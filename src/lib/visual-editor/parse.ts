/**
 * Wikitext → `VeDocument`: the first half of the round-trip contract in
 * docs/engine/visual-editor.md §4.
 *
 * The parser is a *bookkeeper* before it is a grammar. Every byte of the
 * normalized input lands in exactly one of three places — `doc.leading`, some
 * block's `source`, or that block's `gapAfter` — and the scan only ever moves
 * forward, so `serializeDocument(parseDocument(x)) === x` holds structurally
 * rather than by luck. That is why the block scan works in offsets and slices
 * the original text instead of rebuilding it from the parsed shape.
 *
 * The grammar it does understand is the subset the visual surface can edit:
 * paragraphs, headings, flat list runs, rules (spec §2) and the tables whose
 * cells hold nothing but inline content (§7, {@link readTable}). Everything
 * else — block templates, extension tags, comments, categories, files,
 * `#REDIRECT`, leading-space preformatted text, and the tables that refuse —
 * becomes an `atomic` block whose source is never re-serialized.
 * Classification therefore only has to be *stable*, not complete: a construct
 * we misjudge still round-trips, it merely edits as a chip instead of as
 * prose.
 *
 * Classification follows the real engine so the surface agrees with what the
 * article actually renders as: line precedence mirrors
 * src/lib/wikitext/blocks.ts, and the scanner's shape mirrors
 * src/lib/wikitext-highlight.ts (both lossless, both dependency-free).
 * Grammar references are to docs/engine/wikitext-spec.md.
 *
 * Nothing here throws and nothing drops input. An unmatched `{{`, `[[`, `<b>`
 * or `''` is literal text, exactly as MediaWiki treats it. The surface parses
 * synchronously on every load and every mode switch, so the scan is bounded in
 * both directions as well: recursion stops at {@link MAX_DEPTH} and the hunt
 * for a closer stops when a run's fuel does. Both degrade to "that opener is
 * literal text", which is a parse this file already has to produce.
 */

import { serializeBlock, serializeTable } from "@/lib/visual-editor/serialize";
import type {
  VeAtomicKind,
  VeBlock,
  VeDocument,
  VeHeadingLevel,
  VeInline,
  VeListItem,
  VeMark,
  VeTableRow,
  VeTableShape,
} from "@/lib/visual-editor/model";
import { isVersionTagName } from "@/lib/version-branches";
import { matchProtocol } from "@/lib/wikitext/external-links";
/**
 * What opens a table (§7.1, §7.8) — imported rather than mirrored, because a
 * table is found by the same line shape in both halves of the system and a
 * disagreement about that would put a block boundary in a different place.
 *
 * The engine's cell splitting is deliberately NOT imported with it; see
 * {@link splitCellPieces} for the reason.
 */
import { TABLE_START_RE } from "@/lib/wikitext/tables";

/* ------------------------------------------------------------------ */
/* Lexical tables                                                      */
/* ------------------------------------------------------------------ */

/**
 * Tags that open a BLOCK atomic when a line starts with one, and the chip
 * kind each becomes. `ref`, `nowiki` and `math` are deliberately absent: they
 * are inline constructs even when an author puts one at the head of a line,
 * so a `<ref>` there must not swallow the paragraph it belongs to.
 */
const BLOCK_TAG_KIND: ReadonlyMap<string, VeAtomicKind> = new Map<string, VeAtomicKind>([
  ["infobox", "infobox"],
  ["gallery", "gallery"],
  ["tabber", "tabber"],
  ["pre", "pre"],
  ["poem", "pre"],
  ["syntaxhighlight", "pre"],
  ["source", "pre"],
  ["references", "html"],
  ["blockquote", "html"],
  ["div", "html"],
  ["table", "html"],
  ["center", "html"],
  ["section", "html"],
  ["timeline", "html"],
  ["ul", "html"],
  ["ol", "html"],
  ["dl", "html"],
]);

/** Every tag whose element is opaque, block or inline, and its chip kind. */
const TAG_KIND: ReadonlyMap<string, VeAtomicKind> = new Map<string, VeAtomicKind>([
  ...BLOCK_TAG_KIND,
  ["nowiki", "nowiki"],
  ["ref", "ref"],
  ["math", "html"],
]);

/**
 * A version tag is not in either table because it has no fixed name to put
 * there: `<v70>`, `<v70+v80>` and `<v70+>` are named for the range they carry
 * (versioning.md §2.1). So the tables answer for the names that are spelled
 * out, and this answers for the ones that are computed — one question, asked
 * by the block scan, the inline scan and `atomicKindOf` alike.
 */
function tagKindOf(name: string, blockOnly: boolean): VeAtomicKind | null {
  const fixed = blockOnly ? BLOCK_TAG_KIND.get(name) : TAG_KIND.get(name);
  if (fixed !== undefined) return fixed;
  return isVersionTagName(name) ? "versions" : null;
}

/** The seven marks, with the HTML spellings authors and browsers produce. */
const MARK_TAGS: ReadonlyMap<string, VeMark> = new Map<string, VeMark>([
  ["b", "bold"],
  ["strong", "bold"],
  ["i", "italic"],
  ["em", "italic"],
  ["u", "underline"],
  ["ins", "underline"],
  ["s", "strike"],
  ["del", "strike"],
  ["strike", "strike"],
  ["sup", "sup"],
  ["sub", "sub"],
  ["code", "code"],
  ["tt", "code"],
]);

/**
 * Elements whose body is raw text (spec §10.1, §10.2, §10.5). Their close tag
 * is found by literal search, never by depth counting: a `<nowiki>` holding
 * the text `<nowiki>` is closed by the first `</nowiki>`, not the second.
 */
const RAW_TEXT_TAGS: ReadonlySet<string> = new Set(["nowiki", "pre", "syntaxhighlight", "source"]);

/**
 * Elements the engine lifts out of the text BEFORE it looks for block
 * boundaries — `EXT_TAGS` in src/lib/wikitext/preprocessor.ts, mirrored here
 * rather than imported so the editor bundle keeps its distance from the
 * pipeline. One of these opened mid-sentence and closed three lines down holds
 * its paragraph together across anything in between, blank lines included,
 * because the block scan never sees the lines it spans.
 *
 * Raw block HTML is deliberately absent. `<div>` and `<table>` reach the block
 * scan intact, so §11.2 balances them inside the block they were opened in and
 * the paragraph still ends at the next blank line — verified against
 * /api/preview, which closes the element itself and carries on.
 */
const SPANNING_TAGS: ReadonlySet<string> = new Set([
  "nowiki",
  "pre",
  "syntaxhighlight",
  "source",
  "ref",
  "references",
  "gallery",
  "tabber",
  "poem",
  "infobox",
]);

/** {@link SPANNING_TAGS}, plus the version tags that have no fixed name. */
function spansBlocks(name: string): boolean {
  return SPANNING_TAGS.has(name) || isVersionTagName(name);
}

const RULE_RE = /^-{4,}$/;
const REDIRECT_RE = /^#redirect/i;
const CATEGORY_LINK_RE = /^\[\[[ \t]*category[ \t]*:[ \t]*/i;
const MEDIA_LINK_RE = /^\[\[[ \t]*(?:file|image)[ \t]*:[ \t]*/i;
const TABLE_CLOSE_RE = /^\|\}/;
const LIST_RE = /^[*#:;]+/;
const BLANK_RE = /^[ \t]*$/;
/**
 * A tag name may carry `.` and `+` beyond the HTML character set, because a
 * version tag is named for its range: `<v64.1+v70>` (versioning.md §2.1). The
 * engine's `TAG_OPEN_RE` widened the same way and for the same reason; no HTML
 * element name contains either character, so a name that is not a version tag
 * still falls through to "some element we keep whole" exactly as before.
 */
const OPEN_TAG_NAME_RE = /^<([A-Za-z][A-Za-z0-9.+]*)/;
/**
 * One HTML tag, tolerating quoted attribute values that contain `>`. The
 * attribute group is LAZY on purpose: a greedy one swallows the `/` of
 * `<br />` and every self-closing tag reads as an opener.
 */
const TAG_RE = /<(\/?)([A-Za-z][A-Za-z0-9.+]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/y;

/** `= h1 =` … `====== h6 ======`, longest marker first (spec §2.1). */
const HEADING_LEVELS: readonly VeHeadingLevel[] = [6, 5, 4, 3, 2, 1];

const HEADING_RES: readonly { level: VeHeadingLevel; re: RegExp }[] = HEADING_LEVELS.map(
  (level) => ({ level, re: new RegExp(`^={${level}}(.+)={${level}}[ \\t]*$`) }),
);

/* ------------------------------------------------------------------ */
/* Small scanners shared by the block and inline passes                */
/* ------------------------------------------------------------------ */

function isBlank(line: string): boolean {
  return BLANK_RE.test(line);
}

function headingTitle(line: string): { level: VeHeadingLevel; title: string } | null {
  for (const { level, re } of HEADING_RES) {
    const m = re.exec(line);
    if (m !== null) return { level, title: m[1].trim() };
  }
  return null;
}

/** Lowercased name of the opening tag a string starts with, or null. */
function openTagName(source: string): string | null {
  const m = OPEN_TAG_NAME_RE.exec(source);
  return m === null ? null : m[1].toLowerCase();
}

/**
 * The first line of a fragment.
 *
 * `TABLE_START_RE` is anchored at both ends of a LINE, because the engine
 * applies it line by line, so a multi-line fragment has to be cut down before
 * it can be asked whether it opens a table.
 */
function firstLine(text: string): string {
  const cut = text.indexOf("\n");
  return cut === -1 ? text : text.slice(0, cut);
}

/** Length of the run of `ch` starting at `at`. */
function runLength(text: string, at: number, ch: string): number {
  let n = 0;
  while (at + n < text.length && text.charAt(at + n) === ch) n += 1;
  return n;
}

/**
 * Offset just past the balanced `{{…}}` / `{{{…}}}` starting at `at`, or -1.
 *
 * Openers are pushed with their width so `{{a|{{{b}}}}}` closes in the right
 * order; a `}}}` met over a `{{` closes two braces and leaves the third,
 * which is what the preprocessor does with the same input.
 */
function matchBraces(text: string, at: number): number {
  if (!text.startsWith("{{", at)) return -1;
  const widths: number[] = [];
  let i = at;
  while (i < text.length) {
    if (text.startsWith("{{{", i)) {
      widths.push(3);
      i += 3;
      continue;
    }
    if (text.startsWith("{{", i)) {
      widths.push(2);
      i += 2;
      continue;
    }
    if (widths.length > 0 && text.startsWith("}}", i)) {
      const width = widths[widths.length - 1] === 3 && text.startsWith("}}}", i) ? 3 : 2;
      widths.pop();
      i += width;
      if (widths.length === 0) return i;
      continue;
    }
    i += 1;
  }
  return -1;
}

/** Offset just past the balanced `[[…]]` starting at `at`, or -1. */
function matchWikiLink(text: string, at: number): number {
  if (!text.startsWith("[[", at)) return -1;
  let depth = 0;
  let i = at;
  while (i < text.length) {
    if (text.startsWith("[[", i)) {
      depth += 1;
      i += 2;
      continue;
    }
    if (text.startsWith("]]", i)) {
      depth -= 1;
      i += 2;
      if (depth === 0) return i;
      continue;
    }
    i += 1;
  }
  return -1;
}

/** §6.3: everything except whitespace, `<`, `>`, `[`, `]`, `"` and U+007F. */
function isUrlChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  if (code <= 0x20 || code === 0x7f) return false;
  return ch !== "<" && ch !== ">" && ch !== "[" && ch !== "]" && ch !== '"';
}

/* ------------------------------------------------------------------ */
/* Bounded scanning                                                    */
/* ------------------------------------------------------------------ */

/** A hostile or looping construct must not blow the stack; it degrades to text. */
const MAX_DEPTH = 64;

/**
 * How many characters one parse may spend on lookaheads that FAIL, per
 * character of the text it is parsing, and a floor for short runs.
 *
 * The failures are what cost: a closer search reads to the end of the text and
 * comes back with "unmatched", and the next opener repeats it. Real articles
 * spend nearly nothing here — a construct that closes is found in its own
 * length, and one with no closer anywhere in the text is answered from
 * {@link lastCloseOf} — so the budget is only ever reached by text built to
 * reach it, `"<b>".repeat(20000)` and its friends.
 */
const LOOKAHEAD_PER_CHAR = 64;
const LOOKAHEAD_FLOOR = 1 << 16;

interface Fuel {
  left: number;
}

/**
 * One text being scanned, with everything that keeps the scan bounded: the
 * recursion depth, the shared fuel, and the memos that make a text full of
 * unmatched openers cost one pass instead of one pass per opener.
 */
interface Scan {
  /** The string every offset in this scan refers to. */
  readonly text: string;
  /** How far inside the top-level run this one sits. */
  readonly depth: number;
  /** Shared with every nested run: the budget belongs to the whole tree. */
  readonly fuel: Fuel;
  /** Offset of the last `}}` in `text`; no `{{` after it can ever close. */
  readonly lastBraceClose: number;
  /** Offset of the last `]]`, and of the last `]`, for the same reason. */
  readonly lastLinkClose: number;
  readonly lastBracket: number;
  /** Per element name, the offset of its last close tag, on first ask. */
  readonly lastClose: Map<string, number>;
  /** Per element name, its compiled close matcher, on first ask. */
  readonly matchers: Map<string, RegExp>;
}

function newFuel(text: string): Fuel {
  return { left: LOOKAHEAD_PER_CHAR * text.length + LOOKAHEAD_FLOOR };
}

function newScan(text: string, fuel: Fuel, depth: number): Scan {
  return {
    text,
    depth,
    fuel,
    lastBraceClose: text.lastIndexOf("}}"),
    lastLinkClose: text.lastIndexOf("]]"),
    lastBracket: text.lastIndexOf("]"),
    lastClose: new Map(),
    matchers: new Map(),
  };
}

/** A scan of `text` nested inside `parent`: same budget, one level deeper. */
function nested(parent: Scan, text: string): Scan {
  return newScan(text, parent.fuel, parent.depth + 1);
}

/** Charge a failed lookahead, which read from `at` to the end of the text. */
function charge(scan: Scan, at: number): void {
  scan.fuel.left -= scan.text.length - at;
}

/** RegExp-literal form of a tag name — a version tag's carries `.` and `+`. */
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Elements whose close tag is found by literal search rather than by depth
 * counting.
 *
 * A raw-text element, because a `<nowiki>` holding the text `<nowiki>` is
 * closed by the first `</nowiki>`, not the second (spec §10.1, §10.2, §10.5).
 * A version tag, because that is what the engine does with every extension tag
 * (`findClosingTag`, preprocessor.ts): `<v70>a<v70>b</v70>` ends at the first
 * closer there too, and §2.6 asks authors not to nest them in the first place.
 */
function closesLiterally(name: string): boolean {
  return RAW_TEXT_TAGS.has(name) || isVersionTagName(name);
}

/**
 * Offset of the last `</name…>` in the scan's text, or -1 when the element
 * never closes at all.
 *
 * This is the one question that turns a text full of unmatched openers from
 * quadratic into linear: the answer is the same for every one of them, so it
 * is asked once. Its own pass is charged like any other lookahead, because a
 * text with thousands of DISTINCT unmatched names would otherwise pay for one
 * pass each.
 */
function lastCloseOf(scan: Scan, name: string): number {
  const known = scan.lastClose.get(name);
  if (known !== undefined) return known;

  scan.fuel.left -= scan.text.length;
  // Deliberately looser than either matcher below, so a "no closer here" is
  // always the truth for both of them. `\b` needs a word character to sit
  // against, and a version tag's name can end on `+` (`<v70+>`), where it would
  // never match at all.
  const tail = /\w$/.test(name) ? "\\b[^>]*" : "[^>]*";
  const re = new RegExp(`</${escapeForRegExp(name)}${tail}>`, "gi");
  let last = -1;
  for (let m = re.exec(scan.text); m !== null; m = re.exec(scan.text)) last = m.index;
  scan.lastClose.set(name, last);
  return last;
}

/**
 * The close matcher for one element, compiled once per scan.
 *
 * The name is escaped rather than spliced in raw: unescaped, a `</v70+v80>`
 * pattern would also close on `</v700v80>` (`0+` is one-or-more zeroes), which
 * is the trap the engine's own `findClosingTag` documents.
 */
function closeMatcher(scan: Scan, name: string): RegExp {
  const cached = scan.matchers.get(name);
  if (cached !== undefined) return cached;
  const safe = escapeForRegExp(name);
  const re = closesLiterally(name)
    ? new RegExp(`</${safe}\\s*>`, "gi")
    : new RegExp(`<(/?)${safe}\\b[^>]*?(/?)>`, "gi");
  scan.matchers.set(name, re);
  return re;
}

/** Where one element's close tag sits, or null when the opener is unmatched. */
function findClose(scan: Scan, from: number, name: string): { start: number; end: number } | null {
  if (scan.fuel.left <= 0 || from > lastCloseOf(scan, name)) return null;
  const raw = closesLiterally(name);
  const re = closeMatcher(scan, name);
  re.lastIndex = from;
  let depth = 1;
  for (;;) {
    const m = re.exec(scan.text);
    if (m === null) {
      charge(scan, from);
      return null;
    }
    if (raw) return { start: m.index, end: m.index + m[0].length };
    if (m[1] === "/") {
      depth -= 1;
      if (depth === 0) return { start: m.index, end: m.index + m[0].length };
    } else if (m[2] !== "/") {
      depth += 1;
    }
  }
}

/** {@link matchBraces}, answered from the memo where nothing can close. */
function matchBracesAt(scan: Scan, at: number): number {
  if (scan.fuel.left <= 0 || at > scan.lastBraceClose) return -1;
  const end = matchBraces(scan.text, at);
  if (end === -1) charge(scan, at);
  return end;
}

/** {@link matchWikiLink}, bounded the same way. */
function matchWikiLinkAt(scan: Scan, at: number): number {
  if (scan.fuel.left <= 0 || at > scan.lastLinkClose) return -1;
  const end = matchWikiLink(scan.text, at);
  if (end === -1) charge(scan, at);
  return end;
}

/* ------------------------------------------------------------------ */
/* Atomic identity                                                     */
/* ------------------------------------------------------------------ */

/**
 * Which chip a raw wikitext fragment becomes (spec §2, §5). Used both by the
 * block scan and by the toolbar's `insert` action, which hands over a snippet
 * with no idea what it is.
 *
 * The order is the block scan's own precedence, so a fragment classifies the
 * same way whether it arrived from an article or from a dialog. Anything
 * unrecognized is `unknown`, which still round-trips.
 */
export function atomicKindOf(source: string): VeAtomicKind {
  if (source.startsWith(" ") || source.startsWith("\t")) return "pre";
  if (source.startsWith("<!--")) return "comment";
  if (source.startsWith("{{{")) return "magic";
  if (source.startsWith("{{")) return "template";
  if (TABLE_START_RE.test(firstLine(source))) return "table";
  if (CATEGORY_LINK_RE.test(source)) return "category";
  if (MEDIA_LINK_RE.test(source)) return "media";
  if (REDIRECT_RE.test(source)) return "redirect";
  const tag = openTagName(source);
  if (tag !== null) return tagKindOf(tag, false) ?? "html";
  return "unknown";
}

/** First argument name of a `{{…}}` / `{{{…}}}` call, trimmed, or null. */
function braceArgument(source: string, width: number): string | null {
  const body = source.slice(width);
  const cut = body.search(/[|{}]/);
  const name = (cut === -1 ? body : body.slice(0, cut)).trim().replace(/\s+/g, " ");
  return name === "" ? null : name;
}

/** Page name of a `[[Prefix:name|…]]` link, prefix removed, or null. */
function prefixedLinkName(source: string, prefix: RegExp): string | null {
  const m = prefix.exec(source);
  if (m === null) return null;
  const body = source.slice(m[0].length);
  const cut = body.search(/[|\]]/);
  const name = (cut === -1 ? body : body.slice(0, cut)).trim();
  return name === "" ? null : name;
}

/**
 * The short human label the surface draws on an atomic chip (§5). It is the
 * construct's *name* wherever one exists — a template name, a file name, a
 * category — and the element name otherwise, because "gallery" tells a reader
 * more about a chip than the first line of its body would.
 */
export function atomicLabelOf(kind: VeAtomicKind, source: string): string {
  switch (kind) {
    case "template":
      return braceArgument(source, 2) ?? "template";
    case "magic":
      return braceArgument(source, 3) ?? "magic";
    case "media":
      return prefixedLinkName(source, MEDIA_LINK_RE) ?? "media";
    case "category":
      return prefixedLinkName(source, CATEGORY_LINK_RE) ?? "category";
    case "redirect": {
      const m = /\[\[([^\]|]*)/.exec(source);
      const target = m === null ? "" : m[1].trim();
      return target === "" ? "redirect" : target;
    }
    case "table":
      return "table";
    case "comment":
      return "comment";
    case "unknown":
      return "unknown";
    case "infobox":
    case "gallery":
    case "tabber":
    case "versions":
    case "pre":
    case "nowiki":
    case "ref":
    case "html":
      return openTagName(source) ?? kind;
  }
}

function atomicInline(source: string): VeInline {
  const atomic = atomicKindOf(source);
  return { kind: "atomic", atomic, source, label: atomicLabelOf(atomic, source) };
}

/* ------------------------------------------------------------------ */
/* Inline                                                              */
/* ------------------------------------------------------------------ */

interface InlineMatch {
  node: VeInline;
  end: number;
}

/**
 * One HTML-ish construct at `at`, or null when the `<` is literal text.
 *
 * Precedence is the spec's (§10 before §11): extension tags first, then
 * `<br>`, then the seven marks, and only then "some element we keep whole".
 * An opening tag with no close is not a construct at all — MediaWiki prints
 * it, so we keep it as text and the round trip stays exact.
 *
 * A mark keeps no attributes, because the model has nowhere to put them: a
 * styled `<sup class="notice">` survives untouched through §4's `source`
 * rule and collapses to a plain `<sup>` the moment its block is edited. That
 * is the same bargain the seven-mark toolbar makes everywhere else.
 */
function scanTag(scan: Scan, at: number): InlineMatch | null {
  const text = scan.text;
  TAG_RE.lastIndex = at;
  const m = TAG_RE.exec(text);
  if (m === null) return null;
  const name = m[2].toLowerCase();
  const openEnd = at + m[0].length;
  if (m[1] === "/") return null;

  if (name === "br") return { node: { kind: "break", source: m[0] }, end: openEnd };
  // `<ref name="x" />`, `<references />`, `<nowiki/>` — complete on their own.
  if (m[4] === "/") return { node: atomicInline(m[0]), end: openEnd };

  const close = findClose(scan, openEnd, name);
  if (close === null) return null;

  const mark = MARK_TAGS.get(name);
  if (mark !== undefined) {
    return {
      node: {
        kind: "mark",
        mark,
        children: parseRun(nested(scan, text.slice(openEnd, close.start))),
      },
      end: close.end,
    };
  }
  const source = text.slice(at, close.end);
  const atomic = tagKindOf(name, false) ?? "html";
  return {
    node: { kind: "atomic", atomic, source, label: atomicLabelOf(atomic, source) },
    end: close.end,
  };
}

/** `[[target|label]]`, `[[File:…]]` and `[[Category:…]]` (spec §5). */
function wikiLinkNode(scan: Scan, source: string): VeInline {
  if (MEDIA_LINK_RE.test(source) || CATEGORY_LINK_RE.test(source)) return atomicInline(source);
  const body = source.slice(2, source.length - 2);
  const pipe = body.indexOf("|");
  const target = pipe === -1 ? body : body.slice(0, pipe);
  // A bare link parses its own target as its children, so it serializes back
  // bare instead of growing a `|Foo` nobody typed.
  const label = pipe === -1 ? target : body.slice(pipe + 1);
  return { kind: "link", target, children: parseRun(nested(scan, label)) };
}

/** `[href label]` (spec §6.2). Free URLs stay text — they have no brackets. */
function scanExternalLink(scan: Scan, at: number): InlineMatch | null {
  const text = scan.text;
  const protocol = matchProtocol(text, at + 1, true);
  if (protocol === 0) return null;
  if (at > scan.lastBracket) return null;

  let urlEnd = at + 1 + protocol;
  while (urlEnd < text.length && isUrlChar(text.charAt(urlEnd))) urlEnd += 1;

  let i = urlEnd;
  while (i < text.length) {
    if (text.startsWith("[[", i)) {
      // A `[[…]]` in the label owns its own `]]`, so step over it whole.
      const inner = matchWikiLinkAt(scan, i);
      if (inner > 0) {
        i = inner;
        continue;
      }
    }
    if (text.charAt(i) === "]") break;
    i += 1;
  }
  if (i >= text.length) {
    charge(scan, at);
    return null;
  }

  const separator = text.charAt(urlEnd);
  const spaced = separator === " " || separator === "\t";
  const label = spaced ? text.slice(urlEnd + 1, i) : text.slice(urlEnd, i);
  return {
    node: {
      kind: "extlink",
      href: text.slice(at + 1, urlEnd),
      children: label === "" ? [] : parseRun(nested(scan, label)),
    },
    end: i + 1,
  };
}

/**
 * `''italic''`, `'''bold'''`, `'''''both'''''` (spec §1.1).
 *
 * A run of four apostrophes opens bold and leaves the fourth inside the
 * content, which is both what MediaWiki renders and — the leftover being
 * plain text — byte-exact on the way back out. A run with no closer before
 * the end of the line is literal text.
 */
function scanEmphasis(scan: Scan, at: number): InlineMatch | null {
  const text = scan.text;
  const run = runLength(text, at, "'");
  if (run < 2) return null;
  const width = run >= 5 ? 5 : run >= 3 ? 3 : 2;

  let i = at + width;
  let closer = -1;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === "\n") break;
    if (ch === "'") {
      const here = runLength(text, i, "'");
      if (here >= width) {
        closer = i;
        break;
      }
      i += here;
      continue;
    }
    i += 1;
  }
  if (closer === -1) return null;

  const children = parseRun(nested(scan, text.slice(at + width, closer)));
  const node: VeInline =
    width === 2
      ? { kind: "mark", mark: "italic", children }
      : width === 3
        ? { kind: "mark", mark: "bold", children }
        : { kind: "mark", mark: "bold", children: [{ kind: "mark", mark: "italic", children }] };
  return { node, end: closer + width };
}

/**
 * Parse one inline region — a paragraph, a heading title, a list item's text
 * or a link label (spec §2, inline nodes).
 *
 * Left to right, first match wins, and anything that fails to match is one
 * more character of text. Adjacent text is coalesced so the node list stays
 * small enough to diff against what comes back out of the DOM.
 *
 * Past {@link MAX_DEPTH} the rest of the region is one literal `text` node.
 * Markup nested that deep is hostile, not authored, and a text node is the one
 * answer that still holds §4: it serializes back to the bytes it came from.
 */
function parseRun(scan: Scan): VeInline[] {
  const text = scan.text;
  if (scan.depth > MAX_DEPTH) return text === "" ? [] : [{ kind: "text", text }];

  const out: VeInline[] = [];
  let buffer = "";

  const flush = (): void => {
    if (buffer !== "") {
      out.push({ kind: "text", text: buffer });
      buffer = "";
    }
  };

  let i = 0;
  while (i < text.length) {
    if (text.startsWith("<!--", i)) {
      const close = text.indexOf("-->", i + 4);
      const end = close === -1 ? text.length : close + 3;
      flush();
      out.push(atomicInline(text.slice(i, end)));
      i = end;
      continue;
    }
    if (text.startsWith("{{", i)) {
      const end = matchBracesAt(scan, i);
      if (end > 0) {
        flush();
        out.push(atomicInline(text.slice(i, end)));
        i = end;
        continue;
      }
    }
    if (text.charAt(i) === "<") {
      const tag = scanTag(scan, i);
      if (tag !== null) {
        flush();
        out.push(tag.node);
        i = tag.end;
        continue;
      }
    }
    if (text.startsWith("[[", i)) {
      const end = matchWikiLinkAt(scan, i);
      if (end > 0) {
        flush();
        out.push(wikiLinkNode(scan, text.slice(i, end)));
        i = end;
        continue;
      }
    }
    if (text.charAt(i) === "[") {
      const link = scanExternalLink(scan, i);
      if (link !== null) {
        flush();
        out.push(link.node);
        i = link.end;
        continue;
      }
    }
    if (text.startsWith("''", i)) {
      const emphasis = scanEmphasis(scan, i);
      if (emphasis !== null) {
        flush();
        out.push(emphasis.node);
        i = emphasis.end;
        continue;
      }
    }
    buffer += text.charAt(i);
    i += 1;
  }

  flush();
  return out;
}

/** {@link parseRun} on its own budget, for a region parsed out of context. */
export function parseInlineRun(text: string): VeInline[] {
  return parseRun(newScan(text, newFuel(text), 0));
}

/** A scan of `text` at the top level, drawing on the document's budget. */
function subScan(scan: Scan, text: string): Scan {
  return newScan(text, scan.fuel, 0);
}

/** {@link parseRun} on one block's text, drawing on the document's budget. */
function parseInlineIn(scan: Scan, text: string): VeInline[] {
  return parseRun(subScan(scan, text));
}

/* ------------------------------------------------------------------ */
/* Tables (spec §7)                                                    */
/* ------------------------------------------------------------------ */

/**
 * Why one table stayed an atomic chip instead of becoming a `VeTable`.
 *
 * Each of these is a construct the engine renders and the model cannot carry,
 * so refusing is the only answer that keeps §4: a table that refuses edits
 * exactly as it did before this file learned the grammar, while a table that
 * parsed and came back different would be a silent rewrite of somebody's
 * article. The reasons are named rather than boolean because the refusals are
 * what the tests are about — "this one nests a table" says more when it
 * breaks than "false" does.
 */
export type VeTableRefusal =
  /** Not `{|` at all — only reachable through the exported entry point. */
  | "not-a-table"
  /** `::{|` wraps the table in `<dl><dd>` levels (§7.8) the model has no field for. */
  | "indented"
  /** No `|}`: the block scan ran to the end of the document instead. */
  | "unclosed"
  /** Text after `|}`, which §7.1 re-queues as a line of its own after the table. */
  | "trailing-content"
  /** A `{|` inside the table (§7.9). A cell holds inline content, not a table. */
  | "nested-table"
  /** A non-marker line before the first cell, which §7.7 emits BEFORE the table. */
  | "fostered-content"
  /** A cell continued onto another line, so §7.3 parses its content as blocks. */
  | "cell-continuation"
  /** The same for a caption (§7.4). */
  | "caption-continuation"
  /** `|+ attrs | text`: the model's caption is inline children and nothing else. */
  | "caption-attrs"
  /** A second `|+`, which §7.4 drops with a warning rather than rendering. */
  | "second-caption"
  /** Nothing left to edit: no `|-` in it produced a single cell (§7.5). */
  | "no-rows"
  /** It read, but writing it back and reading that did not agree. */
  | "not-a-fixed-point";

export type VeTableParse =
  | { readonly ok: true; readonly shape: VeTableShape }
  | { readonly ok: false; readonly reason: VeTableRefusal };

function refuseTable(reason: VeTableRefusal): VeTableParse {
  return { ok: false, reason };
}

/**
 * Offset just past a construct at `at` whose insides are not table markup, or
 * -1 when nothing opens there.
 *
 * `{{…}}` and `[[…]]` both hold pipes that mean something else, and an
 * unmatched opener is literal text to the engine — so it is literal text here
 * too, and the scan simply carries on through it.
 */
function skipOpaque(scan: Scan, at: number): number {
  if (scan.text.startsWith("{{", at)) return matchBracesAt(scan, at);
  if (scan.text.startsWith("[[", at)) return matchWikiLinkAt(scan, at);
  return -1;
}

/**
 * §7.3's cell splitting — `||` everywhere, `!!` on a header line as well —
 * performed on **unexpanded** wikitext, which is the reason it is written here
 * rather than imported from the engine's scanner.
 *
 * The engine splits after template expansion (§7 preamble): by the time its
 * `splitCellPieces` runs, a `{{Verify|weather}}` has become whatever it
 * renders as, and every `|` still standing really is table markup. The editor
 * never expands anything, so the braces are still braces, and splitting on the
 * pipes inside one would show the author two cells where the article renders
 * one — then write two back the moment they typed into either. Stepping over a
 * balanced `{{…}}`, `{{{…}}}` and `[[…]]` is what makes the editor's idea of a
 * cell the same as the reader's.
 *
 * The construct this cannot follow is a template that *emits* the markup:
 * `{{!}}` expands to a pipe before the engine's scanner runs (§7.10). Such a
 * cell stays whole here, which costs the editor a cell boundary and costs the
 * article nothing — the magic word is written back exactly where it was, so
 * the page still renders the cells it always did.
 */
function splitCellPieces(scan: Scan, header: boolean): string[] {
  const text = scan.text;
  const pieces: string[] = [];
  let start = 0;
  let i = 0;
  while (i + 1 < text.length) {
    const skip = skipOpaque(scan, i);
    if (skip > 0) {
      i = skip;
      continue;
    }
    const two = text.charAt(i) + text.charAt(i + 1);
    if (two === "||" || (header && two === "!!")) {
      pieces.push(text.slice(start, i));
      i += 2;
      start = i;
      continue;
    }
    i += 1;
  }
  pieces.push(text.slice(start));
  return pieces;
}

/**
 * §7.3's attribute split: the first `|` separates a cell's attributes from its
 * content, and a construct met before that pipe vetoes the split entirely —
 * the whole piece is content.
 *
 * The spec names `[[` as the veto because that is the construct still standing
 * when the engine looks; {@link splitCellPieces} explains why `{{` has to join
 * it here. Both amount to the same rule: a pipe inside something else is not
 * the cell's separator.
 */
function splitCellAttrs(scan: Scan): { attrs: string | null; content: string } {
  const text = scan.text;
  for (let i = 0; i < text.length; i += 1) {
    if (skipOpaque(scan, i) > 0) return { attrs: null, content: text };
    if (text.charAt(i) === "|") return { attrs: text.slice(0, i), content: text.slice(i + 1) };
  }
  return { attrs: null, content: text };
}

/**
 * One `{| … |}` read structurally — the shape it has, or the first reason it
 * cannot have one.
 *
 * The line grammar is §7.1's, in §7.1's order, and the two splits that decide
 * where a cell ends are imported from the engine's own scanner rather than
 * mirrored (see the import comment at the top of this file).
 *
 * What it cannot carry, it refuses. One rule underlies most of the list: **a
 * cell is one line.** §7.3 hands a cell with continuation lines to the block
 * parser, and `VeInline[]` cannot hold a list, a heading, a paragraph break or
 * a nested table. Refusing every continuation line rather than those four
 * constructs separately is deliberate — it is the same question asked once,
 * where it cannot be got subtly wrong. (The engine strips a *blank* trailing
 * continuation line before parsing the cell, so it would have tolerated that
 * one. Refusing it too costs a rare table its cell editing and costs the round
 * trip nothing.)
 */
function readTable(scan: Scan, source: string): VeTableParse {
  const lines = source.split("\n");
  const head = TABLE_START_RE.exec(lines[0] ?? "");
  if (head === null) return refuseTable("not-a-table");
  if (head[1] !== "") return refuseTable("indented");

  const rows: VeTableRow[] = [];
  let caption: VeInline[] | null = null;
  let row: VeTableRow | null = null;
  /** What a continuation line would attach to — which is why we refuse it. */
  let open: "cell" | "caption" | null = null;
  let closed = false;

  // §7.5: a `|-` that ends up with no cells emits nothing at all, so it is
  // dropped here exactly as the engine drops it. Its attributes go with it,
  // and nothing that was ever on screen is lost.
  const pushRow = (candidate: VeTableRow | null): void => {
    if (candidate !== null && candidate.cells.length > 0) rows.push(candidate);
  };

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];

    if (TABLE_START_RE.test(line)) return refuseTable("nested-table");

    if (TABLE_CLOSE_RE.test(line)) {
      // §7.1 re-queues whatever follows the close — on that line or below it —
      // as text after the table, and the model has nowhere to put it. The
      // block scan ends a table block at its own `|}`, so this only bites the
      // exported entry point, which anyone may hand a whole page.
      if (line.slice(2).trim() !== "") return refuseTable("trailing-content");
      for (let k = i + 1; k < lines.length; k += 1) {
        if (!isBlank(lines[k])) return refuseTable("trailing-content");
      }
      closed = true;
      break;
    }

    if (line.startsWith("|+")) {
      if (caption !== null) return refuseTable("second-caption");
      const split = splitCellAttrs(subScan(scan, line.slice(2)));
      if (split.attrs !== null) return refuseTable("caption-attrs");
      caption = parseInlineIn(scan, split.content.trim());
      open = "caption";
      continue;
    }

    if (line.startsWith("|-")) {
      pushRow(row);
      // `|----` is `|-` with extra dashes (§7.1); the rest is attributes.
      row = { attrs: line.replace(/^\|-+/, "").trim(), cells: [] };
      open = null;
      continue;
    }

    if (line.startsWith("!") || line.startsWith("|")) {
      const header = line.startsWith("!");
      // Cells before any `|-` open an implicit first row (§7.5).
      const current: VeTableRow = row ?? { attrs: "", cells: [] };
      for (const piece of splitCellPieces(subScan(scan, line.slice(1)), header)) {
        const split = splitCellAttrs(subScan(scan, piece));
        current.cells.push({
          header,
          attrs: split.attrs === null ? "" : split.attrs.trim(),
          children: parseInlineIn(scan, split.content.trim()),
        });
      }
      row = current;
      open = "cell";
      continue;
    }

    if (open === "cell") return refuseTable("cell-continuation");
    if (open === "caption") return refuseTable("caption-continuation");
    return refuseTable("fostered-content");
  }

  if (!closed) return refuseTable("unclosed");
  pushRow(row);
  if (rows.length === 0) return refuseTable("no-rows");
  return { ok: true, shape: { attrs: head[2].trim(), caption, rows } };
}

/**
 * {@link readTable}, plus the check that makes editing a table's cells safe:
 * writing the shape back out and reading that again has to produce the same
 * wikitext.
 *
 * That is §4's guarantee stated for one block, and it is *checked* rather than
 * argued because the argument is long — cell splitting, the attribute split,
 * the caption's own split and the trimming this parser does all interact, and
 * a cell whose content holds a `|` in the wrong place comes back as two. A
 * table that fails the check keeps the raw-wikitext dialog it has always had.
 *
 * The comparison is on the wikitext, not on the two shapes: what §4 owes an
 * author is bytes, and two shapes that write the same bytes are the same table
 * to everything downstream.
 */
function parseTable(scan: Scan, source: string): VeTableParse {
  const first = readTable(scan, source);
  if (!first.ok) return first;
  const canonical = serializeTable(first.shape);
  const again = readTable(scan, canonical);
  if (!again.ok || serializeTable(again.shape) !== canonical) {
    return refuseTable("not-a-fixed-point");
  }
  return first;
}

/**
 * {@link parseTable} on one table's wikitext, on its own budget — for a caller
 * holding a table and nothing else, and for the tests that name the refusals.
 */
export function parseTableWikitext(source: string): VeTableParse {
  const text = source.replace(/\r\n?/g, "\n");
  return parseTable(newScan(text, newFuel(text), 0), text);
}

/* ------------------------------------------------------------------ */
/* Block scan                                                          */
/* ------------------------------------------------------------------ */

interface SourceLine {
  /** Offset of the line's first character in the normalized document. */
  start: number;
  /** Offset of its terminating newline, or of the end of the document. */
  end: number;
  text: string;
}

/**
 * What a scan decided, plus the index of the block's LAST line. Only headings
 * carry data across: the rest is cheaper to re-derive from the exact source
 * slice than to thread through.
 */
type BlockScan =
  | { block: "rule"; end: number }
  | { block: "heading"; end: number; level: VeHeadingLevel; title: string }
  | { block: "list"; end: number }
  | { block: "paragraph"; end: number }
  // The shape rides along because deciding it IS the classification: a table
  // is a table block only if it parses, so the parse has already happened by
  // the time this is returned and there is no reason to pay for it twice.
  | { block: "table"; end: number; shape: VeTableShape }
  | { block: "atomic"; end: number };

function splitLines(source: string): SourceLine[] {
  const out: SourceLine[] = [];
  let start = 0;
  for (;;) {
    const newline = source.indexOf("\n", start);
    if (newline === -1) {
      out.push({ start, end: source.length, text: source.slice(start) });
      return out;
    }
    out.push({ start, end: newline, text: source.slice(start, newline) });
    start = newline + 1;
  }
}

/** The block tag a line opens with, or null (rule j of the classification). */
function blockTagName(line: string): string | null {
  const name = openTagName(line);
  return name !== null && tagKindOf(name, true) !== null ? name : null;
}

/**
 * Lines that begin a block of their own, and so interrupt a paragraph.
 *
 * Comments, lone files and flush templates are absent on purpose: those are
 * blocks when they START one, but a `{{Verify}}` or a `[[File:…]]` on the
 * second line of a paragraph belongs to that paragraph, and cutting there
 * would strand the rest of the sentence in a block of its own.
 */
function startsOtherBlock(line: string): boolean {
  return (
    RULE_RE.test(line) ||
    headingTitle(line) !== null ||
    line.startsWith(" ") ||
    line.startsWith("\t") ||
    CATEGORY_LINK_RE.test(line) ||
    TABLE_START_RE.test(line) ||
    blockTagName(line) !== null ||
    LIST_RE.test(line)
  );
}

/** A line holding exactly one `[[File:…]]` / `[[Image:…]]` and nothing else. */
function isLoneMediaLink(line: string): boolean {
  return MEDIA_LINK_RE.test(line) && matchWikiLink(line, 0) === line.length;
}

function lastLineOfPre(lines: readonly SourceLine[], start: number): number {
  let end = start;
  while (
    end + 1 < lines.length &&
    (lines[end + 1].text.startsWith(" ") || lines[end + 1].text.startsWith("\t"))
  ) {
    end += 1;
  }
  return end;
}

function lastLineOfList(lines: readonly SourceLine[], start: number): number {
  let end = start;
  while (end + 1 < lines.length && LIST_RE.test(lines[end + 1].text)) end += 1;
  return end;
}

/**
 * Where an unterminated construct has to stop: the last line with content in
 * it. Trailing blank lines belong to the gap, not to the block, so a document
 * that simply ends mid-`<gallery>` still keeps its final newline where §4
 * expects to find it.
 */
function lastContentLine(lines: readonly SourceLine[], start: number): number {
  let end = lines.length - 1;
  while (end > start && isBlank(lines[end].text)) end -= 1;
  return end;
}

/** The line `needle` first appears on at or after `start`; the last, failing. */
function lineContaining(lines: readonly SourceLine[], start: number, needle: string): number {
  for (let k = start; k < lines.length; k += 1) {
    if (lines[k].text.includes(needle)) return k;
  }
  return lastContentLine(lines, start);
}

/** `{| … |}` with nesting (spec §7.9); unterminated runs to the last line. */
function lastLineOfTable(lines: readonly SourceLine[], start: number): number {
  let depth = 0;
  for (let k = start; k < lines.length; k += 1) {
    const line = lines[k].text;
    if (TABLE_START_RE.test(line)) {
      depth += 1;
      continue;
    }
    if (TABLE_CLOSE_RE.test(line)) {
      depth -= 1;
      if (depth <= 0) return k;
    }
  }
  return lastContentLine(lines, start);
}

/** Net open/close count for one element name on a line; self-closing is zero. */
function tagDepthDelta(line: string, name: string): number {
  const re = new RegExp(`<(/?)${escapeForRegExp(name)}\\b[^>]*?(/?)>`, "gi");
  let depth = 0;
  for (;;) {
    const m = re.exec(line);
    if (m === null) return depth;
    if (m[1] === "/") depth -= 1;
    else if (m[2] !== "/") depth += 1;
  }
}

/** `<gallery>…</gallery>` and friends; unterminated runs to the last line. */
function lastLineOfTagBlock(lines: readonly SourceLine[], start: number, name: string): number {
  TAG_RE.lastIndex = 0;
  const opener = TAG_RE.exec(lines[start].text);
  if (opener !== null && opener[4] === "/") return start;
  // The same literal close the scan uses (see `closesLiterally`): counting
  // depth would need a `\b` the `+` of `<v70+>` can never satisfy.
  if (closesLiterally(name)) return lineContaining(lines, start, `</${name}`);

  let depth = 0;
  for (let k = start; k < lines.length; k += 1) {
    depth += tagDepthDelta(lines[k].text, name);
    if (depth <= 0) return k;
  }
  return lastContentLine(lines, start);
}

/**
 * The last line of a `{{…}}` call that ends flush with a line end, or null.
 *
 * Flushness is the whole test: `{{Infobox_moon | … }}` written across ten
 * lines is a block, while `{{Verify|weather}}` sitting mid-sentence is not —
 * that one belongs to its paragraph as an inline chip.
 */
function lastLineOfTemplate(
  scan: Scan,
  lines: readonly SourceLine[],
  start: number,
): number | null {
  if (!lines[start].text.startsWith("{{")) return null;
  const end = matchBracesAt(scan, lines[start].start);
  if (end === -1) return null;
  for (let k = start; k < lines.length; k += 1) {
    if (lines[k].end === end) return k;
    if (lines[k].end > end) return null;
  }
  return null;
}

/**
 * Offset just past the construct opening at `at`, or -1 when nothing opens
 * there, or nothing closes it.
 *
 * Only the constructs the engine resolves BEFORE the block scan count: a
 * `{{…}}` call, which the preprocessor expands over the whole page, and a
 * {@link SPANNING_TAGS} element, which it lifts out whole. A `[[…]]` does not
 * — the link parser runs per inline region, so /api/preview leaves `[[Foo` and
 * `bar]]` as literal text in two different paragraphs — and neither does raw
 * block HTML.
 */
function spanningClose(scan: Scan, at: number): number {
  const text = scan.text;
  if (text.startsWith("{{", at)) return matchBracesAt(scan, at);
  if (text.charAt(at) !== "<") return -1;
  TAG_RE.lastIndex = at;
  const m = TAG_RE.exec(text);
  if (m === null || m[1] === "/" || m[4] === "/") return -1;
  const name = m[2].toLowerCase();
  if (!spansBlocks(name)) return -1;
  const close = findClose(scan, at + m[0].length, name);
  return close === null ? -1 : close.end;
}

/**
 * How far a paragraph reaches: to the blank line or interrupting line that
 * ends it, unless a construct opened inside it demonstrably closes further
 * down, in which case the paragraph keeps eating lines up to that close.
 * Without that, a template opened mid-sentence splits into two blocks and its
 * `}}` becomes a paragraph of its own.
 *
 * The close has to be real, and the reason is §4 rather than tidiness: an
 * unmatched `{{`, or a `<div>` an author merely MENTIONED in prose, is literal
 * text to the engine, which ends the paragraph at the next blank or
 * block-starting line all the same. Treating one as "still open" let a single
 * typo swallow every heading, list and table below it into one paragraph —
 * and editing that paragraph then published the article without them.
 */
function lastLineOfParagraph(scan: Scan, lines: readonly SourceLine[], start: number): number {
  let end = start;
  /** Where the search for openers has already been: never scan text twice. */
  let scanned = lines[start].start;
  /** How far the constructs found so far reach; past a line end, it glues. */
  let reach = scanned;

  for (;;) {
    const stop = lines[end].end;
    let i = Math.max(scanned, lines[end].start);
    while (i < stop) {
      const close = spanningClose(scan, i);
      if (close === -1) {
        i += 1;
        continue;
      }
      // The construct's own body cannot open anything the paragraph does not
      // already reach, so the scan resumes past it — possibly lines later.
      if (close > reach) reach = close;
      i = close;
    }
    scanned = i;

    if (end + 1 >= lines.length) break;
    const next = lines[end + 1].text;
    if (reach <= stop && (isBlank(next) || startsOtherBlock(next))) return end;
    end += 1;
  }
  // Trailing blank lines belong to the gap, not to the block (§4).
  return Math.min(end, lastContentLine(lines, start));
}

/**
 * Classify the block starting at `start`, first match wins. The order is the
 * one in docs/engine/visual-editor.md §2 read against blocks.ts's per-line
 * precedence: the unambiguous single-line shapes, then the multi-line
 * containers, then lists, then prose as the fallback.
 */
function scanBlock(
  scan: Scan,
  lines: readonly SourceLine[],
  start: number,
  atDocumentStart: boolean,
): BlockScan {
  const line = lines[start].text;

  if (RULE_RE.test(line)) return { block: "rule", end: start };

  const heading = headingTitle(line);
  if (heading !== null) {
    return { block: "heading", end: start, level: heading.level, title: heading.title };
  }

  // §12.1 makes a redirect a whole-page construct, so only the very first
  // block can be one; a `#REDIRECT` further down is an ordinary list line.
  if (atDocumentStart && REDIRECT_RE.test(line)) return { block: "atomic", end: start };

  if (line.startsWith(" ") || line.startsWith("\t")) {
    return { block: "atomic", end: lastLineOfPre(lines, start) };
  }
  if (line.startsWith("<!--")) {
    return { block: "atomic", end: lineContaining(lines, start, "-->") };
  }
  if (CATEGORY_LINK_RE.test(line)) return { block: "atomic", end: start };
  if (isLoneMediaLink(line)) return { block: "atomic", end: start };
  if (TABLE_START_RE.test(line)) {
    // A table is the one construct with two possible answers: an editable
    // block when its cells hold inline content that survives being written
    // back, and the atomic chip it has always been when they do not.
    const end = lastLineOfTable(lines, start);
    const table = parseTable(scan, scan.text.slice(lines[start].start, lines[end].end));
    return table.ok ? { block: "table", end, shape: table.shape } : { block: "atomic", end };
  }

  const template = lastLineOfTemplate(scan, lines, start);
  if (template !== null) return { block: "atomic", end: template };

  const tag = blockTagName(line);
  if (tag !== null) return { block: "atomic", end: lastLineOfTagBlock(lines, start, tag) };

  if (LIST_RE.test(line)) return { block: "list", end: lastLineOfList(lines, start) };

  return { block: "paragraph", end: lastLineOfParagraph(scan, lines, start) };
}

/** One list line: its literal marker, then its text minus one space (§4). */
function parseListItem(scan: Scan, line: string): VeListItem {
  const marker = LIST_RE.exec(line)?.[0] ?? "";
  const rest = line.slice(marker.length);
  return { marker, children: parseInlineIn(scan, rest.startsWith(" ") ? rest.slice(1) : rest) };
}

/**
 * `canonical` is the block's own serialization, so it can only be filled in
 * once the block exists. The object is still local to `buildBlock`, which is
 * what makes writing to it here safe.
 */
function sealed(block: VeBlock): VeBlock {
  block.canonical = serializeBlock(block);
  return block;
}

function buildBlock(
  id: string,
  scan: Scan,
  decision: BlockScan,
  source: string,
  gapAfter: string,
): VeBlock {
  switch (decision.block) {
    case "rule":
      return sealed({ kind: "rule", id, source, canonical: null, gapAfter, dashes: source.length });
    case "heading":
      return sealed({
        kind: "heading",
        id,
        source,
        canonical: null,
        gapAfter,
        level: decision.level,
        children: parseInlineIn(scan, decision.title),
      });
    case "list":
      return sealed({
        kind: "list",
        id,
        source,
        canonical: null,
        gapAfter,
        items: source.split("\n").map((line) => parseListItem(scan, line)),
      });
    case "paragraph":
      // §4: wikitext renders a paragraph's newlines as spaces, so folding
      // them loses nothing an author can see — and an untouched paragraph
      // keeps its line breaks anyway, through `source`.
      return sealed({
        kind: "paragraph",
        id,
        source,
        canonical: null,
        gapAfter,
        children: parseInlineIn(scan, source.replace(/\n/g, " ")),
      });
    case "table":
      return sealed({ kind: "table", id, source, canonical: null, gapAfter, ...decision.shape });
    case "atomic": {
      const atomic = atomicKindOf(source);
      return sealed({
        kind: "atomic",
        id,
        source,
        canonical: null,
        gapAfter,
        atomic,
        label: atomicLabelOf(atomic, source),
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Document                                                            */
/* ------------------------------------------------------------------ */

/**
 * Parse a whole article.
 *
 * Ids are positional (`b0`, `b1`, …) so two parses of the same text produce
 * the same document and a test can name a block by reading the source.
 *
 * The guarantee — `serializeDocument(parseDocument(x)) === x` for any `x`
 * whose newlines are already LF — comes from the accounting, not from the
 * grammar: `leading`, then every block's `source` and `gapAfter`, are
 * consecutive slices of the normalized input that cover all of it.
 */
export function parseDocument(wikitext: string): VeDocument {
  const source = wikitext.replace(/\r\n?/g, "\n");
  // One scan for the whole page: the memos and the fuel are the document's,
  // so a page full of unmatched openers costs one pass, not one per opener.
  const scan = newScan(source, newFuel(source), 0);
  const lines = splitLines(source);
  const blocks: VeBlock[] = [];

  let cursor = 0;
  while (cursor < lines.length && isBlank(lines[cursor].text)) cursor += 1;
  const leading = cursor < lines.length ? source.slice(0, lines[cursor].start) : source;

  while (cursor < lines.length) {
    const decision = scanBlock(scan, lines, cursor, blocks.length === 0);
    const body = source.slice(lines[cursor].start, lines[decision.end].end);

    // The gap is the block's terminating newline plus every blank line after
    // it, consumed LINE-WISE: a following line that merely starts with a
    // space is preformatted text (§3.3), and a greedy whitespace run would
    // eat the very space that makes it a block.
    let next = decision.end + 1;
    while (next < lines.length && isBlank(lines[next].text)) next += 1;
    const gapEnd = next < lines.length ? lines[next].start : source.length;
    const gap = source.slice(lines[decision.end].end, gapEnd);

    blocks.push(buildBlock(`b${blocks.length}`, scan, decision, body, gap));
    cursor = next;
  }

  return { leading, blocks };
}
