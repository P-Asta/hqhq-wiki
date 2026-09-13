/**
 * Wiki tools exposed to the GLM agent (function calling): full-text search
 * over the FTS5 index and plain-text page reads from the search_docs mirror.
 *
 * Read-only by design — the toolset touches search(), getPageView() and
 * search_docs, never the write paths. Imports stay on the plain-Node-safe
 * modules (client/queries/schema); src/lib/wiki/service.ts is server-only
 * and must not be pulled into scripts/agent-server.ts.
 */

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { WikiDb } from "@/lib/db/client";
import { getPageView, search } from "@/lib/db/queries";
import { NAMESPACES, searchDocs, type Namespace } from "@/lib/db/schema";
import { parseTitle } from "@/lib/title";

import type { ToolDef } from "./glm";
import type { SourceRef } from "./protocol";

/** Search hits per call (the model may ask for fewer, never more). */
export const MAX_SEARCH_LIMIT = 8;
/** Page text handed to the model, in characters — keeps prompts bounded. */
export const MAX_PAGE_CHARS = 6000;

export interface ToolExecution {
  /** JSON (or plain-text notice) returned to the model as the tool result. */
  result: string;
  /** Pages actually read — cited to the user in the `done` event. */
  sources: SourceRef[];
  /** Display text for the tool_call / tool_result events. */
  label: string;
  /** Result-row count, where counting makes sense. */
  count?: number;
}

export interface AgentToolset {
  definitions: ToolDef[];
  execute(name: string, argsJson: string): ToolExecution;
  /**
   * Resolve every `[[Title]]` the model wrote inline in its own answer
   * (loop.ts) to the real page it names, keyed by the exact raw text between
   * the brackets. A title that doesn't resolve (hallucinated, red-linked,
   * unstorable namespace) is simply absent — never guessed at.
   */
  resolveInlineLinks(rawTitles: string[]): Record<string, SourceRef>;
}

/* ------------------------------------------------------------------ */
/* Argument schemas                                                    */
/* ------------------------------------------------------------------ */

const searchArgsSchema = z.object({
  query: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
});

const readPageArgsSchema = z.object({
  slug: z.string().trim().min(1).max(300),
  namespace: z.enum(NAMESPACES).optional(),
  locale: z.string().trim().min(2).max(16).optional(),
});

/* ------------------------------------------------------------------ */
/* Definitions (GLM function-calling schema)                           */
/* ------------------------------------------------------------------ */

const SEARCH_WIKI_DEF: ToolDef = {
  type: "function",
  function: {
    name: "search_wiki",
    description:
      "Full-text search over the wiki. Returns matching pages with their namespace, slug and a " +
      "short snippet. Call read_page with a hit's namespace and slug to read its full text. " +
      "Search in the user's language first; if nothing relevant comes back, retry in English.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms (a few keywords work best)." },
        limit: {
          type: "integer",
          description: `Maximum hits to return, 1-${MAX_SEARCH_LIMIT} (default 5).`,
        },
      },
      required: ["query"],
    },
  },
};

const READ_PAGE_DEF: ToolDef = {
  type: "function",
  function: {
    name: "read_page",
    description:
      "Read a wiki page's full plain text by slug (redirects are followed; a locale without a " +
      "translation falls back to English). Always read a page before answering from it.",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Page slug, exactly as returned by search_wiki." },
        namespace: {
          type: "string",
          enum: [...NAMESPACES],
          description: 'Page namespace from search_wiki (default "main").',
        },
        locale: {
          type: "string",
          description: "Locale to read (defaults to the asker's locale, with English fallback).",
        },
      },
      required: ["slug"],
    },
  },
};

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

/** `<mark>`/`</mark>` and the FTS ellipsis stay out of model input. */
function stripSnippet(snippet: string): string {
  return snippet.replace(/<\/?mark>/g, "");
}

function invalidArgs(label: string, detail: string): ToolExecution {
  return {
    result: `Invalid arguments: ${detail}. Fix the arguments and call the tool again.`,
    sources: [],
    label,
  };
}

/** search_docs row for (pageId, locale) — the ready-made plain text. */
function readBody(db: WikiDb, pageId: number, locale: string): { body: string } | undefined {
  return db
    .select({ body: searchDocs.body })
    .from(searchDocs)
    .where(and(eq(searchDocs.pageId, pageId), eq(searchDocs.locale, locale)))
    .get();
}

function executeSearch(db: WikiDb, uiLocale: string, argsJson: string): ToolExecution {
  let raw: unknown;
  try {
    raw = JSON.parse(argsJson || "{}");
  } catch {
    return invalidArgs("search_wiki", "arguments are not valid JSON");
  }
  const parsed = searchArgsSchema.safeParse(raw);
  if (!parsed.success) return invalidArgs("search_wiki", parsed.error.issues[0]?.message ?? "bad input");

  const { query, limit } = parsed.data;
  const hits = search(db, query, { locale: uiLocale, limit: limit ?? 5 });
  const rows = hits.map((h) => ({
    title: h.title,
    namespace: h.namespace,
    slug: h.slug,
    locale: h.locale,
    snippet: stripSnippet(h.snippet),
  }));
  return {
    result:
      rows.length > 0
        ? JSON.stringify(rows)
        : "No pages matched. Try different or fewer keywords (or English terms).",
    sources: [],
    label: query,
    count: rows.length,
  };
}

function executeReadPage(db: WikiDb, uiLocale: string, argsJson: string): ToolExecution {
  let raw: unknown;
  try {
    raw = JSON.parse(argsJson || "{}");
  } catch {
    return invalidArgs("read_page", "arguments are not valid JSON");
  }
  const parsed = readPageArgsSchema.safeParse(raw);
  if (!parsed.success) return invalidArgs("read_page", parsed.error.issues[0]?.message ?? "bad input");

  const namespace: Namespace = parsed.data.namespace ?? "main";
  const locale = parsed.data.locale ?? uiLocale;
  const requested = { namespace, slug: parsed.data.slug, locale };

  let view = getPageView(db, requested);
  if (view.kind === "redirect") {
    // One hop, like the read view (service.ts renderPage).
    view = getPageView(db, {
      namespace: view.to.namespace,
      slug: view.to.slug,
      locale,
      followRedirect: false,
    });
  }
  if (view.kind !== "page") {
    return {
      result: `Page not found: ${namespace}:${parsed.data.slug}. Use search_wiki to find the exact slug.`,
      sources: [],
      label: parsed.data.slug,
    };
  }

  // servedLocale's mirror row should exist; EN is the last-resort fallback.
  const doc = readBody(db, view.pageId, view.servedLocale) ?? readBody(db, view.pageId, "en");
  if (!doc) {
    return {
      result: `Page ${namespace}:${view.slug} has no readable text.`,
      sources: [],
      label: view.title,
    };
  }

  const truncated = doc.body.length > MAX_PAGE_CHARS;
  const content = truncated ? `${doc.body.slice(0, MAX_PAGE_CHARS)} …[truncated]` : doc.body;
  return {
    result: JSON.stringify({
      title: view.title,
      namespace: view.namespace,
      slug: view.slug,
      locale: view.servedLocale,
      truncated,
      content,
    }),
    sources: [
      {
        namespace: view.namespace,
        slug: view.slug,
        title: view.title,
        locale: view.servedLocale,
      },
    ],
    label: view.title,
  };
}

/**
 * Resolve one `[[Title]]` mention (agent-generated inline link markup)
 * exactly like the wiki's own wikilinks do: parseTitle's namespace/slug
 * algorithm, one redirect hop, O7 EN fallback (same rules as read_page and
 * the article view). Null for anything unparseable, unstorable, or that
 * doesn't exist.
 */
function resolveInlineLink(db: WikiDb, rawTitle: string, uiLocale: string): SourceRef | null {
  const parsed = parseTitle(rawTitle);
  if (!parsed || !parsed.storable || parsed.nsName === null) return null;

  let view = getPageView(db, { namespace: parsed.nsName, slug: parsed.slug, locale: uiLocale });
  if (view.kind === "redirect") {
    view = getPageView(db, {
      namespace: view.to.namespace,
      slug: view.to.slug,
      locale: uiLocale,
      followRedirect: false,
    });
  }
  if (view.kind !== "page") return null;
  return { namespace: view.namespace, slug: view.slug, title: view.title, locale: view.servedLocale };
}

/** The toolset the agent loop hands to GLM, bound to one db + UI locale. */
export function createWikiToolset(db: WikiDb, uiLocale: string): AgentToolset {
  return {
    definitions: [SEARCH_WIKI_DEF, READ_PAGE_DEF],
    execute(name, argsJson) {
      if (name === "search_wiki") return executeSearch(db, uiLocale, argsJson);
      if (name === "read_page") return executeReadPage(db, uiLocale, argsJson);
      return {
        result: `Unknown tool "${name}". Available tools: search_wiki, read_page.`,
        sources: [],
        label: name,
      };
    },
    resolveInlineLinks(rawTitles) {
      const out: Record<string, SourceRef> = {};
      for (const raw of rawTitles) {
        if (!raw) continue;
        const ref = resolveInlineLink(db, raw, uiLocale);
        if (ref) out[raw] = ref;
      }
      return out;
    },
  };
}
