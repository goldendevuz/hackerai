import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";

describe("free daily cost limit (standalone, FREE_DAILY_COST_LIMIT_USD)", () => {
  const mockCreateRedisClient = jest.fn();
  const mockGet = jest.fn();
  const mockEval = jest.fn();
  const originalEnv = process.env.FREE_DAILY_COST_LIMIT_USD;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.FREE_DAILY_COST_LIMIT_USD;
    mockGet.mockResolvedValue(null);
    mockEval.mockResolvedValue(1);
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.FREE_DAILY_COST_LIMIT_USD;
    } else {
      process.env.FREE_DAILY_COST_LIMIT_USD = originalEnv;
    }
  });

  const getIsolatedModule = () => {
    let isolatedModule: typeof import("../free-daily-cost");

    jest.isolateModules(() => {
      jest.doMock("../redis", () => ({
        createRedisClient: mockCreateRedisClient,
      }));

      isolatedModule = require("../free-daily-cost");
    });

    return isolatedModule!;
  };

  it("is a no-op (unlimited) when FREE_DAILY_COST_LIMIT_USD is unset, never touching Redis", async () => {
    mockCreateRedisClient.mockReturnValue({ get: mockGet, eval: mockEval });
    const { checkFreeDailyCostLimit } = getIsolatedModule();

    const snapshot = await checkFreeDailyCostLimit("user-123");

    expect(snapshot.dailyRemainingAtStart).toBe(Infinity);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("throws a rate-limit error when the configured daily cap is exhausted", async () => {
    process.env.FREE_DAILY_COST_LIMIT_USD = "0.3";
    mockCreateRedisClient.mockReturnValue({ get: mockGet, eval: mockEval });
    mockGet.mockResolvedValue(3000); // 3000 points == $0.30 already spent today
    const { checkFreeDailyCostLimit } = getIsolatedModule();

    await expect(checkFreeDailyCostLimit("user-123")).rejects.toMatchObject({
      type: "rate_limit",
      surface: "chat",
      cause: expect.stringContaining("today's free cost allowance"),
    });
  });

  it("reports remaining budget under the configured cap, keyed by UTC day", async () => {
    process.env.FREE_DAILY_COST_LIMIT_USD = "0.3";
    mockCreateRedisClient.mockReturnValue({ get: mockGet, eval: mockEval });
    mockGet.mockResolvedValue(1000); // $0.10 already spent today
    const { checkFreeDailyCostLimit } = getIsolatedModule();

    const snapshot = await checkFreeDailyCostLimit("user-123");

    expect(mockGet).toHaveBeenCalledWith(
      expect.stringMatching(/^free_daily_cost:user-123:\d{4}-\d{2}-\d{2}$/),
    );
    expect(snapshot.dailyLimitPoints).toBe(3000);
    expect(snapshot.dailyRemainingAtStart).toBe(2000);
  });

  it("records cost as daily points only when the cap is configured", async () => {
    mockCreateRedisClient.mockReturnValue({ get: mockGet, eval: mockEval });
    const { recordFreeDailyCost } = getIsolatedModule();

    await recordFreeDailyCost("user-123", 0.05);
    expect(mockEval).not.toHaveBeenCalled();

    process.env.FREE_DAILY_COST_LIMIT_USD = "0.3";
    await recordFreeDailyCost("user-123", 0.05);
    expect(mockEval).toHaveBeenCalledWith(
      expect.any(String),
      [expect.stringMatching(/^free_daily_cost:user-123:\d{4}-\d{2}-\d{2}$/)],
      [500, expect.any(Number)],
    );
  });

  it("skips checks outside production when Redis is unavailable", async () => {
    process.env.FREE_DAILY_COST_LIMIT_USD = "0.3";
    mockCreateRedisClient.mockReturnValue(null);
    const { checkFreeDailyCostLimit, recordFreeDailyCost } =
      getIsolatedModule();

    const snapshot = await checkFreeDailyCostLimit("user-123");

    expect(snapshot.rateLimitSkipped).toBe(true);
    await expect(
      recordFreeDailyCost("user-123", 0.01),
    ).resolves.toBeUndefined();
  });
});
