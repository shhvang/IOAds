import type Database from "better-sqlite3";
import { isTier, planLimits, standalonePostingIssue } from "./plans.js";
import { config } from "../config.js";

const MAX_LIMIT = 1_000_000;
const keys = ["accounts", "groups", "campaigns", "targets", "dailyMessages"] as const;

export type Limits = Record<(typeof keys)[number], number>;

export function parseLimits(value: unknown, tier: string, standalone = false): Limits | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!isTier(tier)) return null;
  const defaults = planLimits(tier);
  // Rental limits come from the hub. Keep its earlier paid campaign ceiling
  // while the standalone bot advertises and enforces its smaller plan caps.
  if (!standalone && (tier === "pro" || tier === "business")) defaults.campaigns = MAX_LIMIT;
  const raw = value as Record<string, unknown>;
  const result = { ...defaults };
  for (const key of keys) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "number" || !Number.isSafeInteger(raw[key]) || raw[key] < 0 || raw[key] > MAX_LIMIT) return null;
    if (raw[key] > defaults[key]) return null;
    result[key] = raw[key];
  }
  return result as Limits;
}

export function tenantLimits(db: Database.Database, tenantId: string): Limits {
  const row = db.prepare("SELECT tierCode, limits, productId FROM tenants WHERE tenantId = ?").get(tenantId) as { tierCode: string; limits: string; productId: string } | undefined;
  if (!row) throw new Error("tenant not found");
  const limits = parseLimits(JSON.parse(row.limits), row.tierCode, row.productId === "ads-standalone");
  if (!limits) throw new Error("tenant limits are invalid");
  return limits;
}

export function limitFor(db: Database.Database, tenantId: string, key: keyof Limits): number {
  return tenantLimits(db, tenantId)[key];
}

export function isTenantBlocked(db: Database.Database, tenantId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM localUsers WHERE tenantId=? AND blocked=1").get(tenantId));
}

/** Existing sessions must obey the same owner/account rule as new logins. */
export function revokeOwnerAccounts(db: Database.Database, tenantId?: string): number {
  const rows = db.prepare(`SELECT a.tenantId,a.accountId FROM accounts a JOIN tenants t ON t.tenantId=a.tenantId
    WHERE a.telegramUserId=t.ownerId AND (? IS NULL OR a.tenantId=?) AND (a.session IS NOT NULL OR a.status IN ('active','limit_paused'))`)
    .all(tenantId ?? null, tenantId ?? null) as Array<{ tenantId: string; accountId: string }>;
  db.transaction(() => {
    for (const row of rows) {
      db.prepare("UPDATE accounts SET status='logged_out',session=NULL,loginPhone=NULL,phoneCodeHash=NULL,updatedAt=? WHERE tenantId=? AND accountId=?")
        .run(new Date().toISOString(), row.tenantId, row.accountId);
      db.prepare("UPDATE groups SET enabled=0,updatedAt=? WHERE tenantId=? AND accountId=?")
        .run(new Date().toISOString(), row.tenantId, row.accountId);
      db.prepare("UPDATE campaignTargets SET enabled=0,updatedAt=? WHERE tenantId=? AND accountId=?")
        .run(new Date().toISOString(), row.tenantId, row.accountId);
    }
  })();
  return rows.length;
}

export function enforceTenantLimits(db: Database.Database, tenantId: string): void {
  revokeOwnerAccounts(db, tenantId);
  const limits = tenantLimits(db, tenantId);
  const tenant = db.prepare("SELECT productId,tierCode FROM tenants WHERE tenantId=?").get(tenantId) as { productId: string; tierCode: string };
  db.transaction(() => {
    db.prepare(`UPDATE groups SET enabled = 0, updatedAt = datetime('now') WHERE tenantId = ? AND enabled = 1 AND chatKind='group' AND rowid NOT IN
      (SELECT rowid FROM groups WHERE tenantId = ? AND enabled = 1 AND chatKind='group' ORDER BY rowid LIMIT ?)`).run(tenantId, tenantId, limits.groups);
    db.prepare(`UPDATE campaigns SET status = 'paused', updatedAt = datetime('now') WHERE tenantId = ? AND status IN ('draft', 'scheduled', 'paused') AND id NOT IN
      (SELECT id FROM campaigns WHERE tenantId = ? AND status!='cancelled' ORDER BY id LIMIT ?)`).run(tenantId, tenantId, limits.campaigns);
    if (tenant.productId === "ads-standalone" || tenant.tierCode === "free") {
      const scheduled = db.prepare("SELECT id,message,contentKind,richContent,richMessage,sourceChatId,sourceMessageId,inlineOptions FROM campaigns WHERE tenantId=? AND status='scheduled'").all(tenantId) as Array<{ id: number; message: string; contentKind: string; richContent: string | null; richMessage: string | null; sourceChatId: string | null; sourceMessageId: number | null; inlineOptions: string | null }>;
      for (const row of scheduled) {
        const issue = standalonePostingIssue(tenant.tierCode, row, config.botUsername);
        if (!issue) continue;
        db.prepare("UPDATE campaigns SET status='paused',nextRunAt=NULL,updatedAt=? WHERE tenantId=? AND id=?").run(new Date().toISOString(), tenantId, row.id);
        db.prepare("UPDATE deliveries SET status='skipped',error=? WHERE tenantId=? AND campaignId=? AND status IN ('pending','retry')").run(issue, tenantId, row.id);
      }
    }
    const campaigns = db.prepare("SELECT id FROM campaigns WHERE tenantId = ?").all(tenantId) as Array<{ id: number }>;
    for (const campaign of campaigns) db.prepare(`UPDATE campaignTargets SET enabled = 0, updatedAt = datetime('now') WHERE campaignId = ? AND tenantId = ? AND enabled = 1 AND rowid NOT IN
      (SELECT rowid FROM campaignTargets WHERE campaignId = ? AND tenantId = ? AND enabled = 1 ORDER BY accountId, chatId LIMIT ?)`).run(campaign.id, tenantId, campaign.id, tenantId, limits.targets);
    const connected = db.prepare("SELECT accountId,status FROM accounts WHERE tenantId=? AND status IN ('active','limit_paused') AND session IS NOT NULL ORDER BY CASE WHEN status='active' THEN 0 ELSE 1 END, createdAt, accountId")
      .all(tenantId) as Array<{ accountId: string; status: string }>;
    for (const [index, account] of connected.entries()) {
      const status = index < limits.accounts ? "active" : "limit_paused";
      if (account.status !== status) db.prepare("UPDATE accounts SET status=?,updatedAt=? WHERE tenantId=? AND accountId=?").run(status, new Date().toISOString(), tenantId, account.accountId);
    }
  })();
}
