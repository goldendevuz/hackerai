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
  createGroqFallbackFetch,
  createGroqKeyState,
  toGroqRequestBody,
} from "../groq-fallback";

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

describe("Groq fallback", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("replays a refused request on Groq without OpenRouter-only fields", async () => {
    const groq = jest.fn<any>().mockResolvedValue(new Response("ok"));
    global.fetch = groq as unknown as typeof fetch;
    const base = jest
      .fn<any>()
      .mockResolvedValue(new Response("limit", { status: 429 }));

    const response = await createGroqFallbackFetch(
      base,
      "gsk_x",
      "m-groq",
    )(OPENROUTER_URL, {
      method: "POST",
      body: orBody(),
      headers: { Authorization: "Bearer or" },
    });

    expect(await response.text()).toBe("ok");
    const [url, init] = groq.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer gsk_x");
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({
      model: "m-groq",
      stream: true,
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

  it("does not replay successes, client errors, images, or without a key", async () => {
    const groq = jest.fn<any>();
    global.fetch = groq as unknown as typeof fetch;
    const run = (status: number, body: string, key: string | undefined) =>
      createGroqFallbackFetch(
        jest.fn<any>().mockResolvedValue(new Response("x", { status })),
        key,
        "m",
      )(OPENROUTER_URL, { method: "POST", body });

    await run(200, orBody(), "gsk_x");
    await run(400, orBody(), "gsk_x");
    await run(429, orBody(), undefined);
    await run(
      429,
      orBody({
        messages: [
          { role: "user", content: [{ type: "image_url", image_url: {} }] },
        ],
      }),
      "gsk_x",
    );
    expect(groq).not.toHaveBeenCalled();
  });

  it("keeps OpenRouter's own error when Groq also fails", async () => {
    global.fetch = jest
      .fn<any>()
      .mockResolvedValue(new Response("down", { status: 500 })) as never;
    const response = await createGroqFallbackFetch(
      jest.fn<any>().mockResolvedValue(new Response("limit", { status: 402 })),
      "gsk_x",
      "m",
    )(OPENROUTER_URL, { method: "POST", body: orBody() });
    expect(response.status).toBe(402);
  });

  it("refuses to convert a request it cannot express as text", () => {
    expect(
      toGroqRequestBody(
        { messages: [{ role: "user", content: [{ type: "file" }] }] },
        "m",
      ),
    ).toBeNull();
  });

  describe("several keys", () => {
    const keyUsed = (call: unknown[]) =>
      new Headers((call[1] as RequestInit).headers).get("Authorization");
    const refuse = () =>
      jest.fn<any>().mockResolvedValue(new Response("limit", { status: 429 }));

    it("moves to the next key when one is rate limited, then skips it", async () => {
      const groq = jest
        .fn<any>()
        .mockResolvedValueOnce(
          new Response("slow", {
            status: 429,
            headers: { "retry-after": "30" },
          }),
        )
        .mockImplementation(async () => new Response("ok"));
      global.fetch = groq as unknown as typeof fetch;
      const state = createGroqKeyState();
      const run = () =>
        createGroqFallbackFetch(
          refuse(),
          "key-a, key-b",
          "m",
          state,
        )(OPENROUTER_URL, { method: "POST", body: orBody() });

      expect((await run()).status).toBe(200);
      expect(groq.mock.calls.map(keyUsed)).toEqual([
        "Bearer key-a",
        "Bearer key-b",
      ]);

      // key-a is cooling down, so the next replays go straight to key-b.
      await run();
      await run();
      expect(groq.mock.calls.slice(2).map(keyUsed)).toEqual([
        "Bearer key-b",
        "Bearer key-b",
      ]);
    });

    it("spreads healthy replays across keys", async () => {
      const groq = jest
        .fn<any>()
        .mockImplementation(async () => new Response("ok"));
      global.fetch = groq as unknown as typeof fetch;
      const state = createGroqKeyState();
      const fetchWithGroq = createGroqFallbackFetch(
        refuse(),
        "key-a,key-b",
        "m",
        state,
      );
      for (let i = 0; i < 4; i++) {
        await fetchWithGroq(OPENROUTER_URL, { method: "POST", body: orBody() });
      }
      expect(groq.mock.calls.map(keyUsed)).toEqual([
        "Bearer key-a",
        "Bearer key-b",
        "Bearer key-a",
        "Bearer key-b",
      ]);
    });

    it("does not try another key for a request Groq rejects on its merits", async () => {
      const groq = jest
        .fn<any>()
        .mockResolvedValue(new Response("bad", { status: 400 }));
      global.fetch = groq as unknown as typeof fetch;
      const response = await createGroqFallbackFetch(
        refuse(),
        "key-a,key-b",
        "m",
        createGroqKeyState(),
      )(OPENROUTER_URL, { method: "POST", body: orBody() });
      expect(groq).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(429); // OpenRouter's own error
    });
  });
});
