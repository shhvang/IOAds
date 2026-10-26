import assert from "node:assert/strict";
import { openDb, now } from "./db.js";
import { config } from "./config.js";
import { FakeTelegramAdapter } from "./telegram.js";
import { addTarget as addCampaignTarget, createCampaign, setCampaignStatus } from "./services/campaigns.js";
import { runSchedulerOnce } from "./services/scheduler.js";

config.deliveryConcurrency = 16;
const db = openDb(":memory:");
const time = now();
db.prepare("INSERT INTO tenants (tenantId,productId,ownerId,state,tierCode,runtime,version,trial,limits,config,updatedAt,appliedAt) VALUES ('large','ads',1,'active','business','service',1,0,?,'{}',?,?)")
  .run(JSON.stringify({ accounts: 10, groups: 1000, campaigns: 100, targets: 1000, dailyMessages: 10000 }), time, time);
db.prepare("INSERT INTO accounts (accountId,tenantId,ownerId,telegramUserId,session,status,createdAt,updatedAt) VALUES ('sender','large',1,2,'fake','active',?,?)")
  .run(time, time);
const created = createCampaign(db, "large", { name: "many groups", message: "hello", senderAccountId: "sender", intervalSeconds: 300 }) as { id: number };
const addGroup = db.prepare("INSERT INTO groups (tenantId,accountId,chatId,title,enabled,chatKind,createdAt,updatedAt) VALUES ('large','sender',?,?,1,'group',?,?)");
const addTarget = db.prepare("INSERT INTO campaignTargets (campaignId,tenantId,accountId,chatId,createdAt,updatedAt) VALUES (?,'large','sender',?,?,?)");
for (let i = 0; i < 35; i += 1) {
  const chatId = `-${1000 + i}`;
  addGroup.run(chatId, `Group ${i}`, time, time);
  addTarget.run(created.id, chatId, time, time);
}
setCampaignStatus(db, "large", created.id, "scheduled");
const adapter = new FakeTelegramAdapter();
for (let i = 0; i < 35; i += 1) await runSchedulerOnce(db, () => adapter);
assert.equal(adapter.sent.length, 35);
assert.equal(new Set(adapter.sent.map((item) => item.chatId)).size, 35);
assert.equal((db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status='sent'").get() as { n: number }).n, 35);
db.prepare("UPDATE campaigns SET accountCooldownSeconds=3600,nextRunAt='2000-01-01T00:00:00.000Z' WHERE id=?").run(created.id);
assert.equal(await runSchedulerOnce(db, () => adapter), 1);
assert.equal(await runSchedulerOnce(db, () => adapter), 0);
assert.equal((db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE campaignId=? AND status='pending'").get(created.id) as { n: number }).n, 34);

db.prepare("INSERT INTO accounts (accountId,tenantId,ownerId,telegramUserId,session,status,createdAt,updatedAt) VALUES ('flaky','large',1,3,'fake','active',?,?)")
  .run(time, time);
db.prepare("INSERT INTO groups (tenantId,accountId,chatId,title,enabled,chatKind,createdAt,updatedAt) VALUES ('large','flaky','-999','Flaky',1,'group',?,?)").run(time, time);
const retryCampaign = createCampaign(db, "large", { name: "retry", message: "retry me", senderAccountId: "flaky", intervalSeconds: 300 }) as { id: number };
db.prepare("INSERT INTO campaignTargets (campaignId,tenantId,accountId,chatId,createdAt,updatedAt) VALUES (?,'large','flaky','-999',?,?)")
  .run(retryCampaign.id, time, time);
setCampaignStatus(db, "large", retryCampaign.id, "scheduled");
let failures = 1;
const flaky = new FakeTelegramAdapter();
flaky.sendMessage = async (chatId, message) => {
  if (failures--) throw new Error("network connection lost");
  flaky.sent.push({ chatId, message });
};
await runSchedulerOnce(db, (_tenant, accountId) => accountId === "flaky" ? flaky : adapter);
assert.equal((db.prepare("SELECT status FROM deliveries WHERE campaignId=?").get(retryCampaign.id) as { status: string }).status, "retry");
db.prepare("UPDATE deliveries SET nextAttemptAt='2000-01-01T00:00:00.000Z' WHERE campaignId=?").run(retryCampaign.id);
await runSchedulerOnce(db, (_tenant, accountId) => accountId === "flaky" ? flaky : adapter);
assert.equal((db.prepare("SELECT status FROM deliveries WHERE campaignId=?").get(retryCampaign.id) as { status: string }).status, "sent");

// One campaign can deliver the same group through two accounts, while each account keeps its own selection.
db.prepare("UPDATE campaigns SET status='paused' WHERE id=?").run(created.id);
db.prepare("INSERT INTO groups (tenantId,accountId,chatId,title,enabled,chatKind,createdAt,updatedAt) VALUES ('large','sender','-999','Shared',1,'group',?,?)").run(time, time);
const shared = createCampaign(db, "large", { name: "per account", message: "same campaign", senderAccountId: "sender", intervalSeconds: 300 }) as { id: number };
db.prepare("UPDATE accounts SET sendAfter=NULL WHERE tenantId='large' AND accountId='sender'").run();
await addCampaignTarget(db, "large", shared.id, "-999", "sender");
await addCampaignTarget(db, "large", shared.id, "-999", "flaky");
await addCampaignTarget(db, "large", shared.id, "-1000", "sender");
setCampaignStatus(db, "large", shared.id, "scheduled");
const primaryAdapter = new FakeTelegramAdapter();
const secondaryAdapter = new FakeTelegramAdapter();
for (let i = 0; i < 3; i += 1) await runSchedulerOnce(db, (_tenant, accountId) => accountId === "sender" ? primaryAdapter : secondaryAdapter);
assert.deepEqual(primaryAdapter.sent.map((item) => item.chatId).sort(), ["-1000", "-999"]);
assert.deepEqual(secondaryAdapter.sent.map((item) => item.chatId), ["-999"]);
assert.equal((db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE campaignId=? AND status='sent'").get(shared.id) as { n: number }).n, 3);
db.prepare("UPDATE campaigns SET contentKind='media',sourceChatId=NULL,sourceMessageId=NULL,inlineMode=0,nextRunAt='2000-01-01T00:00:00.000Z' WHERE id=?").run(shared.id);
assert.equal(await runSchedulerOnce(db, (_tenant, accountId) => accountId === "sender" ? primaryAdapter : secondaryAdapter), 0);
assert.equal(await runSchedulerOnce(db, (_tenant, accountId) => accountId === "sender" ? primaryAdapter : secondaryAdapter), 0);
assert.equal(primaryAdapter.sent.length, 2);
assert.equal(secondaryAdapter.sent.length, 1);
assert.equal((db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE campaignId=? AND status='failed'").get(shared.id) as { n: number }).n, 3);
db.close();
console.log("scheduler: complete fanout, cooldown, and retry pass");
