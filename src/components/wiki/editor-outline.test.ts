/**
 * The outline's arithmetic — docs/engine/visual-editor.md §10.1.
 *
 * All of it is pure, and it is worth being pedantic about because the mistakes
 * it can make are invisible: a section range that is one block short leaves the
 * last paragraph of a section behind when it moves, and nothing on screen says
 * so until the article is published. So the nesting rules are asked with object
 * literals — that is what {@link OutlineNode} exists for — and the byte-level
 * promise is asked over the wikitext the wiki actually ships, the way
 * roundtrip.test.ts asks §4.
 *
 * Five shapes get their own cases because each broke something plausible:
 * ordinary nesting, a document that **starts mid-level**, a heading with
 * nothing under it, the first and last sections, and a move that would land
 * nowhere — which is three different nowheres and only one of them is an end of
 * the document.
 *
 * The last section is the one that matters most: moving a section must rewrite
 * **no block**. It is asserted through `parseDocument` on both sides, so a
 * splice that canonicalized a heading (`==Layout==` → `== Layout ==`) or folded
 * a two-line paragraph would be caught even though the page would still look
 * right.
 */

import { describe, expect, it } from "vitest";

import { ENTITY_ARTICLES } from "@/lib/db/seed-content/entities";
import { EQUIPMENT_SCRAP_ARTICLES } from "@/lib/db/seed-content/equipment-scrap";
import { MECHANICS_STRATEGY_ARTICLES } from "@/lib/db/seed-content/mechanics-strategies";
import { MOON_ARTICLES } from "@/lib/db/seed-content/moons";
import { ARTICLES } from "@/lib/db/seed-data";
import { parseDocument } from "@/lib/visual-editor/parse";

import {
  applySectionMove,
  documentOutline,
  moveRun,
  sectionAtBlock,
  sectionAtOffset,
  sectionMovePlan,
  sectionRange,
  sectionSibling,
  type OutlineMoveDirection,
  type OutlineNode,
  type SectionMovePlan,
} from "./editor-outline";

/* ---------------------------------------------------------------- */
/* Helpers                                                           */
/* ---------------------------------------------------------------- */

/**
 * A heading list from levels alone, numbered as though every heading were one
 * block apart. The nesting rules read only the level and the block index, so
 * this is the whole input for most of what follows.
 */
function nodes(levels: readonly number[]): OutlineNode[] {
  return levels.map((level, index) => ({
    level: level as OutlineNode["level"],
    blockIndex: index,
  }));
}

/** The same, with the blocks between the headings spelled out. */
function at(pairs: readonly (readonly [number, number])[]): OutlineNode[] {
  return pairs.map(([level, blockIndex]) => ({
    level: level as OutlineNode["level"],
    blockIndex,
  }));
}

const CORPUS: { name: string; wikitext: string }[] = [];
for (const article of [
  ...ARTICLES,
  ...MOON_ARTICLES,
  ...ENTITY_ARTICLES,
  ...EQUIPMENT_SCRAP_ARTICLES,
  ...MECHANICS_STRATEGY_ARTICLES,
]) {
  CORPUS.push({ name: article.title, wikitext: article.wikitext });
  for (const translation of article.translations) {
    CORPUS.push({ name: `${article.title} [${translation.locale}]`, wikitext: translation.wikitext });
  }
}

/* ---------------------------------------------------------------- */
/* documentOutline — the tree                                        */
/* ---------------------------------------------------------------- */

describe("documentOutline", () => {
  it("reads level, text and position off the buffer", () => {
    const outline = documentOutline(
      ["Lead paragraph.", "", "== One ==", "", "Body.", "", "=== One a ===", "", "== Two =="].join(
        "\n",
      ),
    );

    expect(outline.blockCount).toBe(5);
    expect(outline.headings.map((heading) => [heading.level, heading.title, heading.blockIndex])).toEqual(
      [
        [2, "One", 1],
        [3, "One a", 3],
        [2, "Two", 4],
      ],
    );
  });

  it("has no headings, and no map to draw, for a page without any", () => {
    const outline = documentOutline("Just a paragraph.\n\nAnd another.\n");
    expect(outline.headings).toEqual([]);
    expect(outline.blockCount).toBe(2);
  });

  it("survives an empty buffer", () => {
    expect(documentOutline("")).toEqual({ headings: [], blockCount: 0 });
  });

  it("prints the heading's text, not its markup", () => {
    const outline = documentOutline("== The '''Bold''' [[Moon|moon]] ==\n");
    expect(outline.headings[0].title).toBe("The Bold moon");
  });

  it("keeps a heading whose text is empty, and says it is empty", () => {
    // `== ==` is a heading with nothing in it; the panel is what decides to
    // print "(untitled)", and it can only do that if this reports the truth.
    const outline = documentOutline("== ==\n\nBody.\n");
    expect(outline.headings).toHaveLength(1);
    expect(outline.headings[0].title).toBe("");
  });

  it("indents from the shallowest level the document uses, not from h2", () => {
    const flat = documentOutline("=== A ===\n\n=== B ===\n");
    expect(flat.headings.map((heading) => heading.depth)).toEqual([0, 0]);

    const mixed = documentOutline("== A ==\n\n=== A1 ===\n\n==== A1a ====\n");
    expect(mixed.headings.map((heading) => heading.depth)).toEqual([0, 1, 2]);
  });

  it("indents a document that starts mid-level by what it says, not by what it meant", () => {
    // `===` first, `==` after: the `===` really is a level deeper, and an
    // outline that quietly promoted it would be tidying the article.
    const outline = documentOutline("=== Deep ===\n\n== Shallow ==\n");
    expect(outline.headings.map((heading) => [heading.level, heading.depth])).toEqual([
      [3, 1],
      [2, 0],
    ]);
  });

  it("does not see a heading the parser does not — inside nowiki, or in a cell", () => {
    const outline = documentOutline(
      ["<nowiki>== Not a heading ==</nowiki>", "", '{| class="wikitable"', "! == nor this ==", "|}"].join(
        "\n",
      ),
    );
    expect(outline.headings).toEqual([]);
  });

  it("cuts each heading's own wikitext out of the buffer", () => {
    const text = "Lead.\n\n==Tight==\n\nBody.\n\n===  Loose  ===\n";
    const outline = documentOutline(text);
    const cut = outline.headings.map((heading) =>
      heading.range === null ? null : text.slice(heading.range.start, heading.range.end),
    );
    expect(cut).toEqual(["==Tight==", "===  Loose  ==="]);
  });

  it("refuses to guess a range for a buffer the parser had to fold (CRLF)", () => {
    // `parseDocument` normalizes CRLF first, so every offset after the first
    // line is off by one per line. No range at all is the honest answer, and
    // the caller's contract is to scroll nowhere rather than to the wrong line.
    const outline = documentOutline("Lead.\r\n\r\n== One ==\r\n");
    expect(outline.headings).toHaveLength(1);
    expect(outline.headings[0].range).toBeNull();
    // The block index still works, which is what visual mode navigates by.
    expect(outline.headings[0].blockIndex).toBe(1);
  });

  it("cuts every heading of every article the wiki ships", () => {
    let seen = 0;
    for (const { name, wikitext } of CORPUS) {
      const outline = documentOutline(wikitext);
      const blocks = parseDocument(wikitext).blocks;
      expect(outline.blockCount, name).toBe(blocks.length);
      let previous = -1;
      for (const heading of outline.headings) {
        const block = blocks[heading.blockIndex];
        expect(block.kind, `${name} @${heading.blockIndex}`).toBe("heading");
        expect(heading.id, name).toBe(block.id);
        // Ranges are in order and never overlap, which is what makes
        // `sectionAtOffset`'s single forward walk correct.
        expect(heading.range, name).not.toBeNull();
        if (heading.range === null) continue;
        expect(heading.range.start, name).toBeGreaterThan(previous);
        previous = heading.range.start;
        expect(wikitext.slice(heading.range.start, heading.range.end), name).toBe(block.source);
        seen += 1;
      }
    }
    // A corpus with no headings in it would pass every assertion above.
    expect(seen).toBeGreaterThan(100);
  });
});

/* ---------------------------------------------------------------- */
/* sectionRange — what belongs to a heading                          */
/* ---------------------------------------------------------------- */

describe("sectionRange", () => {
  it("takes everything up to the next heading at the same level", () => {
    // == A ==  p  p  == B ==  p
    const headings = at([
      [2, 0],
      [2, 3],
    ]);
    expect(sectionRange(headings, 0, 5)).toEqual({ start: 0, end: 3 });
    expect(sectionRange(headings, 1, 5)).toEqual({ start: 3, end: 5 });
  });

  it("takes the subsections with it", () => {
    // == A ==  p  === A1 ===  p  === A2 ===  p  == B ==
    const headings = at([
      [2, 0],
      [3, 2],
      [3, 4],
      [2, 6],
    ]);
    expect(sectionRange(headings, 0, 7)).toEqual({ start: 0, end: 6 });
    expect(sectionRange(headings, 1, 7)).toEqual({ start: 2, end: 4 });
    expect(sectionRange(headings, 2, 7)).toEqual({ start: 4, end: 6 });
  });

  it("stops a subsection at a heading of a HIGHER level", () => {
    // A `==` closes a `===` even though it is not the same level: the section
    // ends at the next heading of the same *or a higher* level.
    const headings = at([
      [3, 0],
      [2, 2],
    ]);
    expect(sectionRange(headings, 0, 4)).toEqual({ start: 0, end: 2 });
  });

  it("gives a heading with nothing under it a section of just itself", () => {
    const headings = nodes([2, 2, 2]);
    expect(sectionRange(headings, 1, 3)).toEqual({ start: 1, end: 2 });
  });

  it("runs the last section to the end of the document", () => {
    const headings = at([
      [2, 1],
      [2, 4],
    ]);
    expect(sectionRange(headings, 1, 9)).toEqual({ start: 4, end: 9 });
  });

  it("never reaches back over the lead", () => {
    // Three blocks before the first heading: they belong to the page, not to
    // any section, and a range that swallowed them could bury the article's
    // first sentence under a subsection.
    const headings = at([[2, 3]]);
    expect(sectionRange(headings, 0, 6)).toEqual({ start: 3, end: 6 });
  });

  it("is null for an index that names no heading", () => {
    const headings = nodes([2, 3]);
    expect(sectionRange(headings, 2, 4)).toBeNull();
    expect(sectionRange(headings, -1, 4)).toBeNull();
    expect(sectionRange([], 0, 4)).toBeNull();
  });

  it("keeps the heading itself even when the block count is wrong", () => {
    // A stale `blockCount` must not produce an empty or inverted range: the
    // move plan divides by it, and a zero-length run is a move of nothing.
    const headings = at([[2, 5]]);
    expect(sectionRange(headings, 0, 2)).toEqual({ start: 5, end: 6 });
  });

  it("tiles the document's headings end to end, on every article", () => {
    for (const { name, wikitext } of CORPUS) {
      const { headings, blockCount } = documentOutline(wikitext);
      if (headings.length === 0) continue;
      for (let i = 0; i < headings.length; i += 1) {
        const range = sectionRange(headings, i, blockCount);
        expect(range, name).not.toBeNull();
        if (range === null) continue;
        expect(range.start, name).toBe(headings[i].blockIndex);
        expect(range.end, name).toBeGreaterThan(range.start);
        expect(range.end, name).toBeLessThanOrEqual(blockCount);
      }
    }
  });
});

/* ---------------------------------------------------------------- */
/* sectionSibling — who a section may be swapped with                */
/* ---------------------------------------------------------------- */

describe("sectionSibling", () => {
  it("finds the neighbour at the same level", () => {
    const headings = nodes([2, 2, 2]);
    expect(sectionSibling(headings, 1, "up")).toBe(0);
    expect(sectionSibling(headings, 1, "down")).toBe(2);
  });

  it("steps over a neighbour's subsections", () => {
    // == A ==  === A1 ===  === A2 ===  == B ==
    const headings = nodes([2, 3, 3, 2]);
    expect(sectionSibling(headings, 0, "down")).toBe(3);
    expect(sectionSibling(headings, 3, "up")).toBe(0);
  });

  it("has nowhere to go at the first and last of a level", () => {
    const headings = nodes([2, 2]);
    expect(sectionSibling(headings, 0, "up")).toBe(-1);
    expect(sectionSibling(headings, 1, "down")).toBe(-1);
  });

  it("refuses the same level under a different parent — that is a re-parenting", () => {
    // == A ==  === A1 ===  == B ==  === B1 ===
    // A1 and B1 are both `===`, and swapping them would move A1 out of A and
    // into B. The outline reorders; it does not restructure.
    const headings = nodes([2, 3, 2, 3]);
    expect(sectionSibling(headings, 1, "down")).toBe(-1);
    expect(sectionSibling(headings, 3, "up")).toBe(-1);
    // Their parents are siblings of each other, and those do move.
    expect(sectionSibling(headings, 0, "down")).toBe(2);
  });

  it("gives an only subsection no sibling in either direction", () => {
    const headings = nodes([2, 3, 2]);
    expect(sectionSibling(headings, 1, "up")).toBe(-1);
    expect(sectionSibling(headings, 1, "down")).toBe(-1);
  });

  it("gives a document that starts mid-level no siblings at all", () => {
    // === Deep ===  == Shallow ==. Neither is at the other's level, so neither
    // has anywhere to go — the honest answer, and both arrows are disabled.
    const headings = nodes([3, 2]);
    expect(sectionSibling(headings, 0, "down")).toBe(-1);
    expect(sectionSibling(headings, 1, "up")).toBe(-1);
  });

  it("is -1 for an index that names no heading", () => {
    expect(sectionSibling(nodes([2]), 4, "up")).toBe(-1);
    expect(sectionSibling([], 0, "down")).toBe(-1);
  });

  it("is symmetric: my next sibling's previous sibling is me", () => {
    const headings = nodes([2, 3, 4, 3, 2, 3, 2]);
    for (let i = 0; i < headings.length; i += 1) {
      const down = sectionSibling(headings, i, "down");
      if (down < 0) continue;
      expect(sectionSibling(headings, down, "up")).toBe(i);
    }
  });
});

/* ---------------------------------------------------------------- */
/* sectionMovePlan — where a section lands                           */
/* ---------------------------------------------------------------- */

describe("sectionMovePlan", () => {
  it("swaps two top-level sections, subsections and all", () => {
    // b0 == A ==   b1 p   b2 === A1 ===   b3 p   b4 == B ==   b5 p
    const headings = at([
      [2, 0],
      [3, 2],
      [2, 4],
    ]);
    expect(sectionMovePlan(headings, 0, "down", 6)).toEqual({
      from: 0,
      count: 4,
      to: 6,
      blockCount: 6,
    });
    // The same swap, asked the other way round, is the same arrangement.
    expect(sectionMovePlan(headings, 2, "up", 6)).toEqual({
      from: 4,
      count: 2,
      to: 0,
      blockCount: 6,
    });
  });

  it("lands past the whole of the section it steps over, not past its heading", () => {
    // b0 == A ==   b1 == B ==   b2 === B1 ===   b3 == C ==
    // A moving down has to clear B *and* B1, or it would land inside B.
    const headings = at([
      [2, 0],
      [2, 1],
      [3, 2],
      [2, 3],
    ]);
    expect(sectionMovePlan(headings, 0, "down", 4)).toEqual({
      from: 0,
      count: 1,
      to: 3,
      blockCount: 4,
    });
  });

  it("is null at both ends", () => {
    const headings = nodes([2, 2, 2]);
    expect(sectionMovePlan(headings, 0, "up", 3)).toBeNull();
    expect(sectionMovePlan(headings, 2, "down", 3)).toBeNull();
  });

  it("is null for a section with no sibling to trade places with", () => {
    // The three nowheres that are not an end of the document: an only
    // subsection, a subsection whose same-level neighbour has another parent,
    // and a document that starts mid-level.
    expect(sectionMovePlan(nodes([2, 3, 2]), 1, "down", 3)).toBeNull();
    expect(sectionMovePlan(nodes([2, 3, 2, 3]), 1, "down", 4)).toBeNull();
    expect(sectionMovePlan(nodes([3, 2]), 0, "down", 2)).toBeNull();
  });

  it("is null for a row that is not there", () => {
    expect(sectionMovePlan(nodes([2, 2]), 7, "up", 2)).toBeNull();
  });

  it("carries the block count it was computed over", () => {
    const plan = sectionMovePlan(nodes([2, 2]), 1, "up", 2);
    expect(plan?.blockCount).toBe(2);
  });
});

/* ---------------------------------------------------------------- */
/* moveRun — the array move both surfaces are planned in             */
/* ---------------------------------------------------------------- */

describe("moveRun", () => {
  const plan = (from: number, count: number, to: number): SectionMovePlan => ({
    from,
    count,
    to,
    blockCount: 0,
  });

  it("moves a run forwards and backwards", () => {
    const items = ["a", "b", "c", "d", "e"];
    expect(moveRun(items, plan(0, 2, 4))).toEqual(["c", "d", "a", "b", "e"]);
    expect(moveRun(items, plan(3, 2, 1))).toEqual(["a", "d", "e", "b", "c"]);
  });

  it("moves a run to the very end", () => {
    expect(moveRun(["a", "b", "c"], plan(0, 1, 3))).toEqual(["b", "c", "a"]);
  });

  it("moves a run to the very front", () => {
    expect(moveRun(["a", "b", "c"], plan(2, 1, 0))).toEqual(["c", "a", "b"]);
  });

  it("refuses a destination inside the run, or on either of its edges", () => {
    const items = ["a", "b", "c", "d"];
    expect(moveRun(items, plan(1, 2, 2))).toBeNull();
    expect(moveRun(items, plan(1, 2, 1))).toBeNull();
    expect(moveRun(items, plan(1, 2, 3))).toBeNull();
  });

  it("refuses a run that is not in the list", () => {
    const items = ["a", "b"];
    expect(moveRun(items, plan(1, 5, 0))).toBeNull();
    expect(moveRun(items, plan(-1, 1, 0))).toBeNull();
    expect(moveRun(items, plan(0, 0, 1))).toBeNull();
    expect(moveRun(items, plan(0, 1, 9))).toBeNull();
    expect(moveRun(items, plan(0.5, 1, 2))).toBeNull();
  });

  it("keeps every item exactly once", () => {
    const items = [0, 1, 2, 3, 4, 5];
    const moved = moveRun(items, plan(1, 3, 6));
    expect(moved).not.toBeNull();
    expect([...(moved ?? [])].sort((a, b) => a - b)).toEqual(items);
  });
});

/* ---------------------------------------------------------------- */
/* applySectionMove — §4 through the buffer                          */
/* ---------------------------------------------------------------- */

/** The first row of `text` whose section can move that way, or null. */
function firstMovable(
  text: string,
  direction: OutlineMoveDirection,
): { index: number; plan: SectionMovePlan } | null {
  const { headings, blockCount } = documentOutline(text);
  for (let index = 0; index < headings.length; index += 1) {
    const plan = sectionMovePlan(headings, index, direction, blockCount);
    if (plan !== null) return { index, plan };
  }
  return null;
}

describe("applySectionMove", () => {
  const ARTICLE = [
    "Lead sentence.",
    "",
    "==Alpha==",
    "First",
    "line and second line.",
    "",
    "=== Alpha one ===",
    "* one",
    "* two",
    "",
    "== Beta ==",
    "Beta body.",
    "",
    "== Gamma ==",
    "Gamma body.",
  ].join("\n");

  it("moves the section and rewrites no block", () => {
    const before = parseDocument(ARTICLE).blocks;
    const found = firstMovable(ARTICLE, "down");
    expect(found).not.toBeNull();
    if (found === null) return;

    const moved = applySectionMove(ARTICLE, found.plan);
    const after = parseDocument(moved).blocks;
    const expected = moveRun(before, found.plan);
    expect(expected).not.toBeNull();
    // Every block's ORIGINAL bytes, in the new order. `==Alpha==` stays tight
    // and the two-line paragraph stays on two lines: a serializer that
    // canonicalized either would fail here and look fine on screen.
    expect(after.map((block) => block.source)).toEqual(
      (expected ?? []).map((block) => block.source),
    );
  });

  it("moves the lead nowhere", () => {
    const moved = applySectionMove(ARTICLE, {
      from: 1,
      count: 3,
      to: 5,
      blockCount: parseDocument(ARTICLE).blocks.length,
    });
    // Whatever that plan does, the lead is block 0 and stays block 0 — no plan
    // this module produces starts before the first heading.
    expect(parseDocument(moved).blocks[0].source).toBe("Lead sentence.");
  });

  it("does not glue two blocks together when the last section rises", () => {
    // The last block's gap separates it from nothing, and carrying that gap
    // into the middle of the article is how a reorder silently merges two
    // paragraphs. `serializeDocument` re-derives it; this is the assertion
    // that it did.
    const text = "== A ==\n\nA body.\n\n== B ==\n\nB body.";
    const found = firstMovable(text, "down");
    expect(found).not.toBeNull();
    if (found === null) return;
    const moved = applySectionMove(text, found.plan);
    expect(parseDocument(moved).blocks).toHaveLength(4);
    // Four blocks, a blank line between each, one newline at the end. Both
    // joints were re-derived, because both blocks there lost the successor
    // their gap belonged to — which is §4's own rule, and the reason the
    // document does not end on a stray blank line either.
    expect(moved).toBe("== B ==\n\nB body.\n\n== A ==\n\nA body.\n");
  });

  it("returns the buffer untouched when the plan does not fit it", () => {
    const stale: SectionMovePlan = { from: 0, count: 2, to: 4, blockCount: 99 };
    expect(applySectionMove(ARTICLE, stale)).toBe(ARTICLE);
    const impossible: SectionMovePlan = {
      from: 0,
      count: 1,
      to: 1,
      blockCount: parseDocument(ARTICLE).blocks.length,
    };
    expect(applySectionMove(ARTICLE, impossible)).toBe(ARTICLE);
  });

  it("rewrites no block, on every article the wiki ships", () => {
    let moved = 0;
    for (const { name, wikitext } of CORPUS) {
      for (const direction of ["up", "down"] as const) {
        const found = firstMovable(wikitext, direction);
        if (found === null) continue;
        const before = parseDocument(wikitext).blocks;
        const expected = moveRun(before, found.plan);
        const after = parseDocument(applySectionMove(wikitext, found.plan)).blocks;
        expect(after.map((block) => block.source), `${name} ${direction}`).toEqual(
          (expected ?? []).map((block) => block.source),
        );
        moved += 1;
      }
    }
    expect(moved).toBeGreaterThan(20);
  });
});

/* ---------------------------------------------------------------- */
/* Where the caret is                                                */
/* ---------------------------------------------------------------- */

describe("sectionAtBlock / sectionAtOffset", () => {
  const TEXT = ["Lead.", "", "== A ==", "", "A body.", "", "=== A1 ===", "", "A1 body."].join("\n");
  const OUTLINE = documentOutline(TEXT);

  it("puts the lead in no section at all", () => {
    expect(sectionAtBlock(OUTLINE.headings, 0)).toBe(-1);
    expect(sectionAtOffset(OUTLINE.headings, 0)).toBe(-1);
  });

  it("marks the innermost section, not its parent", () => {
    // Block 4 is A1's body; A contains it too, but A1 is where the caret is.
    expect(sectionAtBlock(OUTLINE.headings, 4)).toBe(1);
    expect(sectionAtOffset(OUTLINE.headings, TEXT.indexOf("A1 body."))).toBe(1);
  });

  it("marks the heading's own row while the caret is in the heading", () => {
    expect(sectionAtBlock(OUTLINE.headings, 1)).toBe(0);
    expect(sectionAtOffset(OUTLINE.headings, TEXT.indexOf("== A =="))).toBe(0);
  });

  it("answers -1 for a caret nobody reported", () => {
    expect(sectionAtBlock(OUTLINE.headings, -1)).toBe(-1);
    expect(sectionAtOffset(OUTLINE.headings, -1)).toBe(-1);
  });

  it("clamps past the end rather than falling off it", () => {
    expect(sectionAtBlock(OUTLINE.headings, 999)).toBe(1);
    expect(sectionAtOffset(OUTLINE.headings, 9999)).toBe(1);
  });

  it("refuses an offset when the buffer has no ranges to compare it with", () => {
    // CRLF: block indices still work, offsets do not, and an offset asked of
    // them gets no answer rather than a wrong one.
    const folded = documentOutline("Lead.\r\n\r\n== A ==\r\n\r\nBody.\r\n");
    expect(folded.headings[0].range).toBeNull();
    expect(sectionAtOffset(folded.headings, 20)).toBe(-1);
    expect(sectionAtBlock(folded.headings, 2)).toBe(0);
  });

  it("is in no section when there are no headings", () => {
    const none = documentOutline("Just prose.\n");
    expect(sectionAtBlock(none.headings, 0)).toBe(-1);
    expect(sectionAtOffset(none.headings, 3)).toBe(-1);
  });
});
