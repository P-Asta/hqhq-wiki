/**
 * Stage 4 — block parse (spec §14.5).
 *
 * Input is EXPANDED + SANITIZED wikitext: templates are gone, version markup
 * was resolved in stage 2, raw HTML is already allowlisted, and `<nowiki>` /
 * `<pre>` / `<syntaxhighlight>` bodies are opaque strip markers we treat as
 * atomic inline text.
 *
 * Per-line precedence (§14.5): redirect (whole page, once) → `__WORD__`
 * behavior switches → tables (§7) → headings (§2) → `----` (§3.4) → lists
 * (§4) → space-pre + paragraphs (§3, with the §3.1.4 block-HTML exemption and
 * the Addendum A1 / D-14 blank-line rule).
 *
 * INLINE CONTENT. Stage 5 runs after this one, so by default every inline
 * region is emitted as a single raw `Text` node holding the region's source.
 * The pipeline (and tests) may inject the real `parseInline` through the
 * optional 4th argument — the extra optional parameter keeps the function
 * assignable to `EngineStages["parseBlocks"]`.
 *
 * RENDERING CONTRACT for `html-block` nodes emitted here: `html-block` is a
 * NON-WRAPPING container. `tag` is informational only (the block-level tag
 * that triggered §3.1 rule 4, or `""` for a bare inline region such as a
 * single-line table cell); the actual tag markup lives in the inline
 * children. Stage 6 must emit the children and never synthesize an element.
 */

import { parseTitle } from "@/lib/title";

import type {
  BlockNode,
  Heading,
  HtmlBlock,
  HtmlInline,
  InlineNode,
  PageMeta,
  Paragraph,
  ParseContext,
  Preformatted,
  RedirectNotice,
  Title,
  TitleKey,
} from "./types";
import { isListLine, parseListRun } from "./lists";
import { TABLE_START_RE, parseTableAt } from "./tables";

/* ------------------------------------------------------------------ */
/* Environment shared with lists.ts / tables.ts                        */
/* ------------------------------------------------------------------ */

export type InlineParser = (
  text: string,
  ctx: ParseContext,
  meta: PageMeta,
) => InlineNode[];

/** Threaded through the (mutually recursive) block scanners. */
export interface BlockEnv {
  ctx: ParseContext;
  meta: PageMeta;
  /** Stage 5 for one inline region. */
  inline(text: string): InlineNode[];
  /** Recursive stage 4 for a nested region (table cell, fostered content). */
  region(lines: string[]): BlockNode[];
  /** Page-wide heading-id uniqueness set (§2.4). */
  usedIds: Set<string>;
}

/** Non-wrapping block container: renders its inline children with no element. */
export function transparentBlock(children: InlineNode[]): HtmlBlock {
  return { type: "html-block", tag: "", attrs: {}, children };
}

/* ------------------------------------------------------------------ */
/* Behavior switches (§2.6)                                            */
/* ------------------------------------------------------------------ */

export const BEHAVIOR_SWITCHES = [
  "NOTOC",
  "FORCETOC",
  "NOEDITSECTION",
  "HIDDENCAT",
  "NOINDEX",
  "INDEX",
  // Fandom parity (see wikitext-spec.md "Fandom extensions"): switches every
  // Fandom article carries. Recorded in `meta.behaviorSwitches`, removed from
  // the output; the app layer decides what (if anything) they mean. Any OTHER
  // `__WORD__` stays literal text, per §2.6.
  "NOWYSIWYG",
  "NOGALLERY",
  "EXPECTUNUSEDCATEGORY",
  "STATICREDIRECT",
  "TOC",
] as const;

// `TOC` last so `__NOTOC__` / `__FORCETOC__` win the alternation.
const SWITCH_RE =
  /__(NOTOC|FORCETOC|NOEDITSECTION|HIDDENCAT|NOINDEX|INDEX|NOWYSIWYG|NOGALLERY|EXPECTUNUSEDCATEGORY|STATICREDIRECT|TOC)__/g;

/**
 * Internal placeholder marking where the FIRST `__TOC__` stood. U+007F cannot
 * occur in author text (stage 0 removes it) and the sequence is not a strip
 * marker, so it is unforgeable.
 */
const TOC_SENTINEL = `${String.fromCharCode(0x7f)}<TOC>${String.fromCharCode(0x7f)}`;

/**
 * Remove every recognized `__WORD__`, record it in `meta.behaviorSwitches`,
 * and mark the first `__TOC__` position. A line left empty by the removal
 * produces no paragraph (§2.6) — it is dropped entirely.
 */
export function extractBehaviorSwitches(text: string, meta: PageMeta): string {
  if (!text.includes("__")) return text;
  let sawToc = false;
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    SWITCH_RE.lastIndex = 0;
    if (!SWITCH_RE.test(line)) {
      kept.push(line);
      continue;
    }
    SWITCH_RE.lastIndex = 0;
    const replaced = line.replace(SWITCH_RE, (_m, word: string) => {
      meta.behaviorSwitches.add(word);
      if (word === "TOC" && !sawToc) {
        sawToc = true;
        return TOC_SENTINEL;
      }
      return "";
    });
    if (replaced.trim() === "" && line.trim() !== "") continue;
    kept.push(replaced);
  }
  return kept.join("\n");
}

/* ------------------------------------------------------------------ */
/* Redirects (§12.1)                                                   */
/* ------------------------------------------------------------------ */

const REDIRECT_RE = /^[ \t\n]*#redirect[ \t]*:?[ \t\n]*\[\[([^[\]|]*)(?:\|[^\]]*)?\]\]/i;

interface RedirectMatch {
  notice: RedirectNotice;
  /** Source after the redirect line (rendered below the notice, §12.3). */
  rest: string;
}

function titleKeyOf(t: Title): TitleKey {
  return `${t.namespace}:${t.pageName.replace(/ /g, "_")}`;
}

function detectRedirect(text: string, env: BlockEnv): RedirectMatch | null {
  const m = REDIRECT_RE.exec(text);
  if (!m) return null;
  const raw = (m[1] ?? "").trim();
  const parsed = parseTitle(raw, env.ctx.config.namespaces);
  if (!parsed) return null;

  const target: Title = {
    namespace: parsed.namespace,
    pageName: parsed.pageName,
    ...(parsed.fragment !== null ? { fragment: parsed.fragment } : {}),
  };
  // Addendum A2: the fragment travels on target.fragment.
  env.meta.redirect = { target };
  if (parsed.storable) {
    const key = titleKeyOf(target);
    if (!env.meta.linksTo.includes(key)) env.meta.linksTo.push(key);
  }

  const consumed = m[0].length;
  const nl = text.indexOf("\n", consumed);
  const rest = nl < 0 ? "" : text.slice(nl + 1);
  return {
    notice: { type: "redirect", target, targetText: raw },
    rest,
  };
}

/* ------------------------------------------------------------------ */
/* Headings (§2)                                                       */
/* ------------------------------------------------------------------ */

const HEADING_RES: RegExp[] = [];
for (let n = 6; n >= 1; n--) {
  HEADING_RES.push(new RegExp(`^={${n}}(.+)={${n}}[ \\t]*$`));
}

export interface HeadingMatch {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
}

/** §2.1 — try levels 6 down to 1; surplus `=` fall through into the content. */
export function matchHeading(line: string): HeadingMatch | null {
  for (let k = 0; k < HEADING_RES.length; k++) {
    const m = HEADING_RES[k]!.exec(line);
    if (m) {
      const level = (6 - k) as 1 | 2 | 3 | 4 | 5 | 6;
      return { level, text: m[1]!.trim() };
    }
  }
  return null;
}

/** Group 1 is the marker's tag name — kept in step with expand.ts's copy. */
const STRIP_MARKER_RE = new RegExp(
  `\\u007f'"UNIQ--([A-Za-z0-9-]+?)-[0-9A-Fa-f]+-QINU"'\\u007f`,
  "g",
);

/**
 * Best-effort plain text of a heading's raw inline source, for §2.4 step 1.
 * Stage 6 may recompute this from the rendered content; the algorithm (steps
 * 2–5) is shared via `headingAnchorId`.
 */
export function headingPlainText(source: string): string {
  return source
    .replace(STRIP_MARKER_RE, "")
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/\[[^\s\]]+[ \t]+([^\]]*)\]/g, "$1")
    .replace(/'{2,}/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"');
}

/**
 * §2.4 steps 2–5 in `fragmentMode: 'html5'`: trim, collapse whitespace runs,
 * spaces → `_`, keep everything else verbatim; empty → `_`.
 */
export function headingAnchorId(plain: string): string {
  const id = plain.trim().replace(/\s+/g, "_");
  return id === "" ? "_" : id;
}

/** §2.4 duplicate handling: `Foo`, `Foo_2`, `Foo_3`; collisions bump again. */
export function uniqueHeadingId(base: string, used: Set<string>): string {
  let id = base;
  let n = 1;
  while (used.has(id)) {
    n++;
    id = `${base}_${n}`;
  }
  used.add(id);
  return id;
}

/* ------------------------------------------------------------------ */
/* Raw block-level HTML (§3.1 rule 4 + Addendum A1 / D-14)             */
/* ------------------------------------------------------------------ */

const BLOCK_HTML_TAGS =
  "table|caption|thead|tbody|tfoot|tr|td|th|div|blockquote|ol|ul|dl|li|dt|dd|pre|p|h1|h2|h3|h4|h5|h6|hr|center|figure|figcaption";
const BLOCK_HTML_LINE_RE = new RegExp(`^<(/?)(${BLOCK_HTML_TAGS})(?=[\\s/>])`, "i");

/** Elements whose content model rejects `<p>` (Addendum A1). */
const P_REJECTING = new Set(["table", "thead", "tbody", "tfoot", "tr", "ul", "ol", "dl"]);
const P_REJECTING_RE = /<(\/?)(table|thead|tbody|tfoot|tr|ul|ol|dl)(?=[\s/>])/gi;

/**
 * Block-level HTML containers whose content model ALLOWS `<p>` and which
 * therefore hold the blocks that follow them (§3.1 rule 4, "the HTML flows
 * as-is").
 *
 * These are the opposite case to {@link P_REJECTING}. A `<table>` run becomes
 * ONE inline region because a `<p>` inside it is invalid (Addendum A1 / D-14);
 * a `<div>` run must instead keep parsing normally — its lines ARE paragraphs
 * — with the results nested inside the element. Without this, §11.2 balancing
 * closes the element at the end of its own line (that being the end of its
 * inline region) and the later `</div>` is dropped as a stray close, so the
 * content an author wrapped renders as siblings AFTER an empty element instead
 * of inside it.
 *
 * Restricted to the flow containers authors actually wrap article text in.
 * `pre`, `p`, `h1`–`h6` and `hr` are deliberately absent (they are leaves),
 * and `td`/`th`/`li`/`dd` only occur inside a `P_REJECTING` run, which owns
 * them.
 */
const P_ALLOWING_CONTAINERS = new Set(["div", "blockquote", "center", "figure"]);

/** Tag name when the line's first token is an allowed block-level tag. */
export function blockHtmlTag(line: string): string | null {
  const m = BLOCK_HTML_LINE_RE.exec(line);
  return m ? m[2]!.toLowerCase() : null;
}

/** As {@link blockHtmlTag}, but only for an OPENING tag (`</div>` ⇒ null). */
function blockHtmlOpenTag(line: string): string | null {
  const m = BLOCK_HTML_LINE_RE.exec(line);
  return m && m[1] !== "/" ? m[2]!.toLowerCase() : null;
}

/**
 * Net open/close count for one element name on a line. A self-closing
 * `<div />` opens and closes, so it contributes nothing. Stage 3 has already
 * canonicalized every allowed tag, so `[^>]*` cannot run past a real tag end.
 */
function containerDepthDelta(line: string, tag: string): number {
  const re = new RegExp("<(/?)" + tag + "\\b[^>]*?(/?)>", "gi");
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m[1] === "/") depth -= 1;
    else if (m[2] !== "/") depth += 1;
  }
  return depth;
}

/** Index just past the `</tag>` on this line, or -1. */
function closeTagEnd(line: string, tag: string): number {
  const m = new RegExp("</" + tag + "\\s*>", "i").exec(line);
  return m ? m.index + m[0].length : -1;
}

/**
 * The element node an unclosed opening line produced, so the blocks that
 * follow can be nested into it. Searches last-to-first, and into children for
 * `<div><div>` on one line, because the element left open is the innermost
 * trailing one.
 */
function findOpenContainer(
  nodes: readonly (InlineNode | BlockNode)[],
  tag: string,
): HtmlInline | null {
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i]!;
    if (node.type !== "html-inline") continue;
    const deeper = findOpenContainer(node.children, tag);
    if (deeper) return deeper;
    if (node.tag === tag) return node;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Block-level strip markers (§10.2, §10.4, §10.3)                     */
/* ------------------------------------------------------------------ */

/**
 * Extension tags whose strip marker stands for a BLOCK element: `<pre>` and
 * block-form `<syntaxhighlight>` (§10.2/§10.5 — "always block-level", so it
 * splits a paragraph), `<references>` (§10.3) and `<gallery>` (§10.4).
 * `nowiki`, `ref`, inline `syntaxhighlight` and the parser's own generated
 * HTML are inline and deliberately absent.
 */
const BLOCK_MARKER_NAMES: ReadonlySet<string> = new Set([
  "pre",
  "syntaxhighlight",
  "references",
  "gallery",
  // Fandom extensions §F.2: `<tabber>` is a widget and `<poem>` a `<div>`,
  // so both are block-level for the same reason `<gallery>` is.
  "tabber",
  "poem",
  // Fandom portable infobox: an `<aside>` floated beside the lead, so it must
  // never be wrapped in the `<p>` of the line it was written on.
  "infobox",
]);

/** The first block-level strip marker on `line`, or null. */
function findBlockMarker(line: string): { start: number; end: number } | null {
  if (!line.includes("\u007f")) return null;
  const re = new RegExp(STRIP_MARKER_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (BLOCK_MARKER_NAMES.has(m[1] as string)) {
      return { start: m.index, end: m.index + m[0].length };
    }
  }
  return null;
}

function updatePRejectDepth(line: string, depth: number): number {
  let d = depth;
  P_REJECTING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = P_REJECTING_RE.exec(line)) !== null) {
    const name = m[2]!.toLowerCase();
    if (!P_REJECTING.has(name)) continue;
    if (m[1] === "/") d = Math.max(0, d - 1);
    else d++;
  }
  return d;
}

/* ------------------------------------------------------------------ */
/* Line predicates (§3.1)                                              */
/* ------------------------------------------------------------------ */

function isBlank(line: string): boolean {
  return line.trim() === "";
}

/** Rule 2: one or more leading spaces AND visible content. */
function isPreLine(line: string): boolean {
  return line.startsWith(" ") && line.trim() !== "";
}

const HR_RE = /^(-{4,})([\s\S]*)$/;

function startsBlock(line: string): boolean {
  return (
    isBlank(line) ||
    line.includes(TOC_SENTINEL) ||
    TABLE_START_RE.test(line) ||
    matchHeading(line) !== null ||
    HR_RE.test(line) ||
    isListLine(line) ||
    isPreLine(line) ||
    blockHtmlTag(line) !== null
  );
}

/* ------------------------------------------------------------------ */
/* Region parser                                                       */
/* ------------------------------------------------------------------ */

function parseRegion(source: string[], env: BlockEnv): BlockNode[] {
  const out: BlockNode[] = [];
  const lines = source.slice();
  let i = 0;
  let blankRun = 0;
  let pReject = 0;

  /**
   * §3.2 blank-line runs — only applied when the run is followed by a
   * paragraph-text line in a context that accepts `<p>` (Addendum A1/D-14).
   * Returns true when the next paragraph must start with `<br />`.
   */
  const consumeBlankRun = (): boolean => {
    const k = blankRun;
    blankRun = 0;
    if (k === 0 || out.length === 0 || pReject > 0) return false;
    for (let n = 0; n < k - 2; n++) {
      out.push({ type: "p", children: [{ type: "br" }] } satisfies Paragraph);
    }
    return k >= 2;
  };

  while (i < lines.length) {
    const line = lines[i]!;

    if (isBlank(line)) {
      blankRun++;
      i++;
      continue;
    }

    // __TOC__ placement (§2.5).
    if (line.includes(TOC_SENTINEL)) {
      blankRun = 0;
      out.push({ type: "toc" });
      const rest = line.split(TOC_SENTINEL).join("");
      if (rest.trim() === "") {
        i++;
      } else {
        lines[i] = rest;
      }
      continue;
    }

    // 3. Tables (§7) — before everything else so `|` lines are never misread.
    if (TABLE_START_RE.test(line)) {
      blankRun = 0;
      const scan = parseTableAt(lines, i, env);
      if (scan) {
        out.push(scan.block);
        i = scan.next;
        if (scan.trailing !== null) lines.splice(i, 0, scan.trailing);
        continue;
      }
    }

    // 4. Headings (§2).
    const heading = matchHeading(line);
    if (heading) {
      blankRun = 0;
      const children = env.inline(heading.text);
      const id = uniqueHeadingId(
        headingAnchorId(headingPlainText(heading.text)),
        env.usedIds,
      );
      out.push({ type: "heading", level: heading.level, id, children } satisfies Heading);
      i++;
      continue;
    }

    // 5. `----` (§3.4): the rest of the line is re-queued as a new line.
    const hr = HR_RE.exec(line);
    if (hr) {
      blankRun = 0;
      out.push({ type: "hr" });
      i++;
      const rest = hr[2]!;
      if (rest !== "") lines.splice(i, 0, rest);
      continue;
    }

    // 6. Lists (§4).
    if (isListLine(line)) {
      blankRun = 0;
      const run = parseListRun(lines, i, env);
      out.push(...run.blocks);
      i = run.next;
      continue;
    }

    // 7a. Space-indented pre (§3.3) — inline markup IS parsed inside.
    if (isPreLine(line)) {
      blankRun = 0;
      const preLines: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(" ")) {
        preLines.push(lines[i]!);
        i++;
      }
      // A trailing whitespace-only line does not belong to the block; one
      // between two pre lines stays inside as an empty line.
      while (preLines.length > 0 && isBlank(preLines[preLines.length - 1]!)) {
        preLines.pop();
        i--;
      }
      const body = `${preLines.map((l) => l.slice(1)).join("\n")}\n`;
      out.push({
        type: "pre",
        literal: false,
        children: env.inline(body),
      } satisfies Preformatted);
      continue;
    }

    // 7b. A block-level extension tag (§10.2 `<pre>`, §10.3 `<references>`,
    //     §10.4 `<gallery>`, §10.5 block `<syntaxhighlight>`) reaches this
    //     stage as a strip marker. Being block-level it splits the paragraph
    //     it sits in, so peel the text around it off into its own lines and
    //     emit the marker with no `<p>` wrapper.
    const marker = findBlockMarker(line);
    if (marker !== null) {
      const before = line.slice(0, marker.start);
      const after = line.slice(marker.end);
      if (before !== "" || after !== "") {
        const parts = [before, line.slice(marker.start, marker.end), after];
        lines.splice(i, 1, ...parts.filter((p) => p !== ""));
        continue;
      }
      blankRun = 0;
      out.push(transparentBlock(env.inline(line)));
      i++;
      continue;
    }

    // 7c. Raw block-level HTML line (§3.1 rule 4): no `<p>` wrapper.
    const tag = blockHtmlTag(line);
    if (tag !== null) {
      blankRun = 0;

      // A p-ALLOWING container (`<div>`, `<blockquote>`, …) that opens here
      // and does not close on this line HOLDS the blocks that follow, rather
      // than closing at the end of its own inline region (§11.2) and letting
      // them spill out as siblings. The lines between are parsed as ordinary
      // blocks — paragraphs, lists, headings all work inside a wrapper div —
      // and nest into the element the opening line produced.
      const openTag = blockHtmlOpenTag(line);
      if (openTag !== null && P_ALLOWING_CONTAINERS.has(openTag)) {
        let depth = containerDepthDelta(line, openTag);
        if (depth > 0) {
          const inner: string[] = [];
          let j = i + 1;
          for (; j < lines.length; j += 1) {
            const next = lines[j]!;
            const delta = containerDepthDelta(next, openTag);
            if (depth + delta <= 0) {
              // This line closes the container. Text before the close tag is
              // still content; text after it goes back on the queue.
              const end = closeTagEnd(next, openTag);
              const head = end < 0 ? next : next.slice(0, end);
              const tail = end < 0 ? "" : next.slice(end);
              const headBody = head.replace(new RegExp("</" + openTag + "\\s*>\\s*$", "i"), "");
              if (headBody.trim() !== "") inner.push(headBody);
              lines[j] = tail;
              if (tail.trim() === "") j += 1;
              break;
            }
            depth += delta;
            inner.push(next);
          }

          const openNodes = env.inline(line);
          const container = findOpenContainer(openNodes, openTag);
          const innerBlocks = env.region(inner);
          if (container !== null) container.children.push(...innerBlocks);
          else openNodes.push(...(innerBlocks as unknown as InlineNode[]));

          pReject = 0;
          out.push({ type: "html-block", tag: openTag, attrs: {}, children: openNodes });
          i = j;
          continue;
        }
      }
      const buf: string[] = [line];
      let depth = updatePRejectDepth(line, pReject);
      i++;
      // §11.2 balances raw HTML "per block scope", and for an element whose
      // content model rejects `<p>` (Addendum A1: table/tr/ul/ol/dl…) that
      // scope spans every line until it closes: the lines form ONE inline
      // region, so stage 5 balances the element across the whole run instead
      // of auto-closing it at the end of its opening line. Blank lines inside
      // the run emit nothing (A1 / D-14) and text lines stay bare — a `<p>`
      // there is exactly the invalid markup D-14 exists to prevent.
      while (depth > 0 && i < lines.length) {
        const next = lines[i]!;
        i++;
        if (isBlank(next)) continue;
        buf.push(next);
        depth = updatePRejectDepth(next, depth);
      }
      pReject = depth;
      out.push({
        type: "html-block",
        tag,
        attrs: {},
        children: env.inline(buf.join("\n")),
      });
      continue;
    }

    // 7d. Paragraph (§3.2): consecutive text lines join with their newlines.
    const leadingBr = consumeBlankRun();
    const buf: string[] = [];
    while (i < lines.length && !startsBlock(lines[i]!)) {
      pReject = updatePRejectDepth(lines[i]!, pReject);
      buf.push(lines[i]!);
      i++;
    }
    const children: InlineNode[] = [];
    if (leadingBr) {
      children.push({ type: "br" }, { type: "text", value: "\n" });
    }
    children.push(...env.inline(buf.join("\n")));
    out.push({ type: "p", children } satisfies Paragraph);
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Stage entry point                                                   */
/* ------------------------------------------------------------------ */

const defaultInline: InlineParser = (text) =>
  text === "" ? [] : [{ type: "text", value: text }];

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Stage 4 (spec §14.5). `inlineParser` is optional so the function stays
 * assignable to `EngineStages["parseBlocks"]`; without it every inline region
 * is left as one raw `Text` node carrying the region's source, for stage 5.
 */
export function parseBlocks(
  sanitized: string,
  ctx: ParseContext,
  meta: PageMeta,
  inlineParser: InlineParser = defaultInline,
): BlockNode[] {
  if (!(meta.behaviorSwitches instanceof Set)) meta.behaviorSwitches = new Set();
  if (!Array.isArray(meta.warnings)) meta.warnings = [];
  if (!Array.isArray(meta.linksTo)) meta.linksTo = [];

  const env: BlockEnv = {
    ctx,
    meta,
    inline: (text) => inlineParser(text, ctx, meta),
    region: (lines) => parseRegion(lines, env),
    usedIds: new Set<string>(),
  };

  const redirect = detectRedirect(sanitized, env);
  const body = extractBehaviorSwitches(redirect ? redirect.rest : sanitized, meta);

  const out: BlockNode[] = [];
  if (redirect) out.push(redirect.notice);
  out.push(...parseRegion(splitLines(body), env));
  return out;
}
