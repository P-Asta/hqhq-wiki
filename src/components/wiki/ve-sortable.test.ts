/**
 * The drag's arithmetic (user direction, 2026-09-05).
 *
 * These four functions decide the two things an author actually sees — where
 * the hole opens while they drag, and where the item lands when they let go —
 * and the failure mode that matters is the two disagreeing. So the assertions
 * are mostly about *agreement*: a shift computed for the destination must
 * describe the same arrangement the move produces.
 */

import { describe, expect, it } from "vitest";

import {
  sortGap,
  sortLandingStart,
  sortShift,
  sortTargetIndex,
  type SortExtent,
} from "./ve-sortable";

/** Four items, 20 tall, stacked with no gaps: 0–20, 20–40, 40–60, 60–80. */
const STACK: SortExtent[] = [
  { start: 0, end: 20 },
  { start: 20, end: 40 },
  { start: 40, end: 60 },
  { start: 60, end: 80 },
];

/** What an array looks like after moving `from` onto slot `to`. */
function moved<T>(items: readonly T[], from: number, to: number): T[] {
  const out = items.slice();
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

describe("sortTargetIndex", () => {
  it("claims a slot from its midpoint, not from its whole extent", () => {
    // Otherwise a tall block could never be dragged past a short one without
    // overshooting it completely.
    expect(sortTargetIndex(STACK, 9)).toBe(0);
    expect(sortTargetIndex(STACK, 11)).toBe(1);
    expect(sortTargetIndex(STACK, 29)).toBe(1);
    expect(sortTargetIndex(STACK, 31)).toBe(2);
  });

  it("takes the nearest slot past either end", () => {
    expect(sortTargetIndex(STACK, -500)).toBe(0);
    expect(sortTargetIndex(STACK, 500)).toBe(3);
  });

  it("has no answer for nothing to sort", () => {
    expect(sortTargetIndex([], 10)).toBe(-1);
  });

  it("reads items of different sizes by their own middles", () => {
    const ragged: SortExtent[] = [
      { start: 0, end: 100 },
      { start: 100, end: 120 },
    ];
    expect(sortTargetIndex(ragged, 49)).toBe(0);
    expect(sortTargetIndex(ragged, 51)).toBe(1);
    expect(sortTargetIndex(ragged, 109)).toBe(1);
  });
});

describe("sortGap", () => {
  it("lands one past the target going down, and on it going up", () => {
    // The target is still in front of the dragged item when a downward move is
    // computed; getting this backwards goes one place too far in one direction
    // and looks perfectly right in the other.
    expect(sortGap(0, 2)).toBe(3);
    expect(sortGap(3, 1)).toBe(1);
    expect(sortGap(1, 1)).toBe(1);
  });

  it("describes the same arrangement a slot move produces", () => {
    const items = ["a", "b", "c", "d"];
    for (let from = 0; from < items.length; from += 1) {
      for (let to = 0; to < items.length; to += 1) {
        // `moveBlockRun`'s reading of a gap: take the item out, then insert it
        // before whatever is at `gap` in the ORIGINAL array.
        const gap = sortGap(from, to);
        const rest = items.filter((_unused, index) => index !== from);
        const before = gap > from ? gap - 1 : gap;
        const byGap = [...rest.slice(0, before), items[from], ...rest.slice(before)];
        expect(byGap).toEqual(moved(items, from, to));
      }
    }
  });
});

describe("sortShift", () => {
  it("moves everything the dragged item passes the other way", () => {
    // Dragging item 0 down onto slot 2: 1 and 2 come back one place each, and
    // the hole that opens is where 0 will sit.
    expect(sortShift(0, 2, 1, 20)).toBe(-20);
    expect(sortShift(0, 2, 2, 20)).toBe(-20);
    expect(sortShift(0, 2, 3, 20)).toBe(0);
  });

  it("moves them forward when the drag goes the other way", () => {
    expect(sortShift(3, 1, 1, 20)).toBe(20);
    expect(sortShift(3, 1, 2, 20)).toBe(20);
    expect(sortShift(3, 1, 0, 20)).toBe(0);
  });

  it("never shifts the item being dragged — it is following the pointer", () => {
    expect(sortShift(0, 3, 0, 20)).toBe(0);
    expect(sortShift(3, 0, 3, 20)).toBe(0);
  });

  it("shifts nothing at all while the drag is over its own slot", () => {
    for (let index = 0; index < 4; index += 1) {
      expect(sortShift(2, 2, index, 20)).toBe(0);
    }
  });

  it("opens exactly one item-sized hole, wherever it is aimed", () => {
    // The invariant behind the picture: every other item moves by 0 or by one
    // size, and the number that move is the distance travelled.
    for (let from = 0; from < 4; from += 1) {
      for (let to = 0; to < 4; to += 1) {
        let shifted = 0;
        for (let index = 0; index < 4; index += 1) {
          const shift = sortShift(from, to, index, 20);
          expect(Math.abs(shift)).toBeLessThanOrEqual(20);
          if (shift !== 0) shifted += 1;
        }
        expect(shifted).toBe(Math.abs(to - from));
      }
    }
  });
});

describe("sortLandingStart", () => {
  it("settles on the target's own leading edge going up", () => {
    expect(sortLandingStart(STACK, 3, 1)).toBe(20);
  });

  it("settles a size back from the target's trailing edge going down", () => {
    // Everything between has closed up in front of it, so the item's leading
    // edge is one size short of where the target used to end.
    expect(sortLandingStart(STACK, 0, 2)).toBe(40);
  });

  it("stays put over its own slot", () => {
    expect(sortLandingStart(STACK, 2, 2)).toBe(40);
  });

  it("is where the item really ends up, for every move and every size", () => {
    // Checked against the arrangement itself rather than against the formula:
    // lay the items out in their new order and read off where the dragged one
    // starts. Ragged sizes are the case that separates a right answer from a
    // plausible one — with four equal items, "the target's leading edge" and
    // "a size back from its trailing edge" are the same number.
    const ragged: SortExtent[] = [];
    let at = 0;
    for (const size of [10, 40, 20, 30]) {
      ragged.push({ start: at, end: at + size });
      at += size;
    }

    for (const extents of [STACK, ragged]) {
      const sizes = extents.map((extent) => extent.end - extent.start);
      for (let from = 0; from < extents.length; from += 1) {
        for (let to = 0; to < extents.length; to += 1) {
          const order = moved(
            extents.map((_unused, index) => index),
            from,
            to,
          );
          let start = extents[0].start;
          for (const index of order) {
            if (index === from) break;
            start += sizes[index];
          }
          expect(sortLandingStart(extents, from, to)).toBe(start);
        }
      }
    }
  });

  it("agrees with the shifts about which way the run closed up", () => {
    // The other half of the same picture: every item the drag passed has moved
    // by one dragged-size, and the landing sits in the hole that leaves.
    const size = 20;
    for (let from = 0; from < STACK.length; from += 1) {
      for (let to = 0; to < STACK.length; to += 1) {
        const landing = sortLandingStart(STACK, from, to);
        const occupied = STACK.map((extent, index) =>
          index === from ? null : extent.start + sortShift(from, to, index, size),
        ).filter((value): value is number => value !== null);
        expect(occupied).not.toContain(landing);
      }
    }
  });

  it("has no answer for an index that is not there", () => {
    expect(sortLandingStart(STACK, 9, 1)).toBeNull();
    expect(sortLandingStart(STACK, 1, 9)).toBeNull();
  });
});
