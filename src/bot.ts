import { Bot, InlineKeyboard, type Context } from "grammy";
import type Database from "better-sqlite3";
import { config } from "./config.js";
import { now } from "./db.js";
import { accounts, loginComplete, loginStart, logout } from "./services/account.js";
import { addTarget, createCampaign, listCampaigns, setCampaignStatus } from "./services/campaigns.js";
import { syncGroups, setGroup } from "./services/groups.js";
import { tierLimits } from "./services/plans.js";
import { paymentMethods, verifyPayment, type PaymentMethod } from "./payments.js";

type Flow = { action: "phone" | "code" | "campaign" | "payment"; accountId?: string; phone?: string; tier?: string; method?: PaymentMethod; paymentId?: number };

export function startAdsBot(db: Database.Database): void {
  if (!config.botToken) return;
  const bot = new Bot(config.botToken, { client: { apiRoot: config.telegramApiRoot } });
  const flows = new Map<number, Flow>();
  const tenantId = (userId: number): string => {
    const row = db.prepare("SELECT tenantId FROM localUsers WHERE telegramId = ?").get(userId) as { tenantId: string } | undefined;
    if (!row) throw new Error("Send /start to set up your ads account.");
    return row.tenantId;
  };
  const home = (keyboard = new InlineKeyboard()) => keyboard
    .text("Campaigns", "campaigns").text("Userbots", "accounts").row()
    .text("Groups", "groups").text("Plan & usage", "plan").row()
    .text("Help", "help");
  const showHome = async (ctx: Context) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const tid = tenantId(userId);
    const user = db.prepare("SELECT tierCode FROM localUsers WHERE telegramId = ?").get(userId) as { tierCode: string };
    const sentToday = (db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE tenantId = ? AND status='sent' AND sentAt >= date('now')").get(tid) as { n: number }).n;
    const limits = tierLimits(user.tierCode);
    await ctx.reply(`<b>Ads dashboard</b>\n\nToday: ${sentToday}/${limits.dailyMessages} messages · ${accounts(db, tid).filter((a) => a.status === "active").length}/${limits.accounts} userbots`, { parse_mode: "HTML", reply_markup: home() });
  };
  bot.use(async (ctx, next) => {
    if (ctx.from && !ctx.message?.text?.startsWith("/start")) {
      try {
        const member = await ctx.api.getChatMember(config.forceJoinChat, ctx.from.id);
         if (member.status === "left" || member.status === "kicked" || (member.status === "restricted" && !member.is_member)) {
          db.prepare("UPDATE localUsers SET forceJoined = 0, updatedAt = ? WHERE telegramId = ?").run(now(), ctx.from.id);
          await ctx.reply("Join @iobuysell to use your userbots.", { reply_markup: new InlineKeyboard().url("Join @iobuysell", "https://t.me/iobuysell").row().text("Check membership", "home") });
          return;
        }
        db.prepare("UPDATE localUsers SET forceJoined = 1, updatedAt = ? WHERE telegramId = ?").run(now(), ctx.from.id);
      } catch {
        await ctx.reply("I can’t verify your @iobuysell membership yet. Open the group, then try again.", { reply_markup: new InlineKeyboard().url("Open @iobuysell", "https://t.me/iobuysell") });
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
        await ctx.reply("Join @iobuysell to activate campaigns. Your free ads are also posted there every 10 minutes.", { reply_markup: new InlineKeyboard().url("Join @iobuysell", "https://t.me/iobuysell").row().text("I joined", "home") });
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
  bot.callbackQuery("help", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.editMessageText("Connect a userbot, sync its groups, then create a campaign from a message. Campaigns run every 5–60 minutes. Every campaign also posts to @iobuysell every 10 minutes.", { reply_markup: home() }); });
  bot.callbackQuery("accounts", async (ctx) => {
    await ctx.answerCallbackQuery();
    const list = accounts(db, tenantId(ctx.from.id));
    const keyboard = new InlineKeyboard().text("Connect userbot", "connect").row();
    for (const account of list) keyboard.text(`${account.phone ?? account.accountId} · ${account.status}`, `account:${account.accountId}`).row();
    keyboard.text("Back", "home");
    await ctx.editMessageText(list.length ? "<b>Your userbots</b>" : "No userbots connected yet.", { parse_mode: "HTML", reply_markup: keyboard });
  });
  bot.callbackQuery(/^account:(.+)$/, async (ctx) => {
    const accountId = ctx.match[1]!;
    const keyboard = new InlineKeyboard().text("Log out", `logout:${accountId}`).row().text("Back", "accounts");
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Userbot settings", { reply_markup: keyboard });
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
  bot.callbackQuery("connect", async (ctx) => { flows.set(ctx.from.id, { action: "phone" }); await ctx.answerCallbackQuery(); await ctx.reply("Send the phone number for your Telegram userbot."); });
  bot.callbackQuery("campaigns", async (ctx) => {
    await ctx.answerCallbackQuery();
    const tid = tenantId(ctx.from.id), list = listCampaigns(db, tid) as Array<{ id: number; name: string; status: string; intervalSeconds: number }>;
    const keyboard = new InlineKeyboard().text("New campaign", "newcampaign").row();
    for (const c of list) keyboard.text(`${c.name} · ${c.status} · ${c.intervalSeconds / 60}m`, `campaign:${c.id}`).row();
    keyboard.text("Back", "home");
    await ctx.editMessageText(list.length ? "<b>Campaigns</b>" : "No campaigns yet. Create one to start scheduling ads.", { parse_mode: "HTML", reply_markup: keyboard });
  });
  bot.callbackQuery("newcampaign", async (ctx) => {
    const tid = tenantId(ctx.from.id), list = accounts(db, tid).filter((a) => a.status === "active");
    await ctx.answerCallbackQuery();
    if (!list.length) return ctx.reply("Connect a userbot before creating a campaign.", { reply_markup: home() });
    flows.set(ctx.from.id, { action: "campaign", accountId: list[0]!.accountId });
    await ctx.reply("Forward the ad here to keep the original message, formatting, media, and rich content.");
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
    const keyboard = new InlineKeyboard().text(action === "pause" ? "Pause" : "Schedule", `setcampaign:${id}:${action}`).text("Cancel", `setcampaign:${id}:cancel`).row()
      .text("5 min", `interval:${id}:300`).text("30 min", `interval:${id}:1800`).text("1 hour", `interval:${id}:3600`).row();
    if (!['free', 'starter'].includes((db.prepare("SELECT tierCode FROM localUsers WHERE telegramId = ?").get(ctx.from.id) as { tierCode: string }).tierCode)) keyboard.text(inline.inlineMode ? "Use direct userbot" : "Use bot inline via userbot", `inline:${id}`).row();
    keyboard.text("Back", "campaigns");
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
    await ctx.editMessageText(`Campaign ${status === "cancel" ? "cancelled" : status}.`, { reply_markup: home() });
  });
  bot.callbackQuery("groups", async (ctx) => {
    const tid = tenantId(ctx.from.id), list = accounts(db, tid).filter((a) => a.status === "active");
    await ctx.answerCallbackQuery();
    if (!list.length) return ctx.reply("Connect a userbot first.");
    const groups = await syncGroups(db, tid, list[0]!.accountId) as Array<{ chatId: string; title: string; enabled: number }>;
    const keyboard = new InlineKeyboard();
    for (const group of groups.slice(0, 30)) keyboard.text(`${group.enabled ? "✓" : "○"} ${group.title}`.slice(0, 60), `group:${list[0]!.accountId}:${group.chatId}:${group.enabled ? 0 : 1}`).row();
    keyboard.text("Back", "home");
    await ctx.reply("Choose groups to include in campaigns.", { reply_markup: keyboard });
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
    await ctx.editMessageText(`<b>${row.tierCode} plan</b>${expires.paidUntil ? ` · until ${new Date(expires.paidUntil).toLocaleDateString()}` : ""}\n\nFree: 500 messages/day, 1 userbot, 1 campaign\n$1/month: 2,000 messages/day, 5 userbots, unlimited campaigns\n$3/month: 10,000 messages/day, 15 userbots, unlimited campaigns\n\nPayments are automatically verified against transaction history.`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Upgrade to $1", "upgrade:pro").row().text("Upgrade to $3", "upgrade:business").row().text("Back", "home") });
  });
  bot.callbackQuery(/^upgrade:(pro|business)$/, async (ctx) => {
    const tier = ctx.match[1]!;
    const monthly = tier === "pro" ? 1 : 3;
    const date = new Date(Date.now() + 30 * 86400_000).toISOString();
    const available = paymentMethods();
    if (!available.length) return ctx.answerCallbackQuery({ text: "Payments aren’t configured yet. Ask the bot owner.", show_alert: true });
    await ctx.answerCallbackQuery();
    const keyboard = new InlineKeyboard();
    for (const method of available) keyboard.text(method === "Binance" ? "Binance Pay" : `USDT ${method}`, `pay:${tier}:${method}`).row();
    keyboard.text("Back", "plan");
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
    await ctx.reply(`<b>Pay $${amount} · ${method}</b>\n\n${address}\n\n${method === "Binance" ? "Send USDT with Binance Pay." : "Send USDT on the selected network."}\nThen send the Order ID or transaction hash here. This request expires in 30 minutes.`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Cancel", "plan") });
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
    try {
      if (flow.action === "phone") {
        const result = await loginStart(db, tenantId(ctx.from.id), ctx.message.text);
        flows.set(ctx.from.id, { action: "code", accountId: result.accountId, phone: ctx.message.text });
        await ctx.reply("Telegram sent a login code. Send it here; include your 2FA password if Telegram asks.");
      } else if (flow.action === "code") {
        const [code, password] = ctx.message.text.split(" ", 2);
        await loginComplete(db, tenantId(ctx.from.id), flow.accountId!, flow.phone!, code!, password);
        flows.delete(ctx.from.id);
        await ctx.reply("Userbot connected.", { reply_markup: home() });
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
      await ctx.reply(String(error instanceof Error ? error.message : error));
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
    const keyboard = new InlineKeyboard();
    for (const group of groups.slice(0, 25)) keyboard.text(group.title.slice(0, 35), `target:${created.id}:${group.chatId}`).row();
    keyboard.text("Open campaigns", "campaigns");
    await ctx.reply(`Campaign saved from your original message. ${plan === "free" || plan === "starter" ? "It will post through this bot." : "Choose targets, interval, and posting method."}`, { reply_markup: keyboard });
  });
  bot.catch((error) => console.error(`ads bot update failed: ${String(error)}`));
  void bot.start({ onStart: () => console.log("Ads bot started") });
}
