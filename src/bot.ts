import { Bot, type Context } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import type { InlineQueryResult } from "grammy/types";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { now } from "./db.js";
import { accounts, canRestoreAccount, cancelLogin, deleteAccount, loginComplete, loginStart, logout, refreshAccountProfile, restoreAccount } from "./services/account.js";
import { addTarget, clearTargets, createCampaign, deleteCampaign, listCampaigns, selectAllTargets, setCampaignStatus, updateTarget } from "./services/campaigns.js";
import { syncGroups, setGroup } from "./services/groups.js";
import { tierLimits } from "./services/plans.js";
import { enforceTenantLimits } from "./services/limits.js";
import { paymentMethods, verifyPayment, type PaymentMethod } from "./payments.js";
import { back, button, editRich, editRichAt, escapeHtml, menu, replyRich, type Button } from "./bot-ui.js";
import { inlineResults, reusableRichMessage, withoutAttributionIcons } from "./inline.js";

type Flow = { action: "phone" | "sending_code" | "code" | "password" | "verifying_code" | "campaign" | "payment"; accountId?: string; phone?: string; code?: string; tier?: string; method?: PaymentMethod; paymentId?: number; uiMessageId?: number };
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
type CachedInlineMedia = WithoutId<Extract<InlineQueryResult, { type: "photo" | "video" | "document" | "gif" | "mpeg4_gif" | "audio" | "voice" | "sticker" }>>;

class PersistentFlows extends Map<number, Flow> {
  constructor(private readonly db: Database.Database) {
    super();
    const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
    db.prepare("DELETE FROM botFlows WHERE updatedAt < ?").run(cutoff);
    for (const row of db.prepare("SELECT telegramId,data FROM botFlows").all() as Array<{ telegramId: number; data: string }>) {
      try { super.set(row.telegramId, JSON.parse(row.data) as Flow); } catch { db.prepare("DELETE FROM botFlows WHERE telegramId=?").run(row.telegramId); }
    }
  }
  override set(userId: number, flow: Flow): this {
    super.set(userId, flow);
    const action = flow.action === "sending_code" ? "phone" : flow.action === "verifying_code" ? "code" : flow.action;
    const saved = { ...flow, action, code: undefined };
    this.db.prepare("INSERT INTO botFlows (telegramId,data,updatedAt) VALUES (?,?,?) ON CONFLICT(telegramId) DO UPDATE SET data=excluded.data,updatedAt=excluded.updatedAt")
      .run(userId, JSON.stringify(saved), now());
    return this;
  }
  override delete(userId: number): boolean {
    this.db.prepare("DELETE FROM botFlows WHERE telegramId=?").run(userId);
    return super.delete(userId);
  }
  sweep(): void {
    const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
    const stale = this.db.prepare("SELECT telegramId FROM botFlows WHERE updatedAt < ?").all(cutoff) as Array<{ telegramId: number }>;
    for (const row of stale) this.delete(row.telegramId);
  }
}

export function cachedInlineMedia(msg: NonNullable<Context["message"]>): CachedInlineMedia | null {
  const caption = msg.caption;
  const caption_entities = msg.caption_entities;
  const show_caption_above_media = msg.show_caption_above_media;
  if (msg.photo?.length) return { type: "photo", photo_file_id: msg.photo.at(-1)!.file_id, caption, caption_entities, show_caption_above_media };
  if (msg.video) return { type: "video", video_file_id: msg.video.file_id, title: msg.caption?.slice(0, 80) || "Campaign video", caption, caption_entities, show_caption_above_media };
  if (msg.animation) return msg.animation.mime_type === "image/gif"
    ? { type: "gif", gif_file_id: msg.animation.file_id, caption, caption_entities, show_caption_above_media }
    : { type: "mpeg4_gif", mpeg4_file_id: msg.animation.file_id, caption, caption_entities, show_caption_above_media };
  if (msg.document) return { type: "document", document_file_id: msg.document.file_id, title: msg.document.file_name || "Campaign document", caption, caption_entities };
  if (msg.audio) return { type: "audio", audio_file_id: msg.audio.file_id, caption, caption_entities };
  if (msg.voice) return { type: "voice", voice_file_id: msg.voice.file_id, title: "Campaign voice message", caption, caption_entities };
  if (msg.sticker) return { type: "sticker", sticker_file_id: msg.sticker.file_id };
  return null;
}

function loginError(error: unknown): string {
  const text = String(error).toUpperCase();
  if (text.includes("PHONE_NUMBER_INVALID")) return "Telegram rejected this phone number.";
  if (text.includes("PHONE_NUMBER_BANNED")) return "This phone number is restricted by Telegram.";
  if (text.includes("PHONE_CODE_INVALID")) return "The code is incorrect.";
  if (text.includes("PHONE_CODE_EXPIRED")) return "The code expired. Cancel and request a new one.";
  if (text.includes("SESSION_PASSWORD_NEEDED")) return "This account needs its 2FA password after the code.";
  if (text.includes("PASSWORD_HASH_INVALID")) return "The 2FA password is incorrect.";
  if (text.includes("LOGIN CODE WAS NOT REQUESTED")) return "This login session expired. Cancel and request a new code.";
  if (text.includes("FLOOD_WAIT")) return "Telegram is rate limiting login attempts. Wait before trying again.";
  if (text.includes("ALREADY CONNECTED")) return "This Telegram account is already in your account list. Open that entry instead.";
  if (/TIMEOUT|NETWORK|CONNECTION/.test(text)) return "Telegram is taking too long to respond. Try again shortly.";
  return "Telegram could not complete this step. Try again or cancel the login.";
}

export function startAdsBot(db: Database.Database): void {
  if (!config.botToken) return;
  const bot = new Bot(config.botToken, { client: { apiRoot: config.telegramApiRoot } });
  bot.use(sequentialize((ctx) => ctx.from ? String(ctx.from.id) : undefined));
  
  void bot.api.setMyCommands([
    { command: "start", description: "Start the bot" },
    { command: "menu", description: "Show main menu" },
    { command: "help", description: "Get help" },
  ]);
  
  const flows = new PersistentFlows(db);
  const showFlowPrompt = async (ctx: Context, flow: Flow, content: string, options: Parameters<typeof editRich>[2] = {}) => {
    const result = await editRich(ctx, content, options);
    flow.uiMessageId = typeof result === "object" && "message_id" in result ? result.message_id : ctx.callbackQuery?.message?.message_id;
    flows.set(ctx.from!.id, flow);
  };
  const flowRich = async (ctx: Context, flow: Flow | undefined, content: string, options: Parameters<typeof replyRich>[2] = {}): Promise<number> => {
    if (flow?.uiMessageId) {
      try {
        await editRichAt(ctx, flow.uiMessageId, content, options);
        return flow.uiMessageId;
      } catch (error) {
        if (/message is not modified/i.test(String(error))) return flow.uiMessageId;
        if (!/message to edit not found|message can't be edited|there is no text|message is not a text message/i.test(String(error))) throw error;
      }
    }
    const sent = await replyRich(ctx, content, options);
    if (flow && ctx.from && flows.get(ctx.from.id) === flow) {
      flow.uiMessageId = sent.message_id;
      flows.set(ctx.from.id, flow);
    }
    return sent.message_id;
  };
  setInterval(() => flows.sweep(), 60_000).unref();
  const membership = new Map<number, { allowed: boolean; expires: number }>();
  const tenantId = (userId: number): string => {
    const row = db.prepare("SELECT tenantId FROM localUsers WHERE telegramId = ?").get(userId) as { tenantId: string } | undefined;
    if (!row) throw new Error("Send /start to set up your ads account.");
    return row.tenantId;
  };
  const home = (primary: "campaign" | "accounts" | "connect" = "campaign") => menu([
    [button(primary === "campaign" ? "Create campaign" : primary === "accounts" ? "Restore an account" : "Connect account", primary === "campaign" ? "newcampaign" : primary === "accounts" ? "accounts" : "connect", "primary", primary === "accounts" ? "refresh" : "plus")],
    [button("Campaigns", "campaigns", undefined, "megaphone"), button("Accounts", "accounts", undefined, "people")],
    [button("Groups", "groups", undefined, "people"), button("Activity", "activity", undefined, "chart")],
    [button("Plan", "plan", undefined, "card"), button("Help", "help", "link", "support")],
  ]);
  const showHome = async (ctx: Context) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const tid = tenantId(userId);
    const user = db.prepare("SELECT tierCode FROM localUsers WHERE telegramId = ?").get(userId) as { tierCode: string };
    const sentToday = (db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE tenantId = ? AND status='sent' AND sentAt >= date('now')").get(tid) as { n: number }).n;
    const limits = tierLimits(user.tierCode);
    const accountList = accounts(db, tid);
    const connected = accountList.filter((a) => a.status === "active").length;
    const primary = connected ? "campaign" : accountList.some((account) => account.phone) ? "accounts" : "connect";
    const running = Number((db.prepare("SELECT COUNT(*) AS n FROM campaigns WHERE tenantId = ? AND status = 'scheduled'").get(tid) as { n: number }).n);
    const caption = `<h2>IOAds</h2><p>Schedule posts to groups your connected accounts already belong to.</p><hr/><table compact><tr><td>Accounts</td><td>${connected} / ${limits.accounts}</td></tr><tr><td>Scheduled</td><td>${running}</td></tr><tr><td>Sent today</td><td>${sentToday.toLocaleString()} / ${limits.dailyMessages.toLocaleString()}</td></tr></table><p>${primary === "campaign" ? "Ready to create a campaign. Forward the post you want to send." : primary === "accounts" ? "Your saved account needs attention. Open Accounts to restore or reconnect it." : "First, connect an account. Then choose its groups and forward a post."}</p>`;
    if (ctx.callbackQuery) await editRich(ctx, caption, { parse_mode: "HTML", reply_markup: home(primary) });
    else await replyRich(ctx, caption, { parse_mode: "HTML", reply_markup: home(primary) });
  };
  bot.use(async (ctx, next) => {
    if (ctx.chatMember || ctx.inlineQuery) { await next(); return; }
    const flow = ctx.from ? flows.get(ctx.from.id) : undefined;
    if (ctx.callbackQuery && flow && ["phone", "sending_code", "code", "password", "verifying_code"].includes(flow.action)
      && ctx.callbackQuery.data !== "login:cancel") {
      await ctx.answerCallbackQuery({ text: "Finish or cancel the current userbot login first.", show_alert: true });
      return;
    }
    if (ctx.from && !ctx.message?.text?.startsWith("/start")) {
      const cached = membership.get(ctx.from.id);
      if (cached && cached.expires > Date.now() && cached.allowed) { await next(); return; }
      try {
        const member = await ctx.api.getChatMember(config.forceJoinChat, ctx.from.id);
         if (member.status === "left" || member.status === "kicked" || (member.status === "restricted" && !member.is_member)) {
          membership.set(ctx.from.id, { allowed: false, expires: Date.now() + 30_000 });
          db.prepare("UPDATE localUsers SET forceJoined = 0, updatedAt = ? WHERE telegramId = ?").run(now(), ctx.from.id);
          await editRich(ctx, "Join @iobuysell to use your userbots.", { reply_markup: menu([[{ text: "Join", url: "https://t.me/iobuysell" }], [button("Check", "home")]]) });
          return;
        }
        membership.set(ctx.from.id, { allowed: true, expires: Date.now() + 60_000 });
        db.prepare("UPDATE localUsers SET forceJoined = 1, updatedAt = ? WHERE telegramId = ?").run(now(), ctx.from.id);
      } catch {
         await editRich(ctx, "I can’t verify your @iobuysell membership yet. Open the group, then try again.", { reply_markup: menu([[{ text: "Open", url: "https://t.me/iobuysell" }]]) });
        return;
      }
    }
    await next();
  });
  bot.on("chat_member", async (ctx) => {
    const chat = ctx.chat;
    if (String(chat.id) !== config.forceJoinChat && `@${chat.username ?? ""}`.toLowerCase() !== config.forceJoinChat.toLowerCase()) return;
    const member = ctx.chatMember.new_chat_member;
    const allowed = member.status !== "left" && member.status !== "kicked" && (member.status !== "restricted" || member.is_member);
    const userId = member.user.id;
    membership.set(userId, { allowed, expires: Date.now() + 60_000 });
    db.prepare("UPDATE localUsers SET forceJoined=?,updatedAt=? WHERE telegramId=?").run(allowed ? 1 : 0, now(), userId);
  });
  bot.command("start", async (ctx) => {
    const userId = ctx.from!.id;
    flows.delete(userId);
    const tid = `ads:${userId}`;
    db.prepare("INSERT OR IGNORE INTO localUsers (telegramId, tenantId, tierCode, createdAt, updatedAt) VALUES (?, ?, 'free', ?, ?)").run(userId, tid, now(), now());
    db.prepare(`INSERT OR IGNORE INTO tenants (tenantId, productId, ownerId, state, tierCode, runtime, version, trial, suspendReason, periodEnd, retainUntil, limits, config, secretsFingerprint, controlBotFingerprint, controlBotToken, fault, updatedAt, appliedAt) VALUES (?, 'ads-standalone', ?, 'active', 'free', 'service', 1, 0, NULL, NULL, NULL, ?, '{}', NULL, NULL, NULL, NULL, ?, ?)`)
      .run(tid, userId, JSON.stringify(tierLimits("free")), now(), now());
    try {
      const member = await ctx.api.getChatMember(config.forceJoinChat, userId);
       if (member.status === "left" || member.status === "kicked" || (member.status === "restricted" && !member.is_member)) {
          await replyRich(ctx, "Join @iobuysell to activate campaigns.", { reply_markup: menu([[{ text: "Join", url: "https://t.me/iobuysell" }], [button("Check", "home")]]) });
        return;
      }
      db.prepare("UPDATE localUsers SET forceJoined = 1, updatedAt = ? WHERE telegramId = ?").run(now(), userId);
    } catch {
      await replyRich(ctx, "I can’t check @iobuysell right now. Try again shortly.");
      return;
    }
    await showHome(ctx);
  });
  bot.command("menu", showHome);
  const helpContent = `<h2>How IOAds works</h2><ol><li>Connect the Telegram accounts that will post.</li><li>Sync groups each account already belongs to.</li><li>Forward a post, then choose groups separately for each account.</li><li>Review the frequency, start the campaign, and follow deliveries in Activity.</li></ol><details><summary>What the bot can access</summary><p>IOAds sends only to groups visible to a connected account. It does not join groups, discover members, or send direct messages.</p></details>`;
  bot.command("help", (ctx) => replyRich(ctx, helpContent, { parse_mode: "HTML", reply_markup: menu([[button("Create campaign", "newcampaign", "primary", "plus")], [button("Accounts", "accounts", undefined, "people"), button("Groups", "groups", undefined, "people")], [back("home", "Back to home")]]) }));
  bot.callbackQuery("help", async (ctx) => { await ctx.answerCallbackQuery(); await editRich(ctx, helpContent, { parse_mode: "HTML", reply_markup: menu([[button("Create campaign", "newcampaign", "primary", "plus")], [button("Accounts", "accounts", undefined, "people"), button("Groups", "groups", undefined, "people")], [back("home", "Back to home")]]) }); });
  bot.callbackQuery("schedule", async (ctx) => { await ctx.answerCallbackQuery(); await editRich(ctx, "<b>Schedule</b>\nReview campaign status, delivery interval, target groups, and posting method. Open any campaign to pause it or change its timing.", { parse_mode: "HTML", reply_markup: menu([[button("Campaigns", "campaigns")], [button("New campaign", "newcampaign")], [back("home", "Back to home")]]) }); });
  bot.callbackQuery("activity", async (ctx) => {
    await ctx.answerCallbackQuery();
    const rows = db.prepare("SELECT c.name, d.chatId, d.status, d.error, d.nextAttemptAt FROM deliveries d JOIN campaigns c ON c.id = d.campaignId WHERE d.tenantId = ? ORDER BY d.id DESC LIMIT 8").all(tenantId(ctx.from.id)) as Array<{ name: string; chatId: string; status: string; error: string | null; nextAttemptAt: string | null }>;
    const body = rows.length ? rows.map((row) => `• <b>${escapeHtml(row.name)}</b> · ${row.status} · ${escapeHtml(row.chatId)}${row.error ? `\n  ${escapeHtml(row.error.slice(0, 120))}` : ""}${row.status === "retry" && row.nextAttemptAt ? `\n  retry ${escapeHtml(row.nextAttemptAt)}` : ""}`).join("\n") : "No deliveries yet. Scheduled sends will appear here.";
    await editRich(ctx, `🗃 <b>Activity</b>\nRecent campaign deliveries\n\n${body}`, { parse_mode: "HTML", reply_markup: menu([[button("Campaigns", "campaigns")], [back("home", "Back to home")]]) });
  });
  bot.callbackQuery("settings", async (ctx) => { await ctx.answerCallbackQuery(); await editRich(ctx, "<b>Settings</b>\nManage linked Telegram accounts, group access, plan limits, and campaign delivery preferences.", { parse_mode: "HTML", reply_markup: menu([[button("Accounts", "accounts"), button("Groups", "groups")], [button("Plan", "plan")], [back("home", "Back to home")]]) }); });
  const accountLabel = (account: ReturnType<typeof accounts>[number]): string => account.phone ? `${account.displayName ? `${account.displayName} · ` : ""}${account.phone}` : `Login attempt ${new Date(account.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" })} · ${account.accountId.slice(0, 6)}`;
  const accountButtonLabel = (account: ReturnType<typeof accounts>[number]): string => account.phone && account.displayName ? `${account.displayName.slice(0, 18)} · ${account.phone}` : accountLabel(account).slice(0, 36);
  const accountState = (status: string): string => status === "active" ? "Connected" : status === "limit_paused" ? "Paused by plan limit" : status === "connecting" ? "Login in progress" : "Disconnected";
  const loginBack = (userId: number): Button => {
    const accountId = flows.get(userId)?.accountId;
    const known = accountId && accounts(db, tenantId(userId)).some((account) => account.accountId === accountId && account.phone);
    return back("login:cancel", known ? "Back to account" : "Back to accounts");
  };
  const showAccounts = async (ctx: Context, requestedPage = 0) => {
    const tid = tenantId(ctx.from!.id);
    const missing = accounts(db, tid).filter((account) => account.status === "active" && !account.displayName);
    if (missing.length) await Promise.race([
      Promise.allSettled(missing.map((account) => refreshAccountProfile(db, tid, account.accountId))),
      new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
    ]);
    const list = accounts(db, tid);
    const pageSize = 6, page = Math.min(Math.max(0, requestedPage), Math.max(0, Math.ceil(list.length / pageSize) - 1));
    const visible = list.slice(page * pageSize, (page + 1) * pageSize);
    const rows: Button[][] = [[button("Connect account", "connect", "primary", "plus")], ...visible.map((account) => [button(`${account.status === "active" ? "" : account.status === "limit_paused" ? "⏸ " : "○ "}${accountButtonLabel(account)}`, `account:${account.accountId}`, undefined, account.status === "active" ? "check" : undefined)])];
    if (list.length > pageSize) rows.push([...(page ? [button("Previous", `accounts:${page - 1}`, undefined, "prev")] : []), ...(page < Math.ceil(list.length / pageSize) - 1 ? [button("Next", `accounts:${page + 1}`, undefined, "next")] : [])]);
    rows.push([back("home", "Back to home")]);
    const connected = list.filter((account) => account.status === "active").length;
    const unfinished = list.filter((account) => !account.phone).length;
    const lines = visible.map((account) => `<li><b>${escapeHtml(accountLabel(account))}</b> · ${account.phone ? accountState(account.status) : "Failed or cancelled setup"}</li>`).join("");
    await editRich(ctx, `<h2>Accounts</h2><p>${connected} connected${unfinished ? ` · ${unfinished} incomplete login${unfinished === 1 ? "" : "s"}` : ""}. Open any row to manage or remove it.</p>${lines ? `<ul>${lines}</ul>` : "<p>Connect an account to access its groups and send campaigns.</p>"}`, { parse_mode: "HTML", reply_markup: menu(rows) });
  };
  bot.callbackQuery("accounts", async (ctx) => { await ctx.answerCallbackQuery(); await showAccounts(ctx); });
  bot.callbackQuery(/^accounts:(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await showAccounts(ctx, Number(ctx.match[1])); });
  const showAccount = async (ctx: Context, accountId: string) => {
    const account = accounts(db, tenantId(ctx.from!.id)).find((item) => item.accountId === accountId);
    if (!account) return editRich(ctx, "Account not found.", { reply_markup: menu([[back("accounts", "Back to accounts")]]) });
    const linkedCampaigns = (db.prepare("SELECT COUNT(*) AS n FROM campaigns c WHERE c.tenantId=? AND (c.senderAccountId=? OR EXISTS (SELECT 1 FROM campaignTargets ct WHERE ct.campaignId=c.id AND ct.tenantId=c.tenantId AND ct.accountId=?))").get(tenantId(ctx.from!.id), accountId, accountId) as { n: number }).n;
    const rows: Button[][] = [];
    if (account.status === "active") rows.push([button("Manage groups", `groupsof:${accountId}:0`, "primary", "people")]);
    if (canRestoreAccount(db, tenantId(ctx.from!.id), accountId)) rows.push([button("Restore saved session", `restore:${accountId}`, "primary", "refresh")]);
    if (account.status === "logged_out" && account.phone) rows.push([button("Reconnect with code", `reconnect:${accountId}`, "primary", "plus")]);
    if (account.status === "active" || account.status === "limit_paused") rows.push([button("Disconnect", `confirmlogout:${accountId}`, "danger", "cross")]);
    else rows.push([button("Remove this entry", `confirmdelete:${accountId}`, "danger", "trash")]);
    rows.push([back("accounts", "Back to accounts")]);
    const title = accountLabel(account);
    const detail = !account.phone ? "The login was not completed. You can remove this attempt." : account.status === "limit_paused" ? "Your plan currently has fewer account slots. The saved session is preserved and will resume if a slot becomes available." : account.status === "logged_out" ? "This account is disconnected. Restore its saved session if available, or reconnect with a new login code. Existing campaigns will keep using this account." : "This account can post to its selected groups.";
    await editRich(ctx, `<h2>${escapeHtml(title)}</h2><p><b>Status:</b> ${account.phone ? accountState(account.status) : "Incomplete login"}<br/><b>Campaigns:</b> ${linkedCampaigns}</p><p>${detail}</p>`, { parse_mode: "HTML", reply_markup: menu(rows) });
  };
  bot.callbackQuery(/^account:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await showAccount(ctx, ctx.match[1]!); });
  bot.callbackQuery(/^reconnect:(.+)$/, async (ctx) => {
    const accountId = ctx.match[1]!;
    const account = accounts(db, tenantId(ctx.from.id)).find((item) => item.accountId === accountId && item.status === "logged_out" && item.phone);
    await ctx.answerCallbackQuery();
    if (!account) return showAccount(ctx, accountId);
    await showFlowPrompt(ctx, { action: "phone", accountId }, `<h2>Reconnect ${escapeHtml(account.phone)}</h2><p>Send this account’s phone number again with its country code. Telegram will send a new login code. Reconnecting keeps your existing campaigns linked to this account.</p>`, { parse_mode: "HTML", reply_markup: menu([[back("login:cancel", "Back to account")]]) });
  });
  bot.callbackQuery(/^restore:(.+)$/, async (ctx) => {
    const accountId = ctx.match[1]!;
    await ctx.answerCallbackQuery("Checking saved session");
    await editRich(ctx, "Checking the saved Telegram session…", { reply_markup: menu([[back(`account:${accountId}`, "Back to account")]]) });
    try {
      const restored = await restoreAccount(db, tenantId(ctx.from.id), accountId);
      await editRich(ctx, restored ? "Account restored. Sync its groups, then re-enable any groups and campaign targets that were cleared when the session was lost." : "Telegram no longer accepts this saved session. Connect the account again with a new login code.", { reply_markup: menu([[button(restored ? "Manage groups" : "Connect account", restored ? `groupsof:${accountId}:0` : "connect", "primary")], [back(`account:${accountId}`, "Back to account")]]) });
    } catch (error) { await editRich(ctx, `Could not restore account: ${escapeHtml(error instanceof Error ? error.message : String(error))}`, { reply_markup: menu([[back(`account:${accountId}`, "Back to account")]]) }); }
  });
  bot.callbackQuery(/^confirmdelete:(.+)$/, async (ctx) => {
    const accountId = ctx.match[1]!;
    const account = accounts(db, tenantId(ctx.from.id)).find((item) => item.accountId === accountId);
    await ctx.answerCallbackQuery();
    if (!account) return editRich(ctx, "Account not found.", { reply_markup: menu([[back("accounts", "Back to accounts")]]) });
    const count = (db.prepare("SELECT COUNT(*) AS n FROM campaigns WHERE tenantId=? AND senderAccountId=?").get(tenantId(ctx.from.id), accountId) as { n: number }).n;
    const secondary = (db.prepare("SELECT COUNT(DISTINCT campaignId) AS n FROM campaignTargets WHERE tenantId=? AND accountId=?").get(tenantId(ctx.from.id), accountId) as { n: number }).n;
    await editRich(ctx, `<h2>Remove account entry?</h2><p>${escapeHtml(accountLabel(account))}${count ? ` started ${count} campaign${count === 1 ? "" : "s"}. Delete or change those campaigns first.` : `. Its saved session${secondary ? `, selections in ${secondary} campaign${secondary === 1 ? "" : "s"}, and related delivery history` : ""} will be deleted.`}</p>`, { parse_mode: "HTML", reply_markup: menu([...(count ? [] : [[button("Remove entry", `delete:${accountId}`, "danger", "trash")]]), [back(`account:${accountId}`, "Back to account")]]) });
  });
  bot.callbackQuery(/^delete:(.+)$/, async (ctx) => {
    const accountId = ctx.match[1]!;
    try { await deleteAccount(db, tenantId(ctx.from.id), accountId); await ctx.answerCallbackQuery("Entry removed"); await showAccounts(ctx); }
    catch (error) { await ctx.answerCallbackQuery({ text: String(error instanceof Error ? error.message : error), show_alert: true }); }
  });
  bot.callbackQuery(/^confirmlogout:(.+)$/, async (ctx) => {
    const accountId = ctx.match[1]!;
    const account = accounts(db, tenantId(ctx.from.id)).find((item) => item.accountId === accountId);
    await ctx.answerCallbackQuery();
    if (!account) return editRich(ctx, "Account not found.", { reply_markup: menu([[back("accounts", "Back to accounts")]]) });
    await editRich(ctx, `<h2>Disconnect account?</h2><p>${escapeHtml(accountLabel(account))} will stop sending. Other connected accounts in the same campaigns can continue.</p>`, { parse_mode: "HTML", reply_markup: menu([[button("Disconnect", `logout:${accountId}`, "danger", "cross")], [back(`account:${accountId}`, "Back to account")]]) });
  });
  bot.callbackQuery(/^logout:(.+)$/, async (ctx) => {
    try {
      await logout(db, tenantId(ctx.from.id), ctx.match[1]!);
      await ctx.answerCallbackQuery("Userbot logged out");
      await editRich(ctx, "Account disconnected. Its deliveries will wait until it reconnects; other connected accounts can continue.", { reply_markup: menu([[back("accounts", "Back to accounts")]]) });
    } catch (error) {
      await ctx.answerCallbackQuery({ text: String(error instanceof Error ? error.message : error), show_alert: true });
    }
  });
  bot.callbackQuery("connect", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (["phone", "sending_code", "code", "password", "verifying_code"].includes(flows.get(ctx.from.id)?.action ?? "")) {
      await editRich(ctx, "A login is already in progress. Finish it or cancel it before starting another account.", { reply_markup: menu([[loginBack(ctx.from.id)]]) });
      return;
    }
    await showFlowPrompt(ctx, { action: "phone" }, `<h2>Connect an account</h2><p><b>Step 1 of 3 · Phone number</b><br/>Send a different Telegram account’s number with country code, for example <code>+1234567890</code>. The account operating this bot cannot also be a sender.</p><p>Telegram will send a code next. If the account uses two-step verification, I will ask for its password after that. Your session is encrypted on this service.</p>`, { parse_mode: "HTML", reply_markup: menu([[loginBack(ctx.from.id)]]) });
  });
  bot.callbackQuery("login:cancel", async (ctx) => {
    const flow = flows.get(ctx.from.id);
    const previousAccount = flow?.accountId && accounts(db, tenantId(ctx.from.id)).find((item) => item.accountId === flow.accountId && item.phone) ? flow.accountId : null;
    if (flow?.accountId && ["sending_code", "code", "password", "verifying_code"].includes(flow.action)) await cancelLogin(db, tenantId(ctx.from.id), flow.accountId);
    flows.delete(ctx.from.id);
    await ctx.answerCallbackQuery("Login cancelled");
    if (previousAccount) await showAccount(ctx, previousAccount);
    else await showAccounts(ctx);
  });
  const showCampaigns = async (ctx: Context, requestedPage = 0) => {
    const tid = tenantId(ctx.from!.id), list = listCampaigns(db, tid) as Array<{ id: number; name: string; status: string; intervalSeconds: number }>;
    const pageSize = 6;
    const page = Math.min(Math.max(0, requestedPage), Math.max(0, Math.ceil(list.length / pageSize) - 1));
    const visible = list.slice(page * pageSize, (page + 1) * pageSize);
    const rows: Button[][] = [[button("Create campaign", "newcampaign", "primary")], ...visible.map((c) => [button(`${c.status === "scheduled" ? "●" : c.status === "draft" ? "◌" : c.status === "cancelled" ? "×" : "Ⅱ"} ${c.name.slice(0, 35)}`, `campaign:${c.id}`)])];
    if (list.length > pageSize) rows.push([...(page ? [button("← Previous", `campaigns:${page - 1}`)] : []), ...(page < Math.ceil(list.length / pageSize) - 1 ? [button("Next →", `campaigns:${page + 1}`)] : [])]);
    rows.push([back("home", "Back to home")]);
    const body = visible.map((c) => `<li><b>${escapeHtml(c.name)}</b> · ${c.status} · ${c.intervalSeconds / 60} min</li>`).join("");
    await editRich(ctx, `<h2>Campaigns</h2><p>${list.length ? `${list.length} total · showing ${page * pageSize + 1}–${Math.min(list.length, (page + 1) * pageSize)}.` : "No campaigns yet. Forward a post to create your first one."}</p>${body ? `<ul>${body}</ul>` : ""}`, { parse_mode: "HTML", reply_markup: menu(rows) });
  };
  bot.callbackQuery("campaigns", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showCampaigns(ctx);
  });
  bot.callbackQuery(/^campaigns:(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await showCampaigns(ctx, Number(ctx.match[1])); });
  bot.inlineQuery(/.*/, async (ctx) => {
    const query = ctx.inlineQuery.query;
    const results = inlineResults(db, ctx.from.id, query, config.botUsername);
    const options = {
      cache_time: 0, is_personal: true,
      ...(!/^campaign:\d+$/.test(query) ? { button: { text: "Open IOAds in private chat", start_parameter: "inline" } } : {}),
    };
    try {
      await ctx.answerInlineQuery(results, options);
    } catch (error) {
      if (!/button_icon|custom emoji|icon_custom_emoji_id|fragment|premium/i.test(String(error))) throw error;
      await ctx.answerInlineQuery(withoutAttributionIcons(results), options);
    }
  });
  bot.callbackQuery("newcampaign", async (ctx) => {
    const tid = tenantId(ctx.from.id);
    const list = accounts(db, tid).filter((a) => a.status === "active");
    await ctx.answerCallbackQuery();
    if (!list.length) return editRich(ctx, "Connect an account before creating a campaign.", { reply_markup: menu([[button("Connect account", "connect", "primary", "plus")], [back("campaigns", "Back to campaigns")]]) });
    const existing = db.prepare("SELECT id,status FROM campaigns WHERE tenantId=? AND status!='cancelled' ORDER BY id DESC").all(tid) as Array<{ id: number; status: string }>;
    const tier = (db.prepare("SELECT tierCode FROM localUsers WHERE telegramId=?").get(ctx.from.id) as { tierCode: string }).tierCode;
    if (existing.length >= tierLimits(tier).campaigns) {
      const draft = existing.find((item) => item.status === "draft");
      return editRich(ctx, draft ? "You already have a draft. Select its groups and schedule it here." : "Your plan’s campaign limit is full. Open a campaign to manage it.", { reply_markup: menu([[button(draft ? "Open draft" : "Campaigns", draft ? `campaign:${draft.id}` : "campaigns", "primary")], [back("campaigns", "Back to campaigns")]]) });
    }
    if (list.length > 1) return editRich(ctx, `<h2>New campaign</h2><p>Choose an account to begin. After forwarding your post, you can add other accounts and choose different groups for each one.</p>`, { parse_mode: "HTML", reply_markup: menu([...list.map((account) => [button(accountButtonLabel(account), `campaignfrom:${account.accountId}`)]), [back("newcampaign:back", "Back to campaigns")]]) });
    await showFlowPrompt(ctx, { action: "campaign", accountId: list[0]!.accountId }, `<h2>Send your post</h2><p>Forward the ad here. Text, formatting, and supported media will be kept.</p><p>Next you will choose groups and review the schedule before starting.</p>`, { parse_mode: "HTML", reply_markup: menu([[back("newcampaign:back", "Back to campaigns")]]) });
  });
  bot.callbackQuery(/^campaignfrom:([^:]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const account = accounts(db, tenantId(ctx.from.id)).find((item) => item.accountId === ctx.match[1] && item.status === "active");
    if (!account) return editRich(ctx, "That account is unavailable. Choose another account.", { reply_markup: menu([[back("newcampaign", "Back to account choice")]]) });
    await showFlowPrompt(ctx, { action: "campaign", accountId: account.accountId }, `<h2>Send your post</h2><p><b>Starting with:</b> ${escapeHtml(accountLabel(account))}</p><p>Forward the ad here. Then choose groups for this account, add any other accounts, and review the schedule.</p>`, { parse_mode: "HTML", reply_markup: menu([[back("newcampaign", "Back to account choice")]]) });
  });
  bot.callbackQuery("newcampaign:back", async (ctx) => { flows.delete(ctx.from.id); await ctx.answerCallbackQuery(); await showCampaigns(ctx); });
  const showCampaign = async (ctx: Context, id: number) => {
    const campaign = db.prepare("SELECT name, status, intervalSeconds FROM campaigns WHERE tenantId = ? AND id = ?").get(tenantId(ctx.from!.id), id) as { name: string; status: string; intervalSeconds: number } | undefined;
    if (!campaign) return editRich(ctx, "Campaign not found.", { reply_markup: menu([[back("campaigns", "Back to campaigns")]]) });
    const action = campaign.status === "scheduled" ? "pause" : "schedule";
    const tid = tenantId(ctx.from!.id);
    const inline = db.prepare("SELECT inlineMode,contentKind,richMessage,richContent,inlineOptions FROM campaigns WHERE tenantId = ? AND id = ?").get(tid, id) as { inlineMode: number; contentKind: string; richMessage: string | null; richContent: string | null; inlineOptions: string | null };
    const targets = (db.prepare(`SELECT COUNT(*) AS count FROM campaignTargets ct JOIN groups g ON g.tenantId=ct.tenantId AND g.accountId=ct.accountId AND g.chatId=ct.chatId JOIN accounts a ON a.tenantId=ct.tenantId AND a.accountId=ct.accountId WHERE ct.tenantId=? AND ct.campaignId=? AND ct.enabled=1 AND g.enabled=1 AND g.chatKind='group' AND a.status='active' AND a.session IS NOT NULL`).get(tid, id) as { count: number }).count;
    const rows: Button[][] = [
      [button(`Accounts & groups · ${targets} selected`, `campaignaccounts:${id}`, "primary")],
      [button(`${campaign.intervalSeconds === 300 ? "✓ " : ""}5 min`, `interval:${id}:300`), button(`${campaign.intervalSeconds === 1800 ? "✓ " : ""}30 min`, `interval:${id}:1800`), button(`${campaign.intervalSeconds === 3600 ? "✓ " : ""}60 min`, `interval:${id}:3600`)],
    ];
    const hasMediaSpoiler = inline.inlineOptions ? (JSON.parse(inline.inlineOptions) as { has_media_spoiler?: boolean }).has_media_spoiler : false;
    const canInline = !hasMediaSpoiler && (inline.contentKind === "text" || !!inline.richContent || !!(inline.richMessage && inline.inlineOptions));
    if (config.botUsername && canInline) rows.push([button(`Posting: ${inline.inlineMode ? "inline" : "direct"} · change`, `inline:${id}`)]);
    rows.push([button(action === "pause" ? "Pause campaign" : "Start campaign", `setcampaign:${id}:${action}`, action === "pause" ? "danger" : "success")]);
    if (campaign.status !== "cancelled") rows.push([button("Cancel campaign", `confirmcancel:${id}`, "link")]);
    else rows.push([button("Delete campaign", `confirmdeletecampaign:${id}`, "danger", "trash")]);
    rows.push([back("campaigns", "Back to campaigns")]);
    const keyboard = menu(rows);
    await editRich(ctx, `<h2>${escapeHtml(campaign.name)}</h2><p><b>Status:</b> ${campaign.status}<br/><b>Groups:</b> ${targets} ready<br/><b>Frequency:</b> every ${campaign.intervalSeconds / 60} minutes<br/><b>Posting:</b> ${inline.inlineMode ? "inline via connected account" : inline.contentKind === "text" ? "connected account" : "connected account copy"}</p><p>${!targets ? "Choose at least one group to start." : campaign.status === "scheduled" ? "This campaign is running. You can pause it or change its groups and frequency." : campaign.status === "cancelled" ? "Stopped. You can start it again." : "Ready to start. The first delivery will be queued when you start it."}</p>`, { parse_mode: "HTML", reply_markup: keyboard });
  };
  bot.callbackQuery(/^campaign:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showCampaign(ctx, Number(ctx.match[1]));
  });
  const showCampaignAccounts = async (ctx: Context, id: number, requestedPage = 0, flow?: Flow) => {
    const tid = tenantId(ctx.from!.id);
    if (!db.prepare("SELECT 1 FROM campaigns WHERE tenantId=? AND id=?").get(tid, id)) throw new Error("Campaign not found.");
    const list = db.prepare(`SELECT a.rowid AS accountRowId,a.accountId,a.phone,a.displayName,a.status,COUNT(ct.chatId) AS selected
      FROM accounts a LEFT JOIN campaignTargets ct ON ct.tenantId=a.tenantId AND ct.accountId=a.accountId AND ct.campaignId=? AND ct.enabled=1
      WHERE a.tenantId=? AND (a.status='active' OR ct.chatId IS NOT NULL) GROUP BY a.accountId ORDER BY CASE WHEN a.status='active' THEN 0 ELSE 1 END,a.createdAt DESC`).all(id, tid) as Array<{ accountRowId: number; accountId: string; phone: string | null; displayName: string | null; status: string; selected: number }>;
    const pageSize = 6, page = Math.min(Math.max(0, requestedPage), Math.max(0, Math.ceil(list.length / pageSize) - 1));
    const visible = list.slice(page * pageSize, (page + 1) * pageSize);
    const rows: Button[][] = visible.map((item) => [button(`${item.selected ? "✓ " : ""}${item.displayName || item.phone || "Telegram account"}${item.displayName && item.phone ? ` · ${item.phone}` : ""} · ${item.selected} groups`, `ca:${id}:${item.accountRowId}`)]);
    if (list.length > pageSize) rows.push([...(page ? [button("Previous", `campaignaccounts:${id}:${page - 1}`, undefined, "prev")] : []), ...(page < Math.ceil(list.length / pageSize) - 1 ? [button("Next", `campaignaccounts:${id}:${page + 1}`, undefined, "next")] : [])]);
    rows.push([back(`campaign:${id}`, "Back to campaign")]);
    const summary = visible.map((item) => `<li><b>${escapeHtml(item.displayName || "Telegram account")}</b>${item.phone ? ` · ${escapeHtml(item.phone)}` : ""} · ${item.selected} selected${item.status === "active" ? "" : " · disconnected"}</li>`).join("");
    const content = `<h2>Accounts & groups</h2><p>Choose each account that should post this campaign. Each account has its own group selection, so the same campaign can reach different groups from different accounts.</p>${summary ? `<ul>${summary}</ul>` : "<p>Connect an account to choose groups.</p>"}`;
    if (flow) await flowRich(ctx, flow, content, { parse_mode: "HTML", reply_markup: menu(rows) });
    else await editRich(ctx, content, { parse_mode: "HTML", reply_markup: menu(rows) });
  };
  bot.callbackQuery(/^campaignaccounts:(\d+)(?::(\d+))?$/, async (ctx) => { await ctx.answerCallbackQuery(); await showCampaignAccounts(ctx, Number(ctx.match[1]), Number(ctx.match[2] ?? 0)); });
  bot.callbackQuery(/^ca:(\d+):(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); const account = db.prepare("SELECT accountId FROM accounts WHERE rowid=? AND tenantId=?").get(Number(ctx.match[2]), tenantId(ctx.from.id)) as { accountId: string } | undefined; if (!account) return showCampaignAccounts(ctx, Number(ctx.match[1])); await showCampaignTargets(ctx, Number(ctx.match[1]), account.accountId); });
  const showCampaignTargets = async (ctx: Context, id: number, accountId: string, requestedPage = 0, notice = "") => {
    const tid = tenantId(ctx.from!.id);
    const campaign = db.prepare("SELECT senderAccountId FROM campaigns WHERE tenantId=? AND id=?").get(tid, id) as { senderAccountId: string } | undefined;
    if (!campaign) throw new Error("Campaign not found.");
    const account = db.prepare("SELECT rowid AS accountRowId,phone,displayName,status FROM accounts WHERE tenantId=? AND accountId=?").get(tid, accountId) as { accountRowId: number; phone: string | null; displayName: string | null; status: string } | undefined;
    if (!account) throw new Error("Account not found.");
    const accountRowId = account.accountRowId;
    const pageSize = 6;
    const total = (db.prepare("SELECT COUNT(*) AS n FROM groups WHERE tenantId=? AND accountId=? AND chatKind='group'").get(tid, accountId) as { n: number }).n;
    const page = Math.min(Math.max(0, requestedPage), Math.max(0, Math.ceil(total / pageSize) - 1));
    const groups = db.prepare(`SELECT g.rowid AS groupId,g.chatId,g.title,g.enabled AS allowed,ct.enabled AS selected FROM groups g LEFT JOIN campaignTargets ct
      ON ct.tenantId=g.tenantId AND ct.accountId=g.accountId AND ct.chatId=g.chatId AND ct.campaignId=?
      WHERE g.tenantId=? AND g.accountId=? AND g.chatKind='group' ORDER BY g.title LIMIT ? OFFSET ?`)
      .all(id, tid, accountId, pageSize, page * pageSize) as Array<{ groupId: number; chatId: string; title: string; allowed: number; selected: number | null }>;
    const selected = db.prepare(`SELECT g.title FROM campaignTargets ct JOIN groups g ON g.tenantId=ct.tenantId AND g.accountId=ct.accountId AND g.chatId=ct.chatId WHERE ct.tenantId=? AND ct.campaignId=? AND ct.accountId=? AND ct.enabled=1 AND g.enabled=1 AND g.chatKind='group' ORDER BY g.title`).all(tid, id, accountId) as Array<{ title: string }>;
    const blocked = (db.prepare(`SELECT COUNT(*) AS n FROM campaignTargets ct JOIN groups g ON g.tenantId=ct.tenantId AND g.accountId=ct.accountId AND g.chatId=ct.chatId WHERE ct.tenantId=? AND ct.campaignId=? AND ct.accountId=? AND ct.enabled=1 AND (g.enabled=0 OR g.chatKind!='group')`).get(tid, id, accountId) as { n: number }).n;
    const rows: Button[][] = groups.map((group) => [button(`${group.selected && group.allowed ? "" : group.selected ? "⚠ " : "☐ "}${group.title.slice(0, 45)}`, `t:${id}:${group.groupId}:${page}`, group.selected && group.allowed ? "success" : undefined, group.selected && group.allowed ? "check" : undefined)]);
    if (total > pageSize) rows.push([...(page ? [button("Previous", `ct:${id}:${accountRowId}:${page - 1}`, undefined, "prev")] : []), ...(page < Math.ceil(total / pageSize) - 1 ? [button("Next", `ct:${id}:${accountRowId}:${page + 1}`, undefined, "next")] : [])]);
    if (total && account.status === "active") rows.push([button("Select all", `ta:${id}:${accountRowId}:${page}`, "success", "check"), ...(selected.length || blocked ? [button("Clear selection", `tc:${id}:${accountRowId}:${page}`, "link", "cross")] : [])]);
    rows.push([button("Refresh groups", `tr:${id}:${accountRowId}:${page}`, "link", "refresh")], [back(`campaignaccounts:${id}`, "Back to accounts")]);
    const names = selected.length ? selected.slice(0, 5).map((item) => escapeHtml(item.title)).join(", ") + (selected.length > 5 ? ` and ${selected.length - 5} more` : "") : "None yet";
    await editRich(ctx, `<h2>Choose groups</h2><p><b>${escapeHtml(account.displayName || "Telegram account")}${account.phone ? ` · ${escapeHtml(account.phone)}` : ""}</b><br/>${notice ? `<b>${escapeHtml(notice)}</b><br/>` : ""}${account.status !== "active" ? "Reconnect this account to update its groups." : total ? "Tap a group to select or remove it. The checkboxes update immediately." : "No verified groups yet. Tap Refresh groups to sync this account. Channels are excluded."}</p><p><b>${account.status === "active" ? "Ready" : "Selected"} · ${selected.length}</b><br/>${names}${blocked ? `<br/>⚠ ${blocked} selected but blocked. Refresh groups to update access.` : ""}</p><p>Showing ${total ? page * pageSize + 1 : 0}–${Math.min(total, (page + 1) * pageSize)} of ${total} groups.</p>`, { parse_mode: "HTML", reply_markup: menu(rows) });
  };
  bot.callbackQuery(/^campaigntargets:(\d+)(?::(\d+))?$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try { await showCampaignAccounts(ctx, Number(ctx.match[1])); }
    catch (error) { await editRich(ctx, String(error instanceof Error ? error.message : error), { reply_markup: menu([[back(`campaign:${ctx.match[1]}`, "Back to campaign")]]) }); }
  });
  const campaignAccountByRow = (ctx: Context, rowId: number): string => {
    const row = db.prepare("SELECT accountId FROM accounts WHERE tenantId=? AND rowid=?").get(tenantId(ctx.from!.id), rowId) as { accountId: string } | undefined;
    if (!row) throw new Error("Account unavailable. Return to the campaign.");
    return row.accountId;
  };
  bot.callbackQuery(/^ct:(\d+):(\d+):(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await showCampaignTargets(ctx, Number(ctx.match[1]), campaignAccountByRow(ctx, Number(ctx.match[2])), Number(ctx.match[3])); });
  bot.callbackQuery(/^ta:(\d+):(\d+):(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]), accountId = campaignAccountByRow(ctx, Number(ctx.match[2])), page = Number(ctx.match[3]);
    await ctx.answerCallbackQuery("Selecting all groups");
    await editRich(ctx, "<h2>Selecting groups</h2><p>Checking which groups this account can post to…</p>", { parse_mode: "HTML", reply_markup: menu([[back(`ct:${id}:${ctx.match[2]}:${page}`, "Back to groups")]]) });
    try { const result = await selectAllTargets(db, tenantId(ctx.from.id), id, accountId); await showCampaignTargets(ctx, id, accountId, page, `${result.selected} groups selected${result.skipped ? `; ${result.skipped} unavailable skipped` : ""}.`); }
    catch (error) { await editRich(ctx, `Could not select all groups: ${String(error instanceof Error ? error.message : error)}`, { reply_markup: menu([[back(`ct:${id}:${ctx.match[2]}:${page}`, "Back to groups")]]) }); }
  });
  bot.callbackQuery(/^tc:(\d+):(\d+):(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]), accountId = campaignAccountByRow(ctx, Number(ctx.match[2])), page = Number(ctx.match[3]);
    try { const cleared = clearTargets(db, tenantId(ctx.from.id), id, accountId); await ctx.answerCallbackQuery(`${cleared} groups removed`); await showCampaignTargets(ctx, id, accountId, page); }
    catch (error) { await ctx.answerCallbackQuery({ text: String(error instanceof Error ? error.message : error), show_alert: true }); }
  });
  bot.callbackQuery(/^tr:(\d+):(\d+):(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]), accountId = campaignAccountByRow(ctx, Number(ctx.match[2])), page = Number(ctx.match[3]);
    await ctx.answerCallbackQuery("Refreshing groups");
    await editRich(ctx, "Refreshing groups from your connected account…", { reply_markup: menu([[back(`ct:${id}:${ctx.match[2]}:${page}`, "Back to groups")]]) });
    try { await syncGroups(db, tenantId(ctx.from.id), accountId); await showCampaignTargets(ctx, id, accountId, page); }
    catch (error) { await editRich(ctx, `Could not refresh groups: ${String(error instanceof Error ? error.message : error)}`, { reply_markup: menu([[back(`ct:${id}:${ctx.match[2]}:${page}`, "Back to groups")]]) }); }
  });
  bot.callbackQuery(/^alltargets:(\d+):(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]), page = Number(ctx.match[2]);
    await ctx.answerCallbackQuery("Selecting all groups");
    await editRich(ctx, `<h2>Selecting groups</h2><p>Checking which groups this account can post to…</p>`, { parse_mode: "HTML", reply_markup: menu([[back(`campaigntargets:${id}:${page}`, "Back to groups")]]) });
    try {
      const result = await selectAllTargets(db, tenantId(ctx.from.id), id);
      const primary = db.prepare("SELECT senderAccountId FROM campaigns WHERE tenantId=? AND id=?").get(tenantId(ctx.from.id), id) as { senderAccountId: string };
      await showCampaignTargets(ctx, id, primary.senderAccountId, page, `${result.selected} groups selected${result.skipped ? `; ${result.skipped} unavailable skipped` : ""}.`);
    } catch (error) {
      await editRich(ctx, `Could not select all groups: ${String(error instanceof Error ? error.message : error)}`, { reply_markup: menu([[back(`campaigntargets:${id}:${page}`, "Back to groups")]]) });
    }
  });
  bot.callbackQuery(/^cleartargets:(\d+):(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]), page = Number(ctx.match[2]);
    try {
      const cleared = clearTargets(db, tenantId(ctx.from.id), id);
      await ctx.answerCallbackQuery(`${cleared} groups removed`);
      const primary = db.prepare("SELECT senderAccountId FROM campaigns WHERE tenantId=? AND id=?").get(tenantId(ctx.from.id), id) as { senderAccountId: string };
      await showCampaignTargets(ctx, id, primary.senderAccountId, page);
    } catch (error) { await ctx.answerCallbackQuery({ text: String(error instanceof Error ? error.message : error), show_alert: true }); }
  });
  bot.callbackQuery(/^campaignrefresh:(\d+)(?::(\d+))?$/, async (ctx) => {
    await ctx.answerCallbackQuery("Refreshing groups");
    const tid = tenantId(ctx.from.id), id = Number(ctx.match[1]);
    const campaign = db.prepare("SELECT senderAccountId FROM campaigns WHERE tenantId=? AND id=?").get(tid, id) as { senderAccountId: string } | undefined;
    if (!campaign) return editRich(ctx, "Campaign not found.", { reply_markup: menu([[back("campaigns", "Back to campaigns")]]) });
    await editRich(ctx, "Refreshing groups from your connected account…", { reply_markup: menu([[back(`campaign:${id}`, "Back to campaign")]]) });
    try { await syncGroups(db, tid, campaign.senderAccountId); await showCampaignTargets(ctx, id, campaign.senderAccountId, Number(ctx.match[2] ?? 0)); }
    catch (error) { await editRich(ctx, `Could not refresh groups: ${String(error instanceof Error ? error.message : error)}`, { reply_markup: menu([[back(`campaign:${id}`, "Back to campaign")]]) }); }
  });
  bot.callbackQuery(/^interval:(\d+):(300|1800|3600)$/, async (ctx) => {
    const [, id, seconds] = ctx.match;
    db.prepare("UPDATE campaigns SET intervalSeconds = ?, nextRunAt = NULL, updatedAt = ? WHERE tenantId = ? AND id = ?").run(Number(seconds), now(), tenantId(ctx.from.id), Number(id));
    await ctx.answerCallbackQuery("Interval updated");
    await showCampaign(ctx, Number(id));
  });
  bot.callbackQuery(/^inline:(\d+)$/, async (ctx) => {
    if (!config.botUsername) return ctx.answerCallbackQuery({ text: "Inline delivery is not configured.", show_alert: true });
    const id = Number(ctx.match[1]);
    const campaign = db.prepare("SELECT inlineMode,contentKind,sourceChatId,richMessage,richContent,inlineOptions FROM campaigns WHERE tenantId=? AND id=?").get(tenantId(ctx.from.id), id) as { inlineMode: number; contentKind: string; sourceChatId: string | null; richMessage: string | null; richContent: string | null; inlineOptions: string | null } | undefined;
    if (!campaign) return ctx.answerCallbackQuery({ text: "Campaign unavailable.", show_alert: true });
    const options = campaign.inlineOptions ? JSON.parse(campaign.inlineOptions) as { reply_markup?: unknown; link_preview_options?: unknown; has_media_spoiler?: boolean } : {};
    if (!campaign.inlineMode && (options.has_media_spoiler || !(campaign.contentKind === "text" || campaign.richContent || (campaign.richMessage && campaign.inlineOptions))))
      return ctx.answerCallbackQuery({ text: "This post cannot be sent intact through inline mode.", show_alert: true });
    if (campaign.inlineMode && !campaign.sourceChatId && (campaign.contentKind !== "text" || options.reply_markup || options.link_preview_options))
      return ctx.answerCallbackQuery({ text: "Direct posting needs ADS_ARCHIVE_CHAT to keep this post intact.", show_alert: true });
    db.prepare("UPDATE campaigns SET inlineMode = 1 - inlineMode, updatedAt = ? WHERE tenantId = ? AND id = ?").run(now(), tenantId(ctx.from.id), id);
    await ctx.answerCallbackQuery("Posting method updated");
    await showCampaign(ctx, id);
  });
  bot.callbackQuery(/^setcampaign:(\d+):(pause|schedule|cancel)$/, async (ctx) => {
    const [, rawId, status] = ctx.match;
    try {
      setCampaignStatus(db, tenantId(ctx.from.id), Number(rawId), status === "pause" ? "paused" : status === "cancel" ? "cancelled" : "scheduled");
      await ctx.answerCallbackQuery("Campaign updated");
      await showCampaign(ctx, Number(rawId));
    } catch (error) {
      await ctx.answerCallbackQuery({ text: String(error instanceof Error ? error.message : error), show_alert: true });
    }
  });
  bot.callbackQuery(/^confirmcancel:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const campaign = db.prepare("SELECT name FROM campaigns WHERE tenantId=? AND id=?").get(tenantId(ctx.from.id), id) as { name: string } | undefined;
    await ctx.answerCallbackQuery();
    if (!campaign) return editRich(ctx, "Campaign not found.", { reply_markup: menu([[back("campaigns", "Back to campaigns")]]) });
    await editRich(ctx, `<h2>Stop campaign?</h2><p><b>${escapeHtml(campaign.name)}</b> will stop sending and pending deliveries will be skipped. You can start it again later.</p>`, { parse_mode: "HTML", reply_markup: menu([[button("Stop campaign", `setcampaign:${id}:cancel`, "danger", "cross")], [back(`campaign:${id}`, "Back to campaign")]]) });
  });
  bot.callbackQuery(/^confirmdeletecampaign:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const campaign = db.prepare("SELECT name FROM campaigns WHERE tenantId=? AND id=? AND status='cancelled'").get(tenantId(ctx.from.id), id) as { name: string } | undefined;
    await ctx.answerCallbackQuery();
    if (!campaign) return showCampaigns(ctx);
    await editRich(ctx, `<h2>Delete campaign?</h2><p><b>${escapeHtml(campaign.name)}</b>, its group selections, and its delivery history will be removed permanently.</p>`, { parse_mode: "HTML", reply_markup: menu([[button("Delete campaign", `deletecampaign:${id}`, "danger", "trash")], [back(`campaign:${id}`, "Back to campaign")]]) });
  });
  bot.callbackQuery(/^deletecampaign:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const campaign = db.prepare("SELECT 1 FROM campaigns WHERE tenantId=? AND id=? AND status='cancelled'").get(tenantId(ctx.from.id), id);
    if (!campaign) return ctx.answerCallbackQuery({ text: "Stop the campaign before deleting it.", show_alert: true });
    deleteCampaign(db, tenantId(ctx.from.id), id);
    await ctx.answerCallbackQuery("Campaign deleted");
    await showCampaigns(ctx);
  });
  const showGroups = async (ctx: Context, accountId: string, requestedPage = 0, origin: "account" | "groups" = "account") => {
    const tid = tenantId(ctx.from!.id);
    const account = accounts(db, tid).find((item) => item.accountId === accountId && item.status === "active");
    if (!account) throw new Error("Account unavailable. Connect it again.");
    const pageSize = 6;
    const summary = db.prepare("SELECT COUNT(*) AS total, SUM(enabled) AS enabled FROM groups WHERE tenantId=? AND accountId=? AND chatKind='group'").get(tid, accountId) as { total: number; enabled: number | null };
    const page = Math.min(Math.max(0, requestedPage), Math.max(0, Math.ceil(summary.total / pageSize) - 1));
    const groups = db.prepare("SELECT rowid AS groupId,chatId,title,enabled FROM groups WHERE tenantId=? AND accountId=? AND chatKind='group' ORDER BY title LIMIT ? OFFSET ?").all(tid, accountId, pageSize, page * pageSize) as Array<{ groupId: number; chatId: string; title: string; enabled: number }>;
    const rows: Button[][] = groups.map((group) => [button(`${group.enabled ? "" : "☐ "}${group.title.slice(0, 45)}`, `g:${group.groupId}:${group.enabled ? 0 : 1}:${page}:${origin}`, group.enabled ? "success" : undefined, group.enabled ? "check" : undefined)]);
    if (summary.total > pageSize) rows.push([...(page ? [button("Previous", `groupsof:${accountId}:${page - 1}:${origin}`, undefined, "prev")] : []), ...(page < Math.ceil(summary.total / pageSize) - 1 ? [button("Next", `groupsof:${accountId}:${page + 1}:${origin}`, undefined, "next")] : [])]);
    rows.push([button("Sync from Telegram", `groupsync:${accountId}:${page}:${origin}`, "link", "refresh")], [origin === "groups" ? back("groups", "Back to groups") : back(`account:${accountId}`, "Back to account")]);
    await editRich(ctx, `<h2>Groups</h2><p><b>${escapeHtml(accountLabel(account))}</b><br/>${summary.enabled ?? 0} enabled of ${summary.total} verified groups.</p><p>${summary.total ? "Tap to allow or block delivery to a group. Campaigns choose their own targets from enabled groups." : "No verified groups yet. Tap Sync from Telegram to load groups. Channels are excluded."}</p><p>Showing ${summary.total ? page * pageSize + 1 : 0}–${Math.min(summary.total, (page + 1) * pageSize)} of ${summary.total}.</p>`, { parse_mode: "HTML", reply_markup: menu(rows) });
  };
  bot.callbackQuery("groups", async (ctx) => {
    const list = accounts(db, tenantId(ctx.from.id)).filter((a) => a.status === "active");
    await ctx.answerCallbackQuery();
    if (!list.length) return editRich(ctx, "Connect an account to see its groups.", { reply_markup: menu([[button("Connect account", "connect", "primary", "plus")], [back("home", "Back to home")]]) });
    await editRich(ctx, `<h2>Choose an account</h2><p>Groups belong to the account that will send your campaign.</p>`, { parse_mode: "HTML", reply_markup: menu([...list.map((account) => [button(account.phone ?? "Telegram account", `groupsof:${account.accountId}:0:groups`)]), [back("home", "Back to home")]]) });
  });
  bot.callbackQuery(/^groupsof:([^:]+):(\d+)(?::(account|groups))?$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try { await showGroups(ctx, ctx.match[1]!, Number(ctx.match[2]), ctx.match[3] === "groups" ? "groups" : "account"); }
    catch (error) { await editRich(ctx, escapeHtml(error instanceof Error ? error.message : String(error)), { parse_mode: "HTML", reply_markup: menu([[ctx.match[3] === "groups" ? back("groups", "Back to groups") : back("accounts", "Back to accounts")]]) }); }
  });
  bot.callbackQuery(/^groupsync:([^:]+):(\d+)(?::(account|groups))?$/, async (ctx) => {
    const [, accountId, page] = ctx.match;
    const origin = ctx.match[3] === "groups" ? "groups" : "account";
    await ctx.answerCallbackQuery("Syncing groups");
    try { await syncGroups(db, tenantId(ctx.from.id), accountId!); await showGroups(ctx, accountId!, Number(page), origin); }
    catch (error) { await editRich(ctx, `Could not sync groups: ${String(error instanceof Error ? error.message : error)}`, { reply_markup: menu([[button("Try again", `groupsync:${accountId}:${page}:${origin}`, undefined, "refresh")], [back(`groupsof:${accountId}:${page}:${origin}`, "Back to groups")]]) }); }
  });
  const toggleGroup = async (ctx: Context, accountId: string, chatId: string, enabled: boolean, page: number, origin: "account" | "groups" = "account") => {
    try {
      const tier = (db.prepare("SELECT tierCode FROM tenants WHERE tenantId = ?").get(tenantId(ctx.from!.id)) as { tierCode: string }).tierCode;
      await setGroup(db, tenantId(ctx.from!.id), accountId, chatId, enabled, undefined, tier === "business" ? 2 : tier === "pro" ? 1 : 0);
      await ctx.answerCallbackQuery(enabled ? "Group enabled" : "Group disabled");
      await showGroups(ctx, accountId, page, origin);
    } catch (error) { await ctx.answerCallbackQuery({ text: String(error instanceof Error ? error.message : error), show_alert: true }); }
  };
  bot.callbackQuery(/^g:(\d+):(0|1):(\d+)(?::(account|groups))?$/, async (ctx) => {
    const row = db.prepare("SELECT accountId,chatId FROM groups WHERE rowid=? AND tenantId=?").get(Number(ctx.match[1]), tenantId(ctx.from.id)) as { accountId: string; chatId: string } | undefined;
    if (!row) return ctx.answerCallbackQuery({ text: "Group unavailable. Refresh the list.", show_alert: true });
    await toggleGroup(ctx, row.accountId, row.chatId, ctx.match[2] === "1", Number(ctx.match[3]), ctx.match[4] === "groups" ? "groups" : "account");
  });
  bot.callbackQuery(/^group:([^:]+):([^:]+):(0|1)$/, async (ctx) => {
    await toggleGroup(ctx, ctx.match[1]!, ctx.match[2]!, ctx.match[3] === "1", 0);
  });
  bot.callbackQuery("plan", async (ctx) => {
    flows.delete(ctx.from.id);
    await ctx.answerCallbackQuery();
    const row = db.prepare("SELECT tierCode FROM localUsers WHERE telegramId = ?").get(ctx.from.id) as { tierCode: string };
    const expires = db.prepare("SELECT paidUntil FROM localUsers WHERE telegramId = ?").get(ctx.from.id) as { paidUntil: string | null };
    const rows = [[button("Choose Pro · $1/mo", "upgrade:pro", "primary", "card")], [button("Choose Business · $3/mo", "upgrade:business", undefined, "card")], [back("home", "Back to home")]];
    await editRich(ctx, `<h2>Your plan · ${escapeHtml(row.tierCode)}</h2><p>${expires.paidUntil ? `Active until ${new Date(expires.paidUntil).toLocaleDateString()}.` : "Choose a plan when you need more accounts or daily sends."}</p><table compact><tr><th>Plan</th><th>Accounts</th><th>Daily sends</th></tr>${([['Free', 'free'], ['Pro', 'pro'], ['Business', 'business']] as const).map(([label, tier]) => `<tr><td>${label}</td><td>${tierLimits(tier).accounts}</td><td>${tierLimits(tier).dailyMessages.toLocaleString()}</td></tr>`).join("")}</table><p>Payments are checked automatically after you send a transaction ID.</p>`, { parse_mode: "HTML", reply_markup: menu(rows) });
  });
  bot.callbackQuery(/^upgrade:(pro|business)$/, async (ctx) => {
    flows.delete(ctx.from.id);
    const tier = ctx.match[1]!;
    const monthly = tier === "pro" ? 1 : 3;
    const date = new Date(Date.now() + 30 * 86400_000).toISOString();
    const available = paymentMethods();
    if (!available.length) return ctx.answerCallbackQuery({ text: "Payments aren’t configured yet. Ask the bot owner.", show_alert: true });
    await ctx.answerCallbackQuery();
    const rows = available.map((method) => [button(method === "Binance" ? "Binance" : method, `pay:${tier}:${method}`)]);
    rows.push([back("plan", "Back to plan")]);
    const keyboard = menu(rows);
    await editRich(ctx, `<b>${tier} · $${monthly}/month</b>\nChoose a payment method. Access begins after the transfer is verified.`, { parse_mode: "HTML", reply_markup: keyboard });
  });
  bot.callbackQuery(/^pay:(pro|business):(Binance|BEP20|TRC20)$/, async (ctx) => {
    const tier = ctx.match[1]!, method = ctx.match[2] as PaymentMethod;
    const amount = tier === "pro" ? 1 : 3;
    if (!paymentMethods().includes(method)) return ctx.answerCallbackQuery({ text: "Payment method unavailable", show_alert: true });
    const address = method === "Binance" ? `Binance Pay UID: ${config.paymentBinancePayId}` : method === "BEP20" ? config.paymentBep20Address : config.paymentTrc20Address;
    const reference = `ads:${ctx.from.id}:${Date.now()}`;
    const timestamp = now(), expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const id = Number(db.prepare("INSERT INTO planPayments (telegramId, tierCode, network, amount, reference, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?)").run(ctx.from.id, tier, method, amount, reference, timestamp, expiresAt).lastInsertRowid);
    await ctx.answerCallbackQuery();
    await showFlowPrompt(ctx, { action: "payment", tier, method, paymentId: id }, `<b>Pay $${amount} · ${method}</b>\n\n${address}\n\n${method === "Binance" ? "Send USDT with Binance Pay." : "Send USDT on the selected network."}\nThen send the Order ID or transaction hash here. This request expires in 30 minutes.`, { parse_mode: "HTML", reply_markup: menu([[back(`upgrade:${tier}`, "Back to payment methods")]]) });
  });
  bot.callbackQuery("home", async (ctx) => { flows.delete(ctx.from.id); await ctx.answerCallbackQuery(); await showHome(ctx); });
  const toggleTarget = async (ctx: Context, campaignId: number, accountId: string, chatId: string, page: number) => {
    try {
      const tid = tenantId(ctx.from!.id);
      const campaign = db.prepare("SELECT senderAccountId FROM campaigns WHERE tenantId = ? AND id = ?").get(tid, campaignId) as { senderAccountId: string } | undefined;
      if (!campaign) throw new Error("campaign not found");
      const group = db.prepare("SELECT enabled FROM groups WHERE tenantId=? AND accountId=? AND chatId=? AND chatKind='group'").get(tid, accountId, chatId) as { enabled: number } | undefined;
      if (!group) throw new Error("Group unavailable. Refresh the list.");
      const tier = (db.prepare("SELECT tierCode FROM tenants WHERE tenantId = ?").get(tid) as { tierCode: string }).tierCode;
      const current = db.prepare("SELECT enabled FROM campaignTargets WHERE tenantId=? AND campaignId=? AND accountId=? AND chatId=?").get(tid, campaignId, accountId, chatId) as { enabled: number } | undefined;
      if (current?.enabled && group.enabled) {
        updateTarget(db, tid, campaignId, chatId, false, accountId);
        await ctx.answerCallbackQuery("Group removed");
      } else {
        await setGroup(db, tid, accountId, chatId, true, undefined, tier === "business" ? 2 : tier === "pro" ? 1 : 0);
        await addTarget(db, tid, campaignId, chatId, accountId);
        await ctx.answerCallbackQuery("Group selected");
      }
      await showCampaignTargets(ctx, campaignId, accountId, page);
    } catch (error) {
      await ctx.answerCallbackQuery({ text: String(error instanceof Error ? error.message : error), show_alert: true });
    }
  };
  bot.callbackQuery(/^t:(\d+):(\d+):(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const tid = tenantId(ctx.from.id);
    const group = db.prepare("SELECT chatId,accountId FROM groups WHERE rowid=? AND tenantId=? AND chatKind='group'").get(Number(ctx.match[2]), tid) as { chatId: string; accountId: string } | undefined;
    if (!group) return ctx.answerCallbackQuery({ text: "Group unavailable. Refresh the list.", show_alert: true });
    await toggleTarget(ctx, id, group.accountId, group.chatId, Number(ctx.match[3]));
  });
  bot.callbackQuery(/^target:(\d+):([^:]+)$/, async (ctx) => {
    const campaign = db.prepare("SELECT senderAccountId FROM campaigns WHERE tenantId=? AND id=?").get(tenantId(ctx.from.id), Number(ctx.match[1])) as { senderAccountId: string } | undefined;
    if (!campaign) return ctx.answerCallbackQuery({ text: "Campaign not found", show_alert: true });
    await toggleTarget(ctx, Number(ctx.match[1]), campaign.senderAccountId, ctx.match[2]!, 0);
  });
  bot.on("message:text", async (ctx, next) => {
    const flow = flows.get(ctx.from.id);
    if (!flow) return next();
    if (flow.action === "campaign") return next();
    if (flow.action === "sending_code" || flow.action === "verifying_code") {
      await flowRich(ctx, flow, "Telegram is still processing the previous step. Please wait, or cancel this login.", { reply_markup: menu([[loginBack(ctx.from.id)]]) });
      return;
    }
    try {
      if (flow.action === "phone") {
        const phone = ctx.message.text.trim();
        if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
          await flowRich(ctx, flow, "Send a valid phone number in international format, such as <code>+1234567890</code>.", { parse_mode: "HTML", reply_markup: menu([[loginBack(ctx.from.id)]]) });
          return;
        }
        if (flow.accountId) {
          const existing = accounts(db, tenantId(ctx.from.id)).find((account) => account.accountId === flow.accountId);
          if (existing?.phone && existing.phone !== phone) {
            await flowRich(ctx, flow, `Send the phone number already linked to this account: <code>${escapeHtml(existing.phone)}</code>.`, { parse_mode: "HTML", reply_markup: menu([[back("login:cancel", "Back to account")]]) });
            return;
          }
        }
        const sendingFlow: Flow = { action: "sending_code", accountId: flow.accountId ?? randomUUID(), phone, uiMessageId: flow.uiMessageId };
        flows.set(ctx.from.id, sendingFlow);
        const progress = await flowRich(ctx, sendingFlow, "Connecting to Telegram", { reply_markup: menu([[loginBack(ctx.from.id)]]) });
        const action = setInterval(() => void ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => undefined), 4_000);
        try {
          await ctx.api.sendChatAction(ctx.chat.id, "typing");
          const result = await loginStart(db, tenantId(ctx.from.id), phone, sendingFlow.accountId);
          if (flows.get(ctx.from.id) !== sendingFlow) {
            await cancelLogin(db, tenantId(ctx.from.id), result.accountId);
            return;
          }
          flows.set(ctx.from.id, { action: "code", accountId: result.accountId, phone, uiMessageId: progress });
          await editRichAt(ctx, progress, `✅ <b>Code sent</b>\n\nTelegram sent a login code to <code>${escapeHtml(phone)}</code>. Check that account's Telegram app or SMS, then send the code here. This must be a different account from the one operating this bot.`, { parse_mode: "HTML", reply_markup: menu([[loginBack(ctx.from.id)]]) });
        } finally {
          clearInterval(action);
        }
      } else if (flow.action === "code" || flow.action === "password") {
        const rawInput = ctx.message.text.trim();
        const inputCode = rawInput.replace(/\s+/g, "");
        const code = flow.action === "password" ? flow.code : inputCode;
        const passwordValue = flow.action === "password" ? rawInput : undefined;
        if (flow.action === "code" && !/^\d{5,6}$/.test(inputCode)) {
          await flowRich(ctx, flow, "Send the 5 or 6 digit login code from Telegram.\n\n💡 Tip: You can send it with or without spaces (e.g., <code>12345</code> or <code>1 2 3 4 5</code>).", { parse_mode: "HTML", reply_markup: menu([[loginBack(ctx.from.id)]]) });
          return;
        }
        const verifyingFlow: Flow = { ...flow, action: "verifying_code" };
        flows.set(ctx.from.id, verifyingFlow);
        const progress = await flowRich(ctx, verifyingFlow, "Verifying your login with Telegram", { reply_markup: menu([[loginBack(ctx.from.id)]]) });
        const action = setInterval(() => void ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => undefined), 4_000);
        try {
          await ctx.api.sendChatAction(ctx.chat.id, "typing");
          await loginComplete(db, tenantId(ctx.from.id), flow.accountId!, flow.phone!, code ?? "", passwordValue);
          if (flows.get(ctx.from.id) !== verifyingFlow) return;
          flows.delete(ctx.from.id);
          await editRichAt(ctx, progress, "<b>Userbot connected</b>\nYou can now sync its groups and create a campaign.", { parse_mode: "HTML", reply_markup: home() });
        } catch (error) {
          if (flows.get(ctx.from.id) !== verifyingFlow) return;
          if (String(error).toUpperCase().includes("SESSION_PASSWORD_NEEDED") && flow.action === "code") {
            flows.set(ctx.from.id, { ...flow, action: "password", code: code! });
            await editRichAt(ctx, progress, "🔐 <b>Two-step verification required</b>\n\nThis account has 2FA enabled. Send your cloud password (the one you set in Security settings, not the login code) to complete the connection.", { parse_mode: "HTML", reply_markup: menu([[loginBack(ctx.from.id)]]) });
          } else if (flow.action === "password" && !flow.code && /PHONE_CODE_INVALID|not waiting for a login code/i.test(String(error))) {
            flows.set(ctx.from.id, { ...flow, action: "code" });
            await editRichAt(ctx, progress, "The login session resumed after a restart. Send the Telegram code again, or cancel to request a new one.", { reply_markup: menu([[loginBack(ctx.from.id)]]) });
          } else if (String(error).toUpperCase().includes("ALREADY CONNECTED") || String(error).includes("account operating this bot")) {
            flows.delete(ctx.from.id);
            await editRichAt(ctx, progress, `<b>Account not connected</b><br/>${escapeHtml(String(error instanceof Error ? error.message : error))}`, { parse_mode: "HTML", reply_markup: menu([[back("accounts", "Back to accounts")]]) });
          } else {
            flows.set(ctx.from.id, { ...flow, action: flow.action === "password" ? "password" : "code", code: flow.action === "password" ? flow.code : code });
            await editRichAt(ctx, progress, `❌ <b>Login failed</b>\n\n${loginError(error)}\n\nTry again or cancel to start over.`, { parse_mode: "HTML", reply_markup: menu([[loginBack(ctx.from.id)]]) });
          }
        } finally {
          clearInterval(action);
        }
      } else if (flow.action === "payment") {
        const payment = db.prepare("SELECT id, telegramId, tierCode, network, amount, createdAt, expiresAt, status FROM planPayments WHERE id = ?").get(flow.paymentId) as { id: number; telegramId: number; tierCode: string; network: PaymentMethod; amount: number; createdAt: string; expiresAt: string; status: string } | undefined;
        if (!payment || payment.status !== "pending" || payment.telegramId !== ctx.from.id || Date.parse(payment.expiresAt) <= Date.now()) throw new Error("Payment request expired. Start a new upgrade request.");
        const verified = await verifyPayment(payment.network, ctx.message.text.trim(), payment.createdAt, payment.amount);
        if (!verified) return flowRich(ctx, flow, "I couldn’t match that payment yet. Check the ID and try again after the transfer confirms.", { reply_markup: menu([[back(`upgrade:${payment.tierCode}`, "Back to payment methods")]]) });
        const currentUntil = (db.prepare("SELECT paidUntil FROM localUsers WHERE telegramId = ?").get(ctx.from.id) as { paidUntil: string | null }).paidUntil;
        const paidUntil = new Date(Math.max(Date.now(), currentUntil ? Date.parse(currentUntil) : 0) + 30 * 86400_000).toISOString();
        try {
          const activate = db.transaction(() => {
          const updated = db.prepare("UPDATE planPayments SET externalId = ?, status = 'paid' WHERE id = ? AND status = 'pending'").run(verified.canonicalId, payment.id);
          if (!updated.changes) throw new Error("Payment request was already processed.");
          db.prepare("UPDATE localUsers SET tierCode = ?, paidUntil = ?, updatedAt = ? WHERE telegramId = ?").run(payment.tierCode, paidUntil, now(), ctx.from.id);
          const limits = JSON.stringify(tierLimits(payment.tierCode));
          db.prepare("UPDATE tenants SET tierCode = ?, limits = ?, version = version + 1, updatedAt = ? WHERE tenantId = ?").run(payment.tierCode, limits, now(), tenantId(ctx.from.id));
          });
          activate();
          enforceTenantLimits(db, tenantId(ctx.from.id));
        } catch (error) {
          if (String(error).includes("UNIQUE constraint failed")) throw new Error("That transaction has already been used.");
          throw error;
        }
        flows.delete(ctx.from.id);
        const list = accounts(db, tenantId(ctx.from.id));
        const primary = list.some((item) => item.status === "active") ? "campaign" : list.some((item) => item.phone) ? "accounts" : "connect";
        await flowRich(ctx, flow, `${payment.tierCode} is active until ${new Date(paidUntil).toLocaleDateString()}.`, { reply_markup: home(primary) });
      }
    } catch (error) {
      if (["phone", "sending_code"].includes(flows.get(ctx.from.id)?.action ?? "")) {
        const previous = flows.get(ctx.from.id);
        const retryFlow: Flow = { action: "phone", accountId: previous?.accountId, uiMessageId: previous?.uiMessageId };
        flows.set(ctx.from.id, retryFlow);
        await flowRich(ctx, retryFlow, `Could not request a login code: ${loginError(error)}\nCheck the number and try again, or cancel the login.`, { reply_markup: menu([[loginBack(ctx.from.id)]]) });
      } else {
        const activeFlow = flows.get(ctx.from.id);
        await flowRich(ctx, activeFlow, String(error instanceof Error ? error.message : error), { reply_markup: menu([[activeFlow?.action === "payment" && activeFlow.tier ? back(`upgrade:${activeFlow.tier}`, "Back to payment methods") : back("home", "Back to home")]]) });
      }
    }
  });
  bot.on("message", async (ctx) => {
    const flow = flows.get(ctx.from.id);
    if (flow?.action !== "campaign") return;
    let savedCampaignId: number | null = null;
    try {
      const msg = ctx.message;
      if (msg.media_group_id) throw new Error("Telegram sends albums as separate updates. Send one post at a time so the campaign keeps the complete post.");
      if (msg.reply_markup?.inline_keyboard.some((row) => row.some((item) => !("url" in item || "copy_text" in item))))
        throw new Error("This post contains buttons tied to another bot. Use URL or copy buttons instead.");
      const message = msg.text ?? msg.caption ?? (msg.rich_message ? "[Telegram rich message]" : "[Telegram media]");
      const tid = tenantId(ctx.from.id);
      const richContent = msg.rich_message ? reusableRichMessage(msg.rich_message) : null;
      const inlineMedia = cachedInlineMedia(msg);
      const inlineSupported = !!(config.botUsername && !msg.has_media_spoiler && (richContent || msg.text || inlineMedia));
      if (!inlineSupported && (!msg.text || msg.reply_markup || msg.link_preview_options) && !config.archiveChat)
        throw new Error("This post needs ADS_ARCHIVE_CHAT to keep all content intact. Configure a dedicated archive chat and send it again.");
      if (config.archiveChat && config.archiveChat.replace(/^@/, "").toLowerCase() === config.forceJoinChat.replace(/^@/, "").toLowerCase())
        throw new Error("ADS_ARCHIVE_CHAT must be separate from the public group.");
      const archived = config.archiveChat ? await ctx.api.copyMessage(config.archiveChat, msg.chat.id, msg.message_id) : null;
      const entities = msg.entities ?? msg.caption_entities ?? [];
      const inlineOptions = { link_preview_options: msg.link_preview_options, reply_markup: msg.reply_markup, has_media_spoiler: msg.has_media_spoiler };
      const created = db.transaction(() => {
        const row = createCampaign(db, tid, { name: message.slice(0, 50), message, senderAccountId: flow.accountId!, intervalSeconds: 300 }) as { id: number };
        db.prepare("UPDATE campaigns SET messageEntities = ?, sourceChatId = ?, sourceMessageId = ?, richMessage = ?, richContent = ?, inlineOptions = ?, contentKind=?, inlineMode = ? WHERE id = ? AND tenantId = ?")
          .run(JSON.stringify(entities), archived ? config.archiveChat : null, archived?.message_id ?? null, inlineMedia ? JSON.stringify(inlineMedia) : null, richContent ? JSON.stringify(richContent) : null, JSON.stringify(inlineOptions), richContent ? "rich" : msg.text ? "text" : "media", inlineSupported ? 1 : 0, row.id, tid);
        return row;
      })();
      savedCampaignId = created.id;
      flows.delete(ctx.from.id);
      await showCampaignAccounts(ctx, created.id, 0, flow);
    } catch (error) {
      await flowRich(ctx, flow, `${savedCampaignId ? "Campaign saved, but the account screen could not open" : "Could not save this campaign"}: ${escapeHtml(String(error instanceof Error ? error.message : error))}`, { parse_mode: "HTML", reply_markup: menu([[back(savedCampaignId ? `campaign:${savedCampaignId}` : "newcampaign:back", savedCampaignId ? "Open campaign" : "Back to campaigns")]]) });
    }
  });
  bot.catch((error) => console.error(`ads bot update failed: ${String(error)}`));
  let stopping = false;
  let active: ReturnType<typeof run> | null = null;
  const start = () => {
    if (stopping) return;
    const handle = run(bot, { runner: { fetch: { allowed_updates: ["message", "callback_query", "inline_query", "chat_member"] } }, sink: { concurrency: 128 } });
    active = handle;
    console.log("Ads bot started");
    const task = handle.task();
    if (task) void task.then(() => { if (!stopping) setTimeout(start, 1_000).unref(); })
      .catch((error) => { console.error(`ads bot polling failed: ${String(error)}`); if (!stopping) setTimeout(start, 5_000).unref(); });
  };
  process.once("SIGTERM", () => { stopping = true; void active?.stop(); });
  process.once("SIGINT", () => { stopping = true; void active?.stop(); });
  start();
}
