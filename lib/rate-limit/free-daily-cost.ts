import { ChatSDKError } from "@/lib/errors";
import { getFreeDailyCostLimitDollars } from "./free-config";
import { POINTS_PER_DOLLAR } from "./token-bucket";
import { createRedisClient } from "./redis";
import { getLimitPressureContext } from "@/lib/limit-pressure";

// Reuses the same atomic INCRBY-with-TTL-on-first-write pattern as
// free-monthly-cost.ts, keyed per UTC day instead of per UTC month.
const RECORD_FREE_DAILY_COST_SCRIPT = `
local key = KEYS[1]
local points = tonumber(ARGV[1])
local ttlMs = tonumber(ARGV[2])

if points <= 0 then
  return tonumber(redis.call("GET", key) or "0")
end

local nextUsed = redis.call("INCRBY", key, points)
if nextUsed == points then
  redis.call("PEXPIRE", key, ttlMs)
end

return nextUsed
`;

export interface FreeDailyCostSnapshot {
  dailyLimitPoints: number;
  dailyRemainingAtStart: number;
  dailyResetTime: Date;
  rateLimitSkipped?: boolean;
}

const dollarsToPoints = (dollars: number): number => {
  if (!Number.isFinite(dollars) || dollars <= 0) return 0;
  return Math.ceil(dollars * POINTS_PER_DOLLAR);
};

const getCurrentUtcDayWindow = () => {
  const now = new Date();
  const bucket = now.toISOString().slice(0, 10);
  const reset = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return { bucket, reset, ttlMs: Math.max(1, reset - now.getTime()) };
};

const freeDailyCostKey = (userId: string, bucket: string) =>
  `free_daily_cost:${userId}:${bucket}`;

const getLimitMessage = (reset: number) =>
  `You've used today's free cost allowance. It resets at midnight UTC (${new Date(
    reset,
  ).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  })}). Upgrade for higher limits and more features.`;

/**
 * Optional standalone daily spend cap. No-ops (returns an always-available
 * snapshot) when FREE_DAILY_COST_LIMIT_USD is unset, so this never changes
 * behavior for a deployment that hasn't opted in.
 */
export async function checkFreeDailyCostLimit(
  quotaSubject: string,
): Promise<FreeDailyCostSnapshot> {
  const limitDollars = getFreeDailyCostLimitDollars();
  const { bucket, reset } = getCurrentUtcDayWindow();
  if (limitDollars <= 0) {
    return {
      dailyLimitPoints: 0,
      dailyRemainingAtStart: Infinity,
      dailyResetTime: new Date(reset),
    };
  }
  const limitPoints = dollarsToPoints(limitDollars);
  const redis = createRedisClient();

  if (!redis) {
    if (process.env.NODE_ENV !== "production") {
      return {
        dailyLimitPoints: limitPoints,
        dailyRemainingAtStart: limitPoints,
        dailyResetTime: new Date(reset),
        rateLimitSkipped: true,
      };
    }
    throw new ChatSDKError(
      "rate_limit:chat",
      "Rate limiting service is not configured",
    );
  }

  const usedPoints = Math.max(
    0,
    Number((await redis.get(freeDailyCostKey(quotaSubject, bucket))) ?? 0),
  );
  const remainingPoints = Math.max(0, limitPoints - usedPoints);

  if (remainingPoints <= 0) {
    throw new ChatSDKError("rate_limit:chat", getLimitMessage(reset), {
      resetTimestamp: reset,
      subscription: "free",
      capReason: "free_daily_cost_exhausted",
      ...getLimitPressureContext({
        subscription: "free",
        capReason: "free_daily_cost_exhausted",
      }),
    });
  }

  return {
    dailyLimitPoints: limitPoints,
    dailyRemainingAtStart: remainingPoints,
    dailyResetTime: new Date(reset),
  };
}

export async function recordFreeDailyCost(
  userId: string,
  costDollars: number,
): Promise<void> {
  if (getFreeDailyCostLimitDollars() <= 0) return;
  const costPoints = dollarsToPoints(costDollars);
  if (costPoints <= 0) return;

  const redis = createRedisClient();
  if (!redis) {
    if (process.env.NODE_ENV !== "production") return;
    throw new ChatSDKError(
      "rate_limit:chat",
      "Rate limiting service is not configured",
    );
  }

  const { bucket, ttlMs } = getCurrentUtcDayWindow();
  await redis.eval(
    RECORD_FREE_DAILY_COST_SCRIPT,
    [freeDailyCostKey(userId, bucket)],
    [costPoints, ttlMs],
  );
}
