/** Agent loop (loop.ts) with a scripted ChatFn and a recording toolset. */

import { describe, expect, it } from "vitest";

import type { ChatFn, ChatMessage, ChatResult, ToolCall } from "./glm";
import { MAX_TOOL_ROUNDS, runAgent } from "./loop";
import type { PageContext, ServerEvent, SourceRef } from "./protocol";
import type { AgentToolset, ToolExecution } from "./tools";

function toolCall(id: string, name: string, args: object): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function recordingToolset(
  executions: Record<string, ToolExecution>,
  resolveInlineLinks: (rawTitles: string[]) => Record<string, SourceRef> = () => ({}),
): {
  toolset: AgentToolset;
  calls: Array<{ name: string; args: string }>;
} {
  const calls: Array<{ name: string; args: string }> = [];
  return {
    calls,
    toolset: {
      definitions: [
        { type: "function", function: { name: "search_wiki", description: "", parameters: {} } },
        { type: "function", function: { name: "read_page", description: "", parameters: {} } },
      ],
      execute(name, args) {
        calls.push({ name, args });
        return executions[name] ?? { result: "ok", sources: [], label: name };
      },
      resolveInlineLinks,
    },
  };
}

function run(
  chat: ChatFn,
  toolset: AgentToolset,
  page: PageContext | null = null,
): Promise<{ events: ServerEvent[] }> {
  const events: ServerEvent[] = [];
  return runAgent({
    question: "타이탄이 뭐야?",
    history: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
    locale: "ko",
    siteName: "HQHQ Wiki",
    page,
    chat,
    tools: toolset,
    emit: (e) => events.push(e),
    signal: new AbortController().signal,
  }).then(() => ({ events }));
}

describe("runAgent", () => {
  it("runs the tool round-trip and emits events in order", async () => {
    const { toolset, calls } = recordingToolset({
      search_wiki: { result: "[]", sources: [], label: "titan", count: 1 },
      read_page: {
        result: "{}",
        sources: [{ namespace: "main", slug: "titan", title: "Titan", locale: "ko" }],
        label: "Titan",
      },
    });

    const transcripts: ChatMessage[][] = [];
    const script: ChatResult[] = [
      { content: "", toolCalls: [toolCall("c1", "search_wiki", { query: "titan" })], finishReason: "tool_calls" },
      { content: "", toolCalls: [toolCall("c2", "read_page", { slug: "titan" })], finishReason: "tool_calls" },
      { content: "", toolCalls: [], finishReason: "stop" },
    ];
    const chat: ChatFn = async (messages, _tools, callbacks) => {
      transcripts.push(messages.map((m) => ({ ...m })));
      const step = script.shift();
      if (!step) throw new Error("chat called too often");
      if (script.length === 0) {
        callbacks.onContent?.("타이탄은 ");
        callbacks.onContent?.("보스입니다.");
        return { ...step, content: "타이탄은 보스입니다." };
      }
      return step;
    };

    const { events } = await run(chat, toolset);

    expect(calls).toEqual([
      { name: "search_wiki", args: '{"query":"titan"}' },
      { name: "read_page", args: '{"slug":"titan"}' },
    ]);
    expect(events).toEqual([
      { type: "tool_call", tool: "search_wiki", label: "titan" },
      { type: "tool_result", tool: "search_wiki", label: "titan", count: 1 },
      {
        type: "tool_call",
        tool: "read_page",
        label: "Titan",
        page: { namespace: "main", slug: "titan", title: "Titan", locale: "ko" },
      },
      { type: "tool_result", tool: "read_page", label: "Titan", count: undefined },
      { type: "delta", text: "타이탄은 " },
      { type: "delta", text: "보스입니다." },
      {
        type: "done",
        sources: [{ namespace: "main", slug: "titan", title: "Titan", locale: "ko" }],
        links: {},
      },
    ]);

    // The final transcript carries the echoed assistant tool_calls message and
    // the paired role:"tool" results (GLM requires the pairing).
    const finalMessages = transcripts[2];
    expect(finalMessages[0].role).toBe("system");
    expect(finalMessages[1]).toEqual({ role: "user", content: "hi" });
    expect(finalMessages[2]).toEqual({ role: "assistant", content: "hello" });
    expect(finalMessages[3]).toEqual({ role: "user", content: "타이탄이 뭐야?" });
    expect(finalMessages[4]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "c1" }],
    });
    expect(finalMessages[5]).toEqual({ role: "tool", content: "[]", tool_call_id: "c1" });
    expect(finalMessages[6]).toMatchObject({ role: "assistant", tool_calls: [{ id: "c2" }] });
    expect(finalMessages[7]).toEqual({ role: "tool", content: "{}", tool_call_id: "c2" });
  });

  it("separates pre-tool chatter from the next round's text with a blank line", async () => {
    const { toolset } = recordingToolset({
      search_wiki: { result: "[]", sources: [], label: "titan", count: 0 },
    });
    const script: ChatResult[] = [
      // The model narrates, then calls a tool anyway.
      { content: "Let me check.", toolCalls: [toolCall("c1", "search_wiki", { query: "titan" })], finishReason: "tool_calls" },
      { content: "Titans are bosses.", toolCalls: [], finishReason: "stop" },
    ];
    const chat: ChatFn = async (_messages, _tools, callbacks) => {
      const step = script.shift();
      if (!step) throw new Error("chat called too often");
      if (step.content) callbacks.onContent?.(step.content);
      return step;
    };

    const { events } = await run(chat, toolset);
    const deltas = events.flatMap((e) => (e.type === "delta" ? [e.text] : []));
    expect(deltas).toEqual(["Let me check.", "\n\n", "Titans are bosses."]);
  });

  it("dedupes repeated sources in the done event", async () => {
    const { toolset } = recordingToolset({
      read_page: {
        result: "{}",
        sources: [{ namespace: "main", slug: "titan", title: "Titan", locale: "en" }],
        label: "Titan",
      },
    });
    const script: ChatResult[] = [
      { content: "", toolCalls: [toolCall("c1", "read_page", { slug: "titan" })], finishReason: "tool_calls" },
      { content: "", toolCalls: [toolCall("c2", "read_page", { slug: "titan" })], finishReason: "tool_calls" },
      { content: "done", toolCalls: [], finishReason: "stop" },
    ];
    const chat: ChatFn = async () => {
      const step = script.shift();
      if (!step) throw new Error("chat called too often");
      return step;
    };

    const { events } = await run(chat, toolset);
    const done = events.find((e) => e.type === "done");
    expect(done).toEqual({
      type: "done",
      sources: [{ namespace: "main", slug: "titan", title: "Titan", locale: "en" }],
      links: {},
    });
  });

  it("withholds tools after MAX_TOOL_ROUNDS to force an answer", async () => {
    const { toolset } = recordingToolset({});
    const toolsOffered: boolean[] = [];
    const chat: ChatFn = async (_messages, tools) => {
      toolsOffered.push(tools !== undefined);
      // Always asks for another search — a runaway model.
      return {
        content: "",
        toolCalls: tools ? [toolCall("c", "search_wiki", { query: "again" })] : [],
        finishReason: tools ? "tool_calls" : "stop",
      };
    };

    const { events } = await run(chat, toolset);
    expect(toolsOffered).toHaveLength(MAX_TOOL_ROUNDS + 1);
    expect(toolsOffered.at(-1)).toBe(false);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("propagates chat failures to the caller", async () => {
    const { toolset } = recordingToolset({});
    const chat: ChatFn = async () => {
      throw new Error("boom");
    };
    const events: ServerEvent[] = [];
    await expect(
      runAgent({
        question: "q",
        history: [],
        locale: "en",
        siteName: "W",
        page: null,
        chat,
        tools: toolset,
        emit: (e) => events.push(e),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("boom");
    expect(events).toEqual([]);
  });

  it("resolves [[Title]] mentions in the answer into the done event's links", async () => {
    const resolved: Record<string, SourceRef> = {
      "Zap Gun": { namespace: "main", slug: "zap-gun", title: "Zap Gun", locale: "en" },
    };
    const seenTitles: string[][] = [];
    const { toolset } = recordingToolset({}, (titles) => {
      seenTitles.push(titles);
      return resolved;
    });
    const chat: ChatFn = async (_messages, _tools, callbacks) => {
      callbacks.onContent?.("Use the [[Zap Gun]] to stun it.");
      return { content: "Use the [[Zap Gun]] to stun it.", toolCalls: [], finishReason: "stop" };
    };

    const { events } = await run(chat, toolset);
    expect(seenTitles).toEqual([["Zap Gun"]]);
    const done = events.find((e) => e.type === "done");
    expect(done).toEqual({ type: "done", sources: [], links: resolved });
  });

  it("dedupes repeated [[Title]] mentions before resolving", async () => {
    const seenTitles: string[][] = [];
    const { toolset } = recordingToolset({}, (titles) => {
      seenTitles.push(titles);
      return {};
    });
    const chat: ChatFn = async (_messages, _tools, callbacks) => {
      callbacks.onContent?.("[[Jester]] appears near [[Jester]] and [[Zap Gun]].");
      return { content: "", toolCalls: [], finishReason: "stop" };
    };

    await run(chat, toolset);
    expect(seenTitles).toEqual([["Jester", "Zap Gun"]]);
  });

  it("skips link resolution entirely when the answer has no bracket mentions", async () => {
    let called = false;
    const { toolset } = recordingToolset({}, () => {
      called = true;
      return {};
    });
    const chat: ChatFn = async (_messages, _tools, callbacks) => {
      callbacks.onContent?.("No links here.");
      return { content: "No links here.", toolCalls: [], finishReason: "stop" };
    };

    const { events } = await run(chat, toolset);
    expect(called).toBe(false);
    expect(events.find((e) => e.type === "done")).toMatchObject({ links: {} });
  });

  it("mentions the current page in the system prompt when provided", async () => {
    const { toolset } = recordingToolset({});
    let systemContent = "";
    const chat: ChatFn = async (messages) => {
      systemContent = messages[0]?.content ?? "";
      return { content: "answer", toolCalls: [], finishReason: "stop" };
    };

    await run(chat, toolset, { namespace: "main", slug: "titan" });
    expect(systemContent).toContain("main:titan");
    expect(systemContent).toContain("currently viewing");
  });

  it("omits page guidance from the system prompt when there is none", async () => {
    const { toolset } = recordingToolset({});
    let systemContent = "";
    const chat: ChatFn = async (messages) => {
      systemContent = messages[0]?.content ?? "";
      return { content: "answer", toolCalls: [], finishReason: "stop" };
    };

    await run(chat, toolset, null);
    expect(systemContent).not.toContain("currently viewing");
  });
});
