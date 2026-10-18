import type Database from "better-sqlite3";
import { now } from "../db.js";
import { adapterFor, requireAccount } from "./account.js";
import { writeAudit } from "./audit.js";
import { limitFor } from "./limits.js";

const text = (value: unknown, field: string, max: number): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${field} must be 1-${max} characters`);
  return value;
};
const integer = (value: unknown, field: string, min: number, max: number): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${field} must be an integer between ${min} and ${max}`);
  return value;
};
const sender = (db: Database.Database, tenantId: string, accountId: unknown): string => {
  const value = text(accountId, "senderAccountId", 100);
  requireAccount(db, tenantId, value, true);
  return value;
};
function campaign(db: Database.Database, tenantId: string, id: number): unknown { return db.prepare("SELECT * FROM campaigns WHERE tenantId = ? AND id = ?").get(tenantId, id); }
export function listCampaigns(db: Database.Database, tenantId: string): unknown[] { return db.prepare("SELECT * FROM campaigns WHERE tenantId = ? ORDER BY id DESC").all(tenantId); }

export function createCampaign(db: Database.Database, tenantId: string, input: { name: string; message: string; senderAccountId: string; intervalSeconds?: number; dailyLimit?: number; accountCooldownSeconds?: number; groupCooldownSeconds?: number }): unknown {
  if (Number((db.prepare("SELECT COUNT(*) AS n FROM campaigns WHERE tenantId = ?").get(tenantId) as { n: number }).n) >= limitFor(db, tenantId, "campaigns")) throw new Error("campaign limit reached");
  const name = text(input.name, "name", 120), message = text(input.message, "message", 4096), senderAccountId = sender(db, tenantId, input.senderAccountId);
  const intervalSeconds = integer(input.intervalSeconds ?? 3600, "intervalSeconds", 300, 3600), dailyLimit = integer(input.dailyLimit ?? 0, "dailyLimit", 0, 1_000_000), accountCooldownSeconds = integer(input.accountCooldownSeconds ?? 0, "accountCooldownSeconds", 0, 31_536_000), groupCooldownSeconds = integer(input.groupCooldownSeconds ?? 0, "groupCooldownSeconds", 0, 31_536_000);
  const result = db.prepare(`INSERT INTO campaigns (tenantId, name, senderAccountId, message, intervalSeconds, dailyLimit, accountCooldownSeconds, groupCooldownSeconds, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(tenantId, name, senderAccountId, message, intervalSeconds, dailyLimit, accountCooldownSeconds, groupCooldownSeconds, now(), now());
  writeAudit(db, tenantId, "campaign_created", { id: Number(result.lastInsertRowid), senderAccountId });
  return campaign(db, tenantId, Number(result.lastInsertRowid));
}

export function updateCampaign(db: Database.Database, tenantId: string, id: number, input: Record<string, unknown>): unknown {
  const current = campaign(db, tenantId, id) as { senderAccountId: string } | undefined;
  if (!current) throw new Error("campaign not found");
  const checks: Record<string, () => unknown> = { name: () => text(input.name, "name", 120), message: () => text(input.message, "message", 4096), senderAccountId: () => sender(db, tenantId, input.senderAccountId), intervalSeconds: () => integer(input.intervalSeconds, "intervalSeconds", 300, 3600), dailyLimit: () => integer(input.dailyLimit, "dailyLimit", 0, 1_000_000), accountCooldownSeconds: () => integer(input.accountCooldownSeconds, "accountCooldownSeconds", 0, 31_536_000), groupCooldownSeconds: () => integer(input.groupCooldownSeconds, "groupCooldownSeconds", 0, 31_536_000) };
  const updates = Object.keys(checks).filter((field) => input[field] !== undefined);
  sender(db, tenantId, input.senderAccountId ?? current.senderAccountId);
  if (input.senderAccountId !== undefined && input.senderAccountId !== current.senderAccountId && db.prepare("SELECT 1 FROM campaignTargets WHERE tenantId = ? AND campaignId = ?").get(tenantId, id)) throw new Error("remove targets before changing sender account");
  for (const field of updates) input[field] = checks[field]!();
  if (updates.length) db.prepare(`UPDATE campaigns SET ${updates.map((field) => `${field} = @${field}`).join(", ")}, updatedAt = @updatedAt WHERE tenantId = @tenantId AND id = @id`).run({ ...input, updatedAt: now(), tenantId, id });
  writeAudit(db, tenantId, "campaign_updated", { id });
  return campaign(db, tenantId, id);
}
export function deleteCampaign(db: Database.Database, tenantId: string, id: number): void { db.prepare("DELETE FROM campaigns WHERE tenantId = ? AND id = ?").run(tenantId, id); writeAudit(db, tenantId, "campaign_deleted", { id }); }
export function setCampaignStatus(db: Database.Database, tenantId: string, id: number, status: "scheduled" | "paused" | "cancelled"): void { if (!campaign(db, tenantId, id)) throw new Error("campaign not found"); db.prepare("UPDATE campaigns SET status = ?, nextRunAt = CASE WHEN ? = 'scheduled' THEN COALESCE(nextRunAt, ?) ELSE nextRunAt END, updatedAt = ? WHERE tenantId = ? AND id = ?").run(status, status, now(), now(), tenantId, id); writeAudit(db, tenantId, `campaign_${status}`, { id }); }
export async function addTarget(db: Database.Database, tenantId: string, id: number, chatId: string): Promise<void> {
  const current = db.prepare("SELECT senderAccountId FROM campaigns WHERE tenantId = ? AND id = ?").get(tenantId, id) as { senderAccountId: string } | undefined;
  if (!current) throw new Error("campaign not found");
  requireAccount(db, tenantId, current.senderAccountId, true);
  if (typeof chatId !== "string" || !chatId || chatId.length > 100) throw new Error("invalid chatId");
  if (!db.prepare("SELECT 1 FROM groups WHERE tenantId = ? AND accountId = ? AND chatId = ?").get(tenantId, current.senderAccountId, chatId)) throw new Error("group not found for sender account");
  if (!(await adapterFor(db, tenantId, current.senderAccountId).canPost(chatId))) throw new Error("selected account cannot post to this group");
  db.transaction(() => {
    if (!db.prepare("SELECT 1 FROM campaignTargets WHERE tenantId = ? AND campaignId = ? AND chatId = ?").get(tenantId, id, chatId) && Number((db.prepare("SELECT COUNT(*) AS n FROM campaignTargets WHERE tenantId = ? AND campaignId = ?").get(tenantId, id) as { n: number }).n) >= limitFor(db, tenantId, "targets")) throw new Error("target limit reached");
    db.prepare("INSERT INTO campaignTargets (campaignId, tenantId, accountId, chatId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(campaignId, chatId) DO UPDATE SET enabled=1, updatedAt=excluded.updatedAt").run(id, tenantId, current.senderAccountId, chatId, now(), now());
  })();
  writeAudit(db, tenantId, "target_added", { campaignId: id, chatId });
}
export function updateTarget(db: Database.Database, tenantId: string, id: number, chatId: string, enabled: unknown): void { if (typeof enabled !== "boolean") throw new Error("enabled must be boolean"); const result = db.prepare("UPDATE campaignTargets SET enabled = ?, updatedAt = ? WHERE campaignId = ? AND tenantId = ? AND chatId = ?").run(enabled ? 1 : 0, now(), id, tenantId, chatId); if (!result.changes) throw new Error("target not found"); writeAudit(db, tenantId, enabled ? "target_enabled" : "target_disabled", { campaignId: id, chatId }); }
export function deleteTarget(db: Database.Database, tenantId: string, id: number, chatId: string): void { db.prepare("DELETE FROM campaignTargets WHERE campaignId = ? AND tenantId = ? AND chatId = ?").run(id, tenantId, chatId); writeAudit(db, tenantId, "target_deleted", { campaignId: id, chatId }); }
export function detail(db: Database.Database, tenantId: string, id: number): unknown { const row = campaign(db, tenantId, id); return row ? { ...(row as object), targets: db.prepare("SELECT * FROM campaignTargets WHERE tenantId = ? AND campaignId = ?").all(tenantId, id) } : undefined; }
