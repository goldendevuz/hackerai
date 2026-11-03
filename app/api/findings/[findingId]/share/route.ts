import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { getUserID } from "@/lib/auth/get-user-id";
import { ChatSDKError } from "@/lib/errors";
import { workos } from "../../../workos";

export const runtime = "nodejs";

const bodySchema = z.object({ email: z.string().trim().email().max(320) });

/**
 * POST /api/findings/:findingId/share
 * Body: { email }
 * The owner pushes an independent copy into an existing user's Findings. The
 * recipient takes no action, and nobody is invited: an email with no account
 * is rejected.
 */
export const POST = async (
  req: NextRequest,
  { params }: { params: Promise<{ findingId: string }> },
) => {
  let senderId: string;
  try {
    senderId = await getUserID(req);
  } catch (error) {
    if (error instanceof ChatSDKError) return error.toResponse();
    throw error;
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }
  const { findingId } = await params;

  try {
    const recipients = await workos.userManagement.listUsers({
      email: parsed.data.email,
      limit: 1,
    });
    const recipient = recipients.data[0];
    if (!recipient) {
      return NextResponse.json({ error: "user_not_found" }, { status: 404 });
    }
    if (recipient.id === senderId) {
      return NextResponse.json({ error: "self_share" }, { status: 400 });
    }

    const sender = await workos.userManagement.getUser(senderId);
    const senderName = [sender.firstName, sender.lastName]
      .filter(Boolean)
      .join(" ");

    const result = await getConvexClient().mutation(
      api.findings.shareFindingCopyForBackend,
      {
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        senderUserId: senderId,
        recipientUserId: recipient.id,
        findingId,
        ...(senderName ? { senderName } : {}),
      },
    );

    if (!result.success) {
      const status = result.error === "not_found" ? 404 : 400;
      return NextResponse.json({ error: result.error }, { status });
    }
    return NextResponse.json({
      success: true,
      already_shared: result.already_shared,
    });
  } catch (error) {
    console.error("Failed to share finding:", error);
    return NextResponse.json({ error: "share_failed" }, { status: 500 });
  }
};
