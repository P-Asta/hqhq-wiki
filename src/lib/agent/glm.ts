/**
 * GLM (Z.ai / Zhipu BigModel) chat-completions client for the wiki Q&A agent.
 *
 * The v4 API is OpenAI-wire-compatible (POST {base}/chat/completions,
 * `Authorization: Bearer <key>`), so this is plain fetch + SSE — the official
 * TypeScript SDK is unreleased. GLM quirks honored here:
 *   - temperature is [0, 1] (not OpenAI's [0, 2]);
 *   - streamed tool calls require BOTH `stream: true` and `tool_stream: true`,
 *     and arrive as indexed `function.arguments` fragments to concatenate;
 *   - thinking models interleave `delta.reasoning_content` with
 *     `delta.content` — kept separate so reasoning never leaks into answers;
 *   - `thinking: {type}` toggles reasoning on GLM-4.x, but GLM-5.x always
 *     reasons — for those we send `reasoning_effort` instead (default low,
 *     for snappy Q&A).
 *
 * Defaults target the GLM Coding Plan (subscription): its token only works
 * on the coding endpoint, so a subscriber just pastes GLM_API_KEY and runs.
 * Pay-as-you-go keys set GLM_BASE_URL to the general /api/paas/v4 endpoint.
 */

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

/** GLM Coding Plan (subscription) endpoint; NOT interchangeable with the
 *  pay-as-you-go https://api.z.ai/api/paas/v4. */
export const DEFAULT_GLM_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
export const DEFAULT_GLM_MODEL = "glm-5.3";

const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface GlmConfig {
  apiKey: string;
  /** API root WITHOUT the /chat/completions suffix. */
  baseUrl: string;
  model: string;
  maxTokens: number;
  /** Clamped to GLM's [0, 1]. */
  temperature: number;
  /** GLM-4.x reasoning toggle; "disabled" keeps Q&A latency low. */
  thinking: "enabled" | "disabled";
  /** Reasoning depth for models that think (GLM-5.x always does). */
  reasoningEffort: ReasoningEffort;
}

/** Thrown when GLM_API_KEY is missing — the server fails fast at boot. */
export class GlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlmConfigError";
  }
}

/** Non-2xx response from the GLM API. */
export class GlmApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GlmApiError";
  }
}

/** A set env var as a finite number; unset/blank/garbage reads as undefined. */
function parseNumberEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Read lazily (src/lib/env.ts pattern) so tests can set process.env first. */
export function getGlmConfig(env: Record<string, string | undefined> = process.env): GlmConfig {
  const apiKey = env.GLM_API_KEY?.trim();
  if (!apiKey) {
    throw new GlmConfigError(
      "GLM_API_KEY is not set. Paste your GLM Coding Plan (subscription) token — or a " +
        "pay-as-you-go API key — into .env (see .env.example). Tokens come from " +
        "https://z.ai (international) or https://bigmodel.cn (mainland).",
    );
  }
  const maxTokens = parseNumberEnv(env.GLM_MAX_TOKENS);
  // 0 is a valid GLM temperature (near-greedy) — only unset/garbage defaults.
  const temperature = parseNumberEnv(env.GLM_TEMPERATURE) ?? 0.6;
  const effortRaw = env.GLM_REASONING_EFFORT?.trim().toLowerCase();
  return {
    apiKey,
    baseUrl: (env.GLM_BASE_URL?.trim() || DEFAULT_GLM_BASE_URL).replace(/\/+$/, ""),
    model: env.GLM_MODEL?.trim() || DEFAULT_GLM_MODEL,
    maxTokens: maxTokens && maxTokens > 0 ? Math.min(maxTokens, 131072) : 4096,
    temperature: Math.min(Math.max(temperature, 0), 1),
    thinking: env.GLM_THINKING?.trim() === "enabled" ? "enabled" : "disabled",
    reasoningEffort: (REASONING_EFFORTS as readonly string[]).includes(effortRaw ?? "")
      ? (effortRaw as ReasoningEffort)
      : "low",
  };
}

/* ------------------------------------------------------------------ */
/* Chat types (OpenAI wire shape)                                      */
/* ------------------------------------------------------------------ */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCallbacks {
  /** Answer-text fragment, in order. */
  onContent?: (text: string) => void;
  /** Reasoning fragment (thinking models); never part of the answer. */
  onReasoning?: (text: string) => void;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
}

/** The chat dependency the agent loop takes — injectable for tests. */
export type ChatFn = (
  messages: ChatMessage[],
  tools: ToolDef[] | undefined,
  callbacks: ChatCallbacks,
  signal: AbortSignal,
) => Promise<ChatResult>;

/* ------------------------------------------------------------------ */
/* Streaming call                                                      */
/* ------------------------------------------------------------------ */

interface StreamDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface StreamChunk {
  choices?: Array<{ delta?: StreamDelta; finish_reason?: string | null }>;
}

/** Accumulates GLM's fragmented tool-call deltas, keyed by `index`. */
interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

async function readErrorBody(res: Response): Promise<{ code: string; message: string }> {
  const fallback = { code: `http-${res.status}`, message: `GLM request failed (${res.status}).` };
  try {
    const body: unknown = await res.json();
    const err = (body as { error?: { code?: unknown; message?: unknown } }).error;
    if (err && typeof err.message === "string") {
      return { code: typeof err.code === "string" ? err.code : fallback.code, message: err.message };
    }
  } catch {
    // Non-JSON error body; fall through.
  }
  return fallback;
}

/**
 * One streaming chat-completions call. Resolves after `data: [DONE]` (or
 * stream end) with the full assembled result; fragments are surfaced through
 * `callbacks` as they arrive.
 */
export async function streamChat(
  config: GlmConfig,
  messages: ChatMessage[],
  tools: ToolDef[] | undefined,
  callbacks: ChatCallbacks,
  signal: AbortSignal,
): Promise<ChatResult> {
  // GLM-5.x cannot disable reasoning — steer it with reasoning_effort
  // instead. GLM-4.x honors the thinking toggle (default disabled).
  const thinkingEnabled = config.thinking === "enabled" || /^glm-5/i.test(config.model);

  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      max_tokens: config.maxTokens,
      temperature: config.temperature,
      thinking: { type: thinkingEnabled ? "enabled" : "disabled" },
      ...(thinkingEnabled ? { reasoning_effort: config.reasoningEffort } : {}),
      stream: true,
      ...(tools && tools.length > 0 ? { tools, tool_choice: "auto", tool_stream: true } : {}),
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    const { code, message } = await readErrorBody(res);
    throw new GlmApiError(res.status, code, message);
  }

  let content = "";
  let finishReason: string | null = null;
  const toolAccs = new Map<number, ToolCallAccumulator>();

  const handleChunk = (chunk: StreamChunk): void => {
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};
    if (delta.reasoning_content) callbacks.onReasoning?.(delta.reasoning_content);
    if (delta.content) {
      content += delta.content;
      callbacks.onContent?.(delta.content);
    }
    for (const [i, tc] of (delta.tool_calls ?? []).entries()) {
      const index = tc.index ?? i;
      const acc = toolAccs.get(index) ?? { id: "", name: "", arguments: "" };
      if (tc.id) acc.id = tc.id;
      if (tc.function?.name) acc.name = tc.function.name;
      if (tc.function?.arguments) acc.arguments += tc.function.arguments;
      toolAccs.set(index, acc);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  const handleLine = (rawLine: string): void => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      handleChunk(JSON.parse(payload) as StreamChunk);
    } catch {
      // A malformed SSE line is dropped rather than killing the stream.
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    }
    // A stream that ends without a trailing newline still has its last event
    // (and any bytes held by the decoder) sitting in the buffer — flush both.
    buffer += decoder.decode();
    if (buffer) handleLine(buffer);
  } finally {
    reader.releaseLock();
  }

  const toolCalls = [...toolAccs.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, acc]) => ({
      id: acc.id,
      type: "function" as const,
      function: { name: acc.name, arguments: acc.arguments },
    }))
    .filter((tc) => tc.id && tc.function.name);

  return { content, toolCalls, finishReason };
}

/** Bind streamChat to a config, yielding the loop's ChatFn dependency. */
export function createChatFn(config: GlmConfig): ChatFn {
  return (messages, tools, callbacks, signal) =>
    streamChat(config, messages, tools, callbacks, signal);
}
