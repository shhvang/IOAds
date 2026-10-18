import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { now } from "../db.js";
import { seal } from "../lib/crypto.js";
import { createTelegramAdapter, type TelegramAdapter } from "../telegram.js";
import { limitFor } from "./limits.js";

const adapters = new Map<string, TelegramAdapter>();
const key = (tenantId: string, accountId: string): string => `${tenantId}:${accountId}`;

export function setAdapterForTest(tenantId: string, accountId: string, adapter: TelegramAdapter): void { adapters.set(key(tenantId, accountId), adapter); }

export function forgetAdapter(tenantId: string, accountId?: string): void {
  const entries = [...adapters.entries()].filter(([adapterKey]) => adapterKey.startsWith(`${tenantId}:`) && (!accountId || adapterKey === key(tenantId, accountId)));
  for (const [adapterKey, adapter] of entries) {
    adapters.delete(adapterKey);
    void adapter.logout().catch(() => undefined);
  }
}

export function accounts(db: Database.Database, tenantId: string): Array<{ accountId: string; status: string; phone: string | null; telegramUserId: number | null }> {
  return db.prepare("SELECT accountId, status, phone, telegramUserId FROM accounts WHERE tenantId = ? ORDER BY createdAt, accountId").all(tenantId) as Array<{ accountId: string; status: string; phone: string | null; telegramUserId: number | null }>;
}

export function accountStatus(db: Database.Database, tenantId: string, accountId?: string): unknown {
  if (accountId) {
    const row = db.prepare("SELECT accountId, status, phone, telegramUserId FROM accounts WHERE tenantId = ? AND accountId = ?").get(tenantId, accountId);
    if (!row) throw new Error("account not found");
    return row;
  }
  return accounts(db, tenantId);
}

export function activeAccount(db: Database.Database, tenantId: string, accountId: string): boolean {
  const row = db.prepare("SELECT status, session FROM accounts WHERE tenantId = ? AND accountId = ?").get(tenantId, accountId) as { status: string; session: string | null } | undefined;
  return row?.status === "active" && Boolean(row.session);
}

export function requireAccount(db: Database.Database, tenantId: string, accountId: string, active = false): void {
  if (!db.prepare("SELECT 1 FROM accounts WHERE tenantId = ? AND accountId = ?").get(tenantId, accountId)) throw new Error("account not found");
  if (active && !activeAccount(db, tenantId, accountId)) throw new Error("account is not active");
}

export function adapterFor(db: Database.Database, tenantId: string, accountId: string): TelegramAdapter {
  const adapterKey = key(tenantId, accountId);
  const row = db.prepare("SELECT status, session FROM accounts WHERE tenantId = ? AND accountId = ?").get(tenantId, accountId) as { status: string; session: string | null } | undefined;
  if (!row) throw new Error("account not found");
  const cached = adapters.get(adapterKey);
  if (cached && (row.status === "connecting" || row.status === "active" || Boolean(row.session))) return cached;
  if (cached) {
    adapters.delete(adapterKey);
    void cached.logout().catch(() => undefined);
  }
  const adapter = createTelegramAdapter(accountId);
  adapters.set(adapterKey, adapter);
  return adapter;
}

export async function loginStart(db: Database.Database, tenantId: string, phone: string, requestedAccountId?: string): Promise<{ accountId: string; sent: true }> {
  if (!config.sessionEncryptionKey) throw new Error("SESSION_ENCRYPTION_KEY is required before login");
  const accountId = requestedAccountId ?? randomUUID();
  const owned = db.prepare("SELECT tenantId, status FROM accounts WHERE accountId = ?").get(accountId) as { tenantId: string; status: string } | undefined;
  if (owned && owned.tenantId !== tenantId) throw new Error("account not found");
  if (owned?.status === "active") throw new Error("account is already active");
  const existing = db.prepare("SELECT status FROM accounts WHERE tenantId = ? AND accountId = ?").get(tenantId, accountId) as { status: string } | undefined;
   if (Number((db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE tenantId = ? AND (status = 'active' OR status = 'connecting')").get(tenantId) as { n: number }).n) >= limitFor(db, tenantId, "accounts")) throw new Error("account limit reached");
  const created = now();
  db.prepare(`INSERT INTO accounts (accountId, tenantId, ownerId, loginPhone, createdAt, updatedAt) SELECT ?, tenantId, ownerId, ?, ?, ? FROM tenants WHERE tenantId = ?
     ON CONFLICT(tenantId, accountId) DO UPDATE SET loginPhone=excluded.loginPhone, phoneCodeHash=NULL, status='connecting', updatedAt=excluded.updatedAt`).run(accountId, phone, created, created, tenantId);
  const adapter = adapterFor(db, tenantId, accountId);
  try {
    const result = await adapter.sendCode(phone);
    db.prepare("UPDATE accounts SET phoneCodeHash = ?, updatedAt = ? WHERE tenantId = ? AND accountId = ? AND status = 'connecting'").run(result.phoneCodeHash, now(), tenantId, accountId);
    return { accountId, sent: true };
  } catch (error) {
    db.prepare("UPDATE accounts SET status = 'logged_out', loginPhone = NULL, phoneCodeHash = NULL, updatedAt = ? WHERE tenantId = ? AND accountId = ? AND status = 'connecting'").run(now(), tenantId, accountId);
    await adapter.logout().catch(() => undefined);
    adapters.delete(key(tenantId, accountId));
    throw error;
  }
}

export async function cancelLogin(db: Database.Database, tenantId: string, accountId: string): Promise<void> {
  db.prepare("UPDATE accounts SET status = 'logged_out', loginPhone = NULL, phoneCodeHash = NULL, updatedAt = ? WHERE tenantId = ? AND accountId = ? AND status = 'connecting'").run(now(), tenantId, accountId);
  const adapter = adapters.get(key(tenantId, accountId));
  adapters.delete(key(tenantId, accountId));
  await adapter?.logout().catch(() => undefined);
}

export async function loginComplete(db: Database.Database, tenantId: string, accountId: string, phone: string, code: string, password?: string): Promise<void> {
  if (!config.sessionEncryptionKey) throw new Error("SESSION_ENCRYPTION_KEY is required before login");
  const adapter = adapterFor(db, tenantId, accountId);
  const row = db.prepare("SELECT phoneCodeHash, status FROM accounts WHERE tenantId = ? AND accountId = ?").get(tenantId, accountId) as { phoneCodeHash: string | null; status: string } | undefined;
  if (row?.status !== "connecting" || !row.phoneCodeHash) throw new Error("login code was not requested");
  const result = await adapter.signIn(phone, row.phoneCodeHash, code, password);
  const saved = db.prepare("UPDATE accounts SET phone = ?, telegramUserId = ?, session = ?, status = 'active', loginPhone = NULL, phoneCodeHash = NULL, updatedAt = ? WHERE tenantId = ? AND accountId = ? AND status = 'connecting'")
    .run(phone, result.userId, seal(result.session, config.sessionEncryptionKey), now(), tenantId, accountId);
  if (!saved.changes) throw new Error("login was cancelled");
}

export async function logout(db: Database.Database, tenantId: string, accountId: string): Promise<void> {
  requireAccount(db, tenantId, accountId);
  const row = db.prepare("SELECT status, session FROM accounts WHERE tenantId = ? AND accountId = ?").get(tenantId, accountId) as { status: string; session: string | null };
  try {
    if (row.status === "active" && row.session) await adapterFor(db, tenantId, accountId).logout();
  } finally {
    db.prepare("UPDATE accounts SET session = NULL, status = 'logged_out', loginPhone = NULL, phoneCodeHash = NULL, updatedAt = ? WHERE tenantId = ? AND accountId = ?").run(now(), tenantId, accountId);
    adapters.delete(key(tenantId, accountId));
  }
}

export async function deleteAccount(db: Database.Database, tenantId: string, accountId: string): Promise<void> {
  requireAccount(db, tenantId, accountId);
  if (db.prepare("SELECT 1 FROM campaigns WHERE tenantId = ? AND senderAccountId = ? LIMIT 1").get(tenantId, accountId)) throw new Error("delete or change campaigns using this account first");
  await logout(db, tenantId, accountId);
  db.prepare("DELETE FROM accounts WHERE tenantId = ? AND accountId = ?").run(tenantId, accountId);
}
