/**
 * The visual editor's document model — the single normative type module for
 * `src/lib/visual-editor/**` and the contenteditable surface that renders it.
 *
 * Normative spec: docs/engine/visual-editor.md (§2 model, §3 DOM mapping,
 * §4 round-trip guarantee). Wikitext grammar references are to
 * docs/engine/wikitext-spec.md.
 *
 * Three properties this shape exists to guarantee:
 *
 * 1. **Lossless for untouched content.** Every parsed block keeps its exact
 *    `source`, the `canonical` serialization it had at parse time, and the
 *    whitespace `gapAfter` that followed it. A block whose serialization still
 *    equals `canonical` is emitted as `source`, so publishing an unedited
 *    article reproduces it byte for byte (§4).
 * 2. **No structural information hides in the DOM.** Lists stay *flat*, each
 *    item keeping its literal wikitext marker (`"*"`, `"**"`, `"#*"`, `":"`,
 *    `";"`). Nesting is rebuilt for display and flattened again on read, so a
 *    mixed or malformed marker run survives the round trip.
 * 3. **Anything the model does not understand is atomic.** Templates,
 *    extension tags, raw HTML blocks, comments, categories and files become
 *    `atomic` nodes whose `source` is emitted verbatim and never re-parsed.
 *    A table is the one construct that is *both*: {@link VeTable} when every
 *    cell holds inline content that survives being written back, and an
 *    `atomic` of kind `"table"` — unchanged from before — when it does not.
 */

/* ------------------------------------------------------------------ */
/* Inline                                                              */
/* ------------------------------------------------------------------ */

/**
 * The seven character-formatting marks the visual toolbar exposes. Everything
 * else that dresses inline text (`<span>`, `<small>`, `<font>`, …) is an
 * inline atomic instead, so the serializer never has to invent markup.
 */
export type VeMark = "bold" | "italic" | "underline" | "strike" | "sup" | "sub" | "code";

/** The wikitext each mark serializes to (spec §1.1 for the apostrophes). */
export const MARK_SYNTAX: Record<VeMark, { before: string; after: string }> = {
  bold: { before: "'''", after: "'''" },
  italic: { before: "''", after: "''" },
  underline: { before: "<u>", after: "</u>" },
  strike: { before: "<s>", after: "</s>" },
  sup: { before: "<sup>", after: "</sup>" },
  sub: { before: "<sub>", after: "</sub>" },
  code: { before: "<code>", after: "</code>" },
};

/**
 * What an atomic node holds, which decides the chip the surface draws and the
 * icon beside it. `unknown` is the safe default — it still round-trips.
 */
export type VeAtomicKind =
  | "template"
  | "table"
  | "infobox"
  | "gallery"
  | "tabber"
  | "versions"
  | "media"
  | "category"
  | "comment"
  | "pre"
  | "redirect"
  | "html"
  | "nowiki"
  | "ref"
  | "magic"
  | "unknown";

export interface VeText {
  kind: "text";
  text: string;
}

export interface VeMarkNode {
  kind: "mark";
  mark: VeMark;
  children: VeInline[];
}

/**
 * `[[target|children]]`, or `[[target]]` when the children serialize to
 * exactly `target` (the serializer decides; there is no separate flag).
 */
export interface VeLink {
  kind: "link";
  target: string;
  children: VeInline[];
}

/** `[href children]`, or `[href]` when there are no children (spec §6.2). */
export interface VeExtLink {
  kind: "extlink";
  href: string;
  children: VeInline[];
}

/** An opaque inline construct: `{{tpl}}`, `<ref>`, `<nowiki>`, `<span>`, … */
export interface VeInlineAtomic {
  kind: "atomic";
  atomic: VeAtomicKind;
  /** Emitted verbatim on save; never re-parsed. */
  source: string;
  /** Short human label for the chip, e.g. a template name. */
  label: string;
}

/** `<br>` in any of its spellings, which `source` remembers. */
export interface VeBreak {
  kind: "break";
  source: string;
}

export type VeInline = VeText | VeMarkNode | VeLink | VeExtLink | VeInlineAtomic | VeBreak;

/* ------------------------------------------------------------------ */
/* Blocks                                                              */
/* ------------------------------------------------------------------ */

/**
 * The three fields that make §4's guarantee work, plus the id the DOM carries
 * in `data-ve-id` so a block read back out of the surface can be matched to
 * the block it came from.
 *
 * All three are `null` for a block the author created in the editor: it has no
 * original text to preserve, so it is always serialized canonically.
 */
export interface VeBlockBase {
  id: string;
  /** Exact original wikitext, without the surrounding blank lines. */
  source: string | null;
  /** `serializeBlock()` of this block as parsed — the "untouched" fingerprint. */
  canonical: string | null;
  /** Exact whitespace that followed the block in the original text. */
  gapAfter: string | null;
}

export interface VeParagraph extends VeBlockBase {
  kind: "paragraph";
  children: VeInline[];
}

/** `= h1 =` … `====== h6 ======` (spec §2). The UI offers 2–5. */
export type VeHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface VeHeading extends VeBlockBase {
  kind: "heading";
  level: VeHeadingLevel;
  children: VeInline[];
}

/**
 * One line of a list run. `marker` is the literal prefix as written — `"*"`,
 * `"**"`, `"#"`, `"#*"`, `":"`, `";"` — so a mixed run is preserved exactly
 * (spec §4).
 */
export interface VeListItem {
  marker: string;
  children: VeInline[];
}

export interface VeList extends VeBlockBase {
  kind: "list";
  items: VeListItem[];
}

/** `----`; `dashes` keeps the run length so `-----` survives (spec §3.3). */
export interface VeRule extends VeBlockBase {
  kind: "rule";
  dashes: number;
}

/** A block the model deliberately does not understand. `source` is the truth. */
export interface VeAtomicBlock extends VeBlockBase {
  kind: "atomic";
  atomic: VeAtomicKind;
  source: string;
  label: string;
}

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */

/**
 * One cell of a table (spec §7.3).
 *
 * `children` is INLINE, and that is the whole reason a table can be a block
 * at all: a cell whose wikitext needs block treatment — a list, a heading, a
 * nested table, anything spread over continuation lines — is a cell this
 * model cannot hold, so its table stays a {@link VeAtomicBlock} instead
 * (parse.ts, `readTableShape`).
 *
 * `attrs` is the text before the cell's own `|` separator, kept verbatim and
 * never interpreted: `colspan="2"` is markup the engine's sanitizer owns
 * (spec §7.2), not something the editor may rewrite.
 */
export interface VeTableCell {
  /** A header cell, written with `!` rather than `|`. */
  header: boolean;
  /** Attributes before the cell's own separator, kept verbatim. */
  attrs: string;
  children: VeInline[];
}

export interface VeTableRow {
  /** Attributes on the row's `|-` marker, kept verbatim. */
  attrs: string;
  cells: VeTableCell[];
}

/**
 * `{| … |}` as a first-class block, so its cells are editable content rather
 * than code in a dialog (spec §7, visual-editor.md §2, §3).
 *
 * Two invariants hold for every table that reaches this type, and table.ts's
 * operations preserve both:
 *
 * - **At least one row, and every row at least one cell.** A `|-` that ends up
 *   with no cells renders nothing (spec §7.5), so the parser drops it and a
 *   table left with no rows at all refuses into an atomic. An empty table is
 *   litter, which is why removing the last row or column returns null.
 * - **Rows may be ragged.** Different rows really do have different cell
 *   counts in wikitext, and nothing here pads them: a column is an index into
 *   a row, not a promise that the row reaches it (table.ts states the rule the
 *   operations keep).
 */
export interface VeTable extends VeBlockBase {
  kind: "table";
  /** Attributes on the `{|` opener, e.g. `class="wikitable"`. Verbatim. */
  attrs: string;
  /** The `|+` caption, when the table has one. */
  caption: VeInline[] | null;
  rows: VeTableRow[];
}

/**
 * A table without §4's bookkeeping — what the parser builds before the block
 * wrapper goes on, and all the serializer needs to write one back. Keeping it
 * separate is what lets parse.ts check its own output for a fixed point
 * without inventing an id for a table it may still refuse.
 */
export type VeTableShape = Pick<VeTable, "attrs" | "caption" | "rows">;

export type VeBlock = VeParagraph | VeHeading | VeList | VeRule | VeTable | VeAtomicBlock;

/** `leading` is the exact text before the first block (normally `""`). */
export interface VeDocument {
  leading: string;
  blocks: VeBlock[];
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** A document with nothing in it — what an empty buffer parses to. */
export function emptyDocument(): VeDocument {
  return { leading: "", blocks: [] };
}

/**
 * Ids for blocks the author creates while editing. Parsing assigns `"b0"`,
 * `"b1"`, … positionally (so parse output is deterministic and diffable in
 * tests); everything minted later comes from a factory, which keeps a
 * document's ids unique without a global counter.
 */
export type VeIdFactory = () => string;

export function createIdFactory(prefix = "n"): VeIdFactory {
  let next = 0;
  return () => {
    next += 1;
    return `${prefix}${next}`;
  };
}

/** The base fields of a block created in the editor (§4: always canonical). */
export function newBlockBase(id: string): VeBlockBase {
  return { id, source: null, canonical: null, gapAfter: null };
}

/** Deep-ish clone used when a command rewrites one block in place. */
export function cloneInline(nodes: readonly VeInline[]): VeInline[] {
  return nodes.map((node) => {
    switch (node.kind) {
      case "mark":
        return { ...node, children: cloneInline(node.children) };
      case "link":
      case "extlink":
        return { ...node, children: cloneInline(node.children) };
      default:
        return { ...node };
    }
  });
}

/** Plain text of an inline run — the chip labels and link-bareness test. */
export function inlineText(nodes: readonly VeInline[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        out += node.text;
        break;
      case "mark":
      case "link":
      case "extlink":
        out += inlineText(node.children);
        break;
      case "atomic":
        out += node.label;
        break;
      case "break":
        out += " ";
        break;
    }
  }
  return out;
}

/** True when an inline run holds nothing an author could see. */
export function isInlineEmpty(nodes: readonly VeInline[]): boolean {
  return nodes.every((node) => node.kind === "text" && node.text === "");
}
