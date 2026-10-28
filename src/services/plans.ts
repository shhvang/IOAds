export const PLAN_RANKS: Record<string, number> = { free: 0, starter: 0, pro: 1, business: 2 };
export const PLAN_PRICES: Record<"free" | "pro" | "business", number> = { free: 0, pro: 1, business: 3 };
export const tierRank = (tier: string): number => PLAN_RANKS[tier] ?? 0;
export const standaloneInlineMode = (tier: string): boolean => tierRank(tier) === 0;

export function standalonePostingIssue(tier: string, post: {
  message: string; contentKind: string; richContent: string | null; richMessage: string | null;
  sourceChatId: string | null; sourceMessageId: number | null; inlineOptions: string | null;
}, botUsername: string): string | null {
  let options: { has_media_spoiler?: boolean; reply_markup?: unknown; link_preview_options?: unknown };
  try { options = post.inlineOptions ? JSON.parse(post.inlineOptions) : {}; }
  catch { return "The saved post options are invalid. Edit the campaign post."; }
  if (standaloneInlineMode(tier)) {
    if (!botUsername) return "Free campaigns need ADS_BOT_USERNAME for inline posting.";
    if (options.has_media_spoiler || (post.contentKind === "legacy" && post.message === "[Telegram media or rich message]") ||
      (post.contentKind !== "text" && post.contentKind !== "legacy" && !post.richContent && !post.richMessage))
      return "This post cannot be sent inline on Free. Edit it to use supported content.";
  } else if (!(post.sourceChatId && post.sourceMessageId) &&
    (post.contentKind !== "text" && post.contentKind !== "legacy" || post.message === "[Telegram media or rich message]" || options.has_media_spoiler || options.reply_markup || options.link_preview_options)) {
    return "Direct posting needs an archive copy of this post. Configure ADS_ARCHIVE_CHAT, then edit the campaign post.";
  }
  return null;
}

export const PLAN_LIMITS: Record<string, Record<string, number>> = {
  free: { accounts: 1, groups: 1_000_000, campaigns: 1, targets: 1_000_000, dailyMessages: 2000 },
  starter: { accounts: 1, groups: 1_000_000, campaigns: 1, targets: 1_000_000, dailyMessages: 2000 },
  pro: { accounts: 5, groups: 1_000_000, campaigns: 5, targets: 1_000_000, dailyMessages: 5000 },
  business: { accounts: 15, groups: 1_000_000, campaigns: 20, targets: 1_000_000, dailyMessages: 15000 },
};

export const planLimits = (tier: string): Record<string, number> => ({ ...(PLAN_LIMITS[tier] ?? PLAN_LIMITS.starter) });
export const isTier = (tier: string): boolean => Object.hasOwn(PLAN_LIMITS, tier);
export const tierLimits = planLimits;
