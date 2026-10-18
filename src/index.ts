import express from "express";
import { config } from "./config.js";
import { openDb } from "./db.js";
import { createApiRouter } from "./api.js";
import { createRentalRouter } from "./rental/api.js";
import { startRentalSync } from "./rental/sync.js";
import { runPromoOnce, startScheduler } from "./services/scheduler.js";
import { validateConfig } from "./config.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { startAdsBot } from "./bot.js";
import { Bot } from "grammy";
import { enforceTenantLimits } from "./services/limits.js";

validateConfig();
const db = openDb(`${config.dataDir}/ads.db`);
const app = express();
app.get("/health", (_req, res) => res.json({ ok: true, service: "ads" }));
app.get("/", (_req, res) => { try { res.type("html").send(readFileSync(resolve(process.cwd(), "web/index.html"), "utf8")); } catch { res.status(404).send("UI unavailable"); } });
app.use("/rental/v1", createRentalRouter(db));
app.use("/api", createApiRouter(db));
if (config.rental) startRentalSync(db);
startAdsBot(db);
if (config.botToken) {
  const promoBot = new Bot(config.botToken, { client: { apiRoot: config.telegramApiRoot } });
  const sendMessage = async (target: string, message: string, sourceChatId: string | null, sourceMessageId: number | null, entities: Array<Record<string, unknown>>) => {
    if (sourceChatId && sourceMessageId) await promoBot.api.copyMessage(target, sourceChatId, sourceMessageId);
    else await promoBot.api.sendMessage(target, message, { entities: entities as never });
  };
  setInterval(() => void runPromoOnce(db, async (message, entities, sourceChatId, sourceMessageId) => {
    await sendMessage(config.promoChat, message, sourceChatId, sourceMessageId, entities);
  }), 30_000).unref();
  startScheduler(db, config.schedulerIntervalMs, async (target, source, messageId) => {
    await promoBot.api.copyMessage(target, source, messageId);
  });
  setInterval(() => {
    const expired = db.prepare("SELECT telegramId, tenantId FROM localUsers WHERE tierCode != 'free' AND paidUntil <= ?").all(new Date().toISOString()) as Array<{ telegramId: number; tenantId: string }>;
    for (const user of expired) {
      db.transaction(() => {
        db.prepare("UPDATE localUsers SET tierCode = 'free', paidUntil = NULL, updatedAt = ? WHERE telegramId = ?").run(new Date().toISOString(), user.telegramId);
        db.prepare("UPDATE tenants SET tierCode = 'free', limits = ?, version = version + 1, updatedAt = ? WHERE tenantId = ?").run(JSON.stringify({ accounts: 1, groups: 1_000_000, campaigns: 1, targets: 1_000_000, dailyMessages: 500 }), new Date().toISOString(), user.tenantId);
        enforceTenantLimits(db, user.tenantId);
      })();
      void promoBot.api.sendMessage(user.telegramId, "Your paid plan ended. Your account is now on Free: 500 messages/day, 1 userbot and 1 campaign.").catch(() => undefined);
    }
    const users = db.prepare("SELECT telegramId FROM localUsers WHERE forceJoined = 1").all() as Array<{ telegramId: number }>;
    for (const user of users) void promoBot.api.getChatMember(config.forceJoinChat, user.telegramId).then((member) => {
      if (member.status === "left" || member.status === "kicked" || (member.status === "restricted" && !member.is_member)) db.prepare("UPDATE localUsers SET forceJoined = 0, updatedAt = ? WHERE telegramId = ?").run(new Date().toISOString(), user.telegramId);
    }).catch(() => undefined);
  }, 60_000).unref();
}
else startScheduler(db, config.schedulerIntervalMs);
app.listen(config.port, () => console.log(`IOAds listening on ${config.port}`));
