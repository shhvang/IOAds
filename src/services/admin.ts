import type Database from "better-sqlite3";
import { now } from "../db.js";
import { config } from "../config.js";
import { tierLimits } from "./plans.js";
import { enforceTenantLimits } from "./limits.js";
import { adapterFor, quiesceTenantAdapters } from "./account.js";
import type { TelegramAdapter } from "../telegram.js";

export type Audience = 1 | 2 | 3;
export type BroadcastSource = { sourceChatId: string; sourceMessageId: number; archiveChatId: string | null; archiveMessageId: number | null; message: string | null; entities: string; contentKind: "text" | "copy" };
type Job = { id: number; broadcastId: number; kind: "bot" | "userbot"; tenantId: string | null; accountId: string | null; chatId: string; attempts: number; sourceChatId: string; sourceMessageId: number; archiveChatId: string | null; archiveMessageId: number | null; message: string | null; entities: string; contentKind: string };

export function logAdmin(db: Database.Database, action: string, subject?: string, detail?: unknown): void {
  db.prepare("INSERT INTO adminActions(actorId,action,subject,detail,createdAt) VALUES(?,?,?,?,?)")
    .run(config.adminTelegramId, action, subject ?? null, detail === undefined ? null : JSON.stringify(detail), now());
}

export function grantStandalonePlan(db: Database.Database, telegramId: number, tier: "free" | "pro" | "business", days = 30): string | null {
  if (!Number.isSafeInteger(telegramId) || telegramId < 1) throw new Error("invalid user");
  if (tier !== "free" && (![30, 90, 365].includes(days))) throw new Error("invalid grant duration");
  const user = db.prepare("SELECT u.tenantId,u.tierCode,u.paidUntil FROM localUsers u JOIN tenants t ON t.tenantId=u.tenantId WHERE u.telegramId=? AND t.productId='ads-standalone'")
    .get(telegramId) as { tenantId: string; tierCode: string; paidUntil: string | null } | undefined;
  if (!user) throw new Error("bot user not found");
  const base = tier === "free" ? null : Math.max(Date.now(), user.paidUntil ? Date.parse(user.paidUntil) || 0 : 0);
  const paidUntil = base === null ? null : new Date(base + days * 86400_000).toISOString();
  db.transaction(() => {
    db.prepare("UPDATE localUsers SET tierCode=?,paidUntil=?,updatedAt=? WHERE telegramId=?").run(tier, paidUntil, now(), telegramId);
    db.prepare("UPDATE tenants SET tierCode=?,limits=?,version=version+1,updatedAt=? WHERE tenantId=?")
      .run(tier, JSON.stringify(tierLimits(tier)), now(), user.tenantId);
    enforceTenantLimits(db, user.tenantId);
    logAdmin(db, tier === "free" ? "plan_revoked" : "plan_granted", user.tenantId, { previousTier: user.tierCode, tier, days: tier === "free" ? null : days, paidUntil });
  })();
  return paidUntil;
}

export async function setUserBlocked(db: Database.Database, telegramId: number, blocked: boolean): Promise<number> {
  if (!Number.isSafeInteger(telegramId) || telegramId < 1) throw new Error("invalid user");
  if (telegramId === config.adminTelegramId) throw new Error("the admin account cannot be blocked");
  const user = db.prepare("SELECT u.tenantId,u.blocked FROM localUsers u JOIN tenants t ON t.tenantId=u.tenantId WHERE u.telegramId=? AND t.productId='ads-standalone'")
    .get(telegramId) as { tenantId: string; blocked: number } | undefined;
  if (!user) throw new Error("bot user not found");
  if (Boolean(user.blocked) === blocked) throw new Error(blocked ? "user is already blocked" : "user is not blocked");
  const count = db.transaction(() => {
    db.prepare("UPDATE localUsers SET blocked=?,updatedAt=? WHERE telegramId=?").run(blocked ? 1 : 0, now(), telegramId);
    if (blocked) {
      db.prepare("DELETE FROM botFlows WHERE telegramId=?").run(telegramId);
      const changed = db.prepare("UPDATE accounts SET status='blocked',updatedAt=? WHERE tenantId=? AND status IN ('active','limit_paused') AND session IS NOT NULL")
        .run(now(), user.tenantId).changes;
      db.prepare("UPDATE accounts SET status='logged_out',loginPhone=NULL,phoneCodeHash=NULL,updatedAt=? WHERE tenantId=? AND status='connecting'")
        .run(now(), user.tenantId);
      db.prepare("UPDATE deliveries SET status='skipped',error='user blocked by admin',nextAttemptAt=NULL WHERE tenantId=? AND status IN ('pending','retry')")
        .run(user.tenantId);
      db.prepare("UPDATE adminBroadcastTargets SET status='skipped',error='user blocked by admin',nextAttemptAt=NULL WHERE status IN ('pending','retry') AND ((kind='bot' AND chatId=?) OR (kind='userbot' AND tenantId=?))")
        .run(String(telegramId), user.tenantId);
      logAdmin(db, "user_blocked", user.tenantId, { accounts: changed });
      return changed;
    }
    db.prepare("UPDATE accounts SET status='limit_paused',updatedAt=? WHERE tenantId=? AND status='blocked' AND session IS NOT NULL").run(now(), user.tenantId);
    db.prepare("UPDATE accounts SET status='logged_out',updatedAt=? WHERE tenantId=? AND status='blocked' AND session IS NULL").run(now(), user.tenantId);
    enforceTenantLimits(db, user.tenantId);
    const restored = (db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE tenantId=? AND status='active' AND session IS NOT NULL").get(user.tenantId) as { n: number }).n;
    logAdmin(db, "user_unblocked", user.tenantId, { activeAccounts: restored });
    return restored;
  })();
  if (blocked) await quiesceTenantAdapters(db, user.tenantId);
  return count;
}

const groupWhere = `g.enabled=1 AND g.chatKind='group' AND a.status='active' AND a.session IS NOT NULL
  AND a.telegramUserId IS NOT NULL AND a.telegramUserId!=t.ownerId AND t.state='active' AND t.runtime='service'
  AND COALESCE(t.suspendReason,'')!='blocked' AND (u.forceJoined IS NULL OR u.forceJoined=1)
  AND (u.blocked IS NULL OR u.blocked=0)
  AND (?=3 OR t.tierCode IN ('free','starter'))`;

export function broadcastAudienceCounts(db: Database.Database, audience: Audience): { botUsers: number; groups: number } {
  const botUsers = (db.prepare("SELECT COUNT(*) AS n FROM localUsers WHERE blocked=0").get() as { n: number }).n;
  const groups = audience === 1 ? 0 : (db.prepare(`SELECT COUNT(DISTINCT g.chatId) AS n FROM groups g JOIN accounts a ON a.tenantId=g.tenantId AND a.accountId=g.accountId JOIN tenants t ON t.tenantId=g.tenantId LEFT JOIN localUsers u ON u.tenantId=t.tenantId WHERE ${groupWhere} AND g.chatId!=?`)
    .get(audience, config.archiveChat) as { n: number }).n;
  return { botUsers, groups };
}

export function createAdminBroadcast(db: Database.Database, source: BroadcastSource): number {
  if (!Number.isSafeInteger(source.sourceMessageId) || source.sourceMessageId < 1) throw new Error("invalid source post");
  if (!source.sourceChatId) throw new Error("invalid source chat");
  if (source.contentKind === "text" && (!source.message || source.message.length > 4096)) throw new Error("invalid text post");
  if (!Array.isArray(JSON.parse(source.entities))) throw new Error("invalid post entities");
  const result = db.prepare(`INSERT INTO adminBroadcasts(audience,status,sourceChatId,sourceMessageId,archiveChatId,archiveMessageId,message,entities,contentKind,createdAt)
    VALUES(1,'draft',?,?,?,?,?,?,?,?)`).run(source.sourceChatId, source.sourceMessageId, source.archiveChatId, source.archiveMessageId, source.message, source.entities, source.contentKind, now());
  const id = Number(result.lastInsertRowid);
  logAdmin(db, "broadcast_drafted", String(id), { contentKind: source.contentKind });
  return id;
}

export function startAdminBroadcast(db: Database.Database, id: number, audience: Audience): { botUsers: number; groups: number } {
  if (![1, 2, 3].includes(audience)) throw new Error("invalid audience");
  return db.transaction(() => {
    const draft = db.prepare("SELECT id,contentKind,archiveChatId,archiveMessageId FROM adminBroadcasts WHERE id=? AND status='draft'")
      .get(id) as { id: number; contentKind: string; archiveChatId: string | null; archiveMessageId: number | null } | undefined;
    if (!draft) throw new Error("broadcast is no longer a draft");
    if (audience !== 1 && draft.contentKind === "copy" && (!draft.archiveChatId || !draft.archiveMessageId)) throw new Error("The archive copy is unavailable");
    db.prepare("INSERT INTO adminBroadcastTargets(broadcastId,kind,chatId,status) SELECT ?,'bot',CAST(telegramId AS TEXT),'pending' FROM localUsers WHERE blocked=0")
      .run(id);
    if (audience !== 1) {
      db.prepare(`INSERT OR IGNORE INTO adminBroadcastTargets(broadcastId,kind,tenantId,accountId,chatId,status)
        SELECT ?,'userbot',g.tenantId,g.accountId,g.chatId,'pending' FROM groups g
        JOIN accounts a ON a.tenantId=g.tenantId AND a.accountId=g.accountId
        JOIN tenants t ON t.tenantId=g.tenantId LEFT JOIN localUsers u ON u.tenantId=t.tenantId WHERE ${groupWhere} AND g.chatId!=?
        ORDER BY g.chatId,g.tenantId,g.accountId`).run(id, audience, config.archiveChat);
    }
    db.prepare("UPDATE adminBroadcasts SET audience=?,status='running',startedAt=? WHERE id=?").run(audience, now(), id);
    const counts = db.prepare("SELECT COUNT(*) AS botUsers, (SELECT COUNT(*) FROM adminBroadcastTargets WHERE broadcastId=? AND kind='userbot') AS groups FROM adminBroadcastTargets WHERE broadcastId=? AND kind='bot'")
      .get(id, id) as { botUsers: number; groups: number };
    logAdmin(db, "broadcast_started", String(id), { audience, ...counts });
    return counts;
  })();
}

export function setAdminBroadcastStatus(db: Database.Database, id: number, action: "pause" | "resume" | "cancel"): void {
  db.transaction(() => {
    const current = db.prepare("SELECT status FROM adminBroadcasts WHERE id=?").get(id) as { status: string } | undefined;
    if (!current) throw new Error("broadcast not found");
    if (action === "pause" && current.status !== "running" || action === "resume" && current.status !== "paused" || action === "cancel" && !["running", "paused", "draft"].includes(current.status)) throw new Error("broadcast cannot be changed now");
    const status = action === "pause" ? "paused" : action === "resume" ? "running" : "cancelled";
    db.prepare("UPDATE adminBroadcasts SET status=?,finishedAt=CASE WHEN ?='cancelled' THEN ? ELSE finishedAt END WHERE id=?").run(status, status, now(), id);
    if (action === "cancel") db.prepare("UPDATE adminBroadcastTargets SET status='skipped',error='cancelled' WHERE broadcastId=? AND status IN ('pending','retry')").run(id);
    logAdmin(db, `broadcast_${action}`, String(id));
  })();
}

function claim(db: Database.Database, kind: "bot" | "userbot"): Job | null {
  return db.transaction(() => {
    const candidate = db.prepare(`SELECT q.id FROM adminBroadcastTargets q JOIN adminBroadcasts b ON b.id=q.broadcastId
      LEFT JOIN accounts a ON a.accountId=q.accountId AND a.tenantId=q.tenantId
      WHERE b.status='running' AND q.kind=? AND q.status IN ('pending','retry') AND (q.nextAttemptAt IS NULL OR q.nextAttemptAt<=?)
      AND (q.kind='bot' OR ((a.sendAfter IS NULL OR a.sendAfter<=?) AND NOT EXISTS
      (SELECT 1 FROM adminBroadcastTargets busy WHERE busy.accountId=q.accountId AND busy.status='claimed')
      AND NOT EXISTS (SELECT 1 FROM deliveries busy WHERE busy.accountId=q.accountId AND busy.status='claimed')))
      ORDER BY q.id LIMIT 1`).get(kind, now(), now()) as { id: number } | undefined;
    if (!candidate) return null;
    db.prepare("UPDATE adminBroadcastTargets SET status='claimed',attempts=attempts+1,claimedAt=?,error=NULL WHERE id=?")
      .run(now(), candidate.id);
    return db.prepare(`SELECT q.*,b.sourceChatId,b.sourceMessageId,b.archiveChatId,b.archiveMessageId,b.message,b.entities,b.contentKind
      FROM adminBroadcastTargets q JOIN adminBroadcasts b ON b.id=q.broadcastId WHERE q.id=?`).get(candidate.id) as Job;
  })();
}

function retryDelay(error: unknown, attempts: number): number | null {
  const message = String(error);
  if (/bot was blocked|user is deactivated|chat not found|forbidden|not enough rights|can't access/i.test(message)) return null;
  const flood = /FLOOD_(?:PREMIUM_)?WAIT[_ ](\d+)|retry.after[^0-9]*(\d+)|wait(?: of)?\s+(\d+)/i.exec(message);
  if (flood) return Math.min(86400, Math.max(1, Number(flood[1] ?? flood[2] ?? flood[3])));
  return attempts < 3 ? 30 * 2 ** (attempts - 1) : null;
}

export async function runAdminBroadcastOnce(db: Database.Database, sendBot: (chatId: string, sourceChatId: string, sourceMessageId: number) => Promise<unknown>, getAdapter: (tenantId: string, accountId: string) => TelegramAdapter = (tenantId, accountId) => adapterFor(db, tenantId, accountId), maxJobs = 8): Promise<number> {
  db.prepare("UPDATE adminBroadcastTargets SET status='retry',nextAttemptAt=?,claimedAt=NULL,error='worker restarted' WHERE status='claimed' AND claimedAt<?")
    .run(now(), new Date(Date.now() - 120_000).toISOString());
  const jobs: Job[] = [];
  for (let n = 0; n < maxJobs; n += 1) {
    const job = claim(db, n % 2 ? "userbot" : "bot") ?? claim(db, n % 2 ? "bot" : "userbot");
    if (!job) break;
    jobs.push(job);
  }
  await Promise.allSettled(jobs.map(async (job) => {
    try {
      if (job.kind === "bot") {
        const recipient = db.prepare("SELECT blocked FROM localUsers WHERE telegramId=?").get(Number(job.chatId)) as { blocked: number } | undefined;
        if (!recipient || recipient.blocked) throw new Error("user blocked or unavailable");
        await sendBot(job.chatId, job.archiveChatId ?? job.sourceChatId, job.archiveMessageId ?? job.sourceMessageId);
      }
      else {
        const valid = db.prepare(`SELECT 1 FROM accounts a JOIN tenants t ON t.tenantId=a.tenantId JOIN groups g ON g.tenantId=a.tenantId AND g.accountId=a.accountId AND g.chatId=?
          LEFT JOIN localUsers u ON u.tenantId=t.tenantId
          WHERE a.tenantId=? AND a.accountId=? AND a.status='active' AND a.session IS NOT NULL AND a.telegramUserId IS NOT NULL AND a.telegramUserId!=t.ownerId
          AND g.enabled=1 AND g.chatKind='group' AND t.state='active' AND t.runtime='service' AND COALESCE(t.suspendReason,'')!='blocked'
          AND (u.forceJoined IS NULL OR u.forceJoined=1) AND (u.blocked IS NULL OR u.blocked=0)`).get(job.chatId, job.tenantId, job.accountId);
        if (!valid) throw new Error("account or enabled group is no longer available");
        const adapter = getAdapter(job.tenantId!, job.accountId!);
        if (job.contentKind === "text") await adapter.sendMessage(job.chatId, job.message!, JSON.parse(job.entities));
        else await adapter.copyMessage(job.chatId, job.archiveChatId!, job.archiveMessageId!);
      }
      db.transaction(() => {
        db.prepare("UPDATE adminBroadcastTargets SET status='sent',sentAt=?,claimedAt=NULL WHERE id=? AND status='claimed'").run(now(), job.id);
        if (job.kind === "userbot") db.prepare("UPDATE accounts SET sendAfter=? WHERE tenantId=? AND accountId=? AND (sendAfter IS NULL OR sendAfter<?)")
          .run(new Date(Date.now() + 3_000).toISOString(), job.tenantId, job.accountId, new Date(Date.now() + 3_000).toISOString());
      })();
    } catch (error) {
      if (/user blocked or unavailable|account or enabled group is no longer available/i.test(String(error))) {
        db.prepare("UPDATE adminBroadcastTargets SET status='skipped',nextAttemptAt=NULL,claimedAt=NULL,error=? WHERE id=? AND status='claimed'")
          .run(String(error).slice(0, 500), job.id);
        return;
      }
      const delay = retryDelay(error, job.attempts);
      db.prepare("UPDATE adminBroadcastTargets SET status=?,nextAttemptAt=?,claimedAt=NULL,error=? WHERE id=? AND status='claimed'")
        .run(delay === null ? "failed" : "retry", delay === null ? null : new Date(Date.now() + delay * 1000).toISOString(), String(error).slice(0, 500), job.id);
      if (job.kind === "userbot" && delay !== null && /FLOOD|retry.after|wait(?: of)?\s+\d+/i.test(String(error)))
        db.prepare("UPDATE accounts SET sendAfter=? WHERE tenantId=? AND accountId=?").run(new Date(Date.now() + delay * 1000).toISOString(), job.tenantId, job.accountId);
    }
  }));
  db.prepare(`UPDATE adminBroadcasts SET status='completed',finishedAt=? WHERE status='running' AND NOT EXISTS
    (SELECT 1 FROM adminBroadcastTargets q WHERE q.broadcastId=adminBroadcasts.id AND q.status IN ('pending','retry','claimed'))`).run(now());
  return jobs.length;
}
