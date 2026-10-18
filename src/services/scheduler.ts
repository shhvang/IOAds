import type Database from "better-sqlite3";
import { now } from "../db.js";
import { adapterFor } from "./account.js";
import type { TelegramAdapter } from "../telegram.js";
import { tierRank } from "./plans.js";
import { tenantLimits } from "./limits.js";

const accountLocks = new Map<string, Promise<void>>();
async function sendSerial(key: string, send: () => Promise<void>): Promise<void> {
  const previous = accountLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  accountLocks.set(key, current);
  await previous;
  try { await send(); } finally { release(); if (accountLocks.get(key) === current) accountLocks.delete(key); }
}

export async function runSchedulerOnce(db: Database.Database, adapterForAccount: (tenantId: string, accountId: string) => TelegramAdapter = (tenantId, accountId) => adapterFor(db, tenantId, accountId), copyMessage?: (chatId: string, sourceChatId: string, messageId: number) => Promise<void>): Promise<number> {
  const campaigns = db.prepare(`SELECT c.*, t.tierCode, t.state, t.runtime, t.suspendReason, u.forceJoined FROM campaigns c JOIN tenants t ON t.tenantId = c.tenantId
    LEFT JOIN localUsers u ON u.tenantId = c.tenantId
    WHERE c.status = 'scheduled' AND (c.nextRunAt IS NULL OR c.nextRunAt <= ?) ORDER BY c.id`).all(now()) as Array<Record<string, unknown>>;
  let sent = 0;
  const maxPerPass = 25;
  const accountSentAt = new Map<string, number>();
  const tenantPassSent = new Map<string, number>();
  for (const campaign of campaigns) {
    if (campaign.state !== "active" || campaign.runtime !== "service" || campaign.suspendReason === "blocked" || campaign.forceJoined === 0) continue;
    const tenantId = String(campaign.tenantId), accountId = String(campaign.senderAccountId), limits = tenantLimits(db, tenantId);
    const targets = db.prepare(`SELECT g.chatId, g.messageOverride, g.lastSentAt FROM campaignTargets ct JOIN groups g ON g.tenantId = ct.tenantId AND g.accountId = ct.accountId AND g.chatId = ct.chatId
      WHERE ct.tenantId = ? AND ct.campaignId = ? AND ct.accountId = ? AND ct.enabled = 1 AND g.enabled = 1 ORDER BY g.chatId`).all(tenantId, campaign.id, accountId) as Array<Record<string, unknown>>;
    const daily = Math.min(Number(campaign.dailyLimit), limits.dailyMessages);
    const sentToday = Number((db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE tenantId = ? AND status = 'sent' AND sentAt >= date('now')").get(tenantId) as { n: number }).n);
    const campaignSentToday = Number((db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE tenantId = ? AND campaignId = ? AND status = 'sent' AND sentAt >= date('now')").get(tenantId, campaign.id) as { n: number }).n);
    if (sentToday + (tenantPassSent.get(tenantId) ?? 0) >= limits.dailyMessages || (daily > 0 && campaignSentToday >= daily)) continue;
    const account = db.prepare("SELECT status, session FROM accounts WHERE tenantId = ? AND accountId = ?").get(tenantId, accountId) as { status: string; session: string | null } | undefined;
    if (account?.status !== "active" || !account.session) continue;
    const lastAccountSend = db.prepare("SELECT MAX(sentAt) AS sentAt FROM deliveries WHERE tenantId = ? AND accountId = ? AND status = 'sent'").get(tenantId, accountId) as { sentAt: string | null };
    const accountKey = `${tenantId}:${accountId}`, lastAccountAt = Math.max(lastAccountSend.sentAt ? Date.parse(lastAccountSend.sentAt) : 0, accountSentAt.get(accountKey) ?? 0);
    if (lastAccountAt && Number(campaign.accountCooldownSeconds) > 0 && Date.now() - lastAccountAt < Number(campaign.accountCooldownSeconds) * 1000) continue;
    let accountSent = false, campaignPassSent = 0, retryAt: string | null = null;
    for (const target of targets) {
      if (sent >= maxPerPass || accountSent) break;
      const currentTenant = db.prepare("SELECT tierCode, state, runtime, suspendReason FROM tenants WHERE tenantId = ?").get(tenantId) as { tierCode: string; state: string; runtime: string; suspendReason: string | null } | undefined;
      const currentAccount = db.prepare("SELECT status, session FROM accounts WHERE tenantId = ? AND accountId = ?").get(tenantId, accountId) as { status: string; session: string | null } | undefined;
      if (!currentTenant || currentTenant.state !== "active" || currentTenant.runtime !== "service" || currentTenant.suspendReason === "blocked" || currentAccount?.status !== "active" || !currentAccount.session) break;
       const message = tierRank(currentTenant.tierCode) >= 1 && target.messageOverride ? String(target.messageOverride) : String(campaign.message);
      const last = target.lastSentAt ? Date.parse(String(target.lastSentAt)) : 0;
      if (Number(campaign.groupCooldownSeconds) > 0 && Date.now() - last < Number(campaign.groupCooldownSeconds) * 1000) continue;
      const retry = db.prepare("SELECT occurrenceKey FROM deliveries WHERE campaignId = ? AND chatId = ? AND accountId = ? AND status = 'retry' ORDER BY id DESC LIMIT 1").get(campaign.id, target.chatId, accountId) as { occurrenceKey: string } | undefined;
      const occurrenceKey = retry?.occurrenceKey ?? `${campaign.id}:${accountId}:${target.chatId}:${campaign.nextRunAt ?? "initial"}`;
      db.prepare("UPDATE deliveries SET status = 'retry' WHERE occurrenceKey = ? AND status = 'claimed' AND claimedAt < ?").run(occurrenceKey, new Date(Date.now() - 15 * 60 * 1000).toISOString());
      const claimed = db.prepare(`INSERT OR IGNORE INTO deliveries (tenantId, campaignId, chatId, accountId, occurrenceKey, status, attempts, claimedAt, createdAt) VALUES (?, ?, ?, ?, ?, 'claimed', 1, ?, ?)`).run(tenantId, campaign.id, target.chatId, accountId, occurrenceKey, now(), now());
      if (!claimed.changes && !db.prepare("UPDATE deliveries SET status = 'claimed', attempts = attempts + 1, claimedAt = ?, error = NULL WHERE occurrenceKey = ? AND status = 'retry'").run(now(), occurrenceKey).changes) continue;
      const delivery = db.prepare("SELECT id FROM deliveries WHERE occurrenceKey = ?").get(occurrenceKey) as { id: number };
      try {
        const entities = JSON.parse(String(campaign.messageEntities ?? "[]")) as Array<Record<string, unknown>>;
        await sendSerial(accountKey, () => Number(campaign.inlineMode)
          ? adapterForAccount(tenantId, accountId).sendInline(String(target.chatId), `campaign:${campaign.id}`)
          : tierRank(currentTenant.tierCode) === 0 && copyMessage && campaign.sourceChatId && campaign.sourceMessageId
            ? copyMessage(String(target.chatId), String(campaign.sourceChatId), Number(campaign.sourceMessageId))
            : campaign.sourceChatId && campaign.sourceMessageId
              ? adapterForAccount(tenantId, accountId).copyMessage(String(target.chatId), String(campaign.sourceChatId), Number(campaign.sourceMessageId))
              : adapterForAccount(tenantId, accountId).sendMessage(String(target.chatId), message, entities));
        db.prepare("UPDATE deliveries SET status = 'sent', sentAt = ? WHERE id = ?").run(now(), delivery.id);
        db.prepare("UPDATE groups SET lastSentAt = ?, updatedAt = ? WHERE tenantId = ? AND accountId = ? AND chatId = ?").run(now(), now(), tenantId, accountId, target.chatId);
        sent += 1; campaignPassSent += 1; tenantPassSent.set(tenantId, (tenantPassSent.get(tenantId) ?? 0) + 1); accountSent = Number(campaign.accountCooldownSeconds) > 0; accountSentAt.set(accountKey, Date.now());
      } catch (error) {
        const text = String(error), flood = /(?:flood_wait[_ ](\d+)|wait(?: of)?\s+(\d+))/i.exec(text);
        if (flood) { const seconds = Number(flood[1] ?? flood[2] ?? 60); retryAt = new Date(Date.now() + seconds * 1000).toISOString(); db.prepare("UPDATE deliveries SET status = 'retry', error = ? WHERE id = ?").run(`flood wait ${seconds}s`, delivery.id); }
        else db.prepare("UPDATE deliveries SET status = 'failed', error = ? WHERE id = ?").run(text.slice(0, 500), delivery.id);
      }
      if (sentToday + (tenantPassSent.get(tenantId) ?? 0) >= limits.dailyMessages || (daily > 0 && campaignSentToday + campaignPassSent >= daily)) break;
    }
    db.prepare("UPDATE campaigns SET nextRunAt = ?, updatedAt = ? WHERE id = ? AND tenantId = ?").run(retryAt ?? new Date(Date.now() + Number(campaign.intervalSeconds) * 1000).toISOString(), now(), campaign.id, tenantId);
  }
  return sent;
}

export async function runPromoOnce(db: Database.Database, send: (message: string, entities: Array<Record<string, unknown>>, sourceChatId: string | null, sourceMessageId: number | null) => Promise<void>): Promise<number> {
  const due = db.prepare(`SELECT c.id, c.tenantId, c.message, c.messageEntities, c.sourceChatId, c.sourceMessageId FROM campaigns c JOIN tenants t ON t.tenantId = c.tenantId
    JOIN localUsers u ON u.tenantId = c.tenantId WHERE c.status = 'scheduled' AND t.state = 'active' AND u.forceJoined = 1
    AND (c.promoNextAt IS NULL OR c.promoNextAt <= ?) ORDER BY c.id LIMIT 10`).all(now()) as Array<{ id: number; tenantId: string; message: string; messageEntities: string; sourceChatId: string | null; sourceMessageId: number | null }>;
  for (const campaign of due) {
    const entities = JSON.parse(campaign.messageEntities) as Array<Record<string, unknown>>;
    try {
      await send(campaign.message, entities, campaign.sourceChatId, campaign.sourceMessageId);
      db.prepare("UPDATE campaigns SET promoNextAt = ? WHERE id = ? AND tenantId = ?").run(new Date(Date.now() + 600_000).toISOString(), campaign.id, campaign.tenantId);
    } catch (error) {
      console.error(`ads promo send failed: ${String(error)}`);
      db.prepare("UPDATE campaigns SET promoNextAt = ? WHERE id = ? AND tenantId = ?").run(new Date(Date.now() + 600_000).toISOString(), campaign.id, campaign.tenantId);
    }
  }
  return due.length;
}

export function startScheduler(db: Database.Database, intervalMs: number, copyMessage?: (target: string, source: string, messageId: number) => Promise<void>): void {
  let busy = false;
  const run = async () => { if (busy) return; busy = true; try { await runSchedulerOnce(db, undefined, copyMessage); } finally { busy = false; } };
  void run();
  setInterval(() => void run(), intervalMs).unref();
}
