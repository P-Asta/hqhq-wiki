"use client";

import { useEffect, useRef } from "react";

/**
 * Client-side sorting for `table.sortable` inside `.wiki-prose`
 * (Fandom ext §F.2.4 "Tabber, poem, gallery options, sortable tables").
 *
 * PROGRESSIVE ENHANCEMENT. The server renders a perfectly readable table; this
 * island only adds affordances once it hydrates, which is why it stamps
 * `.sortable-ready` on the table — globals.css hangs the sort arrows and the
 * pointer cursor off that class, so a reader without JavaScript never sees a
 * control that does nothing.
 *
 * Everything above `hydrate()` is PURE and exported so it can be unit-tested
 * in the `node` test environment (there is no DOM in the suite).
 *
 * ---------------------------------------------------------------------------
 * HTML CONTRACT (globals.css styles exactly these)
 * ---------------------------------------------------------------------------
 *   table.sortable                  opt-in, as authored in wikitext
 *   table.sortable.sortable-ready   set by this island once hydrated
 *   th[role~="button"][tabindex]    a sortable header (MediaWiki uses the same
 *                                   `role="columnheader button"` pairing, which
 *                                   keeps the header's table semantics AND
 *                                   announces it as activatable)
 *   th[aria-sort=none|ascending|descending]   current state, also the CSS hook
 *   th.unsortable                   a column this island must leave alone
 */

/* ------------------------------------------------------------------ */
/* §F.2.4a Cell values — the pure, testable core                       */
/* ------------------------------------------------------------------ */

/**
 * Leading-number extraction.
 *
 * Real wiki cells wrap their number in units, symbols and prose: `4.73%`,
 * `56▮`, `21 lb`, `$1,234.50`, `~5`, `0 - 9 (avg. 3)`. All of those must sort
 * as their LEADING number, so the pattern allows an optional run of
 * comparison/currency glyphs, then a signed number with optional thousands
 * separators, and simply ignores everything after it.
 *
 * A number that does NOT start the cell (`Version 50`, `Tier 2 moon`) is
 * deliberately not matched: those are names, and sorting them numerically
 * would scramble a text column that happens to contain digits.
 */
const LEADING_NUMBER_RE =
  /^[\s~≈<>≤≥±+]*[$€£¥]?[\s]*([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|[+-]?\.\d+)/;

/**
 * The numeric value of a cell, or `null` when the cell is not numeric.
 * `null` is what routes a value into the text comparator.
 */
export function parseNumericCell(text: string): number | null {
  const m = LEADING_NUMBER_RE.exec(text);
  if (m === null) return null;
  const value = Number((m[1] as string).replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

/** Collapse the whitespace the wikitext renderer leaves inside cells. */
export function normalizeCellText(text: string): string {
  // ` ` (from `&nbsp;`) counts as whitespace here; `\s` does not cover it
  // reliably across engines, so it is listed explicitly.
  return text.replace(/[\s ]+/g, " ").trim();
}

/**
 * Sort rank: numbers first, then text, then blanks.
 *
 * Keeping blanks in their own rank is what stops an empty cell from landing in
 * the middle of a numeric column; the direction flip in {@link orderIndexes}
 * applies to the rank too, so blanks are last ascending and first descending —
 * the same as MediaWiki's `sortable` and simple enough to reason about.
 */
function rankOf(value: string): 0 | 1 | 2 {
  if (value === "") return 2;
  return parseNumericCell(value) === null ? 1 : 0;
}

/**
 * Locale-aware text collation with embedded-number awareness, so `Level 9`
 * precedes `Level 10`. Built once — `Intl.Collator` construction is the
 * expensive part, comparison is not.
 */
const COLLATOR = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

/**
 * Ascending three-way comparison of two RAW cell strings.
 *
 * Pure, total and direction-free: {@link orderIndexes} negates it for a
 * descending pass, and ties are broken there by original position so the sort
 * is stable.
 */
export function compareCells(a: string, b: string): number {
  const left = normalizeCellText(a);
  const right = normalizeCellText(b);

  const rank = rankOf(left) - rankOf(right);
  if (rank !== 0) return rank < 0 ? -1 : 1;

  const leftNumber = parseNumericCell(left);
  const rightNumber = parseNumericCell(right);
  if (leftNumber !== null && rightNumber !== null) {
    if (leftNumber < rightNumber) return -1;
    if (leftNumber > rightNumber) return 1;
    // Equal leading numbers (`56▮` vs `56 lb`): fall through to the text pass
    // so the order stays deterministic instead of depending on input order.
    return COLLATOR.compare(left, right);
  }

  return COLLATOR.compare(left, right);
}

/** The three states a column cycles through on repeated activation. */
export type SortDirection = "ascending" | "descending" | "none";

/** `none → ascending → descending → none` (§F.2.4a). */
export function nextDirection(current: SortDirection): SortDirection {
  if (current === "none") return "ascending";
  return current === "ascending" ? "descending" : "none";
}

/**
 * Order a column's values, returning a PERMUTATION OF INDEXES rather than
 * reordered values — the DOM caller needs the indexes to move `<tr>` elements,
 * and returning them keeps this function free of any DOM knowledge.
 *
 * `"none"` restores the original order, which is what makes the third click
 * cheap and exact rather than an approximation.
 */
export function orderIndexes(
  values: readonly string[],
  direction: SortDirection,
): number[] {
  const indexes = values.map((_, index) => index);
  if (direction === "none") return indexes;
  const sign = direction === "ascending" ? 1 : -1;
  return indexes.sort((a, b) => {
    const cmp = compareCells(values[a] as string, values[b] as string);
    // Stable: equal cells keep their original relative order in BOTH
    // directions (the tiebreak is not negated).
    return cmp === 0 ? a - b : sign * cmp;
  });
}

/* ------------------------------------------------------------------ */
/* §F.2.4b DOM hydration                                               */
/* ------------------------------------------------------------------ */

/**
 * A table is skipped entirely when a merged cell makes "row N, column C"
 * ambiguous — reordering rows under a `rowspan` would visibly corrupt the
 * table, so bailing out is the only correct behavior. Also honors the explicit
 * `class="unsortable"` opt-out.
 */
function isSortable(table: HTMLTableElement): boolean {
  if (table.classList.contains("unsortable")) return false;
  return table.querySelector("td[rowspan], td[colspan], th[rowspan], th[colspan]") === null;
}

/** Rows whose every cell is a `<th>` — the header row(s) of an engine table. */
function isHeaderRow(row: HTMLTableRowElement): boolean {
  const cells = Array.from(row.cells);
  return cells.length > 0 && cells.every((cell) => cell.tagName === "TH");
}

/**
 * A cell's sort key. `data-sort-value` wins when an author supplied one (the
 * MediaWiki convention, and the escape hatch for dates and other formats this
 * island does not model); otherwise the rendered text is used, so `[[Robot
 * toy|Robot Toy]]` sorts as "Robot Toy" and not as its markup.
 */
function cellKey(row: HTMLTableRowElement, column: number): string {
  const cell = row.cells[column];
  if (cell === undefined) return "";
  const override = cell.getAttribute("data-sort-value");
  return override !== null ? override : (cell.textContent ?? "");
}

interface Hydrated {
  destroy: () => void;
}

function hydrateTable(table: HTMLTableElement): Hydrated | null {
  if (!isSortable(table)) return null;

  const allRows = Array.from(table.rows);
  const headerIndex = allRows.findIndex(isHeaderRow);
  if (headerIndex === -1) return null;
  const header = allRows[headerIndex] as HTMLTableRowElement;

  const bodyRows = allRows.slice(headerIndex + 1).filter((row) => !isHeaderRow(row));
  if (bodyRows.length < 2) return null;

  // The original order is captured ONCE, before any sorting, so the "none"
  // state is a restoration and not a re-derivation.
  const originalOrder = [...bodyRows];
  const parent = originalOrder[0]?.parentElement ?? null;
  if (parent === null) return null;

  const headers = Array.from(header.cells).filter(
    (cell) => !cell.classList.contains("unsortable"),
  );
  if (headers.length === 0) return null;

  const cleanups: (() => void)[] = [];
  let activeColumn = -1;
  let direction: SortDirection = "none";

  const apply = () => {
    const order =
      activeColumn === -1
        ? originalOrder.map((_, i) => i)
        : orderIndexes(
            originalOrder.map((row) => cellKey(row, activeColumn)),
            direction,
          );
    // A DocumentFragment keeps this to a single reflow no matter how many rows
    // move, and appending an already-attached node moves it (no clone, so
    // event handlers and selection inside cells survive).
    const fragment = document.createDocumentFragment();
    for (const index of order) fragment.appendChild(originalOrder[index] as HTMLTableRowElement);
    parent.appendChild(fragment);
  };

  headers.forEach((cell) => {
    const column = cell.cellIndex;
    const previousRole = cell.getAttribute("role");
    const previousTabIndex = cell.getAttribute("tabindex");

    cell.setAttribute("role", "columnheader button");
    cell.setAttribute("tabindex", "0");
    cell.setAttribute("aria-sort", "none");

    const activate = () => {
      direction = column === activeColumn ? nextDirection(direction) : "ascending";
      // Clear the previous column's state before adopting the new one, so at
      // most one `aria-sort` is ever non-`none` (an ARIA requirement).
      for (const other of headers) other.setAttribute("aria-sort", "none");
      if (direction === "none") {
        activeColumn = -1;
      } else {
        activeColumn = column;
        cell.setAttribute("aria-sort", direction);
      }
      apply();
    };

    const onClick = () => activate();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
      // Space would scroll the page; the header is acting as a button here.
      event.preventDefault();
      activate();
    };

    cell.addEventListener("click", onClick);
    cell.addEventListener("keydown", onKeyDown);
    cleanups.push(() => {
      cell.removeEventListener("click", onClick);
      cell.removeEventListener("keydown", onKeyDown);
      cell.removeAttribute("aria-sort");
      if (previousRole === null) cell.removeAttribute("role");
      else cell.setAttribute("role", previousRole);
      if (previousTabIndex === null) cell.removeAttribute("tabindex");
      else cell.setAttribute("tabindex", previousTabIndex);
    });
  });

  table.classList.add("sortable-ready");

  return {
    destroy: () => {
      for (const cleanup of cleanups) cleanup();
      activeColumn = -1;
      direction = "none";
      apply();
      table.classList.remove("sortable-ready");
    },
  };
}

/**
 * Mounts once from `WikiHtml`. Renders an inert marker element rather than
 * `null` so the effect can scope its query to the same container as the
 * article HTML instead of reaching across the whole document.
 */
export function SortableTables() {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const scope = ref.current?.parentElement;
    if (!scope) return;
    const tables = scope.querySelectorAll<HTMLTableElement>(".wiki-prose table.sortable");
    const hydrated: Hydrated[] = [];
    for (const table of tables) {
      const instance = hydrateTable(table);
      if (instance !== null) hydrated.push(instance);
    }
    return () => {
      for (const instance of hydrated) instance.destroy();
    };
  }, []);

  return <span hidden ref={ref} />;
}
