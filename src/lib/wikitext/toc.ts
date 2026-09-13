/**
 * Heading anchors and the table of contents (spec §2.4, §2.5, §2.6).
 *
 * All of this is render-stage work (§14.7): ids are generated from the
 * *rendered* inline content of each heading, deduplicated in document order,
 * and the TOC is built from the same records and spliced either at the first
 * `__TOC__` placeholder or immediately before the first heading.
 *
 * The rendered TOC carries both the MediaWiki-compatible `toc` class and the
 * app's own `wiki-toc` token class (see the class list in render.ts).
 */

import { decodeEntities, escapeAttr, escapeText, stripTags } from "./sanitize";
import type { ParseContext, TocEntry } from "./types";

/* ------------------------------------------------------------------ */
/* §2.4 anchor ids                                                     */
/* ------------------------------------------------------------------ */

/**
 * §2.4 steps 1–3 + 5: rendered HTML → plain text → trimmed, whitespace runs
 * collapsed, spaces replaced by `_`. `fragmentMode: 'html5'` keeps Unicode
 * (Hangul included) as-is; nothing is dot-encoded (D-3). Empty → `_`.
 */
export function anchorIdFromHtml(html: string): string {
  const text = decodeEntities(stripTags(html)).replace(/\s+/g, " ").trim();
  const id = text.replace(/ /g, "_");
  return id === "" ? "_" : id;
}

/**
 * §2.4 step 4: an id placed in a URL fragment is percent-encoded, then `%3A`
 * is reverted to `:` for readability.
 */
export function encodeFragment(id: string): string {
  return encodeURIComponent(id).replace(/%3A/g, ":");
}

/**
 * Per-page unique id allocator (§2.4 "Duplicate handling"): the 2nd occurrence
 * of a base id gets `_2`, the 3rd `_3`; a literal heading that already carries
 * a generated id is bumped again (`Foo_2` → `Foo_2_2`) — uniqueness wins and
 * order of appearance decides.
 */
export class IdAllocator {
  private readonly used = new Set<string>();
  private readonly counts = new Map<string, number>();

  allocate(base: string): string {
    if (!this.used.has(base)) {
      this.used.add(base);
      this.counts.set(base, 1);
      return base;
    }
    let n = this.counts.get(base) ?? 1;
    let candidate: string;
    do {
      n += 1;
      candidate = `${base}_${n}`;
    } while (this.used.has(candidate));
    this.counts.set(base, n);
    this.used.add(candidate);
    return candidate;
  }

  /** Reserve an id that was authored verbatim (raw HTML `id=` attributes). */
  reserve(id: string): void {
    this.used.add(id);
  }

  has(id: string): boolean {
    return this.used.has(id);
  }
}

/* ------------------------------------------------------------------ */
/* §2.5 TOC                                                            */
/* ------------------------------------------------------------------ */

/** One wikitext heading as seen by the renderer, in document order. */
export interface HeadingRecord {
  /** h-level 1..6. */
  level: number;
  /** Final (deduplicated) id. */
  id: string;
  /** Rendered inline HTML of the heading. */
  html: string;
}

/**
 * §2.5: relative TOC levels. A heading deeper than its predecessor increases
 * `tocLevel` by exactly one whatever the jump; a shallower one unwinds to the
 * matching open level. Numbering is hierarchical per tocLevel.
 */
export function buildToc(headings: readonly HeadingRecord[]): TocEntry[] {
  const stack: number[] = [];
  const counters: number[] = [];
  const out: TocEntry[] = [];

  for (const h of headings) {
    while (stack.length > 0 && (stack[stack.length - 1] as number) > h.level) {
      stack.pop();
      counters.pop();
    }
    if (stack.length === 0 || (stack[stack.length - 1] as number) < h.level) {
      stack.push(h.level);
      counters.push(0);
    }
    const depth = stack.length;
    counters[depth - 1] = (counters[depth - 1] as number) + 1;
    out.push({
      level: h.level,
      tocLevel: depth,
      number: counters.slice(0, depth).join("."),
      id: h.id,
      html: flattenTocText(h.html),
    });
  }
  return out;
}

/**
 * §2.5: TOC text keeps formatting but flattens links to their text (a heading
 * containing `[[A|b]]` shows `b`, not a nested `<a>`).
 */
export function flattenTocText(html: string): string {
  return html.replace(/<a\b[^>]*>/g, "").replace(/<\/a>/g, "");
}

/**
 * §2.5 / §2.6 precedence: `__TOC__` > `__FORCETOC__` > `__NOTOC__`, and
 * otherwise a TOC appears from four headings up.
 */
export function shouldShowToc(
  headingCount: number,
  switches: ReadonlySet<string>,
): boolean {
  if (switches.has("TOC")) return true;
  if (switches.has("FORCETOC")) return true;
  if (switches.has("NOTOC")) return false;
  return headingCount >= 4;
}

/** §2.5 output shape (with the app's `wiki-toc` token class added). */
export function renderToc(entries: readonly TocEntry[], ctx: ParseContext): string {
  if (entries.length === 0) return "";
  const title = escapeText(ctx.config.messages.tocTitle);
  let html = `<div id="toc" class="toc wiki-toc" role="navigation">`;
  html += `<div class="toctitle"><h2>${title}</h2></div>`;
  html += renderTocList(entries, 0, 1).html;
  html += `</div>`;
  return html;
}

/** Recursive `<ul>` builder over the flat, tocLevel-annotated entry list. */
function renderTocList(
  entries: readonly TocEntry[],
  start: number,
  depth: number,
): { html: string; next: number } {
  let html = "<ul>";
  let i = start;
  while (i < entries.length) {
    const entry = entries[i] as TocEntry;
    if (entry.tocLevel < depth) break;
    if (entry.tocLevel > depth) {
      // Defensive: a jump deeper than +1 cannot happen (buildToc normalizes).
      const nested = renderTocList(entries, i, depth + 1);
      html += nested.html;
      i = nested.next;
      continue;
    }
    html += `<li class="toclevel-${depth}">`;
    html += `<a href="#${escapeAttr(encodeFragment(entry.id))}">`;
    html += `<span class="tocnumber">${escapeText(entry.number)}</span> `;
    html += `<span class="toctext">${entry.html}</span></a>`;
    i += 1;
    if (i < entries.length && (entries[i] as TocEntry).tocLevel > depth) {
      const nested = renderTocList(entries, i, depth + 1);
      html += nested.html;
      i = nested.next;
    }
    html += "</li>";
  }
  html += "</ul>";
  return { html, next: i };
}
