/**
 * The decisions behind the table controls — which cell the caret is in, which
 * of the twelve edits that cell can be given, what one of them does, and where
 * the caret lands afterwards.
 *
 * Normative spec: docs/engine/visual-editor.md §3 (the DOM mapping), §3.2 (the
 * controls) and §4 (the round-trip guarantee); the wikitext underneath is
 * docs/engine/wikitext-spec.md §7. The edits themselves live in
 * `src/lib/visual-editor/table.ts` and **nothing here reimplements one**: this
 * module chooses and dispatches, that one computes.
 *
 * It exists apart from `visual-editor.tsx` for the reason `ve-selection.ts`
 * does. Every function here is pure, so all of it can be exercised under
 * vitest's node environment — and the thing that must never happen, an
 * operation landing on a different row than the one the author's caret was in,
 * is arithmetic that can be *tested* rather than markup that can only be
 * clicked at.
 *
 * **The row and column walk repeats `dom.ts`'s reader exactly**, which is the
 * one piece of duplication here and the reason it is called out: an index is
 * only meaningful against the model `domToDocument` builds out of the same
 * markup, so this walks through an inserted `<tbody>/<thead>/<tfoot>`, adopts a
 * cell left outside a row, and drops a row left with no cells — all three
 * exactly as `collectRows` does (§3, spec §7.5). `ve-table.test.ts` asserts the
 * agreement against `domToDocument` itself rather than trusting this sentence.
 *
 * Ragged rows are real (table.ts: *a column is an index, not a promise*), so
 * the spot carries every row's own width rather than one number: Tab's "next
 * cell in this row" and a move's "there is a column to the right" are questions
 * about one row, and answering them from the table's widest row would step over
 * a cell that does not exist.
 */

import type { VeTableContext, VeTableOp } from "@/lib/visual-editor/actions";
import type { VeTable } from "@/lib/visual-editor/model";
import {
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  removeColumn,
  removeRow,
  toggleHeaderRow,
} from "@/lib/visual-editor/table";

/* ------------------------------------------------------------------ */
/* Reading the markup                                                  */
/* ------------------------------------------------------------------ */

/**
 * The structural subset of DOM `Node` this module reads — the same bargain
 * `dom.ts`'s `VeDomNode` and `ve-selection.ts`'s `VeMoveNode` make, so the walk
 * below can be exercised with object literals under vitest's node environment.
 * Real elements satisfy it; `getAttribute` is optional because text nodes have
 * none.
 */
export interface VeTableNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly childNodes: ArrayLike<VeTableNode>;
  getAttribute?(name: string): string | null;
}

const ELEMENT_NODE = 1;

/** A hostile or looping subtree must not blow the stack (dom.ts's own limit). */
const MAX_DEPTH = 64;

function childrenOf(node: VeTableNode): VeTableNode[] {
  const out: VeTableNode[] = [];
  const list = node.childNodes;
  for (let i = 0; i < list.length; i += 1) out.push(list[i]);
  return out;
}

function isCellTag(tag: string): boolean {
  return tag === "TH" || tag === "TD";
}

function isRowGroupTag(tag: string): boolean {
  return tag === "TBODY" || tag === "THEAD" || tag === "TFOOT";
}

function collectRows(node: VeTableNode, rows: VeTableNode[][], depth: number): void {
  if (depth > MAX_DEPTH) return;
  let loose: VeTableNode[] = [];
  const flushLoose = (): void => {
    if (loose.length === 0) return;
    rows.push(loose);
    loose = [];
  };

  for (const child of childrenOf(node)) {
    if (child.nodeType !== ELEMENT_NODE) continue;
    const tag = child.nodeName;
    if (isRowGroupTag(tag)) {
      flushLoose();
      collectRows(child, rows, depth + 1);
      continue;
    }
    if (tag === "TR") {
      flushLoose();
      const cells: VeTableNode[] = [];
      for (const grandchild of childrenOf(child)) {
        if (grandchild.nodeType === ELEMENT_NODE && isCellTag(grandchild.nodeName)) {
          cells.push(grandchild);
        }
      }
      // A row with no cells emits nothing (spec §7.5) and the model holds no
      // such row, so counting one here would offset every index below it.
      if (cells.length > 0) rows.push(cells);
      continue;
    }
    if (isCellTag(tag)) loose.push(child);
  }
  flushLoose();
}

/**
 * A table's cells, grouped into the rows `domToDocument` reads out of it.
 *
 * Nested tables are not walked into: the outer table's rows are its own, and a
 * cell of an inner one belongs to no row of this table — which is the answer
 * the controls want, since a table holding another is a table the model refused
 * (spec §7.9) and the inner markup can only have arrived by paste.
 */
export function tableRowsOf(table: VeTableNode): VeTableNode[][] {
  const rows: VeTableNode[][] = [];
  collectRows(table, rows, 0);
  return rows;
}

/**
 * Where one cell sits in its table, and the shape of the table around it —
 * everything the controls need and nothing that has to be looked up twice.
 *
 * `widths` is per row on purpose (see the module comment): the table's widest
 * row is a different question, and {@link spotColumnCount} is where it is
 * asked.
 */
export interface VeTableSpot {
  row: number;
  column: number;
  /** Cells per row, in order. Rows are genuinely ragged (spec §7.3). */
  widths: readonly number[];
  /** Every cell of the caret's row is a `<th>`, so the toggle names the way out. */
  headerRow: boolean;
}

export function spotRowCount(spot: VeTableSpot): number {
  return spot.widths.length;
}

/** The table's widest row — the only column index an operation may name. */
export function spotColumnCount(spot: VeTableSpot): number {
  let widest = 0;
  for (const width of spot.widths) widest = Math.max(widest, width);
  return widest;
}

/** Where `cell` sits in `table`, or null when it is in no row of it. */
export function tableSpotOf(table: VeTableNode, cell: VeTableNode): VeTableSpot | null {
  const rows = tableRowsOf(table);
  const widths = rows.map((row) => row.length);
  for (let row = 0; row < rows.length; row += 1) {
    for (let column = 0; column < rows[row].length; column += 1) {
      if (rows[row][column] !== cell) continue;
      return {
        row,
        column,
        widths,
        headerRow: rows[row].every((one) => one.nodeName === "TH"),
      };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Which controls are offered                                          */
/* ------------------------------------------------------------------ */

/**
 * Which of the twelve edits can do something from `spot`.
 *
 * Only the four moves are ever refused here, and for the reason the gutter's
 * move buttons are (§3.1): at the first row there is nowhere up, and a button
 * that says so is better than one that clicks and does nothing.
 *
 * Everything else is offered, **including the deletes that would take the whole
 * table with them** — that is a real edit, not an impossible one, and the
 * dialog in front of it (§3.2) is where the author is told. `toggleHeaderRow`
 * is offered too, because the one case it refuses cannot be seen from here: it
 * is about a cell's *wikitext*, and this spot knows only the markup's shape.
 * The refusal is reported when it happens instead.
 */
export function tableCan(spot: VeTableSpot): Readonly<Record<VeTableOp, boolean>> {
  const rows = spotRowCount(spot);
  const columns = spotColumnCount(spot);
  return {
    insertRowAbove: true,
    insertRowBelow: true,
    moveRowUp: spot.row > 0,
    moveRowDown: spot.row + 1 < rows,
    deleteRow: true,
    insertColumnLeft: true,
    insertColumnRight: true,
    moveColumnLeft: spot.column > 0,
    moveColumnRight: spot.column + 1 < columns,
    deleteColumn: true,
    toggleHeaderRow: true,
    deleteTable: true,
  };
}

/** What the toolbar is told about the caret's table (actions.ts). */
export function tableContextOf(spot: VeTableSpot): VeTableContext {
  return { can: tableCan(spot), headerRow: spot.headerRow };
}

/* ------------------------------------------------------------------ */
/* Naming them                                                         */
/* ------------------------------------------------------------------ */

/**
 * The order both controls list the operations in — rows, then columns, then
 * the two that are about the table itself.
 *
 * One list rather than two, because a control the mouse offers in a different
 * order from the one the keyboard offers is two controls to learn. It is also
 * the exhaustiveness check: an operation added to `VeTableOp` and forgotten
 * here is a control that exists and cannot be reached.
 */
export const TABLE_OPS: readonly VeTableOp[] = [
  "insertRowAbove",
  "insertRowBelow",
  "moveRowUp",
  "moveRowDown",
  "deleteRow",
  "insertColumnLeft",
  "insertColumnRight",
  "moveColumnLeft",
  "moveColumnRight",
  "deleteColumn",
  "toggleHeaderRow",
  "deleteTable",
];

/**
 * The names the floating control and the toolbar's menu share.
 *
 * They share them on purpose: an author who learns "Insert row below" from a
 * tooltip has to find the same words in the menu, or the two controls read as
 * two features. `src/lib/wiki/edit-view.ts` fills this bag once and hands the
 * same object to both.
 */
export interface VeTableLabels {
  insertRowAbove: string;
  insertRowBelow: string;
  moveRowUp: string;
  moveRowDown: string;
  deleteRow: string;
  insertColumnLeft: string;
  insertColumnRight: string;
  moveColumnLeft: string;
  moveColumnRight: string;
  deleteColumn: string;
  /**
   * The header toggle is named for what the click will do, which is why there
   * are two: `On` while the caret's row is a body row, `Off` while it is
   * already a header row. A single name plus a pressed state would make the
   * control's meaning something to be read off an icon.
   */
  headerRowOn: string;
  headerRowOff: string;
  deleteTable: string;
}

/** One operation's accessible name — the only place the toggle's pair is resolved. */
export function tableOpLabel(op: VeTableOp, labels: VeTableLabels, headerRow: boolean): string {
  switch (op) {
    case "insertRowAbove":
      return labels.insertRowAbove;
    case "insertRowBelow":
      return labels.insertRowBelow;
    case "moveRowUp":
      return labels.moveRowUp;
    case "moveRowDown":
      return labels.moveRowDown;
    case "deleteRow":
      return labels.deleteRow;
    case "insertColumnLeft":
      return labels.insertColumnLeft;
    case "insertColumnRight":
      return labels.insertColumnRight;
    case "moveColumnLeft":
      return labels.moveColumnLeft;
    case "moveColumnRight":
      return labels.moveColumnRight;
    case "deleteColumn":
      return labels.deleteColumn;
    case "toggleHeaderRow":
      return headerRow ? labels.headerRowOff : labels.headerRowOn;
    case "deleteTable":
      return labels.deleteTable;
  }
}

/**
 * Where a rule is drawn above a row of the list — the three groups of
 * {@link TABLE_OPS}, said once so both controls group alike.
 */
export function tableOpStartsGroup(op: VeTableOp): boolean {
  return op === "insertColumnLeft" || op === "toggleHeaderRow" || op === "deleteTable";
}

/* ------------------------------------------------------------------ */
/* Applying one                                                        */
/* ------------------------------------------------------------------ */

/**
 * What one operation came to.
 *
 * - `table` — the table as it now reads; the surface redraws that block.
 * - `delete` — there is no table left. Removing the last row or the last
 *   column is the same answer as "delete the table", because a table with no
 *   rows renders nothing (spec §7.5) and the model does not hold one
 *   (model.ts's invariant). The surface asks before it happens.
 * - `refused` — {@link toggleHeaderRow} would have split a cell in two, so it
 *   did nothing. Named apart from `none` because an author who pressed a
 *   button is owed the reason.
 * - `none` — nothing to do. The surface leaves the markup, and with it the
 *   caret, exactly where it was.
 */
export type VeTableOutcome =
  | { kind: "table"; table: VeTable }
  | { kind: "delete" }
  | { kind: "refused" }
  | { kind: "none" };

/**
 * `table.ts` hands the *same object* back for an edit that changes nothing —
 * an index out of range, a move to where the row already is — so identity is
 * the signal, and it is a deliberate one: redrawing the block anyway would
 * cost the caret its place for an edit that did not happen.
 */
function outcomeOf(before: VeTable, after: VeTable): VeTableOutcome {
  return after === before ? { kind: "none" } : { kind: "table", table: after };
}

/** `removeRow`/`removeColumn` answer null for "there is no table left". */
function removalOutcome(before: VeTable, after: VeTable | null): VeTableOutcome {
  if (after === null) return { kind: "delete" };
  return outcomeOf(before, after);
}

/**
 * One operation, applied to the row and column the caret is in.
 *
 * Every branch delegates to `src/lib/visual-editor/table.ts`: the ragged rule,
 * the refusals and §4's bookkeeping are decided there, once, where they are
 * tested. What this adds is only the mapping from a control to a call — and the
 * exhaustive switch, which is what makes a thirteenth operation a compile
 * error rather than a silently ignored click.
 */
export function tableOpOutcome(
  table: VeTable,
  spot: Pick<VeTableSpot, "row" | "column">,
  op: VeTableOp,
): VeTableOutcome {
  switch (op) {
    case "insertRowAbove":
      return outcomeOf(table, insertRow(table, spot.row, "above"));
    case "insertRowBelow":
      return outcomeOf(table, insertRow(table, spot.row, "below"));
    case "moveRowUp":
      return outcomeOf(table, moveRow(table, spot.row, spot.row - 1));
    case "moveRowDown":
      return outcomeOf(table, moveRow(table, spot.row, spot.row + 1));
    case "deleteRow":
      return removalOutcome(table, removeRow(table, spot.row));
    case "insertColumnLeft":
      return outcomeOf(table, insertColumn(table, spot.column, "left"));
    case "insertColumnRight":
      return outcomeOf(table, insertColumn(table, spot.column, "right"));
    case "moveColumnLeft":
      return outcomeOf(table, moveColumn(table, spot.column, spot.column - 1));
    case "moveColumnRight":
      return outcomeOf(table, moveColumn(table, spot.column, spot.column + 1));
    case "deleteColumn":
      return removalOutcome(table, removeColumn(table, spot.column));
    case "toggleHeaderRow": {
      const next = toggleHeaderRow(table, spot.row);
      if (next !== table) return { kind: "table", table: next };
      // Unchanged means one of two things, and they are not the same news: a
      // row that is not there (nothing to say) or a data cell holding `!!`,
      // which `!` would split into two header cells (spec §7.3). Only the
      // second is a refusal an author needs told about.
      const real = Number.isInteger(spot.row) && spot.row >= 0 && spot.row < table.rows.length;
      return real ? { kind: "refused" } : { kind: "none" };
    }
    case "deleteTable":
      return { kind: "delete" };
  }
}

/* ------------------------------------------------------------------ */
/* Where the caret goes                                                */
/* ------------------------------------------------------------------ */

/**
 * The cell the caret should end up in, named in the coordinates of the table
 * the operation produced.
 *
 * An insert lands the caret **in the new cell or row**, because that is what
 * the author asked the control for: "insert a row below" is how somebody starts
 * typing a row. A move follows the row or column it moved, because otherwise
 * pressing the same button twice would move two different rows. A delete stays
 * where it was and is clamped by {@link clampSpot}, since the cell it names may
 * be the one that has just gone.
 */
export function spotAfterOp(
  spot: Pick<VeTableSpot, "row" | "column">,
  op: VeTableOp,
): { row: number; column: number } {
  const { row, column } = spot;
  switch (op) {
    // The new row takes this index and pushes the old one down.
    case "insertRowAbove":
      return { row, column };
    case "insertRowBelow":
      return { row: row + 1, column };
    case "moveRowUp":
      return { row: row - 1, column };
    case "moveRowDown":
      return { row: row + 1, column };
    case "insertColumnLeft":
      return { row, column };
    case "insertColumnRight":
      return { row, column: column + 1 };
    case "moveColumnLeft":
      return { row, column: column - 1 };
    case "moveColumnRight":
      return { row, column: column + 1 };
    case "deleteRow":
    case "deleteColumn":
    case "toggleHeaderRow":
    // Unreachable: a deleted table has no cell to land in, and the surface
    // never asks. Answering the caret's own position keeps this total.
    case "deleteTable":
      return { row, column };
  }
}

/**
 * The nearest cell that really exists to the one `want` names, or null for a
 * table with nothing in it (which the model does not hold).
 *
 * Clamping row-first and then column-within-that-row is what makes this right
 * for a ragged table: the column is clamped against the row it landed in, not
 * against the table's widest.
 */
export function clampSpot(
  table: VeTable,
  want: { row: number; column: number },
): { row: number; column: number } | null {
  if (table.rows.length === 0) return null;
  const row = Math.max(0, Math.min(want.row, table.rows.length - 1));
  const cells = table.rows[row].cells.length;
  if (cells === 0) return null;
  return { row, column: Math.max(0, Math.min(want.column, cells - 1)) };
}

/* ------------------------------------------------------------------ */
/* Tab                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Where Tab goes from `spot` — the behaviour every table editor has, and the
 * one authors try before they look for a control (§3.2).
 *
 * - `cell` — move the caret, and nothing else. Crossing into the next row is
 *   still only a caret move: no markup changes, so nothing is re-serialized
 *   and §4 is not even consulted.
 * - `append` — Tab at the very last cell, which is where every table editor
 *   grows a row. That one *is* an edit, so it goes through the same path a
 *   control's click does.
 * - `none` — Shift+Tab at the first cell. Deliberately not "grow a row above":
 *   nobody backs into a new row, and the key is better spent doing nothing.
 *
 * The walk is per row rather than over a flattened list of cells because rows
 * are ragged: the row below may be shorter or longer than this one, and
 * "column 4 of the next row" is a cell that need not exist.
 */
export type VeTableStep =
  | { kind: "cell"; row: number; column: number }
  | { kind: "append" }
  | { kind: "none" };

export function tableTabStep(spot: VeTableSpot, back: boolean): VeTableStep {
  const rows = spotRowCount(spot);
  if (back) {
    if (spot.column > 0) return { kind: "cell", row: spot.row, column: spot.column - 1 };
    if (spot.row === 0) return { kind: "none" };
    const above = spot.widths[spot.row - 1];
    return { kind: "cell", row: spot.row - 1, column: above - 1 };
  }
  if (spot.column + 1 < spot.widths[spot.row]) {
    return { kind: "cell", row: spot.row, column: spot.column + 1 };
  }
  if (spot.row + 1 < rows) return { kind: "cell", row: spot.row + 1, column: 0 };
  return { kind: "append" };
}
