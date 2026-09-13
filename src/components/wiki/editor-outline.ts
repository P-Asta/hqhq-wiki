/**
 * The outline: the heading tree of the buffer, and the arithmetic of moving a
 * whole **section** — a heading and everything under it — among its siblings
 * (docs/engine/visual-editor.md §10.1).
 *
 * It is pure, and it is derived from the **buffer** rather than from either
 * surface, for the reason §9.1 gives for find and replace: source mode edits
 * the wikitext and visual mode edits a rendering of it, so an outline written
 * against a surface would be a second outline to write, to test and to keep in
 * step. The one string both modes agree on is the buffer.
 *
 * Every position here is said twice, because the two consumers ask in different
 * units and the two keys fail in different places:
 *
 * - a **block index**, which is what `ve-selection.ts`'s mover moves and what
 *   the visual surface reports its caret in;
 * - a **buffer range**, which is what the source textarea scrolls to and what
 *   its caret is an offset into.
 *
 * The block indices always exist; the ranges can be null, together, under
 * exactly `blockSpans`' rule (editor-find.ts): they are `serializeDocument`'s
 * own arithmetic restricted to a freshly parsed document, and a document whose
 * spans do not tile the buffer end to end — one holding CRLF, which the parser
 * folds and the raw buffer did not — yields no ranges at all rather than ranges
 * that are off by a little. A caller with no range does not scroll; a caller
 * with a wrong one would scroll somewhere and claim the heading is there.
 *
 * **Why a section and not a block.** §3.1 already moves one block, and an
 * author restructuring an article does not think in blocks: "swap Behaviour and
 * Strategy" is six paragraphs and two headings, and doing it with the gutter
 * handle is a dozen presses that pass through a dozen wrong arrangements. What
 * this module adds is only the *plan*; the move itself is still §3.1's, applied
 * by `moveBlockRun` to the same units `moveBlock` moves — there is one mover.
 */

import { inlineText, type VeBlock, type VeHeadingLevel } from "@/lib/visual-editor/model";
import { parseDocument } from "@/lib/visual-editor/parse";
import { serializeDocument } from "@/lib/visual-editor/serialize";

/* ------------------------------------------------------------------ */
/* The tree                                                            */
/* ------------------------------------------------------------------ */

/** A heading's span in the buffer: `text.slice(start, end)` is its wikitext. */
export interface OutlineRange {
  start: number;
  end: number;
}

/**
 * The parts of a heading the section arithmetic below reads, and nothing more.
 *
 * Split out from {@link OutlineHeading} so every rule in this file can be asked
 * with object literals — the same bargain `VeMoveNode` and `VeDomNode` make.
 * The nesting rules are the ones that are easy to get wrong and hard to *see*
 * wrong once they are spliced into a document, so they are the ones that have
 * to be cheap to ask.
 */
export interface OutlineNode {
  /** `2` for `== x ==`; 1–6, and a document may start at any of them. */
  level: VeHeadingLevel;
  /** Which block of the document the heading itself is. */
  blockIndex: number;
}

export interface OutlineHeading extends OutlineNode {
  /** `data-ve-id` of the heading's block, so the surface can be asked for it. */
  id: string;
  /** The heading's plain text — what the row prints. May be empty (`== ==`). */
  title: string;
  /**
   * How far the row is indented: the level, less the shallowest level the
   * document uses. An article written entirely in `===` reads flat, which is
   * what it is; one that starts at `===` and only then uses `==` indents the
   * `===` — which is also what it is. The outline reports the document, it
   * does not tidy it.
   */
  depth: number;
  /** Where the heading's own wikitext is, or null — see the module comment. */
  range: OutlineRange | null;
}

export interface DocumentOutline {
  headings: OutlineHeading[];
  /**
   * How many blocks the document has. A move plan carries it so the surface it
   * is applied to can refuse a plan computed over a different document — the
   * visual surface serializes on a debounce, so the buffer this was derived
   * from can trail the DOM by a fraction of a second.
   */
  blockCount: number;
}

/** The heading tree of a buffer, in document order. */
export function documentOutline(text: string): DocumentOutline {
  const doc = parseDocument(text);

  // The tiling `blockSpans` does, walked here rather than parsed a second time:
  // `leading`, then every block's own `source` and its own `gapAfter`.
  const ranges: (OutlineRange | null)[] = [];
  let offset = doc.leading.length;
  let tiles = true;
  for (const block of doc.blocks) {
    if (!tiles || block.source === null || block.gapAfter === null) {
      tiles = false;
      ranges.push(null);
      continue;
    }
    ranges.push({ start: offset, end: offset + block.source.length });
    offset += block.source.length + block.gapAfter.length;
  }
  if (offset !== text.length) tiles = false;

  let shallowest: number | null = null;
  for (const block of doc.blocks) {
    if (block.kind !== "heading") continue;
    if (shallowest === null || block.level < shallowest) shallowest = block.level;
  }

  const headings: OutlineHeading[] = [];
  for (let index = 0; index < doc.blocks.length; index += 1) {
    const block = doc.blocks[index];
    if (block.kind !== "heading") continue;
    headings.push({
      id: block.id,
      blockIndex: index,
      level: block.level,
      title: inlineText(block.children).trim(),
      depth: block.level - (shallowest ?? block.level),
      range: tiles ? ranges[index] : null,
    });
  }

  return { headings, blockCount: doc.blocks.length };
}

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

/** Block indices `[start, end)` — the heading, and everything under it. */
export interface OutlineSection {
  start: number;
  end: number;
}

/**
 * Which blocks belong to heading `index`: the heading itself, and every block
 * after it up to the next heading of the **same or a higher** level — "higher"
 * meaning a smaller number, which is what `== x ==` closing a `=== y ===` is.
 *
 * Null for an index that names no heading, because a caller may be holding a
 * row drawn from a buffer that has since lost it.
 *
 * The blocks *before* the first heading are in no section and this never
 * returns them: a page's lead belongs to the page rather than to a heading, and
 * a section move able to displace it would be able to bury the first sentence
 * of the article under a subsection.
 */
export function sectionRange(
  headings: readonly OutlineNode[],
  index: number,
  blockCount: number,
): OutlineSection | null {
  const heading = headings[index];
  if (heading === undefined) return null;
  let end = blockCount;
  for (let i = index + 1; i < headings.length; i += 1) {
    if (headings[i].level <= heading.level) {
      end = headings[i].blockIndex;
      break;
    }
  }
  // A heading is always in its own section, even one that closes the document
  // or is followed immediately by a shallower heading.
  return { start: heading.blockIndex, end: Math.max(end, heading.blockIndex + 1) };
}

/** Up the document or down it — the two ways a section moves, as a block does. */
export type OutlineMoveDirection = "up" | "down";

/**
 * The sibling one step up or down: the nearest heading in that direction at the
 * **same level with the same parent**, or -1 when there is none.
 *
 * "Same parent" is not a second test — it falls out of the scan. Walking away
 * from `index`, a *deeper* heading belongs to some other section and is stepped
 * over; the first heading at the same level is a sibling, because no shallower
 * one was crossed to reach it; and a *shallower* one is the enclosing section's
 * edge, so the scan stops there rather than stepping outside the section this
 * heading lives in.
 *
 * That last rule is the whole point. Under
 *
 *     == A ==   === A1 ===   == B ==   === B1 ===
 *
 * `A1` has no next sibling: `B1` stands at the same level, but moving `A1` onto
 * it would take it out of `A` and put it into `B`. That is a *re-parenting* and
 * not a reorder, and an outline offering it as "move down" would rewrite the
 * article's structure while claiming to shuffle it. The arrow is disabled
 * instead.
 */
export function sectionSibling(
  headings: readonly OutlineNode[],
  index: number,
  direction: OutlineMoveDirection,
): number {
  const heading = headings[index];
  if (heading === undefined) return -1;
  const step = direction === "up" ? -1 : 1;
  for (let i = index + step; i >= 0 && i < headings.length; i += step) {
    const level = headings[i].level;
    if (level < heading.level) return -1;
    if (level === heading.level) return i;
  }
  return -1;
}

/**
 * A run of blocks to be lifted out and put back somewhere else — the same shape
 * `moveBlockRun` (ve-selection.ts) applies to the DOM and
 * {@link applySectionMove} applies to the buffer.
 *
 * `to` is said in the numbering the run was read in, *before* the lift: the run
 * ends up immediately before whatever is at index `to` now. It therefore always
 * falls outside `[from, from + count)`.
 */
export interface SectionMovePlan {
  from: number;
  count: number;
  to: number;
  /** The document this was computed over — a surface that disagrees refuses. */
  blockCount: number;
}

/**
 * Where a section goes when it is moved, or **null when it goes nowhere**.
 *
 * Nowhere is a real answer, and it has three causes worth telling apart even
 * though the caller needs only the one: the first sibling cannot rise, the last
 * cannot fall, and a heading with no sibling in that direction at all — an only
 * subsection, or the `===` a document that starts mid-level opens with — can do
 * neither. All three disable the arrow rather than letting it click and do
 * nothing, which is the rule §3.1's gutter handle already keeps.
 */
export function sectionMovePlan(
  headings: readonly OutlineNode[],
  index: number,
  direction: OutlineMoveDirection,
  blockCount: number,
): SectionMovePlan | null {
  const range = sectionRange(headings, index, blockCount);
  if (range === null) return null;
  const sibling = sectionSibling(headings, index, direction);
  if (sibling < 0) return null;
  const other = sectionRange(headings, sibling, blockCount);
  if (other === null) return null;
  // Up: land where the sibling starts. Down: land where the sibling *ends* —
  // its whole section and not its heading, or moving past a section that has
  // subsections would land inside it.
  const to = direction === "up" ? other.start : other.end;
  if (to >= range.start && to <= range.end) return null;
  return { from: range.start, count: range.end - range.start, to, blockCount };
}

/* ------------------------------------------------------------------ */
/* Where the caret is                                                  */
/* ------------------------------------------------------------------ */

/**
 * The last heading the position has already passed, walking in document order.
 *
 * `before` answers "is this heading at or before the position?" and returns
 * null for a heading that cannot say — a buffer offset asked of a document
 * whose ranges did not tile (above) — which ends the walk rather than guessing.
 */
function lastPassed(
  headings: readonly OutlineHeading[],
  before: (heading: OutlineHeading) => boolean | null,
): number {
  let found = -1;
  for (let i = 0; i < headings.length; i += 1) {
    const passed = before(headings[i]);
    if (passed === null || !passed) break;
    found = i;
  }
  return found;
}

/**
 * The section holding a position, as an index into `headings`, or -1.
 *
 * The **innermost** one, which is what "the section the caret is in" means to
 * an author: sections partition everything after the lead, in document order,
 * so the last heading at or before the position is the deepest one containing
 * it. -1 is the honest answer for the lead, which is in no section at all.
 */
export function sectionAtBlock(headings: readonly OutlineHeading[], blockIndex: number): number {
  if (blockIndex < 0) return -1;
  return lastPassed(headings, (heading) => heading.blockIndex <= blockIndex);
}

/** The same, for the buffer offset the source textarea reports its caret as. */
export function sectionAtOffset(headings: readonly OutlineHeading[], offset: number): number {
  if (offset < 0) return -1;
  return lastPassed(headings, (heading) =>
    heading.range === null ? null : heading.range.start <= offset,
  );
}

/* ------------------------------------------------------------------ */
/* Applying a plan to the buffer (source mode)                         */
/* ------------------------------------------------------------------ */

/**
 * The plan as an array move: items `[from, from + count)` lifted out and put
 * back before the item that was at `to`. Null when the plan does not describe a
 * move of this list at all — which is the caller's cue to leave it alone.
 *
 * Exported because it *is* the arithmetic, and the arithmetic is the part that
 * is easy to get subtly wrong and impossible to see wrong once it has been
 * spliced into a DOM.
 */
export function moveRun<T>(items: readonly T[], plan: SectionMovePlan): T[] | null {
  const { from, count, to } = plan;
  if (!Number.isInteger(from) || !Number.isInteger(count) || !Number.isInteger(to)) return null;
  if (count < 1 || from < 0 || from + count > items.length) return null;
  if (to < 0 || to > items.length) return null;
  // Inside the run is not a destination, and either edge of it is not a move.
  if (to >= from && to <= from + count) return null;
  const run = items.slice(from, from + count);
  const rest = [...items.slice(0, from), ...items.slice(from + count)];
  const at = to < from ? to : to - count;
  return [...rest.slice(0, at), ...run, ...rest.slice(at)];
}

/**
 * Move a section inside the wikitext — what source mode does, having no DOM to
 * re-parent.
 *
 * Through the model rather than by slicing the string, and the difference is
 * §4. Every block of a freshly parsed document is untouched, so each is emitted
 * from its own `source` and comes back byte for byte; what cannot be carried
 * along is the whitespace, because **`gapAfter` belongs to a pair** and three
 * of this document's pairs no longer exist. §4's rule for that case is written
 * down and `domToDocument` already keeps it: a block whose *successor* changed
 * loses its gap, and the serializer derives a new one that can actually
 * separate the pair the block sits between now. Carrying the old one instead is
 * how a reorder silently merges two paragraphs — the `"\n"` that separated the
 * last block from nothing separates nothing in the middle of an article.
 *
 * Keeping that rule here rather than inventing a second one is also what makes
 * the two movers agree: the visual surface re-parents elements and reads them
 * back through `domToDocument`, and a section that came out different depending
 * on which mode the author happened to be in would be a difference nobody could
 * see until they switched. `ve-selection.test.ts` asserts the two byte for byte.
 *
 * A plan that does not fit the buffer returns it unchanged.
 */
export function applySectionMove(text: string, plan: SectionMovePlan): string {
  const doc = parseDocument(text);
  if (doc.blocks.length !== plan.blockCount) return text;
  const moved = moveRun(doc.blocks, plan);
  if (moved === null) return text;

  const successorWas = new Map<VeBlock, VeBlock | null>();
  for (let i = 0; i < doc.blocks.length; i += 1) {
    successorWas.set(doc.blocks[i], doc.blocks[i + 1] ?? null);
  }
  const blocks = moved.map((block, index) => {
    const next = moved[index + 1] ?? null;
    return successorWas.get(block) === next ? block : { ...block, gapAfter: null };
  });

  return serializeDocument({ leading: doc.leading, blocks });
}
