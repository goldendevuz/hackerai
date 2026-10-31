/**
 * Solider.uz Phase 1: optional unlock for cloud (E2B) Agent mode on the free
 * tier. Upstream gates cloud Agent behind a paid subscription — both in the
 * UI (AgentUpgradeDialog) and server-side (assertFreeAgentGates) — because
 * HackerAI's hosted product funds E2B/model usage from subscription revenue.
 * This fork has no payments configured (see CHANGES.md), so every account is
 * permanently "free"; the gate would make the cloud sandbox we provisioned
 * ourselves (our own E2B/OpenRouter keys) unreachable for no reason.
 *
 * NEXT_PUBLIC_SOLIDER_UNLOCK_CLOUD_AGENT=true removes that restriction.
 * Unset keeps upstream behavior (free tier -> local sandbox or upgrade only).
 * NEXT_PUBLIC_ so the same flag is readable client-side (ChatModeSelector)
 * and server-side (assertFreeAgentGates) without duplicating the check.
 */
export const isCloudAgentUnlockedForFree = (): boolean =>
  process.env.NEXT_PUBLIC_SOLIDER_UNLOCK_CLOUD_AGENT === "true";
