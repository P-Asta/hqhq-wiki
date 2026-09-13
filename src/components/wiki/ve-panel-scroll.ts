"use client";

/**
 * **A floating panel's wheel never reaches the page** (user report, 2026-09-05:
 * "whether it came from a right-click or from `/`, once the menu's scroll hits
 * its limit the whole page scrolls — and that is what makes the menu vanish").
 *
 * Both menus are `position: fixed` and anchored to something the page can move
 * away from: the slash menu to the caret, the right-click menu to the pointer.
 * Neither can follow a scroll, so the surface closes them when the page moves
 * (`visual-editor.tsx`). That is right when the author scrolls the article —
 * and wrong every time the page moved only because the *panel* ran out of list.
 *
 * The fix is two halves, and this is the second:
 *
 * 1. `overscroll-contain` on the scroller (a stylesheet rule) stops the wheel
 *    at the ends of a list that **can** scroll, so the leftover delta is not
 *    passed up to the page.
 * 2. This hook covers the case that rule cannot: a list with nothing to scroll
 *    at all — three matching rows, a short block menu — where the browser hands
 *    the wheel straight to the page and the menu disappears under a gesture
 *    that never moved anything inside it.
 *
 * It also scrolls the list for a wheel that landed **beside** it: the slash
 * menu's heading is inside the panel but outside its `<ul>`, and a wheel there
 * would otherwise scroll nothing and dismiss everything.
 *
 * `wheel` is registered by hand rather than through JSX because React attaches
 * it **passively** at the root, where `preventDefault` does nothing at all.
 */

import { useEffect, type RefObject } from "react";

/** Marks the element inside a panel that owns the scrollbar. */
export const PANEL_SCROLLER_ATTR = "data-ve-scroller";

/** One line, in pixels, for a wheel that reports its delta in lines. */
const LINE_HEIGHT = 16;

/**
 * A wheel's delta in **pixels**, whatever unit it arrived in — exported
 * because the units are the part that is silently wrong.
 *
 * `deltaMode` is 0 (pixels) on most trackpads and 1 (lines) on a mouse wheel
 * under Firefox and on Windows, where `deltaY` is about 3. Adding that to
 * `scrollTop` unchanged moves the list three pixels and reads as a menu that
 * does not scroll — the very complaint this file answers, one layer down.
 * Mode 2 is pages, which is the scroller's own height.
 */
export function wheelDeltaPixels(
  event: Pick<WheelEvent, "deltaY" | "deltaMode">,
  viewport: number,
): number {
  if (event.deltaMode === 1) return event.deltaY * LINE_HEIGHT;
  if (event.deltaMode === 2) return event.deltaY * viewport;
  return event.deltaY;
}

/**
 * `shown` is what tells the effect the panel is on screen. A ref is stable, so
 * without it the listener would be attached once — on a mount where a panel
 * that is drawn conditionally has not rendered its element yet, and never
 * again once it had.
 */
export function useContainedWheel(panelRef: RefObject<HTMLElement | null>, shown = true): void {
  useEffect(() => {
    const panel = shown ? panelRef.current : null;
    if (panel === null) return;

    const onWheel = (event: WheelEvent): void => {
      // The scroller is named rather than guessed: an element with `overflow:
      // visible` can have a `scrollHeight` past its `clientHeight` and still
      // not scroll, so measuring alone would pick the wrong box.
      const scroller =
        panel.hasAttribute(PANEL_SCROLLER_ATTR)
          ? panel
          : panel.querySelector<HTMLElement>(`[${PANEL_SCROLLER_ATTR}]`);
      if (scroller === null || scroller.scrollHeight <= scroller.clientHeight) {
        // Nothing here can move, so nothing should: without this the page
        // takes the wheel, and the page moving is what closes this panel.
        event.preventDefault();
        return;
      }
      if (event.target instanceof Node && scroller.contains(event.target)) {
        // The list is under the pointer and can move: leave it to the browser,
        // whose `overscroll-contain` already stops the delta at either end.
        return;
      }
      event.preventDefault();
      scroller.scrollTop += wheelDeltaPixels(event, scroller.clientHeight);
    };

    panel.addEventListener("wheel", onWheel, { passive: false });
    return () => panel.removeEventListener("wheel", onWheel);
  }, [panelRef, shown]);
}
