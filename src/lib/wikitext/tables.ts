/**
 * Stage 4 — table scanner (spec §7).
 *
 * Input lines are EXPANDED + SANITIZED wikitext: `{{!}}` / `{{=}}` already
 * arrived as literal `|` / `=`, raw HTML is already normalized, and strip
 * markers are opaque atoms. The scanner is line-based and recursive: a `{|`
 * met inside a cell's continuation region is swallowed verbatim (with depth
 * counting) into that cell's buffer and re-parsed when the cell body goes
 * back through the block parser (§7.9).
 *
 * Owned by the block-parser agent together with blocks.ts / lists.ts.
 */

import type {
  Attrs,
  BlockNode,
  DefinitionList,
  InlineNode,
  Table,
  TableCell,
  TableRow,
} from "./types";
import type { BlockEnv } from "./blocks";

/* ------------------------------------------------------------------ */
/* Line predicates                                                     */
/* ------------------------------------------------------------------ */

/** `{|` at line start, after an optional run of `:` indent chars (§7.8). */
export const TABLE_START_RE = /^(:*)\{\|(.*)$/;

export function isTableStart(line: string): boolean {
  return TABLE_START_RE.test(line);
}

/* ------------------------------------------------------------------ */
/* HTML attribute strings (§7.2 → §11.3/§11.4)                          */
/* ------------------------------------------------------------------ */

/**
 * `name="v"` / `name='v'` / `name=v` / bare `name`, whitespace separated.
 * Linear scan (no nested quantifiers — §14.11).
 */
export function parseHtmlAttributes(src: string): Attrs {
  const out: Attrs = {};
  let i = 0;
  const n = src.length;
  while (i < n) {
    while (i < n && /\s/.test(src[i]!)) i++;
    if (i >= n) break;
    const nameStart = i;
    while (i < n && !/[\s=/>"'<]/.test(src[i]!)) i++;
    if (i === nameStart) {
      i++; // unusable character (stray `=`, quote, …) — skip it
      continue;
    }
    const name = src.slice(nameStart, i).toLowerCase();
    let j = i;
    while (j < n && /\s/.test(src[j]!)) j++;
    if (src[j] !== "=") {
      out[name] = "";
      continue;
    }
    j++;
    while (j < n && /\s/.test(src[j]!)) j++;
    const quote = src[j];
    if (quote === '"' || quote === "'") {
      const end = src.indexOf(quote, j + 1);
      if (end < 0) {
        out[name] = src.slice(j + 1);
        i = n;
      } else {
        out[name] = src.slice(j + 1, end);
        i = end + 1;
      }
    } else {
      const start = j;
      while (j < n && !/\s/.test(src[j]!)) j++;
      out[name] = src.slice(start, j);
      i = j;
    }
  }
  return out;
}

const GLOBAL_ATTRS = new Set(["id", "class", "style", "lang", "dir", "title", "role"]);
const ARIA_ATTRS = new Set([
  "aria-describedby",
  "aria-flowto",
  "aria-hidden",
  "aria-label",
  "aria-labelledby",
  "aria-owns",
]);
const REJECTED_DATA = new Set(["data-mw", "data-parsoid", "data-ooui"]);

/** §11.3, restricted to the elements the table grammar can emit. */
const CELL_ATTRS: ReadonlySet<string> = new Set([
  "colspan",
  "rowspan",
  "headers",
  "scope",
  "abbr",
  "axis",
  "align",
  "valign",
  "bgcolor",
  "width",
  "height",
  "nowrap",
]);

const PER_ELEMENT: Readonly<Record<string, ReadonlySet<string>>> = {
  table: new Set([
    "border",
    "cellpadding",
    "cellspacing",
    "align",
    "bgcolor",
    "frame",
    "rules",
    "summary",
    "width",
  ]),
  td: CELL_ATTRS,
  th: CELL_ATTRS,
  tr: new Set(["align", "valign", "bgcolor"]),
  caption: new Set(["align"]),
};

const INSECURE_STYLE = "/* insecure input */";

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => {
      const cp = parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "�";
    })
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const cp = parseInt(dec, 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "�";
    })
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

const STYLE_BLOCKLIST = [
  "expression",
  "javascript:",
  "vbscript:",
  "url(",
  "image(",
  "image-set(",
  "attr(",
  "var(",
  "-moz-binding",
  "behavior:",
  "accelerator:",
  "@import",
  "</",
];

const CONTROL_CHARS_RE = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]");

/**
 * §11.4 — accept the declared style only if it survives entity/CSS-escape
 * decoding, comment stripping and the blocklist; otherwise the whole value is
 * replaced with the "insecure input" placeholder.
 */
export function filterStyleValue(value: string): string {
  let s = decodeBasicEntities(value);
  s = s.replace(/\\([0-9a-fA-F]{1,6})[ \t]?/g, (_m, hex: string) => {
    const cp = parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "�";
  });
  s = s.replace(/\\([^\n])/g, "$1");
  if (CONTROL_CHARS_RE.test(s)) return INSECURE_STYLE;
  const withoutComments = s.replace(/\/\*[\s\S]*?\*\//g, "");
  if (withoutComments.includes("/*")) return INSECURE_STYLE;
  const lower = withoutComments.toLowerCase();
  for (const bad of STYLE_BLOCKLIST) {
    if (lower.includes(bad)) return INSECURE_STYLE;
  }
  if (/filter[ \t]*:[^;]*progid/.test(lower)) return INSECURE_STYLE;
  return value;
}

function isAllowedAttribute(tag: string, name: string): boolean {
  if (name.startsWith("data-")) {
    if (REJECTED_DATA.has(name)) return false;
    return /^data-[a-z0-9_.:-]+$/.test(name);
  }
  if (GLOBAL_ATTRS.has(name) || ARIA_ATTRS.has(name)) return true;
  return PER_ELEMENT[tag]?.has(name) ?? false;
}

/**
 * §7.2 — filter a parsed attribute bag through the §11.3 allowlist for one of
 * the table-family elements. Disallowed names are dropped silently.
 */
export function filterAttributes(tag: string, raw: Attrs): Attrs {
  const out: Attrs = {};
  for (const key of Object.keys(raw)) {
    const name = key.toLowerCase();
    if (!isAllowedAttribute(tag, name)) continue;
    const value = raw[key] ?? "";
    if (name === "style") {
      out.style = filterStyleValue(value);
    } else if (name === "dir") {
      const d = value.trim().toLowerCase();
      if (d === "ltr" || d === "rtl") out.dir = d;
    } else {
      out[name] = value;
    }
  }
  return out;
}

function attrsFor(tag: string, src: string): Attrs {
  const trimmed = src.trim();
  if (trimmed === "") return {};
  return filterAttributes(tag, parseHtmlAttributes(trimmed));
}

/* ------------------------------------------------------------------ */
/* Cell splitting (§7.3)                                               */
/* ------------------------------------------------------------------ */

/**
 * Split a cell line's remainder on the literal `||` token; header lines split
 * on `!!` as well (`!!` never splits a data line).
 */
export function splitCellPieces(rest: string, header: boolean): string[] {
  const pieces: string[] = [];
  let start = 0;
  let i = 0;
  while (i + 1 < rest.length) {
    const two = rest.charAt(i) + rest.charAt(i + 1);
    if (two === "||" || (header && two === "!!")) {
      pieces.push(rest.slice(start, i));
      i += 2;
      start = i;
      continue;
    }
    i++;
  }
  pieces.push(rest.slice(start));
  return pieces;
}

/**
 * §7.3 attribute split: only the first `|` splits, and only when the segment
 * before it contains no `[[` (the wikilink veto). A segment that yields no
 * allowed attribute is still consumed — content never falls back.
 */
export function splitCellAttrs(piece: string): { attrs: string | null; content: string } {
  const p = piece.indexOf("|");
  if (p < 0) return { attrs: null, content: piece };
  const before = piece.slice(0, p);
  if (before.includes("[[")) return { attrs: null, content: piece };
  return { attrs: before, content: piece.slice(p + 1) };
}

/* ------------------------------------------------------------------ */
/* The scanner                                                         */
/* ------------------------------------------------------------------ */

interface OpenCell {
  header: boolean;
  attrs: Attrs;
  lines: string[];
}

export interface TableScanResult {
  /** The `<table>` (wrapped in `<dl><dd>` levels when the start line was indented). */
  block: BlockNode;
  /** Text after `|}` on the closing line, re-queued as a fresh line (§7.1). */
  trailing: string | null;
  /** Index of the first line after the table. */
  next: number;
}

function isWhitespaceOnly(line: string): boolean {
  return line.trim() === "";
}

/** Non-wrapping block container: renders its inline children with no element. */
function transparent(children: InlineNode[]): BlockNode {
  return { type: "html-block", tag: "", attrs: {}, children };
}

function buildCell(open: OpenCell, env: BlockEnv): TableCell {
  const lines = open.lines.slice();
  while (lines.length > 1 && isWhitespaceOnly(lines[lines.length - 1]!)) lines.pop();
  if (lines.length > 0) lines[0] = lines[0]!.replace(/^[ \t]+/, "");
  let children: BlockNode[];
  if (lines.length <= 1) {
    // §7.3: a single-line cell is emitted without a <p> wrapper.
    const content = (lines[0] ?? "").trim();
    children = content === "" ? [] : [transparent(env.inline(content))];
  } else {
    children = env.region(lines);
  }
  return { type: "cell", header: open.header, attrs: open.attrs, children };
}

/**
 * Parse the table starting at `lines[start]`. Returns null when that line is
 * not a table start.
 */
export function parseTableAt(
  lines: string[],
  start: number,
  env: BlockEnv,
): TableScanResult | null {
  const head = TABLE_START_RE.exec(lines[start] ?? "");
  if (!head) return null;

  const indent = head[1]!.length;
  const table: Table = {
    type: "table",
    attrs: attrsFor("table", head[2]!),
    rows: [],
    fostered: [],
  };

  const fosteredLines: string[] = [];
  let captionAttrs: Attrs | null = null;
  let captionLines: string[] | null = null;
  let capturing: "cell" | "caption" | "discard" | null = null;
  let cell: OpenCell | null = null;
  let row: TableRow | null = null;
  let trailing: string | null = null;

  const closeCell = (): void => {
    if (cell) {
      if (!row) row = { type: "tr", attrs: {}, cells: [] };
      row.cells.push(buildCell(cell, env));
      cell = null;
    }
    if (capturing === "cell") capturing = null;
  };
  const flushRow = (): void => {
    closeCell();
    // §7.5: a row that ended up with zero cells emits nothing.
    if (row && row.cells.length > 0) table.rows.push(row);
    row = null;
  };
  const appendContinuation = (line: string): void => {
    if (capturing === "cell" && cell) cell.lines.push(line);
    else if (capturing === "caption" && captionLines) captionLines.push(line);
    else if (capturing === "discard") {
      /* body of a dropped duplicate caption */
    } else fosteredLines.push(line);
  };

  let i = start + 1;
  while (i < lines.length) {
    const line = lines[i]!;

    // §7.9 nested table: swallowed verbatim into the current buffer and
    // re-parsed when that buffer goes back through the block parser.
    if (TABLE_START_RE.test(line)) {
      let depth = 1;
      const buf: string[] = [line];
      i++;
      while (i < lines.length && depth > 0) {
        const l = lines[i]!;
        if (TABLE_START_RE.test(l)) depth++;
        else if (l.startsWith("|}")) depth--;
        buf.push(l);
        i++;
      }
      for (const l of buf) appendContinuation(l);
      continue;
    }

    if (line.startsWith("|}")) {
      const rest = line.slice(2).replace(/^[ \t]+/, "");
      if (rest !== "") trailing = rest;
      i++;
      break;
    }

    if (line.startsWith("|+")) {
      closeCell();
      const split = splitCellAttrs(line.slice(2));
      if (captionLines === null) {
        captionAttrs = split.attrs === null ? {} : attrsFor("caption", split.attrs);
        captionLines = [split.content.trim()];
        capturing = "caption";
      } else {
        env.meta.warnings.push("Extra table caption ignored (spec §7.4)");
        capturing = "discard";
      }
      i++;
      continue;
    }

    if (/^\|-/.test(line)) {
      flushRow();
      const rest = line.replace(/^\|-+/, "");
      row = { type: "tr", attrs: attrsFor("tr", rest), cells: [] };
      capturing = null;
      i++;
      continue;
    }

    if (line.startsWith("!") || line.startsWith("|")) {
      const header = line.startsWith("!");
      closeCell();
      if (!row) row = { type: "tr", attrs: {}, cells: [] };
      const pieces = splitCellPieces(line.slice(1), header);
      for (let k = 0; k < pieces.length; k++) {
        const split = splitCellAttrs(pieces[k]!);
        const open: OpenCell = {
          header,
          attrs: split.attrs === null ? {} : attrsFor(header ? "th" : "td", split.attrs),
          lines: [split.content],
        };
        if (k === pieces.length - 1) {
          cell = open;
          capturing = "cell";
        } else {
          row.cells.push(buildCell(open, env));
        }
      }
      i++;
      continue;
    }

    appendContinuation(line);
    i++;
  }

  flushRow();

  if (captionLines !== null) {
    const text = captionLines.join("\n").trim();
    table.caption = { attrs: captionAttrs ?? {}, children: env.inline(text) };
  }
  if (fosteredLines.length > 0) {
    // §7.7: content before the first cell is emitted BEFORE the <table>.
    table.fostered = env.region(fosteredLines);
  }

  // §7.8 — `:`-indent wraps the whole table in that many <dl><dd> levels.
  let block: BlockNode = table;
  for (let d = 0; d < indent; d++) {
    const dl: DefinitionList = {
      type: "dl",
      items: [{ type: "dd", children: [block] }],
    };
    block = dl;
  }

  return { block, trailing, next: i };
}
