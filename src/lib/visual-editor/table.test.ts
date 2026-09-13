/**
 * The table operations — table.ts, which is the arithmetic the surface's row
 * and column controls will run on.
 *
 * Three things are being pinned down, in this order of importance:
 *
 * 1. **The ragged invariant.** "A column is an index, not a promise": an
 *    operation on column *c* touches the rows that have a cell at *c* and no
 *    others, and no row is ever padded. Every operation is checked against a
 *    deliberately ragged table, because a table nobody has edited is square
 *    and would let a padding bug through.
 * 2. **Totality.** Out-of-range indices — negative, past the end, fractional,
 *    NaN — are no-ops, never throws. These numbers come from a click.
 * 3. **§4.** The operations carry a block's `source`, `canonical` and
 *    `gapAfter` across untouched, so the serializer keeps making the "was this
 *    really edited?" decision on its own, and an operation that changes
 *    nothing republishes the original bytes.
 */

import { describe, expect, it } from "vitest";

import { newBlockBase, type VeTable, type VeTableCell, type VeTableRow } from "./model";
import { serializeBlock } from "./serialize";
import {
  columnCount,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  removeColumn,
  removeRow,
  toggleHeaderRow,
} from "./table";

/* ---------------------------------------------------------------- */
/* Helpers                                                           */
/* ---------------------------------------------------------------- */

function cell(text: string, header = false, attrs = ""): VeTableCell {
  return { header, attrs, children: text === "" ? [] : [{ kind: "text", text }] };
}

function row(cells: VeTableCell[], attrs = ""): VeTableRow {
  return { attrs, cells };
}

function table(rows: VeTableRow[]): VeTable {
  return { ...newBlockBase("t1"), kind: "table", attrs: "", caption: null, rows };
}

/**
 * The whole table as text, a header cell marked with the `!` its wikitext
 * would carry. Comparing these says what changed and where in one line.
 */
function grid(value: VeTable | null): string[][] {
  if (value === null) throw new Error("expected a table, got null");
  return value.rows.map((each) =>
    each.cells.map((one) => {
      const text = one.children.map((node) => (node.kind === "text" ? node.text : "?")).join("");
      return one.header ? `!${text}` : text;
    }),
  );
}

function widths(value: VeTable | null): number[] {
  if (value === null) throw new Error("expected a table, got null");
  return value.rows.map((each) => each.cells.length);
}

/** `! A !! B` over `| 1 || 2` — the shape most of the wiki's tables have. */
function square(): VeTable {
  return table([
    row([cell("A", true), cell("B", true)]),
    row([cell("1"), cell("2")]),
    row([cell("3"), cell("4")]),
  ]);
}

/**
 * Rows of three, one and two cells. Wikitext really does produce these — each
 * cell line is split on its own (spec §7.3) — so every operation below is
 * asked what it does to the short rows, not only to the long one.
 */
function ragged(): VeTable {
  return table([
    row([cell("a"), cell("b"), cell("c")]),
    row([cell("d")]),
    row([cell("e"), cell("f")]),
  ]);
}

/** Every out-of-range index one number can be. */
const NOT_INDEXES = [-1, 3, 99, 1.5, NaN];

/* ---------------------------------------------------------------- */
/* insertRow                                                         */
/* ---------------------------------------------------------------- */

describe("insertRow", () => {
  it("puts an empty row above or below the row it was pointed at", () => {
    expect(grid(insertRow(square(), 1, "above"))).toEqual([
      ["!A", "!B"],
      ["", ""],
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(grid(insertRow(square(), 1, "below"))).toEqual([
      ["!A", "!B"],
      ["1", "2"],
      ["", ""],
      ["3", "4"],
    ]);
  });

  it("makes data cells even under a header row", () => {
    // "Insert row below" on a header is how a table gets its first body row.
    const added = insertRow(square(), 0, "below");
    expect(grid(added)).toEqual([["!A", "!B"], ["", ""], ["1", "2"], ["3", "4"]]);
    expect(added.rows[1].cells.every((each) => !each.header)).toBe(true);
    expect(added.rows[1].attrs).toBe("");
  });

  it("takes its width from the row it was pointed at, not from the widest", () => {
    expect(widths(insertRow(ragged(), 1, "below"))).toEqual([3, 1, 1, 2]);
    expect(widths(insertRow(ragged(), 0, "above"))).toEqual([3, 3, 1, 2]);
  });

  it("is a no-op for an index that is not a row", () => {
    for (const at of NOT_INDEXES) {
      expect(grid(insertRow(square(), at, "below"))).toEqual(grid(square()));
    }
  });
});

/* ---------------------------------------------------------------- */
/* removeRow                                                         */
/* ---------------------------------------------------------------- */

describe("removeRow", () => {
  it("removes the row it was pointed at", () => {
    expect(grid(removeRow(square(), 1))).toEqual([["!A", "!B"], ["3", "4"]]);
    expect(grid(removeRow(square(), 0))).toEqual([["1", "2"], ["3", "4"]]);
  });

  it("returns null rather than an empty table", () => {
    // §7.5: a table with no rows renders nothing, so what the caller has is a
    // block to delete.
    expect(removeRow(table([row([cell("only")])]), 0)).toBeNull();
  });

  it("is a no-op for an index that is not a row", () => {
    for (const at of NOT_INDEXES) expect(grid(removeRow(square(), at))).toEqual(grid(square()));
  });
});

/* ---------------------------------------------------------------- */
/* toggleHeaderRow                                                   */
/* ---------------------------------------------------------------- */

describe("toggleHeaderRow", () => {
  it("flips every cell in the row", () => {
    expect(grid(toggleHeaderRow(square(), 1))).toEqual([["!A", "!B"], ["!1", "!2"], ["3", "4"]]);
    expect(grid(toggleHeaderRow(square(), 0))).toEqual([["A", "B"], ["1", "2"], ["3", "4"]]);
  });

  it("is its own inverse, mixed rows included", () => {
    const mixed = table([row([cell("A", true), cell("b"), cell("C", true)])]);
    expect(grid(toggleHeaderRow(mixed, 0))).toEqual([["A", "!b", "C"]]);
    expect(grid(toggleHeaderRow(toggleHeaderRow(mixed, 0), 0))).toEqual(grid(mixed));
    expect(grid(toggleHeaderRow(toggleHeaderRow(square(), 1), 1))).toEqual(grid(square()));
  });

  it("keeps the row's attributes and each cell's own", () => {
    const attributed = table([row([cell("A", false, 'style="width:2em"')], 'class="x"')]);
    const flipped = toggleHeaderRow(attributed, 0);
    expect(flipped.rows[0].attrs).toBe('class="x"');
    expect(flipped.rows[0].cells[0].attrs).toBe('style="width:2em"');
    expect(flipped.rows[0].cells[0].header).toBe(true);
  });

  it("refuses a row holding a cell that `!!` would split in two", () => {
    // A data line does not split on `!!` and a header line does (spec §7.3),
    // so `| a !! b` is one cell and `! a !! b` is two. Rewriting the author's
    // cell — or escaping it, which §4 forbids — is worse than not moving.
    const hazard = table([row([cell("ok"), cell("a !! b")])]);
    expect(toggleHeaderRow(hazard, 0)).toEqual(hazard);
    expect(serializeBlock(hazard)).toBe("{|\n|-\n| ok || a !! b\n|}");

    // The same when the `!!` is hiding in the attribute half of the cell.
    const inAttrs = table([row([cell("x", false, 'title="a!!b"')])]);
    expect(toggleHeaderRow(inAttrs, 0)).toEqual(inAttrs);
  });

  it("still flips a header row back, and flips a row holding a bare `!`", () => {
    const single = table([row([cell("Wow! Big")])]);
    expect(grid(toggleHeaderRow(single, 0))).toEqual([["!Wow! Big"]]);
    expect(serializeBlock(toggleHeaderRow(single, 0))).toBe("{|\n|-\n! Wow! Big\n|}");
  });

  it("is a no-op for an index that is not a row", () => {
    for (const at of NOT_INDEXES) {
      expect(grid(toggleHeaderRow(square(), at))).toEqual(grid(square()));
    }
  });
});

/* ---------------------------------------------------------------- */
/* moveRow                                                           */
/* ---------------------------------------------------------------- */

describe("moveRow", () => {
  it("moves a row to the index it was given, in either direction", () => {
    expect(grid(moveRow(square(), 2, 0))).toEqual([["3", "4"], ["!A", "!B"], ["1", "2"]]);
    expect(grid(moveRow(square(), 0, 2))).toEqual([["1", "2"], ["3", "4"], ["!A", "!B"]]);
  });

  it("keeps every row's own cells and attributes with it", () => {
    const attributed = table([row([cell("a")], 'class="one"'), row([cell("b")], 'class="two"')]);
    const moved = moveRow(attributed, 1, 0);
    expect(moved.rows.map((each) => each.attrs)).toEqual(['class="two"', 'class="one"']);
    expect(grid(moved)).toEqual([["b"], ["a"]]);
  });

  it("is a no-op for a move that goes nowhere or out of range", () => {
    expect(grid(moveRow(square(), 1, 1))).toEqual(grid(square()));
    for (const at of NOT_INDEXES) {
      expect(grid(moveRow(square(), at, 0))).toEqual(grid(square()));
      expect(grid(moveRow(square(), 0, at))).toEqual(grid(square()));
    }
  });
});

/* ---------------------------------------------------------------- */
/* insertColumn                                                      */
/* ---------------------------------------------------------------- */

describe("insertColumn", () => {
  it("adds an empty cell to the left or right of the column, in every row", () => {
    expect(grid(insertColumn(square(), 1, "left"))).toEqual([
      ["!A", "!", "!B"],
      ["1", "", "2"],
      ["3", "", "4"],
    ]);
    expect(grid(insertColumn(square(), 1, "right"))).toEqual([
      ["!A", "!B", "!"],
      ["1", "2", ""],
      ["3", "4", ""],
    ]);
  });

  it("gives the new cell its neighbour's header-ness, so a header row stays one", () => {
    // A `<td>` in the middle of a header row would break the row across two
    // lines of wikitext and render a body cell inside the header.
    const added = insertColumn(square(), 0, "right");
    expect(added.rows[0].cells.every((each) => each.header)).toBe(true);
    expect(added.rows[1].cells.every((each) => !each.header)).toBe(true);
    expect(serializeBlock(added)).toBe(
      "{|\n|-\n! A !!  !! B\n|-\n| 1 ||  || 2\n|-\n| 3 ||  || 4\n|}",
    );
  });

  it("leaves a row that does not reach the column alone", () => {
    expect(grid(insertColumn(ragged(), 2, "left"))).toEqual([
      ["a", "b", "", "c"],
      ["d"],
      ["e", "f"],
    ]);
    expect(widths(insertColumn(ragged(), 2, "left"))).toEqual([4, 1, 2]);
    expect(widths(insertColumn(ragged(), 1, "right"))).toEqual([4, 1, 3]);
    expect(widths(insertColumn(ragged(), 0, "left"))).toEqual([4, 2, 3]);
  });

  it("is a no-op for an index that is not a column anywhere", () => {
    for (const at of [-1, 3, 99, 1.5, NaN]) {
      expect(grid(insertColumn(ragged(), at, "left"))).toEqual(grid(ragged()));
    }
  });
});

/* ---------------------------------------------------------------- */
/* removeColumn                                                      */
/* ---------------------------------------------------------------- */

describe("removeColumn", () => {
  it("removes the column from every row that reaches it", () => {
    expect(grid(removeColumn(square(), 0))).toEqual([["!B"], ["2"], ["4"]]);
    expect(grid(removeColumn(ragged(), 1))).toEqual([["a", "c"], ["d"], ["e"]]);
  });

  it("leaves a row that does not reach the column alone", () => {
    expect(grid(removeColumn(ragged(), 2))).toEqual([["a", "b"], ["d"], ["e", "f"]]);
  });

  it("takes a row away with its last cell", () => {
    // §7.5 again: a row with no cells renders nothing, and the model does not
    // hold one — so in a ragged table, removing a column can remove a row.
    expect(grid(removeColumn(ragged(), 0))).toEqual([["b", "c"], ["f"]]);
  });

  it("returns null when that was the last column anywhere", () => {
    expect(removeColumn(table([row([cell("a")]), row([cell("b")])]), 0)).toBeNull();
  });

  it("is a no-op for an index that is not a column anywhere", () => {
    for (const at of [-1, 3, 99, 1.5, NaN]) {
      expect(grid(removeColumn(ragged(), at))).toEqual(grid(ragged()));
    }
  });
});

/* ---------------------------------------------------------------- */
/* moveColumn                                                        */
/* ---------------------------------------------------------------- */

describe("moveColumn", () => {
  it("moves the column in every row that has both ends of the move", () => {
    expect(grid(moveColumn(square(), 0, 1))).toEqual([["!B", "!A"], ["2", "1"], ["4", "3"]]);
    expect(grid(moveColumn(ragged(), 2, 0))).toEqual([["c", "a", "b"], ["d"], ["e", "f"]]);
  });

  it("leaves a row that does not reach both indices in the order it had", () => {
    // Clamping the move into a short row would reorder cells nobody pointed
    // at; the short rows here keep exactly what they held.
    const moved = moveColumn(ragged(), 0, 2);
    expect(grid(moved)).toEqual([["b", "c", "a"], ["d"], ["e", "f"]]);
    expect(widths(moved)).toEqual([3, 1, 2]);
  });

  it("is a no-op for a move that goes nowhere or out of range", () => {
    expect(grid(moveColumn(ragged(), 1, 1))).toEqual(grid(ragged()));
    for (const at of [-1, 3, 99, 1.5, NaN]) {
      expect(grid(moveColumn(ragged(), at, 0))).toEqual(grid(ragged()));
      expect(grid(moveColumn(ragged(), 0, at))).toEqual(grid(ragged()));
    }
  });
});

/* ---------------------------------------------------------------- */
/* The invariants every operation shares                             */
/* ---------------------------------------------------------------- */

describe("columnCount", () => {
  it("is the widest row, which is what an index has to fit inside", () => {
    expect(columnCount(square())).toBe(2);
    expect(columnCount(ragged())).toBe(3);
    expect(columnCount(table([row([cell("a")])]))).toBe(1);
  });
});

describe("every operation", () => {
  /** One call of each, on the ragged table, with an index it can act on. */
  const operations: { name: string; run: (value: VeTable) => VeTable | null }[] = [
    { name: "insertRow above", run: (value) => insertRow(value, 1, "above") },
    { name: "insertRow below", run: (value) => insertRow(value, 1, "below") },
    { name: "removeRow", run: (value) => removeRow(value, 1) },
    { name: "toggleHeaderRow", run: (value) => toggleHeaderRow(value, 0) },
    { name: "moveRow", run: (value) => moveRow(value, 0, 2) },
    { name: "insertColumn left", run: (value) => insertColumn(value, 1, "left") },
    { name: "insertColumn right", run: (value) => insertColumn(value, 1, "right") },
    { name: "removeColumn", run: (value) => removeColumn(value, 1) },
    { name: "moveColumn", run: (value) => moveColumn(value, 0, 2) },
  ];

  it.each(operations)("$name leaves the table it was given alone", ({ run }) => {
    const before = ragged();
    const snapshot = JSON.stringify(before);
    run(before);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it.each(operations)("$name pads no row out to a common width", ({ run }) => {
    // The ragged rule, stated as the property it is: the short rows stay
    // short. Only the column operations may change a row's length at all, and
    // then by exactly the one cell they added or removed.
    const after = run(ragged());
    if (after === null) throw new Error("expected a table");
    for (const each of after.rows) {
      expect(each.cells.length).toBeLessThanOrEqual(columnCount(ragged()) + 1);
    }
    expect(new Set(widths(after)).size).toBeGreaterThan(1);
  });

  it.each(operations)("$name keeps §4's bookkeeping on the block", ({ run }) => {
    const before: VeTable = {
      ...ragged(),
      source: "{|\n| a || b || c\n|-\n| d\n|-\n| e || f\n|}",
      canonical: "{|\n|-\n| a || b || c\n|-\n| d\n|-\n| e || f\n|}",
      gapAfter: "\n\n",
    };
    const after = run(before);
    if (after === null) throw new Error("expected a table");
    expect(after.id).toBe(before.id);
    expect(after.source).toBe(before.source);
    expect(after.canonical).toBe(before.canonical);
    expect(after.gapAfter).toBe(before.gapAfter);
  });

  it.each(operations)("$name leaves the caption and the table's attributes alone", ({ run }) => {
    const before: VeTable = {
      ...ragged(),
      attrs: 'class="wikitable"',
      caption: [{ kind: "text", text: "Scrap values" }],
    };
    const after = run(before);
    if (after === null) throw new Error("expected a table");
    expect(after.attrs).toBe('class="wikitable"');
    expect(after.caption).toEqual([{ kind: "text", text: "Scrap values" }]);
  });

  it.each(operations)("$name leaves a model a table can hold", ({ run }) => {
    // model.ts's invariant: at least one row, and every row at least one cell.
    const after = run(ragged());
    if (after === null) throw new Error("expected a table");
    expect(after.rows.length).toBeGreaterThan(0);
    for (const each of after.rows) expect(each.cells.length).toBeGreaterThan(0);
  });
});
