/**
 * What the clipboard means — the fifth of the Notion-shaped controls
 * (docs/engine/visual-editor.md §1, §11).
 *
 * Until now a paste was `insertText`: two paragraphs arrived as one, a
 * spreadsheet arrived as tab characters, a heading arrived as `## Title` in
 * running prose, and a link arrived as bare punctuation the author then had to
 * wrap by hand. Every one of those is a structure the clipboard already knew
 * about and the editor threw away.
 *
 * **`text/plain` only, always.** The clipboard's `text/html` flavour is not
 * read here and must not be: it is a whole other editor's DOM, and §3's reader
 * would have to make sense of it well enough that nothing foreign could reach
 * `serializeDocument`. Everything below is therefore recovered from the plain
 * text — which is also the flavour a spreadsheet, a terminal, a markdown file
 * and a chat client all agree on.
 *
 * **The paste is read as one document, not line by line.** The three readings
 * are decided in this order, and the first that fits wins:
 *
 * 1. **A URL** — over a selection it becomes the link around it; alone at the
 *    caret it becomes a page link when it names a page of *this* wiki, and is
 *    left as text otherwise, since the engine linkifies a bare URL already
 *    (wikitext-spec §6.2 "free").
 * 2. **Wikitext** — text carrying this wiki's own markup (`[[`, `{{`, `{|`,
 *    `== x ==`, `----`, `<ref>`) is pasted **verbatim**. Somebody copying a
 *    passage out of another article, or out of source mode, means the bytes
 *    they copied; converting them would be the editor rewriting markup it was
 *    handed. This test runs before markdown's, because the two grammars
 *    collide (`*` `#` `[…]`) and only one of them can win a line.
 * 3. **Markdown, or a grid** — anything else. Markdown because it is the
 *    muscle memory Notion built and the shape most notes on the internet are
 *    already in; a tab-separated grid because that is what every spreadsheet
 *    puts on the clipboard, and retyping one into a table is the chore this
 *    whole feature exists to remove.
 *
 * **Nothing is escaped, on purpose** (§4). A `|` that survives into a table
 * cell splits it on the next parse exactly as a typed `''` becomes italics:
 * this module writes wikitext, and wikitext is what the author gets.
 *
 * **Inside a table cell the answer is always inline** (wikitext-spec §7.3): a
 * cell holds inline content and nothing else, so a heading or a list made in
 * one is a table the model then has to refuse — and a refused table goes back
 * to being a chip with a dialog, which is the one thing a paste must not
 * silently do to a table somebody was editing.
 *
 * Everything here is pure: it sees strings and returns strings, never a DOM
 * and never a `Range`. The surface owns the caret and decides only *where* the
 * answer goes (visual-editor.tsx, `applyPaste`).
 */

import {
  DEFAULT_NAMESPACES,
  NS_ID_BY_STORABLE,
  humanizeSlug,
  pathToTitle,
  type StorableNamespace,
} from "@/lib/title";

import { parseDocument } from "./parse";

/* ------------------------------------------------------------------ */
/* The answer                                                          */
/* ------------------------------------------------------------------ */

/**
 * What the surface should put in, and in which of its two units.
 *
 * `text` is the untouched fallback — plain characters at the caret, the
 * behaviour every paste had before this module existed. The other two carry
 * **wikitext**, because wikitext is the only thing this editor writes: the
 * surface parses it back and draws it with the same two halves of §3 a
 * document load uses, so a pasted construct is the same markup as an inserted
 * one and §4 decides what publishes exactly as it does everywhere else.
 */
export type VePaste =
  /** Plain characters at the caret. */
  | { kind: "text"; text: string }
  /** One run of inline wikitext, into the block the caret is already in. */
  | { kind: "inline"; wikitext: string }
  /** One or more whole blocks. */
  | { kind: "blocks"; wikitext: string };

export interface VePasteInput {
  /** The clipboard's `text/plain`, exactly as it arrived. */
  text: string;
  /** The text this paste replaces; `""` at a collapsed caret. */
  selection: string;
  /** The caret is inside a table cell, where only inline content fits. */
  inCell: boolean;
  /**
   * This wiki's own origin (`https://wiki.example`), so a link to one of its
   * pages is pasted as a page link rather than as an external URL. `""` — the
   * default anywhere there is no `window` — simply turns that reading off.
   */
  origin?: string;
}

/* ------------------------------------------------------------------ */
/* URLs                                                                */
/* ------------------------------------------------------------------ */

/**
 * The schemes a pasted URL may carry (wikitext-spec §6.1, the linkable set
 * trimmed to what a person actually copies). `javascript:` and `data:` are
 * absent because the engine never links them, and a paste that wrote one would
 * be writing markup that renders as its own literal text.
 */
const URL_SCHEME = /^(?:https?|ftp|ftps|sftp|ssh|irc|ircs|mailto|tel|sms|xmpp|news):/i;

/** True for a string that is one whole URL and nothing else. */
export function isUrl(value: string): boolean {
  const text = value.trim();
  if (text === "" || /\s/.test(text)) return false;
  if (!URL_SCHEME.test(text)) return false;
  // `<`, `>`, `[`, `]` and `"` are outside a URL (§6.3), so a string carrying
  // one is not a URL — it is text that happens to start like one.
  return !/[<>[\]"]/.test(text);
}

/**
 * The page a URL of **this** wiki names, or null for anything else.
 *
 * The scheme is the URL router's, in reverse (`src/lib/locale-path.ts`):
 * English has no prefix (`/wiki/titan`) and every other language has one
 * (`/ko/wiki/titan`), so the path is read as an optional locale segment
 * followed by `wiki` and the title's own path — which `pathToTitle` already
 * knows how to read, because the article route reads it with the same
 * function.
 *
 * A `Category:` or `File:` page comes back with a **leading colon**, and that
 * colon is not decoration: `[[Category:Mechanics]]` files the page into that
 * category and renders nothing, and `[[File:…]]` embeds the image (§5.8).
 * Pasting a link to a category page must make a link. It is the same rule
 * `linkSuggestionTarget` keeps for the link dialog (§5.4), and
 * `paste.test.ts` pins the two together.
 */
export function internalTarget(url: string, origin: string): string | null {
  if (origin === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(url, origin);
  } catch {
    return null;
  }
  if (parsed.origin !== new URL(origin).origin) return null;

  const segments = parsed.pathname.split("/").filter((part) => part !== "");
  // `/wiki/x` or `/{locale}/wiki/x`. Anything else is a route of ours that is
  // not an article — a search, a history, the admin — and a link to one of
  // those is an ordinary external link, not a page name.
  const at = segments[0] === "wiki" ? 1 : segments[1] === "wiki" ? 2 : -1;
  if (at < 0) return null;
  const rest = segments.slice(at);
  if (rest.length === 0) return null;

  const path = pathToTitle(rest.map(decodeSegment));
  if (path === null) return null;
  const name = humanizeSlug(path.slug);
  if (path.nsName === "main") return name;
  const canonical = DEFAULT_NAMESPACES.canonical[NS_ID_BY_STORABLE[path.nsName]];
  return `${plainPrefix(path.nsName)}${canonical}:${name}`;
}

/** The `:` that keeps a category or file link a *link* (§5.4). */
function plainPrefix(nsName: StorableNamespace): string {
  return nsName === "file" || nsName === "category" ? ":" : "";
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The link a URL and a label make: a page link where the URL names a page of
 * this wiki, an external link otherwise — and a bare `[[Page]]` where the
 * label says nothing the target does not already say.
 */
export function linkWikitext(url: string, label: string, origin: string): string {
  const target = internalTarget(url, origin);
  const text = label.trim();
  if (target === null) return text === "" ? url : `[${url} ${text}]`;
  if (text === "" || text === target) return `[[${target}]]`;
  return `[[${target}|${text}]]`;
}

/* ------------------------------------------------------------------ */
/* Is it already ours?                                                 */
/* ------------------------------------------------------------------ */

/**
 * Markup that only this wiki writes. Any of it, anywhere in the paste, and the
 * whole paste is wikitext: a passage copied out of another article carries its
 * links and its templates, and rewriting those would be the editor editing
 * bytes it was handed rather than bytes somebody typed.
 *
 * `''` is deliberately **not** in the set. Two apostrophes are also how an
 * ordinary sentence spells a quotation inside a quotation, and reading a novel
 * excerpt as wikitext because of one would be worse than the other mistake.
 */
const WIKITEXT_MARKS = [
  /\[\[/, // a page link or a file
  /\{\{/, // a template call or a parser function
  /(^|\n)\s*\{\|/, // a table opener (§7.1)
  /(^|\n)\s*={1,6}[^=\n]+={1,6}\s*(\n|$)/, // a heading (§2)
  /(^|\n)-{4,}\s*(\n|$)/, // a horizontal rule (§3.3)
  /<(ref|references|gallery|infobox|tabber|nowiki|poem|syntaxhighlight)\b/i,
  /<v\d[^>]*>/i, // a version tag (versioning.md §2.1)
];

/** True when the paste is already this wiki's own markup. */
export function looksLikeWikitext(text: string): boolean {
  return WIKITEXT_MARKS.some((mark) => mark.test(text));
}

/* ------------------------------------------------------------------ */
/* Markdown → wikitext                                                 */
/* ------------------------------------------------------------------ */

/**
 * Inline markdown, in the one order that works: code spans first, because
 * everything inside one is literal; then links, whose labels may carry
 * emphasis; then the emphases themselves, longest delimiter first so `**` is
 * never read as two `*`.
 *
 * `_` is only emphasis at a word's edge, which is what keeps `snake_case` a
 * word rather than an italic; `*` needs no such rule, because it is not a
 * character words are spelled with.
 */
export function inlineMarkdown(text: string, origin: string): string {
  let out = "";
  let index = 0;

  while (index < text.length) {
    const rest = text.slice(index);

    // \* \_ \` \[ — the escape that says "this character is a character".
    const escaped = /^\\([\\`*_[\]()#+\-.!~|>])/.exec(rest);
    if (escaped !== null) {
      out += escaped[1];
      index += escaped[0].length;
      continue;
    }

    // `code` — literal inside, so nothing below sees it.
    const code = /^(`+)([^]*?)\1/.exec(rest);
    if (code !== null && code[2] !== "") {
      out += `<code>${code[2]}</code>`;
      index += code[0].length;
      continue;
    }

    // [label](url) and its image spelling. An image is written as a link,
    // because a URL on somebody else's server is not a file on this wiki and
    // `[[File:…]]` names one that is (§5.2).
    const link = /^!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
    if (link !== null) {
      out += linkWikitext(link[2], inlineMarkdown(link[1], origin), origin);
      index += link[0].length;
      continue;
    }

    const strong = /^(\*\*|__)(?=\S)([^]*?\S)\1/.exec(rest);
    if (strong !== null) {
      out += `'''${inlineMarkdown(strong[2], origin)}'''`;
      index += strong[0].length;
      continue;
    }

    const strike = /^~~(?=\S)([^]*?\S)~~/.exec(rest);
    if (strike !== null) {
      out += `<s>${inlineMarkdown(strike[1], origin)}</s>`;
      index += strike[0].length;
      continue;
    }

    const star = /^\*(?=\S)([^*]*?\S)\*(?!\*)/.exec(rest);
    if (star !== null) {
      out += `''${inlineMarkdown(star[1], origin)}''`;
      index += star[0].length;
      continue;
    }

    // `_x_`, only where the run stands alone as a word.
    const under = /^_(?=\S)([^_]*?\S)_(?![\p{L}\p{N}_])/u.exec(rest);
    if (under !== null && !isWordCharacter(text[index - 1])) {
      out += `''${inlineMarkdown(under[1], origin)}''`;
      index += under[0].length;
      continue;
    }

    out += text[index];
    index += 1;
  }
  return out;
}

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}_]/u.test(character);
}

/**
 * How deep an indented list line sits. A tab is one level and so are two
 * spaces, which is the pair of conventions markdown is actually written with;
 * four spaces is therefore two levels, which is what the author saw.
 */
export function listDepth(indent: string): number {
  let width = 0;
  for (const character of indent) width += character === "\t" ? 2 : 1;
  return Math.floor(width / 2);
}

/** One line of markdown, as far as its own line can be read. */
type MdLine =
  | { kind: "blank" }
  | { kind: "heading"; level: number; text: string }
  | { kind: "item"; marker: "*" | "#"; depth: number; text: string }
  | { kind: "quote"; text: string }
  | { kind: "rule" }
  | { kind: "fence" }
  | { kind: "text"; text: string };

function readLine(line: string): MdLine {
  if (line.trim() === "") return { kind: "blank" };
  if (/^\s*(?:```|~~~)/.test(line)) return { kind: "fence" };
  if (/^\s{0,3}(?:\*\s*){3,}$|^\s{0,3}(?:-\s*){3,}$|^\s{0,3}(?:_\s*){3,}$/.test(line)) {
    return { kind: "rule" };
  }

  const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
  if (heading !== null) return { kind: "heading", level: heading[1].length, text: heading[2] };

  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet !== null) {
    return { kind: "item", marker: "*", depth: listDepth(bullet[1]), text: bullet[2] };
  }

  const numbered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
  if (numbered !== null) {
    return { kind: "item", marker: "#", depth: listDepth(numbered[1]), text: numbered[2] };
  }

  const quote = /^\s*>\s?(.*)$/.exec(line);
  if (quote !== null) return { kind: "quote", text: quote[1] };

  return { kind: "text", text: line.trim() };
}

/**
 * A markdown heading's wikitext level.
 *
 * **`#` is `==`, not `=`.** A wiki article never writes an h1: the page title
 * is the h1, and the format menu offers h2…h5 for exactly that reason (§1). A
 * pasted document's own top level is therefore this page's top level, and the
 * five below it follow, clamped at the six wikitext has.
 */
export function headingMarks(level: number): string {
  return "=".repeat(Math.min(level + 1, 6));
}

/* ------------------------------------------------------------------ */
/* Grids                                                               */
/* ------------------------------------------------------------------ */

/**
 * A table's rows, or null when the text is not a grid.
 *
 * Two spellings arrive on a clipboard and both are read here:
 *
 * - **Tab-separated**, which is what every spreadsheet writes. Two or more
 *   lines, each carrying at least one tab, and all of them the same width —
 *   the width is what tells a copied selection apart from prose that merely
 *   happens to contain a tab.
 * - **A markdown table**, recognised by its separator row (`|---|---|`), whose
 *   header line then becomes header cells.
 *
 * A markdown table's alignment colons are **dropped**. Alignment is a
 * `style="text-align:…"` attribute, and §7 is explicit that this editor never
 * invents an attribute string it would then only be carrying verbatim.
 */
export interface VeGrid {
  header: boolean;
  rows: string[][];
}

export function readGrid(text: string): VeGrid | null {
  const lines = text.split("\n").filter((line, index, all) => {
    // A trailing newline is punctuation, not an empty row.
    return !(line === "" && index === all.length - 1);
  });
  if (lines.length < 2) return null;

  const markdown = readMarkdownGrid(lines);
  if (markdown !== null) return markdown;

  if (!lines.every((line) => line.includes("\t"))) return null;
  const rows = lines.map((line) => line.split("\t"));
  const width = rows[0].length;
  if (width < 2 || !rows.every((row) => row.length === width)) return null;
  // No header is guessed. A first row that *is* one is one click away
  // ("header row on", §3.2), and guessing wrong costs the author the same
  // click plus the surprise.
  return { header: false, rows };
}

function readMarkdownGrid(lines: readonly string[]): VeGrid | null {
  if (lines.length < 3) return null;
  if (!lines.every((line) => line.includes("|"))) return null;
  if (!/^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$/.test(lines[1])) return null;

  const header = splitRow(lines[0]);
  const body = lines.slice(2).map(splitRow);
  const width = header.length;
  if (width < 1) return null;
  return { header: true, rows: [header, ...body.map((row) => row.slice(0, width))] };
}

/** A markdown row's cells: split on the pipes the author did not escape. */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (character === "\\" && trimmed[index + 1] === "|") {
      current += "|";
      index += 1;
      continue;
    }
    if (character === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  cells.push(current.trim());
  return cells;
}

/**
 * A grid's wikitext, in the canonical shape §4 names — every row opened with
 * `|-`, like cells joined on one line — so the table this writes is a fixed
 * point of the parser and the block the surface draws from it is a table it
 * can edit, not a chip.
 */
export function gridWikitext(grid: VeGrid, origin: string): string {
  const out: string[] = ['{| class="wikitable"'];
  grid.rows.forEach((row, index) => {
    const header = grid.header && index === 0;
    out.push("|-");
    const cells = row.map((cell) => inlineMarkdown(cell, origin).replace(/\s+/g, " ").trim());
    out.push(`${header ? "!" : "|"} ${cells.join(header ? " !! " : " || ")}`);
  });
  out.push("|}");
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* The document                                                        */
/* ------------------------------------------------------------------ */

/**
 * A markdown document's wikitext.
 *
 * Fenced code becomes leading-space preformatted lines, which is the one
 * spelling §2 has for a block of code: the model holds no `pre` block, so the
 * lines become an atomic and the chip renders them (visual-editor.tsx,
 * `applyFormat`, takes the same road for the format menu's Preformatted).
 *
 * A block quote becomes an indent (`:`), because that is the block the editor's
 * own indent control writes and this editor keeps one spelling per construct.
 */
export function markdownWikitext(text: string, origin: string): string {
  const out: string[] = [];
  const lines = text.split("\n");
  let fenced = false;

  for (const raw of lines) {
    const line = readLine(raw);
    if (line.kind === "fence") {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      // Verbatim, and never read as markdown: that is what a fence means.
      out.push(` ${raw}`);
      continue;
    }
    switch (line.kind) {
      case "blank":
        out.push("");
        break;
      case "rule":
        out.push("----");
        break;
      case "heading": {
        const marks = headingMarks(line.level);
        out.push(`${marks} ${inlineMarkdown(line.text, origin)} ${marks}`);
        break;
      }
      case "item":
        out.push(
          `${line.marker.repeat(line.depth + 1)} ${inlineMarkdown(line.text, origin)}`.trimEnd(),
        );
        break;
      case "quote":
        out.push(`: ${inlineMarkdown(line.text, origin)}`.trimEnd());
        break;
      case "text":
        out.push(inlineMarkdown(line.text, origin));
        break;
    }
  }
  // A run of blank lines is one paragraph break however many the author had.
  // Only *blank lines* come off the ends, never whitespace: the leading space
  // is what makes a preformatted line preformatted (§3.2), so a paste opening
  // with a fence would otherwise lose the very thing it just wrote.
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\s*\n+$/, "");
}

/* ------------------------------------------------------------------ */
/* The reading                                                         */
/* ------------------------------------------------------------------ */

/** Folds the line endings the parser folds first anyway (§4). */
function foldNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * Inline or blocks — asked of the parser rather than guessed at.
 *
 * A conversion that produced exactly one paragraph produced inline content,
 * whatever markers went into it, so it belongs in the block the caret is
 * already in: pasting `**hello**` in the middle of a sentence must embolden
 * two words, not open a paragraph. Anything else is structure and needs blocks
 * of its own.
 */
function shape(wikitext: string): VePaste {
  if (wikitext === "") return { kind: "text", text: "" };
  let single = false;
  try {
    const doc = parseDocument(wikitext);
    single = doc.blocks.length === 1 && doc.blocks[0].kind === "paragraph";
  } catch {
    single = false;
  }
  return single ? { kind: "inline", wikitext } : { kind: "blocks", wikitext };
}

/**
 * What the clipboard means, in the units the surface puts things in.
 *
 * The order of the three readings is the one this module's header states, and
 * each of them is a whole-paste decision: a paste is a URL, or it is wikitext,
 * or it is markdown. Nothing is decided per line, because a line's meaning
 * depends on which of the two grammars is being read.
 */
export function readPaste(input: VePasteInput): VePaste {
  const origin = input.origin ?? "";
  const text = foldNewlines(input.text);
  if (text === "") return { kind: "text", text: "" };

  // 1 — a URL.
  if (isUrl(text)) {
    const url = text.trim();
    if (input.selection !== "") {
      return { kind: "inline", wikitext: linkWikitext(url, input.selection, origin) };
    }
    const target = internalTarget(url, origin);
    // A bare external URL is left alone: the engine linkifies it where it
    // stands (§6.2 "free"), so writing brackets around it would only take the
    // URL off the screen and put a `[1]` in its place.
    return target === null
      ? { kind: "text", text: url }
      : { kind: "inline", wikitext: `[[${target}]]` };
  }

  // A cell holds inline content and nothing else (§7.3). The lines are folded
  // to spaces — a cell cannot hold a newline, because every table marker sits
  // at the start of a line (§7.1) — and the markup is read only where it
  // cannot become a block.
  if (input.inCell) {
    const flat = text.replace(/\s*\n\s*/g, " ").trim();
    if (looksLikeWikitext(flat)) return { kind: "inline", wikitext: flat };
    return { kind: "inline", wikitext: inlineMarkdown(flat, origin) };
  }

  // 2 — already ours.
  if (looksLikeWikitext(text)) return shape(text.trim());

  // 3 — a grid, then markdown.
  const grid = readGrid(text);
  if (grid !== null) return { kind: "blocks", wikitext: gridWikitext(grid, origin) };

  const wikitext = markdownWikitext(text, origin);
  if (wikitext === "") return { kind: "text", text: "" };
  return shape(wikitext);
}
