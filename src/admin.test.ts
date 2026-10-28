import assert from "node:assert/strict";
import { openDb, now } from "./db.js";
import { config } from "./config.js";
import { tierLimits } from "./services/plans.js";
import { broadcastAudienceCounts, createAdminBroadcast, grantStandalonePlan, runAdminBroadcastOnce, setAdminBroadcastStatus, setUserBlocked, startAdminBroadcast } from "./services/admin.js";
import { FakeTelegramAdapter } from "./telegram.js";
import { runSchedulerOnce } from "./services/scheduler.js";
import { activeAccount, adapterFor, setAdapterForTest, forgetAdapter } from "./services/account.js";
import { syncGroups } from "./services/groups.js";
import { groupLink, telegramProfileLink } from "./admin-bot.js";
import { isTenantBlocked } from "./services/limits.js";
import { inlineResults } from "./inline.js";

const db = openDb(":memory:");
const previousAdmin = config.adminTelegramId;
config.adminTelegramId = 5552153244;
function seed(owner: number, tier: string, groups: string[]): void {
  const tenantId = `ads:${owner}`, accountId = `account-${owner}`;
  db.prepare(`INSERT INTO tenants(tenantId,productId,ownerId,state,tierCode,runtime,version,trial,limits,config,updatedAt,appliedAt)
    VALUES(?,'ads-standalone',?,'active',?,'service',1,0,?,'{}',?,?)`)
    .run(tenantId, owner, tier, JSON.stringify(tierLimits(tier)), now(), now());
  db.prepare("INSERT INTO localUsers(telegramId,tenantId,tierCode,forceJoined,createdAt,updatedAt) VALUES(?,?,?,1,?,?)")
    .run(owner, tenantId, tier, now(), now());
  db.prepare("INSERT INTO accounts(accountId,tenantId,ownerId,telegramUserId,session,status,createdAt,updatedAt) VALUES(?,?,?,?,?,'active',?,?)")
    .run(accountId, tenantId, owner, owner + 1000, "fake", now(), now());
  for (const chatId of groups) db.prepare("INSERT INTO groups(tenantId,accountId,chatId,title,enabled,chatKind,createdAt,updatedAt) VALUES(?,?,?,?,1,'group',?,?)")
    .run(tenantId, accountId, chatId, `Group ${chatId}`, now(), now());
}
seed(10, "free", ["-100", "-101"]);
seed(20, "pro", ["-100", "-102"]);
assert.equal((db.prepare("SELECT COUNT(*) AS n FROM groupDirectory").get() as { n: number }).n, 3);
assert.equal(telegramProfileLink("ad_user", 42), "https://t.me/ad_user");
assert.equal(telegramProfileLink(null, 42), "tg://user?id=42");
assert.equal(telegramProfileLink(null, 42, "+12345678901"), "https://t.me/+12345678901");
const previousKey = config.sessionEncryptionKey;
config.sessionEncryptionKey = "directory-test-key";
seed(30, "free", []);
const directoryAdapter = new FakeTelegramAdapter();
directoryAdapter.profile = async () => ({ userId: 1030, displayName: "Sender", username: "sender_user" });
directoryAdapter.groups.push(
  { chatId: "-100300", title: "Public group", username: "public_group", kind: "group" },
  { chatId: "-100301", title: "Private group", username: null, inviteLink: "https://t.me/+inviteHash123", kind: "group" },
  { chatId: "-100302", title: "Channel", username: "some_channel", kind: "channel" },
);
setAdapterForTest("ads:30", "account-30", directoryAdapter);
await syncGroups(db, "ads:30", "account-30");
assert.equal((db.prepare("SELECT username FROM accounts WHERE accountId='account-30'").get() as { username: string }).username, "sender_user");
const publicGroup = db.prepare("SELECT username,inviteCipher FROM groupDirectory WHERE chatId='-100300'").get() as { username: string | null; inviteCipher: string | null };
const privateGroup = db.prepare("SELECT username,inviteCipher FROM groupDirectory WHERE chatId='-100301'").get() as { username: string | null; inviteCipher: string | null };
assert.equal(groupLink(publicGroup), "https://t.me/public_group");
assert.ok(privateGroup.inviteCipher && !privateGroup.inviteCipher.includes("inviteHash123"));
assert.equal(groupLink(privateGroup), "https://t.me/+inviteHash123");
assert.equal(db.prepare("SELECT 1 FROM groupDirectory WHERE chatId='-100302'").get(), undefined);
db.prepare("DELETE FROM accounts WHERE accountId='account-30'").run();
assert.equal(db.prepare("SELECT 1 FROM groups WHERE chatId='-100301'").get(), undefined);
assert.equal(groupLink(db.prepare("SELECT username,inviteCipher FROM groupDirectory WHERE chatId='-100301'").get() as typeof privateGroup), "https://t.me/+inviteHash123");
db.prepare("DELETE FROM localUsers WHERE telegramId=30").run();
db.prepare("DELETE FROM tenants WHERE tenantId='ads:30'").run();
forgetAdapter("ads:30", "account-30");
config.sessionEncryptionKey = previousKey;
assert.deepEqual(broadcastAudienceCounts(db, 1), { botUsers: 2, groups: 0 });
assert.deepEqual(broadcastAudienceCounts(db, 2), { botUsers: 2, groups: 2 });
assert.deepEqual(broadcastAudienceCounts(db, 3), { botUsers: 2, groups: 3 });

const until = grantStandalonePlan(db, 10, "business", 30);
assert.ok(until && Date.parse(until) > Date.now() + 29 * 86400_000);
assert.equal((db.prepare("SELECT tierCode FROM tenants WHERE tenantId='ads:10'").get() as { tierCode: string }).tierCode, "business");
assert.equal((db.prepare("SELECT tierCode FROM localUsers WHERE telegramId=10").get() as { tierCode: string }).tierCode, "business");
const extended = grantStandalonePlan(db, 10, "business", 90);
assert.ok(extended && Date.parse(extended) >= Date.parse(until) + 89 * 86400_000);
grantStandalonePlan(db, 10, "free");
assert.equal((db.prepare("SELECT paidUntil FROM localUsers WHERE telegramId=10").get() as { paidUntil: string | null }).paidUntil, null);
await assert.rejects(async () => grantStandalonePlan(db, 99, "pro"), /not found/);

const source = { sourceChatId: "5552153244", sourceMessageId: 42, archiveChatId: null, archiveMessageId: null, message: "Announcement", entities: "[]", contentKind: "text" as const };
const blockId = createAdminBroadcast(db, source);
startAdminBroadcast(db, blockId, 3);
assert.equal(await setUserBlocked(db, 10, true), 1);
assert.equal(isTenantBlocked(db, "ads:10"), true);
assert.equal(activeAccount(db, "ads:10", "account-10"), false);
assert.throws(() => adapterFor(db, "ads:10", "account-10"), /blocked/);
assert.equal((db.prepare("SELECT status FROM accounts WHERE accountId='account-10'").get() as { status: string }).status, "blocked");
assert.equal((db.prepare("SELECT session FROM accounts WHERE accountId='account-10'").get() as { session: string }).session, "fake");
assert.equal((db.prepare("SELECT COUNT(*) AS n FROM adminBroadcastTargets WHERE broadcastId=? AND status='skipped'").get(blockId) as { n: number }).n, 3);
assert.deepEqual(broadcastAudienceCounts(db, 3), { botUsers: 1, groups: 2 });
setAdminBroadcastStatus(db, blockId, "cancel");
assert.equal(await setUserBlocked(db, 10, false), 1);
assert.equal(isTenantBlocked(db, "ads:10"), false);
assert.equal(activeAccount(db, "ads:10", "account-10"), true);
assert.deepEqual(broadcastAudienceCounts(db, 3), { botUsers: 2, groups: 3 });
await assert.rejects(() => setUserBlocked(db, config.adminTelegramId, true), /admin account/);
const id = createAdminBroadcast(db, source);
assert.deepEqual(startAdminBroadcast(db, id, 2), { botUsers: 2, groups: 2 });
assert.throws(() => startAdminBroadcast(db, id, 2), /no longer a draft/);
const botSends: string[] = [];
const adapters = new Map([["ads:10", new FakeTelegramAdapter()], ["ads:20", new FakeTelegramAdapter()]]);
for (let i = 0; i < 5; i += 1) {
  await runAdminBroadcastOnce(db, async (chatId) => { botSends.push(chatId); }, (tenantId) => adapters.get(tenantId)!, 8);
  db.prepare("UPDATE accounts SET sendAfter=NULL").run();
}
assert.deepEqual(botSends.sort(), ["10", "20"]);
assert.deepEqual(adapters.get("ads:10")!.sent.map((item) => item.chatId).sort(), ["-100", "-101"]);
assert.equal(adapters.get("ads:20")!.sent.length, 0);
assert.equal((db.prepare("SELECT status FROM adminBroadcasts WHERE id=?").get(id) as { status: string }).status, "completed");
assert.equal((db.prepare("SELECT COUNT(*) AS n FROM adminBroadcastTargets WHERE broadcastId=? AND status='sent'").get(id) as { n: number }).n, 4);

const allId = createAdminBroadcast(db, source);
assert.deepEqual(startAdminBroadcast(db, allId, 3), { botUsers: 2, groups: 3 });
assert.equal((db.prepare("SELECT COUNT(*) AS n FROM adminBroadcastTargets WHERE broadcastId=? AND kind='userbot' AND chatId='-100'").get(allId) as { n: number }).n, 1);
const campaignId = Number(db.prepare("INSERT INTO campaigns(tenantId,name,senderAccountId,message,status,intervalSeconds,createdAt,updatedAt) VALUES('ads:20','Campaign','account-20','Campaign post','scheduled',3600,?,?)")
  .run(now(), now()).lastInsertRowid);
db.prepare("INSERT INTO campaignTargets(campaignId,tenantId,accountId,chatId,createdAt,updatedAt) VALUES(?,'ads:20','account-20','-102',?,?)")
  .run(campaignId, now(), now());
const campaignAdapter = new FakeTelegramAdapter();
assert.equal(await runSchedulerOnce(db, () => campaignAdapter), 0);
assert.equal(campaignAdapter.sent.length, 0);
setAdminBroadcastStatus(db, allId, "pause");
assert.equal(await runAdminBroadcastOnce(db, async () => { throw new Error("paused jobs must not send"); }), 0);
setAdminBroadcastStatus(db, allId, "resume");
setAdminBroadcastStatus(db, allId, "cancel");
assert.equal((db.prepare("SELECT COUNT(*) AS n FROM adminBroadcastTargets WHERE broadcastId=? AND status='skipped'").get(allId) as { n: number }).n, 5);
await setUserBlocked(db, 20, true);
assert.equal((db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE campaignId=? AND status='skipped'").get(campaignId) as { n: number }).n, 1);
assert.deepEqual(inlineResults(db, 1020, `campaign:${campaignId}`, "ioads_test_bot"), []);
assert.equal(await runSchedulerOnce(db, () => campaignAdapter), 0);
await setUserBlocked(db, 20, false);
db.prepare("UPDATE campaigns SET nextRunAt=NULL WHERE id=?").run(campaignId);
assert.equal(await runSchedulerOnce(db, () => campaignAdapter), 1);
assert.equal(campaignAdapter.sent.length, 1);

const mediaId = createAdminBroadcast(db, { ...source, archiveChatId: "-999", archiveMessageId: 77, message: "Media caption", contentKind: "copy" });
assert.deepEqual(startAdminBroadcast(db, mediaId, 2), { botUsers: 2, groups: 2 });
const copied: Array<[string, string, number]> = [];
const botCopied: Array<[string, string, number]> = [];
const mediaAdapter = new FakeTelegramAdapter();
mediaAdapter.copyMessage = async (chatId, sourceChatId, messageId) => { copied.push([chatId, sourceChatId, messageId]); };
for (let i = 0; i < 5; i += 1) {
  await runAdminBroadcastOnce(db, async (chatId, sourceChatId, messageId) => { botCopied.push([chatId, sourceChatId, messageId]); }, () => mediaAdapter, 8);
  db.prepare("UPDATE accounts SET sendAfter=NULL").run();
}
assert.deepEqual(copied.sort((a, b) => a[0].localeCompare(b[0])), [["-100", "-999", 77], ["-101", "-999", 77]]);
assert.deepEqual(botCopied.sort((a, b) => a[0].localeCompare(b[0])), [["10", "-999", 77], ["20", "-999", 77]]);

const failedId = createAdminBroadcast(db, source);
startAdminBroadcast(db, failedId, 1);
await runAdminBroadcastOnce(db, async () => { throw new Error("network timeout"); }, undefined, 8);
assert.equal((db.prepare("SELECT COUNT(*) AS n FROM adminBroadcastTargets WHERE broadcastId=? AND status='retry'").get(failedId) as { n: number }).n, 2);
setAdminBroadcastStatus(db, failedId, "cancel");
assert.equal((db.prepare("SELECT COUNT(*) AS n FROM adminBroadcastTargets WHERE broadcastId=? AND status='skipped'").get(failedId) as { n: number }).n, 2);

const missingArchive = createAdminBroadcast(db, { ...source, contentKind: "copy" });
assert.throws(() => startAdminBroadcast(db, missingArchive, 3), /archive copy/);
assert.deepEqual(startAdminBroadcast(db, missingArchive, 1), { botUsers: 2, groups: 0 });
setAdminBroadcastStatus(db, missingArchive, "cancel");

config.adminTelegramId = previousAdmin;
db.close();
console.log("admin: grants, blocking, audience snapshot, deduplication, media copy, retry, pause and cancel pass");
