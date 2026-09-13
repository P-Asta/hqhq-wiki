/** GLM client (glm.ts): config parsing and SSE stream assembly. */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_GLM_BASE_URL,
  DEFAULT_GLM_MODEL,
  GlmApiError,
  GlmConfigError,
  getGlmConfig,
  streamChat,
  type ChatMessage,
} from "./glm";

/* ------------------------------------------------------------------ */
/* getGlmConfig                                                        */
/* ------------------------------------------------------------------ */

describe("getGlmConfig", () => {
  it("throws without an api key", () => {
    expect(() => getGlmConfig({})).toThrow(GlmConfigError);
  });

  it("applies defaults (subscription endpoint, glm-5.3, low effort)", () => {
    const config = getGlmConfig({ GLM_API_KEY: "k" });
    expect(config.baseUrl).toBe(DEFAULT_GLM_BASE_URL);
    expect(DEFAULT_GLM_BASE_URL).toContain("/api/coding/paas/v4");
    expect(config.model).toBe(DEFAULT_GLM_MODEL);
    expect(config.thinking).toBe("disabled");
    expect(config.reasoningEffort).toBe("low");
  });

  it("validates GLM_REASONING_EFFORT case-insensitively, defaulting to low", () => {
    expect(
      getGlmConfig({ GLM_API_KEY: "k", GLM_REASONING_EFFORT: "HIGH" }).reasoningEffort,
    ).toBe("high");
    expect(
      getGlmConfig({ GLM_API_KEY: "k", GLM_REASONING_EFFORT: "turbo" }).reasoningEffort,
    ).toBe("low");
  });

  it("strips trailing slashes and clamps temperature to GLM's [0, 1]", () => {
    const config = getGlmConfig({
      GLM_API_KEY: "k",
      GLM_BASE_URL: "https://open.bigmodel.cn/api/paas/v4/",
      GLM_TEMPERATURE: "7",
    });
    expect(config.baseUrl).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(config.temperature).toBe(1);
  });

  it("honors GLM_TEMPERATURE=0 instead of substituting the default", () => {
    expect(getGlmConfig({ GLM_API_KEY: "k", GLM_TEMPERATURE: "0" }).temperature).toBe(0);
    // Blank and garbage still default.
    expect(getGlmConfig({ GLM_API_KEY: "k", GLM_TEMPERATURE: "" }).temperature).toBe(0.6);
    expect(getGlmConfig({ GLM_API_KEY: "k", GLM_TEMPERATURE: "hot" }).temperature).toBe(0.6);
  });
});

/* ------------------------------------------------------------------ */
/* streamChat                                                          */
/* ------------------------------------------------------------------ */

const CONFIG = getGlmConfig({ GLM_API_KEY: "test-key" });
const MESSAGES: ChatMessage[] = [{ role: "user", content: "hi" }];

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function dataLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamChat", () => {
  it("assembles content deltas in order and surfaces them via callbacks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          dataLine({ choices: [{ delta: { content: "Hel" } }] }),
          // Split mid-line across network chunks + CRLF endings.
          'data: {"choices":[{"delta":{"content":"lo',
          ' wiki"}}]}\r\n',
          dataLine({ choices: [{ delta: {}, finish_reason: "stop" }] }),
          "data: [DONE]\n\n",
        ]),
      ),
    );

    const seen: string[] = [];
    const result = await streamChat(
      CONFIG,
      MESSAGES,
      undefined,
      { onContent: (t) => seen.push(t) },
      new AbortController().signal,
    );

    expect(result.content).toBe("Hello wiki");
    expect(seen).toEqual(["Hel", "lo wiki"]);
    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toEqual([]);
  });

  it("keeps reasoning_content out of the answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          dataLine({ choices: [{ delta: { reasoning_content: "hmm" } }] }),
          dataLine({ choices: [{ delta: { content: "answer" } }] }),
        ]),
      ),
    );

    const reasoning: string[] = [];
    const result = await streamChat(
      CONFIG,
      MESSAGES,
      undefined,
      { onReasoning: (t) => reasoning.push(t) },
      new AbortController().signal,
    );

    expect(result.content).toBe("answer");
    expect(reasoning).toEqual(["hmm"]);
  });

  it("accumulates fragmented tool-call arguments by index", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          dataLine({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_1", function: { name: "search_wiki", arguments: '{"que' } },
                  ],
                },
              },
            ],
          }),
          dataLine({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"titan"}' } }] } }],
          }),
          dataLine({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
          "data: [DONE]\n\n",
        ]),
      ),
    );

    const result = await streamChat(
      CONFIG,
      MESSAGES,
      [{ type: "function", function: { name: "search_wiki", description: "", parameters: {} } }],
      {},
      new AbortController().signal,
    );

    expect(result.toolCalls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "search_wiki", arguments: '{"query":"titan"}' },
      },
    ]);
    expect(result.finishReason).toBe("tool_calls");
  });

  it("sends tool_stream only when tools are offered", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => sseResponse(["data: [DONE]\n\n"]),
    );
    vi.stubGlobal("fetch", fetchMock);

    await streamChat(CONFIG, MESSAGES, undefined, {}, new AbortController().signal);
    const bare = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(bare.tool_stream).toBeUndefined();
    expect(bare.stream).toBe(true);

    await streamChat(
      CONFIG,
      MESSAGES,
      [{ type: "function", function: { name: "t", description: "", parameters: {} } }],
      {},
      new AbortController().signal,
    );
    const withTools = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(withTools.tool_stream).toBe(true);
    expect(withTools.tool_choice).toBe("auto");
  });

  it("forces thinking on with reasoning_effort for GLM-5 models", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => sseResponse(["data: [DONE]\n\n"]),
    );
    vi.stubGlobal("fetch", fetchMock);

    // CONFIG's model is the glm-5.3 default.
    await streamChat(CONFIG, MESSAGES, undefined, {}, new AbortController().signal);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("low");
  });

  it("keeps thinking disabled and omits reasoning_effort for GLM-4 models", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => sseResponse(["data: [DONE]\n\n"]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const config = getGlmConfig({ GLM_API_KEY: "k", GLM_MODEL: "glm-4.7" });
    await streamChat(config, MESSAGES, undefined, {}, new AbortController().signal);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("flushes the final event of a stream that ends without a newline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          dataLine({ choices: [{ delta: { content: "first " } }] }),
          // No trailing \n — the event sits in the line buffer at EOF.
          'data: {"choices":[{"delta":{"content":"last"}}]}',
        ]),
      ),
    );

    const result = await streamChat(CONFIG, MESSAGES, undefined, {}, new AbortController().signal);
    expect(result.content).toBe("first last");
  });

  it("drops malformed SSE lines instead of failing the stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse(["data: {not json}\n\n", dataLine({ choices: [{ delta: { content: "ok" } }] })]),
      ),
    );

    const result = await streamChat(CONFIG, MESSAGES, undefined, {}, new AbortController().signal);
    expect(result.content).toBe("ok");
  });

  it("maps an API error body onto GlmApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "1113", message: "quota exhausted" } }), {
            status: 429,
          }),
      ),
    );

    await expect(
      streamChat(CONFIG, MESSAGES, undefined, {}, new AbortController().signal),
    ).rejects.toMatchObject({ name: "GlmApiError", status: 429, code: "1113", message: "quota exhausted" });
    expect(new GlmApiError(500, "x", "y")).toBeInstanceOf(Error);
  });
});
