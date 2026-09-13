/**
 * Sortable-table comparator (Fandom ext §F.2.4a).
 *
 * The cell strings below are lifted VERBATIM from the reference fixture
 * docs/engine/fixtures/fandom-artifice.wikitext (the "Scrap Loot Table" and
 * "Entities" tables) — the point of this suite is that the real article sorts
 * correctly, not that a synthetic comparator is self-consistent.
 *
 * Only pure exports are exercised: the suite runs in the `node` environment,
 * and the DOM half of the island is deliberately kept behind these functions.
 */

import { describe, expect, it } from "vitest";

import {
  compareCells,
  nextDirection,
  normalizeCellText,
  orderIndexes,
  parseNumericCell,
} from "./sortable-table";

/** Ascending sort of raw cell strings, via the index permutation. */
function sorted(values: readonly string[], direction: "ascending" | "descending" = "ascending") {
  return orderIndexes(values, direction).map((i) => values[i]);
}

/* ---------------------------------------------------------------- */
/* parseNumericCell — leading-number extraction                      */
/* ---------------------------------------------------------------- */

describe("parseNumericCell", () => {
  it("reads the fixture's real numeric cells", () => {
    // "Spawn Chance", "Min/Max/Average Value" (▮ = the game's value glyph),
    // and "Weight" columns of the Scrap Loot Table.
    expect(parseNumericCell("4.73%")).toBe(4.73);
    expect(parseNumericCell("45.00%")).toBe(45);
    expect(parseNumericCell("56▮")).toBe(56);
    expect(parseNumericCell("123▮")).toBe(123);
    expect(parseNumericCell("21 lb")).toBe(21);
    expect(parseNumericCell("0 lb")).toBe(0);
    expect(parseNumericCell("2")).toBe(2);
    expect(parseNumericCell("20")).toBe(20);
  });

  it("reads the leading number of a range cell", () => {
    // Moon-page spawn columns are written as a range plus an average.
    expect(parseNumericCell("0 - 9 (avg. 3)")).toBe(0);
    expect(parseNumericCell("3 - 12 (avg. 7)")).toBe(3);
  });

  it("handles currency, thousands separators, signs and approximations", () => {
    expect(parseNumericCell("$1,234.50")).toBe(1234.5);
    expect(parseNumericCell("1,000,000")).toBe(1_000_000);
    expect(parseNumericCell("-5")).toBe(-5);
    expect(parseNumericCell("+12%")).toBe(12);
    expect(parseNumericCell("~5 lb")).toBe(5);
    expect(parseNumericCell("<1%")).toBe(1);
    expect(parseNumericCell(".5")).toBe(0.5);
  });

  it("returns null for text cells, including text that merely CONTAINS a number", () => {
    expect(parseNumericCell("Yes")).toBeNull();
    expect(parseNumericCell("No")).toBeNull();
    expect(parseNumericCell("Robot Toy")).toBeNull();
    expect(parseNumericCell("Earth Leviathan")).toBeNull();
    // A leading word means it is a NAME; sorting it by 50 would be wrong.
    expect(parseNumericCell("Version 50")).toBeNull();
    expect(parseNumericCell("")).toBeNull();
    expect(parseNumericCell("—")).toBeNull();
  });
});

/* ---------------------------------------------------------------- */
/* normalizeCellText                                                 */
/* ---------------------------------------------------------------- */

describe("normalizeCellText", () => {
  it("trims and collapses whitespace, including the &nbsp; the engine emits", () => {
    // The fixture really does write "| No" with a leading space.
    expect(normalizeCellText(" No")).toBe("No");
    expect(normalizeCellText("\n  Earth   Leviathan \n")).toBe("Earth Leviathan");
    expect(normalizeCellText("21 lb")).toBe("21 lb");
  });
});

/* ---------------------------------------------------------------- */
/* compareCells                                                      */
/* ---------------------------------------------------------------- */

describe("compareCells", () => {
  it("compares numeric cells by value, not by string", () => {
    // The whole point: "9" must precede "20", which string order reverses.
    expect(compareCells("9", "20")).toBeLessThan(0);
    expect(compareCells("4.73%", "45.00%")).toBeLessThan(0);
    expect(compareCells("123▮", "56▮")).toBeGreaterThan(0);
    expect(compareCells("0 lb", "21 lb")).toBeLessThan(0);
  });

  it("treats a leading space as insignificant", () => {
    expect(compareCells(" No", "No")).toBe(0);
  });

  it("is case-insensitive and number-aware for text cells", () => {
    expect(compareCells("Rubber ducky", "rubber Ducky")).toBe(0);
    expect(compareCells("Level 9", "Level 10")).toBeLessThan(0);
    expect(compareCells("Bracken", "Maneater")).toBeLessThan(0);
  });

  it("ranks numbers before text and text before blanks", () => {
    expect(compareCells("5", "Yes")).toBeLessThan(0);
    expect(compareCells("Yes", "")).toBeLessThan(0);
    expect(compareCells("5", "")).toBeLessThan(0);
  });

  it("breaks a numeric tie by text so the result never depends on input order", () => {
    expect(compareCells("56▮", "56 lb")).toBe(-compareCells("56 lb", "56▮"));
    expect(compareCells("56▮", "56▮")).toBe(0);
  });
});

/* ---------------------------------------------------------------- */
/* orderIndexes — direction, stability, restoration                  */
/* ---------------------------------------------------------------- */

describe("orderIndexes", () => {
  const spawnChance = ["4.73%", " 4.58%", "4.43%", "2.36%"];
  const items = ["Robot Toy", "Painting", "Rubber ducky", "Gold bar"];

  it("sorts the fixture's Spawn Chance column numerically both ways", () => {
    expect(sorted(spawnChance)).toEqual(["2.36%", "4.43%", " 4.58%", "4.73%"]);
    expect(sorted(spawnChance, "descending")).toEqual(["4.73%", " 4.58%", "4.43%", "2.36%"]);
  });

  it("sorts the fixture's Item column alphabetically", () => {
    expect(sorted(items)).toEqual(["Gold bar", "Painting", "Robot Toy", "Rubber ducky"]);
  });

  it("sorts a Weight column by its leading number, ignoring the unit", () => {
    expect(sorted(["21 lb", "31 lb", "0 lb", "8 lb"])).toEqual([
      "0 lb",
      "8 lb",
      "21 lb",
      "31 lb",
    ]);
  });

  it("is stable: equal cells keep their original order in BOTH directions", () => {
    // The fixture's Yes/No columns are almost all ties.
    const stunnable = ["Yes", "Yes", "No", "Yes", " No"];
    expect(orderIndexes(stunnable, "ascending")).toEqual([2, 4, 0, 1, 3]);
    expect(orderIndexes(stunnable, "descending")).toEqual([0, 1, 3, 2, 4]);
  });

  it("puts blanks last ascending and first descending", () => {
    expect(sorted(["3", "", "1"])).toEqual(["1", "3", ""]);
    expect(sorted(["3", "", "1"], "descending")).toEqual(["", "3", "1"]);
  });

  it("`none` restores the original order exactly", () => {
    expect(orderIndexes(spawnChance, "none")).toEqual([0, 1, 2, 3]);
  });

  it("does not mutate its input", () => {
    const values = [...spawnChance];
    orderIndexes(values, "descending");
    expect(values).toEqual(spawnChance);
  });

  it("handles degenerate columns without throwing", () => {
    expect(orderIndexes([], "ascending")).toEqual([]);
    expect(orderIndexes(["only"], "descending")).toEqual([0]);
  });
});

/* ---------------------------------------------------------------- */
/* nextDirection — the three-state cycle                             */
/* ---------------------------------------------------------------- */

describe("nextDirection", () => {
  it("cycles none → ascending → descending → none", () => {
    expect(nextDirection("none")).toBe("ascending");
    expect(nextDirection("ascending")).toBe("descending");
    expect(nextDirection("descending")).toBe("none");
  });
});
