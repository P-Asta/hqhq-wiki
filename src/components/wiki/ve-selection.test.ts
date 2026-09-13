/**
 * The decisions in `ve-selection.ts` that can be asked without a browser
 * (docs/engine/visual-editor.md §3 DOM mapping, §3.1 moving a block, §4 the
 * round-trip guarantee, §5 atomic previews).
 *
 * The rest of the module is Range and DOM surgery, and this suite runs in
 * vitest's `node` environment, where there is neither. So the questions the
 * surgery got *wrong* are exported and answered here instead: "where in the
 * root does this block go?", "is this markup the author's at all?", "which of
 * the root's children are one block?" and "where does a block moved from i
 * land?" All four are plain enough to ask with object literals, and the first
 * two used to be answered by accident — one by appending to the end of the
 * article, the other by not asking.
 *
 * The last section is bigger than a decision, because moving a block makes a
 * claim about §4: reordering a page must republish every block byte for byte.
 * That is asserted the way roundtrip.test.ts asserts the rest of §4 — through
 * the whole surface, `documentToHtml` → move → `domToDocument` →
 * `serializeDocument` — since a move that re-created markup instead of
 * re-parenting it would still look right on screen and quietly canonicalize
 * every block it touched.
 */

import { describe, expect, it } from "vitest";

import { documentToHtml, domToDocument, type VeDomNode } from "@/lib/visual-editor/dom";
import { createIdFactory } from "@/lib/visual-editor/model";
import { parseDocument } from "@/lib/visual-editor/parse";
import { serializeDocument } from "@/lib/visual-editor/serialize";

import {
  applySectionMove,
  documentOutline,
  sectionMovePlan,
  type OutlineMoveDirection,
} from "./editor-outline";
import {
  atomicBeside,
  blockMoveTarget,
  blockRunAnchor,
  blockUnits,
  isInAtomic,
  lineTextOf,
  neighbourIndex,
  rootInsertIndex,
  type VeAncestor,
  type VeLineNode,
  type VeMoveDirection,
  type VeWalkNode,
} from "./ve-selection";

/* ---------------------------------------------------------------- */
/* rootInsertIndex — a block insertion at a boundary on the root     */
/* ---------------------------------------------------------------- */

describe("rootInsertIndex", () => {
  it("puts a second INSERT beside the first, not at the end of the article", () => {
    // INSERT ▾ → Table on `[p, table, p]` leaves the caret where
    // `placeCaretAfter` put it: (root, 2), the gap behind the new chip. The
    // next table belongs in that gap — appending it landed it below the
    // trailing paragraph, at the bottom of the page.
    expect(rootInsertIndex(3, 2, false)).toBe(2);
  });

  it("puts a block after the chip the author has selected", () => {
    // Clicking an atomic runs `selectNode`, whose range is
    // (root, 1)–(root, 2): the block the author is standing on is that child,
    // so INSERT goes after it, exactly as a caret inside any other block does.
    expect(rootInsertIndex(3, 1, true)).toBe(2);
  });

  it("inserts at the front when the boundary is before every child", () => {
    expect(rootInsertIndex(3, 0, false)).toBe(0);
    expect(rootInsertIndex(3, 0, true)).toBe(1);
  });

  it("appends when the boundary is past the last child", () => {
    expect(rootInsertIndex(3, 3, false)).toBe(3);
    // Nothing at the offset can be the selected child, so the flag cannot
    // push the index past the end.
    expect(rootInsertIndex(3, 3, true)).toBe(3);
  });

  it("survives an offset no child answers to", () => {
    expect(rootInsertIndex(2, 9, false)).toBe(2);
    expect(rootInsertIndex(2, -1, false)).toBe(0);
    expect(rootInsertIndex(0, 0, false)).toBe(0);
  });
});

/* ---------------------------------------------------------------- */
/* isInAtomic — authored content, or an injected preview?            */
/* ---------------------------------------------------------------- */

/** One element in an ancestor chain: its attributes, and what holds it. */
function node(attrs: readonly string[], parent: VeAncestor | null = null): VeAncestor {
  return { hasAttribute: (name: string) => attrs.includes(name), parentElement: parent };
}

describe("isInAtomic", () => {
  it("says no for a list the author wrote", () => {
    const surface = node([]);
    const list = node(["data-ve", "data-ve-id"], surface);
    const item = node([], list);
    expect(isInAtomic(item)).toBe(false);
    expect(isInAtomic(list)).toBe(false);
  });

  it("says yes inside a rendered <gallery>, which is a list of divs", () => {
    // The shape `POST /api/preview/fragments` returns for a `<gallery>`:
    // `<ul class="gallery"><li class="gallerybox"><div class="thumb">…`.
    // `normalizeLists` used to unwrap both of those `<div>`s, collapsing the
    // thumbnails and captions into a run of loose text that no reload short
    // of a whole document load could repair.
    const surface = node([]);
    const atomic = node(["data-ve", "data-ve-kind", "data-ve-src"], surface);
    const body = node(["data-ve-body"], atomic);
    const gallery = node([], body);
    const box = node([], gallery);
    const thumb = node([], box);
    expect(isInAtomic(thumb)).toBe(true);
    expect(isInAtomic(box)).toBe(true);
    expect(isInAtomic(gallery)).toBe(true);
  });

  it("counts the atomic node itself as one", () => {
    const atomic = node(["data-ve-src"], node([]));
    expect(isInAtomic(atomic)).toBe(true);
  });

  it("has an answer for a node with no ancestry at all", () => {
    expect(isInAtomic(null)).toBe(false);
    expect(isInAtomic(node([]))).toBe(false);
  });
});

/* ---------------------------------------------------------------- */
/* blockMoveTarget — where a block lands, and where it does not      */
/* ---------------------------------------------------------------- */

describe("blockMoveTarget", () => {
  it("moves a block one place, in the direction asked for", () => {
    expect(blockMoveTarget(5, 2, "up")).toBe(1);
    expect(blockMoveTarget(5, 2, "down")).toBe(3);
  });

  it("says nowhere at the ends of the document", () => {
    // The answer the gutter disables a button on, and the shortcut swallows.
    // `index - 1` would be -1, which `insertBefore` reads as "append": the
    // first paragraph of an article would teleport to the bottom of it.
    expect(blockMoveTarget(5, 0, "up")).toBeNull();
    expect(blockMoveTarget(5, 4, "down")).toBeNull();
  });

  it("says nowhere in a document with nothing to swap with", () => {
    expect(blockMoveTarget(1, 0, "up")).toBeNull();
    expect(blockMoveTarget(1, 0, "down")).toBeNull();
    expect(blockMoveTarget(0, 0, "up")).toBeNull();
    expect(blockMoveTarget(0, 0, "down")).toBeNull();
  });

  it("says nowhere for an index the document does not have", () => {
    // The DOM can change under a handle the pointer is still hovering, and a
    // block that has been deleted must not move its neighbour instead.
    expect(blockMoveTarget(3, 3, "up")).toBeNull();
    expect(blockMoveTarget(3, -1, "down")).toBeNull();
    expect(blockMoveTarget(3, 1.5, "up")).toBeNull();
    expect(blockMoveTarget(3, Number.NaN, "down")).toBeNull();
  });

  it("is reversible everywhere it answers at all", () => {
    for (let index = 0; index < 6; index += 1) {
      const down = blockMoveTarget(6, index, "down");
      if (down === null) continue;
      expect(blockMoveTarget(6, down, "up")).toBe(index);
    }
  });
});

/* ---------------------------------------------------------------- */
/* The surface — documentToHtml's markup as walkable nodes           */
/* ---------------------------------------------------------------- */

/**
 * `documentToHtml`'s output as the nodes `domToDocument` walks, and as the
 * children a move re-orders.
 *
 * The same bargain roundtrip.test.ts makes, for the same reason: vitest runs
 * in node, so there is no DOM, and one would only prove what a browser does
 * with the markup. This reads back exactly the subset the writer emits —
 * elements with double-quoted attributes, void `<br>`/`<hr>`, the four
 * entities `escapeHtml` writes — and throws on anything else rather than
 * guessing.
 */
interface SurfaceNode extends VeDomNode {
  childNodes: SurfaceNode[];
  getAttribute(name: string): string | null;
}

const TAG = /<(\/?)([a-z][a-z0-9]*)((?:\s+[a-z-]+="[^"]*")*)\s*>/gi;
const ATTRIBUTE = /([a-z-]+)="([^"]*)"/gi;
const VOID_TAGS = new Set(["BR", "HR"]);

function unescapeHtml(value: string): string {
  // `&amp;` last, or an escaped `&lt;` comes back as a tag.
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function element(tag: string, attributes = ""): SurfaceNode {
  const attrs = new Map<string, string>();
  ATTRIBUTE.lastIndex = 0;
  let found = ATTRIBUTE.exec(attributes);
  while (found !== null) {
    attrs.set(found[1], unescapeHtml(found[2]));
    found = ATTRIBUTE.exec(attributes);
  }
  return {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    nodeValue: null,
    childNodes: [],
    getAttribute: (wanted: string): string | null => attrs.get(wanted) ?? null,
  };
}

function textNode(value: string): SurfaceNode {
  return {
    nodeType: 3,
    nodeName: "#text",
    nodeValue: value,
    childNodes: [],
    getAttribute: () => null,
  };
}

function surface(html: string): SurfaceNode {
  const root = element("div");
  const stack: SurfaceNode[] = [root];
  const pushText = (raw: string): void => {
    if (raw === "") return;
    stack[stack.length - 1].childNodes.push(textNode(unescapeHtml(raw)));
  };

  let at = 0;
  TAG.lastIndex = 0;
  let match = TAG.exec(html);
  while (match !== null) {
    pushText(html.slice(at, match.index));
    at = TAG.lastIndex;
    const [, closing, tag, attributes] = match;
    if (closing === "/") {
      const open = stack.pop();
      if (open === undefined || open.nodeName !== tag.toUpperCase() || stack.length === 0) {
        throw new Error(`unbalanced close tag ${tag} in ${html}`);
      }
    } else {
      const node = element(tag, attributes);
      stack[stack.length - 1].childNodes.push(node);
      if (!VOID_TAGS.has(node.nodeName)) stack.push(node);
    }
    match = TAG.exec(html);
  }
  pushText(html.slice(at));
  if (stack.length !== 1) throw new Error(`unclosed element in ${html}`);
  return root;
}

/**
 * The move `moveBlockRun` performs, on the tree above.
 *
 * It is the same three steps in the same order — group the root's children into
 * blocks, ask `blockRunAnchor` which child the run is put back before, lift the
 * whole run out and insert it there — so what is asserted below is the grouping
 * and the arithmetic the surface really uses, with only `insertBefore` swapped
 * for splicing an array. The anchor is resolved *before* the lift here for the
 * same reason it is there: after the lift it could be a node that is gone.
 */
function moveRunUnits(root: SurfaceNode, from: number, count: number, to: number): boolean {
  const units = blockUnits(root.childNodes);
  const anchor = blockRunAnchor(units.length, from, count, to);
  if (anchor === null) return false;
  const target = units[anchor.unit];
  const last = target[target.length - 1];
  // `nextSibling`, which the tree above does not carry.
  const after = root.childNodes[root.childNodes.indexOf(last) + 1];
  const marker = anchor.side === "before" ? target[0] : (after ?? null);

  const moving: SurfaceNode[] = [];
  for (let i = from; i < from + count; i += 1) moving.push(...units[i]);
  const rest = root.childNodes.filter((child) => !moving.includes(child));
  const at = marker === null ? rest.length : rest.indexOf(marker);
  root.childNodes = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  return true;
}

/**
 * `moveBlock`'s move: one block is a run of one, and it delegates exactly as
 * the module does — so the two callers cannot drift apart in the test either.
 */
function moveUnit(root: SurfaceNode, index: number, direction: VeMoveDirection): boolean {
  const units = blockUnits(root.childNodes);
  const to = blockMoveTarget(units.length, index, direction);
  if (to === null) return false;
  return moveRunUnits(root, index, 1, direction === "up" ? to : to + 1);
}

/** Open the article in visual mode, move one block, publish (§4). */
function publishAfterMove(wikitext: string, index: number, direction: VeMoveDirection): string {
  const doc = parseDocument(wikitext);
  const root = surface(documentToHtml(doc));
  expect(moveUnit(root, index, direction)).toBe(true);
  return serializeDocument(domToDocument(root, doc, createIdFactory("n")));
}

/* ---------------------------------------------------------------- */
/* blockUnits — which of the root's children are one block           */
/* ---------------------------------------------------------------- */

describe("blockUnits", () => {
  it("gives each ordinary block a unit of its own", () => {
    const children = [
      element("p", ' data-ve="p" data-ve-id="b0"'),
      element("h2", ' data-ve="h" data-ve-id="b1"'),
      element("div", ' data-ve="atomic" data-ve-id="b2" data-ve-src="{{X}}"'),
    ];
    expect(blockUnits(children).map((unit) => unit.length)).toEqual([1, 1, 1]);
  });

  it("keeps a mixed list's sibling roots in ONE unit", () => {
    // `*` then `#` at depth 0 closes one list and opens another (dom.ts
    // `listToHtml`); only the first carries the id, and the reader rejoins the
    // rest. Moving the `<ul>` alone would leave the `<ol>` behind — two lists
    // published where the author wrote one.
    const children = [
      element("ul", ' data-ve="list" data-ve-id="b0"'),
      element("ol"),
      element("p", ' data-ve="p" data-ve-id="b1"'),
    ];
    const units = blockUnits(children);
    expect(units).toHaveLength(2);
    expect(units[0].map((node) => node.nodeName)).toEqual(["UL", "OL"]);
  });

  it("does not absorb a list that carries an id of its own", () => {
    // Two lists with a blank line between them are two blocks, and
    // `data-ve-id` is the only thing in the markup that says so.
    const children = [
      element("ul", ' data-ve="list" data-ve-id="b0"'),
      element("ul", ' data-ve="list" data-ve-id="b1"'),
    ];
    expect(blockUnits(children)).toHaveLength(2);
  });

  it("keeps a run together across the whitespace between its roots", () => {
    const children = [
      element("ul", ' data-ve="list" data-ve-id="b0"'),
      textNode("\n  "),
      element("ol"),
    ];
    expect(blockUnits(children)).toHaveLength(1);
  });

  it("leaves whitespace out of every unit, so a move steps over it", () => {
    const children = [
      textNode("\n"),
      element("p", ' data-ve="p" data-ve-id="b0"'),
      textNode("  "),
      element("p", ' data-ve="p" data-ve-id="b1"'),
    ];
    const units = blockUnits(children);
    expect(units).toHaveLength(2);
    for (const unit of units) expect(unit.every((node) => node.nodeType === 1)).toBe(true);
  });

  it("makes a unit of bare text, which the reader turns into a paragraph", () => {
    const children = [textNode("loose words"), element("p", ' data-ve-id="b0"')];
    const units = blockUnits(children);
    expect(units).toHaveLength(2);
    expect(units[0][0].nodeValue).toBe("loose words");
  });

  it("ignores what the reader ignores, so nothing invisible can be swapped", () => {
    const comment: VeDomNode = {
      nodeType: 8,
      nodeName: "#comment",
      nodeValue: " note ",
      childNodes: [],
    };
    expect(blockUnits([comment, element("p", ' data-ve-id="b0"')])).toHaveLength(1);
  });

  it("has an answer for a root with nothing in it", () => {
    expect(blockUnits([])).toEqual([]);
  });
});

/* ---------------------------------------------------------------- */
/* Moving a block keeps its bytes (§3.1 over §4)                     */
/* ---------------------------------------------------------------- */

/**
 * A page whose every gap is a blank line, so the expectation for a swap can be
 * written down exactly: the same sources, joined the same way, in a new order.
 *
 * Three of them are chosen because a canonical rewrite *would* change them,
 * which is what makes them proof that the move re-parented the block rather
 * than rebuilding it: `==Layout==` is unspaced where `serializeBlock` writes
 * `== Layout ==`, the last paragraph is two lines where the model holds one,
 * and `[[Mansion|Mansion]]` carries a pipe the serializer drops.
 */
const SOURCES: readonly string[] = [
  "68-Artifice is a moon with a difficulty rating of '''S'''.",
  "== Interior ==",
  "The [[Mansion|Mansion]] interior is the most common one here.",
  "* Main entrance\n* Fire exit",
  "{{Infobox moon|cost=1500}}",
  "==Layout==",
  "----",
  "The quota resets\nevery three days.",
];

const ARTICLE = `${SOURCES.join("\n\n")}\n`;

function reordered(from: number, to: number): string {
  const order = [...SOURCES];
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  return `${order.join("\n\n")}\n`;
}

describe("moving a block through the surface", () => {
  it("publishes an untouched page byte for byte (the control)", () => {
    const doc = parseDocument(ARTICLE);
    const root = surface(documentToHtml(doc));
    expect(serializeDocument(domToDocument(root, doc, createIdFactory("n")))).toBe(ARTICLE);
  });

  it("republishes every block byte-identical, only in a new order", () => {
    // The claim §3.1 makes over §4, asserted for every block of the article in
    // both directions. The three blocks a canonical rewrite would reformat are
    // what make it a claim about bytes rather than about text.
    for (let index = 0; index < SOURCES.length; index += 1) {
      if (index + 1 < SOURCES.length) {
        expect(publishAfterMove(ARTICLE, index, "down")).toBe(reordered(index, index + 1));
      }
      if (index > 0) {
        expect(publishAfterMove(ARTICLE, index, "up")).toBe(reordered(index, index - 1));
      }
    }
  });

  it("keeps the unspaced heading unspaced after it has been moved", () => {
    // Spelled out because it is the failure the `source` rule exists to
    // prevent: a move that rebuilt the block would publish `== Layout ==`,
    // rewriting a line the author never touched.
    const moved = publishAfterMove(ARTICLE, 5, "up");
    expect(moved).toContain("==Layout==");
    expect(moved).not.toContain("== Layout ==");
  });

  it("keeps a moved paragraph's own line breaks", () => {
    expect(publishAfterMove(ARTICLE, 7, "up")).toContain(
      "The quota resets\nevery three days.",
    );
  });

  it("carries a mixed list's second root along with its first", () => {
    // `*` then `#` writes two sibling roots for one block. Moving only the
    // element under the handle would publish the numbered half where it lay.
    const sources = ["Intro.", "* bullet\n# number", "Outro."];
    const page = `${sources.join("\n\n")}\n`;
    expect(publishAfterMove(page, 1, "up")).toBe(
      `${[sources[1], sources[0], sources[2]].join("\n\n")}\n`,
    );
  });

  it("refuses the move at either end rather than wrapping around", () => {
    const doc = parseDocument(ARTICLE);
    const root = surface(documentToHtml(doc));
    expect(moveUnit(root, 0, "up")).toBe(false);
    expect(moveUnit(root, SOURCES.length - 1, "down")).toBe(false);
    // And the document is exactly as it was, not merely still valid.
    expect(serializeDocument(domToDocument(root, doc, createIdFactory("n")))).toBe(ARTICLE);
  });

  it("returns a moved block where it came from", () => {
    const doc = parseDocument(ARTICLE);
    const root = surface(documentToHtml(doc));
    expect(moveUnit(root, 3, "down")).toBe(true);
    expect(moveUnit(root, 4, "up")).toBe(true);
    expect(serializeDocument(domToDocument(root, doc, createIdFactory("n")))).toBe(ARTICLE);
  });
});

/* ---------------------------------------------------------------- */
/* blockRunAnchor — where a run of blocks is put back                */
/* ---------------------------------------------------------------- */

describe("blockRunAnchor", () => {
  it("puts a rising run before the block it lands on", () => {
    expect(blockRunAnchor(6, 3, 2, 1)).toEqual({ side: "before", unit: 1 });
  });

  it("puts a falling run after the block before its destination", () => {
    // Falling, "before unit 5" has to be expressed as "after unit 4": the
    // fragment goes in at that block's next sibling, which is the only node
    // the lift is guaranteed not to have taken away.
    expect(blockRunAnchor(6, 0, 2, 5)).toEqual({ side: "after", unit: 4 });
  });

  it("lands a run at the very end of the document", () => {
    expect(blockRunAnchor(4, 0, 1, 4)).toEqual({ side: "after", unit: 3 });
  });

  it("lands a run at the very front", () => {
    expect(blockRunAnchor(4, 2, 2, 0)).toEqual({ side: "before", unit: 0 });
  });

  it("refuses a destination inside the run — the anchor would be lifted out", () => {
    expect(blockRunAnchor(6, 1, 3, 2)).toBeNull();
    expect(blockRunAnchor(6, 1, 3, 3)).toBeNull();
  });

  it("refuses either edge of the run, which is where it already is", () => {
    expect(blockRunAnchor(6, 1, 3, 1)).toBeNull();
    expect(blockRunAnchor(6, 1, 3, 4)).toBeNull();
  });

  it("refuses a run the document does not hold", () => {
    expect(blockRunAnchor(3, 2, 3, 0)).toBeNull();
    expect(blockRunAnchor(3, -1, 1, 2)).toBeNull();
    expect(blockRunAnchor(3, 0, 0, 2)).toBeNull();
    expect(blockRunAnchor(3, 0, 1, 9)).toBeNull();
    expect(blockRunAnchor(3, 0, 1, -1)).toBeNull();
    expect(blockRunAnchor(3, 1.5, 1, 0)).toBeNull();
  });

  it("agrees with blockMoveTarget for a run of one", () => {
    // `moveBlock` delegates to the run mover, so the two have to describe the
    // same move: from `i`, up is "before i-1" and down is "after i+1".
    for (let index = 0; index < 5; index += 1) {
      const up = blockMoveTarget(5, index, "up");
      expect(blockRunAnchor(5, index, 1, up === null ? index : up)).toEqual(
        up === null ? null : { side: "before", unit: index - 1 },
      );
      const down = blockMoveTarget(5, index, "down");
      expect(blockRunAnchor(5, index, 1, down === null ? index : down + 1)).toEqual(
        down === null ? null : { side: "after", unit: index + 1 },
      );
    }
  });
});

/* ---------------------------------------------------------------- */
/* Moving a whole section keeps its bytes (§10.1 over §4)            */
/* ---------------------------------------------------------------- */

/**
 * An article with sections in it, written so that a canonical rewrite would be
 * visible: `===Layout===` is unspaced, the Overview paragraph is two lines, and
 * `[[Mansion|Mansion]]` carries a pipe the serializer drops. If a section move
 * rebuilt any block instead of re-parenting it, one of the three would change
 * and the page would still look right on screen.
 */
const SECTIONED: readonly string[] = [
  "68-Artifice is a moon with a difficulty rating of '''S'''.",
  "== Overview ==",
  "The quota resets\nevery three days.",
  "===Layout===",
  "* Main entrance\n* Fire exit",
  "== Strategy ==",
  "{{Infobox moon|cost=1500}}",
  "The [[Mansion|Mansion]] interior is the most common one here.",
];

const SECTIONED_ARTICLE = `${SECTIONED.join("\n\n")}\n`;

/** Open the article in visual mode, move one whole section, publish (§4). */
function publishAfterSectionMove(
  wikitext: string,
  headingIndex: number,
  direction: OutlineMoveDirection,
): string {
  const { headings, blockCount } = documentOutline(wikitext);
  const plan = sectionMovePlan(headings, headingIndex, direction, blockCount);
  expect(plan).not.toBeNull();
  if (plan === null) return wikitext;

  const doc = parseDocument(wikitext);
  const root = surface(documentToHtml(doc));
  expect(moveRunUnits(root, plan.from, plan.count, plan.to)).toBe(true);
  const published = serializeDocument(domToDocument(root, doc, createIdFactory("n")));

  // The two movers must agree. Source mode reorders the model and the visual
  // surface re-parents elements; a section that came out different depending on
  // which mode the author happened to be in would be a bug nobody could see
  // until they switched.
  expect(published).toBe(applySectionMove(wikitext, plan));
  return published;
}

describe("moving a section through the surface", () => {
  const swapped = `${[SECTIONED[0], ...SECTIONED.slice(5), ...SECTIONED.slice(1, 5)].join("\n\n")}\n`;

  it("takes the heading and everything under it, and nothing else", () => {
    // Overview owns its body, `===Layout===` and Layout's list. The lead stays
    // where it is, because the lead is in no section at all.
    expect(publishAfterSectionMove(SECTIONED_ARTICLE, 0, "down")).toBe(swapped);
  });

  it("reaches the same arrangement from the other end", () => {
    expect(publishAfterSectionMove(SECTIONED_ARTICLE, 2, "up")).toBe(swapped);
  });

  it("republishes every block byte-identical, including the ones a rewrite would reformat", () => {
    const moved = publishAfterSectionMove(SECTIONED_ARTICLE, 0, "down");
    expect(moved).toContain("===Layout===");
    expect(moved).not.toContain("=== Layout ===");
    expect(moved).toContain("The quota resets\nevery three days.");
    expect(moved).toContain("[[Mansion|Mansion]]");
  });

  it("swaps two subsections without disturbing their parent", () => {
    const sources = [
      "== A ==",
      "A body.",
      "=== A1 ===",
      "A1 body.",
      "=== A2 ===",
      "A2 body.",
      "== B ==",
    ];
    const page = `${sources.join("\n\n")}\n`;
    const order = [0, 1, 4, 5, 2, 3, 6];
    expect(publishAfterSectionMove(page, 1, "down")).toBe(
      `${order.map((i) => sources[i]).join("\n\n")}\n`,
    );
  });

  it("carries a mixed list's second root along with the section holding it", () => {
    // `*` then `#` writes two sibling roots for one block (§3). A run move that
    // counted elements rather than blocks would leave the numbered half behind.
    const sources = ["== A ==", "* bullet\n# number", "== B ==", "B body."];
    const page = `${sources.join("\n\n")}\n`;
    expect(publishAfterSectionMove(page, 0, "down")).toBe(
      `${[sources[2], sources[3], sources[0], sources[1]].join("\n\n")}\n`,
    );
  });

  it("returns a section where it came from", () => {
    const doc = parseDocument(SECTIONED_ARTICLE);
    const root = surface(documentToHtml(doc));
    const first = documentOutline(SECTIONED_ARTICLE);

    const down = sectionMovePlan(first.headings, 0, "down", first.blockCount);
    expect(down).not.toBeNull();
    if (down !== null) expect(moveRunUnits(root, down.from, down.count, down.to)).toBe(true);

    // The article is Strategy, then Overview now, so Overview is the second row
    // and rises from where it landed.
    const after = documentOutline(swapped);
    const back = sectionMovePlan(after.headings, 1, "up", after.blockCount);
    expect(back).not.toBeNull();
    if (back !== null) expect(moveRunUnits(root, back.from, back.count, back.to)).toBe(true);

    expect(serializeDocument(domToDocument(root, doc, createIdFactory("n")))).toBe(
      SECTIONED_ARTICLE,
    );
  });

  it("refuses a plan the surface does not fit, rather than moving the wrong blocks", () => {
    const doc = parseDocument(SECTIONED_ARTICLE);
    const root = surface(documentToHtml(doc));
    // A run reaching past the end of the document is not a run this surface
    // holds; nothing moves, and the article is exactly as it was.
    expect(moveRunUnits(root, 6, 4, 0)).toBe(false);
    expect(serializeDocument(domToDocument(root, doc, createIdFactory("n")))).toBe(
      SECTIONED_ARTICLE,
    );
  });
});

/* ---------------------------------------------------------------- */
/* neighbourIndex — the chip a Backspace eats (section 5)            */
/* ---------------------------------------------------------------- */

/** A text node with `text` in it, and an element, in the shape the walk reads. */
const txt = (text: string) => ({ nodeType: 3, nodeValue: text });
const el = () => ({ nodeType: 1, nodeValue: null });
/** The surface's own spacer, and a break the author typed — one is skipped. */
const filler = () => ({
  nodeType: 1,
  nodeValue: null,
  getAttribute: (name: string) => (name === "data-ve-filler" ? "" : null),
});
const br = () => ({ nodeType: 1, nodeValue: null, getAttribute: () => null });

describe("neighbourIndex", () => {
  it("looks behind the caret for Backspace and in front of it for Delete", () => {
    // The off-by-one that is the whole of it: going back the node is at
    // `offset - 1`, going forward it is at `offset` itself.
    const children = [el(), el(), el()];
    expect(neighbourIndex(children, 1, -1)).toBe(0);
    expect(neighbourIndex(children, 1, 1)).toBe(1);
  });

  it("has nothing behind the start, or in front of the end", () => {
    const children = [el(), el()];
    expect(neighbourIndex(children, 0, -1)).toBe(-1);
    expect(neighbourIndex(children, 2, 1)).toBe(-1);
  });

  it("steps over a caret holder, which is markup and not a character", () => {
    // What a click beside a chip parks (`caretHolderAt`), and the reason the
    // author's first Backspace looked like nothing at all: the holder stood
    // between the caret and the chip, and a walk that counted it deleted a
    // character nobody can see.
    const holder = txt("​");
    expect(neighbourIndex([el(), holder], 2, -1)).toBe(0);
    expect(neighbourIndex([holder, el()], 0, 1)).toBe(1);
    // A holder beside a real character still stops at the character.
    expect(neighbourIndex([el(), txt("​a")], 2, -1)).toBe(1);
  });

  it("steps over the empty text nodes a browser leaves beside a chip", () => {
    // This is the case that made "Backspace does nothing" — a
    // `contenteditable="false"` node is typed beside, and the engine leaves an
    // empty text node between it and the caret.
    const children = [el(), txt(""), txt("")];
    expect(neighbourIndex(children, 3, -1)).toBe(0);
    expect(neighbourIndex([txt(""), txt(""), el()], 0, 1)).toBe(2);
  });

  it("stops at a text node that actually holds something", () => {
    // A character beside the caret is a character the delete is about, and
    // stepping past it would eat a chip the author was nowhere near.
    expect(neighbourIndex([el(), txt("a")], 2, -1)).toBe(1);
    expect(neighbourIndex([txt("a"), el()], 0, 1)).toBe(0);
  });

  it("steps over the filler <br> an empty line is given its height with", () => {
    // The surface's own markup (`newParagraph`, dom.ts), and it stands in
    // every empty paragraph — including the one an author lands in under a
    // table. The first Backspace used to be spent on it and the table only
    // went on the second (user report, 2026-09-06).
    expect(neighbourIndex([el(), filler()], 2, -1)).toBe(0);
    expect(neighbourIndex([filler(), el()], 0, 1)).toBe(1);
  });

  it("stops at a <br> the author put there", () => {
    // An unlabelled break is a line somebody typed with Shift+Enter, and a
    // Backspace beside it is about that line, not about the block above.
    expect(neighbourIndex([el(), br()], 2, -1)).toBe(1);
  });

  it("has no answer inside an empty container", () => {
    expect(neighbourIndex([], 0, -1)).toBe(-1);
    expect(neighbourIndex([], 0, 1)).toBe(-1);
  });

  it("survives an offset past the children it was given", () => {
    // A caret read a moment after the markup under it changed; degrade, never
    // throw, is this module's house rule.
    expect(neighbourIndex([el()], 99, -1)).toBe(-1);
    expect(neighbourIndex([el()], 99, 1)).toBe(-1);
  });
});

/* ---------------------------------------------------------------- */
/* atomicBeside — the chip a Backspace reaches (section 5)           */
/* ---------------------------------------------------------------- */

/**
 * A tree the walk can be asked about. Real DOM nodes satisfy `VeWalkNode`
 * structurally, so these stand in for them exactly — which is the point of the
 * interface: vitest runs in node here, and this walk is the sort that looks
 * right and does nothing.
 */
interface FakeNode extends VeWalkNode {
  name: string;
  nodeType: number;
  nodeValue: string | null;
  childNodes: FakeNode[];
  parentNode: FakeNode | null;
  atomic: boolean;
}

function fake(
  name: string,
  options: { text?: string; atomic?: boolean; children?: FakeNode[] } = {},
): FakeNode {
  const built: FakeNode = {
    name,
    nodeType: options.text === undefined ? 1 : 3,
    nodeValue: options.text ?? null,
    childNodes: options.children ?? [],
    parentNode: null,
    atomic: options.atomic === true,
  };
  for (const child of built.childNodes) child.parentNode = built;
  return built;
}

/** A chip as the surface draws one: `[data-ve-src]` around a rendered body. */
function chip(name: string, body = "x"): FakeNode {
  return fake(name, { atomic: true, children: [fake(`${name}-body`, { text: body })] });
}

const isAtomic = (candidate: VeWalkNode): boolean => (candidate as FakeNode).atomic;

/** What the walk finds, by name, from a caret at `(container, offset)`. */
function beside(
  host: FakeNode,
  container: FakeNode,
  offset: number,
  direction: -1 | 1,
): string | null {
  const found = atomicBeside(host, container, offset, direction, isAtomic);
  return found === null ? null : (found as FakeNode).name;
}

describe("atomicBeside", () => {
  it("finds the chip behind a caret reported as an index in the cell", () => {
    // The reported case: a table cell holding two chips and a caret between
    // them. Chrome reports `(cell, 1)`.
    const first = chip("first", "aaa");
    const second = chip("second", "");
    const cell = fake("td", { children: [first, second] });
    expect(beside(cell, cell, 1, -1)).toBe("first");
    expect(beside(cell, cell, 1, 1)).toBe("second");
  });

  it("finds the chip a click's caret holder is standing in front of", () => {
    // The author's own cell: two version chips and nothing else, so the only
    // way to get a caret there is the click that parks a `​` — and the
    // caret then sits *inside* that holder, at offset 1. Read as a character,
    // it hid the chip behind it and the press was spent on the invisible.
    const first = chip("first", "aaa");
    const holder = fake("#text", { text: "​" });
    const second = chip("second", "");
    const cell = fake("td", { children: [first, holder, second] });
    expect(beside(cell, holder, 1, -1)).toBe("first");
    expect(beside(cell, holder, 0, 1)).toBe("second");
    // And a caret behind a real character is still about that character.
    const typed = fake("#text", { text: "a" });
    const other = fake("td", { children: [chip("chip"), typed] });
    expect(beside(other, typed, 1, -1)).toBeNull();
  });

  it("finds it across the empty text node a browser leaves between them", () => {
    // The same caret, reported by an engine that invented a text node for it —
    // and the reason the first attempt at this went on doing nothing.
    const first = chip("first", "aaa");
    const filler = fake("#text", { text: "" });
    const second = chip("second", "");
    const cell = fake("td", { children: [first, filler, second] });
    expect(beside(cell, filler, 0, -1)).toBe("first");
    expect(beside(cell, filler, 0, 1)).toBe("second");
    expect(beside(cell, cell, 2, -1)).toBe("first");
  });

  it("finds it from a caret inside the chip's own rendered preview", () => {
    // A click can land there: the preview is real markup, it simply is not
    // editable. The chip is plainly what the key is about.
    const first = chip("first", "aaa");
    const cell = fake("td", { children: [first] });
    expect(beside(cell, first.childNodes[0], 1, -1)).toBe("first");
    expect(beside(cell, first, 0, 1)).toBe("first");
  });

  it("leaves a real character alone", () => {
    // A caret with text on the side it is deleting towards is deleting one of
    // those characters, and eating the chip past them would be a rout.
    const first = chip("first", "aaa");
    const text = fake("#text", { text: "hi" });
    const cell = fake("td", { children: [first, text] });
    expect(beside(cell, text, 2, -1)).toBeNull();
    expect(beside(cell, text, 1, -1)).toBeNull();
    // …but at the very edge of that text, the chip is next.
    expect(beside(cell, text, 0, -1)).toBe("first");
  });

  it("steps out of an inline wrapper the caret is sitting at the edge of", () => {
    const first = chip("first", "aaa");
    const inner = fake("#text", { text: "b" });
    const bold = fake("b", { children: [inner] });
    const cell = fake("td", { children: [first, bold] });
    expect(beside(cell, inner, 0, -1)).toBe("first");
  });

  it("steps into one that holds the chip at its own edge", () => {
    const first = chip("first", "aaa");
    const bold = fake("b", { children: [first] });
    const text = fake("#text", { text: "z" });
    const cell = fake("td", { children: [bold, text] });
    expect(beside(cell, text, 0, -1)).toBe("first");
  });

  it("stops at the host — a cell does not reach into the cell before it", () => {
    // Backspace at the very start of a cell must not delete something the
    // author cannot even see the caret next to.
    const previous = chip("previous", "aaa");
    const cellA = fake("td", { children: [previous] });
    const text = fake("#text", { text: "b" });
    const cellB = fake("td", { children: [text] });
    const row = fake("tr", { children: [cellA, cellB] });
    expect(row.childNodes.length).toBe(2);
    expect(beside(cellB, text, 0, -1)).toBeNull();
    expect(beside(cellB, cellB, 0, -1)).toBeNull();
  });

  it("has nothing to find where there is no chip", () => {
    const text = fake("#text", { text: "plain" });
    const cell = fake("td", { children: [text] });
    expect(beside(cell, text, 0, -1)).toBeNull();
    expect(beside(cell, text, 5, 1)).toBeNull();
  });

  it("finds a chip that is the only thing in the cell, from either side", () => {
    const only = chip("only", "aaa");
    const cell = fake("td", { children: [only] });
    expect(beside(cell, cell, 1, -1)).toBe("only");
    expect(beside(cell, cell, 0, 1)).toBe("only");
  });
});

describe("atomicBeside, past the caret's own block", () => {
  /** The same walk, told it may look one step out of an ordinary block. */
  function past(
    outer: FakeNode,
    host: FakeNode,
    container: FakeNode,
    offset: number,
    direction: -1 | 1,
  ): string | null {
    const found = atomicBeside(host, container, offset, direction, isAtomic, outer);
    return found === null ? null : (found as FakeNode).name;
  }

  it("deletes the chip standing as the block above", () => {
    // A caret at the start of a line with a chip above it is the one shape
    // where every editor reaches out (user report: "other blocks are not
    // deleted").
    const block = chip("template");
    const text = fake("#text", { text: "hello" });
    const para = fake("p", { children: [text] });
    const root = fake("root", { children: [block, para] });
    expect(past(root, para, text, 0, -1)).toBe("template");
    expect(past(root, para, para, 0, -1)).toBe("template");
  });

  it("and the one standing below it, going forward", () => {
    const text = fake("#text", { text: "hello" });
    const para = fake("p", { children: [text] });
    const block = chip("gallery");
    const root = fake("root", { children: [para, block] });
    expect(past(root, para, text, 5, 1)).toBe("gallery");
  });

  it("merges with a paragraph rather than reaching into it", () => {
    // Backspace at the start of a line means "join these two lines" wherever
    // the thing above is text, and the browser is left to do exactly that.
    const above = fake("p", { children: [fake("#text", { text: "above" })] });
    const text = fake("#text", { text: "hello" });
    const para = fake("p", { children: [text] });
    const root = fake("root", { children: [above, para] });
    expect(past(root, para, text, 0, -1)).toBeNull();
  });

  it("does not reach inside the block above for a chip at its end", () => {
    // The neighbour has to *be* a chip. Descending would eat a picture out of
    // the end of the paragraph above instead of joining the two lines.
    const inline = chip("picture");
    const above = fake("p", { children: [fake("#text", { text: "see " }), inline] });
    const text = fake("#text", { text: "hello" });
    const para = fake("p", { children: [text] });
    const root = fake("root", { children: [above, para] });
    expect(past(root, para, text, 0, -1)).toBeNull();
  });

  it("keeps a cell's walls even when it is told about the outside", () => {
    // The surface passes no `outer` for a cell at all; this is the belt as well
    // as the braces, because reaching out of one is never right.
    const previous = chip("previous");
    const cellA = fake("td", { children: [previous] });
    const text = fake("#text", { text: "b" });
    const cellB = fake("td", { children: [text] });
    const row = fake("tr", { children: [cellA, cellB] });
    expect(past(row, cellB, text, 0, -1)).toBeNull();
  });

  it("reaches nowhere when it was told of no outside", () => {
    const block = chip("template");
    const text = fake("#text", { text: "hello" });
    const para = fake("p", { children: [text] });
    fake("root", { children: [block, para] });
    expect(beside(para, text, 0, -1)).toBeNull();
  });
});

/* ---------------------------------------------------------------- */
/* lineTextOf — what has been typed on the caret's line              */
/* ---------------------------------------------------------------- */

/**
 * The reading behind `/`, `[[`, `@`, `{{` and every input rule. It went wrong
 * in the one way a string-building walk goes wrong: it read two visual lines as
 * one, with nothing between them. An author who pressed Enter in a table cell
 * and typed "/" on the second line got `"first line/"`, where the slash is
 * mid-word — so `slashContext` refused it and the menu never opened.
 */

/** A node of the line, with the `getAttribute` a chip is recognised by. */
function lineNode(
  name: string,
  options: { text?: string; src?: string; children?: LineFake[] } = {},
): LineFake {
  return {
    nodeName: name,
    nodeType: options.text === undefined ? 1 : 3,
    nodeValue: options.text ?? null,
    childNodes: options.children ?? [],
    getAttribute: (attribute: string) =>
      attribute === "data-ve-src" ? (options.src ?? null) : null,
  };
}

interface LineFake extends VeLineNode {
  nodeName: string;
  nodeType: number;
  nodeValue: string | null;
  childNodes: LineFake[];
}

const text = (value: string): LineFake => lineNode("#text", { text: value });

describe("lineTextOf", () => {
  it("reads a plain line, and puts the caret where the offset says", () => {
    const word = text("hello");
    const para = lineNode("P", { children: [word] });
    const reading = lineTextOf(para, word, 3);
    expect(reading?.text).toBe("hello");
    expect(reading?.offset).toBe(3);
  });

  it("ends the line at a <br>, so a slash after one starts a line", () => {
    // Shift+Enter in a paragraph, then "/". Without the break this read
    // "first/", where the slash is inside a word and opens nothing.
    const first = text("first");
    const typed = text("/");
    const para = lineNode("P", { children: [first, lineNode("BR"), typed] });
    const reading = lineTextOf(para, typed, 1);
    expect(reading?.text).toBe("first\n/");
    expect(reading?.text.slice(0, reading.offset)).toBe("first\n/");
  });

  it("ends it at the wrapper a browser makes of Enter in a cell", () => {
    // What Chrome leaves behind in a `<td>`: two `<div>`s where there was one
    // run of text. The model folds them to one line (dom.ts) and so does the
    // author's eye see two — either way the second one starts a line.
    const typed = text("/tab");
    const cell = lineNode("TD", {
      children: [
        lineNode("DIV", { children: [text("counts")] }),
        lineNode("DIV", { children: [typed] }),
      ],
    });
    const reading = lineTextOf(cell, typed, 4);
    // A wrapper is a line whether or not anything follows it, so the last one
    // is ended too. Only what is *before* the caret is ever read, and the
    // trailing break is behind it.
    expect(reading?.text).toBe("counts\n/tab\n");
    expect(reading?.offset).toBe(11);
    expect(reading?.text.slice(0, reading.offset)).toBe("counts\n/tab");
  });

  it("writes one break for a run of them, and never one at the start", () => {
    // A leading "\n" would shift every offset by one against a line that has
    // no character before the caret at all.
    const typed = text("x");
    const cell = lineNode("TD", {
      children: [lineNode("BR"), lineNode("DIV", { children: [text("a")] }), lineNode("BR"), typed],
    });
    const reading = lineTextOf(cell, typed, 1);
    expect(reading?.text).toBe("a\nx");
  });

  it("places a caret standing on an element, which is where an empty line has it", () => {
    // Enter in a cell, or any empty line: the caret is `(div, 0)` and there is
    // no text node to be inside. This used to give up and answer null, and
    // every reading that depends on it did nothing.
    const second = lineNode("DIV", { children: [] });
    const cell = lineNode("TD", {
      children: [lineNode("DIV", { children: [text("counts")] }), second],
    });
    const reading = lineTextOf(cell, second, 0);
    expect(reading?.text).toBe("counts\n");
    expect(reading?.offset).toBe(7);
  });

  it("places a caret reported as an index among the host's children", () => {
    const chipNode = lineNode("SPAN", { src: "{{Infobox}}", children: [text("Infobox")] });
    const word = text("see ");
    const para = lineNode("P", { children: [word, chipNode] });
    // (p, 2) — the caret after the chip, which is how Chrome reports it.
    expect(lineTextOf(para, para, 2)?.offset).toBe(4);
    expect(lineTextOf(para, para, 1)?.offset).toBe(4);
  });

  it("walks past a chip whole, and reads none of its rendered body", () => {
    // A chip's preview is the engine's drawing of somebody's wikitext (§5).
    // Reading its words would put text on the line that the author cannot see
    // the caret move through — and could hide the slash they just typed.
    const chipNode = lineNode("SPAN", { src: "{{Infobox}}", children: [text("rendered words")] });
    const typed = text("/");
    const para = lineNode("P", { children: [chipNode, typed] });
    const reading = lineTextOf(para, typed, 1);
    expect(reading?.text).toBe("/");
    expect(reading?.offset).toBe(1);
  });

  it("reads nothing of the branch field's textarea", () => {
    // §6's in-place passage field is a form control that happens to live in
    // the markup; what is typed into it is not a line of the article.
    const field = lineNode("TEXTAREA", { children: [text("v70")] });
    const typed = text("body");
    const para = lineNode("P", { children: [field, typed] });
    expect(lineTextOf(para, typed, 4)?.text).toBe("body");
  });

  it("answers null for a caret in no line of this host", () => {
    // A caret inside a chip, which the walk skipped: there is no offset to
    // report, and guessing one would delete the wrong characters.
    const inside = text("rendered");
    const chipNode = lineNode("SPAN", { src: "{{X}}", children: [inside] });
    const para = lineNode("P", { children: [chipNode] });
    expect(lineTextOf(para, inside, 2)).toBeNull();
  });

  it("gives every piece the offset its text starts at", () => {
    // The pieces are what a Range boundary is rebuilt from, so a break has to
    // count as a character there too — an off-by-one here deletes a letter of
    // the author's instead of the marker they typed.
    const a = text("ab");
    const b = text("cd");
    const para = lineNode("P", { children: [a, lineNode("BR"), b] });
    const reading = lineTextOf(para, b, 2);
    expect(reading?.text).toBe("ab\ncd");
    expect(reading?.pieces.map((piece) => piece.start)).toEqual([0, 3]);
    expect(reading?.offset).toBe(5);
  });
});

describe("lineTextOf and the caret holder", () => {
  it("reads the surface's zero-width holder as a space", () => {
    // `caretHolderAt` (visual-editor.tsx) parks a U+200B where a click asks for
    // a position no text node holds — clicking the blank part of an empty line,
    // or of a table cell. The reader drops it (`withoutCaretHolders`), so it
    // never reaches the buffer; what it used to reach was this reading, where a
    // "/" typed straight after one looked like a slash inside a word and the
    // menu stayed shut (user report, 2026-09-06).
    const typed = text("​/tab");
    const para = lineNode("P", { children: [typed] });
    const reading = lineTextOf(para, typed, 4);
    expect(reading?.text).toBe(" /tab");
    // One character in, one character out: every offset stays where it was.
    expect(reading?.offset).toBe(4);
    expect(reading?.pieces[0].start).toBe(0);
  });
});
