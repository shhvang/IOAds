import type Database from "better-sqlite3";
import { now } from "../db.js";
import { config } from "../config.js";
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
  if (Number((db.prepare("SELECT COUNT(*) AS n FROM campaigns WHERE tenantId = ? AND status != 'cancelled'").get(tenantId) as { n: number }).n) >= limitFor(db, tenantId, "campaigns")) throw new Error("campaign limit reached");
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
  if (input.senderAccountId !== undefined) sender(db, tenantId, input.senderAccountId);
  for (const field of updates) input[field] = checks[field]!();
  if (updates.length) db.prepare(`UPDATE campaigns SET ${updates.map((field) => `${field} = @${field}`).join(", ")}, updatedAt = @updatedAt WHERE tenantId = @tenantId AND id = @id`).run({ ...input, updatedAt: now(), tenantId, id });
  writeAudit(db, tenantId, "campaign_updated", { id });
  return campaign(db, tenantId, id);
}
export function deleteCampaign(db: Database.Database, tenantId: string, id: number): void { db.prepare("DELETE FROM campaigns WHERE tenantId = ? AND id = ?").run(tenantId, id); writeAudit(db, tenantId, "campaign_deleted", { id }); }
export function setCampaignStatus(db: Database.Database, tenantId: string, id: number, status: "scheduled" | "paused" | "cancelled"): void {
  const current = campaign(db, tenantId, id) as { senderAccountId: string; status: string } | undefined;
  if (!current) throw new Error("campaign not found");
  if (status === "scheduled") {
    if (current.status === "cancelled" && Number((db.prepare("SELECT COUNT(*) AS n FROM campaigns WHERE tenantId=? AND id!=? AND status!='cancelled'").get(tenantId, id) as { n: number }).n) >= limitFor(db, tenantId, "campaigns")) throw new Error("campaign limit reached");
    const target = db.prepare(`SELECT 1 FROM campaignTargets ct JOIN groups g
      ON g.tenantId=ct.tenantId AND g.accountId=ct.accountId AND g.chatId=ct.chatId
      JOIN accounts a ON a.tenantId=ct.tenantId AND a.accountId=ct.accountId JOIN tenants t ON t.tenantId=ct.tenantId
      WHERE ct.tenantId=? AND ct.campaignId=? AND ct.enabled=1 AND g.enabled=1 AND g.chatKind='group' AND a.status='active' AND a.session IS NOT NULL AND a.telegramUserId IS NOT NULL AND a.telegramUserId!=t.ownerId LIMIT 1`)
      .get(tenantId, id);
    if (!target) throw new Error("Choose at least one enabled group before scheduling this campaign.");
  }
  db.transaction(() => {
    db.prepare("UPDATE campaigns SET status=?, nextRunAt=CASE WHEN ?='scheduled' AND ?!='scheduled' THEN ? ELSE nextRunAt END, updatedAt=? WHERE tenantId=? AND id=?")
      .run(status, status, current.status, now(), now(), tenantId, id);
    if (status === "cancelled") {
      db.prepare("UPDATE deliveries SET status='skipped',error='campaign cancelled' WHERE tenantId=? AND campaignId=? AND status IN ('pending','retry')").run(tenantId, id);
    }
  })();
  writeAudit(db, tenantId, `campaign_${status}`, { id });
}
export async function addTarget(db: Database.Database, tenantId: string, id: number, chatId: string, accountId?: string): Promise<void> {
  const current = db.prepare("SELECT senderAccountId FROM campaigns WHERE tenantId = ? AND id = ?").get(tenantId, id) as { senderAccountId: string } | undefined;
  if (!current) throw new Error("campaign not found");
  const selectedAccountId = accountId ?? current.senderAccountId;
  requireAccount(db, tenantId, selectedAccountId, true);
  if (typeof chatId !== "string" || !chatId || chatId.length > 100) throw new Error("invalid chatId");
  const group = db.prepare("SELECT enabled FROM groups WHERE tenantId = ? AND accountId = ? AND chatId = ? AND chatKind='group'").get(tenantId, selectedAccountId, chatId) as { enabled: number } | undefined;
  if (!group) throw new Error("group not found for sender account");
  if (chatId === config.archiveChat) throw new Error("the archive chat cannot be a campaign target");
  if (!group.enabled && !(await adapterFor(db, tenantId, selectedAccountId).canPost(chatId))) throw new Error("selected account cannot post to this group");
  db.transaction(() => {
    const selected = db.prepare("SELECT enabled FROM campaignTargets WHERE tenantId=? AND campaignId=? AND accountId=? AND chatId=?").get(tenantId, id, selectedAccountId, chatId) as { enabled: number } | undefined;
    if (!selected?.enabled && Number((db.prepare("SELECT COUNT(*) AS n FROM campaignTargets WHERE tenantId=? AND campaignId=? AND enabled=1").get(tenantId, id) as { n: number }).n) >= limitFor(db, tenantId, "targets")) throw new Error("target limit reached");
    db.prepare("INSERT INTO campaignTargets (campaignId, tenantId, accountId, chatId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(campaignId, accountId, chatId) DO UPDATE SET enabled=1, updatedAt=excluded.updatedAt").run(id, tenantId, selectedAccountId, chatId, now(), now());
  })();
  writeAudit(db, tenantId, "target_added", { campaignId: id, accountId: selectedAccountId, chatId });
}
export async function selectAllTargets(db: Database.Database, tenantId: string, id: number, accountId?: string): Promise<{ selected: number; skipped: number }> {
  const current = db.prepare("SELECT senderAccountId FROM campaigns WHERE tenantId=? AND id=?").get(tenantId, id) as { senderAccountId: string } | undefined;
  if (!current) throw new Error("campaign not found");
  const selectedAccountId = accountId ?? current.senderAccountId;
  requireAccount(db, tenantId, selectedAccountId, true);
  const groups = db.prepare("SELECT chatId,enabled FROM groups WHERE tenantId=? AND accountId=? AND chatKind='group' ORDER BY title").all(tenantId, selectedAccountId) as Array<{ chatId: string; enabled: number }>;
  const adapter = adapterFor(db, tenantId, selectedAccountId);
  const allowed: string[] = [];
  let skipped = 0;
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, groups.length) }, async () => {
    while (cursor < groups.length) {
      const group = groups[cursor++]!;
      if (group.chatId === config.archiveChat) { skipped++; continue; }
      if (group.enabled) { allowed.push(group.chatId); continue; }
      try { if (await adapter.canPost(group.chatId)) allowed.push(group.chatId); else skipped++; }
      catch { skipped++; }
    }
  }));
  const count = db.prepare("SELECT COUNT(*) AS n FROM campaignTargets WHERE tenantId=? AND campaignId=? AND enabled=1").get(tenantId, id) as { n: number };
  const enabledTargets = new Set((db.prepare("SELECT chatId FROM campaignTargets WHERE tenantId=? AND campaignId=? AND accountId=? AND enabled=1").all(tenantId, id, selectedAccountId) as Array<{ chatId: string }>).map((row) => row.chatId));
  if (count.n + allowed.filter((chatId) => !enabledTargets.has(chatId)).length > limitFor(db, tenantId, "targets")) throw new Error("target limit reached");
  const enabledGroups = (db.prepare("SELECT COUNT(*) AS n FROM groups WHERE tenantId=? AND enabled=1 AND chatKind='group'").get(tenantId) as { n: number }).n;
  const disabled = new Set(groups.filter((group) => !group.enabled).map((group) => group.chatId));
  const enableCount = allowed.filter((chatId) => disabled.has(chatId)).length;
  if (enabledGroups + enableCount > limitFor(db, tenantId, "groups")) throw new Error("enabled group limit reached");
  const timestamp = now();
  const enableGroup = db.prepare("UPDATE groups SET enabled=1,updatedAt=? WHERE tenantId=? AND accountId=? AND chatId=? AND chatKind='group'");
  const add = db.prepare("INSERT INTO campaignTargets (campaignId,tenantId,accountId,chatId,createdAt,updatedAt) VALUES (?,?,?,?,?,?) ON CONFLICT(campaignId,accountId,chatId) DO UPDATE SET enabled=1,updatedAt=excluded.updatedAt");
  db.transaction(() => {
    for (const chatId of allowed) {
      enableGroup.run(timestamp, tenantId, selectedAccountId, chatId);
      add.run(id, tenantId, selectedAccountId, chatId, timestamp, timestamp);
    }
  })();
  writeAudit(db, tenantId, "targets_selected_all", { campaignId: id, accountId: selectedAccountId, selected: allowed.length, skipped });
  return { selected: allowed.length, skipped };
}
export function clearTargets(db: Database.Database, tenantId: string, id: number, accountId?: string): number {
  const current = campaign(db, tenantId, id) as { senderAccountId: string } | undefined;
  if (!current) throw new Error("campaign not found");
  const selectedAccountId = accountId ?? current.senderAccountId;
  const changed = db.prepare("UPDATE campaignTargets SET enabled=0,updatedAt=? WHERE tenantId=? AND campaignId=? AND accountId=? AND enabled=1").run(now(), tenantId, id, selectedAccountId).changes;
  if (changed) writeAudit(db, tenantId, "targets_cleared", { campaignId: id, accountId: selectedAccountId, count: changed });
  return changed;
}
export function updateTarget(db: Database.Database, tenantId: string, id: number, chatId: string, enabled: unknown, accountId?: string): void {
  if (typeof enabled !== "boolean") throw new Error("enabled must be boolean");
  const current = campaign(db, tenantId, id) as { senderAccountId: string } | undefined;
  if (!current) throw new Error("campaign not found");
  const selectedAccountId = accountId ?? current.senderAccountId;
  if (enabled) {
    requireAccount(db, tenantId, selectedAccountId, true);
    if (!db.prepare("SELECT 1 FROM groups WHERE tenantId=? AND accountId=? AND chatId=? AND chatKind='group' AND enabled=1").get(tenantId, selectedAccountId, chatId)) throw new Error("enabled group not found");
    const existing = db.prepare("SELECT enabled FROM campaignTargets WHERE tenantId=? AND campaignId=? AND accountId=? AND chatId=?").get(tenantId, id, selectedAccountId, chatId) as { enabled: number } | undefined;
    if (existing && !existing.enabled && Number((db.prepare("SELECT COUNT(*) AS n FROM campaignTargets WHERE tenantId=? AND campaignId=? AND enabled=1").get(tenantId, id) as { n: number }).n) >= limitFor(db, tenantId, "targets")) throw new Error("target limit reached");
  }
  const result = db.prepare("UPDATE campaignTargets SET enabled=?,updatedAt=? WHERE campaignId=? AND tenantId=? AND accountId=? AND chatId=?").run(enabled ? 1 : 0, now(), id, tenantId, selectedAccountId, chatId);
  if (!result.changes) throw new Error("target not found");
  writeAudit(db, tenantId, enabled ? "target_enabled" : "target_disabled", { campaignId: id, accountId: selectedAccountId, chatId });
}
export function deleteTarget(db: Database.Database, tenantId: string, id: number, chatId: string, accountId?: string): void {
  const current = campaign(db, tenantId, id) as { senderAccountId: string } | undefined;
  if (!current) throw new Error("campaign not found");
  const selectedAccountId = accountId ?? current.senderAccountId;
  db.prepare("DELETE FROM campaignTargets WHERE campaignId=? AND tenantId=? AND accountId=? AND chatId=?").run(id, tenantId, selectedAccountId, chatId);
  writeAudit(db, tenantId, "target_deleted", { campaignId: id, accountId: selectedAccountId, chatId });
}
export function detail(db: Database.Database, tenantId: string, id: number): unknown { const row = campaign(db, tenantId, id); return row ? { ...(row as object), targets: db.prepare("SELECT * FROM campaignTargets WHERE tenantId = ? AND campaignId = ?").all(tenantId, id) } : undefined; }
