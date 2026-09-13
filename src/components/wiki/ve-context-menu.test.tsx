/**
 * The right-click menu's two pure decisions (user direction, 2026-09-05).
 *
 * `contextMenuPosition` is the one that goes wrong in the wild: a menu opened
 * near an edge of the window has to come back on screen, and it has to do it by
 * flipping about the pointer rather than by sliding out from under it — a panel
 * left under the finger arms its first row before that finger has moved.
 * `contextMenuHeight` is what the flip is decided against, so the two are
 * tested together.
 */

import { describe, expect, it } from "vitest";

import {
  CONTEXT_MENU_WIDTH,
  contextMenuHeight,
  contextMenuPosition,
  type VeContextRow,
} from "./ve-context-menu";

const VIEWPORT = { width: 1200, height: 800 };

function rows(count: number, extra: Partial<VeContextRow> = {}): VeContextRow[] {
  return Array.from({ length: count }, (_unused, index) => ({
    key: `row-${index}`,
    label: `Row ${index}`,
    onSelect: () => undefined,
    ...extra,
  }));
}

describe("contextMenuHeight", () => {
  it("grows with the rows", () => {
    expect(contextMenuHeight(rows(2))).toBeLessThan(contextMenuHeight(rows(8)));
  });

  it("counts the rules and the headings, which take room of their own", () => {
    const plain = contextMenuHeight(rows(4));
    expect(contextMenuHeight(rows(4, { startsGroup: true }))).toBeGreaterThan(plain);
    expect(contextMenuHeight(rows(4, { heading: "Turn into" }))).toBeGreaterThan(plain);
  });

  it("stops growing where the panel starts scrolling", () => {
    // Otherwise a table's twelve operations plus a block's rows would compute a
    // panel taller than the window and be flipped off the top of it.
    expect(contextMenuHeight(rows(200))).toBe(contextMenuHeight(rows(400)));
    expect(contextMenuHeight(rows(200))).toBeLessThanOrEqual(VIEWPORT.height);
  });
});

describe("contextMenuPosition", () => {
  const panel = { width: CONTEXT_MENU_WIDTH, height: 200 };

  it("hangs down and to the right of the pointer, where there is room", () => {
    expect(contextMenuPosition({ top: 100, left: 200 }, panel, VIEWPORT)).toEqual({
      top: 100,
      left: 200,
    });
  });

  it("flips above the pointer rather than sliding up the screen", () => {
    // Sliding would leave the panel *under* the pointer, so the row the author
    // has not aimed at yet would be the one their finger is resting on.
    const at = { top: 700, left: 200 };
    const placed = contextMenuPosition(at, panel, VIEWPORT);
    expect(placed.top).toBe(at.top - panel.height);
    expect(placed.top + panel.height).toBeLessThanOrEqual(at.top);
  });

  it("flips to the left of the pointer at the right-hand edge", () => {
    const at = { top: 100, left: 1150 };
    const placed = contextMenuPosition(at, panel, VIEWPORT);
    expect(placed.left).toBe(at.left - panel.width);
    expect(placed.left + panel.width).toBeLessThanOrEqual(VIEWPORT.width);
  });

  it("flips in both directions at once in the bottom-right corner", () => {
    const at = { top: 780, left: 1190 };
    const placed = contextMenuPosition(at, panel, VIEWPORT);
    expect(placed.top).toBe(at.top - panel.height);
    expect(placed.left).toBe(at.left - panel.width);
  });

  it("clamps rather than flipping a panel that fits in neither direction", () => {
    // At that size the viewport is the constraint and no flip helps; staying
    // where the author is looking beats moving somewhere they are not.
    const tall = { width: CONTEXT_MENU_WIDTH, height: 780 };
    const placed = contextMenuPosition({ top: 600, left: 200 }, tall, VIEWPORT);
    expect(placed.top).toBeGreaterThanOrEqual(0);
    expect(placed.top + tall.height).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it("never leaves the panel off the top or the left of the window", () => {
    const placed = contextMenuPosition({ top: 0, left: 0 }, panel, VIEWPORT);
    expect(placed.top).toBeGreaterThan(0);
    expect(placed.left).toBeGreaterThan(0);
  });
});
