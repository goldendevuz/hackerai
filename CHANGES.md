# Solider.uz fork changes

Base commit: `a51801a1adfa0508ff37c6b75a105e0975c565ff`
(upstream `hackerai-tech/hackerai`, `main`, "Diagnose Convex RPCs before platform timeouts (#1748)").

Phase 1 is a $0-budget, non-commercial deployment: no payments, ads or upsells.

## What changed and why

1. **`convex/s3Utils.ts` — optional Cloudflare R2 backend.**
   `STORAGE_PROVIDER=r2` switches the S3 client to R2's S3-compatible endpoint
   (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
   `R2_BUCKET_NAME`; region `auto`, path-style addressing, single bucket with no
   regional routing). R2's free tier is permanent and has no egress fees. The
   default remains AWS S3, so this is additive.
2. **`.env.local.example` — R2 variables; AI uncensoring path left unset.**
   Documents the R2 variables (AWS kept as a legacy path). `OPENAI_API_KEY` and
   `ABLITERATION_API_KEY` are commented out on purpose: together they route
   requests to a safety-training-removed model. Without them the code no-ops and
   the app uses its standard models. This also drops the only non-free account
   upstream requires.
3. **`lib/cloud-network/policy.ts` — `SOLIDER_LAB_DEFAULT_POLICY`.**
   Restricted mode allowing `portswigger.net` and `*.web-security-academy.net`.
   It applies only to accounts with no saved policy. A policy a user saved
   themselves, "unrestricted" included, is never overridden.
4. **`lib/ai/tools/utils/sandbox.ts` — sandbox creation uses that default.**
   `Sandbox.create()` falls back to `SOLIDER_LAB_DEFAULT_POLICY` instead of
   `DEFAULT_NETWORK_POLICY` when no policy is saved.
5. **`lib/cloud-network/service.ts` — UI matches reality.**
   `defaultNetworkSettings()` returns the lab default. `ensureCloudNetwork()`
   also seeds new accounts with it (it referenced the old constant, so it had to
   change with the import).
6. **`lib/cloud-network/prompt.ts` — agent system prompt matches.**
   The agent is told about the restricted default, never "unrestricted".
7. **`convex/cloudNetwork.ts` — same fallback in `begin`.**
8. **`docker/Dockerfile` — `openvpn` package** added next to `net-tools`, in
   preparation for HackTheBox/TryHackMe VPN access. Nothing calls it yet.
9. **`CHANGES.md`** — this file.

10. **`lib/ai/providers.ts` — optional `:free` model override.**
    Setting `OPENROUTER_MODEL_OVERRIDE=<slug>:free` routes every OpenRouter
    registry entry, including the `models` fallback chain (resolved from the
    registry), to that one model. Unset keeps upstream routing. Upstream's
    models are paid, so a $0 OpenRouter key otherwise fails with 402/403.
    Current value in `.env.local`: `nvidia/nemotron-3-ultra-550b-a55b:free`.
    Free models are rate-limited and vary in tool-calling quality.

11. **`lib/experiments/solider-cloud-agent.ts` plus seven call sites —
    optional cloud Agent unlock for the free tier.** Upstream gates cloud
    (E2B) Agent mode behind a paid subscription at seven independent points,
    because the hosted product funds E2B/model usage from subscription
    revenue:
    - `app/components/ChatInput/ChatModeSelector.tsx` (client: routes free
      users into `AgentUpgradeDialog` instead of Agent mode)
    - `app/components/ChatInput/ChatInput.tsx` (client: `isFreeAgent` watchdog
      effect that force-switches an in-progress chat back to Ask, and a
      second effect that forces `sandboxPreference` away from `"e2b"`, the
      moment a free account's cloud sandbox looks unavailable)
    - `lib/api/chat-stream-helpers.ts` `assertFreeAgentGates` (server: the
      `/api/chat` streaming route)
    - `lib/ai/tools/index.ts` `createTools` (server: the Trigger.dev
      `agent-long` task)
    - `lib/ai/tools/utils/hybrid-sandbox-manager.ts` (server: the actual
      sandbox-acquisition layer — the deepest and most load-bearing check)
    - `app/api/sandbox/network/route.ts` and `app/api/delete-sandboxes/route.ts`
      (server: editing the cloud network allowlist and deleting a cloud
      sandbox)
    - `app/components/chat.tsx` (client, cosmetic: shows the
      `CloudWorkspaceRecovery` status/reconnect UI)

    This fork has no payments configured, so every account is permanently
    "free" and these gates would make the cloud sandbox this fork provisions
    with its own E2B/OpenRouter keys unreachable for no reason.
    `NEXT_PUBLIC_SOLIDER_UNLOCK_CLOUD_AGENT=true` removes the restriction at
    all seven points; unset keeps upstream behavior everywhere. General
    usage/rate limits (token budgets, request rate limiting) are untouched —
    only the free-tier -> cloud-sandbox block is bypassed.

12. **`lib/findings/pdf-report.ts`, `lib/findings/telemetry.ts`,
    `app/components/findings/FindingDetail.tsx` — colorful PDF export for
    findings.** New "Download PDF" button next to the existing "Download
    report" (Markdown) button. This is additive, not a fork-specific
    override: it reuses the already-agent-authored finding fields (the same
    ones `lib/findings/markdown.ts` already renders) and adds only layout —
    severity-colored header badge matching `FindingCard.tsx`'s existing
    Tailwind colors, section headings, code blocks for evidence/PoC, a
    metadata table, and page footers. Generated entirely client-side with
    `jspdf` (new dependency, dynamically imported only when the button is
    clicked) — no server round trip, no paid service, $0 cost. Uses jsPDF's
    core Helvetica font (Latin-1 only); non-Latin scripts may not render, so
    the Markdown export remains the full-fidelity, any-language option.
    Page 1 is a dedicated cover (title, target, severity badge, metadata
    table); body sections start on page 2, with orange section headings
    (not embedded images yet: `evidence_refs` are sandbox-local file paths
    with no fetch path to a displayable image, and E2B sandboxes are
    ephemeral, so a later PDF export could point at a file that's already
    gone — that needs its own server-side plumbing, deferred). Long
    code/evidence blocks render
    in page-sized chunks instead of one oversized block, so a block that
    doesn't fit flows onto the next page instead of leaving the rest of the
    current page blank. `stripMarkdown()` only removes fenced/inline code
    markers, bold, and heading hashes — not single-asterisk "_italic_",
    because agent prose routinely contains literal single asterisks (SQL
    `SELECT * FROM`, glob patterns) that a naive greedy strip corrupted.
    Both this and the existing Markdown "Download report" button bypass
    `downloadFile()`'s File System Access API save-location picker on the
    web and go straight to the browser's Downloads folder via the new
    `downloadBlobDirect()` (`lib/utils/file-download.ts`); Tauri keeps
    `downloadFile()`'s native save dialog for the Markdown button only, since
    that bridge doesn't accept binary content. Not yet wired into the Tauri
    desktop save bridge for PDF (`saveFileToLocal` only
    writes string content); the button shows a toast and no-ops on Desktop
    until that bridge gains binary support.

13. **`lib/cloud-network/policy.ts` — `SOLIDER_LAB_DEFAULT_POLICY` now also
    allows `*.r2.cloudflarestorage.com`.** Regression found live: generated-
    file delivery (`get_terminal_files`, used for PoCs, screenshots, and
    reports an agent hands back to the user) runs `curl -X PUT <presigned-
url>` _inside the sandbox_ (`lib/ai/tools/utils/sandbox-file-uploader.ts`),
    so it's subject to the sandbox's own network policy. The restricted
    labs-only default from change 3 didn't allow R2's upload host, so every
    file delivery from a never-configured account's sandbox failed with a
    TLS handshake error indistinguishable from a real network problem. An
    AWS S3 deployment (`STORAGE_PROVIDER` unset) would need its bucket's
    `*.amazonaws.com` host here instead.

14. **`app/components/AgentsTab.tsx` — `CloudNetworkSettings` unlocked for
    free.** Another gate change 11 missed: the Settings > Agents network
    section (where a user edits their own allowed destinations, e.g. to add
    `*.r2.cloudflarestorage.com` after change 13, or a personal HTB/THM VPN
    endpoint) was hidden entirely behind `subscription !== "free"` — hiding
    the one UI that could self-serve a fix for a never-configured account
    stuck with a stale restricted policy (no payments in this fork, so
    "free" is permanent). Uses the same
    `isCloudAgentUnlockedForFree()` as change 11; the adjacent Queue
    Messages free-tier gate on the same page is unrelated and untouched.

## NOT YET IMPLEMENTED: HackTheBox / TryHackMe VPN-join mode

Deferred to its own pass; none of it is guessed at here:

- Storing a user's personal `.ovpn` config, encrypted at rest.
- Parsing its `remote <host> <port>` line into `NetworkPolicy.allow` through the
  existing `saveNetworkSettings()` path.
- A sandbox-boot step that brings up the OpenVPN tunnel before the agent starts
  and tears it down afterwards.

Until then, only the PortSwigger Web Security Academy default is reachable
without a user-edited network policy.
