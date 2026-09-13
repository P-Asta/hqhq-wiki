/**
 * `VeDocument` → wikitext: the second half of the round-trip contract in
 * docs/engine/visual-editor.md §4.
 *
 * Two properties make that contract work, and both live here.
 *
 * 1. **Serializing a block never looks at its `source`.** `serializeBlock()`
 *    is a pure function of the parsed shape, so `parseDocument()` can call it
 *    once and store the answer as `canonical`. "Did the author touch this
 *    block?" then costs one string comparison instead of a diff.
 * 2. **`serializeDocument()` prefers `source` over its own output.** A block
 *    that still serializes to its `canonical` fingerprint is written back
 *    exactly as it was read — original spacing, and the original gap for as
 *    long as that gap still separates it from whatever follows it now — so
 *    publishing an unedited article reproduces it byte for byte. Only the
 *    blocks whose shape actually changed get re-rendered, and they come out
 *    canonical.
 *
 * Nothing here escapes anything. Text is emitted verbatim: no `<nowiki>` is
 * inserted around prose that happens to look like markup (§4, §7). The price
 * is that an author who literally types `''` into the visual surface gets
 * italics back on the next parse — the same trade Fandom's own visual editor
 * makes, and the reason the model keeps `source` at all.
 */

import { MARK_SYNTAX } from "@/lib/visual-editor/model";
import type {
  VeBlock,
  VeDocument,
  VeInline,
  VeTableCell,
  VeTableShape,
} from "@/lib/visual-editor/model";

/* ------------------------------------------------------------------ */
/* Inline                                                              */
/* ------------------------------------------------------------------ */

/**
 * Wikitext for one inline run.
 *
 * Marks nest by wrapping, which is why bold-around-italic falls out as five
 * apostrophes without a special case: `'''` + `''` is exactly the wikitext
 * for bold-italic (spec §1.1).
 */
export function serializeInline(nodes: readonly VeInline[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        out += node.text;
        break;
      case "mark": {
        const syntax = MARK_SYNTAX[node.mark];
        out += syntax.before + serializeInline(node.children) + syntax.after;
        break;
      }
      case "link": {
        // `[[Foo]]` and `[[Foo|Foo]]` render identically, so the bare form is
        // chosen whenever the label adds nothing — that is what keeps an
        // untouched `[[Foo]]` from growing a pipe on save.
        const label = serializeInline(node.children);
        out += label === node.target ? `[[${node.target}]]` : `[[${node.target}|${label}]]`;
        break;
      }
      case "extlink":
        out +=
          node.children.length === 0
            ? `[${node.href}]`
            : `[${node.href} ${serializeInline(node.children)}]`;
        break;
      case "atomic":
        out += node.source;
        break;
      case "break":
        out += node.source;
        break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */

/**
 * The wikitext for one cell: `attrs | content`, or just the content when the
 * cell carries no attributes (spec §7.3's attribute split, read backwards).
 *
 * The separator is spaced on both sides because that is the form the split
 * reads back unchanged: `attrs` never contains `[[` (a segment that does is
 * content, not attributes, so the parser never stores one) and the first `|`
 * is the one we just wrote, so re-parsing lands on exactly this boundary.
 */
export function serializeTableCell(cell: VeTableCell): string {
  const content = serializeInline(cell.children);
  return cell.attrs === "" ? content : `${cell.attrs} | ${content}`;
}

/** `!` and `!!` for a header run, `|` and `||` for a data run (spec §7.3). */
function cellRunLine(cells: readonly VeTableCell[], header: boolean): string {
  const body = cells.map(serializeTableCell).join(header ? " !! " : " || ");
  const marker = header ? "!" : "|";
  return body === "" ? marker : `${marker} ${body}`;
}

/**
 * Wikitext for a table — the canonical form of visual-editor.md's table
 * mapping:
 *
 * ```
 * {| attrs
 * |+ caption
 * |-
 * ! header !! header
 * |-
 * | cell || cell
 * |}
 * ```
 *
 * Three things that are choices rather than the only spelling, and each is
 * safe for the same reason the spaced heading `== Foo ==` is (§4): a table
 * nobody edited is emitted from its `source`, so a page only adopts this form
 * where the author actually changed a table.
 *
 * - **Every row is introduced by `|-`,** including the first, which wikitext
 *   lets an author leave implicit (spec §7.5).
 * - **A row is written on as few lines as it has runs of like cells.** Header
 *   and data cells cannot share a line — `||` splits a header line into more
 *   `<th>` (spec §7.3) — so a row that mixes them writes one line per run,
 *   and a uniform row writes exactly one.
 * - **The caption comes first,** wherever the `|+` was. The engine emits it
 *   first regardless (spec §7.4), so this changes bytes and not rendering.
 *
 * Nothing is escaped here, as nowhere else in this file is (§4). A cell whose
 * content an author has typed a literal `||` into therefore splits in two on
 * the next parse — the same bargain as typing `''` into a paragraph, and the
 * reason {@link serializeTableCell} is never asked to invent a `<nowiki>`.
 */
export function serializeTable(table: VeTableShape): string {
  const lines: string[] = [table.attrs === "" ? "{|" : `{| ${table.attrs}`];

  if (table.caption !== null) {
    const caption = serializeInline(table.caption);
    lines.push(caption === "" ? "|+" : `|+ ${caption}`);
  }

  for (const row of table.rows) {
    lines.push(row.attrs === "" ? "|-" : `|- ${row.attrs}`);
    let run: VeTableCell[] = [];
    for (const cell of row.cells) {
      if (run.length > 0 && run[0].header !== cell.header) {
        lines.push(cellRunLine(run, run[0].header));
        run = [];
      }
      run.push(cell);
    }
    if (run.length > 0) lines.push(cellRunLine(run, run[0].header));
  }

  lines.push("|}");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Blocks                                                              */
/* ------------------------------------------------------------------ */

/**
 * Wikitext for one block, with **no** trailing newline and no gap — the gap
 * belongs to the document, not to the block (§4).
 *
 * Headings and list items are written in their spaced form (`== Foo ==`,
 * `* item`), and a table in the shape {@link serializeTable} describes. Each
 * is deliberately *a* canonical form rather than *the* original one: an
 * article written `==Foo==` keeps its own spelling through the `source` rule
 * in {@link serializeDocument}, and only adopts the spaced form once the
 * author edits that heading.
 */
export function serializeBlock(block: VeBlock): string {
  switch (block.kind) {
    case "paragraph":
      return serializeInline(block.children);
    case "heading": {
      const marker = "=".repeat(block.level);
      return `${marker} ${serializeInline(block.children)} ${marker}`;
    }
    case "list":
      return block.items
        .map((item) => `${item.marker} ${serializeInline(item.children)}`)
        .join("\n");
    case "rule":
      return "-".repeat(block.dashes);
    case "table":
      return serializeTable(block);
    case "atomic":
      return block.source;
  }
}

/* ------------------------------------------------------------------ */
/* Document                                                            */
/* ------------------------------------------------------------------ */

/** A gap with a blank line in it ends every block the grammar has. */
const BLANK_LINE = /\n[^\S\n]*\n/;

/**
 * The whitespace between one block and the next.
 *
 * `gapAfter` is what separated this block from the block that followed it *at
 * parse time*, and that block can be gone: the author typed a new paragraph
 * behind it, or split it in two. The stored gap does not always survive the
 * change — a lone `"\n"` separates a paragraph from a heading but glues it to
 * another paragraph — so it is only reused while it still separates.
 *
 * - Nothing follows: any gap does, including the empty one a document without
 *   a trailing newline ends on.
 * - The gap must end the block's line, or the next block starts on this one.
 * - A blank line ends any run, so a gap holding one always separates.
 * - Otherwise the pair decides. Two paragraphs, or two lists, with no blank
 *   line between them are *one* block to the parser — which is why a parsed
 *   document can never hold that pair, and why re-deriving the gap there can
 *   never disturb §4's byte-identical guarantee.
 */
function gapBetween(block: VeBlock, next: VeBlock | null): string {
  const stored = block.gapAfter;
  if (next === null) return stored ?? "\n";
  if (stored === null || !stored.endsWith("\n")) return "\n\n";
  if (BLANK_LINE.test(stored)) return stored;
  const runsOn = block.kind === next.kind && (block.kind === "paragraph" || block.kind === "list");
  return runsOn ? "\n\n" : stored;
}

/**
 * Wikitext for a whole document.
 *
 * The gap defaults matter as much as the blocks: a block minted in the editor
 * has `gapAfter === null` and gets a blank line after it, except as the last
 * block where a single newline is the house ending (§4).
 */
export function serializeDocument(doc: VeDocument): string {
  let out = doc.leading;
  for (let i = 0; i < doc.blocks.length; i += 1) {
    const block = doc.blocks[i];
    const text = serializeBlock(block);
    // §4: an untouched block is emitted from `source`. `canonical` is what
    // this same function returned at parse time, so an equal `text` proves
    // the block's shape is unchanged — no comparison of the sources needed.
    const untouched = block.source !== null && block.canonical !== null && text === block.canonical;
    const next = i + 1 < doc.blocks.length ? doc.blocks[i + 1] : null;
    out += (untouched ? block.source : text) + gapBetween(block, next);
  }
  return out;
}
