/**
 * Taking one version's writing off a page — what the X on a version chip does
 * (docs/engine/versioning.md §6, grammar §2).
 *
 * The editor's chips are the versions the page actually writes for, so
 * removing one has to remove the *writing* with it: the decision was "delete
 * the content, with a confirmation that says how much" rather than "keep the
 * text, drop the branch". A transform that deletes prose is not something to
 * do with a regex at the call site, which is why it lives here as a pure
 * function with a test file beside it.
 *
 * {@link previewVersionRemoval} and {@link removeVersionBranch} are the *same*
 * computation on purpose. The number the confirmation quotes cannot drift from
 * the edit it describes, because it is the edit: the preview simply hands back
 * a buffer the caller has not committed yet.
 *
 * **What a version's writing IS, now that the name is the range** (§2.1). A
 * tag whose name STARTS at the doomed id is that version's writing, and the
 * whole element goes with its body: `<v56>`, `<v56+v60>` and `<v56+>` are all
 * "what this page says from v56", differing only in how far the saying runs.
 * Nothing else is touched, which is a much shorter list than the retired
 * grammar needed — there is no wrapper to empty, no attribute to rewrite, and
 * no list of ids to lose an entry from.
 *
 * What it refuses to touch, and reports instead through
 * {@link VersionRemoval.leftBehind}: `{{#ifversion:}}` and `{{#vswitch:}}`
 * calls naming the id, and a window that *ends* at it (`<v50+v56>`). A parser
 * function's branches are arbitrary expressions and guessing which half to
 * delete is how an editor loses a paragraph nobody meant to lose; a window's
 * upper end is the last version of somebody *else's* passage, and cutting it
 * would delete v50's writing under the name of v56. Both are places the author
 * has to visit, so the UI counts them rather than the transform mangling them.
 *
 * The scan borrows its discipline from `parse.ts`: comments and raw-text
 * elements (`<nowiki>`, `<pre>`, `<syntaxhighlight>`, `<source>`) are masked
 * out before anything is matched, so a `</v56+>` quoted inside one cannot
 * close a passage early — and the version markup in the seeded Help page's
 * `<pre>` examples is documentation, not a passage, and stays exactly as
 * written. An unclosed one masks to the end of the buffer, because that is
 * where the engine ends it (`findClosingTag`, preprocessor.ts).
 *
 * An unclosed `<v56+>` runs to the end of the buffer by that same rule, and
 * there this module deliberately parts company with the engine: it removes
 * nothing at all. Deleting from a half-typed tag to the bottom of the page is
 * the disaster this transform exists to avoid, and a typo is not consent. The
 * chip stays until the author closes the tag. Nothing throws: markup this
 * cannot read gives back the buffer it came with.
 */

import { readVersionTagName } from "@/lib/version-branches";

/** The result of removing one version's branches from a buffer. */
export interface VersionRemoval {
  /** The buffer with that version's branch gone. */
  text: string;
  /** Characters of authored content the removal takes with it — what the confirm quotes. */
  removedChars: number;
  /** Occurrences naming the id that this transform refuses to touch (see below). */
  leftBehind: number;
}

/* ------------------------------------------------------------------ */
/* Lexical tables                                                      */
/* ------------------------------------------------------------------ */

/**
 * One HTML tag, tolerating quoted attribute values that contain `>`. Copied
 * from `parse.ts` rather than imported so this module leaves that file's
 * exports as they are; the lazy attribute group is what keeps `<v70+/>` from
 * reading as a plain opener.
 *
 * `.` and `+` are in the name class because a version tag's name carries its
 * range (§2.1) — without them `<v70+v80>` would scan as a `v70` element with
 * `+v80` for an attribute, and the closer `</v70+v80>` would never be found to
 * match it. The engine widened `TAG_OPEN_RE` for the same reason.
 */
const TAG_RE = /<(\/?)([A-Za-z][A-Za-z0-9.+]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/y;

/** The two parser functions that name versions without branching on markup. */
const PARSER_FN_RE = /\{\{\s*#(ifversion|vswitch)\s*:/gi;

/** Elements whose body is raw text (wikitext-spec §10.1, §10.2, §10.5). */
const RAW_TEXT_TAGS: ReadonlySet<string> = new Set(["nowiki", "pre", "syntaxhighlight", "source"]);

/** Whitespace that may sit beside a block without making the line non-empty. */
const BLANK_ONLY_RE = /^[ \t\r]*$/;
const BLANK_HEAD_RE = /^[ \t\r]*\n/;
const BLANK_TAIL_RE = /(?:^|\n)[ \t\r]*\n$/;
const TRAILING_BLANKS_RE = /(?:[ \t\r]*\n)+$/;

/** A hostile or looping construct must degrade to "left alone", never recurse forever. */
const MAX_DEPTH = 64;

/**
 * How many separate edits one removal may make. Far above any real page — a
 * version named a thousand times is a generated page, not an authored one —
 * and it is what makes the fixed-point loop below finite even if some future
 * rule ever failed to shrink the buffer.
 */
const MAX_EDITS = 1024;

/** How far past an unclosed `{{#ifversion:` the scan reads looking for its ids. */
const MAX_CALL_SCAN = 64 * 1024;

/* ------------------------------------------------------------------ */
/* Version ids                                                         */
/* ------------------------------------------------------------------ */

/**
 * Ids compare trimmed and case-insensitively: `v56`, `V56` and `" v56 "` are
 * one version, exactly as `sortBoundaries` in version-branches.ts has it.
 */
function normalizeId(raw: string): string {
  return raw.trim().toLowerCase();
}

/* ------------------------------------------------------------------ */
/* Masking: comments and raw-text elements                             */
/* ------------------------------------------------------------------ */

interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * The first `</name…>` after `from`, or -1.
 *
 * A raw-text element closes on a literal search, never on depth counting
 * (spec §10.1): a `<nowiki>` holding the text `<nowiki>` is closed by the
 * first `</nowiki>`. The memo of where the *last* closer sits is what keeps a
 * buffer full of unclosed openers from costing one full pass each.
 */
function rawClose(text: string, from: number, name: string, memo: Map<string, number>): number {
  let last = memo.get(name);
  if (last === undefined) {
    const all = new RegExp(`</${name}\\s*>`, "gi");
    last = -1;
    for (let m = all.exec(text); m !== null; m = all.exec(text)) last = m.index;
    memo.set(name, last);
  }
  if (from > last) return -1;
  const re = new RegExp(`</${name}\\s*>`, "gi");
  re.lastIndex = from;
  const m = re.exec(text);
  return m === null ? -1 : m.index + m[0].length;
}

/**
 * The stretches of `text` that hold no markup: HTML comments and raw-text
 * elements, each taken whole, tags included.
 *
 * This is the rule that makes the Help page's `<pre>` examples safe. Both
 * degenerate shapes follow the engine, and both run to the end of the buffer:
 * an unterminated `<!--` swallows the rest of the input (preprocessor.ts §10.8,
 * and `highlight` agrees) and so does an unterminated `<nowiki>`.
 *
 * Returned ascending and non-overlapping, which is what lets every later scan
 * walk them with a single cursor.
 */
function protectedSpans(text: string): Span[] {
  const spans: Span[] = [];
  const lastClose = new Map<string, number>();
  const lastGt = text.lastIndexOf(">");
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt === -1) break;
    if (text.startsWith("<!--", lt)) {
      const close = text.indexOf("-->", lt + 4);
      const end = close === -1 ? text.length : close + 3;
      spans.push({ start: lt, end });
      i = end;
      continue;
    }
    // Past the last `>` no tag can close, so the lazy attribute run would read
    // to the end of the buffer once per `<` — the same memo `parse.ts` keeps
    // for its own closers, and the difference between linear and quadratic on
    // a buffer of half-typed openers.
    if (lt > lastGt) break;
    TAG_RE.lastIndex = lt;
    const m = TAG_RE.exec(text);
    if (m === null) {
      i = lt + 1;
      continue;
    }
    const openEnd = lt + m[0].length;
    const name = m[2].toLowerCase();
    if (m[1] === "/" || !RAW_TEXT_TAGS.has(name)) {
      i = openEnd;
      continue;
    }
    if (m[4] === "/") {
      spans.push({ start: lt, end: openEnd });
      i = openEnd;
      continue;
    }
    // An unclosed extension tag swallows the rest of the input — `findClosingTag`
    // in preprocessor.ts answers `contentEnd: text.length` — so everything past
    // it is quoted text, not markup, and none of it is this transform's to cut.
    const found = rawClose(text, openEnd, name, lastClose);
    const end = found === -1 ? text.length : found;
    spans.push({ start: lt, end });
    i = end;
  }
  return spans;
}

/** Whether `at` falls inside any masked stretch. */
function masked(spans: readonly Span[], at: number): boolean {
  for (const span of spans) {
    if (at < span.start) return false;
    if (at < span.end) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Tags                                                                */
/* ------------------------------------------------------------------ */

interface TagMatch {
  readonly start: number;
  readonly end: number;
  /** Lowercased element name — for a version tag, its whole range (§2.1). */
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
}

/** Every tag outside the masked stretches, in source order. */
function scanTags(text: string, spans: readonly Span[]): TagMatch[] {
  const out: TagMatch[] = [];
  const lastGt = text.lastIndexOf(">");
  let i = 0;
  let cursor = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt === -1 || lt > lastGt) break;
    while (cursor < spans.length && spans[cursor].end <= lt) cursor += 1;
    if (cursor < spans.length && spans[cursor].start <= lt) {
      i = spans[cursor].end;
      continue;
    }
    TAG_RE.lastIndex = lt;
    const m = TAG_RE.exec(text);
    if (m === null) {
      i = lt + 1;
      continue;
    }
    out.push({
      start: lt,
      end: lt + m[0].length,
      name: m[2].toLowerCase(),
      closing: m[1] === "/",
      selfClosing: m[4] === "/",
    });
    i = lt + m[0].length;
  }
  return out;
}

/**
 * For every opening tag, the index of the closing tag that matches it, or null
 * when it never closes.
 *
 * One stack per element name, resolved in a single pass — the same pairing
 * `findClose` reaches by depth counting, computed once instead of once per
 * opener so a long page stays linear.
 */
function pairTags(tags: readonly TagMatch[]): (number | null)[] {
  const close: (number | null)[] = tags.map(() => null);
  const stacks = new Map<string, number[]>();
  for (let i = 0; i < tags.length; i += 1) {
    const tag = tags[i];
    if (tag.selfClosing) continue;
    let stack = stacks.get(tag.name);
    if (stack === undefined) {
      stack = [];
      stacks.set(tag.name, stack);
    }
    if (!tag.closing) {
      stack.push(i);
      continue;
    }
    const open = stack.pop();
    if (open !== undefined) close[open] = i;
  }
  return close;
}

/* ------------------------------------------------------------------ */
/* Reading a block as the version tags it is made of                   */
/* ------------------------------------------------------------------ */

/** One version tag inside a block, located, with its body's offsets. */
export interface VersionTagSpan {
  /** Lower bound, spelled as the page wrote it. */
  readonly from: string;
  /** Upper bound; null when the tag is open-ended. */
  readonly to: string | null;
  /** The whole element. */
  readonly start: number;
  readonly end: number;
  /** Its body — what an in-place edit replaces, and nothing around it. */
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

/**
 * The version tags one block's wikitext consists of, in source order — or null
 * when it is made of anything else.
 *
 * **Why a block can hold several.** A page that says one thing from v45 and
 * another from v56 writes two tags back to back, with nothing between them: a
 * newline there would be text belonging to *every* version and would render an
 * empty paragraph for the windows the reader is not on (versioning.md §2.2).
 * The visual surface's block scan takes that whole run as one atomic node, so
 * "which passage does v56 render here" is a question about the run, not about
 * a tag — and this is what answers it.
 *
 * It lives beside the removal transform because it needs the same lexer: the
 * masking that keeps a `</v56+>` quoted inside `<nowiki>` or `<pre>` from
 * closing a passage early, and the pairing that matches a closer to its opener
 * by folded name and by depth.
 *
 * Null — not an empty list — for everything the caller must not rewrite: prose
 * beside the tags, a tag that never closes or whose closer does not repeat its
 * name (§10.7), a self-closing tag, an attribute the name does not carry
 * (§2.1 puts the whole meaning in the name, so the engine ignores attributes,
 * but a caller that dropped one would be losing the author's bytes), and any
 * other element. Whitespace between the tags is allowed and kept: it is the
 * author's, and an edit made here splices one body without moving a byte of it.
 */
export function versionTagSpans(source: string): VersionTagSpan[] | null {
  try {
    return readSpans(source);
  } catch {
    return null;
  }
}

function readSpans(source: string): VersionTagSpan[] | null {
  const tags = scanTags(source, protectedSpans(source));
  if (tags.length === 0) return null;
  const close = pairTags(tags);
  const spans: VersionTagSpan[] = [];
  let at = 0;

  for (let i = 0; i < tags.length; i += 1) {
    const tag = tags[i];
    if (tag.start < at) continue; // inside a body already taken
    if (source.slice(at, tag.start).trim() !== "") return null;
    const range = readVersionTagName(tag.name);
    if (range === null || tag.closing || tag.selfClosing) return null;
    if (attrsOf(source, tag).trim() !== "") return null;
    const closeIdx = close[i];
    if (closeIdx === null) return null;
    const closer = tags[closeIdx];
    spans.push({
      from: range.from,
      to: range.to,
      start: tag.start,
      end: closer.end,
      bodyStart: tag.end,
      bodyEnd: closer.start,
    });
    at = closer.end;
  }

  if (spans.length === 0 || source.slice(at).trim() !== "") return null;
  return spans;
}

/** The attribute run of one open tag, read back off the buffer. */
function attrsOf(source: string, tag: TagMatch): string {
  // `<` + name + attrs + `>`, with the tag's own offsets — the scan does not
  // keep the run because nothing else here needs it.
  return source.slice(tag.start + 1 + tag.name.length, tag.end - 1);
}

/* ------------------------------------------------------------------ */
/* Finding the next edit                                               */
/* ------------------------------------------------------------------ */

interface Edit {
  readonly start: number;
  readonly end: number;
  /** Author-visible characters this edit deletes — never the markup around them. */
  readonly removed: number;
}

interface Ctx {
  readonly text: string;
  readonly tags: readonly TagMatch[];
  readonly close: readonly (number | null)[];
  readonly key: string;
}

/** The closer of the opener at `open`, when it lies inside `limit`. */
function closeOf(ctx: Ctx, open: number, limit: number): number | null {
  const found = ctx.close[open];
  if (found === null || found >= limit) return null;
  return found;
}

/**
 * The first edit removing `ctx.key` would make inside one stretch of tags, or
 * null when that stretch has nothing to do.
 *
 * The whole decision is the tag's NAME (§2.1): a passage that *starts* at the
 * doomed version is that version's writing, whether it runs to one version, to
 * a later one or forever, and it goes with its body. A window that merely ends
 * there belongs to the version it starts at, and is counted rather than cut.
 *
 * An opener whose closer is missing — or lies outside this stretch — is passed
 * over. The engine would run it to the end of the buffer; this is the one
 * place that reading is refused, because acting on it means deleting from a
 * half-written tag to the bottom of the page.
 */
function scanRegion(ctx: Ctx, from: number, to: number, depth: number): Edit | null {
  if (depth > MAX_DEPTH) return null;
  let i = from;
  while (i < to) {
    const tag = ctx.tags[i];
    if (tag.closing) {
      i += 1;
      continue;
    }
    const range = readVersionTagName(tag.name);
    if (range === null) {
      i += 1;
      continue;
    }
    const doomed = normalizeId(range.from) === ctx.key;
    if (tag.selfClosing) {
      // No body, so nothing authored goes with it — but the tag is still this
      // version's, and leaving it would leave a chip with nothing behind it.
      if (doomed) return { start: tag.start, end: tag.end, removed: 0 };
      i += 1;
      continue;
    }
    const close = closeOf(ctx, i, to);
    if (close === null) {
      i += 1;
      continue;
    }
    if (doomed) {
      const closeTag = ctx.tags[close];
      return { start: tag.start, end: closeTag.end, removed: closeTag.start - tag.end };
    }
    // A kept passage may still hold a doomed one — §2 constructs nest anywhere.
    const inner = scanRegion(ctx, i + 1, close, depth + 1);
    if (inner !== null) return inner;
    i = close + 1;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Applying one edit                                                   */
/* ------------------------------------------------------------------ */

/** Whether `before` ends on an empty line — the start of the buffer counts. */
function endsBlank(before: string): boolean {
  return before === "" || BLANK_TAIL_RE.test(before);
}

/**
 * Cut `[start, end)` out, taking the whitespace the block was holding open.
 *
 * An element that has its line to itself takes the whole line, and then the
 * seam is closed: the blank line above it and the blank line below it were one
 * separator, and leaving both is the double blank line §4's serializer would
 * otherwise have to explain. The document's own ending survives either way — a
 * buffer that ended on a newline still does, and one that never did is not
 * given one.
 *
 * An element sharing its line with prose is cut exactly, spaces and all:
 * rewriting the author's sentence spacing is a bigger liberty than the double
 * space it would fix, and the renderer collapses that anyway.
 */
function cutBlock(text: string, start: number, end: number): string {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const found = text.indexOf("\n", end);
  const lineEnd = found === -1 ? text.length : found;
  const alone =
    BLANK_ONLY_RE.test(text.slice(lineStart, start)) && BLANK_ONLY_RE.test(text.slice(end, lineEnd));
  if (!alone) return text.slice(0, start) + text.slice(end);

  let before = text.slice(0, lineStart);
  let after = text.slice(Math.min(lineEnd + 1, text.length));
  for (;;) {
    if (!endsBlank(before)) break;
    const head = BLANK_HEAD_RE.exec(after);
    if (head === null) break;
    after = after.slice(head[0].length);
  }
  if (after === "") {
    const ending = text.endsWith("\r\n") ? "\r\n" : text.endsWith("\n") ? "\n" : "";
    before = before.replace(TRAILING_BLANKS_RE, ending);
  }
  return before + after;
}

function applyEdit(text: string, edit: Edit): string {
  return cutBlock(text, edit.start, edit.end);
}

/* ------------------------------------------------------------------ */
/* What is left behind                                                 */
/* ------------------------------------------------------------------ */

/** Offset just past the balanced `{{…}}` starting at `at`, or -1. */
function matchBraces(text: string, at: number): number {
  if (!text.startsWith("{{", at)) return -1;
  let depth = 0;
  let i = at;
  while (i < text.length) {
    if (text.startsWith("{{", i)) {
      depth += 1;
      i += 2;
      continue;
    }
    if (depth > 0 && text.startsWith("}}", i)) {
      depth -= 1;
      i += 2;
      if (depth === 0) return i;
      continue;
    }
    i += 1;
  }
  return -1;
}

/** Split a call body on its top-level `|`; nested calls and links keep theirs. */
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
 * Ids named by an `{{#ifversion:}}` range (§2.3): comma is OR, `-` is an
 * inclusive span whose ends are both named, and a comparison still names the
 * version it compares against.
 */
function rangeIds(range: string): string[] {
  const out: string[] = [];
  for (const clause of range.split(",")) {
    const bare = clause.trim().replace(/^(?:>=|<=|>|<)/, "");
    for (const end of bare.split("-")) out.push(end);
  }
  return out;
}

/** Whether one parser-function call names `key`. */
function callNames(fn: string, body: string, key: string): boolean {
  const args = splitTopLevelArgs(body);
  // The function name and its first argument share one argument slot.
  const first = args[0];
  const head = first.slice(first.indexOf(":") + 1);
  if (fn === "ifversion") return rangeIds(head).some((id) => normalizeId(id) === key);
  return args.some((arg, index) => {
    const pair = index === 0 ? head : arg;
    const eq = pair.indexOf("=");
    // A positional argument names no boundary; `default` is the else branch (§2.4).
    if (eq === -1) return false;
    const name = normalizeId(pair.slice(0, eq));
    return name !== "default" && name === key;
  });
}

/**
 * How many places still name `key` after the removal — the count the UI turns
 * into "and N places this could not touch".
 *
 * Counted per construct, not per mention: one call naming the id twice is one
 * place the author has to visit. Read off the *result*, so an `until` that
 * rode out on a removed element is never reported as surviving.
 */
function countLeftBehind(text: string, key: string): number {
  const spans = protectedSpans(text);
  let count = 0;

  for (const tag of scanTags(text, spans)) {
    if (tag.closing) continue;
    const range = readVersionTagName(tag.name);
    // A window that ENDS at the doomed id (`<v50+v56>`): the passage is v50's,
    // and its last version is the author's to move. `<v56>` — a window on
    // itself — is not left behind, because the scan above already took it.
    if (range === null || range.to === null) continue;
    if (normalizeId(range.to) === key && normalizeId(range.from) !== key) count += 1;
  }

  const calls = new RegExp(PARSER_FN_RE.source, "gi");
  for (let m = calls.exec(text); m !== null; m = calls.exec(text)) {
    if (masked(spans, m.index)) continue;
    const end = matchBraces(text, m.index);
    // An unclosed call is what put the chip on screen in the first place
    // (`versionsUsed` reads one the same way), so it is answered for too.
    const bodyEnd = end === -1 ? Math.min(text.length, m.index + MAX_CALL_SCAN) : end - 2;
    if (callNames(m[1].toLowerCase(), text.slice(m.index + 2, bodyEnd), key)) count += 1;
  }

  return count;
}

/* ------------------------------------------------------------------ */
/* The transform                                                       */
/* ------------------------------------------------------------------ */

/**
 * Edits are found and applied one at a time against a fresh scan, so every
 * decision — is this line alone, does this group still hold anything — is made
 * about the buffer as it actually is, never about offsets a previous edit has
 * already moved. Each edit strictly shortens the buffer, which is what makes
 * the loop finite; {@link MAX_EDITS} is the belt to that braces.
 */
function compute(source: string, id: string): VersionRemoval {
  const key = normalizeId(id);
  // `*` is `{{#ifversion:}}`'s "always true" (§2.3), never a version — no chip
  // carries it, and a removal for it would have no writing to name.
  if (key === "" || key === "*") return { text: source, removedChars: 0, leftBehind: 0 };

  let text = source;
  let removedChars = 0;
  for (let pass = 0; pass < MAX_EDITS; pass += 1) {
    const spans = protectedSpans(text);
    const tags = scanTags(text, spans);
    const ctx: Ctx = { text, tags, close: pairTags(tags), key };
    const edit = scanRegion(ctx, 0, tags.length, 0);
    if (edit === null) break;
    const next = applyEdit(text, edit);
    if (next === text) break;
    text = next;
    removedChars += edit.removed;
  }

  return { text, removedChars, leftBehind: countLeftBehind(text, key) };
}

/**
 * What removing it would do, without doing it — for the confirmation.
 *
 * The buffer comes back too, and that is the point: the caller shows
 * `removedChars` and `leftBehind` to the author and, on yes, publishes the
 * `text` it was already holding. There is no second computation to disagree
 * with the first.
 */
export function previewVersionRemoval(source: string, id: string): VersionRemoval {
  try {
    return compute(source, id);
  } catch {
    // Malformed markup gives back the buffer it came with, never a mangled one.
    return { text: source, removedChars: 0, leftBehind: 0 };
  }
}

/** Same computation, applied. */
export function removeVersionBranch(source: string, id: string): VersionRemoval {
  return previewVersionRemoval(source, id);
}
