/**
 * Wire protocol of the wiki Q&A agent (scripts/agent-server.ts): the JSON
 * messages exchanged over the WebSocket between the AskView island (hosted
 * in the AskDock side panel) and the standalone agent process. Universal
 * module — no "server-only", no runtime deps — so the client island can
 * import it without dragging zod or drizzle-orm into the browser bundle; the
 * server validates inbound frames with the schemas in ./protocol-schema.ts.
 */

import type { Namespace } from "@/lib/db/schema";

/**
 * Wire copy of schema.ts NAMESPACES — literal so this module (imported by the
 * client island) never drags drizzle-orm into the browser bundle. `satisfies`
 * proves every entry is a real Namespace; the guard type below proves no
 * Namespace is missing, so drift in either direction fails typecheck.
 */
export const WIRE_NAMESPACES = [
  "main",
  "template",
  "category",
  "file",
  "project",
] as const satisfies readonly Namespace[];

type MissingWireNamespace = Exclude<Namespace, (typeof WIRE_NAMESPACES)[number]>;
type WireNamespacesComplete = [MissingWireNamespace] extends [never]
  ? true
  : ["WIRE_NAMESPACES is missing", MissingWireNamespace];
// Fails to compile when schema.ts NAMESPACES gains an entry this list lacks.
const wireNamespacesComplete: WireNamespacesComplete = true;
void wireNamespacesComplete;

/** Longest question the server accepts, in characters. */
export const MAX_QUESTION_CHARS = 4000;
/** Prior turns the client may replay for conversational context. */
export const MAX_HISTORY_TURNS = 12;
/** Longest replayed turn, in characters (answers are truncated client-side). */
export const MAX_HISTORY_CHARS = 8000;
/**
 * Total characters across all replayed turns. Keeps the worst-case ask frame
 * (question + history + JSON overhead, up to 3 bytes/char in UTF-8) well
 * under the server's WebSocket maxPayload, and bounds GLM prompt cost.
 */
export const MAX_HISTORY_TOTAL_CHARS = 24_000;

/* ------------------------------------------------------------------ */
/* Client → server                                                     */
/* ------------------------------------------------------------------ */

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * The wiki page open in the asker's browser (the AskView island reads this
 * from the URL — see src/lib/agent/current-page.ts), or `null` off an
 * article page. Lets the agent answer "this page" / "here" questions and
 * nudges it to read the page the user is actually looking at.
 */
export interface PageContext {
  namespace: Namespace;
  slug: string;
}

export interface AskMessage {
  type: "ask";
  question: string;
  /** UI locale of the asker; drives search locale and EN fallback. */
  locale: string;
  history: HistoryTurn[];
  page: PageContext | null;
}

export type ClientMessage = AskMessage;

/* ------------------------------------------------------------------ */
/* Server → client                                                     */
/* ------------------------------------------------------------------ */

/** A wiki page the agent read while answering; the UI links these. */
export interface SourceRef {
  namespace: Namespace;
  slug: string;
  title: string;
  locale: string;
}

export type ServerEvent =
  /** The question was accepted and a run started. */
  | { type: "ack" }
  /**
   * The model invoked a tool; `label` is display text (query or title).
   * `page` is set only for a successful read_page — the client links to it.
   */
  | { type: "tool_call"; tool: string; label: string; page?: SourceRef }
  /** The tool returned; `count` = result rows where that makes sense. */
  | { type: "tool_result"; tool: string; label: string; count?: number }
  /** A fragment of the streamed answer. */
  | { type: "delta"; text: string }
  /**
   * The run finished; `sources` = pages read, deduped, in read order.
   * `links` resolves every `[[Title]]` mention the model wrote inline in the
   * answer (see loop.ts) to the real page it names, keyed by the exact raw
   * text between the brackets — a title absent from this map didn't resolve
   * (hallucinated or nonexistent) and renders as plain text.
   */
  | { type: "done"; sources: SourceRef[]; links: Record<string, SourceRef> }
  /** The run failed (or the frame was rejected); the socket stays open. */
  | { type: "error"; code: string; message: string };

/** Runtime check used by the client before trusting a parsed frame. */
export function isServerEvent(value: unknown): value is ServerEvent {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === "ack" ||
    type === "tool_call" ||
    type === "tool_result" ||
    type === "delta" ||
    type === "done" ||
    type === "error"
  );
}
