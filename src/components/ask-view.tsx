"use client";

/**
 * Ask chat surface, hosted inside the AskDock side panel: talks to the wiki
 * Q&A agent's WebSocket (scripts/agent-server.ts, protocol in
 * src/lib/agent/protocol.ts). Connects lazily on the first question; streams
 * the answer token by token, shows the agent's search/read activity as it
 * happens, links the cited pages under each answer, and — via `renderAnswer`
 * — turns any `[[Title]]` mention INSIDE the answer text into a link to that
 * page once the run resolves it (loop.ts). Fills its parent (flex column):
 * scrolling transcript on top, composer pinned below.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBanner } from "@/components/ui/status-banner";
import { Textarea } from "@/components/ui/textarea";
import { currentPageFromPathname } from "@/lib/agent/current-page";
import {
  MAX_HISTORY_CHARS,
  MAX_HISTORY_TOTAL_CHARS,
  MAX_HISTORY_TURNS,
  MAX_QUESTION_CHARS,
  isServerEvent,
  type AskMessage,
  type HistoryTurn,
  type ServerEvent,
  type SourceRef,
} from "@/lib/agent/protocol";
import { formatMessage } from "@/lib/i18n";
import { articleHref, searchHref } from "@/lib/locale-path";

// Static member access so Next inlines the value into the client bundle.
const AGENT_WS_URL = process.env.NEXT_PUBLIC_WIKI_AGENT_WS_URL || "ws://localhost:8788";

/** Give up on a socket that neither opens nor errors. */
const CONNECT_TIMEOUT_MS = 8000;
/** A run with no server event for this long counts as hung. */
const IDLE_TIMEOUT_MS = 120_000;

export interface AskViewLabels {
  inputLabel: string;
  placeholder: string;
  send: string;
  thinking: string;
  /** "{query}" */
  searchingLine: string;
  /** "{title}" */
  readingLine: string;
  sourcesLabel: string;
  emptyTitle: string;
  emptyDescription: string;
  /** "{message}" */
  errorLine: string;
  connectionError: string;
}

interface ActivityRow {
  tool: string;
  label: string;
  /** Set when this step named a real page/query — makes the row a link. */
  href?: string;
}

interface Turn {
  id: number;
  role: "user" | "assistant";
  content: string;
  /** Assistant only: search/read steps taken while producing this answer. */
  activity: ActivityRow[];
  /** Assistant only: pages the answer came from. */
  sources: SourceRef[];
  /** Assistant only: `[[Title]]` mentions inside `content`, resolved. */
  links: Record<string, SourceRef>;
  /** Assistant only: still streaming. */
  pending: boolean;
}

/**
 * Render `content`, turning every RESOLVED `[[Title]]` span into a link
 * (`links[raw]`) and quietly dropping the brackets around anything else — a
 * hallucinated mention, or one not resolved yet because `links` is still `{}`
 * mid-stream (the run only resolves them once the answer is complete). A
 * `[[` with no closing `]]` yet (the model mid-way through writing one) is
 * held back entirely rather than flashed as raw markup.
 */
export function renderAnswer(
  content: string,
  links: Record<string, SourceRef>,
  locale: string,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /\[\[([^[\]]+)\]\]/g;
  let lastIndex = 0;
  let key = 0;
  for (const match of content.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) nodes.push(content.slice(lastIndex, index));
    const raw = match[1].trim();
    const ref = links[raw];
    nodes.push(
      ref ? (
        <Link
          key={key++}
          href={articleHref(locale, ref.namespace, ref.slug)}
          className="text-link underline decoration-dotted underline-offset-2 hover:decoration-solid"
        >
          {raw}
        </Link>
      ) : (
        raw
      ),
    );
    lastIndex = index + match[0].length;
  }
  const tail = content.slice(lastIndex);
  const pending = /\[\[[^[\]]*$/.exec(tail);
  nodes.push(pending ? tail.slice(0, pending.index) : tail);
  return nodes;
}

export interface AskViewProps {
  locale: string;
  labels: AskViewLabels;
  /** Whether the hosting dock is visible; false = mounted but display:none. */
  open?: boolean;
}

export function AskView({ locale, labels, open = true }: AskViewProps) {
  // "The page the user is looking at" — reactive, so it stays current as the
  // reader navigates while the dock sits open in the background.
  const pathname = usePathname();
  const page = useMemo(() => currentPageFromPathname(pathname ?? ""), [pathname]);

  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const nextIdRef = useRef(1);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Follow the stream only while the reader is at the bottom — scrolling up
  // to re-read must not be yanked back by every delta.
  const followRef = useRef(true);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror of `busy` for socket callbacks, which outlive renders.
  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  // Re-pin on new turns AND on reveal: while the dock is closed the
  // transcript has no layout box (display:none), so scroll writes are no-ops
  // and browsers reset the offset — without the `open` dep, reopening after
  // an answer streamed in the background would show the transcript scrolled
  // to the top.
  useEffect(() => {
    const el = scrollRef.current;
    if (open && el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [open, turns]);

  // The socket outlives questions; close it with the island.
  useEffect(() => {
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, []);

  const patchLastAssistant = useCallback((patch: (turn: Turn) => Turn) => {
    setTurns((prev) => {
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].role === "assistant") {
          const next = [...prev];
          next[i] = patch(prev[i]);
          return next;
        }
      }
      return prev;
    });
  }, []);

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  /** Close a hung run: no server event for IDLE_TIMEOUT_MS ends the socket. */
  const bumpIdleTimer = useCallback(() => {
    clearIdleTimer();
    idleTimerRef.current = setTimeout(() => {
      socketRef.current?.close(); // onclose settles the run with an error
    }, IDLE_TIMEOUT_MS);
  }, [clearIdleTimer]);

  /**
   * End the current run: drop an assistant turn that never produced anything
   * (no half-empty bubble in the transcript, no phantom history entry), keep
   * partial answers, surface `message` when the run failed.
   */
  const settleRun = useCallback(
    (message: string | null) => {
      clearIdleTimer();
      setTurns((prev) =>
        prev
          .filter(
            (t) =>
              !(t.role === "assistant" && t.pending && !t.content && t.activity.length === 0),
          )
          .map((t) => (t.pending ? { ...t, pending: false } : t)),
      );
      if (message) setError(message);
      setBusy(false);
    },
    [clearIdleTimer],
  );

  const handleEvent = useCallback(
    (event: ServerEvent) => {
      bumpIdleTimer();
      switch (event.type) {
        case "ack":
          break;
        case "tool_call": {
          // search_wiki names a query (link to its results); a successful
          // read_page carries the resolved page (link to the article).
          const href =
            event.tool === "search_wiki"
              ? searchHref(locale, event.label)
              : event.page
                ? articleHref(locale, event.page.namespace, event.page.slug)
                : undefined;
          patchLastAssistant((turn) => ({
            ...turn,
            activity: [...turn.activity, { tool: event.tool, label: event.label, href }],
          }));
          break;
        }
        case "tool_result":
          break;
        case "delta":
          patchLastAssistant((turn) => ({ ...turn, content: turn.content + event.text }));
          break;
        case "done":
          clearIdleTimer();
          patchLastAssistant((turn) => ({
            ...turn,
            sources: event.sources,
            links: event.links,
            pending: false,
          }));
          setBusy(false);
          break;
        case "error":
          settleRun(formatMessage(labels.errorLine, { message: event.message }));
          break;
      }
    },
    [bumpIdleTimer, clearIdleTimer, labels.errorLine, locale, patchLastAssistant, settleRun],
  );

  /** Open (or reuse) the socket; resolves once it is ready to send. */
  const connect = useCallback((): Promise<WebSocket> => {
    const existing = socketRef.current;
    if (existing && existing.readyState === WebSocket.OPEN) return Promise.resolve(existing);
    if (existing) existing.close();

    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(AGENT_WS_URL);
      socketRef.current = socket;

      const connectTimer = setTimeout(() => {
        if (!settled) socket.close(); // rejects via onclose
      }, CONNECT_TIMEOUT_MS);

      socket.onopen = () => {
        settled = true;
        clearTimeout(connectTimer);
        resolve(socket);
      };
      socket.onmessage = (msg) => {
        try {
          const parsed: unknown = JSON.parse(String(msg.data));
          if (isServerEvent(parsed)) handleEvent(parsed);
        } catch {
          // Ignore unparseable frames.
        }
      };
      socket.onclose = () => {
        clearTimeout(connectTimer);
        // A superseded socket's late close must not touch the current run —
        // a new ask may already be streaming on the replacement socket.
        const isCurrent = socketRef.current === socket;
        if (isCurrent) socketRef.current = null;
        if (!settled) {
          settled = true;
          reject(new Error("connect-failed"));
          return;
        }
        // A drop (or idle timeout) mid-answer would otherwise spin forever.
        if (isCurrent && busyRef.current) settleRun(labels.connectionError);
      };
      socket.onerror = () => {
        // onclose follows and settles the promise / surfaces the banner.
      };
    });
  }, [handleEvent, labels.connectionError, settleRun]);

  const ask = useCallback(async () => {
    const question = input.trim();
    if (!question || busy) return;

    // Prior completed turns, oldest first, newest kept — capped per turn, per
    // count, AND in total so the frame stays under the server's maxPayload.
    const completed = turns.filter((t) => t.content.trim().length > 0);
    const history: HistoryTurn[] = [];
    let budget = MAX_HISTORY_TOTAL_CHARS;
    for (let i = completed.length - 1; i >= 0 && history.length < MAX_HISTORY_TURNS; i--) {
      const content = completed[i].content.slice(0, MAX_HISTORY_CHARS);
      if (content.length > budget) break;
      budget -= content.length;
      history.unshift({ role: completed[i].role, content });
    }

    setError(null);
    setBusy(true);
    setInput("");
    // Sending snaps back to the bottom even if the reader had scrolled up —
    // the new question and its answer must be visible.
    followRef.current = true;
    setTurns((prev) => [
      ...prev,
      {
        id: nextIdRef.current++,
        role: "user",
        content: question,
        activity: [],
        sources: [],
        links: {},
        pending: false,
      },
      {
        id: nextIdRef.current++,
        role: "assistant",
        content: "",
        activity: [],
        sources: [],
        links: {},
        pending: true,
      },
    ]);

    try {
      const socket = await connect();
      const frame: AskMessage = { type: "ask", question, locale, history, page };
      socket.send(JSON.stringify(frame));
      bumpIdleTimer();
    } catch {
      settleRun(labels.connectionError);
    }
  }, [bumpIdleTimer, busy, connect, input, labels.connectionError, locale, page, settleRun, turns]);

  const activityLine = (row: ActivityRow): string =>
    row.tool === "read_page"
      ? formatMessage(labels.readingLine, { title: row.label })
      : formatMessage(labels.searchingLine, { query: row.label });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 60;
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3"
      >
        {turns.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <EmptyState title={labels.emptyTitle} description={labels.emptyDescription} />
          </div>
        ) : (
          /* aria-live + aria-busy: assistive tech announces the finished answer
             once the busy flag drops, instead of every streamed fragment. */
          <ol className="flex flex-col gap-3" aria-live="polite" aria-busy={busy}>
            {turns.map((turn) =>
              turn.role === "user" ? (
                <li key={turn.id} className="flex justify-end">
                  <p className="max-w-[85%] whitespace-pre-wrap rounded-[var(--radius-md)] bg-canvas-soft px-3 py-2 text-sm leading-relaxed text-ink">
                    {turn.content}
                  </p>
                </li>
              ) : (
                <li key={turn.id} className="flex flex-col gap-2">
                  {turn.activity.length > 0 ? (
                    <ul className="flex flex-col gap-0.5">
                      {turn.activity.map((row, i) => (
                        <li key={i} className="text-[13px] text-faint">
                          {row.href ? (
                            <Link
                              href={row.href}
                              className="underline decoration-dotted underline-offset-2 transition-colors hover:text-mute"
                            >
                              {activityLine(row)}
                            </Link>
                          ) : (
                            activityLine(row)
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {turn.content ? (
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-body">
                      {renderAnswer(turn.content, turn.links, locale)}
                    </p>
                  ) : turn.pending ? (
                    <p className="text-sm text-faint">{labels.thinking}</p>
                  ) : null}
                  {turn.sources.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[13px] font-medium text-mute">
                        {labels.sourcesLabel}
                      </span>
                      {turn.sources.map((source) => (
                        <Link
                          key={`${source.namespace}:${source.slug}:${source.locale}`}
                          href={articleHref(locale, source.namespace, source.slug)}
                          className="focus-ring rounded-[var(--radius-sm)] border border-hairline bg-surface px-2 py-0.5 text-[13px] text-link hover:underline"
                        >
                          {source.title}
                        </Link>
                      ))}
                    </div>
                  ) : null}
                </li>
              ),
            )}
          </ol>
        )}
      </div>

      <div className="shrink-0 border-t border-hairline p-3">
        {error ? (
          <StatusBanner tone="error" className="mb-2">
            {error}
          </StatusBanner>
        ) : null}

        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void ask();
          }}
        >
          <label className="sr-only" htmlFor="ask-question">
            {labels.inputLabel}
          </label>
          <Textarea
            id="ask-question"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // keyCode 229: WebKit fires the composition-committing Enter with
              // isComposing already false — without this, Safari submits it.
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                e.keyCode !== 229
              ) {
                e.preventDefault();
                void ask();
              }
            }}
            placeholder={labels.placeholder}
            maxLength={MAX_QUESTION_CHARS}
            rows={2}
            className="min-h-12 resize-none"
          />
          <Button type="submit" disabled={busy || input.trim().length === 0}>
            {labels.send}
          </Button>
        </form>
      </div>
    </div>
  );
}
