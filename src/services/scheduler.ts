import type Database from "better-sqlite3";
import { config } from "../config.js";
import { now } from "../db.js";
import { adapterFor } from "./account.js";
import type { TelegramAdapter } from "../telegram.js";
import { tierRank } from "./plans.js";
import { tenantLimits } from "./limits.js";

const LEASE_MS = 120_000;
type Delivery = { id: number; tenantId: string; campaignId: number; accountId: string; chatId: string; attempts: number;
  message: string; messageEntities: string; messageOverride: string | null; sourceChatId: string | null;
  sourceMessageId: number | null; inlineMode: number; contentKind: string; tierCode: string; groupCooldownSeconds: number;
  accountCooldownSeconds: number; lastSentAt: string | null };

const nextDay = (): string => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
};

function planDeliveries(db: Database.Database): void {
  db.prepare("UPDATE deliveries SET status='skipped',error='account or target unavailable' WHERE status IN ('pending','retry') AND (NOT EXISTS (SELECT 1 FROM accounts a JOIN tenants t ON t.tenantId=a.tenantId WHERE a.tenantId=deliveries.tenantId AND a.accountId=deliveries.accountId AND a.status='active' AND a.session IS NOT NULL AND a.telegramUserId IS NOT NULL AND a.telegramUserId!=t.ownerId) OR NOT EXISTS (SELECT 1 FROM groups g WHERE g.tenantId=deliveries.tenantId AND g.accountId=deliveries.accountId AND g.chatId=deliveries.chatId AND g.enabled=1 AND g.chatKind='group') OR NOT EXISTS (SELECT 1 FROM campaignTargets ct WHERE ct.campaignId=deliveries.campaignId AND ct.accountId=deliveries.accountId AND ct.chatId=deliveries.chatId AND ct.enabled=1))").run();
  const due = db.prepare("SELECT c.id FROM campaigns c JOIN tenants t ON t.tenantId=c.tenantId LEFT JOIN localUsers u ON u.tenantId=c.tenantId WHERE c.status='scheduled' AND (c.nextRunAt IS NULL OR c.nextRunAt<=?) AND t.state='active' AND t.runtime='service' AND COALESCE(t.suspendReason,'')!='blocked' AND (u.forceJoined IS NULL OR u.forceJoined=1) ORDER BY c.nextRunAt,c.id LIMIT 1000").all(now()) as Array<{ id: number }>;
  const plan = db.transaction((id: number) => {
    const c = db.prepare("SELECT c.*,t.state,t.runtime,t.suspendReason,u.forceJoined FROM campaigns c JOIN tenants t ON t.tenantId=c.tenantId LEFT JOIN localUsers u ON u.tenantId=c.tenantId WHERE c.id=?").get(id) as Record<string, unknown> | undefined;
    if (!c || c.status !== "scheduled" || c.state !== "active" || c.runtime !== "service" || c.suspendReason === "blocked" || c.forceJoined === 0) return;
    const time = now();
    if (c.nextRunAt && String(c.nextRunAt) > time) return;
    db.prepare("UPDATE campaigns SET nextRunAt=?,updatedAt=? WHERE id=?").run(new Date(Date.now() + Number(c.intervalSeconds) * 1000).toISOString(), time, id);
    const occurrence = `${id}:${c.nextRunAt ?? time}`;
    db.prepare(`INSERT OR IGNORE INTO deliveries (tenantId,campaignId,chatId,accountId,occurrenceKey,status,attempts,nextAttemptAt,createdAt)
      SELECT ct.tenantId,ct.campaignId,ct.chatId,ct.accountId,? || ':' || ct.accountId || ':' || ct.chatId,'pending',0,?,?
      FROM campaignTargets ct JOIN groups g ON g.tenantId=ct.tenantId AND g.accountId=ct.accountId AND g.chatId=ct.chatId
      JOIN accounts a ON a.tenantId=ct.tenantId AND a.accountId=ct.accountId JOIN tenants t ON t.tenantId=ct.tenantId
      WHERE ct.campaignId=? AND ct.tenantId=? AND ct.enabled=1 AND g.enabled=1 AND g.chatKind='group' AND a.status='active' AND a.session IS NOT NULL AND a.telegramUserId IS NOT NULL AND a.telegramUserId!=t.ownerId
      AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.campaignId=ct.campaignId AND d.accountId=ct.accountId AND d.status IN ('pending','retry','claimed') AND d.occurrenceKey NOT LIKE ? || ':%')`)
      .run(occurrence, time, time, id, c.tenantId, occurrence);
  });
  for (const row of due) plan(row.id);
}

function claimDelivery(db: Database.Database): Delivery | "deferred" | null {
  return db.transaction(() => {
    const time = now();
    const candidate = db.prepare("SELECT d.id,d.tenantId,d.campaignId,c.dailyLimit FROM deliveries d JOIN campaigns c ON c.id=d.campaignId JOIN tenants t ON t.tenantId=d.tenantId JOIN accounts a ON a.tenantId=d.tenantId AND a.accountId=d.accountId JOIN groups g ON g.tenantId=d.tenantId AND g.accountId=d.accountId AND g.chatId=d.chatId JOIN campaignTargets ct ON ct.campaignId=d.campaignId AND ct.accountId=d.accountId AND ct.chatId=d.chatId LEFT JOIN localUsers u ON u.tenantId=d.tenantId WHERE d.status IN ('pending','retry') AND (d.nextAttemptAt IS NULL OR d.nextAttemptAt<=?) AND c.status='scheduled' AND t.state='active' AND t.runtime='service' AND COALESCE(t.suspendReason,'')!='blocked' AND (u.forceJoined IS NULL OR u.forceJoined=1) AND a.status='active' AND a.session IS NOT NULL AND a.telegramUserId IS NOT NULL AND a.telegramUserId!=t.ownerId AND (a.sendAfter IS NULL OR a.sendAfter<=?) AND g.enabled=1 AND g.chatKind='group' AND ct.enabled=1 AND NOT EXISTS (SELECT 1 FROM deliveries active WHERE active.accountId=d.accountId AND active.status='claimed') ORDER BY d.nextAttemptAt,d.id LIMIT 1")
      .get(time, time) as { id: number; tenantId: string; campaignId: number; dailyLimit: number } | undefined;
    if (!candidate) return null;
    const limits = tenantLimits(db, candidate.tenantId);
    const day = time.slice(0, 10);
    const count = (campaignId?: number): number => (db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE tenantId=? AND (? IS NULL OR campaignId=?) AND ((status='sent' AND sentAt>=?) OR (status='claimed' AND claimedAt>=?))")
      .get(candidate.tenantId, campaignId ?? null, campaignId ?? null, day, day) as { n: number }).n;
    if (count() >= limits.dailyMessages || (candidate.dailyLimit > 0 && count(candidate.campaignId) >= candidate.dailyLimit)) {
      db.prepare("UPDATE deliveries SET status='retry',nextAttemptAt=? WHERE id=?").run(nextDay(), candidate.id);
      return "deferred";
    }
    db.prepare("UPDATE deliveries SET status='claimed',attempts=attempts+1,claimedAt=?,error=NULL WHERE id=?").run(time, candidate.id);
    return db.prepare("SELECT d.id,d.tenantId,d.campaignId,d.accountId,d.chatId,d.attempts,c.message,c.messageEntities,c.sourceChatId,c.sourceMessageId,c.inlineMode,c.contentKind,c.groupCooldownSeconds,c.accountCooldownSeconds,g.messageOverride,g.lastSentAt,t.tierCode FROM deliveries d JOIN campaigns c ON c.id=d.campaignId JOIN groups g ON g.tenantId=d.tenantId AND g.accountId=d.accountId AND g.chatId=d.chatId JOIN tenants t ON t.tenantId=d.tenantId WHERE d.id=?")
      .get(candidate.id) as Delivery;
  })();
}

function retrySeconds(error: unknown, attempts: number): number | null {
  const message = String(error);
  const flood = /FLOOD_(?:PREMIUM_)?WAIT[_ ](\d+)|retry.after[^0-9]*(\d+)|wait(?: of)?\s+(\d+)/i.exec(message);
  if (flood) return Math.min(86_400, Number(flood[1] ?? flood[2] ?? flood[3]) + 1);
  if (/timeout|network|connection|ECONN|EPIPE|socket|worker.*unavailable|worker.*exited|\b5\d\d\b|INTERNAL/i.test(message))
    return Math.min(3600, 5 * 2 ** Math.min(attempts - 1, 9)) + Math.floor(Math.random() * 5);
  return null;
}

async function deliver(db: Database.Database, d: Delivery, getAdapter: (tenantId: string, accountId: string) => TelegramAdapter): Promise<boolean> {
  const last = d.lastSentAt ? Date.parse(d.lastSentAt) : 0;
  if (last && d.groupCooldownSeconds > 0 && Date.now() - last < d.groupCooldownSeconds * 1000) {
    db.prepare("UPDATE deliveries SET status='retry',nextAttemptAt=?,claimedAt=NULL WHERE id=? AND status='claimed'")
      .run(new Date(last + d.groupCooldownSeconds * 1000).toISOString(), d.id);
    return false;
  }
  try {
    const message = tierRank(d.tierCode) >= 1 && d.messageOverride ? d.messageOverride : d.message;
    const entities = JSON.parse(d.messageEntities || "[]") as Array<Record<string, unknown>>;
    const hasCustomEmoji = entities.some((entity) => entity.type === "custom_emoji");
    if (d.messageOverride && tierRank(d.tierCode) >= 1) await getAdapter(d.tenantId, d.accountId).sendMessage(d.chatId, message, []);
    else if (d.inlineMode && config.botUsername) await getAdapter(d.tenantId, d.accountId).sendInline(d.chatId, `campaign:${d.campaignId}`);
    else if (d.sourceChatId && d.sourceMessageId) await getAdapter(d.tenantId, d.accountId).copyMessage(d.chatId, d.sourceChatId, d.sourceMessageId, hasCustomEmoji);
    else if (d.contentKind === "text" || (d.contentKind === "legacy" && d.message !== "[Telegram media or rich message]")) await getAdapter(d.tenantId, d.accountId).sendMessage(d.chatId, message, entities);
    else throw new Error("Campaign content has no reusable inline result or archive copy");
    const time = now();
    db.transaction(() => {
      db.prepare("UPDATE deliveries SET status='sent',sentAt=?,claimedAt=NULL WHERE id=? AND status='claimed'").run(time, d.id);
      db.prepare("UPDATE groups SET lastSentAt=?,updatedAt=? WHERE tenantId=? AND accountId=? AND chatId=?").run(time, time, d.tenantId, d.accountId, d.chatId);
      if (d.accountCooldownSeconds > 0) db.prepare("UPDATE accounts SET sendAfter=? WHERE tenantId=? AND accountId=?")
        .run(new Date(Date.now() + d.accountCooldownSeconds * 1000).toISOString(), d.tenantId, d.accountId);
    })();
    return true;
  } catch (error) {
    const delay = retrySeconds(error, d.attempts);
    db.transaction(() => {
      db.prepare("UPDATE deliveries SET status=?,nextAttemptAt=?,claimedAt=NULL,error=? WHERE id=? AND status='claimed'")
        .run(delay === null ? "failed" : "retry", delay === null ? null : new Date(Date.now() + delay * 1000).toISOString(), String(error).slice(0, 500), d.id);
      if (String(error).includes("needs Premium to send custom emoji"))
        db.prepare("UPDATE campaignTargets SET enabled=0,updatedAt=? WHERE campaignId=? AND accountId=?").run(now(), d.campaignId, d.accountId);
      if (delay !== null && /FLOOD|retry.after|wait(?: of)?\s+\d+/i.test(String(error)))
        db.prepare("UPDATE accounts SET sendAfter=? WHERE tenantId=? AND accountId=?")
          .run(new Date(Date.now() + delay * 1000).toISOString(), d.tenantId, d.accountId);
    })();
    return false;
  }
}

export async function runSchedulerOnce(db: Database.Database, getAdapter: (tenantId: string, accountId: string) => TelegramAdapter = (tenantId, accountId) => adapterFor(db, tenantId, accountId)): Promise<number> {
  planDeliveries(db);
  db.prepare("UPDATE deliveries SET status='retry',nextAttemptAt=?,claimedAt=NULL WHERE status='claimed' AND claimedAt<?")
    .run(now(), new Date(Date.now() - LEASE_MS).toISOString());
  const jobs: Delivery[] = [];
  for (let i = 0; i < config.deliveryConcurrency * 4 && jobs.length < config.deliveryConcurrency; i += 1) {
    const job = claimDelivery(db);
    if (!job) break;
    if (job !== "deferred") jobs.push(job);
  }
  const results = await Promise.allSettled(jobs.map((job) => deliver(db, job, getAdapter)));
  return results.filter((result) => result.status === "fulfilled" && result.value).length;
}

export function startDeliveryPump(db: Database.Database, getAdapter: (tenantId: string, accountId: string) => TelegramAdapter, intervalMs: number): () => void {
  let active = 0;
  let planningAt = 0;
  let pumping = false;
  let stopped = false;
  const pump = () => {
    if (stopped || pumping) return;
    pumping = true;
    try {
      if (Date.now() - planningAt >= intervalMs) {
        planDeliveries(db);
        db.prepare("UPDATE deliveries SET status='retry',nextAttemptAt=?,claimedAt=NULL WHERE status='claimed' AND claimedAt<?")
          .run(now(), new Date(Date.now() - LEASE_MS).toISOString());
        planningAt = Date.now();
      }
      let skipped = 0;
      while (active < config.deliveryConcurrency && skipped < config.deliveryConcurrency * 4) {
        const job = claimDelivery(db);
        if (!job) break;
        if (job === "deferred") { skipped += 1; continue; }
        active += 1;
        void deliver(db, job, getAdapter)
          .catch((error) => console.error(`ads delivery ${job.id} failed: ${String(error)}`))
          .finally(() => { active -= 1; if (!stopped) setImmediate(pump); });
      }
    } catch (error) { console.error(`ads scheduler pump failed: ${String(error)}`); }
    finally { pumping = false; }
  };
  const timer = setInterval(pump, intervalMs);
  timer.unref();
  pump();
  return () => { stopped = true; clearInterval(timer); };
}
