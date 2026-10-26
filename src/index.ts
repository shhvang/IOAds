import express from "express";
import { config } from "./config.js";
import { openDb } from "./db.js";
import { createApiRouter } from "./api.js";
import { createRentalRouter } from "./rental/api.js";
import { startRentalSync } from "./rental/sync.js";
import { startSchedulerProcess } from "./services/scheduler-process.js";
import { validateConfig } from "./config.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { startAdsBot } from "./bot.js";
import { Bot } from "grammy";
import { enforceTenantLimits } from "./services/limits.js";
import { startWorkerPool } from "./services/worker-pool.js";
import { cancelLogin } from "./services/account.js";

validateConfig();
const db = openDb(`${config.dataDir}/ads.db`);
if (config.telegramApiId && config.telegramApiHash && config.sessionEncryptionKey) startWorkerPool();
const app = express();
app.get("/health", (_req, res) => res.json({ ok: true, service: "ads" }));
app.get("/", (_req, res) => { try { res.type("html").send(readFileSync(resolve(process.cwd(), "web/index.html"), "utf8")); } catch { res.status(404).send("UI unavailable"); } });
app.use("/rental/v1", createRentalRouter(db));
app.use("/api", createApiRouter(db));
if (config.rental) startRentalSync(db);
startAdsBot(db);
startSchedulerProcess(db);
if (config.botToken) {
  const bot = new Bot(config.botToken, { client: { apiRoot: config.telegramApiRoot } });
  setInterval(() => {
    const expired = db.prepare("SELECT telegramId, tenantId FROM localUsers WHERE tierCode != 'free' AND paidUntil <= ?").all(new Date().toISOString()) as Array<{ telegramId: number; tenantId: string }>;
    for (const user of expired) {
      db.transaction(() => {
        db.prepare("UPDATE localUsers SET tierCode = 'free', paidUntil = NULL, updatedAt = ? WHERE telegramId = ?").run(new Date().toISOString(), user.telegramId);
        db.prepare("UPDATE tenants SET tierCode = 'free', limits = ?, version = version + 1, updatedAt = ? WHERE tenantId = ?").run(JSON.stringify({ accounts: 1, groups: 1_000_000, campaigns: 1, targets: 1_000_000, dailyMessages: 500 }), new Date().toISOString(), user.tenantId);
        enforceTenantLimits(db, user.tenantId);
      })();
      void bot.api.sendMessage(user.telegramId, "Your paid plan ended. Your account is now on Free: 500 messages/day, 1 userbot and 1 campaign.").catch(() => undefined);
    }
  }, 60_000).unref();
}
const cleanupLogins = () => {
  const stale = db.prepare("SELECT tenantId,accountId FROM accounts WHERE status='connecting' AND updatedAt<? LIMIT 100")
    .all(new Date(Date.now() - 30 * 60_000).toISOString()) as Array<{ tenantId: string; accountId: string }>;
  for (const row of stale) void cancelLogin(db, row.tenantId, row.accountId).catch((error) => console.error(`stale login cleanup failed: ${String(error)}`));
};
cleanupLogins();
setInterval(cleanupLogins, 60_000).unref();
const server = app.listen(config.port, () => console.log(`IOAds listening on ${config.port}`));
const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
