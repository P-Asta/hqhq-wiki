/**
 * **Dragging something into a new place, and the gap that opens for it**
 * (user direction, 2026-09-05: "let inner elements be dragged too, and animate
 * the move — the element goes to the mouse, and the slot it will fill empties
 * out as it moves").
 *
 * The arithmetic of that, for all three things this editor can reorder:
 * blocks down the page, a table's rows, and a table's columns. It is one
 * module because it is one question asked along one axis — *which slot is the
 * pointer over, and how far does everything else have to move to make room* —
 * and three copies of that question is three places for the drop indicator and
 * the drop to disagree.
 *
 * Everything here is pure and measured in **document** coordinates for the
 * vertical axes and **viewport** ones for the horizontal, which is the caller's
 * business rather than this module's: it is handed extents and a pointer, and
 * it does not care what they were measured against as long as they agree.
 *
 * Nothing in here touches the DOM, which is the point — `ve-selection.test.ts`
 * can assert a drop lands where the indicator promised without a pointer, and
 * the surface can be trusted to draw what this decides.
 */

/** One item's extent along the axis being dragged, in the caller's units. */
export interface SortExtent {
  /** Leading edge — the top of a row, the left of a column. */
  start: number;
  /** Trailing edge. */
  end: number;
}

/**
 * Which **slot** the pointer is over: 0…n-1, the index the dragged item would
 * take if it were dropped now.
 *
 * Slot rather than *gap* semantics, deliberately. A gap ("insert before item
 * i", 0…n) is the right shape for `moveBlockRun`, and it is what
 * {@link sortGap} converts to — but it is the wrong shape for the animation,
 * because a gap has no size and the thing that has to open is an item-sized
 * hole. Asking "which item is the pointer over" once, and deriving the gap
 * from it, keeps the picture and the move computed from the same answer.
 *
 * An item's slot is claimed from its **midpoint**, so the answer flips when
 * the pointer passes the middle of a neighbour rather than when it clears the
 * whole of it — otherwise a tall block could never be dragged past a short one
 * without overshooting it entirely.
 *
 * Past either end the nearest slot wins: a pointer above the first item is
 * dropping at 0, and one below the last is dropping at n-1. There is nowhere
 * else for it to mean.
 */
export function sortTargetIndex(extents: readonly SortExtent[], pointer: number): number {
  if (extents.length === 0) return -1;
  for (let i = 0; i < extents.length; i += 1) {
    const extent = extents[i];
    if (pointer < (extent.start + extent.end) / 2) return i;
  }
  return extents.length - 1;
}

/**
 * The **gap** a slot means to a mover that inserts before an index —
 * `moveBlockRun`'s vocabulary, and `blockMoveTarget`'s.
 *
 * Moving *down*, the item has to land one past its target, because the target
 * itself is still in front of it when the move is computed; moving up it lands
 * exactly on it. Getting this backwards is a move that goes one place too far
 * in one direction and looks right in the other, which is the sort of thing
 * only arithmetic catches.
 */
export function sortGap(from: number, to: number): number {
  return to > from ? to + 1 : to;
}

/**
 * How far the item at `index` must be translated while `from` is on its way to
 * `to` — the "slot empties out" half of the animation.
 *
 * Everything the dragged item passes moves one item-size the *other* way, so
 * the run closes up behind it and an item-sized hole opens at the destination.
 * The dragged item itself is not shifted: it is following the pointer, which
 * is the caller's job and not this one's.
 *
 * `size` is the dragged item's own extent along the axis, so the hole is
 * exactly the shape of the thing that will fill it. That is what makes the
 * animation read as *this* block moving rather than as the page reflowing:
 * nothing changes size, and the gap that opens is the one being aimed at.
 */
export function sortShift(from: number, to: number, index: number, size: number): number {
  if (index === from || from === to) return 0;
  if (from < to) return index > from && index <= to ? -size : 0;
  return index >= to && index < from ? size : 0;
}

/**
 * The extent of the slot the drop will land in, once everything has shifted —
 * where the dragged item comes to rest.
 *
 * Used for the settle: the pointer is released wherever it happens to be, and
 * the item animates from there into its slot rather than snapping. Without it
 * a drop reads as a jump, and the author cannot tell whether it landed where
 * they meant.
 */
export function sortLandingStart(
  extents: readonly SortExtent[],
  from: number,
  to: number,
): number | null {
  const dragged = extents[from];
  const target = extents[to];
  if (dragged === undefined || target === undefined) return null;
  if (from === to) return dragged.start;
  const size = dragged.end - dragged.start;
  // Moving down, the item's leading edge ends up a size back from the target's
  // trailing edge — everything between has closed up in front of it. Moving up
  // it simply takes the target's own leading edge.
  return from < to ? target.end - size : target.start;
}
