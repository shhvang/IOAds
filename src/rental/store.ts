import type Database from "better-sqlite3";
import { now } from "../db.js";
import { shouldRun, versionVerdict, type TenantDesiredState, type TenantRuntimeState } from "./contract.js";
import { enforceTenantLimits, parseLimits } from "../services/limits.js";
import { forgetAdapter } from "../services/account.js";

export type TenantRow = TenantDesiredState & { appliedAt: string; fault: string | null };

const states = new Set(["pending", "active", "suspended", "cancelled", "purged"]);
const reasons = new Set(["unpaid", "blocked", "owner"]);

export function parseDesired(value: unknown): TenantDesiredState | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.tenantId !== "string" || !raw.tenantId || typeof raw.productId !== "string" || typeof raw.ownerTelegramId !== "number" || !Number.isSafeInteger(raw.ownerTelegramId) || typeof raw.version !== "number" || !Number.isSafeInteger(raw.version) || raw.version < 0 || typeof raw.tierCode !== "string" || !states.has(String(raw.state)) || (raw.runtime !== "service" && raw.runtime !== "hub")) return null;
  const limits = parseLimits(raw.limits, raw.tierCode);
  if (!limits || (raw.config !== undefined && (!raw.config || typeof raw.config !== "object" || Array.isArray(raw.config)))) return null;
  return {
    tenantId: raw.tenantId, productId: raw.productId, ownerTelegramId: raw.ownerTelegramId, state: raw.state as TenantDesiredState["state"],
    tierCode: raw.tierCode, runtime: raw.runtime === "hub" ? "hub" : "service", version: raw.version, trial: Boolean(raw.trial),
    suspendReason: reasons.has(String(raw.suspendReason)) ? raw.suspendReason as TenantDesiredState["suspendReason"] : null,
    periodEnd: typeof raw.periodEnd === "string" ? raw.periodEnd : null, retainUntil: typeof raw.retainUntil === "string" ? raw.retainUntil : null,
    limits, secretsFingerprint: typeof raw.secretsFingerprint === "string" ? raw.secretsFingerprint : null, expectData: raw.expectData === true,
    config: raw.config && typeof raw.config === "object" ? raw.config as Record<string, any> : {}, updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now(),
  };
}

const rowToDesired = (row: Record<string, unknown>): TenantDesiredState => ({
  tenantId: String(row.tenantId), productId: String(row.productId), ownerTelegramId: Number(row.ownerId),
  state: row.state as TenantDesiredState["state"], tierCode: String(row.tierCode), runtime: row.runtime as TenantDesiredState["runtime"],
  version: Number(row.version), trial: Boolean(row.trial), suspendReason: (row.suspendReason as TenantDesiredState["suspendReason"]) ?? null,
  periodEnd: (row.periodEnd as string) ?? null, retainUntil: (row.retainUntil as string) ?? null,
  limits: JSON.parse(String(row.limits || "{}")), secretsFingerprint: (row.secretsFingerprint as string) ?? null,
  expectData: false, config: JSON.parse(String(row.config || "{}")), updatedAt: String(row.updatedAt),
});

export function getTenant(db: Database.Database, tenantId: string): TenantRow | undefined {
  const row = db.prepare("SELECT * FROM tenants WHERE tenantId = ?").get(tenantId) as Record<string, unknown> | undefined;
  return row ? { ...rowToDesired(row), appliedAt: String(row.appliedAt), fault: (row.fault as string) ?? null } : undefined;
}

export function tenantForOwner(db: Database.Database, tenantId: string, ownerId: number): TenantRow | undefined {
  const row = db.prepare("SELECT * FROM tenants WHERE tenantId = ? AND ownerId = ?").get(tenantId, ownerId) as Record<string, unknown> | undefined;
  return row ? { ...rowToDesired(row), appliedAt: String(row.appliedAt), fault: (row.fault as string) ?? null } : undefined;
}

export function allTenants(db: Database.Database): TenantRow[] {
  return db.prepare("SELECT * FROM tenants ORDER BY tenantId").all().map((row) => {
    const raw = row as Record<string, unknown>;
    return { ...rowToDesired(raw), appliedAt: String(raw.appliedAt), fault: (raw.fault as string) ?? null };
  });
}

export function applyDesired(db: Database.Database, desired: TenantDesiredState): "apply" | "noop" | "stale" {
  const stored = getTenant(db, desired.tenantId);
  const tombstone = db.prepare("SELECT version FROM tombstones WHERE tenantId = ?").get(desired.tenantId) as { version: number } | undefined;
  const verdict = versionVerdict(desired.version, Math.max(stored?.version ?? -1, tombstone?.version ?? -1));
  if (verdict === "stale") return verdict;
  if (verdict === "noop") return verdict;
  if (desired.state === "purged") {
    db.transaction(() => {
      db.prepare("DELETE FROM deliveries WHERE tenantId = ?").run(desired.tenantId);
      db.prepare("DELETE FROM campaignTargets WHERE tenantId = ?").run(desired.tenantId);
      db.prepare("DELETE FROM campaigns WHERE tenantId = ?").run(desired.tenantId);
      db.prepare("DELETE FROM groups WHERE tenantId = ?").run(desired.tenantId);
       db.prepare("DELETE FROM accounts WHERE tenantId = ?").run(desired.tenantId);
      db.prepare("DELETE FROM audit WHERE tenantId = ?").run(desired.tenantId);
     db.prepare("DELETE FROM tenants WHERE tenantId = ?").run(desired.tenantId);
      db.prepare("INSERT INTO tombstones (tenantId, version) VALUES (?, ?) ON CONFLICT(tenantId) DO UPDATE SET version = excluded.version").run(desired.tenantId, desired.version);
    })();
    forgetAdapter(desired.tenantId);
    return "apply";
  }
  db.prepare(`INSERT INTO tenants (tenantId, productId, ownerId, state, tierCode, runtime, version, trial, suspendReason, periodEnd, retainUntil, limits, config, secretsFingerprint, controlBotFingerprint, controlBotToken, fault, updatedAt, appliedAt)
    VALUES (@tenantId, @productId, @ownerId, @state, @tierCode, @runtime, @version, @trial, @suspendReason, @periodEnd, @retainUntil, @limits, @config, @secretsFingerprint, NULL, NULL, @fault, @updatedAt, @appliedAt)
    ON CONFLICT(tenantId) DO UPDATE SET productId=excluded.productId, ownerId=excluded.ownerId, state=excluded.state, tierCode=excluded.tierCode, runtime=excluded.runtime, version=excluded.version, trial=excluded.trial, suspendReason=excluded.suspendReason, periodEnd=excluded.periodEnd, retainUntil=excluded.retainUntil, limits=excluded.limits, config=excluded.config, secretsFingerprint=excluded.secretsFingerprint, fault=excluded.fault, updatedAt=excluded.updatedAt, appliedAt=excluded.appliedAt`).run({
    tenantId: desired.tenantId, productId: desired.productId, ownerId: desired.ownerTelegramId, state: desired.state,
    tierCode: desired.tierCode, runtime: desired.runtime, version: desired.version, trial: desired.trial ? 1 : 0,
    suspendReason: desired.suspendReason, periodEnd: desired.periodEnd, retainUntil: desired.retainUntil,
    limits: JSON.stringify(desired.limits), config: JSON.stringify(desired.config), secretsFingerprint: desired.secretsFingerprint,
     fault: desired.runtime !== "service" ? "ads is service-run only" : null, updatedAt: desired.updatedAt, appliedAt: now(),
  });
  enforceTenantLimits(db, desired.tenantId);
  db.prepare("DELETE FROM tombstones WHERE tenantId = ?").run(desired.tenantId);
  return verdict;
}

export const runtimeState = (db: Database.Database, tenant: TenantRow): TenantRuntimeState => {
  const usage = db.prepare(`SELECT
    (SELECT COUNT(*) FROM accounts WHERE tenantId = @tenantId AND status = 'active' AND session IS NOT NULL) AS accounts,
    (SELECT COUNT(*) FROM groups WHERE tenantId = @tenantId AND enabled = 1) AS groups,
    (SELECT COUNT(*) FROM deliveries WHERE tenantId = @tenantId AND status = 'sent' AND sentAt >= date('now')) AS dailyMessages`).get({ tenantId: tenant.tenantId }) as Record<string, number>;
  const wanted = shouldRun(tenant, "service") && tenant.state === "active";
   const account = db.prepare("SELECT 1 FROM accounts WHERE tenantId = ? AND status = 'active' AND session IS NOT NULL LIMIT 1").get(tenant.tenantId);
   const hasData = Boolean(db.prepare("SELECT 1 FROM accounts WHERE tenantId = ?").get(tenant.tenantId));
   return { tenantId: tenant.tenantId, version: tenant.version, running: wanted && Boolean(account), applying: false, fault: tenant.fault ?? (wanted && !account ? "telegram account is not active" : null), usage, hasData, observedAt: now() };
};
