/**
 * Row and column operations on a {@link VeTable} — the arithmetic behind the
 * table controls the visual surface grows next.
 *
 * Normative spec: docs/engine/visual-editor.md §2 (the model) and §4 (the
 * round-trip guarantee); the wikitext being preserved is docs/engine/
 * wikitext-spec.md §7. Types: model.ts.
 *
 * It lives apart from the surface for the reason version-branch.ts does: the
 * thing that must never happen — an edit that moves somebody's cell into the
 * wrong row, or quietly reshapes a table nobody asked to reshape — is decided
 * here, where it can be tested, rather than in the DOM, where it could only be
 * checked by hand.
 *
 * **Ragged rows are real, and the rule about them is one sentence: a column is
 * an index, not a promise.** Wikitext rows genuinely have different cell counts
 * (spec §7.3 splits each line on its own), so an operation on column *c*
 * touches exactly the rows that have a cell at *c* and leaves every shorter row
 * alone. Nothing here pads a row out to a common width, and nothing here
 * changes a row's length except by the one cell it was asked to add or remove.
 * A ragged table therefore comes back ragged in the same places.
 *
 * Three more properties every function holds:
 *
 * - **Pure.** The table it is given is never written to; a new one comes back,
 *   sharing the rows and cells the operation did not touch. So the caller may
 *   keep the old table (undo has to) as long as it treats both as read-only,
 *   which is how the rest of the editor already treats a parsed document.
 * - **Total.** An index that is out of range, or not an index at all, is a
 *   no-op and never a throw. The surface hands these numbers straight from a
 *   click, and a table that refuses to shrink is better than a crash mid-edit.
 * - **§4 is not this module's business.** Every operation carries `id`,
 *   `source`, `canonical` and `gapAfter` across untouched, so the serializer
 *   makes the "did this really change?" decision the same way it does for
 *   every other block: by comparing what the block serializes to now with the
 *   `canonical` it serialized to at parse time. An operation that ends up
 *   changing nothing therefore republishes the original bytes.
 *
 * The one operation that can refuse is {@link toggleHeaderRow}, and the reason
 * is spelled out there.
 */

import type { VeTable, VeTableCell, VeTableRow } from "@/lib/visual-editor/model";
import { serializeTableCell } from "@/lib/visual-editor/serialize";

/* ------------------------------------------------------------------ */
/* Shared                                                              */
/* ------------------------------------------------------------------ */

/** A real position in a list of `length` items — `1.5` and `NaN` are not. */
function inRange(index: number, length: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < length;
}

/** How many columns the table has anywhere, which is its widest row. */
export function columnCount(table: VeTable): number {
  let widest = 0;
  for (const row of table.rows) widest = Math.max(widest, row.cells.length);
  return widest;
}

/** A new, empty cell — what an inserted row or column is made of. */
function emptyCell(header: boolean): VeTableCell {
  return { header, attrs: "", children: [] };
}

/** The table with `rows` in place of its own; §4's bookkeeping rides across. */
function withRows(table: VeTable, rows: VeTableRow[]): VeTable {
  return { ...table, rows };
}

/**
 * `list` with the item at `from` moved to index `to`, or null when it cannot
 * be — either index missing from this particular list, or a move to where the
 * item already is.
 *
 * Null rather than a copy is what lets {@link moveColumn} say "this row does
 * not reach that column" and hand the row straight back.
 */
function moved<T>(list: readonly T[], from: number, to: number): T[] | null {
  if (from === to || !inRange(from, list.length) || !inRange(to, list.length)) return null;
  const out = list.slice();
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

/**
 * A new empty row beside the one at `at`.
 *
 * It is as wide as its neighbour, which is the ragged rule read forwards: a
 * new row in a table whose rows disagree about width has to pick one, and the
 * row the author pointed at is the only defensible answer.
 *
 * Its cells are data cells even under a header row. "Insert row below" on a
 * header is how a table gets its first body row, and a second row of `<th>`
 * is never what that click meant; {@link toggleHeaderRow} is there for the
 * rarer case where it was.
 */
export function insertRow(table: VeTable, at: number, where: "above" | "below"): VeTable {
  if (!inRange(at, table.rows.length)) return table;
  const cells: VeTableCell[] = [];
  for (let i = 0; i < table.rows[at].cells.length; i += 1) cells.push(emptyCell(false));
  const rows = table.rows.slice();
  rows.splice(where === "above" ? at : at + 1, 0, { attrs: "", cells });
  return withRows(table, rows);
}

/**
 * The table without the row at `at`, or **null** when that was the last row.
 *
 * Null is not an error: a table with no rows renders nothing (spec §7.5) and
 * the model does not hold one, so what the caller has on its hands is a block
 * to delete rather than a table to redraw.
 */
export function removeRow(table: VeTable, at: number): VeTable | null {
  if (!inRange(at, table.rows.length)) return table;
  if (table.rows.length === 1) return null;
  const rows = table.rows.slice();
  rows.splice(at, 1);
  return withRows(table, rows);
}

/**
 * Every cell of row `at` flipped between `<th>` and `<td>`, or the table
 * unchanged when one of them could not survive the flip.
 *
 * The refusal is small and specific. A header line splits on `!!` as well as
 * on `||` (spec §7.3), a data line only on `||` — so a data cell whose text
 * contains `!!` is written back fine as `| a !! b` and would become *two*
 * header cells the moment it were written as `! a !! b`. Rather than escape it
 * (§4: this editor inserts no `<nowiki>`, anywhere) or split the author's cell
 * behind their back, the row stays as it is. Nothing else can go wrong in
 * either direction: `||` splits both kinds of line alike, so a cell holding
 * one is already the author's own doing and the flip does not make it worse.
 *
 * Each cell flips individually, so a row that mixes the two kinds comes back
 * mixed the other way round and toggling twice is exactly the identity.
 */
export function toggleHeaderRow(table: VeTable, at: number): VeTable {
  if (!inRange(at, table.rows.length)) return table;
  const row = table.rows[at];
  for (const cell of row.cells) {
    if (!cell.header && serializeTableCell(cell).includes("!!")) return table;
  }
  const rows = table.rows.slice();
  rows[at] = { ...row, cells: row.cells.map((cell) => ({ ...cell, header: !cell.header })) };
  return withRows(table, rows);
}

/** The table with the row at `from` sitting at index `to`. */
export function moveRow(table: VeTable, from: number, to: number): VeTable {
  const rows = moved(table.rows, from, to);
  return rows === null ? table : withRows(table, rows);
}

/* ------------------------------------------------------------------ */
/* Columns                                                             */
/* ------------------------------------------------------------------ */

/**
 * A new empty cell beside column `at`, in every row that reaches it.
 *
 * The new cell copies its neighbour's header-ness, which keeps a header row
 * all `<th>`: a stray `<td>` in the middle of one would split that row across
 * two lines of wikitext and render a body cell inside the header.
 */
export function insertColumn(table: VeTable, at: number, where: "left" | "right"): VeTable {
  if (!inRange(at, columnCount(table))) return table;
  const rows = table.rows.map((row) => {
    if (at >= row.cells.length) return row;
    const cells = row.cells.slice();
    cells.splice(where === "left" ? at : at + 1, 0, emptyCell(row.cells[at].header));
    return { ...row, cells };
  });
  return withRows(table, rows);
}

/**
 * The table without column `at`, or **null** when that was the last column
 * anywhere — the same "there is no table left" answer {@link removeRow} gives.
 *
 * A row left with no cells goes with its last cell, because a row with none
 * emits nothing at all (spec §7.5) and the model does not hold one. In a
 * ragged table that means removing a column can remove a row: the one-cell row
 * whose only cell was in it.
 */
export function removeColumn(table: VeTable, at: number): VeTable | null {
  if (!inRange(at, columnCount(table))) return table;
  const rows: VeTableRow[] = [];
  for (const row of table.rows) {
    if (at >= row.cells.length) {
      rows.push(row);
      continue;
    }
    const cells = row.cells.slice();
    cells.splice(at, 1);
    if (cells.length > 0) rows.push({ ...row, cells });
  }
  return rows.length === 0 ? null : withRows(table, rows);
}

/**
 * The table with column `from` sitting at column `to`.
 *
 * Per row, and only where the row has both: a row too short to reach one of
 * the two indices keeps its cells in the order it had them. That is the ragged
 * rule again — clamping the move into a short row would silently reorder cells
 * the author never pointed at.
 */
export function moveColumn(table: VeTable, from: number, to: number): VeTable {
  const columns = columnCount(table);
  if (from === to || !inRange(from, columns) || !inRange(to, columns)) return table;
  const rows = table.rows.map((row) => {
    const cells = moved(row.cells, from, to);
    return cells === null ? row : { ...row, cells };
  });
  return withRows(table, rows);
}
