export const FREE_MONTHLY_COST_LIMIT_USD_DEFAULT = 0.25;
export const FREE_RUN_LOCK_TTL_SECONDS = 15 * 60;
export const FREE_MAX_CONTEXT_TOKENS = 128000;
export const FREE_RATE_LIMIT_REQUESTS_DEFAULT = 10;
export const FREE_ASK_REQUEST_COST = 1;
export const FREE_AGENT_REQUEST_COST = 1;

export type FreeLimitPolicy = {
  dailyRequests: number;
  monthlyCostDollars: number;
  /** Server-selected, frozen for the entire Agent run, including durable waits. */
  agentDailyBudget?: { bucket: string; resetTimestamp: number };
};

export const getFreeRequestLimit = (policy?: FreeLimitPolicy): number => {
  const configuredLimit = parseInt(
    process.env.FREE_RATE_LIMIT_REQUESTS || "",
    10,
  );
  const normal =
    Number.isFinite(configuredLimit) && configuredLimit > 0
      ? configuredLimit
      : FREE_RATE_LIMIT_REQUESTS_DEFAULT;
  return policy &&
    Number.isFinite(policy.dailyRequests) &&
    policy.dailyRequests >= 1
    ? Math.min(normal, Math.floor(policy.dailyRequests))
    : normal;
};

// Solider.uz change: optional standalone daily spend cap for a free-tier
// quota subject, independent of the PostHog-gated agentDailyBudget
// experiment above (which requires POSTHOG_PROJECT_TOKEN to ever assign a
// user and does nothing on a self-hosted fork without PostHog configured).
// Unset/zero means no daily cap -- only the monthly cap applies.
export const getFreeDailyCostLimitDollars = (): number => {
  const configuredLimit = Number(process.env.FREE_DAILY_COST_LIMIT_USD);
  return Number.isFinite(configuredLimit) && configuredLimit > 0
    ? configuredLimit
    : 0;
};

export const getFreeMonthlyCostLimitDollars = (
  policy?: FreeLimitPolicy,
): number => {
  const configuredLimit = Number(process.env.FREE_MONTHLY_COST_LIMIT_USD);
  const normal =
    Number.isFinite(configuredLimit) && configuredLimit > 0
      ? configuredLimit
      : FREE_MONTHLY_COST_LIMIT_USD_DEFAULT;
  return policy &&
    Number.isFinite(policy.monthlyCostDollars) &&
    policy.monthlyCostDollars > 0
    ? Math.min(normal, policy.monthlyCostDollars)
    : normal;
};
