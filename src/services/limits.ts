import type Database from "better-sqlite3";
import { isTier, planLimits } from "./plans.js";

const MAX_LIMIT = 1_000_000;
const keys = ["accounts", "groups", "campaigns", "targets", "dailyMessages"] as const;

export type Limits = Record<(typeof keys)[number], number>;

export function parseLimits(value: unknown, tier: string): Limits | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!isTier(tier)) return null;
  const defaults = planLimits(tier);
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
  const row = db.prepare("SELECT tierCode, limits FROM tenants WHERE tenantId = ?").get(tenantId) as { tierCode: string; limits: string } | undefined;
  if (!row) throw new Error("tenant not found");
  const limits = parseLimits(JSON.parse(row.limits), row.tierCode);
  if (!limits) throw new Error("tenant limits are invalid");
  return limits;
}

export function limitFor(db: Database.Database, tenantId: string, key: keyof Limits): number {
  return tenantLimits(db, tenantId)[key];
}

export function enforceTenantLimits(db: Database.Database, tenantId: string): void {
  const limits = tenantLimits(db, tenantId);
  db.transaction(() => {
    db.prepare(`UPDATE groups SET enabled = 0, updatedAt = datetime('now') WHERE tenantId = ? AND enabled = 1 AND chatKind='group' AND rowid NOT IN
      (SELECT rowid FROM groups WHERE tenantId = ? AND enabled = 1 AND chatKind='group' ORDER BY rowid LIMIT ?)`).run(tenantId, tenantId, limits.groups);
    db.prepare(`UPDATE campaigns SET status = 'paused', updatedAt = datetime('now') WHERE tenantId = ? AND status IN ('draft', 'scheduled', 'paused') AND id NOT IN
      (SELECT id FROM campaigns WHERE tenantId = ? ORDER BY id LIMIT ?)`).run(tenantId, tenantId, limits.campaigns);
    const campaigns = db.prepare("SELECT id FROM campaigns WHERE tenantId = ?").all(tenantId) as Array<{ id: number }>;
    for (const campaign of campaigns) db.prepare(`UPDATE campaignTargets SET enabled = 0, updatedAt = datetime('now') WHERE campaignId = ? AND tenantId = ? AND enabled = 1 AND chatId NOT IN
      (SELECT chatId FROM campaignTargets WHERE campaignId = ? AND tenantId = ? AND enabled = 1 ORDER BY chatId LIMIT ?)`).run(campaign.id, tenantId, campaign.id, tenantId, limits.targets);
    const connected = db.prepare("SELECT accountId,status FROM accounts WHERE tenantId=? AND status IN ('active','limit_paused') AND session IS NOT NULL ORDER BY CASE WHEN status='active' THEN 0 ELSE 1 END, createdAt, accountId")
      .all(tenantId) as Array<{ accountId: string; status: string }>;
    for (const [index, account] of connected.entries()) {
      const status = index < limits.accounts ? "active" : "limit_paused";
      if (account.status !== status) db.prepare("UPDATE accounts SET status=?,updatedAt=? WHERE tenantId=? AND accountId=?").run(status, new Date().toISOString(), tenantId, account.accountId);
    }
  })();
}
