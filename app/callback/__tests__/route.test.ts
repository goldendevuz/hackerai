import { describe, expect, it, jest } from "@jest/globals";

const mockHandleAuth = jest.fn(() => jest.fn());

jest.mock("@workos-inc/authkit-nextjs", () => ({
  handleAuth: mockHandleAuth,
}));
jest.mock("next/server", () => ({
  NextResponse: {
    redirect: jest.fn(),
  },
}));
jest.mock("next/headers", () => ({
  cookies: jest.fn(),
}));

describe("AuthKit callback", () => {
  it("does not enqueue a duplicate signup attribution event", async () => {
    await import("../route");

    expect(mockHandleAuth).toHaveBeenCalledTimes(1);
    expect(mockHandleAuth.mock.calls[0]?.[0]).toEqual({
      onError: expect.any(Function),
    });
  });

  it("passes the public base URL so login does not redirect to the container's 0.0.0.0 origin", async () => {
    process.env.NEXT_PUBLIC_BASE_URL = "https://solider.uz";
    mockHandleAuth.mockClear();
    await jest.isolateModulesAsync(async () => {
      await import("../route");
    });
    delete process.env.NEXT_PUBLIC_BASE_URL;

    expect(mockHandleAuth.mock.calls[0]?.[0]).toMatchObject({
      baseURL: "https://solider.uz",
    });
  });
});
