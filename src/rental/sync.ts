import type Database from "better-sqlite3";
import { config } from "../config.js";
import { applyDesired, parseDesired } from "./store.js";
import { refreshControlBotSecret } from "./secrets.js";
import { CONTRACT_HEADER, CONTRACT_PREFIX, CONTRACT_REVISION, type EntitlementFeed, type TenantDesiredState } from "./contract.js";

let lastSync: string | null = null;
let lastSeq = 0;
let inFlight: Promise<void> | null = null;

export const lastFeedSyncAt = (): string | null => lastSync;
export const sequence = (): number => lastSeq;

async function syncEntitlementsOnce(db: Database.Database, full: boolean): Promise<void> {
  if (!config.rental) return;
  const stored = db.prepare("SELECT lastSeq, cursor, mode, seen, updatedAt FROM rentalSyncState WHERE id = 1").get() as { lastSeq: number; cursor: number | null; mode: string | null; seen: string; updatedAt: string } | undefined;
  if (!stored || (full && (stored.mode !== "full" || stored.cursor === null))) db.prepare("INSERT INTO rentalSyncState (id, lastSeq, cursor, mode, seen, updatedAt) VALUES (1, ?, NULL, ?, '[]', ?) ON CONFLICT(id) DO UPDATE SET cursor = NULL, mode = excluded.mode, seen = '[]', updatedAt = excluded.updatedAt").run(stored?.lastSeq ?? lastSeq, full ? "full" : "delta", new Date().toISOString());
  const state = db.prepare("SELECT lastSeq, cursor, mode, seen FROM rentalSyncState WHERE id = 1").get() as { lastSeq: number; cursor: number | null; mode: string; seen: string };
  lastSeq = state.lastSeq;
  if (!full && state.mode === "full") return;
  let cursor: number | null = state.cursor;
  let pages = 0;
  const seen = new Set<string>(JSON.parse(state.seen));
  let complete = false;
  let authoritative = full;
  do {
    const url = new URL(`${config.rental.hubUrl}${CONTRACT_PREFIX}/entitlements`);
    if (!full) url.searchParams.set("since", String(state.lastSeq));
    if (cursor !== null) url.searchParams.set("cursor", String(cursor));
    const response = await fetch(url, { headers: { authorization: `Bearer ${config.rental.secrets[0]}`, [CONTRACT_HEADER]: CONTRACT_REVISION }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`hub answered ${response.status}`);
    const feed = (await response.json()) as EntitlementFeed;
    if (feed.contract?.split(".")[0] !== CONTRACT_REVISION.split(".")[0]) throw new Error(`unsupported contract ${feed.contract}`);
    if (typeof feed.seq !== "number" || !Number.isSafeInteger(feed.seq) || !Array.isArray(feed.tenants)) throw new Error("invalid entitlement feed");
    authoritative = authoritative && feed.full === true;
    for (const row of feed.tenants) {
      const desired = parseDesired(row);
      if (!desired || desired.productId !== "ads") continue;
      applyDesired(db, desired);
      await refreshControlBotSecret(db, desired).catch((error) => console.error(`ads secret sync failed for ${desired.tenantId}: ${String(error)}`));
      seen.add(desired.tenantId);
    }
    lastSeq = Math.max(lastSeq, feed.seq);
    cursor = feed.nextCursor === null ? null : (typeof feed.nextCursor === "number" && Number.isSafeInteger(feed.nextCursor) ? feed.nextCursor : (() => { throw new Error("invalid entitlement cursor"); })());
    complete = cursor === null;
    db.prepare("UPDATE rentalSyncState SET lastSeq = ?, cursor = ?, mode = ?, seen = ?, updatedAt = ? WHERE id = 1").run(lastSeq, cursor, full ? "full" : "delta", JSON.stringify([...seen]), new Date().toISOString());
    pages += 1;
  } while (cursor !== null && pages < 50);
  if (full && complete && authoritative) {
    const remove = db.transaction(() => {
      for (const tenant of db.prepare("SELECT tenantId, version FROM tenants WHERE productId = 'ads'").all() as Array<{ tenantId: string; version: number }>) {
        if (!seen.has(tenant.tenantId)) {
          db.prepare("DELETE FROM tenants WHERE tenantId = ?").run(tenant.tenantId);
          db.prepare("INSERT INTO tombstones (tenantId, version) VALUES (?, ?) ON CONFLICT(tenantId) DO UPDATE SET version = excluded.version").run(tenant.tenantId, tenant.version);
        }
      }
    });
    remove();
  }
  if (full && complete && authoritative) db.prepare("UPDATE rentalSyncState SET lastSeq = ?, cursor = NULL, mode = 'delta', seen = '[]', updatedAt = ? WHERE id = 1").run(lastSeq, new Date().toISOString());
  lastSync = new Date().toISOString();
}

export async function syncEntitlements(db: Database.Database, full = false): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = syncEntitlementsOnce(db, full).finally(() => { inFlight = null; });
  return inFlight;
}

export function startRentalSync(db: Database.Database): void {
  if (!config.rental) return;
  void syncEntitlements(db, true).catch((error) => console.error(`rental sync failed: ${String(error)}`));
  setInterval(() => void syncEntitlements(db).catch((error) => console.error(`rental sync failed: ${String(error)}`)), 60_000).unref();
  setInterval(() => void syncEntitlements(db, true).catch((error) => console.error(`rental sync failed: ${String(error)}`)), 600_000).unref();
}
