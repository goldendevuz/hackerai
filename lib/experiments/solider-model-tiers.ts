/**
 * Solider.uz Phase 1: optional unlock for the paid-looking model tiers
 * (Standard/Pro/Max) on the free subscription tier. Upstream locks these in
 * the UI (ModelSelector) and normalizes any selection back to "auto"
 * server-side (normalizeSelectedModelForSubscription in types/chat.ts)
 * because the hosted product funds different-cost models from subscription
 * revenue.
 *
 * This fork has no payments configured (see CHANGES.md) and already routes
 * every OpenRouter registry entry -- both the "free" and "paid" named model
 * keys -- through one fixed, cheap model pool via OPENROUTER_MODEL_OVERRIDE
 * (lib/ai/providers.ts). So which tier a user picks here never changes the
 * actual model or cost; it only changes what the UI shows and persists. The
 * unlock is purely cosmetic until this fork has its own pricing tiers.
 *
 * NEXT_PUBLIC_SOLIDER_UNLOCK_MODEL_TIERS=true removes the free-tier lock.
 * Unset keeps upstream behavior (free tier -> "auto" only, other tiers
 * shown locked with an upgrade CTA). NEXT_PUBLIC_ so the same flag is
 * readable client-side (ModelSelector) and server-side (types/chat.ts
 * consumers in chat-handler.ts, agent-trigger-route.ts) without duplicating
 * the check.
 */
export const isModelTierUnlockedForFree = (): boolean =>
  process.env.NEXT_PUBLIC_SOLIDER_UNLOCK_MODEL_TIERS === "true";
