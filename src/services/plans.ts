export const PLAN_RANKS: Record<string, number> = { free: 0, starter: 0, pro: 1, business: 2 };
export const tierRank = (tier: string): number => PLAN_RANKS[tier] ?? 0;

export const PLAN_LIMITS: Record<string, Record<string, number>> = {
  free: { accounts: 1, groups: 1_000_000, campaigns: 1, targets: 1_000_000, dailyMessages: 500 },
  starter: { accounts: 1, groups: 1_000_000, campaigns: 1, targets: 1_000_000, dailyMessages: 500 },
  pro: { accounts: 5, groups: 1_000_000, campaigns: 1_000_000, targets: 1_000_000, dailyMessages: 2000 },
  business: { accounts: 15, groups: 1_000_000, campaigns: 1_000_000, targets: 1_000_000, dailyMessages: 10000 },
};

export const planLimits = (tier: string): Record<string, number> => ({ ...(PLAN_LIMITS[tier] ?? PLAN_LIMITS.starter) });
export const isTier = (tier: string): boolean => Object.hasOwn(PLAN_LIMITS, tier);
export const tierLimits = planLimits;
