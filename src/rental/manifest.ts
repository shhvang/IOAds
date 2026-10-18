import { CONTRACT_REVISION, CONTRACT_SHA256, type ProductManifest } from "./contract.js";
import { config } from "../config.js";

export const productManifest = (): ProductManifest => ({
  contract: CONTRACT_REVISION,
  contractSha256: CONTRACT_SHA256,
  productId: "ads",
  label: "IOAds",
  blurb: "Schedule messages to Telegram groups you already manage.",
  singleton: true,
  hubRunnable: false,
  defaultTier: "starter",
  tiers: [
    { code: "starter", label: "Starter", blurb: "Scheduled group campaigns.", limits: { accounts: 1, groups: 10, campaigns: 3, targets: 10, dailyMessages: 100 }, lines: ["1 account", "10 groups", "3 campaigns", "100 messages/day", "Standard messages"], listed: true },
    { code: "pro", label: "Pro", blurb: "Custom group copy and larger limits.", limits: { accounts: 3, groups: 100, campaigns: 20, targets: 100, dailyMessages: 1000 }, lines: ["3 accounts", "100 groups", "20 campaigns", "1,000 messages/day", "Custom group messages"], listed: true },
    { code: "business", label: "Business", blurb: "High-volume group campaigns.", limits: { accounts: 10, groups: 500, campaigns: 100, targets: 500, dailyMessages: 5000 }, lines: ["10 accounts", "500 groups", "100 campaigns", "5,000 messages/day", "Custom group messages"], listed: true },
  ],
  provisioning: { fields: [{ key: "botToken", kind: "bot_token", label: "Owner control bot token", hint: "Used only to verify Telegram Mini App initData.", required: true, secret: true }] },
  usageKeys: [
    { key: "accounts", label: "Connected accounts", format: "count" },
    { key: "groups", label: "Enabled groups", format: "count" },
    { key: "dailyMessages", label: "Messages today", format: "count" },
  ],
  entryUrl: config.entryUrl,
  nextSteps: ["Log in with a Telegram user account", "Sync groups already visible to that account", "Create and schedule a campaign"],
});
