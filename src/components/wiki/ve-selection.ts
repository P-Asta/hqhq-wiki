/**
 * Caret, Range and DOM surgery for the visual editing surface
 * (docs/engine/visual-editor.md §3 mapping, §6 keyboard) — everything
 * `visual-editor.tsx` needs to find out what the caret is standing in, to move
 * it, and to repair the markup a contenteditable hands back.
 *
 * It lives beside the component rather than inside it for two reasons. The
 * component is already a knot of refs, effects and imperative commands, and
 * Range arithmetic interleaved with JSX makes both unreadable. And none of
 * this is React: every function here takes DOM nodes and returns DOM nodes, so
 * it can be read — and, under a DOM-shaped test environment, exercised —
 * without a renderer.
 *
 * Two of these are more than helpers. The surface delegates six of the seven
 * marks to `document.execCommand` (the component's module comment says why);
 * `code` and "clear formatting" are the two it cannot. There is no `code`
 * command at all, and `removeFormat` is inconsistent across engines about
 * `<code>`, `<sup>` and `<sub>` — so both are hand-rolled here.
 *
 * The last section is a third kind of thing again: **moving a block**. It is
 * here rather than in the component because it is the one command whose
 * correctness is a claim about §4 — the elements are re-parented, never
 * rebuilt, so a reordered page republishes with every block's bytes intact —
 * and because the two questions inside it ("which children are one block?",
 * "where does a block moved from i land?") are answerable without a browser,
 * and are answered in ve-selection.test.ts.
 *
 * House rule for the whole module: **degrade, never throw**. The surface is
 * uncontrolled, so a subtree can be in any shape a browser, an IME or an undo
 * step left it in. A command that cannot be carried out returns `false` or
 * does nothing; it never costs the author their document.
 */

import type { VeMark } from "@/lib/visual-editor/model";

/**
 * Every tag spelling a mark can wear. Ours are first; the rest are what
 * `execCommand` and older markup produce, and are the same synonyms `dom.ts`
 * reads back (§3, "Reading back is tolerant").
 */
const MARK_TAGS: Record<VeMark, readonly string[]> = {
  bold: ["B", "STRONG"],
  italic: ["I", "EM"],
  underline: ["U", "INS"],
  strike: ["S", "DEL", "STRIKE"],
  sup: ["SUP"],
  sub: ["SUB"],
  code: ["CODE", "TT"],
};

/**
 * The inline wrappers "clear formatting" dissolves. `A` is deliberately absent:
 * `unlink` is its own toolbar action (actions.ts) and, as in Fandom, clearing
 * formatting over a sentence must not silently drop the links inside it.
 */
const FORMAT_TAGS: ReadonlySet<string> = new Set([
  "B",
  "STRONG",
  "I",
  "EM",
  "U",
  "INS",
  "S",
  "DEL",
  "STRIKE",
  "SUP",
  "SUB",
  "CODE",
  "TT",
  "SMALL",
  "BIG",
  "FONT",
  "SPAN",
]);

/** Wrappers worth removing once they hold nothing — empty links included. */
const PRUNABLE = "b,strong,i,em,u,ins,s,del,strike,sup,sub,code,tt,small,big,font,span,a";

const LIST_TAGS: ReadonlySet<string> = new Set(["UL", "OL", "DL"]);
const ITEM_TAGS: ReadonlySet<string> = new Set(["LI", "DD", "DT"]);
/** What a browser wraps a line in when it indents, lists or splits one. */
const BLOCK_TAGS: ReadonlySet<string> = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6"]);

/* ------------------------------------------------------------------ */
/* Documents and elements                                              */
/* ------------------------------------------------------------------ */

/** The document a node belongs to; the global one for a node with no owner. */
function ownerDocument(node: Node): Document {
  return node.ownerDocument ?? document;
}

/** True for `<ul>`, `<ol>` and `<dl>` — §3's three list roots. */
export function isListElement(element: Element): boolean {
  return LIST_TAGS.has(element.nodeName);
}

/**
 * Parses a fragment of trusted, self-produced HTML into one element.
 *
 * The only callers hand it `blockToHtml`/`inlineToHtml` output, which escapes
 * everything it interpolates — this is never a route for foreign markup — and
 * `<template>` parses inertly in any case: no image loads, no scripts.
 */
export function elementFromHtml(html: string, doc: Document): HTMLElement | null {
  const holder = doc.createElement("template");
  holder.innerHTML = html;
  const first = holder.content.firstElementChild;
  return first instanceof HTMLElement ? first : null;
}

/**
 * Replaces an element with its own children — how a mark, a link or a stray
 * wrapper is removed without disturbing the text (or the caret) inside it.
 */
export function unwrapElement(element: Element): void {
  const parent = element.parentNode;
  if (parent === null) return;
  while (element.firstChild !== null) parent.insertBefore(element.firstChild, element);
  parent.removeChild(element);
}

/**
 * Rewrites a block as a different tag **in place**: a new element takes the old
 * one's children and its `data-ve-id`, so §4's bookkeeping survives the change
 * and the caret — anchored in text nodes that were moved, not cloned — comes
 * with it.
 *
 * This is why the surface does not use `execCommand("formatBlock")`, which
 * spells its output differently in every engine and drops our attributes.
 */
export function replaceBlockTag(block: Element, tagName: string, ve: string): HTMLElement | null {
  const parent = block.parentNode;
  if (parent === null) return null;
  const next = ownerDocument(block).createElement(tagName);
  const id = block.getAttribute("data-ve-id");
  if (id !== null) next.setAttribute("data-ve-id", id);
  next.setAttribute("data-ve", ve);
  while (block.firstChild !== null) next.appendChild(block.firstChild);
  parent.replaceChild(next, block);
  return next;
}

/* ------------------------------------------------------------------ */
/* Reading the selection                                               */
/* ------------------------------------------------------------------ */

/**
 * The selection's first Range, but only while it lies inside `root`. Anything
 * else — no selection, a caret in another field, a stale range from before a
 * document load — reads as "the surface does not have the caret".
 */
export function currentRange(root: HTMLElement): Range | null {
  const view = ownerDocument(root).defaultView;
  if (view === null) return null;
  const selection = view.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  return root.contains(range.commonAncestorContainer) ? range : null;
}

/** Puts a remembered Range back on screen; false when it no longer applies. */
export function applyRange(root: HTMLElement, range: Range): boolean {
  if (!root.contains(range.commonAncestorContainer)) return false;
  const view = ownerDocument(root).defaultView;
  const selection = view === null ? null : view.getSelection();
  if (selection === null) return false;
  try {
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    return false;
  }
  return true;
}

/**
 * The nearest ancestor of `node` that satisfies `match`, stopping at `root`
 * (exclusive) — the climb behind "am I in a link?" and "am I in bold?".
 */
export function nearestMatching(
  root: HTMLElement,
  node: Node | null,
  match: (element: HTMLElement) => boolean,
): HTMLElement | null {
  let current: Node | null = node;
  while (current !== null && current !== root) {
    if (current instanceof HTMLElement && match(current)) return current;
    current = current.parentNode;
  }
  return null;
}

/**
 * The block `node` sits in — which is precisely the direct child of `root`
 * holding it, because a direct child is what `domToDocument` reads as a block.
 * A caret in an `<li>` therefore reports the whole list, which is the one
 * block the model has for it.
 */
export function nearestBlock(root: HTMLElement, node: Node | null): HTMLElement | null {
  let current: Node | null = node;
  while (current !== null && current !== root && current.parentNode !== root) {
    current = current.parentNode;
  }
  if (current === null || current === root) return null;
  return current instanceof HTMLElement ? current : null;
}

/**
 * Where a block insertion goes when the caret's boundary is `root` itself.
 *
 * `nearestBlock` has no answer there, because such a boundary names a gap
 * between the root's children rather than a block — and the surface parks the
 * caret in exactly that gap twice over: every insertion ends with
 * `placeCaretAfter`, whose `setStartAfter` gives `(root, index + 1)`, and a
 * click on an atomic chip selects it as `(root, index)`–`(root, index + 1)`.
 * Reading "no block" as "append" is what sent the second INSERT to the bottom
 * of the article instead of beside the first.
 *
 * `selectsChild` says the boundary is that unit selection rather than a caret.
 * The block the author is standing on is then the selected child itself, so
 * the new one goes *after* it — the same rule a caret inside any other block
 * follows.
 */
export function rootInsertIndex(
  childCount: number,
  offset: number,
  selectsChild: boolean,
): number {
  const at = Math.max(0, Math.min(offset, childCount));
  return selectsChild && at < childCount ? at + 1 : at;
}

/**
 * The structural subset of `Element` an ancestor walk needs, so the rule below
 * can be exercised with plain objects under vitest's node environment. Real
 * elements satisfy it.
 */
export interface VeAncestor {
  hasAttribute(name: string): boolean;
  readonly parentElement: VeAncestor | null;
}

/**
 * Whether `node` lies inside an atomic — that is, inside engine-rendered
 * preview HTML rather than anything the author wrote (§5).
 *
 * Nothing outside `loadFragments` may touch that subtree. A preview is
 * injected once per document load, so a pass that reshapes one leaves the
 * gallery, table or infobox broken on screen until the whole document is
 * reloaded, and the author cannot even see what went wrong: the model never
 * held that markup in the first place.
 */
export function isInAtomic(node: VeAncestor | null): boolean {
  let current: VeAncestor | null = node;
  while (current !== null) {
    if (current.hasAttribute("data-ve-src")) return true;
    current = current.parentElement;
  }
  return false;
}

/**
 * Whether `mark` is in force where the selection starts.
 *
 * Deliberately an ancestor test rather than `queryCommandState`: the DOM is
 * what the serializer will read, engines disagree about the command states,
 * and `code` has no command at all — one rule for all seven keeps the toolbar
 * honest about what is actually in the markup.
 */
export function isMarkActive(root: HTMLElement, range: Range | null, mark: VeMark): boolean {
  if (range === null) return false;
  const tags = MARK_TAGS[mark];
  return nearestMatching(root, range.startContainer, (el) => tags.includes(el.nodeName)) !== null;
}

/**
 * Whether the range selects `node` as a unit — the shape a browser leaves
 * behind when a `contenteditable="false"` atomic is clicked, and the test that
 * decides whether Delete removes it.
 */
export function rangeSelectsNode(range: Range, node: Node): boolean {
  const parent = node.parentNode;
  if (parent === null || range.collapsed) return false;
  if (range.startContainer !== parent || range.endContainer !== parent) return false;
  const children = parent.childNodes;
  for (let i = 0; i < children.length; i += 1) {
    if (children[i] === node) return range.startOffset <= i && range.endOffset >= i + 1;
  }
  return false;
}

/** Whether the range overlaps the node at all; `false` where it cannot tell. */
export function rangeTouchesNode(range: Range, node: Node): boolean {
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
}

/** Whether the caret sits at the very end of `block`, markup aside. */
export function isAtBlockEnd(block: Element, range: Range): boolean {
  if (!range.collapsed) return false;
  const tail = ownerDocument(block).createRange();
  try {
    tail.selectNodeContents(block);
    tail.setStart(range.endContainer, range.endOffset);
  } catch {
    return false;
  }
  return tail.toString() === "";
}

/* ------------------------------------------------------------------ */
/* Moving the caret                                                    */
/* ------------------------------------------------------------------ */

/** One place where a Range is built and handed to the live selection. */
function withRange(node: Node, build: (range: Range) => void): boolean {
  const doc = ownerDocument(node);
  const view = doc.defaultView;
  const selection = view === null ? null : view.getSelection();
  if (selection === null) return false;
  const range = doc.createRange();
  try {
    build(range);
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    return false;
  }
  return true;
}

/** Drops the caret immediately after a node — where an insertion leaves it. */
export function placeCaretAfter(node: Node): boolean {
  return withRange(node, (range) => {
    range.setStartAfter(node);
    range.collapse(true);
  });
}

/** Drops the caret at the start of an element's content. */
export function placeCaretInside(element: Element): boolean {
  return withRange(element, (range) => {
    range.selectNodeContents(element);
    range.collapse(true);
  });
}

/** Selects a node as a unit — what a click on an atomic chip does. */
export function selectNode(node: Node): boolean {
  return withRange(node, (range) => range.selectNode(node));
}

/** Selects everything inside an element, e.g. the text a wrap just enclosed. */
export function selectNodeContents(element: Element): boolean {
  return withRange(element, (range) => range.selectNodeContents(element));
}

/** Selects the run from one node to another, inclusive. */
function selectAcross(first: Node, last: Node): boolean {
  if (!first.isConnected || !last.isConnected) return false;
  return withRange(first, (range) => {
    range.setStartBefore(first);
    range.setEndAfter(last);
  });
}

/* ------------------------------------------------------------------ */
/* Rewriting a selection                                               */
/* ------------------------------------------------------------------ */

/** Drops whatever the range holds and puts `node` there instead. */
export function replaceRangeWith(range: Range, node: Node): boolean {
  try {
    range.deleteContents();
    range.insertNode(node);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wraps a range in a fresh element.
 *
 * `surroundContents` is the exact operation, but it refuses any range that
 * only partially selects an element — the common case the moment a selection
 * starts inside one mark and ends inside another — so the fallback extracts
 * and re-inserts, which accepts anything.
 */
export function wrapRange(range: Range, tagName: string): HTMLElement | null {
  const wrapper = ownerDocument(range.commonAncestorContainer).createElement(tagName);
  try {
    range.surroundContents(wrapper);
    return wrapper;
  } catch {
    try {
      wrapper.appendChild(range.extractContents());
      range.insertNode(wrapper);
      return wrapper;
    } catch {
      return null;
    }
  }
}

/**
 * Toggles the `code` mark over the current selection.
 *
 * Toggling off dissolves the whole `<code>` the caret is in rather than only
 * the selected slice: splitting an element to un-code three characters in the
 * middle of it is a lot of surgery for a case authors do not ask for, and "the
 * run I am standing in" is the rule the rest of the toolbar follows anyway.
 */
export function toggleCodeMark(root: HTMLElement): boolean {
  const range = currentRange(root);
  if (range === null) return false;

  const tags = MARK_TAGS.code;
  const existing = nearestMatching(root, range.startContainer, (el) => tags.includes(el.nodeName));
  if (existing !== null) {
    const first = existing.firstChild;
    const last = existing.lastChild;
    unwrapElement(existing);
    if (first !== null && last !== null) selectAcross(first, last);
    return true;
  }

  const wrapper = wrapRange(range, "code");
  if (wrapper === null) return false;
  // A collapsed caret produces an empty element: put the caret inside it so the
  // next keystroke lands in code. Some engines drop an empty inline on the next
  // reflow, which costs nothing — the author simply types first and marks after.
  if (wrapper.firstChild === null) placeCaretInside(wrapper);
  else selectNodeContents(wrapper);
  return true;
}

/** Dissolves every format wrapper in a subtree, leaving atomics untouched. */
function stripFormatting(node: Node): void {
  for (const child of Array.from(node.childNodes)) {
    if (!(child instanceof Element)) continue;
    // An atomic's children are a rendered preview, not authored content (§5).
    if (child.hasAttribute("data-ve-src")) continue;
    stripFormatting(child);
    if (FORMAT_TAGS.has(child.nodeName)) unwrapElement(child);
  }
}

/** Removes the empty wrappers a split leaves on either side of a selection. */
function pruneEmptyInline(block: Element): void {
  for (const element of Array.from(block.querySelectorAll(PRUNABLE))) {
    if (element.hasAttribute("data-ve-src")) continue;
    if ((element.textContent ?? "") !== "") continue;
    if (element.querySelector("br,[data-ve-src],img") !== null) continue;
    element.remove();
  }
}

/** The part of `range` that lies inside `block`, or null when that is empty. */
function clipToBlock(range: Range, block: Element): Range | null {
  const clipped = ownerDocument(block).createRange();
  try {
    clipped.selectNodeContents(block);
    if (block.contains(range.startContainer)) {
      clipped.setStart(range.startContainer, range.startOffset);
    }
    if (block.contains(range.endContainer)) {
      clipped.setEnd(range.endContainer, range.endOffset);
    }
  } catch {
    return null;
  }
  return clipped.collapsed ? null : clipped;
}

/**
 * Strips character formatting from the selection.
 *
 * Done one block at a time, and never across a block boundary: extracting a
 * range that spans two paragraphs hands back two half-paragraphs, and putting
 * that fragment back would nest one block inside another. Clipping to each
 * block first means the extract/strip/re-insert cycle only ever moves inline
 * content, which is the one thing it can put back safely.
 */
export function clearFormatting(root: HTMLElement): boolean {
  const range = currentRange(root);
  if (range === null || range.collapsed) return false;

  let first: Node | null = null;
  let last: Node | null = null;

  for (const block of Array.from(root.children)) {
    if (block.hasAttribute("data-ve-src")) continue;
    if (!rangeTouchesNode(range, block)) continue;
    const clipped = clipToBlock(range, block);
    if (clipped === null) continue;

    let fragment: DocumentFragment;
    try {
      fragment = clipped.extractContents();
    } catch {
      continue;
    }
    stripFormatting(fragment);
    const head = fragment.firstChild;
    const tail = fragment.lastChild;
    if (head === null || tail === null) continue;
    if (!replaceRangeWith(clipped, fragment)) continue;

    pruneEmptyInline(block);
    if (first === null) first = head;
    last = tail;
  }

  if (first !== null && last !== null) selectAcross(first, last);
  return first !== null;
}

/* ------------------------------------------------------------------ */
/* Normalising what the browser produced                               */
/* ------------------------------------------------------------------ */

/** The `data-ve-id` of the first identified descendant, for §4 continuity. */
function firstBlockId(element: Element): string | null {
  const owner = element.querySelector("[data-ve-id]");
  return owner === null ? null : owner.getAttribute("data-ve-id");
}

/**
 * Rewrites one `<blockquote>` as the `<dl>`/`<dd>` §3 maps `:` indentation to.
 *
 * `execCommand("indent")` outside a list produces a blockquote, which is not in
 * the mapping table at all — `dom.ts` reads it back as a paragraph and the
 * indent vanishes on save. Indentation *is* a definition list in wikitext, so
 * this is a rewrite into a form the model already has, not an invention.
 */
function blockquoteToList(quote: Element): void {
  const doc = ownerDocument(quote);
  const list = doc.createElement("dl");
  list.setAttribute("data-ve", "list");
  const id = firstBlockId(quote);
  if (id !== null) list.setAttribute("data-ve-id", id);

  let open: HTMLElement | null = null;
  while (quote.firstChild !== null) {
    const child = quote.firstChild;
    const nested =
      child instanceof Element && (LIST_TAGS.has(child.nodeName) || child.nodeName === "BLOCKQUOTE");
    if (nested) {
      // A second indent nests: `::` is a list inside an item, which is exactly
      // the shape `collectListItems` walks back out. The holder is ours, not a
      // line the author wrote, and `data-ve-hold` is how the reader knows.
      const holder = doc.createElement("dd");
      holder.setAttribute("data-ve-hold", "");
      holder.appendChild(child);
      list.appendChild(holder);
      open = null;
      continue;
    }
    if (child instanceof Element && BLOCK_TAGS.has(child.nodeName)) {
      const item = doc.createElement("dd");
      while (child.firstChild !== null) item.appendChild(child.firstChild);
      quote.removeChild(child);
      list.appendChild(item);
      open = null;
      continue;
    }
    if (open === null) {
      open = doc.createElement("dd");
      list.appendChild(open);
    }
    open.appendChild(child);
  }

  quote.replaceWith(list);
}

/** The matches that are the author's; an atomic's preview body is not (§5). */
function authoredOnly(matches: NodeListOf<Element>): Element[] {
  return Array.from(matches).filter((node) => !isInAtomic(node));
}

/**
 * Puts the markup back into the shape §3 describes after a list or indent
 * command, because no two engines spell those the same way:
 *
 * - a blockquote becomes the definition list wikitext means by `:`;
 * - a list nested *beside* its parent's items (`<ul><li>a</li><ul>…`, which is
 *   how several engines indent) moves inside the item above it, where the flat
 *   marker rebuild expects it — left alone, the nested run reads back a level
 *   too shallow;
 * - a paragraph the browser left inside `<li>` is unwrapped, because `dom.ts`
 *   reads an unexpected element inside an item as flat text and the marks in
 *   it would be lost.
 *
 * Nodes are *moved*, never re-created, so a caret inside them survives.
 *
 * Every query is filtered to authored content. This runs after *every*
 * command, and the surface is full of subtrees it did not write: a rendered
 * `<gallery>` is a `<ul>` of `<li>`s wrapping `<div>`s, which the item pass
 * below would happily unwrap into a run of loose text, and a preview holding a
 * `<blockquote>` would come back as a definition list. None of that is markup
 * the model can see, so none of it is markup this may repair.
 */
export function normalizeLists(root: HTMLElement): void {
  for (const quote of authoredOnly(root.querySelectorAll("blockquote"))) {
    // Outer quotes are rewritten first and carry their inner ones along; an
    // inner one is still connected afterwards, inside its new `<dd>`.
    if (!quote.isConnected) continue;
    blockquoteToList(quote);
  }

  for (const list of authoredOnly(root.querySelectorAll("ul,ol,dl"))) {
    const parent = list.parentElement;
    if (parent === null || !LIST_TAGS.has(parent.nodeName)) continue;
    let previous = list.previousElementSibling;
    while (previous !== null && !ITEM_TAGS.has(previous.nodeName)) {
      previous = previous.previousElementSibling;
    }
    if (previous !== null) {
      previous.appendChild(list);
      continue;
    }
    // A nested list with no item above it still needs one to hang from, or the
    // marker rebuild has nothing to attach the deeper level to. It is a holder,
    // not a bullet the author typed, so it is labelled as one — unlabelled, it
    // reads back as an empty item and adds a bare `*` line to the wikitext.
    const holder = ownerDocument(list).createElement(parent.nodeName === "DL" ? "dd" : "li");
    holder.setAttribute("data-ve-hold", "");
    parent.insertBefore(holder, list);
    holder.appendChild(list);
  }

  for (const item of authoredOnly(root.querySelectorAll("li,dd,dt"))) {
    for (const child of Array.from(item.children)) {
      if (BLOCK_TAGS.has(child.nodeName)) unwrapElement(child);
    }
  }
}

/**
 * Pulls the list item the caret is in out of its list, as a plain paragraph in
 * the same place — what `insertUnorderedList` does for a `<ul>`, for the lists
 * no browser command can toggle off.
 *
 * `<dl>` is §3's mapping for `:` and `;` indentation and has no command at
 * all: asking for one turns a list *on* instead, leaving the caret in a list
 * root either way. Renaming that root is not an option — `<h2 data-ve="h">`
 * over `<dd>` children reads back through `pushInline`, which has no case for
 * an item outside a list, so the whole line collapses to one run of plain text
 * and every link and mark in it is lost.
 *
 * The item's child nodes are **moved**, so the marks, the links and the caret
 * inside them all survive. Items above the lifted one stay in the original
 * list; items below, and any deeper list the lifted item held, continue in a
 * fresh list of the same kind behind the paragraph, so splitting a three-line
 * indent with a heading leaves both halves indented. That trailing list is
 * given no `data-ve-id`: it is a block the author has not written before, and
 * `domToDocument` mints one for it on the next read (§4).
 */
export function liftListItem(root: HTMLElement, node: Node | null, id: string): HTMLElement | null {
  const item = nearestMatching(root, node, (element) => ITEM_TAGS.has(element.nodeName));
  if (item === null) return null;
  const list = item.parentElement;
  // Only a top-level list is split. A deeper item's paragraph would land inside
  // the item holding it, where the pass above unwraps it straight back into the
  // line it came from — so an indented line under another one keeps its indent
  // and the format is refused rather than half-applied.
  if (list === null || !isListElement(list) || nearestBlock(root, list) !== list) return null;

  const doc = ownerDocument(list);
  const paragraph = doc.createElement("p");
  paragraph.setAttribute("data-ve", "p");
  paragraph.setAttribute("data-ve-id", id);
  const rest = doc.createElement(list.nodeName.toLowerCase());
  rest.setAttribute("data-ve", "list");

  while (item.firstChild !== null) {
    const child = item.firstChild;
    // A list inside the item is the level below it (`::` under `:`), which
    // belongs to the lines that follow, not to the one becoming a block. Left
    // in the paragraph it would be read as flat text and lose its indent.
    if (child instanceof Element && isListElement(child)) rest.appendChild(child);
    else paragraph.appendChild(child);
  }
  let sibling = item.nextSibling;
  while (sibling !== null) {
    const next = sibling.nextSibling;
    rest.appendChild(sibling);
    sibling = next;
  }

  list.removeChild(item);
  list.after(paragraph);
  if (rest.firstElementChild !== null) paragraph.after(rest);
  if (list.firstElementChild === null) list.remove();
  return paragraph;
}

/**
 * Gives every block in the surface an id of its own.
 *
 * Splitting a paragraph with Enter clones the element, `data-ve-id` and all.
 * `domToDocument` already survives that — the first claimant keeps the id, and
 * with it the original wikitext (§4) — but leaving the duplicate in the DOM
 * means every later read has to re-decide the same thing, and a second split
 * could hand the id to the wrong half. Minting here keeps the two
 * representations agreeing, and follows the same first-in-document-order rule
 * the reader uses, so the half that keeps the history is the same half.
 */
export function ensureUniqueBlockIds(root: HTMLElement, mint: () => string): void {
  const seen = new Set<string>();
  for (const element of Array.from(root.querySelectorAll("[data-ve-id]"))) {
    const id = element.getAttribute("data-ve-id");
    if (id !== null && id !== "" && !seen.has(id)) {
      seen.add(id);
      continue;
    }
    let fresh = mint();
    while (seen.has(fresh)) fresh = mint();
    seen.add(fresh);
    element.setAttribute("data-ve-id", fresh);
  }
}

/* ------------------------------------------------------------------ */
/* Moving a block (visual-editor.md §3, §4, §6)                        */
/* ------------------------------------------------------------------ */

/** Up the document or down it — the only two ways a block ever moves. */
export type VeMoveDirection = "up" | "down";

/**
 * Where a block goes when it is moved from `index`, or **null when it goes
 * nowhere**.
 *
 * Nowhere is a real answer and the reason this is a function rather than
 * `index ± 1` written twice: the first block cannot rise and the last cannot
 * fall, and both ends have to be *said* — the gutter disables a button on the
 * answer, the shortcut swallows nothing on it, and a `-1` slipped into an
 * `insertBefore` would silently teleport a paragraph to the top of the page.
 * An index outside the document is nowhere for the same reason: the DOM can
 * have changed under a handle the pointer is still hovering.
 */
export function blockMoveTarget(
  count: number,
  index: number,
  direction: VeMoveDirection,
): number | null {
  if (!Number.isInteger(index) || index < 0 || index >= count) return null;
  const to = direction === "up" ? index - 1 : index + 1;
  return to < 0 || to >= count ? null : to;
}

/**
 * The structural subset of `Node` the grouping below reads, so the rule can be
 * exercised with object literals under vitest's node environment — the same
 * bargain `VeAncestor` above makes, and `dom.ts`'s `VeDomNode`. Real nodes
 * satisfy it; `getAttribute` is optional because text nodes have none.
 */
/* ------------------------------------------------------------------ */
/* The neighbour a Backspace would eat (visual-editor.md §5)           */
/* ------------------------------------------------------------------ */

/** Enough of a node for {@link neighbourIndex} to walk a child list. */
export interface VeNeighbourNode {
  readonly nodeType: number;
  readonly nodeValue: string | null;
  getAttribute?(name: string): string | null;
}

/**
 * Enough of a node for {@link atomicBeside} to walk a tree — which a real
 * `Node` is, structurally, so the surface passes its own DOM straight in.
 *
 * The interface exists so the walk can be *tested*: vitest runs in node here,
 * there is no DOM and no `instanceof HTMLElement`, and this is exactly the sort
 * of walk that looks right and does nothing. It is `VeMoveNode`'s bargain, one
 * question along.
 */
export interface VeWalkNode {
  readonly nodeType: number;
  readonly nodeValue: string | null;
  readonly childNodes: ArrayLike<VeWalkNode>;
  readonly parentNode: VeWalkNode | null;
}

/**
 * The zero-width characters the surface parks a caret in, and the one rule
 * every walk here owes them: **a holder is markup, not content.**
 *
 * `caretHolderAt` parks one whenever a click lands beside a chip with no text
 * position to take — which, in a cell holding nothing but a version tag, is
 * *every* click, because there is no other way to put a caret there at all.
 * `withoutCaretHolders` (dom.ts) then strips it from every read, so the author
 * can neither see it nor publish it. A walk that counted one would be counting
 * a character that does not exist: the caret would read as standing on
 * something, and the chip an arm's length behind it would never be found (user
 * report, 2026-09-06: "cell안에 있는 version tag를 지우려고 시도하면" — the first
 * Backspace spent itself on the holder and looked like nothing at all).
 */
const HOLDER_CHARS = /[​﻿]/g;

/** Whether `text` is holder padding — empty once the holders come out. */
function isHolderText(text: string): boolean {
  return text.replace(HOLDER_CHARS, "") === "";
}

/**
 * Which child of a container the caret at `offset` would delete, pressing
 * Backspace (`-1`) or Delete (`+1`) — or -1 for "nothing of this container's".
 *
 * **The whole of what makes a chip deletable by keyboard**, and it is an
 * off-by-one waiting to happen, so it is arithmetic here rather than a walk
 * in the surface. A caret is `(container, offset)`; going back, the node it is
 * standing behind is `offset - 1`, and going forward it is `offset` itself.
 *
 * Empty text nodes are stepped over, which is not a nicety: browsers leave
 * them everywhere a `contenteditable="false"` node has been typed beside, and
 * one of them between the caret and a chip is what makes "Backspace does
 * nothing, twice" — the author's report. A node holding nothing but caret
 * holders counts as empty for the same reason and by the same rule
 * (`isHolderText`); a node with a *character* in it does not, because that
 * character is what the delete is actually about.
 */
export function neighbourIndex(
  children: ArrayLike<VeNeighbourNode>,
  offset: number,
  direction: -1 | 1,
): number {
  let at = direction === -1 ? offset - 1 : offset;
  while (at >= 0 && at < children.length) {
    const child = children[at];
    const blank =
      (child.nodeType === MOVE_TEXT_NODE && isHolderText(child.nodeValue ?? "")) ||
      // The filler `<br>` an empty line is given its height with — the
      // surface's own markup, labelled so the reader ignores it too (dom.ts).
      // It sits between the caret and the block above in every empty
      // paragraph, which is the one an author lands in after a table: without
      // this the first Backspace spent itself on the filler and the table only
      // went on the second (user report, 2026-09-06: "backspace를 2번 누르면
      // 지워지고"). An **authored** `<br>` carries no label and still stops the
      // walk, because that one is a line the author put there.
      (child.getAttribute?.("data-ve-filler") ?? null) !== null;
    if (!blank) return at;
    at += direction;
  }
  return -1;
}

/**
 * The block beside the caret's own, when the caret has nothing left inside it.
 *
 * Deliberately shallow: the neighbour has to *be* a chip. Descending into it
 * would make Backspace at the start of a paragraph eat a chip out of the end of
 * the paragraph — or the list item — above, instead of merging the two lines,
 * which is what that key means everywhere else.
 */
function besideOuter(
  host: VeWalkNode,
  outer: VeWalkNode | null,
  direction: -1 | 1,
  isAtomic: (node: VeWalkNode) => boolean,
): VeWalkNode | null {
  if (outer === null || host.parentNode !== outer) return null;
  const at = siblingOffset(host, direction);
  if (at === -1) return null;
  const beside = neighbourIndex(outer.childNodes, at, direction);
  if (beside === -1) return null;
  const node = outer.childNodes[beside];
  return isAtomic(node) ? node : null;
}

/** A node's place among its parent's children, on the side a delete comes from. */
function siblingOffset(node: VeWalkNode, direction: -1 | 1): number {
  const parent = node.parentNode;
  if (parent === null) return -1;
  for (let at = 0; at < parent.childNodes.length; at += 1) {
    if (parent.childNodes[at] === node) return at + (direction === -1 ? 0 : 1);
  }
  return -1;
}

/**
 * The atomic chip a Backspace (`-1`) or Delete (`+1`) at `(container, offset)`
 * would reach, or null — bounded by `host`, the caret's own cell, list item or
 * paragraph.
 *
 * **A walk, not a match on `(container, offset)`.** There is no one place a
 * browser puts the caret between two `contenteditable="false"` chips: it may
 * report the cell and an index, a text node the engine invented between them,
 * an inline wrapper's edge, or a position *inside* the chip's own rendered
 * preview. Matching one of those shapes is why the first attempt at this went
 * on doing nothing exactly where it was asked to work. So this walks the
 * document order the way the delete itself would:
 *
 * 1. A caret already inside a chip is plainly about that chip.
 * 2. A caret in text with characters on the side being deleted towards is about
 *    one of those characters, not a neighbour.
 * 3. Otherwise step **out** of every edge the caret is sitting on — the end of
 *    a `<b>`, an empty text node — take the first node on that side, and step
 *    **in** to its own nearest edge, in case it is a wrapper with the chip at
 *    the end of it.
 *
 * The empty text nodes browsers leave around a `contenteditable="false"` node
 * are stepped over throughout (`neighbourIndex`): one of them between the caret
 * and the chip is what makes the answer always "nothing there".
 *
 * The `host` bound is not a detail either. Backspace at the very start of a
 * cell must not reach back into the cell before it and delete something the
 * author cannot see the caret next to — nor at the start of a list item, where
 * it merges with the item above rather than eating what is inside it.
 *
 * `outer` is the one place the walk may look **past** the host: the surface
 * passes the root when the caret is in an ordinary paragraph, because a caret
 * at the start of a line and a chip standing as the block above it is the one
 * shape where reaching out is what every editor does. Only a direct child of
 * `outer` that is *itself* a chip counts there — no descending — so Backspace
 * at the start of a paragraph after another paragraph still merges the two, and
 * one after a list still merges rather than reaching inside the last item.
 */
export function atomicBeside(
  host: VeWalkNode,
  container: VeWalkNode,
  offset: number,
  direction: -1 | 1,
  isAtomic: (node: VeWalkNode) => boolean,
  outer: VeWalkNode | null = null,
): VeWalkNode | null {
  const ancestorAtomic = (node: VeWalkNode | null): VeWalkNode | null => {
    let current = node;
    while (current !== null) {
      if (isAtomic(current)) return current;
      if (current === host) return null;
      current = current.parentNode;
    }
    return null;
  };

  const inside = ancestorAtomic(container);
  if (inside !== null) return inside;

  let at: VeWalkNode = container;
  let index = offset;
  if (at.nodeType === MOVE_TEXT_NODE) {
    const text = at.nodeValue ?? "";
    // Everything on this side of the caret *within its own text node* has to
    // be nothing before the walk may leave the node — and a caret holder is
    // nothing (`isHolderText`). Reading it as a character is what stood
    // between the caret a click had just parked and the chip it was parked
    // beside, so the press deleted an invisible thing and the author saw
    // Backspace do nothing at all.
    const side = direction === -1 ? text.slice(0, index) : text.slice(index);
    if (!isHolderText(side)) return null;
    const next = siblingOffset(at, direction);
    if (next === -1 || at.parentNode === null) return null;
    index = next;
    at = at.parentNode;
  }

  let found: VeWalkNode | null = null;
  for (;;) {
    const beside = neighbourIndex(at.childNodes, index, direction);
    if (beside !== -1) {
      found = at.childNodes[beside];
      break;
    }
    if (at === host) return besideOuter(host, outer, direction, isAtomic);
    if (at.parentNode === null) return null;
    const next = siblingOffset(at, direction);
    if (next === -1) return null;
    index = next;
    at = at.parentNode;
  }

  while (found !== null && !isAtomic(found) && found.childNodes.length > 0) {
    const kids: ArrayLike<VeWalkNode> = found.childNodes;
    const beside = neighbourIndex(kids, direction === -1 ? kids.length : 0, direction);
    if (beside === -1) break;
    found = kids[beside];
  }
  return ancestorAtomic(found);
}

/* ------------------------------------------------------------------ */
/* Reading the caret's line                                            */
/* ------------------------------------------------------------------ */

/**
 * A node the line reader walks. Structural for the reason `VeWalkNode` is:
 * vitest runs in node here, there is no DOM, and "what has been typed on this
 * line" is exactly the sort of walk that looks right and hands back the wrong
 * string — which is what it did (see {@link lineTextOf}).
 */
export interface VeLineNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly nodeValue: string | null;
  readonly childNodes: ArrayLike<VeLineNode>;
  getAttribute?(name: string): string | null;
}

/** One text node of the line, and where its text starts in the flattening. */
export interface VeLinePiece {
  node: VeLineNode;
  start: number;
}

export interface VeLineText {
  pieces: VeLinePiece[];
  text: string;
  /** How many characters of `text` come before the caret. */
  offset: number;
}

/**
 * The two tags a browser wraps a line in when Enter splits one inside a host
 * that has no block level — a table cell, a caption. They are the two the
 * reader sees through on the way back (dom.ts, `isCellWrapper`), so here they
 * mean what a `<br>` means: the line ends.
 */
const LINE_WRAPPERS: ReadonlySet<string> = new Set(["P", "DIV"]);

const LINE_ELEMENT_NODE = 1;
const LINE_TEXT_NODE = 3;

/**
 * The zero-width characters the surface parks a caret in — `CARET_HOLDER`
 * (dom.ts), written where a click asks for a position no text node holds.
 *
 * They are **read as a space**, never as a character of the author's. The
 * reader already drops them (`withoutCaretHolders`), so they never reach the
 * buffer; what they used to reach was every reading that asks what is in front
 * of the caret — and one of those is "is this slash at the start of a line".
 * A holder is not whitespace to `\s`, so a "/" typed right after one read as a
 * slash *inside a word* and the menu stayed shut (user report, 2026-09-06: "/
 * 가 정상적으로 작동하지 않는다"). It is one character wide, so a space keeps
 * every offset in this reading exactly where it was.
 */
const LINE_HOLDERS = /[\u200B\uFEFF]/g;

/**
 * One line host's text, flattened, with the caret's place in the flattening —
 * or null where the caret is in no line of this host at all.
 *
 * **A line ends where the author sees it end** (fixed 2026-09-06, user report:
 * "table에서 enter를 눌렀을 때 칸이 늘어난 판정이라 /가 정상 작동하지 않는다").
 * The surface used to concatenate the host's text nodes and nothing else, so a
 * cell holding two visual lines read as one string with no seam: the "/"
 * starting the second line arrived as `"first line/"`, `slashContext` saw a
 * character rather than whitespace in front of it, and the slash menu never
 * opened — the same for `[[`, `@` and `{{`, and the same in any paragraph
 * after a Shift+Enter. A `<br>` and a wrapper boundary write one `"\n"`, which
 * is what those readings already treat as the start of a line.
 *
 * **The caret is placed exactly, wherever it stands.** The old rule gave up
 * whenever the caret sat on an *element* — where a browser parks it on an
 * empty line, and where Enter in a cell used to leave it — because an offset
 * guessed there would delete the wrong characters. Nothing is guessed: the
 * walk knows which child index it is at, so a boundary on an element is the
 * text length accumulated when the walk reaches it.
 *
 * A chip is skipped whole: its body is the engine's rendering of somebody's
 * wikitext (§5), not text a caret walks through. So is the branch field's
 * `<textarea>`, which is a form control that happens to live in the markup.
 */
export function lineTextOf(
  host: VeLineNode,
  container: VeLineNode | null,
  at: number,
): VeLineText | null {
  const pieces: VeLinePiece[] = [];
  let text = "";
  let offset: number | null = null;

  /** One "\n" for a break — never two in a row, and never one at the start. */
  const endLine = (): void => {
    if (text !== "" && !text.endsWith("\n")) text += "\n";
  };

  const walk = (node: VeLineNode): void => {
    const children = node.childNodes;
    for (let index = 0; index < children.length; index += 1) {
      if (node === container && index === at) offset = text.length;
      const child = children[index];
      if (child.nodeType === LINE_TEXT_NODE) {
        if (child === container) offset = text.length + at;
        pieces.push({ node: child, start: text.length });
        text += (child.nodeValue ?? "").replace(LINE_HOLDERS, " ");
        continue;
      }
      if (child.nodeType !== LINE_ELEMENT_NODE || child.nodeName === "TEXTAREA") continue;
      if ((child.getAttribute?.("data-ve-src") ?? null) !== null) continue;
      if (child.nodeName === "BR") {
        endLine();
        continue;
      }
      if (LINE_WRAPPERS.has(child.nodeName)) {
        endLine();
        walk(child);
        endLine();
        continue;
      }
      walk(child);
    }
    if (node === container && at === children.length) offset = text.length;
  };
  walk(host);

  return offset === null ? null : { pieces, text, offset };
}

export interface VeMoveNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly nodeValue: string | null;
  getAttribute?(name: string): string | null;
}

const MOVE_ELEMENT_NODE = 1;
const MOVE_TEXT_NODE = 3;

function isBlankTextNode(node: VeMoveNode): boolean {
  return node.nodeType === MOVE_TEXT_NODE && (node.nodeValue ?? "").trim() === "";
}

function isListRootNode(node: VeMoveNode): boolean {
  return node.nodeType === MOVE_ELEMENT_NODE && LIST_TAGS.has(node.nodeName);
}

function hasBlockId(node: VeMoveNode): boolean {
  if (node.getAttribute === undefined) return false;
  return node.getAttribute("data-ve-id") !== null;
}

/**
 * The root's children grouped into the units `domToDocument` reads as blocks —
 * which is what a move has to shift, because a *block* is what the author sees
 * and what §4 keeps the bytes of.
 *
 * The grouping repeats that reader's walk exactly, and the one rule that is
 * not "one element, one block" is why this exists at all: **one list block can
 * write several sibling roots.** `*` then `#` at depth 0 closes one list and
 * opens another (dom.ts `listToHtml`), and only the first carries
 * `data-ve-id`; the reader rejoins the id-less siblings into the block they
 * came from. Moving only the element under the handle would therefore saw a
 * mixed list in half and publish two lists where the author had one.
 *
 * Whitespace between blocks is inert to the reader — it is skipped, never
 * pushed — so it joins no unit and a move simply leaves it where it lies.
 * Bare non-blank text is not inert (the reader makes a paragraph of it), so it
 * is a unit of its own and can be moved past. Anything else the reader ignores
 * outright (a comment node) is ignored here too.
 */
export function blockUnits<T extends VeMoveNode>(children: readonly T[]): T[][] {
  const units: T[][] = [];
  /** The list run still able to absorb an id-less sibling, if the last unit is one. */
  let open: T[] | null = null;

  for (const child of children) {
    if (isBlankTextNode(child)) continue;
    if (child.nodeType !== MOVE_ELEMENT_NODE && child.nodeType !== MOVE_TEXT_NODE) continue;
    if (open !== null && isListRootNode(child) && !hasBlockId(child)) {
      open.push(child);
      continue;
    }
    const unit: T[] = [child];
    units.push(unit);
    open = isListRootNode(child) ? unit : null;
  }
  return units;
}

/**
 * Which unit holds `node`, or -1. A caret's container is somewhere *inside* a
 * block, so containment is the question rather than identity — and a unit can
 * be several elements, so every one of them has to be asked.
 */
function unitIndexOf(units: readonly (readonly Node[])[], node: Node): number {
  for (let i = 0; i < units.length; i += 1) {
    for (const member of units[i]) {
      if (member === node || member.contains(node)) return i;
    }
  }
  return -1;
}

/**
 * The block `node` is in — its elements, its index and how many blocks there
 * are — or null when it is in none.
 *
 * The **members** are why this exists beside {@link blockUnitPosition}: a
 * block is not always one element (§3: a list whose marker changes at depth 0
 * writes sibling roots), so anything that acts on a whole block rather than on
 * its position — the gutter handle's duplicate and delete, a drag's payload —
 * has to be handed the run rather than left to guess at it from the element
 * under the pointer.
 */
export function blockUnitOf(
  root: HTMLElement,
  node: Node,
): { members: Node[]; index: number; count: number } | null {
  const units = blockUnits(Array.from(root.childNodes));
  const index = unitIndexOf(units, node);
  const members = units[index];
  return index < 0 || members === undefined ? null : { members, index, count: units.length };
}

/** Which block `node` is in, and how many there are; null when it is in none. */
export function blockUnitPosition(
  root: HTMLElement,
  node: Node,
): { index: number; count: number } | null {
  const found = blockUnitOf(root, node);
  return found === null ? null : { index: found.index, count: found.count };
}

/**
 * Moves the block holding `node` one place up or down; false when it does not
 * move — it is at that end, or it is in no block at all.
 *
 * **The elements are moved, not rebuilt**, which is the whole point (§4). A
 * block that keeps its element keeps its `data-ve-id`, so `domToDocument`
 * still matches it to the block it was parsed from and `serializeDocument`
 * still emits it from `source`: a page whose paragraphs were only reordered
 * republishes with every paragraph byte-identical, in a new order. Rebuilding
 * the markup — or writing the wikitext out and back — would canonicalize each
 * moved block instead, so `==Layout==` would come back `== Layout ==` and a
 * multi-line paragraph would collapse onto one line, for a move that did not
 * touch a character of either.
 *
 * The caret is not touched here: the nodes it lives in are the same objects
 * after the move, and the surface re-applies the Range it saved beforehand for
 * the engines that drop the selection when a subtree is re-parented.
 */
export function moveBlock(root: HTMLElement, node: Node, direction: VeMoveDirection): boolean {
  try {
    const units = blockUnits(Array.from(root.childNodes));
    const from = unitIndexOf(units, node);
    const to = blockMoveTarget(units.length, from, direction);
    if (to === null) return false;
    // One block is a run of one, and the block it swaps with is the run's
    // destination: rising, it lands where that block starts; falling, it lands
    // where that block ends, which is one past it.
    return moveBlockRun(root, from, 1, direction === "up" ? to : to + 1);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Moving a run of blocks — a section (visual-editor.md §10.1)         */
/* ------------------------------------------------------------------ */

/**
 * Which child the lifted run is put back before, said as a unit and a side.
 *
 * The two sides are not decoration: the run has to be re-inserted relative to a
 * node that is *outside* it, and which end of the destination that is depends
 * on the direction. Rising, the anchor is the first member of the unit the run
 * lands on. Falling, the run goes after the last member of the unit before its
 * destination — and "after" has to be taken as that member's `nextSibling`
 * once the run is gone, which is why this says the side rather than a node.
 *
 * Null is every way a run does not move, and each of them is a real answer a
 * caller has to be able to draw: the run is not in the document, the
 * destination is inside the run (nothing would move and the anchor would be
 * lifted out from under itself), or the destination is one of the run's own
 * edges, which is the arrangement it is already in.
 */
export type VeRunAnchor = { side: "before" | "after"; unit: number };

export function blockRunAnchor(
  unitCount: number,
  from: number,
  count: number,
  to: number,
): VeRunAnchor | null {
  if (!Number.isInteger(unitCount) || !Number.isInteger(from)) return null;
  if (!Number.isInteger(count) || !Number.isInteger(to)) return null;
  if (count < 1 || from < 0 || from + count > unitCount) return null;
  if (to < 0 || to > unitCount) return null;
  if (to >= from && to <= from + count) return null;
  return to < from ? { side: "before", unit: to } : { side: "after", unit: to - 1 };
}

/**
 * Moves the blocks `[from, from + count)` so that they sit immediately before
 * whatever is at `to`; false when they do not move.
 *
 * **This is `moveBlock`'s move, run over more than one block**, and there is
 * deliberately no second implementation of it: a section is a run of blocks and
 * a block is a run of one, so §3.1's promise carries over unchanged. The
 * elements are re-parented rather than rebuilt, every block keeps its
 * `data-ve-id`, `domToDocument` still matches each to the block it was parsed
 * from, and §4 still emits every one of them from `source` — so an article
 * whose sections were only reordered republishes with every paragraph,
 * heading and table byte-identical, in a new order.
 *
 * `to` is an index into the units as they are *now*; the anchor is resolved
 * before anything is lifted, precisely so it cannot be a node the lift has
 * already taken away.
 */
export function moveBlockRun(
  root: HTMLElement,
  from: number,
  count: number,
  to: number,
): boolean {
  try {
    const units = blockUnits(Array.from(root.childNodes));
    const anchor = blockRunAnchor(units.length, from, count, to);
    if (anchor === null) return false;
    const target = units[anchor.unit];
    const before =
      anchor.side === "before" ? target[0] : target[target.length - 1].nextSibling;

    const fragment = ownerDocument(root).createDocumentFragment();
    for (let i = from; i < from + count; i += 1) {
      for (const member of units[i]) fragment.appendChild(member);
    }
    root.insertBefore(fragment, before);
    return true;
  } catch {
    return false;
  }
}
