import type Database from "better-sqlite3";
import { now } from "../db.js";

export function writeAudit(db: Database.Database, tenantId: string, action: string, detail?: unknown, actorId?: number): void {
  db.prepare("INSERT INTO audit (tenantId, actorId, action, detail, createdAt) VALUES (?, ?, ?, ?, ?)").run(tenantId, actorId ?? null, action, detail === undefined ? null : JSON.stringify(detail), now());
}
