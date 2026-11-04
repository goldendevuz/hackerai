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

export const createGroqFallbackFetch =
  (
    baseFetch: typeof fetch,
    apiKey: string | undefined = process.env.GROQ_API_KEY,
    model: string = process.env.GROQ_FALLBACK_MODEL || DEFAULT_GROQ_MODEL,
  ): typeof fetch =>
  async (url, init) => {
    const response = await baseFetch(url, init);
    if (!apiKey || response.ok) return response;
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

    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${apiKey}`);
    headers.delete("HTTP-Referer");
    headers.delete("X-Title");
    console.warn(
      `OpenRouter returned ${response.status}; replaying the request on Groq`,
    );
    const replay = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
      ...init,
      headers,
      body: groqBody,
    });
    // A Groq failure is less informative than OpenRouter's own error.
    return replay.ok ? replay : response;
  };
