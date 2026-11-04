/**
 * Last-resort fallback for OpenRouter chat completions: when OpenRouter refuses
 * a request because the key or the free pool is exhausted (402, 429, 503, or a
 * 403 "key limit"), replay it once on Groq's OpenAI-compatible endpoint.
 *
 * Groq is a provider-level replay, not a model-registry entry: the AI SDK
 * provider keeps parsing a standard OpenAI chat-completions stream, so the
 * request only needs OpenRouter-specific fields stripped and the model swapped.
 * Requests with images or files are not replayed (the default model is
 * text-only). Unset GROQ_API_KEY disables this entirely.
 *
 * GROQ_API_KEY may hold several comma-separated keys. Groq rate limits apply
 * per account, so keys from separate accounts add capacity: replays start at a
 * rotating key, and a key that answers 429 (or 401/403) is skipped for a while.
 */
const GROQ_CHAT_COMPLETIONS_URL =
  "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";
const REPLAY_STATUSES = new Set([402, 429, 503]);

// Standard OpenAI fields Groq accepts; everything else (`models`, `provider`,
// `reasoning`, `usage`, `transforms`, cache hints) is OpenRouter-only.
const ALLOWED_BODY_FIELDS = [
  "messages",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "stream",
  "stop",
  "seed",
  "presence_penalty",
  "frequency_penalty",
  "response_format",
] as const;

const REASONING_EFFORTS = new Set(["low", "medium", "high"]);

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

const toGroqMessages = (messages: unknown): ChatMessage[] | null => {
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

export const toGroqRequestBody = (
  body: Record<string, unknown>,
  model: string,
): string | null => {
  const messages = toGroqMessages(body.messages);
  if (!messages) return null;
  const next: Record<string, unknown> = { model, messages };
  for (const field of ALLOWED_BODY_FIELDS) {
    if (field !== "messages" && body[field] !== undefined) {
      next[field] = body[field];
    }
  }
  if (next.stream === true) next.stream_options = { include_usage: true };
  const effort = (body.reasoning as { effort?: unknown } | undefined)?.effort;
  if (typeof effort === "string" && REASONING_EFFORTS.has(effort)) {
    next.reasoning_effort = effort;
  }
  return JSON.stringify(next);
};

const isKeyLimit403 = async (response: Response) =>
  response.status === 403 &&
  /key limit/i.test(
    await response
      .clone()
      .text()
      .catch(() => ""),
  );

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const MAX_RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;
const REJECTED_KEY_COOLDOWN_MS = 10 * 60_000;

export type GroqKeyState = {
  cursor: number;
  cooldownUntil: Map<string, number>;
};
export const createGroqKeyState = (): GroqKeyState => ({
  cursor: 0,
  cooldownUntil: new Map(),
});
// Shared by every wrapper (the shared client and each project-key client), so
// one rate-limited key is skipped everywhere.
const sharedKeyState = createGroqKeyState();

export const parseGroqKeys = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);

const rateLimitCooldownMs = (response: Response): number => {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, MAX_RATE_LIMIT_COOLDOWN_MS)
    : DEFAULT_RATE_LIMIT_COOLDOWN_MS;
};

/** Keys in rotation order, skipping cooled-down ones unless all are cooling. */
const orderedKeys = (keys: string[], state: GroqKeyState): string[] => {
  const start = state.cursor++ % keys.length;
  const rotated = [...keys.slice(start), ...keys.slice(0, start)];
  const now = Date.now();
  const available = rotated.filter(
    (key) => (state.cooldownUntil.get(key) ?? 0) <= now,
  );
  return available.length > 0 ? available : rotated;
};

export const createGroqFallbackFetch =
  (
    baseFetch: typeof fetch,
    apiKeys: string | undefined = process.env.GROQ_API_KEY,
    model: string = process.env.GROQ_FALLBACK_MODEL || DEFAULT_GROQ_MODEL,
    state: GroqKeyState = sharedKeyState,
  ): typeof fetch =>
  async (url, init) => {
    const response = await baseFetch(url, init);
    const keys = parseGroqKeys(apiKeys);
    if (keys.length === 0 || response.ok) return response;
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

    let groqBody: string | null;
    try {
      groqBody = toGroqRequestBody(
        JSON.parse(init.body) as Record<string, unknown>,
        model,
      );
    } catch {
      return response;
    }
    if (!groqBody) return response;

    console.warn(
      `OpenRouter returned ${response.status}; replaying the request on Groq`,
    );
    for (const key of orderedKeys(keys, state)) {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${key}`);
      headers.delete("HTTP-Referer");
      headers.delete("X-Title");
      const replay = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
        ...init,
        headers,
        body: groqBody,
      });
      if (replay.ok) return replay;
      if (replay.status === 429) {
        state.cooldownUntil.set(key, Date.now() + rateLimitCooldownMs(replay));
        continue;
      }
      if (replay.status === 401 || replay.status === 403) {
        state.cooldownUntil.set(key, Date.now() + REJECTED_KEY_COOLDOWN_MS);
        continue;
      }
      break; // another key cannot fix a request Groq rejects on its merits
    }
    // A Groq failure is less informative than OpenRouter's own error.
    return response;
  };
