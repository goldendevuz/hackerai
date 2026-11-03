import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { mockMutation as mockConvexMutation } from "convex/browser";

const mockGetUserID = jest.fn<() => Promise<string>>();
const mockListUsers = jest.fn<(args: unknown) => Promise<any>>();
const mockGetUser = jest.fn<(id: string) => Promise<any>>();

jest.mock("next/server", () => ({
  NextResponse: {
    json: jest.fn((body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      json: async () => body,
    })),
  },
}));
jest.mock("@/lib/auth/get-user-id", () => ({ getUserID: mockGetUserID }));
jest.mock("../../../../workos", () => ({
  workos: {
    userManagement: { listUsers: mockListUsers, getUser: mockGetUser },
  },
}));

const request = (body: unknown) => ({ json: async () => body }) as any;
const params = { params: Promise.resolve({ findingId: "finding-1" }) };

describe("POST /api/findings/:findingId/share", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CONVEX_SERVICE_ROLE_KEY = "service_key";
    mockGetUserID.mockResolvedValue("sender-1");
    mockGetUser.mockResolvedValue({ firstName: "Ada", lastName: "Lovelace" });
    mockListUsers.mockResolvedValue({ data: [{ id: "recipient-1" }] });
    mockConvexMutation.mockResolvedValue({
      success: true,
      already_shared: false,
    } as never);
  });

  it("copies the finding to an existing user without inviting anyone", async () => {
    const { POST } = await import("../route");
    const response = await POST(request({ email: "b@example.com" }), params);

    expect(response.status).toBe(200);
    expect(mockConvexMutation).toHaveBeenCalledWith(expect.anything(), {
      serviceKey: "service_key",
      senderUserId: "sender-1",
      recipientUserId: "recipient-1",
      findingId: "finding-1",
      senderName: "Ada Lovelace",
    });
  });

  it("rejects an email with no account and writes nothing", async () => {
    mockListUsers.mockResolvedValue({ data: [] });
    const { POST } = await import("../route");
    const response = await POST(
      request({ email: "ghost@example.com" }),
      params,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "user_not_found" });
    expect(mockConvexMutation).not.toHaveBeenCalled();
  });

  it("rejects sharing with yourself", async () => {
    mockListUsers.mockResolvedValue({ data: [{ id: "sender-1" }] });
    const { POST } = await import("../route");
    const response = await POST(request({ email: "me@example.com" }), params);

    expect(response.status).toBe(400);
    expect(mockConvexMutation).not.toHaveBeenCalled();
  });

  it("surfaces a finding the sender does not own as 404", async () => {
    mockConvexMutation.mockResolvedValue({
      success: false,
      error: "not_found",
    } as never);
    const { POST } = await import("../route");
    const response = await POST(request({ email: "b@example.com" }), params);

    expect(response.status).toBe(404);
  });
});
