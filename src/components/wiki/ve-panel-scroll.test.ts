/**
 * A wheel's units (user report, 2026-09-05).
 *
 * The hook around this reads a wheel that landed beside a panel's list and
 * scrolls that list by hand, because the alternative — letting the delta reach
 * the page — is what dismisses a menu anchored to a caret or a pointer. Which
 * makes the *units* load-bearing: a mouse wheel under Firefox, and on Windows
 * generally, reports lines rather than pixels, and a `deltaY` of 3 added to
 * `scrollTop` unchanged would move the list three pixels and read as a list
 * that does not scroll at all.
 */

import { describe, expect, it } from "vitest";

import { wheelDeltaPixels } from "./ve-panel-scroll";

/** The scroller's own height, which is what a "page" of wheel means. */
const VIEWPORT = 320;

describe("wheelDeltaPixels", () => {
  it("passes a pixel delta through untouched", () => {
    expect(wheelDeltaPixels({ deltaY: 120, deltaMode: 0 }, VIEWPORT)).toBe(120);
  });

  it("turns a line delta into pixels, so a mouse wheel moves a whole row", () => {
    const moved = wheelDeltaPixels({ deltaY: 3, deltaMode: 1 }, VIEWPORT);
    expect(moved).toBe(48);
    // The bar it has to clear: one notch has to be worth more than a row of
    // the list, or scrolling looks broken rather than slow.
    expect(moved).toBeGreaterThan(30);
  });

  it("measures a page delta against the list, not against the window", () => {
    expect(wheelDeltaPixels({ deltaY: 1, deltaMode: 2 }, VIEWPORT)).toBe(VIEWPORT);
  });

  it("keeps the direction in every mode", () => {
    expect(wheelDeltaPixels({ deltaY: -120, deltaMode: 0 }, VIEWPORT)).toBeLessThan(0);
    expect(wheelDeltaPixels({ deltaY: -3, deltaMode: 1 }, VIEWPORT)).toBeLessThan(0);
    expect(wheelDeltaPixels({ deltaY: -1, deltaMode: 2 }, VIEWPORT)).toBeLessThan(0);
  });

  it("moves nothing for a wheel that reported nothing", () => {
    expect(wheelDeltaPixels({ deltaY: 0, deltaMode: 1 }, VIEWPORT)).toBe(0);
  });
});
