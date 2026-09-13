/**
 * What the table controls decide, asked without a browser
 * (docs/engine/visual-editor.md §3 DOM mapping, §3.2 the controls, §4 the
 * round-trip guarantee; docs/engine/wikitext-spec.md §7 for the grammar).
 *
 * Three things are being pinned here, and they fail in three different ways.
 *
 * 1. **The walk agrees with the reader.** An index into a table only means
 *    anything against the model `domToDocument` builds out of the same markup,
 *    and `ve-table.ts` walks that markup a second time. A disagreement would
 *    not throw: it would delete the row below the one the author pointed at.
 *    So the agreement is asserted against `domToDocument` itself, over the
 *    shapes a browser actually leaves behind — an inserted `<tbody>`, a row
 *    left with no cells, a cell left outside a row.
 * 2. **Every operation is `table.ts`'s.** Each branch of `tableOpOutcome` is
 *    checked against the function it is supposed to call, so this module
 *    cannot quietly grow an arithmetic of its own.
 * 3. **§4 survives an edit.** The last section runs the real path — parse →
 *    `documentToHtml` → read → operate → `blockToHtml` → read → serialize —
 *    over an article whose other blocks a canonical rewrite *would* have
 *    reformatted, so "only the table changed" is a claim about bytes.
 */

import { describe, expect, it } from "vitest";

import { blockToHtml, documentToHtml, domToDocument, type VeDomNode } from "@/lib/visual-editor/dom";
import { createIdFactory, type VeTable } from "@/lib/visual-editor/model";
import { parseDocument } from "@/lib/visual-editor/parse";
import { serializeDocument } from "@/lib/visual-editor/serialize";
import {
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  removeColumn,
  removeRow,
  toggleHeaderRow,
} from "@/lib/visual-editor/table";
import type { VeTableOp } from "@/lib/visual-editor/actions";

import {
  TABLE_OPS,
  clampSpot,
  spotAfterOp,
  spotColumnCount,
  spotRowCount,
  tableCan,
  tableContextOf,
  tableOpLabel,
  tableOpOutcome,
  tableOpStartsGroup,
  tableRowsOf,
  tableSpotOf,
  tableTabStep,
  type VeTableLabels,
  type VeTableSpot,
} from "./ve-table";

/* ---------------------------------------------------------------- */
/* The surface — markup as the nodes both walks read                 */
/* ---------------------------------------------------------------- */

/**
 * The same bargain `ve-selection.test.ts` and `roundtrip.test.ts` make: vitest
 * runs in node, so there is no DOM, and one would only prove what a browser
 * does with the markup. This reads back the subset the writer emits — elements
 * with double-quoted attributes, void `<br>`/`<hr>`, the four entities
 * `escapeHtml` writes — and throws on anything else rather than guessing.
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
  return { nodeType: 3, nodeName: "#text", nodeValue: value, childNodes: [], getAttribute: () => null };
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

/** Plain text of a subtree — how a cell is named in the assertions below. */
function textOf(node: SurfaceNode): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  let out = "";
  for (const child of node.childNodes) out += textOf(child);
  return out;
}

function firstTable(root: SurfaceNode): SurfaceNode {
  for (const child of root.childNodes) if (child.nodeName === "TABLE") return child;
  throw new Error("no table in the surface");
}

/**
 * The cell whose text is `wanted` — the caret's cell, named by what is in it.
 *
 * A walk of its own rather than one over `tableRowsOf`: this is the fixture,
 * and a fixture built out of the function under test can only ever agree with
 * it.
 */
function cellNamed(node: SurfaceNode, wanted: string): SurfaceNode {
  const found = findCell(node, wanted);
  if (found === null) throw new Error(`no cell reading ${wanted}`);
  return found;
}

function findCell(node: SurfaceNode, wanted: string): SurfaceNode | null {
  for (const child of node.childNodes) {
    if (
      (child.nodeName === "TD" || child.nodeName === "TH") &&
      textOf(child).trim() === wanted
    ) {
      return child;
    }
    const deeper = findCell(child, wanted);
    if (deeper !== null) return deeper;
  }
  return null;
}

/* ---------------------------------------------------------------- */
/* The walk agrees with dom.ts's reader                              */
/* ---------------------------------------------------------------- */

/**
 * The three shapes a browser leaves behind that `collectRows` is tolerant of
 * (§3): the `<tbody>` it inserts around every row, a `<tr>` emptied by an edit,
 * and a `<td>` left outside a row. All three change what row an index means.
 */
const BROWSER_TABLE =
  '<table data-ve="table" data-ve-id="b0" data-ve-attrs="class=&quot;wikitable&quot;">' +
  '<tbody>' +
  '<tr data-ve-attrs=""><th data-ve="cell" data-ve-attrs="">Item</th><th data-ve="cell" data-ve-attrs="">Value</th></tr>' +
  '<tr data-ve-attrs=""></tr>' +
  '<tr data-ve-attrs=""><td data-ve="cell" data-ve-attrs="">Gold bar</td><td data-ve="cell" data-ve-attrs="">210</td></tr>' +
  '</tbody>' +
  '<td data-ve="cell" data-ve-attrs="">Adopted</td>' +
  "</table>";

describe("tableRowsOf / tableSpotOf, against domToDocument", () => {
  const root = surface(BROWSER_TABLE);
  const table = firstTable(root);
  const read = domToDocument(root, { leading: "", blocks: [] }, createIdFactory("n"));
  const block = read.blocks[0];

  it("reads the same rows the model does", () => {
    expect(block.kind).toBe("table");
    if (block.kind !== "table") return;
    const walked = tableRowsOf(table);
    // The emptied `<tr>` is a row to neither (spec §7.5), and the adopted `<td>`
    // is a row to both — so three rows, in the same order, with the same cells.
    expect(walked.length).toBe(block.rows.length);
    expect(walked.length).toBe(3);
    for (let row = 0; row < walked.length; row += 1) {
      expect(walked[row].length).toBe(block.rows[row].cells.length);
    }
  });

  it("names every cell the index the model would answer to", () => {
    if (block.kind !== "table") throw new Error("not a table");
    for (const [name, expected] of [
      ["Item", "Item"],
      ["Value", "Value"],
      ["Gold bar", "Gold bar"],
      ["210", "210"],
      ["Adopted", "Adopted"],
    ] as const) {
      const spot = tableSpotOf(table, cellNamed(table, name));
      expect(spot).not.toBeNull();
      if (spot === null) continue;
      const cell = block.rows[spot.row].cells[spot.column];
      expect(cell.children.map((child) => (child.kind === "text" ? child.text : "")).join("")).toBe(
        expected,
      );
    }
  });

  it("counts the header row as one, and only where every cell is a <th>", () => {
    const header = tableSpotOf(table, cellNamed(table, "Item"));
    const body = tableSpotOf(table, cellNamed(table, "Gold bar"));
    expect(header?.headerRow).toBe(true);
    expect(body?.headerRow).toBe(false);
  });

  it("has no spot for anything that is not a cell of this table", () => {
    expect(tableSpotOf(table, table)).toBeNull();
    expect(tableSpotOf(table, element("td"))).toBeNull();
  });

  it("does not walk into a table nested inside a cell", () => {
    // A table holding another refuses (spec §7.9), so the inner markup can only
    // have arrived by paste — and its cells belong to no row of the outer table,
    // which is the answer that keeps a control off them.
    const nested = surface(
      '<table data-ve="table" data-ve-id="b0"><tr><td data-ve="cell">outer' +
        "<table><tr><td>inner</td></tr></table>" +
        "</td></tr></table>",
    );
    const outer = firstTable(nested);
    const rows = tableRowsOf(outer);
    expect(rows.length).toBe(1);
    expect(rows[0].length).toBe(1);
    expect(tableSpotOf(outer, cellNamed(outer, "inner"))).toBeNull();
    // And the outer cell that HOLDS it is still the outer table's own.
    expect(tableSpotOf(outer, cellNamed(outer, "outerinner"))).toEqual({
      row: 0,
      column: 0,
      widths: [1],
      headerRow: false,
    });
  });
});

/* ---------------------------------------------------------------- */
/* Which controls are offered                                        */
/* ---------------------------------------------------------------- */

function spot(row: number, column: number, widths: number[], headerRow = false): VeTableSpot {
  return { row, column, widths, headerRow };
}

describe("tableCan", () => {
  it("refuses a move that lands nowhere, and nothing else", () => {
    const middle = tableCan(spot(1, 1, [3, 3, 3]));
    for (const op of TABLE_OPS) expect(middle[op]).toBe(true);

    const corner = tableCan(spot(0, 0, [3, 3, 3]));
    expect(corner.moveRowUp).toBe(false);
    expect(corner.moveColumnLeft).toBe(false);
    expect(corner.moveRowDown).toBe(true);
    expect(corner.moveColumnRight).toBe(true);

    const last = tableCan(spot(2, 2, [3, 3, 3]));
    expect(last.moveRowDown).toBe(false);
    expect(last.moveColumnRight).toBe(false);
  });

  it("offers the deletes that would take the whole table", () => {
    // A one-cell table can still be deleted a row at a time; what stands
    // between the click and the loss is the dialog, not a disabled button.
    const only = tableCan(spot(0, 0, [1]));
    expect(only.deleteRow).toBe(true);
    expect(only.deleteColumn).toBe(true);
    expect(only.deleteTable).toBe(true);
    expect(only.moveRowUp).toBe(false);
    expect(only.moveRowDown).toBe(false);
  });

  it("measures a column against the widest row, not the caret's own", () => {
    // Ragged rows: from the short row's last cell there IS a column to the
    // right — column 2 exists in the table, in another row.
    const ragged = spot(1, 0, [3, 1]);
    expect(spotRowCount(ragged)).toBe(2);
    expect(spotColumnCount(ragged)).toBe(3);
    expect(tableCan(ragged).moveColumnRight).toBe(true);
  });

  it("hands the toolbar the same answer it hands the strip", () => {
    const context = tableContextOf(spot(0, 0, [2, 2], true));
    expect(context.headerRow).toBe(true);
    expect(context.can).toEqual(tableCan(spot(0, 0, [2, 2], true)));
  });
});

/* ---------------------------------------------------------------- */
/* Every operation is table.ts's                                     */
/* ---------------------------------------------------------------- */

/** `| a || b` over two rows, the second of which is one cell short. */
function grid(): VeTable {
  const doc = parseDocument("{|\n|-\n! A !! B\n|-\n| c || d\n|-\n| e\n|}\n");
  const block = doc.blocks[0];
  if (block.kind !== "table") throw new Error("the fixture stopped parsing as a table");
  return block;
}

describe("tableOpOutcome", () => {
  const table = grid();
  const at = { row: 1, column: 1 };

  const expectTable = (op: VeTableOp, want: VeTable | null): void => {
    const outcome = tableOpOutcome(table, at, op);
    expect(outcome.kind).toBe("table");
    if (outcome.kind !== "table" || want === null) return;
    expect(outcome.table).toEqual(want);
  };

  it("delegates every insert and move to the pure operation", () => {
    expectTable("insertRowAbove", insertRow(table, 1, "above"));
    expectTable("insertRowBelow", insertRow(table, 1, "below"));
    expectTable("moveRowUp", moveRow(table, 1, 0));
    expectTable("moveRowDown", moveRow(table, 1, 2));
    expectTable("insertColumnLeft", insertColumn(table, 1, "left"));
    expectTable("insertColumnRight", insertColumn(table, 1, "right"));
    expectTable("moveColumnLeft", moveColumn(table, 1, 0));
    expectTable("deleteRow", removeRow(table, 1));
    expectTable("deleteColumn", removeColumn(table, 1));
    expectTable("toggleHeaderRow", toggleHeaderRow(table, 1));
  });

  it("calls the last row's removal a deletion of the table", () => {
    // Not an error and not an empty table: spec §7.5 renders nothing for a
    // table with no rows, and model.ts holds no such thing.
    const one = parseDocument("{|\n| only\n|}\n").blocks[0];
    if (one.kind !== "table") throw new Error("not a table");
    expect(tableOpOutcome(one, { row: 0, column: 0 }, "deleteRow")).toEqual({ kind: "delete" });
    expect(tableOpOutcome(one, { row: 0, column: 0 }, "deleteColumn")).toEqual({ kind: "delete" });
    expect(tableOpOutcome(one, { row: 0, column: 0 }, "deleteTable")).toEqual({ kind: "delete" });
  });

  it("says nothing happened rather than redrawing a table that did not change", () => {
    // Identity is the signal table.ts gives, and it is worth reading: a redraw
    // would cost the caret its place for an edit that never happened.
    expect(tableOpOutcome(table, { row: 0, column: 0 }, "moveRowUp")).toEqual({ kind: "none" });
    expect(tableOpOutcome(table, { row: 0, column: 0 }, "moveColumnLeft")).toEqual({ kind: "none" });
    expect(tableOpOutcome(table, { row: 9, column: 0 }, "insertRowAbove")).toEqual({ kind: "none" });
  });

  it("names the header refusal apart from doing nothing", () => {
    // A data cell holding `!!` would become two header cells (spec §7.3), so
    // `toggleHeaderRow` refuses — and an author who pressed a button is owed
    // the reason rather than a control that visibly does not work.
    const risky = parseDocument("{|\n| a !! b || c\n|}\n").blocks[0];
    if (risky.kind !== "table") throw new Error("not a table");
    expect(toggleHeaderRow(risky, 0)).toBe(risky);
    expect(tableOpOutcome(risky, { row: 0, column: 0 }, "toggleHeaderRow")).toEqual({
      kind: "refused",
    });
    // A row that is not there is not a refusal; there was nothing to refuse.
    expect(tableOpOutcome(risky, { row: 4, column: 0 }, "toggleHeaderRow")).toEqual({
      kind: "none",
    });
  });

  it("leaves the row the caret is not in alone", () => {
    const outcome = tableOpOutcome(table, { row: 0, column: 0 }, "insertRowBelow");
    if (outcome.kind !== "table") throw new Error("expected a table");
    expect(outcome.table.rows.length).toBe(table.rows.length + 1);
    expect(outcome.table.rows[0]).toBe(table.rows[0]);
    expect(outcome.table.rows[2]).toBe(table.rows[1]);
  });
});

/* ---------------------------------------------------------------- */
/* Where the caret goes                                              */
/* ---------------------------------------------------------------- */

describe("spotAfterOp and clampSpot", () => {
  it("lands the caret in the row an insert just made", () => {
    // Which is what the control was asked for: "insert a row below" is how
    // somebody starts typing a row.
    expect(spotAfterOp({ row: 2, column: 1 }, "insertRowAbove")).toEqual({ row: 2, column: 1 });
    expect(spotAfterOp({ row: 2, column: 1 }, "insertRowBelow")).toEqual({ row: 3, column: 1 });
    expect(spotAfterOp({ row: 2, column: 1 }, "insertColumnLeft")).toEqual({ row: 2, column: 1 });
    expect(spotAfterOp({ row: 2, column: 1 }, "insertColumnRight")).toEqual({ row: 2, column: 2 });
  });

  it("follows a row or column that moved", () => {
    // Or pressing the same button twice would move two different rows.
    expect(spotAfterOp({ row: 2, column: 1 }, "moveRowUp")).toEqual({ row: 1, column: 1 });
    expect(spotAfterOp({ row: 2, column: 1 }, "moveRowDown")).toEqual({ row: 3, column: 1 });
    expect(spotAfterOp({ row: 2, column: 1 }, "moveColumnLeft")).toEqual({ row: 2, column: 0 });
    expect(spotAfterOp({ row: 2, column: 1 }, "moveColumnRight")).toEqual({ row: 2, column: 2 });
  });

  it("stays where it was for the edits that take a cell away", () => {
    for (const op of ["deleteRow", "deleteColumn", "toggleHeaderRow"] as const) {
      expect(spotAfterOp({ row: 2, column: 1 }, op)).toEqual({ row: 2, column: 1 });
    }
  });

  it("clamps a column against the row it landed in, not the widest", () => {
    const table = grid();
    expect(clampSpot(table, { row: 9, column: 9 })).toEqual({ row: 2, column: 0 });
    expect(clampSpot(table, { row: 2, column: 1 })).toEqual({ row: 2, column: 0 });
    expect(clampSpot(table, { row: -3, column: -3 })).toEqual({ row: 0, column: 0 });
  });
});

/* ---------------------------------------------------------------- */
/* Tab                                                               */
/* ---------------------------------------------------------------- */

describe("tableTabStep", () => {
  it("walks along a row and wraps to the start of the next", () => {
    expect(tableTabStep(spot(0, 0, [2, 2]), false)).toEqual({ kind: "cell", row: 0, column: 1 });
    expect(tableTabStep(spot(0, 1, [2, 2]), false)).toEqual({ kind: "cell", row: 1, column: 0 });
  });

  it("wraps to the END of the row above, going back", () => {
    expect(tableTabStep(spot(1, 0, [3, 2]), true)).toEqual({ kind: "cell", row: 0, column: 2 });
    expect(tableTabStep(spot(1, 1, [3, 2]), true)).toEqual({ kind: "cell", row: 1, column: 0 });
  });

  it("grows a row at the very last cell", () => {
    expect(tableTabStep(spot(1, 1, [2, 2]), false)).toEqual({ kind: "append" });
  });

  it("does nothing at the very first cell, which is how a keyboard gets out", () => {
    // Shift+Tab there is left to the browser: preventing it would trap focus
    // inside the table, since Tab forward only ever grows more rows.
    expect(tableTabStep(spot(0, 0, [2, 2]), true)).toEqual({ kind: "none" });
  });

  it("respects a row's own width rather than the table's", () => {
    // Ragged rows (spec §7.3): the short row ends at its own last cell, and
    // Tab out of it goes to the next row rather than to a cell that is not
    // there.
    expect(tableTabStep(spot(0, 0, [1, 3]), false)).toEqual({ kind: "cell", row: 1, column: 0 });
    expect(tableTabStep(spot(1, 2, [1, 3]), false)).toEqual({ kind: "append" });
  });
});

/* ---------------------------------------------------------------- */
/* Naming them                                                       */
/* ---------------------------------------------------------------- */

const LABELS: VeTableLabels = {
  insertRowAbove: "Insert row above",
  insertRowBelow: "Insert row below",
  moveRowUp: "Move row up",
  moveRowDown: "Move row down",
  deleteRow: "Delete row",
  insertColumnLeft: "Insert column to the left",
  insertColumnRight: "Insert column to the right",
  moveColumnLeft: "Move column left",
  moveColumnRight: "Move column right",
  deleteColumn: "Delete column",
  headerRowOn: "Make this a header row",
  headerRowOff: "Make this a normal row",
  deleteTable: "Delete table",
};

describe("TABLE_OPS and tableOpLabel", () => {
  it("lists every operation exactly once", () => {
    // The list is what both controls iterate, so an operation missing from it
    // is a control that exists and cannot be reached.
    expect(new Set(TABLE_OPS).size).toBe(TABLE_OPS.length);
    expect(TABLE_OPS.length).toBe(12);
  });

  it("gives every operation a name in both header states", () => {
    for (const op of TABLE_OPS) {
      expect(tableOpLabel(op, LABELS, false)).not.toBe("");
      expect(tableOpLabel(op, LABELS, true)).not.toBe("");
    }
  });

  it("names the header toggle after what the click will do", () => {
    expect(tableOpLabel("toggleHeaderRow", LABELS, false)).toBe(LABELS.headerRowOn);
    expect(tableOpLabel("toggleHeaderRow", LABELS, true)).toBe(LABELS.headerRowOff);
  });

  it("draws a rule between the rows, the columns and the table itself", () => {
    const grouped = TABLE_OPS.filter((op) => tableOpStartsGroup(op));
    expect(grouped).toEqual(["insertColumnLeft", "toggleHeaderRow", "deleteTable"]);
  });
});

/* ---------------------------------------------------------------- */
/* Through the surface (§4)                                          */
/* ---------------------------------------------------------------- */

/**
 * Blocks a canonical rewrite would reformat, so "only the table changed" is a
 * claim about bytes rather than about text: an unspaced heading, a paragraph
 * over two lines, and a link written the long way round.
 */
const SOURCES = [
  "==Scrap==",
  "The quota resets\nevery three days.",
  [
    '{| class="wikitable"',
    "|+ Scrap values",
    "|-",
    "! Item !! Value",
    "|-",
    "| Gold bar || 210",
    "|-",
    "| Bottles || 80",
    "|}",
  ].join("\n"),
  "See [[Mansion|Mansion]].",
];
const ARTICLE = `${SOURCES.join("\n\n")}\n`;

/** Open the article in visual mode, run one operation on a cell, publish. */
function publishAfterTableOp(cell: string, op: VeTableOp): string {
  const doc = parseDocument(ARTICLE);
  const root = surface(documentToHtml(doc));
  const table = firstTable(root);
  const where = tableSpotOf(table, cellNamed(table, cell));
  if (where === null) throw new Error(`no spot for ${cell}`);

  // Exactly what `applyTableOp` does: read the surface back, find the block by
  // the id its element carries, hand it to the operation, draw the answer.
  const read = domToDocument(root, doc, createIdFactory("n"));
  const block = read.blocks.find((one) => one.id === table.getAttribute("data-ve-id"));
  if (block === undefined || block.kind !== "table") throw new Error("the table did not read back");
  const outcome = tableOpOutcome(block, where, op);
  if (outcome.kind !== "table") throw new Error(`expected a table, got ${outcome.kind}`);
  const redrawn = surface(blockToHtml(outcome.table)).childNodes[0];
  root.childNodes = root.childNodes.map((child) => (child === table ? redrawn : child));

  return serializeDocument(domToDocument(root, read, createIdFactory("m")));
}

describe("a table edit through the surface", () => {
  it("publishes an untouched page byte for byte (the control)", () => {
    const doc = parseDocument(ARTICLE);
    const root = surface(documentToHtml(doc));
    expect(serializeDocument(domToDocument(root, doc, createIdFactory("n")))).toBe(ARTICLE);
  });

  it("rewrites the table and not one byte of anything else", () => {
    const published = publishAfterTableOp("Gold bar", "insertRowBelow");
    // Every other block still publishes from `source` (§4): the heading is
    // still unspaced, the paragraph still two lines, the link still the long
    // way round — none of which a canonical rewrite would have left alone.
    expect(published.startsWith("==Scrap==\n\nThe quota resets\nevery three days.\n\n")).toBe(true);
    expect(published.endsWith("\n\nSee [[Mansion|Mansion]].\n")).toBe(true);
    expect(published).not.toContain("== Scrap ==");
    expect(published).toContain("| Gold bar || 210\n|-\n|  || \n|-\n| Bottles || 80");
  });

  it("moves the row the caret was in, and only that row", () => {
    expect(publishAfterTableOp("Bottles", "moveRowUp")).toContain(
      "| Bottles || 80\n|-\n| Gold bar || 210\n|}",
    );
  });

  it("takes a column out of every row that reaches it", () => {
    const published = publishAfterTableOp("Value", "deleteColumn");
    expect(published).toContain("! Item\n|-\n| Gold bar\n|-\n| Bottles\n|}");
    expect(published).not.toContain("210");
  });

  it("keeps the caption where it was through an edit", () => {
    // The caption is not a row and no operation names it, so it has to come
    // back untouched — and first, which is §4's canonical form (spec §7.4).
    expect(publishAfterTableOp("Item", "insertColumnRight")).toContain(
      '{| class="wikitable"\n|+ Scrap values\n|-\n! Item !!  !! Value',
    );
  });

  it("turns a header row into a body row and back", () => {
    expect(publishAfterTableOp("Item", "toggleHeaderRow")).toContain("| Item || Value");
    // And the table still parses as a table afterwards, which is the whole
    // reason the header refusal exists.
    const doc = parseDocument(publishAfterTableOp("Item", "toggleHeaderRow"));
    expect(doc.blocks.filter((block) => block.kind === "table").length).toBe(1);
  });

  it("republishes the original bytes when an operation changed nothing", () => {
    // `moveRowUp` from the first row is refused by `tableCan`, but the path has
    // to be safe even if a stale control were clicked: nothing is redrawn, so
    // the table is still emitted from `source` (§4).
    const doc = parseDocument(ARTICLE);
    const root = surface(documentToHtml(doc));
    const table = firstTable(root);
    const where = tableSpotOf(table, cellNamed(table, "Item"));
    if (where === null) throw new Error("no spot");
    const read = domToDocument(root, doc, createIdFactory("n"));
    const block = read.blocks.find((one) => one.id === table.getAttribute("data-ve-id"));
    if (block === undefined || block.kind !== "table") throw new Error("not a table");
    expect(tableOpOutcome(block, where, "moveRowUp")).toEqual({ kind: "none" });
    expect(serializeDocument(domToDocument(root, read, createIdFactory("m")))).toBe(ARTICLE);
  });
});
