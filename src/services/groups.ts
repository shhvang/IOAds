import type Database from "better-sqlite3";
import { now } from "../db.js";
import { adapterFor, requireAccount } from "./account.js";
import { writeAudit } from "./audit.js";
import { limitFor } from "./limits.js";

export async function syncGroups(db: Database.Database, tenantId: string, accountId: string): Promise<unknown[]> {
  requireAccount(db, tenantId, accountId, true);
  const groups = await adapterFor(db, tenantId, accountId).dialogs();
  const insert = db.prepare(`INSERT INTO groups (tenantId, accountId, chatId, title, username, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenantId, accountId, chatId) DO UPDATE SET title=excluded.title, username=excluded.username, updatedAt=excluded.updatedAt`);
  const transaction = db.transaction(() => {
    for (const group of groups) insert.run(tenantId, accountId, group.chatId, group.title, group.username, now(), now());
    db.prepare(`UPDATE groups SET enabled = 0, updatedAt = ? WHERE tenantId = ? AND accountId = ?${groups.length ? ` AND chatId NOT IN (${groups.map(() => "?").join(",")})` : ""}`).run(now(), tenantId, accountId, ...groups.map((group) => group.chatId));
  });
  transaction();
  return db.prepare("SELECT tenantId, accountId, chatId, title, username, enabled, messageOverride, lastSentAt FROM groups WHERE tenantId = ? AND accountId = ? ORDER BY title").all(tenantId, accountId);
}

export async function setGroup(db: Database.Database, tenantId: string, accountId: string, chatId: string, enabled: boolean, messageOverride: string | null | undefined, rank: number): Promise<void> {
  requireAccount(db, tenantId, accountId, true);
  if (typeof messageOverride === "string" && (!messageOverride.trim() || messageOverride.length > 4096)) throw new Error("messageOverride must be 1-4096 characters");
  if (typeof messageOverride === "string" && rank < 1) throw new Error("custom group messages require a paid plan");
  const current = db.prepare("SELECT enabled FROM groups WHERE tenantId = ? AND accountId = ? AND chatId = ?").get(tenantId, accountId, chatId) as { enabled: number } | undefined;
  if (!current) throw new Error("group not found");
  if (enabled && !(await adapterFor(db, tenantId, accountId).canPost(chatId))) throw new Error("selected account cannot post to this group");
  const result = db.transaction(() => {
    if (enabled && !current.enabled && Number((db.prepare("SELECT COUNT(*) AS n FROM groups WHERE tenantId = ? AND enabled = 1").get(tenantId) as { n: number }).n) >= limitFor(db, tenantId, "groups")) throw new Error("enabled group limit reached");
    return messageOverride === undefined
      ? db.prepare("UPDATE groups SET enabled = ?, updatedAt = ? WHERE tenantId = ? AND accountId = ? AND chatId = ?").run(enabled ? 1 : 0, now(), tenantId, accountId, chatId)
      : db.prepare("UPDATE groups SET enabled = ?, messageOverride = ?, updatedAt = ? WHERE tenantId = ? AND accountId = ? AND chatId = ?").run(enabled ? 1 : 0, messageOverride, now(), tenantId, accountId, chatId);
  })();
  if (!result.changes) throw new Error("group not found");
  writeAudit(db, tenantId, enabled ? "group_enabled" : "group_disabled", { accountId, chatId, hasOverride: typeof messageOverride === "string" });
}

export function setGroupOverride(db: Database.Database, tenantId: string, accountId: string, chatId: string, messageOverride: string | null, rank: number): void {
  if (typeof messageOverride === "string" && (!messageOverride.trim() || messageOverride.length > 4096)) throw new Error("messageOverride must be 1-4096 characters");
  if (typeof messageOverride === "string" && rank < 1) throw new Error("custom group messages require a paid plan");
  const result = db.prepare("UPDATE groups SET messageOverride = ?, updatedAt = ? WHERE tenantId = ? AND accountId = ? AND chatId = ?").run(messageOverride, now(), tenantId, accountId, chatId);
  if (!result.changes) throw new Error("group not found");
  writeAudit(db, tenantId, "group_override_updated", { accountId, chatId, hasOverride: typeof messageOverride === "string" });
}
