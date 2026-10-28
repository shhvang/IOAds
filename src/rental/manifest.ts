import { CONTRACT_REVISION, CONTRACT_SHA256, type ProductManifest } from "./contract.js";
import { config } from "../config.js";
import { PLAN_LIMITS, PLAN_PRICES } from "../services/plans.js";

const tiers = ([
  { code: "free", label: "Free", blurb: "One account and one campaign, posted through the bot's inline mode." },
  { code: "pro", label: "Pro", blurb: "Five accounts and five campaigns, sent directly from your accounts." },
  { code: "business", label: "Business", blurb: "Fifteen accounts and twenty campaigns for larger schedules." },
] as const).map(({ code, label, blurb }) => ({
  code, label, blurb, priceUsd: PLAN_PRICES[code],
  limits: PLAN_LIMITS[code]!,
  lines: [
    `${PLAN_LIMITS[code]!.accounts} account${PLAN_LIMITS[code]!.accounts === 1 ? "" : "s"}`,
    `${PLAN_LIMITS[code]!.campaigns} campaign${PLAN_LIMITS[code]!.campaigns === 1 ? "" : "s"}`,
    `${PLAN_LIMITS[code]!.dailyMessages.toLocaleString()} messages/day`,
    code === "free" ? "Inline posting" : "Direct posting and custom group messages",
  ],
  listed: true,
}));

export const productManifest = (): ProductManifest => ({
  contract: CONTRACT_REVISION,
  contractSha256: CONTRACT_SHA256,
  productId: "ads",
  label: "IOAds",
  blurb: "Schedule posts to groups your connected Telegram accounts already belong to.",
  singleton: true,
  hubRunnable: false,
  defaultTier: "free",
  tiers,
  provisioning: { fields: [{ key: "botToken", kind: "bot_token", label: "Owner control bot token", hint: "Used only to verify Telegram Mini App initData.", required: true, secret: true }] },
  usageKeys: [
    { key: "accounts", label: "Connected accounts", format: "count" },
    { key: "groups", label: "Enabled groups", format: "count" },
    { key: "dailyMessages", label: "Messages today", format: "count" },
  ],
  entryUrl: config.entryUrl,
  nextSteps: ["Connect a separate Telegram user account", "Refresh the groups that account already belongs to", "Send or forward a post, choose targets, and schedule it"],
});
