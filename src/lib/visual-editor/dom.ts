/**
 * The bridge between `VeDocument` and the contenteditable surface — the model
 * written out as HTML, and the surface's markup read back as a model.
 *
 * Normative spec: docs/engine/visual-editor.md §3 (the mapping table) and §4
 * (the bookkeeping a read-back has to carry across). Types: model.ts.
 *
 * The two directions are deliberately asymmetric.
 *
 * - **Writing is exact.** Every block carries `data-ve` and `data-ve-id`, so a
 *   node read back can be matched to the block it came from and inherit that
 *   block's `source`/`canonical`/`gapAfter` — which is the whole of §4's
 *   byte-identical guarantee. Atomics are written `contenteditable="false"`
 *   with an EMPTY body: their wikitext lives only in `data-ve-src`, never
 *   anywhere the reader could mistake it for authored content.
 * - **Reading is tolerant.** The surface is uncontrolled, so most of what we
 *   read back was produced by the browser and `document.execCommand`, not by
 *   us: `<strong>` for bold, `<font>` wrappers, `<div>` for a new line, a
 *   duplicated `data-ve-id` where Enter split a paragraph. Every one of those
 *   degrades to something sane, and nothing in here throws.
 *
 * Three places the DOM cannot hold everything the model does, and what we
 * trade there:
 *
 * - Two constructs the writer synthesizes are byte-identical to content an
 *   author can write by hand: the filler `<br>` that gives an empty paragraph
 *   its height, and the `<li>` opened for a list level a marker jumped over.
 *   Both are labelled where they are written (`data-ve-filler`,
 *   `data-ve-hold`) and dropped again only where that label says so, because
 *   guessing from the shape deletes the author's own empty line or empty
 *   bullet.
 * - A `<br>` carries no spelling either, so the one it was written with rides
 *   along in `data-ve-break`; a break the browser made has none and reads back
 *   as `<br />`.
 * - A rule's dash count and a block atomic's chip label are not in the markup;
 *   both are recovered from the matching previous block, and fall back to
 *   `----` and a label derived from the source.
 * - A table cell cannot hold a newline, because every table marker sits at the
 *   start of a line (spec §7.1). The writer never emits one; the reader folds
 *   the ones a paste brings in to spaces, the way a paragraph's are folded.
 *
 * `domToDocument` reads a structural subset of `Node` (`VeDomNode`) rather
 * than `Node` itself, so the whole module is testable under vitest's node
 * environment with plain object literals. Real DOM nodes satisfy it
 * structurally.
 */

import {
  inlineText,
  newBlockBase,
  type VeAtomicKind,
  type VeBlock,
  type VeBlockBase,
  type VeDocument,
  type VeHeadingLevel,
  type VeIdFactory,
  type VeInline,
  type VeList,
  type VeListItem,
  type VeMark,
  type VeTable,
  type VeTableCell,
  type VeTableRow,
} from "@/lib/visual-editor/model";

/**
 * The structural subset of DOM `Node` this module reads. `getAttribute` is
 * optional because text nodes do not have one.
 */
export interface VeDomNode {
  /** 1 element, 3 text. */
  nodeType: number;
  /** Uppercase tag name for elements, `"#text"` for text nodes. */
  nodeName: string;
  /** Text for text nodes. */
  nodeValue: string | null;
  childNodes: ArrayLike<VeDomNode>;
  getAttribute?(name: string): string | null;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** A hostile or looping subtree must not blow the stack; it degrades to text. */
const MAX_DEPTH = 64;

/** Longest chip label derived from an atomic's source. */
const LABEL_MAX = 48;

/**
 * The two labels the writer puts on markup it synthesized, and which the
 * reader drops on the way back. Anything wearing neither is the author's, even
 * where it has the same shape (§4): a lone `<br>` is their spacer line, an
 * empty `<li>` above a deeper one is their empty bullet.
 *
 * The surface writes them too, wherever it builds one of these by hand
 * (`newParagraph`, `normalizeLists`).
 */
const FILLER_ATTR = "data-ve-filler";
const HOLD_ATTR = "data-ve-hold";

/** Carries a break's original spelling, which the DOM cannot hold. */
const BREAK_ATTR = "data-ve-break";

/**
 * Carries the verbatim wikitext attributes of a table, a row or a cell (§3).
 * They are NOT written as real HTML attributes: the sanitizer that decides
 * which of them an article may keep is the engine's (spec §7.2, §11.3), and
 * the surface is not a renderer.
 */
const ATTRS_ATTR = "data-ve-attrs";

/* ------------------------------------------------------------------ */
/* Escaping                                                            */
/* ------------------------------------------------------------------ */

/**
 * Escapes text for both element content and double-quoted attribute values —
 * one function rather than two, because every attribute this module writes is
 * double-quoted and `data-ve-src` holds arbitrary wikitext.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------------ */
/* Model → HTML                                                        */
/* ------------------------------------------------------------------ */

const MARK_TAG: Record<VeMark, string> = {
  bold: "b",
  italic: "i",
  underline: "u",
  strike: "s",
  sup: "sup",
  sub: "sub",
  code: "code",
};

export function inlineToHtml(nodes: readonly VeInline[]): string {
  let html = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        html += escapeHtml(node.text);
        break;
      case "mark": {
        const tag = MARK_TAG[node.mark];
        html += `<${tag}>${inlineToHtml(node.children)}</${tag}>`;
        break;
      }
      case "link":
        // No `href`: a wiki link inside the surface must never navigate.
        html +=
          `<a data-ve="link" data-ve-target="${escapeHtml(node.target)}">` +
          `${inlineToHtml(node.children)}</a>`;
        break;
      case "extlink":
        html +=
          `<a data-ve="extlink" data-ve-href="${escapeHtml(node.href)}">` +
          `${inlineToHtml(node.children)}</a>`;
        break;
      case "atomic":
        html +=
          `<span data-ve="atomic" data-ve-kind="${escapeHtml(node.atomic)}"` +
          ` data-ve-src="${escapeHtml(node.source)}" contenteditable="false">` +
          `${escapeHtml(node.label)}</span>`;
        break;
      case "break":
        // The spelling is not recoverable from a DOM `<br>`, so it travels in
        // an attribute: without it every save reflows an untouched paragraph
        // whose original said `<br>` onto one line (§4).
        html += `<br ${BREAK_ATTR}="${escapeHtml(node.source)}">`;
        break;
    }
  }
  return html;
}

/** The list element and item element one marker character opens (§3). */
function levelTags(char: string): { list: string; item: string } {
  switch (char) {
    case "#":
      return { list: "ol", item: "li" };
    case ":":
      return { list: "dl", item: "dd" };
    case ";":
      return { list: "dl", item: "dt" };
    default:
      return { list: "ul", item: "li" };
  }
}

interface OpenLevel {
  char: string;
  list: string;
  item: string;
}

/**
 * Rebuilds the nested list tree from the flat markers: open the levels a
 * marker adds, close the ones it drops, and close-and-reopen where a character
 * at a shared depth changes (`*` then `#` is two sibling lists, as in
 * MediaWiki). A nested list opens INSIDE the still-open item above it, which
 * is exactly what `collectListItems` expects to walk back out.
 *
 * A marker change at depth 0 therefore emits more than one root element. Only
 * the first carries `data-ve`/`data-ve-id`; the reader rejoins a run of
 * id-less list siblings into the one block they came from.
 */
function listToHtml(block: VeList): string {
  const stack: OpenLevel[] = [];
  let html = "";
  let rooted = false;

  for (const item of block.items) {
    // A marker can only be empty if something upstream lost it; `*` keeps the
    // item visible rather than dropping it on the floor.
    const marker = item.marker === "" ? "*" : item.marker;

    let common = 0;
    while (
      common < marker.length &&
      common < stack.length &&
      marker.charAt(common) === stack[common].char
    ) {
      common += 1;
    }

    while (stack.length > common) {
      const level = stack[stack.length - 1];
      html += `</${level.item}></${level.list}>`;
      stack.pop();
    }

    if (stack.length === marker.length && stack.length > 0) {
      const level = stack[stack.length - 1];
      html += `</${level.item}><${level.item}>`;
    }

    while (stack.length < marker.length) {
      const char = marker.charAt(stack.length);
      const tags = levelTags(char);
      const attrs = rooted ? "" : ` data-ve="list" data-ve-id="${escapeHtml(block.id)}"`;
      // Every level but the marker's own is one it did not name, and the item
      // opened there holds nothing but the deeper list. It has to say so: an
      // item the author left empty above a deeper one is the same markup, and
      // reading the shape instead of the label deletes it.
      const hold = stack.length + 1 < marker.length ? ` ${HOLD_ATTR}=""` : "";
      html += `<${tags.list}${attrs}><${tags.item}${hold}>`;
      rooted = true;
      stack.push({ char, list: tags.list, item: tags.item });
    }

    html += inlineToHtml(item.children);
  }

  while (stack.length > 0) {
    const level = stack[stack.length - 1];
    html += `</${level.item}></${level.list}>`;
    stack.pop();
  }

  // An item-less list still needs an element to hold the id and the caret.
  if (!rooted) return `<ul data-ve="list" data-ve-id="${escapeHtml(block.id)}"></ul>`;
  return html;
}

/**
 * One editable region's inner HTML.
 *
 * The filler `<br>` is what gives an empty one its height, and what the
 * browser puts there itself the moment the caret lands in it. It is labelled
 * because an authored `<br>` spacer line is the same markup.
 */
function editableBody(children: readonly VeInline[]): string {
  const inner = inlineToHtml(children);
  return inner === "" ? `<br ${FILLER_ATTR}="">` : inner;
}

/**
 * §3's table mapping. The rows are written as bare `<tr>` children: browsers
 * insert the `<tbody>` themselves and the reader walks through whatever they
 * inserted, so writing one here would only be a second shape to keep in step.
 *
 * A cell is an ordinary editable region of the surrounding contenteditable —
 * no `contenteditable="false"`, no `data-ve-src` — which is the entire point
 * of the block existing. `data-ve="cell"` is what the surface's own controls
 * find the caret's cell by; the attribute strings ride along verbatim.
 */
function tableToHtml(block: VeTable): string {
  let html =
    `<table data-ve="table" data-ve-id="${escapeHtml(block.id)}"` +
    ` ${ATTRS_ATTR}="${escapeHtml(block.attrs)}">`;
  if (block.caption !== null) {
    html += `<caption data-ve="caption">${editableBody(block.caption)}</caption>`;
  }
  for (const row of block.rows) {
    html += `<tr ${ATTRS_ATTR}="${escapeHtml(row.attrs)}">`;
    for (const cell of row.cells) {
      const tag = cell.header ? "th" : "td";
      html +=
        `<${tag} data-ve="cell" ${ATTRS_ATTR}="${escapeHtml(cell.attrs)}">` +
        `${editableBody(cell.children)}</${tag}>`;
    }
    html += "</tr>";
  }
  return `${html}</table>`;
}

export function blockToHtml(block: VeBlock): string {
  const id = escapeHtml(block.id);
  switch (block.kind) {
    case "paragraph":
      return `<p data-ve="p" data-ve-id="${id}">${editableBody(block.children)}</p>`;
    case "heading": {
      const tag = `h${block.level}`;
      return `<${tag} data-ve="h" data-ve-id="${id}">${inlineToHtml(block.children)}</${tag}>`;
    }
    case "list":
      return listToHtml(block);
    case "table":
      return tableToHtml(block);
    case "rule":
      return `<div data-ve="rule" data-ve-id="${id}" contenteditable="false"><hr></div>`;
    case "atomic":
      // The body stays empty: §5 injects the rendered preview into it after
      // the document loads, and the source lives only in the attribute, where
      // the reader can never mistake it for something the author typed.
      return (
        `<div data-ve="atomic" data-ve-id="${id}" data-ve-kind="${escapeHtml(block.atomic)}"` +
        ` data-ve-src="${escapeHtml(block.source)}" contenteditable="false">` +
        `<div data-ve-body=""></div></div>`
      );
  }
}

export function documentToHtml(doc: VeDocument): string {
  let html = "";
  for (const block of doc.blocks) html += blockToHtml(block);
  return html;
}

/* ------------------------------------------------------------------ */
/* HTML → model: primitives                                            */
/* ------------------------------------------------------------------ */

function childrenOf(node: VeDomNode): VeDomNode[] {
  const out: VeDomNode[] = [];
  const list = node.childNodes;
  const length = list === null || list === undefined ? 0 : list.length;
  for (let i = 0; i < length; i += 1) {
    const child = list[i];
    if (child !== undefined && child !== null) out.push(child);
  }
  return out;
}

function attr(node: VeDomNode, name: string): string | null {
  const read = node.getAttribute;
  if (typeof read !== "function") return null;
  const value = read.call(node, name);
  return value === undefined ? null : value;
}

function isElement(node: VeDomNode): boolean {
  return node.nodeType === ELEMENT_NODE;
}

/**
 * The one character the surface is allowed to write into the document that the
 * author never typed (§3, "a caret beside a chip").
 *
 * An inline chip is `contenteditable="false"`, and a region whose only content
 * is one — a table cell holding a version tag — has **no text position beside
 * it** for a browser to put a caret in. Naming that position in a Range is not
 * enough: engines normalize a caret out of a place with nothing in it, which is
 * how clicking to the right of such a chip landed in the *next cell*. So the
 * surface parks a zero-width space there, and this is where it is taken back
 * out again, on every read, before anything can be published.
 *
 * Stripping it unconditionally also cleans up after a paste from a word
 * processor, which is where a stray one otherwise comes from.
 */
export const CARET_HOLDER = "\u200B";

/** Every character of `text` that belongs to the author. */
export function withoutCaretHolders(text: string): string {
  return text.includes(CARET_HOLDER) ? text.split(CARET_HOLDER).join("") : text;
}

function isBlank(text: string): boolean {
  return text.trim() === "";
}

/** Plain text of a subtree — what an unknown element contributes. */
function textOf(node: VeDomNode, depth: number): string {
  if (node.nodeType === TEXT_NODE) return withoutCaretHolders(node.nodeValue ?? "");
  if (depth > MAX_DEPTH) return "";
  let out = "";
  for (const child of childrenOf(node)) out += textOf(child, depth + 1);
  return out;
}

const ATOMIC_KINDS: readonly VeAtomicKind[] = [
  "template",
  "table",
  "infobox",
  "gallery",
  "tabber",
  "versions",
  "media",
  "category",
  "comment",
  "pre",
  "redirect",
  "html",
  "nowiki",
  "ref",
  "magic",
  "unknown",
];

/** `data-ve-kind` is author-visible markup, so an unrecognized one degrades. */
function toAtomicKind(value: string | null): VeAtomicKind {
  for (const kind of ATOMIC_KINDS) {
    if (kind === value) return kind;
  }
  return "unknown";
}

/**
 * The chip label a block atomic shows. Blocks do not carry their label in the
 * markup (only the source and the injected preview body), so it is rebuilt
 * from the first line of the source; a block that matches a previous one keeps
 * the label the parser gave it instead.
 */
function atomicLabel(source: string): string {
  const cut = source.indexOf("\n");
  const firstLine = cut < 0 ? source : source.slice(0, cut);
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  if (collapsed.length <= LABEL_MAX) return collapsed;
  return `${collapsed.slice(0, LABEL_MAX - 1)}…`;
}

/* ------------------------------------------------------------------ */
/* HTML → model: inline                                                */
/* ------------------------------------------------------------------ */

/** Everything `document.execCommand` and hand-written HTML spell a mark as. */
function markForTag(tag: string): VeMark | null {
  switch (tag) {
    case "B":
    case "STRONG":
      return "bold";
    case "I":
    case "EM":
      return "italic";
    case "U":
    case "INS":
      return "underline";
    case "S":
    case "DEL":
    case "STRIKE":
      return "strike";
    case "SUP":
      return "sup";
    case "SUB":
      return "sub";
    case "CODE":
    case "TT":
      return "code";
    default:
      return null;
  }
}

/** An `href` with a scheme (or protocol-relative) is an external link. */
function looksExternal(href: string | null): boolean {
  if (href === null) return false;
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
}

function anchorToInline(node: VeDomNode, depth: number): VeInline {
  const children = collectInline(node, depth + 1);
  const ve = attr(node, "data-ve");
  const declaredHref = attr(node, "data-ve-href");
  const href = attr(node, "href");
  if (ve === "extlink" || declaredHref !== null || looksExternal(href)) {
    return { kind: "extlink", href: declaredHref ?? href ?? "", children };
  }
  const target = attr(node, "data-ve-target");
  // A link the browser rebuilt keeps no target, so its own text is the target
  // — which is what `[[Foo]]` means anyway.
  return { kind: "link", target: target ?? inlineText(children), children };
}

function pushInline(out: VeInline[], node: VeDomNode, depth: number): void {
  if (node.nodeType === TEXT_NODE) {
    out.push({ kind: "text", text: withoutCaretHolders(node.nodeValue ?? "") });
    return;
  }
  if (!isElement(node)) return;
  if (depth > MAX_DEPTH) {
    out.push({ kind: "text", text: textOf(node, 0) });
    return;
  }

  const source = attr(node, "data-ve-src");
  if (source !== null) {
    // Never re-read an atomic's children: they hold a rendered preview, not
    // content. The label is the only thing the body is allowed to say.
    const label = textOf(node, 0);
    out.push({
      kind: "atomic",
      atomic: toAtomicKind(attr(node, "data-ve-kind")),
      source,
      label: label === "" ? atomicLabel(source) : label,
    });
    return;
  }

  const tag = node.nodeName;
  if (tag === "BR") {
    // Only the filler the writer labelled is dropped. An unlabelled `<br>` is
    // the author's — the standard vertical spacer — and keeping it is what
    // stops a lone-`<br>` line from vanishing on the next read (§4).
    if (attr(node, FILLER_ATTR) !== null) return;
    out.push({ kind: "break", source: attr(node, BREAK_ATTR) ?? "<br />" });
    return;
  }
  if (tag === "A") {
    out.push(anchorToInline(node, depth));
    return;
  }
  const mark = markForTag(tag);
  if (mark !== null) {
    out.push({ kind: "mark", mark, children: collectInline(node, depth + 1) });
    return;
  }
  if (tag === "FONT" || tag === "SPAN") {
    // Transparent: `execCommand` wraps selections in these for colour and
    // size, neither of which the model has a place for.
    for (const child of childrenOf(node)) pushInline(out, child, depth + 1);
    return;
  }
  const text = textOf(node, 0);
  if (text !== "") out.push({ kind: "text", text });
}

/**
 * Merges neighbouring text (transparent wrappers leave runs of it behind) and
 * drops the empty ones, so two DOM spellings of the same content compare
 * equal.
 */
function tidyInline(nodes: readonly VeInline[]): VeInline[] {
  const out: VeInline[] = [];
  for (const node of nodes) {
    if (node.kind === "text") {
      if (node.text === "") continue;
      const last = out.length > 0 ? out[out.length - 1] : null;
      if (last !== null && last.kind === "text") {
        out[out.length - 1] = { kind: "text", text: last.text + node.text };
        continue;
      }
    }
    out.push(node);
  }
  return out;
}

function collectInline(node: VeDomNode, depth: number): VeInline[] {
  const raw: VeInline[] = [];
  for (const child of childrenOf(node)) pushInline(raw, child, depth);
  return tidyInline(raw);
}

/* ------------------------------------------------------------------ */
/* HTML → model: table cells                                           */
/* ------------------------------------------------------------------ */

function isCellTag(tag: string): boolean {
  return tag === "TH" || tag === "TD";
}

function isRowGroupTag(tag: string): boolean {
  return tag === "TBODY" || tag === "THEAD" || tag === "TFOOT";
}

/**
 * Cell content with its newlines folded to spaces.
 *
 * Spec §7.1 puts every table marker at the start of a line, so a newline
 * inside a cell is not something the wikitext can hold: the following line
 * would read as a new cell, a new row, or the end of the table. The writer
 * never emits one — this is for the ones a paste brings in.
 *
 * An atomic keeps whatever its `data-ve-src` says, newlines included: that
 * attribute is the author's own wikitext (§3), and rewriting it to protect the
 * table around it would be this function editing something nobody asked it to.
 * A multi-line template call typed into a cell through §5's dialog is the one
 * way to break a table from inside, and it is the dialog's to prevent.
 */
function foldCellNewlines(nodes: readonly VeInline[]): VeInline[] {
  return nodes.map((node): VeInline => {
    switch (node.kind) {
      case "text":
        return { kind: "text", text: node.text.replace(/[\r\n]+/g, " ") };
      case "mark":
        return { ...node, children: foldCellNewlines(node.children) };
      case "link":
      case "extlink":
        return { ...node, children: foldCellNewlines(node.children) };
      case "atomic":
      case "break":
        return node;
    }
  });
}

/**
 * Whether an element inside a cell is a wrapper to see through.
 *
 * Enter inside a table cell makes the browser wrap that cell's content in a
 * block element, and a paste arrives wrapped in whatever the source page used.
 * A cell has no block level — that is precisely the condition on which its
 * table parsed at all (§7.3) — so the pieces join into one inline run.
 */
function isCellWrapper(tag: string): boolean {
  return tag === "P" || tag === "DIV";
}

function pushCellContent(out: VeInline[], node: VeDomNode, depth: number): void {
  if (depth > MAX_DEPTH) return;
  for (const child of childrenOf(node)) {
    const wrapper =
      isElement(child) && isCellWrapper(child.nodeName) && attr(child, "data-ve-src") === null;
    if (!wrapper) {
      pushInline(out, child, depth);
      continue;
    }
    // Two blocks in a cell were two lines, and wikitext reads a newline as a
    // space — the same fold `parseDocument` makes inside a paragraph (§4).
    if (out.length > 0) out.push({ kind: "text", text: " " });
    pushCellContent(out, child, depth + 1);
  }
}

/** One cell's or caption's inline content, however the browser wrapped it. */
function collectCellInline(node: VeDomNode, depth: number): VeInline[] {
  const raw: VeInline[] = [];
  pushCellContent(raw, node, depth);
  return foldCellNewlines(tidyInline(raw));
}

function readCell(node: VeDomNode, depth: number): VeTableCell {
  return {
    header: node.nodeName === "TH",
    attrs: attr(node, ATTRS_ATTR) ?? "",
    children: collectCellInline(node, depth),
  };
}

/**
 * The rows of a `<table>`, however the browser has arranged them.
 *
 * Tolerant in the two ways a table needs (§3): the `<tbody>` browsers insert
 * around every row is walked through rather than looked for, and a `<td>` left
 * outside a `<tr>` opens a row of its own instead of vanishing. A row that
 * ends up with no cells is dropped, which is both the model's invariant and
 * what the engine does with the `|-` it came from (§7.5).
 */
function collectRows(node: VeDomNode, rows: VeTableRow[], depth: number): void {
  if (depth > MAX_DEPTH) return;
  let loose: VeTableCell[] = [];
  const flushLoose = (): void => {
    if (loose.length === 0) return;
    rows.push({ attrs: "", cells: loose });
    loose = [];
  };

  for (const child of childrenOf(node)) {
    if (!isElement(child)) continue;
    const tag = child.nodeName;
    if (isRowGroupTag(tag)) {
      flushLoose();
      collectRows(child, rows, depth + 1);
      continue;
    }
    if (tag === "TR") {
      flushLoose();
      const cells: VeTableCell[] = [];
      for (const grandchild of childrenOf(child)) {
        if (isElement(grandchild) && isCellTag(grandchild.nodeName)) {
          cells.push(readCell(grandchild, depth + 1));
        }
      }
      if (cells.length > 0) rows.push({ attrs: attr(child, ATTRS_ATTR) ?? "", cells });
      continue;
    }
    if (isCellTag(tag)) loose.push(readCell(child, depth + 1));
  }
  flushLoose();
}

/** The `<caption>` a table opens with, or null — its presence is the model's. */
function findCaption(node: VeDomNode): VeDomNode | null {
  for (const child of childrenOf(node)) {
    if (isElement(child) && child.nodeName === "CAPTION") return child;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* HTML → model: identity (§4)                                         */
/* ------------------------------------------------------------------ */

interface ReadState {
  prev: Map<string, VeBlock>;
  claimed: Set<string>;
  nextId: VeIdFactory;
}

interface Identity {
  base: VeBlockBase;
  /** The block the id came from, when there is one. */
  prior: VeBlock | null;
}

/**
 * Resolves one element's `data-ve-id` into an id plus §4's bookkeeping.
 *
 * Splitting a paragraph with Enter leaves the browser holding two elements
 * with the same id. The first keeps it — and with it the original source, so
 * an untouched half still publishes byte-identically; every later claimant is
 * a new block with no history.
 */
function identify(domId: string | null, state: ReadState): Identity {
  const wanted = domId === null || domId === "" || state.claimed.has(domId) ? null : domId;
  if (wanted === null) {
    let fresh = state.nextId();
    while (state.claimed.has(fresh)) fresh = state.nextId();
    state.claimed.add(fresh);
    return { base: newBlockBase(fresh), prior: null };
  }
  state.claimed.add(wanted);
  const prior = state.prev.get(wanted);
  if (prior === undefined) return { base: newBlockBase(wanted), prior: null };
  return {
    base: {
      id: wanted,
      source: prior.source,
      canonical: prior.canonical,
      gapAfter: prior.gapAfter,
    },
    prior,
  };
}

/* ------------------------------------------------------------------ */
/* HTML → model: blocks                                                */
/* ------------------------------------------------------------------ */

type BlockShape = "paragraph" | "heading" | "list" | "table" | "rule" | "atomic" | "inline";

function isListTag(tag: string): boolean {
  return tag === "UL" || tag === "OL" || tag === "DL";
}

function headingLevel(tag: string): VeHeadingLevel | null {
  switch (tag) {
    case "H1":
      return 1;
    case "H2":
      return 2;
    case "H3":
      return 3;
    case "H4":
      return 4;
    case "H5":
      return 5;
    case "H6":
      return 6;
    default:
      return null;
  }
}

/** A wrapper whose whole content is an `<hr>` is the rule, not a paragraph. */
function wrapsRule(node: VeDomNode): boolean {
  let sawRule = false;
  for (const child of childrenOf(node)) {
    if (child.nodeType === TEXT_NODE) {
      if (!isBlank(child.nodeValue ?? "")) return false;
      continue;
    }
    if (!isElement(child)) continue;
    if (child.nodeName !== "HR") return false;
    sawRule = true;
  }
  return sawRule;
}

function classify(node: VeDomNode): BlockShape {
  if (attr(node, "data-ve-src") !== null) return "atomic";

  switch (attr(node, "data-ve")) {
    case "p":
      return "paragraph";
    case "h":
      return "heading";
    case "rule":
      return "rule";
    case "list":
      return "list";
    case "table":
      return "table";
    default:
      break;
  }

  const tag = node.nodeName;
  if (tag === "P") return "paragraph";
  if (headingLevel(tag) !== null) return "heading";
  if (isListTag(tag)) return "list";
  // A `<table>` wearing no label of ours is one the author pasted, and reading
  // it as a table is what turns that paste into wikitext instead of a wall of
  // run-together text.
  if (tag === "TABLE") return "table";
  if (tag === "HR") return "rule";
  if (tag === "DIV") return wrapsRule(node) ? "rule" : "paragraph";
  return "inline";
}

/**
 * Flattens one list element back into markers — the exact inverse of
 * `listToHtml`: the marker stack is the marker, and an item that exists only
 * to hold a deeper list emits nothing of its own. `data-ve-hold` is what says
 * so, because the markup alone cannot: an item the author left empty above an
 * indented one looks exactly like a level a marker jump opened.
 */
function collectListItems(list: VeDomNode, stack: string, out: VeListItem[], depth: number): void {
  if (depth > MAX_DEPTH) return;
  const listChar = list.nodeName === "OL" ? "#" : list.nodeName === "DL" ? ":" : "*";

  for (const child of childrenOf(list)) {
    if (child.nodeType === TEXT_NODE) {
      // Whitespace between items is formatting; anything else is an item the
      // browser left unwrapped.
      const text = child.nodeValue ?? "";
      if (!isBlank(text)) {
        out.push({ marker: stack + listChar, children: [{ kind: "text", text }] });
      }
      continue;
    }
    if (!isElement(child)) continue;

    if (isListTag(child.nodeName)) {
      // A list directly inside a list: there is no item to hang it on, so it
      // keeps the depth it already has.
      collectListItems(child, stack, out, depth + 1);
      continue;
    }

    const char = child.nodeName === "DT" ? ";" : child.nodeName === "DD" ? ":" : listChar;
    const marker = stack + char;
    const own: VeInline[] = [];
    const nested: VeDomNode[] = [];
    for (const grandchild of childrenOf(child)) {
      if (isElement(grandchild) && isListTag(grandchild.nodeName)) nested.push(grandchild);
      else pushInline(own, grandchild, 1);
    }
    const children = tidyInline(own);
    // Only the levels a marker jump opened emit nothing, and they say so. An
    // item that is merely empty is one the author wrote, deeper item under it
    // or not, and dropping it would rewrite a list nobody touched (§4).
    if (attr(child, HOLD_ATTR) === null) out.push({ marker, children });
    for (const inner of nested) collectListItems(inner, marker, out, depth + 1);
  }
}

function readBlock(node: VeDomNode, shape: BlockShape, state: ReadState, run: VeDomNode[]): VeBlock {
  const { base, prior } = identify(attr(node, "data-ve-id"), state);

  switch (shape) {
    case "heading": {
      const level = headingLevel(node.nodeName);
      return {
        ...base,
        kind: "heading",
        // `data-ve="h"` on something that is not an h1–h6 can only come from a
        // paste; §1's default heading is the one to fall back to.
        level: level ?? 2,
        children: collectInline(node, 0),
      };
    }
    case "list": {
      const items: VeListItem[] = [];
      for (const element of run) collectListItems(element, "", items, 0);
      return { ...base, kind: "list", items };
    }
    case "table": {
      const rows: VeTableRow[] = [];
      collectRows(node, rows, 0);
      // A table with no cells left in it is not a table: model.ts's invariant
      // says a table has a row and a row has a cell, and §7.5 agrees — such a
      // thing renders nothing. What the author is looking at is an empty
      // paragraph, so that is what they get back.
      if (rows.length === 0) {
        return { ...base, kind: "paragraph", children: collectInline(node, 0) };
      }
      const caption = findCaption(node);
      return {
        ...base,
        kind: "table",
        attrs: attr(node, ATTRS_ATTR) ?? "",
        caption: caption === null ? null : collectCellInline(caption, 0),
        rows,
      };
    }
    case "rule":
      // The dash run is not in the markup: an untouched rule gets its own
      // length back from the block it matched, a new one is plain `----`.
      return {
        ...base,
        kind: "rule",
        dashes: prior !== null && prior.kind === "rule" ? prior.dashes : 4,
      };
    case "atomic": {
      const source = attr(node, "data-ve-src") ?? "";
      // The attribute wins over the matched block's source: an atomic edited
      // through §5's dialog keeps its id, and inheriting `source` here would
      // silently undo that edit. `canonical` still comes from the match, so an
      // untouched atomic compares equal and republishes verbatim.
      const label =
        prior !== null && prior.kind === "atomic" && prior.source === source
          ? prior.label
          : atomicLabel(source);
      return {
        ...base,
        kind: "atomic",
        atomic: toAtomicKind(attr(node, "data-ve-kind")),
        source,
        label,
      };
    }
    case "paragraph":
    case "inline":
      return { ...base, kind: "paragraph", children: collectInline(node, 0) };
  }
}

/**
 * Drops the inherited gap of every block that has a different block behind it
 * than it had at parse time.
 *
 * A gap belongs to a *pair*, not to a block: `"\n"` is what separated this
 * paragraph from the heading that used to follow it, and reusing it once the
 * author has typed a new paragraph there publishes the two merged into one
 * (§4). Only the blocks whose successor actually changed lose their gap, so an
 * untouched surface still comes back with every byte of its spacing.
 *
 * The blocks were built moments ago in `domToDocument`, which is what makes
 * writing to them here safe.
 */
function dropStaleGaps(blocks: readonly VeBlock[], prev: VeDocument): void {
  const followed = new Map<string, string | null>();
  for (let i = 0; i < prev.blocks.length; i += 1) {
    const after = prev.blocks[i + 1];
    followed.set(prev.blocks[i].id, after === undefined ? null : after.id);
  }

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block.gapAfter === null) continue;
    const after = blocks[i + 1];
    const successor = after === undefined ? null : after.id;
    if (followed.get(block.id) !== successor) block.gapAfter = null;
  }
}

/**
 * Reads the surface back into a document.
 *
 * `prev` is the document the surface was last written from: it supplies §4's
 * bookkeeping for every block still carrying its id, and `leading`, which has
 * no representation in the DOM at all.
 */
export function domToDocument(root: VeDomNode, prev: VeDocument, nextId: VeIdFactory): VeDocument {
  const state: ReadState = {
    prev: new Map(prev.blocks.map((block) => [block.id, block])),
    claimed: new Set<string>(),
    nextId,
  };

  const blocks: VeBlock[] = [];
  let loose: VeInline[] = [];

  const flush = (): void => {
    const children = tidyInline(loose);
    loose = [];
    if (children.length === 0) return;
    const { base } = identify(null, state);
    blocks.push({ ...base, kind: "paragraph", children });
  };

  const children = childrenOf(root);
  for (let i = 0; i < children.length; i += 1) {
    const node = children[i];
    try {
      if (node.nodeType === TEXT_NODE) {
        // Bare text between blocks is content the browser never wrapped.
        const text = node.nodeValue ?? "";
        if (!isBlank(text)) loose.push({ kind: "text", text });
        continue;
      }
      if (!isElement(node)) continue;

      const shape = classify(node);
      if (shape === "inline") {
        pushInline(loose, node, 0);
        continue;
      }
      flush();

      // One list block can write several sibling roots (a marker change at
      // depth 0 closes and reopens), and only the first carries the id — so a
      // run of id-less list siblings rejoins the block it came from.
      const run: VeDomNode[] = [node];
      if (shape === "list") {
        let j = i + 1;
        while (j < children.length) {
          const next = children[j];
          if (next.nodeType === TEXT_NODE && isBlank(next.nodeValue ?? "")) {
            j += 1;
            continue;
          }
          if (!isElement(next) || !isListTag(next.nodeName)) break;
          if (attr(next, "data-ve-id") !== null) break;
          run.push(next);
          i = j;
          j += 1;
        }
      }

      blocks.push(readBlock(node, shape, state, run));
    } catch {
      // Nothing a malformed subtree can do is worth losing the rest of the
      // document over; §2's fallback for anything unreadable is a paragraph.
      const { base } = identify(null, state);
      blocks.push({ ...base, kind: "paragraph", children: [] });
    }
  }
  flush();
  dropStaleGaps(blocks, prev);

  return { leading: prev.leading, blocks };
}
