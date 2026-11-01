import {
  checkFreeCostBudget,
  FreeDailyCostSettlement,
  isDailyCostCapExhaustedError,
} from "../free-cost-budget";
import {
  checkFreeMonthlyCostLimit,
  recordFreeMonthlyCost,
} from "../free-monthly-cost";
import { checkFreeDailyCostLimit } from "../free-daily-cost";
import { createRedisClient } from "../redis";
import type { FreeLimitPolicy } from "../free-config";
import { isHandledUserRateLimitError } from "../error-classification";
import { ChatSDKError } from "@/lib/errors";

jest.mock("../redis");
jest.mock("../free-monthly-cost");
jest.mock("../free-daily-cost");
const get = jest.fn();
const evalCost = jest.fn();
const policy: FreeLimitPolicy = {
  dailyRequests: 3,
  monthlyCostDollars: 0.1,
  agentDailyBudget: {
    bucket: "2026-10-01",
    resetTimestamp: Date.parse("2026-10-02T00:00:00Z"),
  },
};

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date("2026-10-01T23:59:00Z"));
  jest.clearAllMocks();
  jest
    .mocked(createRedisClient)
    .mockReturnValue({ get, eval: evalCost } as unknown as NonNullable<
      ReturnType<typeof createRedisClient>
    >);
  get.mockResolvedValue(700);
  evalCost.mockResolvedValue(900);
});
afterEach(() => jest.useRealTimers());

describe("isDailyCostCapExhaustedError", () => {
  it("is true only for the free_daily_cost_exhausted ChatSDKError, not other cap reasons", () => {
    const daily = new ChatSDKError("rate_limit:chat", "daily cap", {
      capReason: "free_daily_cost_exhausted",
    });
    const monthly = new ChatSDKError("rate_limit:chat", "monthly cap", {
      capReason: "free_monthly_exhausted",
    });
    expect(isDailyCostCapExhaustedError(daily)).toBe(true);
    expect(isDailyCostCapExhaustedError(monthly)).toBe(false);
    expect(isDailyCostCapExhaustedError(new Error("plain"))).toBe(false);
    expect(isDailyCostCapExhaustedError(null)).toBe(false);
  });
});

it("control preserves the regional monthly budget and existing ledger", async () => {
  const regional = { dailyRequests: 3, monthlyCostDollars: 0.1 };
  await checkFreeCostBudget("quota", regional);
  expect(checkFreeMonthlyCostLimit).toHaveBeenCalledWith("quota", regional);
  expect(get).not.toHaveBeenCalled();
  // No FREE_DAILY_COST_LIMIT_USD configured: the standalone daily cap must
  // never be consulted, so it can't change behavior for a deployment that
  // hasn't opted in.
  expect(checkFreeDailyCostLimit).not.toHaveBeenCalled();
});

it("never reports the standalone daily cap's remaining budget to the caller, even when it is tighter than the monthly cap", async () => {
  // Regression: an earlier version merged the daily cap's remaining budget
  // into the returned snapshot whenever it was tighter. That snapshot flows
  // straight into BudgetMonitor's mid-stream projection, which has no
  // "downgrade to free" path -- it only hard-aborts. That made the daily
  // cap interrupt an already-started run instead of only gating new ones.
  const originalEnv = process.env.FREE_DAILY_COST_LIMIT_USD;
  process.env.FREE_DAILY_COST_LIMIT_USD = "0.3";
  try {
    const monthlySnapshot = {
      monthlyLimitPoints: 2500,
      monthlyRemainingAtStart: 2000,
      monthlyResetTime: new Date("2026-11-01T00:00:00Z"),
      extraUsageEnabledAtStart: false as const,
      extraUsageHasBalanceAtStart: false as const,
      extraUsageBalanceAtStart: 0 as const,
      extraUsageAutoReload: false as const,
    };
    jest.mocked(checkFreeMonthlyCostLimit).mockResolvedValue(monthlySnapshot);
    jest.mocked(checkFreeDailyCostLimit).mockResolvedValue({
      dailyLimitPoints: 3000,
      dailyRemainingAtStart: 500,
      dailyResetTime: new Date("2026-10-02T00:00:00Z"),
    });

    const snapshot = await checkFreeCostBudget("quota", {
      dailyRequests: 3,
      monthlyCostDollars: 0.25,
    });

    expect(snapshot).toEqual(monthlySnapshot);
    expect(checkFreeDailyCostLimit).toHaveBeenCalledWith("quota");
  } finally {
    if (originalEnv === undefined) delete process.env.FREE_DAILY_COST_LIMIT_USD;
    else process.env.FREE_DAILY_COST_LIMIT_USD = originalEnv;
  }
});

it("propagates (as a catchable error, not a tightened snapshot) when the daily cap is already exhausted", async () => {
  const originalEnv = process.env.FREE_DAILY_COST_LIMIT_USD;
  process.env.FREE_DAILY_COST_LIMIT_USD = "0.3";
  try {
    const dailyError = new ChatSDKError("rate_limit:chat", "daily cap", {
      capReason: "free_daily_cost_exhausted",
    });
    jest.mocked(checkFreeDailyCostLimit).mockRejectedValue(dailyError);

    const error = await checkFreeCostBudget("quota", {
      dailyRequests: 3,
      monthlyCostDollars: 0.25,
    }).catch((e) => e);

    expect(isDailyCostCapExhaustedError(error)).toBe(true);
    expect(checkFreeMonthlyCostLimit).not.toHaveBeenCalled();
  } finally {
    if (originalEnv === undefined) delete process.env.FREE_DAILY_COST_LIMIT_USD;
    else process.env.FREE_DAILY_COST_LIMIT_USD = originalEnv;
  }
});
it("treatment reads shared daily cost with no monthly admission gate", async () => {
  const snapshot = await checkFreeCostBudget("quota", policy);
  expect(get).toHaveBeenCalledWith("free_agent_daily_cost:quota:2026-10-01");
  expect(checkFreeMonthlyCostLimit).not.toHaveBeenCalled();
  expect(snapshot).toMatchObject({
    monthlyLimitPoints: 1000,
    monthlyRemainingAtStart: 300,
    budgetPeriod: "daily",
    capReasonOnExhaustion: "free_daily_cost_exhausted",
  });
  expect(snapshot.monthlyResetTime.toISOString()).toBe(
    "2026-10-02T00:00:00.000Z",
  );
});
it("denies an exhausted daily allowance with a distinct cap and next-day reset", async () => {
  get.mockResolvedValue(1010);
  const error = await checkFreeCostBudget("quota", policy).catch(
    (error) => error,
  );
  expect(error).toMatchObject({
    metadata: expect.objectContaining({
      capReason: "free_daily_cost_exhausted",
    }),
  });
  expect(isHandledUserRateLimitError(error)).toBe(true);
});
it("settles cumulative actual cost into the original day and monthly shadow ledger", async () => {
  jest.setSystemTime(new Date("2026-10-02T00:01:00Z"));
  evalCost.mockResolvedValueOnce(201).mockResolvedValueOnce(500);
  const settlement = new FreeDailyCostSettlement("quota", policy, "attempt");
  await settlement.settle(0.02001);
  await settlement.settle(0.01);
  await settlement.settle(0.05);
  expect(evalCost).toHaveBeenCalledTimes(2);
  expect(evalCost).toHaveBeenNthCalledWith(
    1,
    expect.any(String),
    [
      "free_agent_daily_cost:quota:2026-10-01",
      "free_monthly_cost:quota:2026-10",
      "free_agent_daily_settlement:quota:attempt",
    ],
    [
      201,
      policy.agentDailyBudget!.resetTimestamp + 7 * 86400000,
      Date.parse("2026-11-01T00:00:00Z"),
    ],
  );
  expect(settlement.settledPoints).toBe(500);
});
it("does not allow a durable approval to reopen yesterday's quota", async () => {
  jest.setSystemTime(new Date("2026-10-02T00:01:00Z"));
  const error = await checkFreeCostBudget("quota", policy).catch(
    (error) => error,
  );
  expect(error).toMatchObject({
    cause: expect.stringContaining("daily allowance window has ended"),
  });
  expect(isHandledUserRateLimitError(error)).toBe(true);
  expect(get).not.toHaveBeenCalled();
});
it("fails closed on invalid ledger data", async () => {
  get.mockResolvedValue("bad");
  const error = await checkFreeCostBudget("quota", policy).catch(
    (error) => error,
  );
  expect(error).toMatchObject({
    cause: "Rate limiting service returned invalid usage",
  });
  expect(isHandledUserRateLimitError(error)).toBe(false);
});
it("retries cumulative settlement after a lost response without advancing local state", async () => {
  evalCost
    .mockRejectedValueOnce(new Error("redis unavailable"))
    .mockResolvedValueOnce(200);
  const settlement = new FreeDailyCostSettlement("quota", policy, "attempt");
  await expect(settlement.settle(0.02)).rejects.toThrow("redis unavailable");
  expect(settlement.settledPoints).toBe(0);
  await settlement.settle(0.02);
  expect(evalCost.mock.calls[0]).toEqual(evalCost.mock.calls[1]);
  expect(settlement.settledPoints).toBe(200);
});
