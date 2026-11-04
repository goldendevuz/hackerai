/**
 * Last-resort fallback for OpenRouter chat completions: when OpenRouter refuses
 * a request because the key or the free pool is exhausted (402, 429, 503, or a
 * 403 "key limit"), replay it on a chain of OpenAI-compatible providers.
 *
 * This is a provider-level replay, not a model-registry entry: the AI SDK
 * provider keeps parsing a standard OpenAI chat-completions stream, so the
 * request only needs OpenRouter-specific fields stripped and the model swapped.
 * Requests with images or files are not replayed (the fallback models are
 * text-only). A provider is on the chain only if its API key env var is set.
 *
 * Each key variable may hold several comma-separated keys. Free-tier limits are
 * per account, so keys from separate accounts add capacity: replays start at a
 * rotating key, and a key that answers 429 (or 401/403) is skipped for a while.
 *
 * Privacy: some free tiers (Mistral Experiment, Google AI Studio) may train on
 * prompts. They sit last in the default order; drop one by not setting its key,
 * or set FALLBACK_PROVIDER_ORDER to choose exactly which providers run.
 */
type FallbackProviderSpec = {
  name: string;
  keysEnv: string;
  /** Overrides the default model, e.g. GROQ_FALLBACK_MODEL. */
  modelEnv: string;
  defaultModel: string;
  url: string;
  /** Fields a stricter API rejects are left out unless enabled here. */
  reasoningEffort?: boolean;
  parallelToolCalls?: boolean;
  streamUsage?: boolean;
};

export const FALLBACK_PROVIDERS: readonly FallbackProviderSpec[] = [
  {
    name: "groq",
    keysEnv: "GROQ_API_KEY",
    modelEnv: "GROQ_FALLBACK_MODEL",
    defaultModel: "openai/gpt-oss-120b",
    url: "https://api.groq.com/openai/v1/chat/completions",
    reasoningEffort: true,
    parallelToolCalls: true,
    streamUsage: true,
  },
  {
    name: "cerebras",
    keysEnv: "CEREBRAS_API_KEY",
    modelEnv: "CEREBRAS_FALLBACK_MODEL",
    defaultModel: "gpt-oss-120b",
    url: "https://api.cerebras.ai/v1/chat/completions",
    reasoningEffort: true,
    parallelToolCalls: true,
    streamUsage: true,
  },
  {
    name: "sambanova",
    keysEnv: "SAMBANOVA_API_KEY",
    modelEnv: "SAMBANOVA_FALLBACK_MODEL",
    defaultModel: "gpt-oss-120b",
    url: "https://api.sambanova.ai/v1/chat/completions",
    streamUsage: true,
  },
  {
    name: "huggingface",
    keysEnv: "HUGGINGFACE_API_KEY",
    modelEnv: "HUGGINGFACE_FALLBACK_MODEL",
    defaultModel: "openai/gpt-oss-120b",
    url: "https://router.huggingface.co/v1/chat/completions",
    streamUsage: true,
  },
  {
    name: "nvidia",
    keysEnv: "NVIDIA_API_KEY",
    modelEnv: "NVIDIA_FALLBACK_MODEL",
    defaultModel: "z-ai/glm-5.3-flash",
    url: "https://integrate.api.nvidia.com/v1/chat/completions",
    streamUsage: true,
  },
  {
    name: "mistral",
    keysEnv: "MISTRAL_API_KEY",
    modelEnv: "MISTRAL_FALLBACK_MODEL",
    defaultModel: "mistral-medium-latest",
    url: "https://api.mistral.ai/v1/chat/completions",
    parallelToolCalls: true,
  },
  {
    name: "google",
    keysEnv: "GEMINI_API_KEY",
    modelEnv: "GEMINI_FALLBACK_MODEL",
    defaultModel: "gemini-3-flash-preview",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    streamUsage: true,
  },
];

export type ResolvedFallbackProvider = {
  spec: FallbackProviderSpec;
  keys: string[];
  model: string;
};

export const parseKeys = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);

/** Providers with at least one key, in FALLBACK_PROVIDER_ORDER or default order. */
export const resolveFallbackProviders = (
  env: Record<string, string | undefined> = process.env,
): ResolvedFallbackProvider[] => {
  const order = parseKeys(env.FALLBACK_PROVIDER_ORDER).map((name) =>
    name.toLowerCase(),
  );
  const specs = order.length
    ? order.flatMap((name) => FALLBACK_PROVIDERS.filter((s) => s.name === name))
    : FALLBACK_PROVIDERS;
  return specs.flatMap((spec) => {
    const keys = parseKeys(env[spec.keysEnv]);
    return keys.length
      ? [
          {
            spec,
            keys,
            model: env[spec.modelEnv]?.trim() || spec.defaultModel,
          },
        ]
      : [];
  });
};

const REPLAY_STATUSES = new Set([402, 429, 503]);
const REASONING_EFFORTS = new Set(["low", "medium", "high"]);
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const MAX_RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;
const REJECTED_KEY_COOLDOWN_MS = 10 * 60_000;
const PROVIDER_ERROR_COOLDOWN_MS = 30_000;

type ChatMessage = Record<string, unknown>;

const textOf = (content: unknown): string | null => {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (!Array.isArray(content)) return null;
  let text = "";
  for (const part of content) {
    if (
      !part ||
      typeof part !== "object" ||
      (part as { type?: unknown }).type !== "text" ||
      typeof (part as { text?: unknown }).text !== "string"
    ) {
      return null; // image/file/unknown part: cannot be flattened to text
    }
    text += (part as { text: string }).text;
  }
  return text;
};

/** Plain-text messages, or null when any part cannot be expressed as text. */
export const toPlainMessages = (messages: unknown): ChatMessage[] | null => {
  if (!Array.isArray(messages)) return null;
  const out: ChatMessage[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") return null;
    const message = raw as ChatMessage;
    const content = textOf(message.content);
    if (content === null) return null;
    const next: ChatMessage = { role: message.role, content };
    if (typeof message.name === "string") next.name = message.name;
    if (Array.isArray(message.tool_calls)) next.tool_calls = message.tool_calls;
    if (typeof message.tool_call_id === "string") {
      next.tool_call_id = message.tool_call_id;
    }
    out.push(next);
  }
  return out;
};

// Standard OpenAI fields; everything else (`models`, `provider`, `reasoning`,
// `usage`, `transforms`, cache hints) is OpenRouter-only. Penalties and `seed`
// are left out: providers disagree on them and the app never sets them.
export const toProviderRequestBody = (
  body: Record<string, unknown>,
  messages: ChatMessage[],
  { spec, model }: Pick<ResolvedFallbackProvider, "spec" | "model">,
): string => {
  const next: Record<string, unknown> = { model, messages };
  for (const field of [
    "tools",
    "tool_choice",
    "temperature",
    "top_p",
    "stream",
    "stop",
    "response_format",
  ]) {
    if (body[field] !== undefined) next[field] = body[field];
  }
  if (spec.parallelToolCalls && body.parallel_tool_calls !== undefined) {
    next.parallel_tool_calls = body.parallel_tool_calls;
  }
  const maxTokens = body.max_tokens ?? body.max_completion_tokens;
  if (maxTokens !== undefined) next.max_tokens = maxTokens;
  if (next.stream === true && spec.streamUsage) {
    next.stream_options = { include_usage: true };
  }
  const effort = (body.reasoning as { effort?: unknown } | undefined)?.effort;
  if (
    spec.reasoningEffort &&
    typeof effort === "string" &&
    REASONING_EFFORTS.has(effort)
  ) {
    next.reasoning_effort = effort;
  }
  return JSON.stringify(next);
};

export type FallbackKeyState = {
  cursors: Map<string, number>;
  cooldownUntil: Map<string, number>;
};
export const createFallbackKeyState = (): FallbackKeyState => ({
  cursors: new Map(),
  cooldownUntil: new Map(),
});
// Shared by every wrapper (the shared client and each project-key client), so
// one rate-limited key is skipped everywhere.
const sharedKeyState = createFallbackKeyState();

const cooldownKey = (provider: ResolvedFallbackProvider, key: string) =>
  `${provider.spec.name}:${key}`;

const rateLimitCooldownMs = (response: Response): number => {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, MAX_RATE_LIMIT_COOLDOWN_MS)
    : DEFAULT_RATE_LIMIT_COOLDOWN_MS;
};

/** Keys in rotation order; cooled-down ones are dropped unless `all` is set. */
const orderedKeys = (
  provider: ResolvedFallbackProvider,
  state: FallbackKeyState,
  all: boolean,
): string[] => {
  const { keys, spec } = provider;
  const cursor = state.cursors.get(spec.name) ?? 0;
  state.cursors.set(spec.name, cursor + 1);
  const start = cursor % keys.length;
  const rotated = [...keys.slice(start), ...keys.slice(0, start)];
  if (all) return rotated;
  const now = Date.now();
  return rotated.filter(
    (key) => (state.cooldownUntil.get(cooldownKey(provider, key)) ?? 0) <= now,
  );
};

const isKeyLimit403 = async (response: Response) =>
  response.status === 403 &&
  /key limit/i.test(
    await response
      .clone()
      .text()
      .catch(() => ""),
  );

export const createProviderFallbackFetch =
  (
    baseFetch: typeof fetch,
    {
      providers,
      state = sharedKeyState,
    }: {
      providers?: ResolvedFallbackProvider[];
      state?: FallbackKeyState;
    } = {},
  ): typeof fetch =>
  async (url, init) => {
    const response = await baseFetch(url, init);
    if (response.ok) return response;
    // Resolved per call so a key rotated in the environment takes effect.
    const chain = providers ?? resolveFallbackProviders();
    if (chain.length === 0) return response;
    const target = String(
      typeof url === "object" && "url" in url ? url.url : url,
    );
    if (!target.endsWith("/chat/completions")) return response;
    if (
      !REPLAY_STATUSES.has(response.status) &&
      !(await isKeyLimit403(response))
    ) {
      return response;
    }
    if (typeof init?.body !== "string") return response;

    let body: Record<string, unknown>;
    let messages: ChatMessage[] | null;
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
      messages = toPlainMessages(body.messages);
    } catch {
      return response;
    }
    if (!messages) return response;

    console.warn(
      `OpenRouter returned ${response.status}; replaying on fallback providers`,
    );
    // Second pass ignores cooldowns, so a fully cooled-down chain is still tried
    // once rather than failing without a single attempt.
    for (const all of [false, true]) {
      let attempted = false;
      for (const provider of chain) {
        const sent = toProviderRequestBody(body, messages, provider);
        for (const key of orderedKeys(provider, state, all)) {
          attempted = true;
          const headers = new Headers(init.headers);
          headers.set("Authorization", `Bearer ${key}`);
          headers.delete("HTTP-Referer");
          headers.delete("X-Title");
          let replay: Response;
          try {
            replay = await fetch(provider.spec.url, {
              ...init,
              headers,
              body: sent,
            });
          } catch (error) {
            if (init.signal?.aborted) throw error;
            state.cooldownUntil.set(
              cooldownKey(provider, key),
              Date.now() + PROVIDER_ERROR_COOLDOWN_MS,
            );
            break;
          }
          if (replay.ok) return replay;
          const cooldownMs =
            replay.status === 429
              ? rateLimitCooldownMs(replay)
              : replay.status === 401 || replay.status === 403
                ? REJECTED_KEY_COOLDOWN_MS
                : replay.status >= 500
                  ? PROVIDER_ERROR_COOLDOWN_MS
                  : 0;
          if (cooldownMs > 0) {
            state.cooldownUntil.set(
              cooldownKey(provider, key),
              Date.now() + cooldownMs,
            );
          }
          // Another key of this provider helps only against a key-specific
          // refusal; anything else moves on to the next provider.
          if (![401, 403, 429].includes(replay.status)) break;
        }
      }
      if (attempted) break;
    }
    // A fallback failure is less informative than OpenRouter's own error.
    return response;
  };
