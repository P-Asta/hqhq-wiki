/**
 * Dependency-free wikitext tokenizer for the source editor's syntax
 * highlighting, plus the small source-introspection helpers the editor rail
 * needs (templates used, categories, version boundaries).
 *
 * This is a *display* tokenizer, not the parser: it never expands anything
 * and never fails. Its only invariants are
 *
 *   1. `highlight(src).map((t) => t.text).join("") === src`  (lossless), and
 *   2. it terminates on any input.
 *
 * Constructs recognized (grammar references are to docs/engine/wikitext-spec.md):
 *   §1  `'''bold'''` / `''italic''` markers
 *   §2  `== headings ==`
 *   §3.4 `----` horizontal rules
 *   §4  `*` `#` `:` `;` list markers
 *   §5  `[[links]]`, pipe labels, `[[File:…|…]]`, `[[Category:…]]`
 *   §6  `[https://… label]` external links
 *   §7  `{| … |}` table markup (`|-`, `|+`, `|`, `!`, `||`, `!!`)
 *   §8  `{{templates}}` and `{{{parameters}}}` with their `|` separators
 *   §10 extension tags — `<ref>`, `<gallery>`, `<references/>`, `<nowiki>`,
 *       `<pre>`, `<syntaxhighlight>` — and Fandom's `<infobox>`/`<tabber>`
 *       plus this wiki's version tags, whose NAME is their range: `<v70>`,
 *       `<v70+v80>`, `<v70+>` (versioning.md §2.1); raw-text tags keep
 *       their body opaque
 *   §11 HTML comments and character entities
 *
 * Pure and DOM-free so it can be unit-tested in the node test environment
 * (see wikitext-highlight.test.ts).
 */

import { slugifyTitle } from "@/lib/title";
import { readVersionTagName } from "@/lib/version-branches";

/** One highlighted slice of the source. Concatenation reproduces the input. */
export interface HighlightToken {
  type: HighlightTokenType;
  text: string;
}

export type HighlightTokenType =
  /** Anything with no special meaning. */
  | "text"
  /** `<!-- … -->` (may span lines). */
  | "comment"
  /** Opaque body of `<nowiki>` / `<pre>` / `<syntaxhighlight>`. */
  | "nowiki"
  /** An HTML or extension tag, opening or closing. */
  | "tag"
  /** `{{`, the template name, its `|` separators and `}}`. */
  | "template"
  /** `{{{`, the parameter name, its `|` separators and `}}}`. */
  | "parameter"
  /** `=` runs of a heading line. */
  | "heading"
  /** `'''` markers. */
  | "bold"
  /** `''` markers. */
  | "italic"
  /** `[[`, the link target, its `|` separators and `]]`. */
  | "link"
  /** Display text after a pipe inside a link, or an external link's label. */
  | "link-label"
  /** `[https://…` opener and its closing `]`. */
  | "external"
  /** Table markup: `{|`, `|-`, `|+`, `|}`, and cell/header markers. */
  | "table"
  /** Leading `*` `#` `:` `;` run of a list line. */
  | "list"
  /** `----`. */
  | "hr"
  /** `&amp;` / `&#8594;` character references. */
  | "entity";

/**
 * Token types whose adjacent runs merge into one token. Everything else is
 * emitted one delimiter at a time (see `push`).
 */
const COALESCING = new Set<HighlightTokenType>(["text", "link-label"]);

/** Extension tags whose body is raw text (spec §10.1, §10.2, §10.5). */
const RAW_TEXT_TAGS = new Set(["nowiki", "pre", "syntaxhighlight", "source"]);

interface Frame {
  kind: "template" | "parameter" | "link" | "external";
  /** A pipe (or, for external links, the URL/label boundary) has been seen. */
  piped: boolean;
}

/**
 * Tokenize `source` into a flat, lossless token list.
 *
 * The scanner is single-pass and line-aware: line-start markers (headings,
 * lists, table rows, rules) are recognized first, then inline constructs.
 * Bracket constructs are tracked on a small frame stack so `|` and the
 * closing delimiters take the color of whatever opened them; the stack is
 * dropped at every newline so an unterminated `[[` cannot bleed color
 * through the rest of the buffer.
 */
export function highlight(source: string): HighlightToken[] {
  const out: HighlightToken[] = [];
  const frames: Frame[] = [];
  let atLineStart = true;
  let tableDepth = 0;
  /** Offset where the current heading's closing `=` run begins. */
  let headingCloseAt: number | null = null;
  let i = 0;
  const n = source.length;

  // `+` and `.` are in the name class for the version tags of versioning.md
  // §2.1 (`<v64.1+v70>`). No HTML element name carries either character, so
  // the only names this newly matches are ones nothing else here recognises,
  // and an unrecognised tag has always been coloured as a tag.
  const tagRe = /<(\/?)([A-Za-z][\w:.+-]*)((?:\s(?:"[^"]*"|'[^']*'|[^>])*)?)(\/?)>/y;
  const nameRe = /[^|{}[\]\n]*/y;
  const extRe = /\[(?:https?:\/\/|\/\/|ftp:\/\/|mailto:|news:|irc:)[^\s\]]*/y;
  const entityRe = /&(?:#\d+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/y;
  const headingRe = /^(={1,6})(.+?)(={1,6})[ \t]*$/;
  const hrRe = /^-{4,}/;
  const listRe = /^[*#:;]+/;
  const tableCellRe = /^(?:\|\+|\|-|\||!)/;

  function push(type: HighlightTokenType, text: string): void {
    if (text === "") return;
    const last = out[out.length - 1];
    // Only prose runs coalesce. Markup tokens stay one-delimiter-per-token so
    // consumers can walk the stream structurally (`templatesUsed` reads a
    // `{{name` token; `categoriesUsed` reads target / `|` / sort key as three).
    if (last !== undefined && last.type === type && COALESCING.has(type)) {
      last.text += text;
    } else {
      out.push({ type, text });
    }
    atLineStart = text.charCodeAt(text.length - 1) === 10;
  }

  function lineEndFrom(start: number): number {
    const nl = source.indexOf("\n", start);
    return nl === -1 ? n : nl;
  }

  function top(): Frame | undefined {
    return frames[frames.length - 1];
  }

  /** Plain text takes the label color inside a piped link / external link. */
  function textType(): HighlightTokenType {
    const frame = top();
    if (frame === undefined) return "text";
    if ((frame.kind === "link" || frame.kind === "external") && frame.piped) return "link-label";
    return "text";
  }

  function match(re: RegExp, at: number): string | null {
    re.lastIndex = at;
    const m = re.exec(source);
    return m === null ? null : m[0];
  }

  while (i < n) {
    /* ---- line-start markers (spec §2, §3.4, §4, §7.1) ---- */
    if (atLineStart) {
      const line = source.slice(i, lineEndFrom(i));

      const heading = headingRe.exec(line);
      if (heading !== null) {
        push("heading", heading[1]);
        i += heading[1].length;
        headingCloseAt = i + heading[2].length;
        continue;
      }

      if (line.startsWith("{|")) {
        tableDepth += 1;
        push("table", "{|");
        i += 2;
        continue;
      }
      if (line.startsWith("|}") && tableDepth > 0) {
        tableDepth -= 1;
        push("table", "|}");
        i += 2;
        continue;
      }
      if (tableDepth > 0) {
        const cell = tableCellRe.exec(line);
        if (cell !== null) {
          push("table", cell[0]);
          i += cell[0].length;
          continue;
        }
      }

      const hr = hrRe.exec(line);
      if (hr !== null) {
        push("hr", hr[0]);
        i += hr[0].length;
        continue;
      }

      const list = listRe.exec(line);
      if (list !== null) {
        push("list", list[0]);
        i += list[0].length;
        continue;
      }
    }

    /* ---- the closing `=` run of a heading line ---- */
    if (headingCloseAt !== null && i >= headingCloseAt) {
      const stop = lineEndFrom(i);
      push("heading", source.slice(i, stop));
      i = stop;
      headingCloseAt = null;
      continue;
    }

    const c = source[i];

    if (c === "\n") {
      push("text", "\n");
      // Links never span lines (spec §5.1), so an unterminated `[[` cannot
      // bleed color into the rest of the buffer. Templates and parameters
      // routinely do span lines (the Fandom infobox call is one per line),
      // so their frames survive the newline.
      while (top()?.kind === "link" || top()?.kind === "external") frames.pop();
      headingCloseAt = null;
      i += 1;
      continue;
    }

    /* ---- comments (spec §11) ---- */
    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      const stop = end === -1 ? n : end + 3;
      push("comment", source.slice(i, stop));
      i = stop;
      continue;
    }

    /* ---- tags (spec §10, §11) ---- */
    if (c === "<") {
      tagRe.lastIndex = i;
      const m = tagRe.exec(source);
      if (m !== null) {
        const closing = m[1] === "/";
        const name = m[2].toLowerCase();
        const selfClosing = m[4] === "/";
        push("tag", m[0]);
        i += m[0].length;
        if (!closing && !selfClosing && RAW_TEXT_TAGS.has(name)) {
          const closeIdx = source.toLowerCase().indexOf("</" + name, i);
          if (closeIdx === -1) {
            push("nowiki", source.slice(i));
            i = n;
          } else {
            push("nowiki", source.slice(i, closeIdx));
            i = closeIdx;
          }
        }
        continue;
      }
    }

    /* ---- templates and parameters (spec §8) ---- */
    if (source.startsWith("{{{", i)) {
      frames.push({ kind: "parameter", piped: false });
      const name = match(nameRe, i + 3) ?? "";
      push("parameter", "{{{" + name);
      i += 3 + name.length;
      continue;
    }
    if (source.startsWith("{{", i)) {
      frames.push({ kind: "template", piped: false });
      const name = match(nameRe, i + 2) ?? "";
      push("template", "{{" + name);
      i += 2 + name.length;
      continue;
    }
    if (source.startsWith("}}}", i) && top()?.kind === "parameter") {
      frames.pop();
      push("parameter", "}}}");
      i += 3;
      continue;
    }
    if (source.startsWith("}}", i) && top()?.kind === "template") {
      frames.pop();
      push("template", "}}");
      i += 2;
      continue;
    }

    /* ---- internal links (spec §5) ---- */
    if (source.startsWith("[[", i)) {
      frames.push({ kind: "link", piped: false });
      const target = match(nameRe, i + 2) ?? "";
      push("link", "[[" + target);
      i += 2 + target.length;
      continue;
    }
    if (source.startsWith("]]", i) && top()?.kind === "link") {
      frames.pop();
      push("link", "]]");
      i += 2;
      continue;
    }

    /* ---- external links (spec §6.2) ---- */
    if (c === "[") {
      const ext = match(extRe, i);
      if (ext !== null) {
        frames.push({ kind: "external", piped: true });
        push("external", ext);
        i += ext.length;
        continue;
      }
    }
    if (c === "]" && top()?.kind === "external") {
      frames.pop();
      push("external", "]");
      i += 1;
      continue;
    }

    /* ---- separators ---- */
    if (c === "|") {
      const frame = top();
      if (frame?.kind === "link") {
        frame.piped = true;
        push("link", "|");
        i += 1;
        continue;
      }
      if (frame?.kind === "template" || frame?.kind === "parameter") {
        push(frame.kind, "|");
        i += 1;
        continue;
      }
      if (tableDepth > 0 && frames.length === 0 && source.startsWith("||", i)) {
        push("table", "||");
        i += 2;
        continue;
      }
    }
    if (c === "!" && tableDepth > 0 && frames.length === 0 && source.startsWith("!!", i)) {
      push("table", "!!");
      i += 2;
      continue;
    }

    /* ---- emphasis markers (spec §1.1) ---- */
    if (source.startsWith("'''", i)) {
      push("bold", "'''");
      i += 3;
      continue;
    }
    if (source.startsWith("''", i)) {
      push("italic", "''");
      i += 2;
      continue;
    }

    /* ---- character references (spec §11) ---- */
    if (c === "&") {
      const entity = match(entityRe, i);
      if (entity !== null) {
        push("entity", entity);
        i += entity.length;
        continue;
      }
    }

    push(textType(), c);
    i += 1;
  }

  return out;
}

/**
 * Tokenize and split into visual lines, dropping the newline characters
 * themselves. `highlightLines("a\n")` yields two lines (the second empty),
 * exactly like a textarea's own line count.
 */
export function highlightLines(source: string): HighlightToken[][] {
  const lines: HighlightToken[][] = [[]];
  for (const token of highlight(source)) {
    const parts = token.text.split("\n");
    for (let p = 0; p < parts.length; p += 1) {
      if (p > 0) lines.push([]);
      if (parts[p] !== "") lines[lines.length - 1].push({ type: token.type, text: parts[p] });
    }
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/* Source introspection — the editor rail (client-side, no API calls)  */
/* ------------------------------------------------------------------ */

/** Magic words look like templates but are not pages (spec §9). */
const MAGIC_WORD_RE = /^[A-Z0-9_]+$/;

/**
 * Unique template names called from `source`, in first-use order. Parser
 * functions (`{{#if:…}}`), magic words (`{{PAGENAME}}`) and anything inside
 * comments or `<nowiki>` are skipped — the token stream already excludes the
 * latter.
 */
export function templatesUsed(source: string): string[] {
  const seen = new Map<string, string>();
  for (const token of highlight(source)) {
    if (token.type !== "template" || !token.text.startsWith("{{")) continue;
    const name = token.text.slice(2).trim();
    if (name === "" || name.startsWith("#") || MAGIC_WORD_RE.test(name)) continue;
    const key = name.toLowerCase().replace(/_/g, " ");
    if (!seen.has(key)) seen.set(key, name);
  }
  return [...seen.values()];
}

/** A `[[Category:…]]` membership parsed out of the buffer. */
export interface CategoryRef {
  /** Category name without the prefix, e.g. "Moons". */
  name: string;
  /** Sort key after the pipe, when present. */
  sortKey: string | null;
}

const CATEGORY_PREFIX_RE = /^\s*category\s*:/i;

/** Categories the buffer declares, in document order, de-duplicated. */
export function categoriesUsed(source: string): CategoryRef[] {
  const out: CategoryRef[] = [];
  const seen = new Set<string>();
  const tokens = highlight(source);
  for (let t = 0; t < tokens.length; t += 1) {
    const token = tokens[t];
    if (token.type !== "link" || !token.text.startsWith("[[")) continue;
    const target = token.text.slice(2);
    if (!CATEGORY_PREFIX_RE.test(target)) continue;
    const name = target.replace(CATEGORY_PREFIX_RE, "").trim();
    if (name === "") continue;
    const pipe = tokens[t + 1];
    const label = tokens[t + 2];
    const sortKey =
      pipe?.type === "link" && pipe.text === "|" && label !== undefined && label.type !== "link"
        ? label.text.trim()
        : null;
    const key = name.toLowerCase().replace(/_/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, sortKey });
  }
  return out;
}

/** A `[[Category:name]]` matcher tolerant of spacing, `_`, and sort keys. */
function categoryTagRe(name: string): RegExp {
  const escaped = name
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/[ _]+/g, "[ _]+");
  // Case-insensitive: MediaWiki category names are first-letter-insensitive
  // and the rail's remove button passes back whatever casing the chip had.
  return new RegExp("\\[\\[\\s*category\\s*:\\s*" + escaped + "\\s*(?:\\|[^\\]]*)?\\]\\]", "gi");
}

/**
 * Append `[[Category:name]]` at the bottom of the buffer (MediaWiki
 * convention), keeping it inside an existing category block when there is
 * one. A category already present is returned unchanged.
 *
 * "Already present" is decided on the slug, not the name: membership is stored
 * per slug (decisions-v2 O13.2), so `[[Category:Tier 3 moons]]` and
 * `[[Category:tier-3-moons]]` are one category filed twice — the exact drift
 * the tag picker exists to prevent, and it lists the page twice in its own
 * category box.
 */
export function addCategory(source: string, name: string): string {
  const clean = name.trim().replace(/^\s*category\s*:\s*/i, "").trim();
  if (clean === "") return source;
  const slug = slugifyTitle(clean);
  if (
    categoriesUsed(source).some(
      (c) =>
        c.name.toLowerCase() === clean.toLowerCase() ||
        (slug !== "" && slugifyTitle(c.name) === slug),
    )
  ) {
    return source;
  }
  const tag = "[[Category:" + clean + "]]";
  const body = source.replace(/\s+$/, "");
  if (body === "") return tag + "\n";
  const lastLine = body.slice(body.lastIndexOf("\n") + 1);
  const gap = CATEGORY_PREFIX_RE.test(lastLine.replace(/^\[\[/, "")) ? "\n" : "\n\n";
  return body + gap + tag + "\n";
}

/**
 * Remove every `[[Category:name]]` tag (with or without a sort key). A line
 * that held nothing but the tag is removed with it.
 */
export function removeCategory(source: string, name: string): string {
  const re = categoryTagRe(name);
  const kept: string[] = [];
  for (const line of source.split("\n")) {
    re.lastIndex = 0;
    if (!re.test(line)) {
      kept.push(line);
      continue;
    }
    const stripped = line.replace(re, "");
    if (line.trim() !== "" && stripped.trim() === "") continue;
    kept.push(stripped);
  }
  return kept.join("\n");
}

/* ------------------------------------------------------------------ */
/* Version boundaries — the rail's Versions section (versioning.md §2) */
/* ------------------------------------------------------------------ */

/**
 * Ids shaped `v62` / `v64.1`. The registry's ordinal is `major*1000 + minor`
 * and derives from the id alone (versioning.md §1), which is the only reason
 * a client-side list can be ordered without the registry in hand.
 */
const VERSION_ID_RE = /^v(\d+)(?:\.(\d+))?$/i;

function derivedOrdinal(id: string): number | null {
  const m = VERSION_ID_RE.exec(id);
  if (m === null) return null;
  return Number(m[1]) * 1000 + (m[2] ? Number(m[2]) : 0);
}

/** The name of the tag a `tag` token opens, or null when it closes one. */
const OPEN_TAG_NAME_RE = /^<([A-Za-z][\w:.+-]*)/;

/**
 * Record one candidate id, keeping the first spelling seen for a given id.
 * A candidate with inner whitespace is malformed markup, not an id.
 *
 * `*` is dropped: it is `{{#ifversion:}}`'s "always true" (§2.3), not a
 * version, and the engine leaves it out of `meta.versionBoundaries` for the
 * same reason. A chip reading `*` would offer to preview a version that does
 * not exist and to delete writing that belongs to every one of them.
 */
function collectVersionId(into: Map<string, string>, raw: string): void {
  const id = raw.trim();
  if (id === "" || id === "*" || /\s/.test(id)) return;
  const key = id.toLowerCase();
  if (!into.has(key)) into.set(key, id);
}

/** Non-overlapping occurrences of `pair` in `text`. */
function countPairs(text: string, pair: string): number {
  let count = 0;
  for (let at = text.indexOf(pair); at !== -1; at = text.indexOf(pair, at + pair.length)) {
    count += 1;
  }
  return count;
}

/**
 * How much of the buffer one call may be read from, and how much a whole pass
 * may read in total. A call that never closes has no end to find, so the walk
 * runs to the end of the buffer — once per call, which on a page repeating
 * `{{#vswitch:` with no `}}` is quadratic: 400 KB of it took ninety seconds,
 * and the rail re-runs this on every keystroke. Both bounds sit far above any
 * call an author writes, so a well-formed page reads exactly as before.
 */
const MAX_CALL_SCAN = 64 * 1024;

function callScanBudget(source: string): number {
  return Math.max(source.length * 4, MAX_CALL_SCAN);
}

/**
 * The inside of the `{{…}}` call whose opening token is `tokens[start]`, or
 * `null` when the call outruns the budget above.
 *
 * Token texts concatenate back to the source (invariant 1), so brace depth can
 * be counted over them without re-scanning the buffer — and reading the call
 * out of the *token* stream is what keeps a `{{#vswitch:}}` written inside a
 * comment or `<nowiki>` from being mistaken for a real one.
 */
function templateCallBody(
  tokens: readonly HighlightToken[],
  start: number,
  budget: { left: number },
): string | null {
  let depth = 0;
  let text = "";
  for (let i = start; i < tokens.length; i += 1) {
    // A call this long is not a call; reporting no boundaries for it beats
    // reading the rest of the buffer again for the next one.
    if (text.length >= MAX_CALL_SCAN || budget.left <= 0) return null;
    text += tokens[i].text;
    budget.left -= tokens[i].text.length;
    depth += countPairs(tokens[i].text, "{{") - countPairs(tokens[i].text, "}}");
    if (depth <= 0) break;
  }
  const end = text.endsWith("}}") ? text.length - 2 : text.length;
  return text.slice(2, end);
}

/**
 * Split a call body on its top-level `|`. Depth over `{{`/`[[` keeps a nested
 * call or a piped link inside an argument from ending it.
 */
function splitTopLevelArgs(body: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    if (body.startsWith("{{", i) || body.startsWith("[[", i)) {
      depth += 1;
      i += 1;
    } else if (body.startsWith("}}", i) || body.startsWith("]]", i)) {
      depth -= 1;
      i += 1;
    } else if (depth <= 0 && body[i] === "|") {
      args.push(body.slice(start, i));
      start = i + 1;
    }
  }
  args.push(body.slice(start));
  return args;
}

/**
 * Ids named by an `{{#ifversion:}}` range (§2.3). Comma is OR, `-` is an
 * inclusive span and both of its ends are boundaries the page branches on;
 * the comparison operators are stripped because `>=v62` still names v62.
 */
function rangeVersionIds(range: string): string[] {
  const out: string[] = [];
  for (const clause of range.split(",")) {
    const bare = clause.trim().replace(/^(?:>=|<=|>|<)/, "");
    for (const end of bare.split("-")) out.push(end);
  }
  return out;
}

/** The name a `tag` token closes, or null when it opens one. */
const CLOSE_TAG_NAME_RE = /^<\/([^\s>/]+)\s*>$/;

/**
 * A closing tag whose name starts with a digit — `</69>`, `</70+>`,
 * `</64.1>`.
 *
 * It lives here rather than beside `CLOSE_TAG_NAME_RE` because the
 * highlighter never produces a `tag` token for one: its tag pattern wants a
 * letter after the slash, so this arrives inside a `text` token. Which is the
 * same reason the engine renders it as literal text — nothing reads it as
 * markup at all, and that is exactly what makes it invisible to the author.
 */
const DIGIT_CLOSER_RE = /<\/(\d[\w.+-]*)\s*>/g;

/**
 * Something wrong with the version markup in the buffer, as the strip beside
 * the chips reports it (versioning.md §6).
 *
 * `tag` is the markup verbatim, so the author can find it; `suggestion` is the
 * markup it was probably meant to be, present only where that is not a guess.
 */
export interface VersionMarkupProblem {
  kind: "stray-closer" | "unclosed";
  /** The offending markup, exactly as written. */
  tag: string;
  /**
   * Where `tag` starts in the source.
   *
   * Carried so a repair can be applied **by position** rather than by
   * searching for the text again: a page may hold the same broken closer twice,
   * or hold it once for real and once inside `<nowiki>` as documentation, and a
   * replace-the-string repair would edit whichever it found first.
   */
  at: number;
  /** What it should have said — only for `stray-closer`. */
  suggestion?: string;
}

/**
 * Put the missing `v` back — `repairVersionMarkup(source, problem)`.
 *
 * Only a `stray-closer` can be repaired, and that is the whole design. `</69>`
 * has exactly one reading: a tag name cannot begin with a digit, so it is not
 * markup to anything, it is already published as literal text, and the `v` is
 * the only edit that turns it into something. An **unclosed** opener has no
 * such answer — where the passage was meant to end is a guess, and guessing it
 * would put somebody's paragraph inside a version they never wrote it for. So
 * that one is reported and left alone, which is the same line this editor
 * draws when it refuses to guess which half of an `{{#ifversion:}}` a version
 * removal should take.
 *
 * Splices at `problem.at` and returns the source untouched if what is there is
 * not the tag any more — the buffer can move under a report by a keystroke.
 */
export function repairVersionMarkup(source: string, problem: VersionMarkupProblem): string {
  if (problem.kind !== "stray-closer" || problem.suggestion === undefined) return source;
  if (source.slice(problem.at, problem.at + problem.tag.length) !== problem.tag) return source;
  return source.slice(0, problem.at) + problem.suggestion + source.slice(problem.at + problem.tag.length);
}

/**
 * Version markup the engine will not read the way it was written.
 *
 * **Why this exists at all.** The chips are drawn from `versionsUsed`, which
 * reads *openers*; the engine reads pairs. That is normally the same answer,
 * and when it is not, the page and the editor disagree with nothing on screen
 * to explain why — which is exactly what one mistyped closer does:
 *
 * ```wikitext
 * | Cell1 || <v69>aaa</69> || a          ← `</69>`, not `</v69>`
 * …
 * <v68></v68>
 * <v69></v69>
 * ```
 *
 * `</69>` closes nothing (spec §10.7 — a closing name must repeat its
 * opener), so `<v69>` runs on until the `</v69>` at the *bottom of the page*
 * and swallows everything between: the row's third cell, and the whole
 * `<v68>` block. At any version but v69 that content is simply gone, and v68
 * is never even discovered as a boundary, because a tag inside a hidden
 * branch is never expanded (versioning.md §2.6). The editor still showed both
 * chips. The author sees "the editor knows about v68 and v69, the article only
 * knows v69" and has nothing to go on.
 *
 * Two problems are reported, and both are facts rather than opinions:
 *
 * - **`stray-closer`** — a closing tag whose name is not a version id but
 *   *becomes* one with a `v` in front (`</69>` → `</v69>`, `</70+>` →
 *   `</v70+>`). Nothing legitimate has that shape: a tag name cannot begin
 *   with a digit, so the engine renders it as literal text and it is already
 *   broken however it got there — and the missing `v` is the only plausible
 *   correction. That tightness is the point: this reports, it does not
 *   spell-check.
 * - **`unclosed`** — an opener with no closer repeating its name anywhere
 *   after it, which §10.7 makes swallow the rest of the page. The engine warns
 *   about the same thing from the other side (`unclosed-version-tag`, stage 2);
 *   this one is the buffer's copy, so an author sees it while typing rather
 *   than after saving.
 *
 * Openers are paired **in order**, so a second `<v69>` is closed by a second
 * `</v69>`. Nesting the same range inside itself is not a thing the grammar
 * has, and treating it as one would report a problem where there is none.
 */
export function versionMarkupProblems(source: string): VersionMarkupProblem[] {
  const problems: VersionMarkupProblem[] = [];
  const closers = new Map<string, number>();
  const openers: { name: string; tag: string; at: number }[] = [];

  // The tokens reconstruct the source exactly, so running the length along them
  // is what gives every report an offset — and an offset is what lets a repair
  // land on the one it is about rather than on the next lookalike.
  let offset = 0;
  for (const token of highlight(source)) {
    const at = offset;
    offset += token.text.length;

    if (token.type === "text") {
      // `</69>` is not markup to anyone — not to the highlighter, not to the
      // engine — so it is scanned out of the prose it was left in.
      DIGIT_CLOSER_RE.lastIndex = 0;
      for (let m = DIGIT_CLOSER_RE.exec(token.text); m !== null; m = DIGIT_CLOSER_RE.exec(token.text)) {
        if (readVersionTagName(`v${m[1]}`) === null) continue;
        problems.push({
          kind: "stray-closer",
          tag: m[0],
          at: at + m.index,
          suggestion: `</v${m[1]}>`,
        });
      }
      continue;
    }
    if (token.type !== "tag") continue;

    const closing = CLOSE_TAG_NAME_RE.exec(token.text);
    if (closing !== null) {
      const name = closing[1];
      if (readVersionTagName(name) !== null) {
        const key = name.toLowerCase();
        closers.set(key, (closers.get(key) ?? 0) + 1);
        continue;
      }
      continue;
    }

    const opening = OPEN_TAG_NAME_RE.exec(token.text);
    if (opening === null) continue;
    // A self-closing tag closes itself; the grammar has no `<v70/>`, but the
    // scan must not read one as an opener waiting for a closer.
    if (token.text.endsWith("/>")) continue;
    if (readVersionTagName(opening[1]) === null) continue;
    openers.push({ name: opening[1].toLowerCase(), tag: token.text, at });
  }

  for (const opener of openers) {
    const left = closers.get(opener.name) ?? 0;
    if (left > 0) {
      closers.set(opener.name, left - 1);
      continue;
    }
    problems.push({ kind: "unclosed", tag: opener.tag, at: opener.at });
  }
  // In source order, so the strip reads down the page the author is looking at.
  return problems.sort((a, b) => a.at - b.at);
}

/**
 * Every version id the buffer branches on, ascending by ordinal.
 *
 * The editor's chip strip lists these so an author sees at a glance which
 * patches the page already covers (versioning.md §6), read from the buffer
 * rather than from `meta.versionBoundaries` because the point is to see the
 * coverage of text that has not been saved yet.
 *
 * The sources are exactly the three constructs of versioning.md §2 that name a
 * version: the NAME of a version tag, which is both ends of its range
 * (§2.1) — the engine records the same two ids as boundaries — the range of
 * `{{#ifversion:}}` and the boundary keys of `{{#vswitch:}}`.
 *
 * Ids the registry has never heard of are listed too: the page does branch on
 * them, and that gap is precisely what the author needs to notice. Having no
 * derivable ordinal they sort last, alphabetically.
 */
export function versionsUsed(source: string): string[] {
  const found = new Map<string, string>();
  const tokens = highlight(source);
  const budget = { left: callScanBudget(source) };

  for (let t = 0; t < tokens.length; t += 1) {
    const token = tokens[t];

    if (token.type === "tag") {
      // Openers only. A closing tag repeats its opener's name and so names
      // nothing new, and a STRAY closer names no branch at all: the engine
      // renders it escaped (§10.7), and a chip for it would offer to edit
      // writing that does not exist.
      const name = OPEN_TAG_NAME_RE.exec(token.text);
      const range = name === null ? null : readVersionTagName(name[1]);
      if (range === null) continue;
      // Both ends, because both are boundaries: the page reads one way up to
      // `to` and another way after it, which is what `recordBoundaries` puts in
      // `meta.versionBoundaries` for the same tag (versioning.md §3).
      collectVersionId(found, range.from);
      if (range.to !== null) collectVersionId(found, range.to);
      continue;
    }

    if (token.type !== "template" || !token.text.startsWith("{{")) continue;
    const name = token.text.slice(2).trim().toLowerCase();
    const isIfVersion = name.startsWith("#ifversion");
    if (!isIfVersion && !name.startsWith("#vswitch")) continue;

    const body = templateCallBody(tokens, t, budget);
    if (body === null) continue;
    const args = splitTopLevelArgs(body);
    // The function name and its first argument share one argument slot.
    const first = args[0];
    const head = first.slice(first.indexOf(":") + 1);

    if (isIfVersion) {
      for (const id of rangeVersionIds(head)) collectVersionId(found, id);
      continue;
    }
    args.forEach((arg, index) => {
      const pair = index === 0 ? head : arg;
      const eq = pair.indexOf("=");
      // A positional argument names no boundary: the expander reads each
      // argument's *name*, and an argument without `=` has none, so it lands
      // on the same else branch as `default` (§2.4) rather than on a version.
      if (eq === -1) return;
      const key = pair.slice(0, eq).trim();
      // `default` is #vswitch's else branch (§2.4), not a boundary.
      if (key.toLowerCase() !== "default") collectVersionId(found, key);
    });
  }

  return [...found.values()].sort((a, b) => {
    const oa = derivedOrdinal(a);
    const ob = derivedOrdinal(b);
    if (oa !== null && ob !== null) return oa - ob;
    if (oa !== null) return -1;
    if (ob !== null) return 1;
    return a.localeCompare(b);
  });
}
