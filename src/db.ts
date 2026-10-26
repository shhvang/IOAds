import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const now = (): string => new Date().toISOString();

const DDL = `
CREATE TABLE IF NOT EXISTS tenants (
  tenantId TEXT PRIMARY KEY, productId TEXT NOT NULL, ownerId INTEGER NOT NULL,
  state TEXT NOT NULL, tierCode TEXT NOT NULL, runtime TEXT NOT NULL,
  version INTEGER NOT NULL, trial INTEGER NOT NULL, suspendReason TEXT,
  periodEnd TEXT, retainUntil TEXT, limits TEXT NOT NULL, config TEXT NOT NULL,
  secretsFingerprint TEXT, controlBotFingerprint TEXT, controlBotToken TEXT,
  fault TEXT, updatedAt TEXT NOT NULL, appliedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tenants_owner ON tenants(ownerId);
CREATE TABLE IF NOT EXISTS localUsers (telegramId INTEGER PRIMARY KEY, tenantId TEXT NOT NULL UNIQUE, tierCode TEXT NOT NULL DEFAULT 'free', paidUntil TEXT, forceJoined INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS botFlows (telegramId INTEGER PRIMARY KEY, data TEXT NOT NULL, updatedAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS planPayments (id INTEGER PRIMARY KEY, telegramId INTEGER NOT NULL, tierCode TEXT NOT NULL, network TEXT NOT NULL, amount REAL NOT NULL, reference TEXT NOT NULL UNIQUE, externalId TEXT UNIQUE, createdAt TEXT NOT NULL, expiresAt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending');
CREATE TABLE IF NOT EXISTS accounts (
  accountId TEXT PRIMARY KEY, tenantId TEXT NOT NULL, ownerId INTEGER NOT NULL, phone TEXT, displayName TEXT, telegramUserId INTEGER,
  session TEXT, sessionType TEXT NOT NULL DEFAULT 'tdlib', status TEXT NOT NULL DEFAULT 'logged_out', loginPhone TEXT,
  phoneCodeHash TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
  UNIQUE (tenantId, accountId),
  FOREIGN KEY (tenantId) REFERENCES tenants(tenantId) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS accounts_tenant ON accounts(tenantId);
CREATE TABLE IF NOT EXISTS groups (
  tenantId TEXT NOT NULL, accountId TEXT NOT NULL, chatId TEXT NOT NULL, title TEXT NOT NULL, username TEXT,
  enabled INTEGER NOT NULL DEFAULT 0, chatKind TEXT NOT NULL DEFAULT 'unknown', messageOverride TEXT, lastSentAt TEXT,
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, PRIMARY KEY (tenantId, accountId, chatId),
  FOREIGN KEY (tenantId, accountId) REFERENCES accounts(tenantId, accountId) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tenantId TEXT NOT NULL, name TEXT NOT NULL,
  senderAccountId TEXT NOT NULL,
  message TEXT NOT NULL, messageEntities TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'draft', intervalSeconds INTEGER NOT NULL,
  dailyLimit INTEGER NOT NULL DEFAULT 0, accountCooldownSeconds INTEGER NOT NULL DEFAULT 0,
  groupCooldownSeconds INTEGER NOT NULL DEFAULT 0, nextRunAt TEXT, promoNextAt TEXT, inlineMode INTEGER NOT NULL DEFAULT 0, sourceChatId TEXT, sourceMessageId INTEGER, richMessage TEXT, contentKind TEXT NOT NULL DEFAULT 'legacy', createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL, FOREIGN KEY (tenantId) REFERENCES tenants(tenantId) ON DELETE CASCADE,
  FOREIGN KEY (tenantId, senderAccountId) REFERENCES accounts(tenantId, accountId)
);
CREATE INDEX IF NOT EXISTS campaigns_due ON campaigns(status, nextRunAt);
CREATE TABLE IF NOT EXISTS campaignTargets (
  campaignId INTEGER NOT NULL, tenantId TEXT NOT NULL, accountId TEXT NOT NULL, chatId TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, PRIMARY KEY (campaignId, accountId, chatId),
  FOREIGN KEY (campaignId) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (tenantId, accountId, chatId) REFERENCES groups(tenantId, accountId, chatId) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tenantId TEXT NOT NULL, campaignId INTEGER NOT NULL,
  chatId TEXT NOT NULL, accountId TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  occurrenceKey TEXT, error TEXT, claimedAt TEXT, sentAt TEXT, createdAt TEXT NOT NULL,
  FOREIGN KEY (campaignId) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (tenantId, accountId, chatId) REFERENCES groups(tenantId, accountId, chatId) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS deliveries_limits ON deliveries(tenantId, status, sentAt);
CREATE TABLE IF NOT EXISTS promoDeliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, campaignId INTEGER NOT NULL, tenantId TEXT NOT NULL,
  occurrenceKey TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  nextAttemptAt TEXT, claimedAt TEXT, sentAt TEXT, error TEXT, createdAt TEXT NOT NULL,
  FOREIGN KEY (campaignId) REFERENCES campaigns(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS promo_deliveries_due ON promoDeliveries(status, nextAttemptAt, id);
CREATE TABLE IF NOT EXISTS tombstones (tenantId TEXT PRIMARY KEY, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rentalSyncState (id INTEGER PRIMARY KEY CHECK (id = 1), lastSeq INTEGER NOT NULL DEFAULT 0, cursor INTEGER, mode TEXT, seen TEXT NOT NULL DEFAULT '[]', updatedAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tenantId TEXT NOT NULL, actorId INTEGER, action TEXT NOT NULL,
  detail TEXT, createdAt TEXT NOT NULL, FOREIGN KEY (tenantId) REFERENCES tenants(tenantId) ON DELETE CASCADE
);
`;

export function openDb(path: string): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrateLegacyAccounts(db);
  db.exec(DDL);
  migrateCampaignTargetKeys(db);
  db.exec("CREATE INDEX IF NOT EXISTS campaign_targets_account ON campaignTargets(tenantId, campaignId, accountId, enabled)");
  const columns = db.prepare("PRAGMA table_info(deliveries)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "occurrenceKey")) db.exec("ALTER TABLE deliveries ADD COLUMN occurrenceKey TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS deliveries_occurrence ON deliveries(occurrenceKey) WHERE occurrenceKey IS NOT NULL");
  if (!columns.some((column) => column.name === "nextAttemptAt")) db.exec("ALTER TABLE deliveries ADD COLUMN nextAttemptAt TEXT");
  db.exec("UPDATE promoDeliveries SET status='skipped',error='automatic bot broadcast disabled',claimedAt=NULL WHERE status IN ('pending','retry','claimed')");
  db.exec("CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(status, nextAttemptAt, id)");
  db.exec("CREATE INDEX IF NOT EXISTS deliveries_account_claim ON deliveries(accountId, status, claimedAt)");
  const tenantColumns = db.prepare("PRAGMA table_info(tenants)").all() as Array<{ name: string }>;
  if (!tenantColumns.some((column) => column.name === "controlBotFingerprint")) db.exec("ALTER TABLE tenants ADD COLUMN controlBotFingerprint TEXT");
  if (!tenantColumns.some((column) => column.name === "controlBotToken")) db.exec("ALTER TABLE tenants ADD COLUMN controlBotToken TEXT");
  const accountColumns = db.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>;
  if (!accountColumns.some((column) => column.name === "sendAfter")) db.exec("ALTER TABLE accounts ADD COLUMN sendAfter TEXT");
  if (!accountColumns.some((column) => column.name === "displayName")) db.exec("ALTER TABLE accounts ADD COLUMN displayName TEXT");
  const groupColumns = db.prepare("PRAGMA table_info(groups)").all() as Array<{ name: string }>;
  if (!groupColumns.some((column) => column.name === "lastSeenSync")) db.exec("ALTER TABLE groups ADD COLUMN lastSeenSync TEXT");
  if (!groupColumns.some((column) => column.name === "chatKind")) db.exec("ALTER TABLE groups ADD COLUMN chatKind TEXT NOT NULL DEFAULT 'unknown'");
  if (!accountColumns.some((column) => column.name === "sessionType")) {
    db.exec("ALTER TABLE accounts ADD COLUMN sessionType TEXT NOT NULL DEFAULT 'gramjs'");
  }
  // Sessions are encrypted, so their ciphertext cannot be tested for the tdlib: prefix.
  // Only rows explicitly marked as legacy GramJS sessions need invalidation.
  const migrated = db.prepare("SELECT tenantId, accountId FROM accounts WHERE session IS NOT NULL AND sessionType = 'gramjs'").all() as Array<{ tenantId: string; accountId: string }>;
  db.transaction(() => {
    for (const account of migrated) {
      db.prepare("UPDATE accounts SET session = NULL, status = 'logged_out', loginPhone = NULL, phoneCodeHash = NULL, sessionType = 'tdlib', updatedAt = ? WHERE tenantId = ? AND accountId = ?").run(new Date().toISOString(), account.tenantId, account.accountId);
      db.prepare("UPDATE groups SET enabled = 0 WHERE tenantId = ? AND accountId = ?").run(account.tenantId, account.accountId);
      db.prepare("UPDATE campaignTargets SET enabled = 0 WHERE tenantId = ? AND accountId = ?").run(account.tenantId, account.accountId);
    }
  })();
  const campaignColumns = db.prepare("PRAGMA table_info(campaigns)").all() as Array<{ name: string }>;
  if (!campaignColumns.some((column) => column.name === "messageEntities")) db.exec("ALTER TABLE campaigns ADD COLUMN messageEntities TEXT NOT NULL DEFAULT '[]'");
  if (!campaignColumns.some((column) => column.name === "promoNextAt")) db.exec("ALTER TABLE campaigns ADD COLUMN promoNextAt TEXT");
  if (!campaignColumns.some((column) => column.name === "inlineMode")) db.exec("ALTER TABLE campaigns ADD COLUMN inlineMode INTEGER NOT NULL DEFAULT 0");
  if (!campaignColumns.some((column) => column.name === "sourceChatId")) db.exec("ALTER TABLE campaigns ADD COLUMN sourceChatId TEXT");
  if (!campaignColumns.some((column) => column.name === "sourceMessageId")) db.exec("ALTER TABLE campaigns ADD COLUMN sourceMessageId INTEGER");
  if (!campaignColumns.some((column) => column.name === "richMessage")) db.exec("ALTER TABLE campaigns ADD COLUMN richMessage TEXT");
  if (!campaignColumns.some((column) => column.name === "contentKind")) db.exec("ALTER TABLE campaigns ADD COLUMN contentKind TEXT NOT NULL DEFAULT 'legacy'");
  db.exec("UPDATE campaigns SET contentKind='text',inlineMode=0 WHERE contentKind='legacy' AND inlineMode=1 AND richMessage IS NULL AND message!='[Telegram media or rich message]' AND tenantId IN (SELECT tenantId FROM localUsers)");
  const paymentColumns = db.prepare("PRAGMA table_info(planPayments)").all() as Array<{ name: string }>;
  const paymentNames = new Set(paymentColumns.map((column) => column.name));
  if (!paymentNames.has("network")) db.exec("ALTER TABLE planPayments ADD COLUMN network TEXT NOT NULL DEFAULT 'Binance'");
  if (!paymentNames.has("amount")) db.exec("ALTER TABLE planPayments ADD COLUMN amount REAL NOT NULL DEFAULT 0");
  if (!paymentNames.has("externalId")) db.exec("ALTER TABLE planPayments ADD COLUMN externalId TEXT");
  if (!paymentNames.has("expiresAt")) db.exec("ALTER TABLE planPayments ADD COLUMN expiresAt TEXT NOT NULL DEFAULT ''");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS planPayments_externalId ON planPayments(externalId) WHERE externalId IS NOT NULL");
  db.exec("UPDATE tenants SET productId = 'ads-standalone' WHERE productId = 'ads' AND tenantId IN (SELECT tenantId FROM localUsers)");
  return db;
}

function migrateCampaignTargetKeys(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(campaignTargets)").all() as Array<{ name: string; pk: number }>;
  if (columns.find((column) => column.name === "accountId")?.pk === 2) return;
  db.transaction(() => {
    db.exec(`CREATE TABLE campaignTargets_v2 (
      campaignId INTEGER NOT NULL, tenantId TEXT NOT NULL, accountId TEXT NOT NULL, chatId TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, PRIMARY KEY (campaignId, accountId, chatId),
      FOREIGN KEY (campaignId) REFERENCES campaigns(id) ON DELETE CASCADE,
      FOREIGN KEY (tenantId, accountId, chatId) REFERENCES groups(tenantId, accountId, chatId) ON DELETE CASCADE
    )`);
    db.exec(`INSERT INTO campaignTargets_v2 (campaignId,tenantId,accountId,chatId,enabled,createdAt,updatedAt)
      SELECT campaignId,tenantId,accountId,chatId,enabled,createdAt,updatedAt FROM campaignTargets`);
    db.exec("DROP TABLE campaignTargets; ALTER TABLE campaignTargets_v2 RENAME TO campaignTargets");
  })();
}

function migrateLegacyAccounts(db: Database.Database): void {
  const accounts = db.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>;
  if (!accounts.length || accounts.some((column) => column.name === "accountId")) return;
  db.pragma("foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    const deliveryColumns = db.prepare("PRAGMA table_info(deliveries)").all() as Array<{ name: string }>;
    const occurrence = deliveryColumns.some((column) => column.name === "occurrenceKey") ? "occurrenceKey" : "NULL";
    db.exec("ALTER TABLE deliveries RENAME TO deliveries_legacy; ALTER TABLE campaignTargets RENAME TO campaignTargets_legacy; ALTER TABLE campaigns RENAME TO campaigns_legacy; ALTER TABLE groups RENAME TO groups_legacy; ALTER TABLE accounts RENAME TO accounts_legacy;");
    db.exec("DROP INDEX IF EXISTS campaigns_due; DROP INDEX IF EXISTS deliveries_limits;");
    db.exec(DDL);
    db.exec(`INSERT INTO accounts (accountId, tenantId, ownerId, phone, telegramUserId, session, sessionType, status, loginPhone, phoneCodeHash, createdAt, updatedAt)
      SELECT 'legacy:' || tenantId, tenantId, ownerId, phone, telegramUserId, session, 'gramjs', status, loginPhone, phoneCodeHash, createdAt, updatedAt FROM accounts_legacy`);
    db.exec(`INSERT INTO groups (tenantId, accountId, chatId, title, username, enabled, messageOverride, lastSentAt, createdAt, updatedAt)
      SELECT tenantId, 'legacy:' || tenantId, chatId, title, username, enabled, messageOverride, lastSentAt, createdAt, updatedAt FROM groups_legacy`);
    db.exec(`INSERT INTO campaigns (id, tenantId, name, senderAccountId, message, status, intervalSeconds, dailyLimit, accountCooldownSeconds, groupCooldownSeconds, nextRunAt, createdAt, updatedAt)
      SELECT id, tenantId, name, 'legacy:' || tenantId, message, status, intervalSeconds, dailyLimit, accountCooldownSeconds, groupCooldownSeconds, nextRunAt, createdAt, updatedAt FROM campaigns_legacy`);
    db.exec(`INSERT INTO campaignTargets (campaignId, tenantId, accountId, chatId, enabled, createdAt, updatedAt)
      SELECT campaignId, tenantId, 'legacy:' || tenantId, chatId, enabled, createdAt, updatedAt FROM campaignTargets_legacy`);
    db.exec(`INSERT INTO deliveries (id, tenantId, campaignId, chatId, accountId, status, attempts, occurrenceKey, error, claimedAt, sentAt, createdAt)
      SELECT id, tenantId, campaignId, chatId, 'legacy:' || tenantId, status, attempts, ${occurrence}, error, claimedAt, sentAt, createdAt FROM deliveries_legacy`);
    db.exec("DROP TABLE deliveries_legacy; DROP TABLE campaignTargets_legacy; DROP TABLE campaigns_legacy; DROP TABLE groups_legacy; DROP TABLE accounts_legacy;");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.pragma("foreign_keys = ON");
  }
}
