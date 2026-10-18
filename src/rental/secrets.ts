import type Database from "better-sqlite3";
import { config } from "../config.js";
import { seal } from "../lib/crypto.js";
import { CONTRACT_HEADER, CONTRACT_PREFIX, CONTRACT_REVISION, fingerprint, type TenantDesiredState, type TenantSecrets } from "./contract.js";

export function storeControlBotToken(db: Database.Database, tenantId: string, token: string | null, secretFingerprint: string | null): void {
  db.prepare("UPDATE tenants SET controlBotToken = ?, controlBotFingerprint = ? WHERE tenantId = ?")
    .run(token ? seal(token, config.sessionEncryptionKey) : null, secretFingerprint, tenantId);
}

export function refreshControlBotSecret(db: Database.Database, desired: TenantDesiredState): Promise<void> {
  const current = db.prepare("SELECT controlBotFingerprint FROM tenants WHERE tenantId = ?").get(desired.tenantId) as { controlBotFingerprint: string | null } | undefined;
  if (current?.controlBotFingerprint === desired.secretsFingerprint) return Promise.resolve();

  if (!desired.secretsFingerprint) {
    storeControlBotToken(db, desired.tenantId, null, null);
    return Promise.resolve();
  }
  if (!config.rental) throw new Error("rental hub is not configured");
  if (!config.sessionEncryptionKey) throw new Error("SESSION_ENCRYPTION_KEY is required for the control bot token");

  return fetch(`${config.rental.hubUrl}${CONTRACT_PREFIX}/tenants/${encodeURIComponent(desired.tenantId)}/secrets`, {
    headers: {
      authorization: `Bearer ${config.rental.secrets[0]}`,
      [CONTRACT_HEADER]: CONTRACT_REVISION,
    },
    signal: AbortSignal.timeout(15_000),
  }).then(async (response) => {
    if (!response.ok) throw new Error(`hub answered ${response.status}`);
    const payload = (await response.json()) as TenantSecrets;
    if (payload.tenantId !== desired.tenantId || payload.fingerprint !== desired.secretsFingerprint || fingerprint(payload.values ?? {}) !== desired.secretsFingerprint) throw new Error("secret fingerprint mismatch");
    const token = typeof payload.values?.botToken === "string" && payload.values.botToken ? payload.values.botToken : null;
     storeControlBotToken(db, desired.tenantId, token, payload.fingerprint);
  });
}
