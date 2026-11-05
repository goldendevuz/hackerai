import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import {
  FALLBACK_PROVIDERS,
  createFallbackKeyState,
  createProviderFallbackFetch,
  resolveFallbackProviders,
  toPlainMessages,
  type ResolvedFallbackProvider,
} from "../provider-fallback";

const edge = require("next/dist/compiled/@edge-runtime/primitives/fetch") as {
  Headers: typeof Headers;
  Response: typeof Response;
};
const originalHeaders = globalThis.Headers;
const originalResponse = globalThis.Response;
beforeAll(() => {
  globalThis.Headers = edge.Headers;
  globalThis.Response = edge.Response;
});
afterAll(() => {
  globalThis.Headers = originalHeaders;
  globalThis.Response = originalResponse;
});

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const orBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    model: "z-ai/glm-5.3-flash:free",
    models: ["a:free", "b:free"],
    provider: { sort: "latency" },
    reasoning: { effort: "high" },
    usage: { include: true },
    stream: true,
    max_completion_tokens: 500,
    messages: [
      {
        role: "system",
        content: [{ type: "text", text: "sys", cache_control: { type: "x" } }],
      },
      { role: "user", content: "hi", reasoning: "internal" },
    ],
    tools: [{ type: "function", function: { name: "t", parameters: {} } }],
    ...extra,
  });

const provider = (
  name: string,
  keys: string[],
  model = `${name}-model`,
): ResolvedFallbackProvider => ({
  spec: FALLBACK_PROVIDERS.find((spec) => spec.name === name)!,
  keys,
  model,
});

const refused = (status = 429) =>
  jest.fn<any>().mockResolvedValue(new Response("limit", { status }));
const send = (
  base: ReturnType<typeof refused>,
  providers: ResolvedFallbackProvider[],
  body = orBody(),
) =>
  createProviderFallbackFetch(base, {
    providers,
    state: createFallbackKeyState(),
  })(OPENROUTER_URL, { method: "POST", body });
const urlOf = (call: unknown[]) => String(call[0]);
const keyOf = (call: unknown[]) =>
  new Headers((call[1] as RequestInit).headers).get("Authorization");
const bodyOf = (call: unknown[]) =>
  JSON.parse((call[1] as RequestInit).body as string);

describe("provider fallback chain", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("replays a refused request without OpenRouter-only fields", async () => {
    const replay = jest.fn<any>().mockResolvedValue(new Response("ok"));
    global.fetch = replay as unknown as typeof fetch;

    const response = await send(refused(), [provider("groq", ["gsk_x"], "m")]);

    expect(await response.text()).toBe("ok");
    expect(urlOf(replay.mock.calls[0])).toBe(
      "https://api.groq.com/openai/v1/chat/completions",
    );
    expect(keyOf(replay.mock.calls[0])).toBe("Bearer gsk_x");
    const sent = bodyOf(replay.mock.calls[0]);
    expect(sent).toMatchObject({
      model: "m",
      stream: true,
      max_tokens: 500,
      stream_options: { include_usage: true },
      reasoning_effort: "high",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
    });
    for (const field of ["models", "provider", "reasoning", "usage"]) {
      expect(sent).not.toHaveProperty(field);
    }
    expect(sent.messages[1]).not.toHaveProperty("reasoning");
  });

  it("does not replay successes, client errors, images, or an empty chain", async () => {
    const replay = jest.fn<any>();
    global.fetch = replay as unknown as typeof fetch;
    const chain = [provider("groq", ["gsk_x"])];

    await send(jest.fn<any>().mockResolvedValue(new Response("ok")), chain);
    await send(refused(400), chain);
    await send(refused(), []);
    await send(
      refused(),
      chain,
      orBody({
        messages: [
          { role: "user", content: [{ type: "image_url", image_url: {} }] },
        ],
      }),
    );
    expect(replay).not.toHaveBeenCalled();
  });

  it("keeps OpenRouter's own error when every provider fails", async () => {
    global.fetch = jest
      .fn<any>()
      .mockResolvedValue(new Response("down", { status: 500 })) as never;
    const response = await send(refused(402), [
      provider("groq", ["a"]),
      provider("cerebras", ["b"]),
    ]);
    expect(response.status).toBe(402);
  });

  it("moves to the next provider once a provider's keys are rate limited", async () => {
    const replay = jest
      .fn<any>()
      .mockImplementation(async (url: string) =>
        String(url).includes("groq")
          ? new Response("limit", { status: 429 })
          : new Response("ok"),
      );
    global.fetch = replay as unknown as typeof fetch;

    const response = await send(refused(), [
      provider("groq", ["g1", "g2"]),
      provider("cerebras", ["c1"]),
    ]);

    expect(response.status).toBe(200);
    expect(replay.mock.calls.map((call) => [urlOf(call), keyOf(call)])).toEqual(
      [
        ["https://api.groq.com/openai/v1/chat/completions", "Bearer g1"],
        ["https://api.groq.com/openai/v1/chat/completions", "Bearer g2"],
        ["https://api.cerebras.ai/v1/chat/completions", "Bearer c1"],
      ],
    );
  });

  it("tries the next provider, not the next key, when a provider rejects the request itself", async () => {
    const replay = jest
      .fn<any>()
      .mockImplementation(async (url: string) =>
        String(url).includes("groq")
          ? new Response("bad", { status: 400 })
          : new Response("ok"),
      );
    global.fetch = replay as unknown as typeof fetch;

    await send(refused(), [
      provider("groq", ["g1", "g2"]),
      provider("cerebras", ["c1"]),
    ]);

    expect(replay.mock.calls.map(keyOf)).toEqual(["Bearer g1", "Bearer c1"]);
  });

  it("leaves out fields a stricter provider rejects", async () => {
    const replay = jest.fn<any>().mockResolvedValue(new Response("ok"));
    global.fetch = replay as unknown as typeof fetch;

    await send(refused(), [provider("mistral", ["m1"])]);

    const sent = bodyOf(replay.mock.calls[0]);
    expect(sent).not.toHaveProperty("stream_options");
    expect(sent).not.toHaveProperty("reasoning_effort");
    expect(sent).toMatchObject({ model: "mistral-model", max_tokens: 500 });
  });

  describe("several keys", () => {
    it("moves to the next key when one is rate limited, then skips it", async () => {
      const replay = jest
        .fn<any>()
        .mockResolvedValueOnce(
          new Response("slow", {
            status: 429,
            headers: { "retry-after": "30" },
          }),
        )
        .mockImplementation(async () => new Response("ok"));
      global.fetch = replay as unknown as typeof fetch;
      const run = createProviderFallbackFetch(refused(), {
        providers: [provider("groq", ["key-a", "key-b"])],
        state: createFallbackKeyState(),
      });
      const call = () =>
        run(OPENROUTER_URL, { method: "POST", body: orBody() });

      expect((await call()).status).toBe(200);
      expect(replay.mock.calls.map(keyOf)).toEqual([
        "Bearer key-a",
        "Bearer key-b",
      ]);

      // key-a is cooling down, so the next replays go straight to key-b.
      await call();
      await call();
      expect(replay.mock.calls.slice(2).map(keyOf)).toEqual([
        "Bearer key-b",
        "Bearer key-b",
      ]);
    });

    it("spreads healthy replays across keys", async () => {
      const replay = jest
        .fn<any>()
        .mockImplementation(async () => new Response("ok"));
      global.fetch = replay as unknown as typeof fetch;
      const run = createProviderFallbackFetch(refused(), {
        providers: [provider("groq", ["key-a", "key-b"])],
        state: createFallbackKeyState(),
      });
      for (let i = 0; i < 4; i++) {
        await run(OPENROUTER_URL, { method: "POST", body: orBody() });
      }
      expect(replay.mock.calls.map(keyOf)).toEqual([
        "Bearer key-a",
        "Bearer key-b",
        "Bearer key-a",
        "Bearer key-b",
      ]);
    });
  });
});

describe("resolveFallbackProviders", () => {
  it("includes only providers with a key, in the default order", () => {
    const chain = resolveFallbackProviders({
      GEMINI_API_KEY: "g",
      GROQ_API_KEY: "a, b",
      CEREBRAS_API_KEY: "  ",
    });
    expect(chain.map((entry) => entry.spec.name)).toEqual(["groq", "google"]);
    expect(chain[0].keys).toEqual(["a", "b"]);
  });

  it("honors FALLBACK_PROVIDER_ORDER and per-provider model overrides", () => {
    const chain = resolveFallbackProviders({
      FALLBACK_PROVIDER_ORDER: "cerebras, groq",
      GROQ_API_KEY: "a",
      CEREBRAS_API_KEY: "c",
      MISTRAL_API_KEY: "m",
      GROQ_FALLBACK_MODEL: "llama-3.3-70b-versatile",
    });
    // Mistral has a key but is not in the order, so it never runs.
    expect(chain.map((entry) => entry.spec.name)).toEqual(["cerebras", "groq"]);
    expect(chain[1].model).toBe("llama-3.3-70b-versatile");
    expect(chain[0].model).toBe("gpt-oss-120b");
  });
});

describe("toPlainMessages", () => {
  it("refuses a request it cannot express as text", () => {
    expect(
      toPlainMessages([{ role: "user", content: [{ type: "file" }] }]),
    ).toBe(null);
  });
});
