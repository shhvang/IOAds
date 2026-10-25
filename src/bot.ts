import { Bot, InlineKeyboard, type Context } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { now } from "./db.js";
import { accounts, cancelLogin, loginComplete, loginStart, logout } from "./services/account.js";
import { addTarget, createCampaign, listCampaigns, setCampaignStatus } from "./services/campaigns.js";
import { syncGroups, setGroup } from "./services/groups.js";
import { tierLimits } from "./services/plans.js";
import { paymentMethods, verifyPayment, type PaymentMethod } from "./payments.js";

type Flow = { action: "phone" | "sending_code" | "code" | "password" | "verifying_code" | "campaign" | "payment"; accountId?: string; phone?: string; code?: string; tier?: string; method?: PaymentMethod; paymentId?: number };

const button = (text: string, callback_data: string): InlineKeyboardButton => ({
  text, callback_data,
});

function menu(rows: InlineKeyboardButton[][]): InlineKeyboard {
  return new InlineKeyboard(rows);
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]!);
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
  if (/TIMEOUT|NETWORK|CONNECTION/.test(text)) return "Telegram is taking too long to respond. Try again shortly.";
  return "Telegram could not complete this step. Try again or cancel the login.";
}

export function startAdsBot(db: Database.Database): void {
  if (!config.botToken) return;
  const bot = new Bot(config.botToken, { client: { apiRoot: config.telegramApiRoot } });
  
  void bot.api.setMyCommands([
    { command: "start", description: "Start the bot" },
    { command: "menu", description: "Show main menu" },
    { command: "help", description: "Get help" },
  ]);
  
  const flows = new Map<number, Flow>();
  const tenantId = (userId: number): string => {
    const row = db.prepare("SELECT tenantId FROM localUsers WHERE telegramId = ?").get(userId) as { tenantId: string } | undefined;
    if (!row) throw new Error("Send /start to set up your ads account.");
    return row.tenantId;
  };
  const home = () => menu([
    [button("Start", "newcampaign")],
    [button("Campaigns", "campaigns"), button("Accounts", "accounts")],
    [button("Groups", "groups"), button("Schedule", "schedule")],
    [button("Activity", "activity"), button("Plan", "plan")],
    [button("Settings", "settings"), button("Help", "help")],
  ]);
  const showHome = async (ctx: Context) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const tid = tenantId(userId);
    const user = db.prepare("SELECT tierCode FROM localUsers WHERE telegramId = ?").get(userId) as { tierCode: string };
    const sentToday = (db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE tenantId = ? AND status='sent' AND sentAt >= date('now')").get(tid) as { n: number }).n;
    const limits = tierLimits(user.tierCode);
    const connected = accounts(db, tid).filter((a) => a.status === "active").length;
    const running = Number((db.prepare("SELECT COUNT(*) AS n FROM campaigns WHERE tenantId = ? AND status = 'scheduled'").get(tid) as { n: number }).n);
    const caption = `📢 <b>Welcome to IOAds</b>\nPlan and manage Telegram campaigns from one place. Link an account, pick groups it already belongs to, then schedule your first ad.\n\n<b>Accounts</b>  ${connected}/${limits.accounts} connected\n<b>Campaigns</b>  ${running} scheduled\n<b>Today</b>  ${sentToday.toLocaleString()}/${limits.dailyMessages.toLocaleString()} messages\n\nStart a campaign, review your groups, or explore your plan and activity below.`;
    if (config.welcomeImage) await ctx.replyWithPhoto(config.welcomeImage, { caption, parse_mode: "HTML", reply_markup: home() });
    else await ctx.reply(caption, { parse_mode: "HTML", reply_markup: home() });
  };
  bot.use(async (ctx, next) => {
    const flow = ctx.from ? flows.get(ctx.from.id) : undefined;
    if (ctx.callbackQuery && flow && ["phone", "sending_code", "code", "password", "verifying_code"].includes(flow.action)
      && ctx.callbackQuery.data !== "login:cancel") {
      await ctx.answerCallbackQuery({ text: "Finish or cancel the current userbot login first.", show_alert: true });
      return;
    }
    if (ctx.from && !ctx.message?.text?.startsWith("/start")) {
      try {
        const member = await ctx.api.getChatMember(config.forceJoinChat, ctx.from.id);
         if (member.status === "left" || member.status === "kicked" || (member.status === "restricted" && !member.is_member)) {
          db.prepare("UPDATE localUsers SET forceJoined = 0, updatedAt = ? WHERE telegramId = ?").run(now(), ctx.from.id);
          await ctx.reply("Join @iobuysell to use your userbots.", { reply_markup: menu([[{ text: "Join", url: "https://t.me/iobuysell" }], [button("Check", "home")]]) });
          return;
        }
        db.prepare("UPDATE localUsers SET forceJoined = 1, updatedAt = ? WHERE telegramId = ?").run(now(), ctx.from.id);
      } catch {
         await ctx.reply("I can’t verify your @iobuysell membership yet. Open the group, then try again.", { reply_markup: menu([[{ text: "Open", url: "https://t.me/iobuysell" }]]) });
        return;
      }
    }
    await next();
  });
  bot.command("start", async (ctx) => {
    const userId = ctx.from!.id;
    const tid = `ads:${userId}`;
    db.prepare("INSERT OR IGNORE INTO localUsers (telegramId, tenantId, tierCode, createdAt, updatedAt) VALUES (?, ?, 'free', ?, ?)").run(userId, tid, now(), now());
    db.prepare(`INSERT OR IGNORE INTO tenants (tenantId, productId, ownerId, state, tierCode, runtime, version, trial, suspendReason, periodEnd, retainUntil, limits, config, secretsFingerprint, controlBotFingerprint, controlBotToken, fault, updatedAt, appliedAt) VALUES (?, 'ads-standalone', ?, 'active', 'free', 'service', 1, 0, NULL, NULL, NULL, ?, '{}', NULL, NULL, NULL, NULL, ?, ?)`)
      .run(tid, userId, JSON.stringify(tierLimits("free")), now(), now());
    try {
      const member = await ctx.api.getChatMember(config.forceJoinChat, userId);
       if (member.status === "left" || member.status === "kicked" || (member.status === "restricted" && !member.is_member)) {
          await ctx.reply("Join @iobuysell to activate campaigns. Your free ads are also posted there every 10 minutes.", { reply_markup: menu([[{ text: "Join", url: "https://t.me/iobuysell" }], [button("Check", "home")]]) });
        return;
      }
      db.prepare("UPDATE localUsers SET forceJoined = 1, updatedAt = ? WHERE telegramId = ?").run(now(), userId);
    } catch {
      await ctx.reply("I can’t check @iobuysell right now. Try again shortly.");
      return;
    }
    await showHome(ctx);
  });
  bot.command("menu", showHome);
  bot.command("help", (ctx) => ctx.reply("Welcome to IOAds. Connect a Telegram account, choose groups it already belongs to, then forward an ad to create a campaign. Set its schedule and delivery method, and review activity any time from the dashboard."));
  bot.callbackQuery("help", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.editMessageText("<b>Getting started</b>\nConnect an account, sync its existing groups, then forward the message you want to promote. Choose targets, set an interval from 5 minutes to 1 hour, and schedule it.\n\nAccounts remain yours: IOAds only uses groups visible to the account and never joins groups or messages members.", { parse_mode: "HTML", reply_markup: menu([[button("Start", "newcampaign")], [button("Accounts", "accounts"), button("Groups", "groups")], [button("Home", "home")]]) }); });
  bot.callbackQuery("schedule", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.editMessageText("<b>Schedule</b>\nReview campaign status, delivery interval, target groups, and posting method. Open any campaign to pause it or change its timing.", { parse_mode: "HTML", reply_markup: menu([[button("Campaigns", "campaigns")], [button("Start", "newcampaign")], [button("Home", "home")]]) }); });
  bot.callbackQuery("activity", async (ctx) => {
    await ctx.answerCallbackQuery();
    const rows = db.prepare("SELECT c.name, d.chatId, d.status, d.sentAt FROM deliveries d JOIN campaigns c ON c.id = d.campaignId WHERE d.tenantId = ? ORDER BY d.id DESC LIMIT 8").all(tenantId(ctx.from.id)) as Array<{ name: string; chatId: string; status: string; sentAt: string | null }>;
    const body = rows.length ? rows.map((row) => `• <b>${escapeHtml(row.name)}</b> · ${row.status} · ${escapeHtml(row.chatId)}`).join("\n") : "No deliveries yet. Completed sends will appear here.";
    await ctx.editMessageText(`🗃 <b>Activity</b>\nRecent campaign deliveries\n\n${body}`, { parse_mode: "HTML", reply_markup: menu([[button("Campaigns", "campaigns")], [button("Home", "home")]]) });
  });
  bot.callbackQuery("settings", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.editMessageText("<b>Settings</b>\nManage linked Telegram accounts, group access, plan limits, and campaign delivery preferences.", { parse_mode: "HTML", reply_markup: menu([[button("Accounts", "accounts"), button("Groups", "groups")], [button("Plan", "plan"), button("Home", "home")]]) }); });
  bot.callbackQuery("accounts", async (ctx) => {
    await ctx.answerCallbackQuery();
    const list = accounts(db, tenantId(ctx.from.id));
    const keyboard = menu([[button("Add", "connect")], ...list.map((account, index) => [button(String(index + 1), `account:${account.accountId}`)]), [button("Back", "home")]]);
    const lines = list.map((account, index) => `${index + 1}. <b>${account.phone ?? "Telegram account"}</b> · ${account.status}`);
    await ctx.editMessageText(`👥 <b>Accounts</b>\n${lines.length ? `${lines.length} linked account${lines.length === 1 ? "" : "s"}. Select a number to manage it.\n\n${lines.join("\n")}` : "Connect a Telegram account to select groups and send scheduled campaigns."}`, { parse_mode: "HTML", reply_markup: keyboard });
  });
  bot.callbackQuery(/^account:(.+)$/, async (ctx) => {
    const accountId = ctx.match[1]!;
    const keyboard = menu([[button("Logout", `logout:${accountId}`)], [button("Back", "accounts")]]);
    await ctx.answerCallbackQuery();
    const account = accounts(db, tenantId(ctx.from.id)).find((item) => item.accountId === accountId);
    await ctx.editMessageText(`👥 <b>Account</b>\n${account?.phone ?? "Telegram account"}\nStatus: ${account?.status ?? "unknown"}\n\nLogging out pauses campaigns that use this account.`, { parse_mode: "HTML", reply_markup: keyboard });
  });
  bot.callbackQuery(/^logout:(.+)$/, async (ctx) => {
    try {
      await logout(db, tenantId(ctx.from.id), ctx.match[1]!);
      await ctx.answerCallbackQuery("Userbot logged out");
      await ctx.editMessageText("Account logged out. Campaigns using it will wait until the account reconnects.", { reply_markup: menu([[button("Accounts", "accounts")], [button("Home", "home")]]) });
    } catch (error) {
      await ctx.answerCallbackQuery({ text: String(error instanceof Error ? error.message : error), show_alert: true });
    }
  });
  bot.callbackQuery("connect", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (["phone", "sending_code", "code", "password", "verifying_code"].includes(flows.get(ctx.from.id)?.action ?? "")) {
      await ctx.reply("A login is already in progress. Finish it or cancel it before starting another account.", { reply_markup: menu([[button("Cancel", "login:cancel")]]) });
      return;
    }
    flows.set(ctx.from.id, { action: "phone" });
    await ctx.reply(`👥 <b>Connect an account</b>\n\n<b>Step 1:</b> Send the phone number with country code (e.g., <code>+1234567890</code>)\n<b>Step 2:</b> Telegram will send a login code\n<b>Step 3:</b> Send the code here\n<b>Step 4:</b> If 2FA is enabled, send the password\n\n⚠️ <b>Important:</b> If you're connecting <i>this account</i> (the one using this bot), send the code with spaces: <code>1 2 3 4 5</code> to prevent auto-fill.\n\nYour session is encrypted and stays on this service.`, { parse_mode: "HTML", reply_markup: menu([[button("Cancel", "login:cancel")]]) });
  });
  bot.callbackQuery("login:cancel", async (ctx) => {
    const flow = flows.get(ctx.from.id);
    if (flow?.accountId && ["sending_code", "code", "password", "verifying_code"].includes(flow.action)) await cancelLogin(db, tenantId(ctx.from.id), flow.accountId);
    flows.delete(ctx.from.id);
    await ctx.answerCallbackQuery("Login cancelled");
    await ctx.editMessageText("Account login cancelled. No account was connected.", { reply_markup: menu([[button("Accounts", "accounts")], [button("Home", "home")]]) });
  });
  bot.callbackQuery("campaigns", async (ctx) => {
    await ctx.answerCallbackQuery();
    const tid = tenantId(ctx.from.id), list = listCampaigns(db, tid) as Array<{ id: number; name: string; status: string; intervalSeconds: number }>;
    const keyboard = menu([[button("Start", "newcampaign")], ...list.slice(0, 8).map((c, index) => [button(String(index + 1), `campaign:${c.id}`)]), [button("Back", "home")]]);
    const body = list.slice(0, 8).map((c, index) => `${index + 1}. <b>${escapeHtml(c.name)}</b> · ${c.status} · every ${c.intervalSeconds / 60}m`).join("\n");
    await ctx.editMessageText(`📢 <b>Campaigns</b>\n${list.length ? `${list.length} campaign${list.length === 1 ? "" : "s"}. Select a number to review its schedule and delivery settings.\n\n${body}` : "No campaigns yet. Create one by forwarding your ad, then choose where and how often it should post."}`, { parse_mode: "HTML", reply_markup: keyboard });
  });
  bot.inlineQuery(/.*/, async (ctx) => {
    const user = db.prepare("SELECT tenantId FROM localUsers WHERE telegramId = ? AND forceJoined = 1").get(ctx.from.id) as { tenantId: string } | undefined;
    const campaignId = /^campaign:(\d+)$/.exec(ctx.inlineQuery.query)?.[1];
    const campaigns = (campaignId
      ? db.prepare(`SELECT c.id, c.name, c.message, c.messageEntities, c.richMessage FROM campaigns c
          JOIN accounts a ON a.tenantId = c.tenantId AND a.accountId = c.senderAccountId
          WHERE c.id = ? AND ((? IS NOT NULL AND c.tenantId = ? AND ? = 1) OR a.telegramUserId = ?)`)
        .all(Number(campaignId), user?.tenantId ?? null, user?.tenantId ?? null, user ? 1 : 0, ctx.from.id)
      : user
        ? db.prepare("SELECT id, name, message, messageEntities, richMessage FROM campaigns WHERE tenantId = ? AND status IN ('draft','scheduled','paused') ORDER BY id DESC LIMIT 20").all(user.tenantId)
        : []) as Array<{ id: number; name: string; message: string; messageEntities: string; richMessage: string | null }>;
    await ctx.answerInlineQuery(campaigns.map((campaign) => ({ type: "article" as const, id: String(campaign.id), title: campaign.name, description: campaign.message.slice(0, 100), input_message_content: campaign.richMessage ? { rich_message: JSON.parse(campaign.richMessage) } : { message_text: campaign.message, entities: JSON.parse(campaign.messageEntities) } })), { cache_time: 0, is_personal: true });
  });
  bot.callbackQuery("newcampaign", async (ctx) => {
    const list = accounts(db, tenantId(ctx.from.id)).filter((a) => a.status === "active");
    await ctx.answerCallbackQuery();
    if (!list.length) return ctx.reply("Connect an account before creating a campaign.", { reply_markup: menu([[button("Add", "connect")], [button("Back", "home")]]) });
    flows.set(ctx.from.id, { action: "campaign", accountId: list[0]!.accountId });
    await ctx.reply("<b>New campaign</b>\nForward the original ad message here. Text, formatting, photos, videos, and supported rich content are preserved. You can choose the groups and schedule next.", { parse_mode: "HTML", reply_markup: menu([[button("Cancel", "home")]]) });
  });
  bot.callbackQuery(/^campaign:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = Number(ctx.match[1]), campaign = db.prepare("SELECT name, status, intervalSeconds FROM campaigns WHERE tenantId = ? AND id = ?").get(tenantId(ctx.from.id), id) as { name: string; status: string; intervalSeconds: number } | undefined;
    if (!campaign) return ctx.reply("Campaign not found.");
    const action = campaign.status === "scheduled" ? "pause" : "schedule";
    const inline = db.prepare("SELECT inlineMode FROM campaigns WHERE tenantId = ? AND id = ?").get(tenantId(ctx.from.id), id) as { inlineMode: number };
    const rows: InlineKeyboardButton[][] = [[button(action === "pause" ? "Pause" : "Schedule", `setcampaign:${id}:${action}`), button("Cancel", `setcampaign:${id}:cancel`)], [button("5m", `interval:${id}:300`), button("30m", `interval:${id}:1800`), button("60m", `interval:${id}:3600`)]];
    if (!['free', 'starter'].includes((db.prepare("SELECT tierCode FROM localUsers WHERE telegramId = ?").get(ctx.from.id) as { tierCode: string }).tierCode)) rows.push([button(inline.inlineMode ? "Direct" : "Inline", `inline:${id}`)]);
    rows.push([button("Back", "campaigns")]);
    const keyboard = menu(rows);
    await ctx.editMessageText(`<b>${campaign.name}</b>\nStatus: ${campaign.status}\nInterval: ${campaign.intervalSeconds / 60} minutes\nPosting: ${inline.inlineMode ? "bot inline via userbot" : "direct userbot"}`, { parse_mode: "HTML", reply_markup: keyboard });
  });
  bot.callbackQuery(/^interval:(\d+):(300|1800|3600)$/, async (ctx) => {
    const [, id, seconds] = ctx.match;
    db.prepare("UPDATE campaigns SET intervalSeconds = ?, nextRunAt = NULL, updatedAt = ? WHERE tenantId = ? AND id = ?").run(Number(seconds), now(), tenantId(ctx.from.id), Number(id));
    await ctx.answerCallbackQuery("Interval updated");
    const campaign = db.prepare("SELECT name, status FROM campaigns WHERE tenantId = ? AND id = ?").get(tenantId(ctx.from.id), Number(id)) as { name: string; status: string } | undefined;
    if (campaign) await ctx.editMessageText(`<b>${escapeHtml(campaign.name)}</b>\nStatus: ${campaign.status}\nInterval: ${Number(seconds) / 60} minutes`, { parse_mode: "HTML", reply_markup: menu([[button("Schedule", `setcampaign:${id}:schedule`), button("Cancel", `setcampaign:${id}:cancel`)], [button("5m", `interval:${id}:300`), button("30m", `interval:${id}:1800`), button("60m", `interval:${id}:3600`)], [button("Back", `campaign:${id}`)]]) });
  });
  bot.callbackQuery(/^inline:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    db.prepare("UPDATE campaigns SET inlineMode = 1 - inlineMode, updatedAt = ? WHERE tenantId = ? AND id = ?").run(now(), tenantId(ctx.from.id), id);
    await ctx.answerCallbackQuery("Posting method updated");
  });
  bot.callbackQuery(/^setcampaign:(\d+):(pause|schedule|cancel)$/, async (ctx) => {
    const [, rawId, status] = ctx.match;
    setCampaignStatus(db, tenantId(ctx.from.id), Number(rawId), status === "pause" ? "paused" : status === "cancel" ? "cancelled" : "scheduled");
    await ctx.answerCallbackQuery("Campaign updated");
    await ctx.editMessageText(`Campaign ${status === "cancel" ? "cancelled" : status}.`, { reply_markup: menu([[button("Campaigns", "campaigns")], [button("Dashboard", "home")]]) });
  });
  bot.callbackQuery("groups", async (ctx) => {
    const tid = tenantId(ctx.from.id), list = accounts(db, tid).filter((a) => a.status === "active");
    await ctx.answerCallbackQuery();
    if (!list.length) return ctx.reply("No account linked yet.", { reply_markup: menu([[button("Add", "connect")]]) });
    const groups = await syncGroups(db, tid, list[0]!.accountId) as Array<{ chatId: string; title: string; enabled: number }>;
    const rows = groups.slice(0, 30).map((group, index) => [button(String(index + 1), `group:${list[0]!.accountId}:${group.chatId}:${group.enabled ? 0 : 1}`)]);
    rows.push([button("Back", "home")]);
    const body = groups.slice(0, 30).map((group, index) => `${index + 1}. <b>${escapeHtml(group.title)}</b> · ${group.enabled ? "included" : "excluded"}`).join("\n");
    await ctx.reply(`<b>Groups</b>\nSelect a group number to toggle campaign delivery. Only chats already visible to your account are listed.\n\n${body || "No eligible groups found. Sync the account after joining groups from Telegram."}`, { parse_mode: "HTML", reply_markup: menu(rows) });
  });
  bot.callbackQuery(/^group:([^:]+):([^:]+):(0|1)$/, async (ctx) => {
    const [, accountId, chatId, enabled] = ctx.match;
    const tier = (db.prepare("SELECT tierCode FROM tenants WHERE tenantId = ?").get(tenantId(ctx.from.id)) as { tierCode: string }).tierCode;
    await setGroup(db, tenantId(ctx.from.id), accountId!, chatId!, enabled === "1", undefined, tier === "business" ? 2 : tier === "pro" ? 1 : 0);
    await ctx.answerCallbackQuery(enabled === "1" ? "Group enabled" : "Group disabled");
  });
  bot.callbackQuery("plan", async (ctx) => {
    flows.delete(ctx.from.id);
    await ctx.answerCallbackQuery();
    const row = db.prepare("SELECT tierCode FROM localUsers WHERE telegramId = ?").get(ctx.from.id) as { tierCode: string };
    const expires = db.prepare("SELECT paidUntil FROM localUsers WHERE telegramId = ?").get(ctx.from.id) as { paidUntil: string | null };
    const rows = [[button("Pro", "upgrade:pro")], [button("Business", "upgrade:business")], [button("Back", "home")]];
    await ctx.editMessageText(`💳 <b>${row.tierCode} plan</b>${expires.paidUntil ? ` · until ${new Date(expires.paidUntil).toLocaleDateString()}` : ""}\n\nFree · 500 messages/day · 1 userbot\nPro · 2,000/day · 5 userbots\nBusiness · 10,000/day · 15 userbots\n\nPayments are verified automatically.`, { parse_mode: "HTML", reply_markup: menu(rows) });
  });
  bot.callbackQuery(/^upgrade:(pro|business)$/, async (ctx) => {
    const tier = ctx.match[1]!;
    const monthly = tier === "pro" ? 1 : 3;
    const date = new Date(Date.now() + 30 * 86400_000).toISOString();
    const available = paymentMethods();
    if (!available.length) return ctx.answerCallbackQuery({ text: "Payments aren’t configured yet. Ask the bot owner.", show_alert: true });
    await ctx.answerCallbackQuery();
    const rows = available.map((method) => [button(method === "Binance" ? "Binance" : method, `pay:${tier}:${method}`)]);
    rows.push([button("Back", "plan")]);
    const keyboard = menu(rows);
    await ctx.reply(`<b>${tier} · $${monthly}/month</b>\nChoose a payment method. Access begins after the transfer is verified.`, { parse_mode: "HTML", reply_markup: keyboard });
  });
  bot.callbackQuery(/^pay:(pro|business):(Binance|BEP20|TRC20)$/, async (ctx) => {
    const tier = ctx.match[1]!, method = ctx.match[2] as PaymentMethod;
    const amount = tier === "pro" ? 1 : 3;
    if (!paymentMethods().includes(method)) return ctx.answerCallbackQuery({ text: "Payment method unavailable", show_alert: true });
    const address = method === "Binance" ? `Binance Pay UID: ${config.paymentBinancePayId}` : method === "BEP20" ? config.paymentBep20Address : config.paymentTrc20Address;
    const reference = `ads:${ctx.from.id}:${Date.now()}`;
    const timestamp = now(), expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const id = Number(db.prepare("INSERT INTO planPayments (telegramId, tierCode, network, amount, reference, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?)").run(ctx.from.id, tier, method, amount, reference, timestamp, expiresAt).lastInsertRowid);
    flows.set(ctx.from.id, { action: "payment", tier, method, paymentId: id });
    await ctx.answerCallbackQuery();
      await ctx.reply(`<b>Pay $${amount} · ${method}</b>\n\n${address}\n\n${method === "Binance" ? "Send USDT with Binance Pay." : "Send USDT on the selected network."}\nThen send the Order ID or transaction hash here. This request expires in 30 minutes.`, { parse_mode: "HTML", reply_markup: menu([[button("Cancel", "plan")]]) });
  });
  bot.callbackQuery("home", async (ctx) => { flows.delete(ctx.from.id); await ctx.answerCallbackQuery(); await showHome(ctx); });
  bot.callbackQuery(/^target:(\d+):([^:]+)$/, async (ctx) => {
    const [, campaignId, chatId] = ctx.match;
    try {
      const tid = tenantId(ctx.from.id);
      const campaign = db.prepare("SELECT senderAccountId FROM campaigns WHERE tenantId = ? AND id = ?").get(tid, Number(campaignId)) as { senderAccountId: string } | undefined;
      if (!campaign) throw new Error("campaign not found");
      await addTarget(db, tid, Number(campaignId), chatId!);
      const tier = (db.prepare("SELECT tierCode FROM tenants WHERE tenantId = ?").get(tid) as { tierCode: string }).tierCode;
      await setGroup(db, tid, campaign.senderAccountId, chatId!, true, undefined, tier === "business" ? 2 : tier === "pro" ? 1 : 0);
      await ctx.answerCallbackQuery("Target added");
    } catch (error) {
      await ctx.answerCallbackQuery({ text: String(error instanceof Error ? error.message : error), show_alert: true });
    }
  });
  bot.on("message:text", async (ctx, next) => {
    const flow = flows.get(ctx.from.id);
    if (!flow) return next();
    if (flow.action === "campaign") return next();
    if (flow.action === "sending_code" || flow.action === "verifying_code") {
      await ctx.reply("Telegram is still processing the previous step. Please wait, or cancel this login.");
      return;
    }
    try {
      if (flow.action === "phone") {
        const phone = ctx.message.text.trim();
        if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
          await ctx.reply("Send a valid phone number in international format, such as <code>+1234567890</code>.", { parse_mode: "HTML" });
          return;
        }
        const sendingFlow: Flow = { action: "sending_code", accountId: randomUUID(), phone };
        flows.set(ctx.from.id, sendingFlow);
        let frame = 0;
        const progress = await ctx.reply("Connecting to Telegram");
        const progressTimer = setInterval(() => {
          frame = (frame + 1) % 4;
          void ctx.api.editMessageText(ctx.chat.id, progress.message_id, `Connecting to Telegram${".".repeat(frame)}`).catch(() => undefined);
        }, 1_500);
        const action = setInterval(() => void ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => undefined), 4_000);
        try {
          await ctx.api.sendChatAction(ctx.chat.id, "typing");
          const result = await loginStart(db, tenantId(ctx.from.id), phone, sendingFlow.accountId);
          if (flows.get(ctx.from.id) !== sendingFlow) {
            await cancelLogin(db, tenantId(ctx.from.id), result.accountId);
            return;
          }
          flows.set(ctx.from.id, { action: "code", accountId: result.accountId, phone });
          clearInterval(progressTimer);
           await ctx.api.editMessageText(ctx.chat.id, progress.message_id, `✅ <b>Code sent</b>\n\nTelegram sent a login code to <code>${escapeHtml(phone)}</code>. Check the account's Telegram app or SMS.\n\n⚠️ <b>If this is your current account:</b> Send the code with spaces between digits (e.g., <code>1 2 3 4 5</code>) to prevent auto-fill.\n\n<b>Otherwise:</b> Send the code normally (e.g., <code>12345</code>).`, { parse_mode: "HTML", reply_markup: menu([[button("Cancel", "login:cancel")]]) });
        } finally {
          clearInterval(progressTimer);
          clearInterval(action);
        }
      } else if (flow.action === "code" || flow.action === "password") {
        const rawInput = ctx.message.text.trim();
        const inputCode = rawInput.replace(/\s+/g, "");
        const code = flow.action === "password" ? flow.code : inputCode;
        const passwordValue = flow.action === "password" ? rawInput : undefined;
        console.log(`[bot] User ${ctx.from.id} submitted login input: flow.action=${flow.action}, accountId=${flow.accountId}`);
        if (flow.action === "code" && !/^\d{5,6}$/.test(inputCode)) {
          console.log(`[bot] Invalid code format, rejecting`);
          await ctx.reply("Send the 5 or 6 digit login code from Telegram.\n\n💡 Tip: You can send it with or without spaces (e.g., <code>12345</code> or <code>1 2 3 4 5</code>).", { parse_mode: "HTML" });
          return;
        }
        const verifyingFlow: Flow = { ...flow, action: "verifying_code" };
        flows.set(ctx.from.id, verifyingFlow);
        console.log(`[bot] Starting verification, setting flow to verifying_code`);
        let frame = 0;
        const progress = await ctx.reply("Verifying your login with Telegram");
        const progressTimer = setInterval(() => {
          frame = (frame + 1) % 4;
          void ctx.api.editMessageText(ctx.chat.id, progress.message_id, `Verifying your login with Telegram${".".repeat(frame)}`).catch(() => undefined);
        }, 1_500);
        const action = setInterval(() => void ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => undefined), 4_000);
        try {
          console.log(`[bot] Calling loginComplete with accountId=${flow.accountId}, password=${passwordValue?'[set]':'[none]'}`);
          await ctx.api.sendChatAction(ctx.chat.id, "typing");
          await loginComplete(db, tenantId(ctx.from.id), flow.accountId!, flow.phone!, code!, passwordValue);
          clearInterval(progressTimer);
          if (flows.get(ctx.from.id) !== verifyingFlow) return;
          flows.delete(ctx.from.id);
          console.log(`[bot] Login successful for user ${ctx.from.id}`);
          await ctx.api.editMessageText(ctx.chat.id, progress.message_id, "<b>Userbot connected</b>\nYou can now sync its groups and create a campaign.", { parse_mode: "HTML", reply_markup: home() });
        } catch (error) {
          console.log(`[bot] Login failed for user ${ctx.from.id}:`, error);
          clearInterval(progressTimer);
          if (flows.get(ctx.from.id) !== verifyingFlow) return;
          if (String(error).toUpperCase().includes("SESSION_PASSWORD_NEEDED") && flow.action === "code") {
            console.log(`[bot] 2FA required, prompting for password`);
            flows.set(ctx.from.id, { ...flow, action: "password", code: code! });
             await ctx.api.editMessageText(ctx.chat.id, progress.message_id, "🔐 <b>Two-step verification required</b>\n\nThis account has 2FA enabled. Send your cloud password (the one you set in Security settings, not the login code) to complete the connection.", { parse_mode: "HTML", reply_markup: menu([[button("Cancel", "login:cancel")]]) });
          } else {
            console.log(`[bot] Showing error to user: ${loginError(error)}`);
            flows.set(ctx.from.id, { ...flow, action: flow.action === "password" ? "password" : "code", code: flow.action === "password" ? flow.code : code });
             await ctx.api.editMessageText(ctx.chat.id, progress.message_id, `❌ <b>Login failed</b>\n\n${loginError(error)}\n\nTry again or cancel to start over.`, { parse_mode: "HTML", reply_markup: menu([[button("Cancel", "login:cancel")]]) });
          }
        } finally {
          clearInterval(progressTimer);
          clearInterval(action);
        }
      } else if (flow.action === "payment") {
        const payment = db.prepare("SELECT id, telegramId, tierCode, network, amount, createdAt, expiresAt, status FROM planPayments WHERE id = ?").get(flow.paymentId) as { id: number; telegramId: number; tierCode: string; network: PaymentMethod; amount: number; createdAt: string; expiresAt: string; status: string } | undefined;
        if (!payment || payment.status !== "pending" || payment.telegramId !== ctx.from.id || Date.parse(payment.expiresAt) <= Date.now()) throw new Error("Payment request expired. Start a new upgrade request.");
        const verified = await verifyPayment(payment.network, ctx.message.text.trim(), payment.createdAt, payment.amount);
        if (!verified) return ctx.reply("I couldn’t match that payment yet. Check the ID and try again after the transfer confirms.");
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
        } catch (error) {
          if (String(error).includes("UNIQUE constraint failed")) throw new Error("That transaction has already been used.");
          throw error;
        }
        flows.delete(ctx.from.id);
        await ctx.reply(`${payment.tierCode} is active until ${new Date(paidUntil).toLocaleDateString()}.`, { reply_markup: home() });
      }
    } catch (error) {
      if (["phone", "sending_code"].includes(flows.get(ctx.from.id)?.action ?? "")) {
        flows.set(ctx.from.id, { action: "phone" });
         await ctx.reply(`Could not request a login code: ${loginError(error)}\nCheck the number and try again, or cancel the login.`, { reply_markup: menu([[button("Cancel", "login:cancel")]]) });
      } else {
        await ctx.reply(String(error instanceof Error ? error.message : error));
      }
    }
  });
  bot.on("message", async (ctx) => {
    const flow = flows.get(ctx.from.id);
    if (flow?.action !== "campaign") return;
    const msg = ctx.message;
    const message = msg.text ?? msg.caption ?? "[Telegram media or rich message]";
    const tid = tenantId(ctx.from.id), plan = (db.prepare("SELECT tierCode FROM localUsers WHERE telegramId = ?").get(ctx.from.id) as { tierCode: string }).tierCode;
    const archived = await ctx.api.copyMessage(config.archiveChat || ctx.from.id, msg.chat.id, msg.message_id);
    const created = createCampaign(db, tid, { name: message.slice(0, 50), message, senderAccountId: flow.accountId!, intervalSeconds: 300 }) as { id: number };
    db.prepare("UPDATE campaigns SET messageEntities = ?, sourceChatId = ?, sourceMessageId = ?, richMessage = ?, inlineMode = ? WHERE id = ? AND tenantId = ?")
      .run(JSON.stringify(msg.entities ?? msg.caption_entities ?? []), config.archiveChat || String(ctx.from.id), archived.message_id, msg.rich_message ? JSON.stringify(msg.rich_message) : null, plan === "free" || plan === "starter" ? 1 : 0, created.id, tid);
    flows.delete(ctx.from.id);
    const groups = await syncGroups(db, tid, flow.accountId!) as Array<{ chatId: string; title: string }>;
    const rows = groups.slice(0, 25).map((group, index) => [button(String(index + 1), `target:${created.id}:${group.chatId}`)]);
    rows.push([button("Campaigns", "campaigns")]);
    const names = groups.slice(0, 25).map((group, index) => `${index + 1}. ${escapeHtml(group.title)}`).join("\n");
    await ctx.reply(`📢 <b>Campaign saved</b>\n${plan === "free" || plan === "starter" ? "Choose groups for delivery through IOAds." : "Select the groups that should receive this ad."}\n\n${names}`, { parse_mode: "HTML", reply_markup: menu(rows) });
  });
  bot.catch((error) => console.error(`ads bot update failed: ${String(error)}`));
  void bot.start({ onStart: () => console.log("Ads bot started") });
}
