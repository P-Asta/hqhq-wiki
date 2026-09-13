/**
 * Search results list (decisions O7). Server component.
 *
 * Snippets arrive from FTS5 `snippet()` with literal `<mark>`/`</mark>`
 * highlight tokens around match terms; everything else in the snippet is
 * plain text. We never inject that string as HTML — it is split on the
 * tokens and rendered as text nodes + real `<mark>` elements, so any markup
 * characters living in article text stay inert.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import { ButtonLink } from "@/components/ui/button";
import type { SearchResult } from "@/lib/db/queries";
import { articleHref } from "@/lib/locale-path";
import { nsPrefix } from "@/lib/title";

const MARK_OPEN = "<mark>";
const MARK_CLOSE = "</mark>";

/** Sanitize + structure an FTS snippet: text nodes and <mark> elements only. */
export function renderSnippet(snippet: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const chunks = snippet.split(MARK_OPEN);
  if (chunks[0]) nodes.push(chunks[0]);
  for (let i = 1; i < chunks.length; i++) {
    const closeAt = chunks[i].indexOf(MARK_CLOSE);
    if (closeAt === -1) {
      // Unbalanced token (snippet truncation) — render as plain text.
      nodes.push(chunks[i]);
      continue;
    }
    const marked = chunks[i].slice(0, closeAt);
    const rest = chunks[i].slice(closeAt + MARK_CLOSE.length);
    if (marked) {
      nodes.push(
        <mark key={i} className="rounded-[2px] bg-link-soft px-0.5 text-inherit">
          {marked}
        </mark>,
      );
    }
    if (rest) nodes.push(rest);
  }
  return nodes;
}

export interface SearchResultsLabels {
  /** Accessible/hover name of the "EN" chip (search.enChip). */
  enChip: string;
}

export interface SearchResultsProps {
  locale: string;
  results: SearchResult[];
  labels: SearchResultsLabels;
}

export function SearchResults({ locale, results, labels }: SearchResultsProps) {
  return (
    <ol className="flex flex-col">
      {results.map((result) => {
        const path = `${nsPrefix(result.namespace)}${result.slug}`;
        const href = articleHref(locale, result.namespace, result.slug);
        return (
          <li
            key={`${result.pageId}:${result.locale}`}
            className="border-b border-hairline py-4 last:border-b-0"
          >
            <div className="flex items-center gap-2">
              <Link
                href={href}
                className="focus-ring rounded-[2px] text-[15px] font-medium text-link hover:underline"
              >
                {result.title}
              </Link>
              {result.fallbackFromEn ? (
                <span
                  title={labels.enChip}
                  aria-label={labels.enChip}
                  className="inline-flex items-center rounded-full border border-hairline bg-canvas-soft px-1.5 py-px font-mono text-[11px] leading-4 text-mute"
                >
                  EN
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 font-mono text-xs text-faint">{path}</p>
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-body">
              {renderSnippet(result.snippet)}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ */
/* Create-from-search (decisions-v2 O14.5)                             */
/* ------------------------------------------------------------------ */

export interface CreatePageActionProps {
  /** The ARTICLE url of the title — visiting it is the create flow (O14.1). */
  href: string;
  /** Pre-formatted "Create “<query>”" (search.createTitle). */
  label: string;
  /** search.createDescription. */
  description: string;
}

/**
 * O14.5: a query with no exact title match gets a prominent "Create <query>"
 * action. It links at the article URL, not at `/edit` — visiting the article
 * URL is what opens the editor now.
 */
export function CreatePageAction({ href, label, description }: CreatePageActionProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-hairline bg-canvas-soft px-4 py-3">
      <p className="min-w-0 text-sm text-mute">{description}</p>
      <ButtonLink href={href} size="sm">
        {label}
      </ButtonLink>
    </div>
  );
}
