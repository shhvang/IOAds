import assert from "node:assert/strict";
import { openDb, now } from "./db.js";
import { config } from "./config.js";
import { FakeTelegramAdapter } from "./telegram.js";
import { addTarget as addCampaignTarget, createCampaign, saveCampaignPost, setCampaignStatus } from "./services/campaigns.js";
import { runSchedulerOnce } from "./services/scheduler.js";
import { tierLimits } from "./services/plans.js";
import { enforceTenantLimits } from "./services/limits.js";
import { inlineResults } from "./inline.js";

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
// Standalone posting follows the current plan even when a saved campaign has an older mode.
const planDb = openDb(":memory:");
const previousBotUsername = config.botUsername;
config.botUsername = "ioads_test_bot";
planDb.prepare("INSERT INTO tenants (tenantId,productId,ownerId,state,tierCode,runtime,version,trial,limits,config,updatedAt,appliedAt) VALUES ('ads:42','ads-standalone',42,'active','free','service',1,0,?,'{}',?,?)")
  .run(JSON.stringify(tierLimits("free")), time, time);
planDb.prepare("INSERT INTO localUsers (telegramId,tenantId,tierCode,forceJoined,createdAt,updatedAt) VALUES (42,'ads:42','free',1,?,?)").run(time, time);
planDb.prepare("INSERT INTO accounts (accountId,tenantId,ownerId,telegramUserId,session,status,createdAt,updatedAt) VALUES ('plan-sender','ads:42',42,43,'fake','active',?,?)").run(time, time);
planDb.prepare("INSERT INTO groups (tenantId,accountId,chatId,title,enabled,chatKind,createdAt,updatedAt) VALUES ('ads:42','plan-sender','-4242','Plan group',1,'group',?,?)").run(time, time);
const planCampaign = createCampaign(planDb, "ads:42", { name: "Plan mode", message: "The post", senderAccountId: "plan-sender", intervalSeconds: 300 }) as { id: number };
await addCampaignTarget(planDb, "ads:42", planCampaign.id, "-4242");
setCampaignStatus(planDb, "ads:42", planCampaign.id, "scheduled");
const planAdapter = new FakeTelegramAdapter();
assert.equal(await runSchedulerOnce(planDb, () => planAdapter), 1);
assert.deepEqual(planAdapter.inlineSent, [{ chatId: "-4242", query: `campaign:${planCampaign.id}` }]);
planDb.prepare("UPDATE tenants SET tierCode='pro',limits=? WHERE tenantId='ads:42'").run(JSON.stringify(tierLimits("pro")));
planDb.prepare("UPDATE localUsers SET tierCode='pro' WHERE tenantId='ads:42'").run();
planDb.prepare("UPDATE campaigns SET inlineMode=1,nextRunAt='2000-01-01T00:00:00.000Z' WHERE id=?").run(planCampaign.id);
assert.equal(await runSchedulerOnce(planDb, () => planAdapter), 1);
assert.deepEqual(planAdapter.sent, [{ chatId: "-4242", message: "The post" }]);
assert.equal(planAdapter.inlineSent.length, 1);
saveCampaignPost(planDb, "ads:42", {
  name: "Updated post", message: "Updated post", messageEntities: "[]", sourceChatId: null, sourceMessageId: null,
  richMessage: null, richContent: null, inlineOptions: "{}", contentKind: "text", inlineMode: 0,
}, "plan-sender", planCampaign.id);
planDb.prepare("UPDATE campaigns SET nextRunAt='2000-01-02T00:00:00.000Z' WHERE id=?").run(planCampaign.id);
assert.equal(await runSchedulerOnce(planDb, () => planAdapter), 1);
assert.equal(planAdapter.sent.at(-1)?.message, "Updated post");
planDb.prepare("UPDATE tenants SET tierCode='free',limits=? WHERE tenantId='ads:42'").run(JSON.stringify(tierLimits("free")));
planDb.prepare("UPDATE localUsers SET tierCode='free' WHERE tenantId='ads:42'").run();
planDb.prepare("UPDATE campaigns SET inlineMode=0,nextRunAt='2000-01-03T00:00:00.000Z' WHERE id=?").run(planCampaign.id);
assert.equal(await runSchedulerOnce(planDb, () => planAdapter), 1);
assert.equal(planAdapter.inlineSent.length, 2);
planDb.prepare("UPDATE tenants SET tierCode='pro',limits=? WHERE tenantId='ads:42'").run(JSON.stringify(tierLimits("pro")));
planDb.prepare("UPDATE localUsers SET tierCode='pro' WHERE tenantId='ads:42'").run();
planDb.prepare("UPDATE campaigns SET contentKind='rich',richContent='{}',sourceChatId=NULL,sourceMessageId=NULL,status='scheduled' WHERE id=?").run(planCampaign.id);
enforceTenantLimits(planDb, "ads:42");
assert.equal((planDb.prepare("SELECT status FROM campaigns WHERE id=?").get(planCampaign.id) as { status: string }).status, "paused");
assert.throws(() => setCampaignStatus(planDb, "ads:42", planCampaign.id, "scheduled"), /archive copy/);
const rentalDb = openDb(":memory:");
rentalDb.prepare("INSERT INTO tenants (tenantId,productId,ownerId,state,tierCode,runtime,version,trial,limits,config,updatedAt,appliedAt) VALUES ('rental-free','ads',80,'active','free','service',1,0,?,'{}',?,?)")
  .run(JSON.stringify(tierLimits("free")), time, time);
rentalDb.prepare("INSERT INTO accounts (accountId,tenantId,ownerId,telegramUserId,session,status,createdAt,updatedAt) VALUES ('rental-sender','rental-free',80,81,'fake','active',?,?)").run(time, time);
rentalDb.prepare("INSERT INTO groups (tenantId,accountId,chatId,title,enabled,chatKind,createdAt,updatedAt) VALUES ('rental-free','rental-sender','-8080','Rental group',1,'group',?,?)").run(time, time);
const rentalCampaign = createCampaign(rentalDb, "rental-free", { name: "Rental Free", message: "A rented post", senderAccountId: "rental-sender", intervalSeconds: 300 }) as { id: number };
await addCampaignTarget(rentalDb, "rental-free", rentalCampaign.id, "-8080");
setCampaignStatus(rentalDb, "rental-free", rentalCampaign.id, "scheduled");
assert.equal(inlineResults(rentalDb, 81, `campaign:${rentalCampaign.id}`, config.botUsername).length, 1);
const rentalAdapter = new FakeTelegramAdapter();
assert.equal(await runSchedulerOnce(rentalDb, () => rentalAdapter), 1);
assert.deepEqual(rentalAdapter.inlineSent, [{ chatId: "-8080", query: `campaign:${rentalCampaign.id}` }]);
assert.equal(rentalAdapter.sent.length, 0);
rentalDb.close();
config.botUsername = previousBotUsername;
planDb.close();
console.log("scheduler: complete fanout, cooldown, and retry pass");
