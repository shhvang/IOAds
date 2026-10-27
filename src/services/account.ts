import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { now } from "../db.js";
import { seal } from "../lib/crypto.js";
import { createTelegramAdapter, hasTdlibSession, removeTdlibSession, type TelegramAdapter } from "../telegram.js";
import { remoteAdapterFor } from "./worker-pool.js";
import { enforceTenantLimits, isTenantBlocked, limitFor, revokeOwnerAccounts } from "./limits.js";

const adapters = new Map<string, TelegramAdapter>();
const testAdapters = new Map<string, TelegramAdapter>();
const key = (tenantId: string, accountId: string): string => `${tenantId}:${accountId}`;
const ownerAccountError = "Use a different Telegram account for the userbot. The account operating this bot cannot be connected as a sender.";
function ownerId(db: Database.Database, tenantId: string): number {
  const row = db.prepare("SELECT ownerId FROM tenants WHERE tenantId=?").get(tenantId) as { ownerId: number } | undefined;
  if (!row) throw new Error("tenant not found");
  return row.ownerId;
}

export function setAdapterForTest(tenantId: string, accountId: string, adapter: TelegramAdapter): void { testAdapters.set(key(tenantId, accountId), adapter); }

export function forgetAdapter(tenantId: string, accountId?: string): void {
  const entries = [...adapters.entries()].filter(([adapterKey]) => adapterKey.startsWith(`${tenantId}:`) && (!accountId || adapterKey === key(tenantId, accountId)));
  for (const [adapterKey, adapter] of entries) {
    adapters.delete(adapterKey);
    void adapter.logout().catch(() => undefined);
  }
  for (const testKey of [...testAdapters.keys()]) if (testKey.startsWith(`${tenantId}:`) && (!accountId || testKey === key(tenantId, accountId))) testAdapters.delete(testKey);
}

/** Close loaded clients without logging out, preserving encrypted TDLib sessions. */
export async function quiesceTenantAdapters(db: Database.Database, tenantId: string): Promise<void> {
  const rows = db.prepare("SELECT accountId FROM accounts WHERE tenantId=?").all(tenantId) as Array<{ accountId: string }>;
  const results = await Promise.allSettled(rows.map(async ({ accountId }) => {
    const adapterKey = key(tenantId, accountId);
    const adapter = adapters.get(adapterKey) ?? testAdapters.get(adapterKey) ?? remoteAdapterFor(accountId);
    adapters.delete(adapterKey);
    await adapter?.close();
  }));
  for (const result of results) if (result.status === "rejected") console.error(`ads sender close failed for blocked tenant ${tenantId}: ${String(result.reason)}`);
}

export function accounts(db: Database.Database, tenantId: string): Array<{ accountId: string; status: string; phone: string | null; displayName: string | null; telegramUserId: number | null; createdAt: string }> {
  return db.prepare("SELECT accountId, status, phone, displayName, telegramUserId, createdAt FROM accounts WHERE tenantId = ? ORDER BY CASE WHEN status='active' THEN 0 WHEN status='limit_paused' THEN 1 ELSE 2 END, createdAt DESC, accountId").all(tenantId) as Array<{ accountId: string; status: string; phone: string | null; displayName: string | null; telegramUserId: number | null; createdAt: string }>;
}

export function accountStatus(db: Database.Database, tenantId: string, accountId?: string): unknown {
  if (accountId) {
    const row = db.prepare("SELECT accountId, status, phone, displayName, telegramUserId FROM accounts WHERE tenantId = ? AND accountId = ?").get(tenantId, accountId);
    if (!row) throw new Error("account not found");
    return row;
  }
  return accounts(db, tenantId);
}

export function activeAccount(db: Database.Database, tenantId: string, accountId: string): boolean {
  if (isTenantBlocked(db, tenantId)) return false;
  const row = db.prepare("SELECT a.status,a.session,a.telegramUserId,t.ownerId FROM accounts a JOIN tenants t ON t.tenantId=a.tenantId WHERE a.tenantId = ? AND a.accountId = ?").get(tenantId, accountId) as { status: string; session: string | null; telegramUserId: number | null; ownerId: number } | undefined;
  return row?.status === "active" && Boolean(row.session) && row.telegramUserId != null && row.telegramUserId !== row.ownerId;
}

export function requireAccount(db: Database.Database, tenantId: string, accountId: string, active = false): void {
  if (!db.prepare("SELECT 1 FROM accounts WHERE tenantId = ? AND accountId = ?").get(tenantId, accountId)) throw new Error("account not found");
  if (active && !activeAccount(db, tenantId, accountId)) throw new Error("account is not active");
}

export function adapterFor(db: Database.Database, tenantId: string, accountId: string): TelegramAdapter {
  if (isTenantBlocked(db, tenantId)) throw new Error("user is blocked");
  const adapterKey = key(tenantId, accountId);
  const injected = testAdapters.get(adapterKey);
  if (injected) return injected;
  const row = db.prepare("SELECT 1 FROM accounts WHERE tenantId = ? AND accountId = ?").get(tenantId, accountId);
  if (!row) throw new Error("account not found");
  const cached = adapters.get(adapterKey);
  if (cached) return cached;
  const adapter = remoteAdapterFor(accountId) ?? createTelegramAdapter(accountId);
  adapters.set(adapterKey, adapter);
  return adapter;
}

export async function refreshAccountProfile(db: Database.Database, tenantId: string, accountId: string): Promise<void> {
  requireAccount(db, tenantId, accountId, true);
  const adapter = adapterFor(db, tenantId, accountId);
  const result = await adapter.profile();
  if (result.userId === ownerId(db, tenantId)) {
    db.prepare("UPDATE accounts SET telegramUserId=? WHERE tenantId=? AND accountId=?").run(result.userId, tenantId, accountId);
    revokeOwnerAccounts(db, tenantId);
    await adapter.close().catch(() => undefined);
    adapters.delete(key(tenantId, accountId));
    throw new Error(ownerAccountError);
  }
  const row = db.prepare("SELECT telegramUserId FROM accounts WHERE tenantId=? AND accountId=?").get(tenantId, accountId) as { telegramUserId: number | null } | undefined;
  if (!row) throw new Error("account not found");
  if (row.telegramUserId && row.telegramUserId !== result.userId) {
    db.prepare("UPDATE accounts SET status='logged_out',updatedAt=? WHERE tenantId=? AND accountId=?").run(now(), tenantId, accountId);
    throw new Error("Saved session belongs to another Telegram account. Reconnect to continue.");
  }
  db.prepare("UPDATE accounts SET displayName=?,telegramUserId=?,updatedAt=? WHERE tenantId=? AND accountId=?")
    .run(result.displayName || null, result.userId, now(), tenantId, accountId);
}

export async function loginStart(db: Database.Database, tenantId: string, phone: string, requestedAccountId?: string): Promise<{ accountId: string; sent: true }> {
  if (isTenantBlocked(db, tenantId)) throw new Error("user is blocked");
  if (!config.sessionEncryptionKey) throw new Error("SESSION_ENCRYPTION_KEY is required before login");
  const accountId = requestedAccountId ?? randomUUID();
  const owned = db.prepare("SELECT tenantId, status, telegramUserId FROM accounts WHERE accountId = ?").get(accountId) as { tenantId: string; status: string; telegramUserId: number | null } | undefined;
  if (owned && owned.tenantId !== tenantId) throw new Error("account not found");
  if (owned?.telegramUserId === ownerId(db, tenantId)) throw new Error(ownerAccountError);
  if (owned?.status === "active" || owned?.status === "limit_paused") throw new Error("account is already connected");
  if (Number((db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE tenantId = ? AND accountId != ? AND (status = 'active' OR status = 'connecting')").get(tenantId, accountId) as { n: number }).n) >= limitFor(db, tenantId, "accounts")) throw new Error("account limit reached");
  if (owned?.status === "connecting") await cancelLogin(db, tenantId, accountId);
  else if (owned) {
    const previous = adapters.get(key(tenantId, accountId)) ?? (hasTdlibSession(accountId) ? remoteAdapterFor(accountId) : null);
    await previous?.logout();
    adapters.delete(key(tenantId, accountId));
  }
  const created = now();
  db.prepare(`INSERT INTO accounts (accountId, tenantId, ownerId, status, sessionType, loginPhone, createdAt, updatedAt) SELECT ?, tenantId, ownerId, 'connecting', 'tdlib', ?, ?, ? FROM tenants WHERE tenantId = ?
     ON CONFLICT(tenantId, accountId) DO UPDATE SET loginPhone=excluded.loginPhone, phoneCodeHash=NULL, session=NULL, sessionType='tdlib', status='connecting', updatedAt=excluded.updatedAt`).run(accountId, phone, created, created, tenantId);
  const adapter = adapterFor(db, tenantId, accountId);
  try {
    const result = await adapter.sendCode(phone);
    const saved = db.prepare("UPDATE accounts SET phoneCodeHash = ?, updatedAt = ? WHERE tenantId = ? AND accountId = ? AND status = 'connecting'").run(result.phoneCodeHash, now(), tenantId, accountId);
    if (!saved.changes) throw new Error("login was cancelled");
    return { accountId, sent: true };
  } catch (error) {
    db.prepare("UPDATE accounts SET status = 'logged_out', loginPhone = NULL, phoneCodeHash = NULL, updatedAt = ? WHERE tenantId = ? AND accountId = ? AND status = 'connecting'").run(now(), tenantId, accountId);
    await adapter.logout().catch(() => undefined);
    adapters.delete(key(tenantId, accountId));
    db.prepare("DELETE FROM accounts WHERE tenantId=? AND accountId=? AND phone IS NULL AND session IS NULL AND status='logged_out'").run(tenantId, accountId);
    throw error;
  }
}

export async function cancelLogin(db: Database.Database, tenantId: string, accountId: string): Promise<void> {
  const changed = db.prepare("UPDATE accounts SET status = 'logged_out', loginPhone = NULL, phoneCodeHash = NULL, updatedAt = ? WHERE tenantId = ? AND accountId = ? AND status = 'connecting'").run(now(), tenantId, accountId);
  if (!changed.changes) return;
  const adapter = adapters.get(key(tenantId, accountId)) ?? remoteAdapterFor(accountId);
  adapters.delete(key(tenantId, accountId));
  await adapter?.logout().catch(() => undefined);
  db.prepare("DELETE FROM accounts WHERE tenantId=? AND accountId=? AND phone IS NULL AND session IS NULL AND status='logged_out'").run(tenantId, accountId);
}

export async function loginComplete(db: Database.Database, tenantId: string, accountId: string, phone: string, code: string, password?: string): Promise<void> {
  if (isTenantBlocked(db, tenantId)) throw new Error("user is blocked");
  if (!config.sessionEncryptionKey) throw new Error("SESSION_ENCRYPTION_KEY is required before login");
  const row = db.prepare("SELECT phoneCodeHash, status, loginPhone FROM accounts WHERE tenantId = ? AND accountId = ?").get(tenantId, accountId) as { phoneCodeHash: string | null; status: string; loginPhone: string | null } | undefined;
  if (row?.status !== "connecting" || !row.phoneCodeHash) throw new Error("login code was not requested");
  if (row.loginPhone !== phone) throw new Error("phone number does not match this login");
  const adapter = adapterFor(db, tenantId, accountId);
  const result = await adapter.signIn(phone, row.phoneCodeHash, code, password);
  if (isTenantBlocked(db, tenantId)) {
    await adapter.close().catch(() => undefined);
    adapters.delete(key(tenantId, accountId));
    throw new Error("user is blocked");
  }
  if (result.userId === ownerId(db, tenantId)) {
    await adapter.logout().catch(() => undefined);
    adapters.delete(key(tenantId, accountId));
    db.prepare("UPDATE accounts SET status='logged_out',session=NULL,loginPhone=NULL,phoneCodeHash=NULL,telegramUserId=?,updatedAt=? WHERE tenantId=? AND accountId=?")
      .run(result.userId, now(), tenantId, accountId);
    db.prepare("DELETE FROM accounts WHERE tenantId=? AND accountId=? AND phone IS NULL AND session IS NULL AND status='logged_out'").run(tenantId, accountId);
    throw new Error(ownerAccountError);
  }
  const duplicate = db.prepare("SELECT phone FROM accounts WHERE tenantId=? AND accountId!=? AND telegramUserId=? AND status IN ('active','limit_paused') LIMIT 1")
    .get(tenantId, accountId, result.userId) as { phone: string | null } | undefined;
  if (duplicate) {
    await adapter.logout().catch(() => undefined);
    adapters.delete(key(tenantId, accountId));
    db.prepare("UPDATE accounts SET status='logged_out',loginPhone=NULL,phoneCodeHash=NULL,updatedAt=? WHERE tenantId=? AND accountId=?").run(now(), tenantId, accountId);
    db.prepare("DELETE FROM accounts WHERE tenantId=? AND accountId=? AND phone IS NULL AND session IS NULL AND status='logged_out'").run(tenantId, accountId);
    throw new Error(`This Telegram account is already connected${duplicate.phone ? ` as ${duplicate.phone}` : ""}.`);
  }
  const saved = db.prepare("UPDATE accounts SET phone = ?, displayName=?, telegramUserId = ?, session = ?, sessionType='tdlib', status = 'active', loginPhone = NULL, phoneCodeHash = NULL, updatedAt = ? WHERE tenantId = ? AND accountId = ? AND status = 'connecting'")
    .run(phone, result.displayName || null, result.userId, seal(result.session, config.sessionEncryptionKey), now(), tenantId, accountId);
  if (!saved.changes) {
    await adapter.logout().catch(() => undefined);
    adapters.delete(key(tenantId, accountId));
    throw new Error("login was cancelled");
  }
}

export async function logout(db: Database.Database, tenantId: string, accountId: string): Promise<void> {
  requireAccount(db, tenantId, accountId);
  const row = db.prepare("SELECT status, session FROM accounts WHERE tenantId = ? AND accountId = ?").get(tenantId, accountId) as { status: string; session: string | null };
  try {
    if ((row.status === "active" || row.status === "limit_paused") && row.session) await adapterFor(db, tenantId, accountId).logout();
  } catch (error) {
    adapters.delete(key(tenantId, accountId));
    throw error;
  }
  db.prepare("UPDATE accounts SET session = NULL, status = 'logged_out', loginPhone = NULL, phoneCodeHash = NULL, updatedAt = ? WHERE tenantId = ? AND accountId = ?").run(now(), tenantId, accountId);
  adapters.delete(key(tenantId, accountId));
  enforceTenantLimits(db, tenantId);
}

export async function deleteAccount(db: Database.Database, tenantId: string, accountId: string): Promise<void> {
  requireAccount(db, tenantId, accountId);
  if (db.prepare("SELECT 1 FROM campaigns WHERE tenantId = ? AND senderAccountId = ? LIMIT 1").get(tenantId, accountId)) throw new Error("Delete or change campaigns started with this account before removing it.");
  await logout(db, tenantId, accountId);
  removeTdlibSession(accountId);
  db.prepare("DELETE FROM accounts WHERE tenantId = ? AND accountId = ?").run(tenantId, accountId);
}

export function canRestoreAccount(db: Database.Database, tenantId: string, accountId: string): boolean {
  const row = db.prepare("SELECT status,phone,session,telegramUserId FROM accounts WHERE tenantId=? AND accountId=?").get(tenantId, accountId) as { status: string; phone: string | null; session: string | null; telegramUserId: number | null } | undefined;
  return row?.status === "logged_out" && !!row.phone && !row.session && row.telegramUserId !== ownerId(db, tenantId) && hasTdlibSession(accountId);
}

export async function restoreAccount(db: Database.Database, tenantId: string, accountId: string): Promise<boolean> {
  if (isTenantBlocked(db, tenantId)) throw new Error("user is blocked");
  if (!config.sessionEncryptionKey) throw new Error("SESSION_ENCRYPTION_KEY is required before recovery");
  if (!canRestoreAccount(db, tenantId, accountId)) throw new Error("No saved Telegram session is available. Connect the account again.");
  if (Number((db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE tenantId=? AND status IN ('active','connecting')").get(tenantId) as { n: number }).n) >= limitFor(db, tenantId, "accounts")) throw new Error("Account limit reached. Upgrade your plan or disconnect another account.");
  const adapter = adapterFor(db, tenantId, accountId);
  try {
    const resumed = await adapter.resumeSession();
    if (isTenantBlocked(db, tenantId)) throw new Error("user is blocked");
    if (!resumed) { await adapter.close(); adapters.delete(key(tenantId, accountId)); return false; }
    if (resumed.userId === ownerId(db, tenantId)) throw new Error(ownerAccountError);
    const duplicate = db.prepare("SELECT 1 FROM accounts WHERE tenantId=? AND accountId!=? AND telegramUserId=? AND status IN ('active','limit_paused')")
      .get(tenantId, accountId, resumed.userId);
    if (duplicate) throw new Error("This Telegram account is already connected elsewhere in your account list.");
    db.prepare("UPDATE accounts SET session=?,sessionType='tdlib',telegramUserId=?,displayName=?,status='active',updatedAt=? WHERE tenantId=? AND accountId=? AND status='logged_out'")
      .run(seal(`tdlib:${accountId}`, config.sessionEncryptionKey), resumed.userId, resumed.displayName || null, now(), tenantId, accountId);
    return true;
  } catch (error) {
    await adapter.close().catch(() => undefined);
    adapters.delete(key(tenantId, accountId));
    throw error;
  }
}
