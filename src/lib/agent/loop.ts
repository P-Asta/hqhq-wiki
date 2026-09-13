/**
 * The agent loop: question in, streamed wiki-grounded answer out.
 *
 * One run = up to MAX_TOOL_ROUNDS GLM calls. While the model keeps returning
 * tool_calls, each call is executed (search_wiki / read_page), its result
 * appended as a role:"tool" message — after echoing the assistant tool_calls
 * message back verbatim, which the API requires — and the conversation
 * re-sent. The final round withholds the tools so the model must answer.
 * Every observable step is pushed through `emit` as a protocol ServerEvent.
 *
 * The system prompt asks the model to wrap any OTHER wiki page it mentions
 * in `[[Title]]` (the wiki's own wikilink syntax); once the full answer is
 * known, every distinct mention is resolved against the database (redirect
 * hop + EN fallback, same as read_page) and shipped as the `done` event's
 * `links` map, so the client can turn real mentions into hyperlinks and
 * quietly drop the brackets around anything hallucinated.
 */

import type { ChatFn, ChatMessage } from "./glm";
import type { ServerEvent, HistoryTurn, PageContext, SourceRef } from "./protocol";
import type { AgentToolset } from "./tools";

/** Tool-executing GLM calls per run; the round after them answers tool-less. */
export const MAX_TOOL_ROUNDS = 6;

/** `[[Title]]` — the wiki's own wikilink syntax, reused for inline mentions. */
const INLINE_LINK_PATTERN = /\[\[([^[\]]+)\]\]/g;

export interface RunAgentInput {
  question: string;
  history: HistoryTurn[];
  /** UI locale of the asker (search locale; the answer follows the question). */
  locale: string;
  /** Wiki display name for the system prompt. */
  siteName: string;
  /** The page open in the asker's browser, if any (current-page.ts). */
  page: PageContext | null;
  chat: ChatFn;
  tools: AgentToolset;
  emit: (event: ServerEvent) => void;
  signal: AbortSignal;
}

function buildSystemPrompt(siteName: string, locale: string, page: PageContext | null): string {
  const lines = [
    `You are the Q&A assistant of ${siteName}, a game wiki. You answer questions strictly from`,
    `the wiki's own content.`,
    ``,
    `Rules:`,
    `- Use search_wiki to find candidate pages, then read_page to read them, BEFORE answering.`,
    `  Never answer about the game from your own general knowledge.`,
    `- Call tools directly, without narrating what you are about to do first.`,
    `- Search in the user's language first; if nothing relevant is found, retry in English`,
    `  (English is the wiki's canonical locale).`,
    `- If the wiki does not contain the answer, say so plainly instead of guessing.`,
    `- Answer in the same language as the user's question.`,
    `- Keep answers concise. Name the wiki page(s) the information came from.`,
    `- Write plain text only — no Markdown syntax (no **, ##, bullet asterisks or backticks). The`,
    `  one exception: wrap the name of any OTHER wiki page you mention in double brackets, exactly`,
    `  like this wiki's own link syntax, e.g. "[[Zap Gun]]" — only for pages you actually found via`,
    `  search_wiki or read_page; never invent one.`,
    ``,
    `The asker's interface locale is "${locale}".`,
  ];
  if (page) {
    lines.push(
      ``,
      `The asker is currently viewing the wiki page "${page.namespace}:${page.slug}". When their ` +
        `question is about "this page", "here", or is otherwise unspecific, read_page this one first.`,
    );
  }
  return lines.join("\n");
}

/** Dedupe by (namespace, slug, locale), preserving first-read order. */
function dedupeSources(sources: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const s of sources) {
    const key = `${s.namespace}:${s.slug}:${s.locale}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * Run one question to completion, emitting protocol events along the way.
 * Rejects on transport/API failure (the caller maps that to an error event);
 * an abort surfaces as the fetch's AbortError.
 */
export async function runAgent(input: RunAgentInput): Promise<void> {
  const { chat, tools, emit, signal } = input;

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(input.siteName, input.locale, input.page) },
    ...input.history.map(
      (turn): ChatMessage => ({ role: turn.role, content: turn.content }),
    ),
    { role: "user", content: input.question },
  ];

  const sources: SourceRef[] = [];
  // Mirrors exactly what the client accumulates from "delta" events (the
  // same text, in the same order, separators included) so the [[Title]]
  // mentions resolved below key onto the identical substrings the client
  // will scan for when it renders the answer.
  let fullAnswerText = "";
  // Deltas stream live even in tool rounds (the model may talk before it
  // calls a tool). When that happened, separate it from the next round's text
  // so chatter and answer don't concatenate into one run-on paragraph.
  let emittedThisRound = false;
  let needSeparator = false;
  const callbacks = {
    onContent: (text: string) => {
      if (!text) return;
      if (needSeparator) {
        fullAnswerText += "\n\n";
        emit({ type: "delta", text: "\n\n" });
        needSeparator = false;
      }
      emittedThisRound = true;
      fullAnswerText += text;
      emit({ type: "delta", text });
    },
  };

  // Round MAX_TOOL_ROUNDS runs tool-less, forcing a final answer.
  for (let round = 0; ; round++) {
    const offerTools = round < MAX_TOOL_ROUNDS;
    emittedThisRound = false;
    const result = await chat(
      messages,
      offerTools ? tools.definitions : undefined,
      callbacks,
      signal,
    );

    if (!offerTools || result.toolCalls.length === 0) {
      const rawTitles = [
        ...new Set([...fullAnswerText.matchAll(INLINE_LINK_PATTERN)].map((m) => m[1].trim())),
      ].filter(Boolean);
      const links = rawTitles.length > 0 ? tools.resolveInlineLinks(rawTitles) : {};
      emit({ type: "done", sources: dedupeSources(sources), links });
      return;
    }

    if (emittedThisRound) needSeparator = true;
    messages.push({
      role: "assistant",
      content: result.content,
      tool_calls: result.toolCalls,
    });
    for (const call of result.toolCalls) {
      if (signal.aborted) throw new DOMException("Run aborted.", "AbortError");
      const name = call.function.name;
      const execution = tools.execute(name, call.function.arguments);
      // sources[0] is set only for a successful read_page — the client
      // turns the activity row into a link to that page.
      emit({ type: "tool_call", tool: name, label: execution.label, page: execution.sources[0] });
      emit({ type: "tool_result", tool: name, label: execution.label, count: execution.count });
      sources.push(...execution.sources);
      messages.push({ role: "tool", content: execution.result, tool_call_id: call.id });
    }
  }
}
