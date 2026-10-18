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
type ButtonStyle = "primary" | "success" | "danger";

const icon = {
  campaign: "5771695636411847302",
  users: "5942877472163892475",
  group: "5944970130554359187",
  plan: "5927169041595634481",
  help: "5891169510483823323",
  add: "5775937998948404844",
  back: "5877629862306385808",
  check: "5985596818912712352",
  cancel: "5985346521103604145",
  settings: "5877260593903177342",
  schedule: "5967412305338568701",
} as const;

const button = (text: string, callback_data: string, key: keyof typeof icon, style: ButtonStyle = "primary"): InlineKeyboardButton => ({
  text, callback_data, icon_custom_emoji_id: icon[key], style,
});

function menu(rows: InlineKeyboardButton[][]): InlineKeyboard {
  return new InlineKeyboard(rows);
}

function loginError(error: unknown): string {
  const text = String(error).toUpperCase();
  if (text.includes("PHONE_NUMBER_INVALID")) return "Telegram rejected this phone number.";
  if (text.includes("PHONE_NUMBER_BANNED")) return "This phone number is restricted by Telegram.";
  if (text.includes("PHONE_CODE_INVALID")) return "The code is incorrect.";
  if (text.includes("PHONE_CODE_EXPIRED")) return "The code expired. Cancel and request a new one.";
  if (text.includes("SESSION_PASSWORD_NEEDED")) return "This account needs its 2FA password after the code.";
  if (text.includes("PASSWORD_HASH_INVALID")) return "The 2FA password is incorrect.";
  if (text.includes("FLOOD_WAIT")) return "Telegram is rate limiting login attempts. Wait before trying again.";
  if (/TIMEOUT|NETWORK|CONNECTION/.test(text)) return "Telegram is taking too long to respond. Try again shortly.";
  return "Telegram could not complete this step. Try again or cancel the login.";
}

export function startAdsBot(db: Database.Database): void {
  if (!config.botToken) return;
  const bot = new Bot(config.botToken, { client: { apiRoot: config.telegramApiRoot } });
  const flows = new Map<number, Flow>();
  const tenantId = (userId: number): string => {
    const row = db.prepare("SELECT tenantId FROM localUsers WHERE telegramId = ?").get(userId) as { tenantId: string } | undefined;
    if (!row) throw new Error("Send /start to set up your ads account.");
    return row.tenantId;
  };
  const home = () => menu([
    [button("Create campaign", "campaigns", "campaign", "success")],
    [button("Userbots", "accounts", "users"), button("Groups", "groups", "group")],
    [button("Plan & usage", "plan", "plan"), button("Help", "help", "help")],
  ]);
  const showHome = async (ctx: Context) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const tid = tenantId(userId);
    const user = db.prepare("SELECT tierCode FROM localUsers WHERE telegramId = ?").get(userId) as { tierCode: string };
    const sentToday = (db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE tenantId = ? AND status='sent' AND sentAt >= date('now')").get(tid) as { n: number }).n;
    const limits = tierLimits(user.tierCode);
    const connected = accounts(db, tid).filter((a) => a.status === "active").length;
    await ctx.reply(`<tg-emoji emoji-id="${icon.campaign}">📢</tg-emoji> <b>Campaign control</b>\n${connected ? "Your posting accounts are ready." : "No posting account linked yet."}\n\n<b>Today</b>  ${sentToday.toLocaleString()}/${limits.dailyMessages.toLocaleString()} messages\n<b>Userbots</b>  ${connected}/${limits.accounts} connected`, { parse_mode: "HTML", reply_markup: home() });
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
          await ctx.reply("Join @iobuysell to use your userbots.", { reply_markup: menu([[{ text: "Join @iobuysell", url: "https://t.me/iobuysell", icon_custom_emoji_id: icon.group, style: "primary" }], [button("Check membership", "home", "check", "success")]]) });
          return;
        }
        db.prepare("UPDATE localUsers SET forceJoined = 1, updatedAt = ? WHERE telegramId = ?").run(now(), ctx.from.id);
      } catch {
        await ctx.reply("I can’t verify your @iobuysell membership yet. Open the group, then try again.", { reply_markup: menu([[{ text: "Open @iobuysell", url: "https://t.me/iobuysell", icon_custom_emoji_id: icon.group, style: "primary" }]]) });
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
         await ctx.reply("Join @iobuysell to activate campaigns. Your free ads are also posted there every 10 minutes.", { reply_markup: menu([[{ text: "Join @iobuysell", url: "https://t.me/iobuysell", icon_custom_emoji_id: icon.group, style: "primary" }], [button("I joined", "home", "check", "success")]]) });
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
  bot.command("help", (ctx) => ctx.reply("Connect a userbot, sync its groups, then create a campaign from a message. Campaigns run every 5–60 minutes. Every campaign also posts to @iobuysell every 10 minutes."));
  bot.callbackQuery("help", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.editMessageText("<b>How IOAds works</b>\nConnect a userbot, choose groups it already belongs to, then schedule ads from a forwarded message.\n\nYour campaigns post on the interval you choose. Free-plan campaigns also appear in @iobuysell.", { parse_mode: "HTML", reply_markup: menu([[button("Add userbot", "accounts", "users", "success")], [button("Back", "home", "back")]]) }); });
  bot.callbackQuery("accounts", async (ctx) => {
    await ctx.answerCallbackQuery();
    const list = accounts(db, tenantId(ctx.from.id));
    const keyboard = menu([[button("Add userbot", "connect", "add", "success")], ...list.map((account) => [button(`${account.phone ?? account.accountId} · ${account.status}`, `account:${account.accountId}`, account.status === "active" ? "check" : "users")]), [button("Back", "home", "back")]]);
    await ctx.editMessageText(`<tg-emoji emoji-id="${icon.users}">👥</tg-emoji> <b>Userbots</b>\n${list.length ? `${list.filter((a) => a.status === "active").length} connected` : "Connect an account to start posting."}`, { parse_mode: "HTML", reply_markup: keyboard });
  });
  bot.callbackQuery(/^account:(.+)$/, async (ctx) => {
    const accountId = ctx.match[1]!;
    const keyboard = menu([[button("Log out", `logout:${accountId}`, "cancel", "danger")], [button("Back", "accounts", "back")]]);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`<tg-emoji emoji-id="${icon.users}">👥</tg-emoji> <b>Userbot settings</b>\nChoose an action for this account.`, { parse_mode: "HTML", reply_markup: keyboard });
  });
  bot.callbackQuery(/^logout:(.+)$/, async (ctx) => {
    try {
      await logout(db, tenantId(ctx.from.id), ctx.match[1]!);
      await ctx.answerCallbackQuery("Userbot logged out");
      await ctx.editMessageText("Userbot logged out. Scheduled campaigns using it are paused until it reconnects.", { reply_markup: home() });
    } catch (error) {
      await ctx.answerCallbackQuery({ text: String(error instanceof Error ? error.message : error), show_alert: true });
    }
  });
  bot.callbackQuery("connect", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (["phone", "sending_code", "code", "password", "verifying_code"].includes(flows.get(ctx.from.id)?.action ?? "")) {
      await ctx.reply("A userbot login is already in progress. Finish it or cancel it first.", { reply_markup: menu([[button("Cancel login", "login:cancel", "cancel", "danger")]]) });
      return;
    }
    flows.set(ctx.from.id, { action: "phone" });
    await ctx.reply(`<tg-emoji emoji-id="${icon.users}">👥</tg-emoji> <b>Link a userbot</b>\nEnter its phone number with country code, such as <code>+1234567890</code>. Telegram will send a sign-in code to that account.`, { parse_mode: "HTML", reply_markup: menu([[button("Cancel", "login:cancel", "cancel", "danger")]]) });
  });
  bot.callbackQuery("login:cancel", async (ctx) => {
    const flow = flows.get(ctx.from.id);
    if (flow?.accountId && ["sending_code", "code", "password", "verifying_code"].includes(flow.action)) await cancelLogin(db, tenantId(ctx.from.id), flow.accountId);
    flows.delete(ctx.from.id);
    await ctx.answerCallbackQuery("Login cancelled");
    await ctx.editMessageText("Userbot login cancelled.", { reply_markup: menu([[button("Userbots", "accounts", "users", "primary")], [button("Dashboard", "home", "back")]]) });
  });
  bot.callbackQuery("campaigns", async (ctx) => {
    await ctx.answerCallbackQuery();
    const tid = tenantId(ctx.from.id), list = listCampaigns(db, tid) as Array<{ id: number; name: string; status: string; intervalSeconds: number }>;
    const keyboard = menu([[button("New campaign", "newcampaign", "add", "success")], ...list.slice(0, 8).map((c) => [button(`${c.name} · ${c.status} · ${c.intervalSeconds / 60}m`, `campaign:${c.id}`, "campaign")]), [button("Back", "home", "back")]]);
    await ctx.editMessageText(`<tg-emoji emoji-id="${icon.campaign}">📢</tg-emoji> <b>Campaigns</b>\n${list.length ? `${list.length} campaigns` : "No campaigns yet. Create one to schedule your first ad."}`, { parse_mode: "HTML", reply_markup: keyboard });
  });
  bot.callbackQuery("newcampaign", async (ctx) => {
    const tid = tenantId(ctx.from.id), list = accounts(db, tid).filter((a) => a.status === "active");
    await ctx.answerCallbackQuery();
    if (!list.length) return ctx.reply("No userbot linked yet. Add one before creating a campaign.", { reply_markup: menu([[button("Add userbot", "accounts", "users", "success")], [button("Back", "home", "back")]]) });
    flows.set(ctx.from.id, { action: "campaign", accountId: list[0]!.accountId });
    await ctx.reply("<b>New campaign</b>\nForward the ad you want to send. Its formatting and media will be preserved.", { parse_mode: "HTML", reply_markup: menu([[button("Cancel", "home", "cancel", "danger")]]) });
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
  bot.callbackQuery(/^campaign:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = Number(ctx.match[1]), campaign = db.prepare("SELECT name, status, intervalSeconds FROM campaigns WHERE tenantId = ? AND id = ?").get(tenantId(ctx.from.id), id) as { name: string; status: string; intervalSeconds: number } | undefined;
    if (!campaign) return ctx.reply("Campaign not found.");
    const action = campaign.status === "scheduled" ? "pause" : "schedule";
    const inline = db.prepare("SELECT inlineMode FROM campaigns WHERE tenantId = ? AND id = ?").get(tenantId(ctx.from.id), id) as { inlineMode: number };
    const rows: InlineKeyboardButton[][] = [[button(action === "pause" ? "Pause" : "Schedule", `setcampaign:${id}:${action}`, action === "pause" ? "schedule" : "check", "success"), button("Cancel", `setcampaign:${id}:cancel`, "cancel", "danger")], [button("5 min", `interval:${id}:300`, "schedule"), button("30 min", `interval:${id}:1800`, "schedule"), button("1 hour", `interval:${id}:3600`, "schedule")]];
    if (!['free', 'starter'].includes((db.prepare("SELECT tierCode FROM localUsers WHERE telegramId = ?").get(ctx.from.id) as { tierCode: string }).tierCode)) rows.push([button(inline.inlineMode ? "Use direct userbot" : "Use bot inline via userbot", `inline:${id}`, "settings")]);
    rows.push([button("Back", "campaigns", "back")]);
    const keyboard = menu(rows);
    await ctx.editMessageText(`<b>${campaign.name}</b>\nStatus: ${campaign.status}\nInterval: ${campaign.intervalSeconds / 60} minutes\nPosting: ${inline.inlineMode ? "bot inline via userbot" : "direct userbot"}`, { parse_mode: "HTML", reply_markup: keyboard });
  });
  bot.callbackQuery(/^interval:(\d+):(300|1800|3600)$/, async (ctx) => {
    const [, id, seconds] = ctx.match;
    db.prepare("UPDATE campaigns SET intervalSeconds = ?, nextRunAt = NULL, updatedAt = ? WHERE tenantId = ? AND id = ?").run(Number(seconds), now(), tenantId(ctx.from.id), Number(id));
    await ctx.answerCallbackQuery("Interval updated");
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
    await ctx.editMessageText(`Campaign ${status === "cancel" ? "cancelled" : status}.`, { reply_markup: menu([[button("Campaigns", "campaigns", "campaign", "primary")], [button("Dashboard", "home", "back")]]) });
  });
  bot.callbackQuery("groups", async (ctx) => {
    const tid = tenantId(ctx.from.id), list = accounts(db, tid).filter((a) => a.status === "active");
    await ctx.answerCallbackQuery();
    if (!list.length) return ctx.reply("No userbot linked yet.", { reply_markup: menu([[button("Add userbot", "accounts", "users", "success")]]) });
    const groups = await syncGroups(db, tid, list[0]!.accountId) as Array<{ chatId: string; title: string; enabled: number }>;
    const rows = groups.slice(0, 30).map((group) => [button(`${group.enabled ? "✓" : "○"} ${group.title}`.slice(0, 60), `group:${list[0]!.accountId}:${group.chatId}:${group.enabled ? 0 : 1}`, "group", group.enabled ? "success" : "primary")]);
    rows.push([button("Back", "home", "back")]);
    await ctx.reply("<b>Campaign groups</b>\nChoose which groups can receive ads.", { parse_mode: "HTML", reply_markup: menu(rows) });
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
    const rows = [[button("Pro · $1/month", "upgrade:pro", "plan", "primary")], [button("Business · $3/month", "upgrade:business", "plan", "success")], [button("Back", "home", "back")]];
    await ctx.editMessageText(`<tg-emoji emoji-id="${icon.plan}">💳</tg-emoji> <b>${row.tierCode} plan</b>${expires.paidUntil ? ` · until ${new Date(expires.paidUntil).toLocaleDateString()}` : ""}\n\nFree · 500 messages/day · 1 userbot\nPro · 2,000/day · 5 userbots\nBusiness · 10,000/day · 15 userbots\n\nPayments are verified automatically.`, { parse_mode: "HTML", reply_markup: menu(rows) });
  });
  bot.callbackQuery(/^upgrade:(pro|business)$/, async (ctx) => {
    const tier = ctx.match[1]!;
    const monthly = tier === "pro" ? 1 : 3;
    const date = new Date(Date.now() + 30 * 86400_000).toISOString();
    const available = paymentMethods();
    if (!available.length) return ctx.answerCallbackQuery({ text: "Payments aren’t configured yet. Ask the bot owner.", show_alert: true });
    await ctx.answerCallbackQuery();
    const rows = available.map((method) => [button(method === "Binance" ? "Binance Pay" : `USDT ${method}`, `pay:${tier}:${method}`, "plan")]);
    rows.push([button("Back", "plan", "back")]);
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
     await ctx.reply(`<b>Pay $${amount} · ${method}</b>\n\n${address}\n\n${method === "Binance" ? "Send USDT with Binance Pay." : "Send USDT on the selected network."}\nThen send the Order ID or transaction hash here. This request expires in 30 minutes.`, { parse_mode: "HTML", reply_markup: menu([[button("Cancel", "plan", "cancel", "danger")]]) });
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
          await ctx.api.editMessageText(ctx.chat.id, progress.message_id, "Login code requested. Check Telegram on the account you’re connecting, then send the code here. If asked, include your 2FA password after the code, separated by a space.", { reply_markup: menu([[button("Cancel login", "login:cancel", "cancel", "danger")]]) });
        } finally {
          clearInterval(progressTimer);
          clearInterval(action);
        }
      } else if (flow.action === "code" || flow.action === "password") {
        const [inputCode, password] = ctx.message.text.split(" ", 2);
        const code = flow.action === "password" ? flow.code : inputCode;
        const passwordValue = flow.action === "password" ? ctx.message.text : password;
        if (flow.action === "code" && !/^\d{5,6}$/.test(inputCode ?? "")) {
          await ctx.reply("Send the login code from Telegram. If your account uses 2FA, add its password after the code.");
          return;
        }
        const verifyingFlow: Flow = { ...flow, action: "verifying_code" };
        flows.set(ctx.from.id, verifyingFlow);
        let frame = 0;
        const progress = await ctx.reply("Verifying your login with Telegram");
        const progressTimer = setInterval(() => {
          frame = (frame + 1) % 4;
          void ctx.api.editMessageText(ctx.chat.id, progress.message_id, `Verifying your login with Telegram${".".repeat(frame)}`).catch(() => undefined);
        }, 1_500);
        const action = setInterval(() => void ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => undefined), 4_000);
        try {
          await ctx.api.sendChatAction(ctx.chat.id, "typing");
          await loginComplete(db, tenantId(ctx.from.id), flow.accountId!, flow.phone!, code!, passwordValue);
          clearInterval(progressTimer);
          if (flows.get(ctx.from.id) !== verifyingFlow) return;
          flows.delete(ctx.from.id);
          await ctx.api.editMessageText(ctx.chat.id, progress.message_id, "<b>Userbot connected</b>\nYou can now sync its groups and create a campaign.", { parse_mode: "HTML", reply_markup: home() });
        } catch (error) {
          clearInterval(progressTimer);
          if (flows.get(ctx.from.id) !== verifyingFlow) return;
          if (String(error).toUpperCase().includes("SESSION_PASSWORD_NEEDED") && flow.action === "code") {
            flows.set(ctx.from.id, { ...flow, action: "password", code: code! });
            await ctx.api.editMessageText(ctx.chat.id, progress.message_id, "This account uses 2FA. Send its password to finish connecting.", { reply_markup: menu([[button("Cancel login", "login:cancel", "cancel", "danger")]]) });
          } else {
            flows.set(ctx.from.id, { ...flow, action: flow.action === "password" ? "password" : "code", code: flow.action === "password" ? flow.code : code });
            await ctx.api.editMessageText(ctx.chat.id, progress.message_id, `Could not verify this login: ${loginError(error)}\nTry again or cancel the login.`, { reply_markup: menu([[button("Cancel login", "login:cancel", "cancel", "danger")]]) });
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
        await ctx.reply(`Could not request a login code: ${loginError(error)}\nCheck the number and try again, or cancel the login.`, { reply_markup: menu([[button("Cancel login", "login:cancel", "cancel", "danger")]]) });
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
    const rows = groups.slice(0, 25).map((group) => [button(group.title.slice(0, 35), `target:${created.id}:${group.chatId}`, "group")]);
    rows.push([button("Open campaigns", "campaigns", "campaign", "success")]);
    await ctx.reply(`<tg-emoji emoji-id="${icon.campaign}">📢</tg-emoji> <b>Campaign saved</b>\n${plan === "free" || plan === "starter" ? "Select groups for delivery through the bot." : "Choose the groups that should receive this ad."}`, { parse_mode: "HTML", reply_markup: menu(rows) });
  });
  bot.catch((error) => console.error(`ads bot update failed: ${String(error)}`));
  void bot.start({ onStart: () => console.log("Ads bot started") });
}
