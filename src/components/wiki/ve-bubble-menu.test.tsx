/**
 * The bubble menu, tested where it is decidable — the placement arithmetic, and
 * the markup one render produces.
 *
 * Two halves, for two reasons.
 *
 * `bubblePosition` is the whole of "where does the bar go", and every case that
 * matters is an edge of the viewport: no room above, no room below, a selection
 * running off the left or the right, a selection taller than the window. Those
 * are miserable to arrange in a browser and trivial to state as numbers, which
 * is exactly why the function takes plain rectangles and returns a point.
 *
 * The component is checked with `renderToStaticMarkup`, the way
 * version-chips.test.tsx does it (vitest runs in a node environment, so static
 * HTML is the whole surface). That reaches the three claims a static render can
 * settle: the marks report the selection's state, "turn into" names the block
 * the caret is in, and a null rect draws nothing whatsoever. What it cannot
 * reach is the file's load-bearing line — the cancelled `mousedown` — because a
 * handler leaves no trace in HTML; that one is asserted by the comment beside
 * it and by the editor's own integration.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { VeBlockFormat } from "@/lib/visual-editor/actions";
import type { VeMark } from "@/lib/visual-editor/model";

import { VeBubbleMenu, bubblePosition, type BubbleMenuLabels } from "./ve-bubble-menu";

/** A plausible bar and a plausible window, so the numbers below read as pixels. */
const BAR = { width: 240, height: 36 };
const VIEW = { width: 1000, height: 800 };

/** The module's own gap and margin — both 8, and both load-bearing here. */
const GAP = 8;
const MARGIN = 8;

/** A selection in the middle of the page: room on every side. */
const MIDDLE = { top: 300, bottom: 320, left: 400, right: 600 };

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("bubblePosition", () => {
  it("centres the bar over the selection and floats it above", () => {
    // centre 500 − half a bar, and one gap clear of the selection's top edge.
    expect(bubblePosition(MIDDLE, BAR, VIEW)).toEqual({
      top: MIDDLE.top - GAP - BAR.height,
      left: 500 - BAR.width / 2,
    });
  });

  it("flips below the selection when there is no room above", () => {
    const high = { ...MIDDLE, top: 20, bottom: 44 };
    expect(bubblePosition(high, BAR, VIEW).top).toBe(44 + GAP);
  });

  it("stays above while the bar still clears the top margin, and flips one pixel later", () => {
    // A bar sitting exactly on the margin is still on screen, so it stays put.
    const exact = { ...MIDDLE, top: MARGIN + BAR.height + GAP, bottom: 200 };
    expect(bubblePosition(exact, BAR, VIEW).top).toBe(MARGIN);

    const oneLess = { ...exact, top: exact.top - 1 };
    expect(bubblePosition(oneLess, BAR, VIEW).top).toBe(200 + GAP);
  });

  it("keeps a low selection's bar above it rather than off the bottom", () => {
    const low = { ...MIDDLE, top: 700, bottom: 780 };
    expect(bubblePosition(low, BAR, VIEW).top).toBe(700 - GAP - BAR.height);
  });

  it("clamps to the left margin for a selection at the left edge", () => {
    const leftmost = { ...MIDDLE, left: 0, right: 20 };
    expect(bubblePosition(leftmost, BAR, VIEW).left).toBe(MARGIN);
  });

  it("clamps to the right margin for a selection at the right edge", () => {
    const rightmost = { ...MIDDLE, left: 980, right: 1000 };
    expect(bubblePosition(rightmost, BAR, VIEW).left).toBe(VIEW.width - MARGIN - BAR.width);
  });

  it("clamps to the bottom margin when neither side has room", () => {
    // A selection running from the top of the window nearly to the bottom: no
    // room above it, and below it would leave the window entirely.
    const tall = { ...MIDDLE, top: 4, bottom: 790 };
    expect(bubblePosition(tall, BAR, VIEW).top).toBe(VIEW.height - MARGIN - BAR.height);
  });

  it("keeps the bar on screen for a selection taller than the viewport", () => {
    // Both edges are outside the window — the bar must not follow either of
    // them out of sight, and it must still be centred over what is visible.
    const overflowing = { top: -500, bottom: 1300, left: 400, right: 600 };
    expect(bubblePosition(overflowing, BAR, VIEW)).toEqual({
      top: VIEW.height - MARGIN - BAR.height,
      left: 500 - BAR.width / 2,
    });
  });

  it("pins a bar wider than the window to the left edge", () => {
    // It cannot fit, so it overflows the readable way: the first control stays
    // reachable rather than the last.
    expect(bubblePosition(MIDDLE, { width: 1200, height: 36 }, VIEW).left).toBe(MARGIN);
  });

  it("pins a bar taller than the window to the top edge", () => {
    expect(bubblePosition(MIDDLE, { width: 240, height: 900 }, VIEW).top).toBe(MARGIN);
  });
});

/* ------------------------------------------------------------------ */
/* Markup                                                              */
/* ------------------------------------------------------------------ */

const LABELS: BubbleMenuLabels = {
  toolbarLabel: "Selection formatting",
  bold: "Bold",
  italic: "Italic",
  underline: "Underline",
  strikethrough: "Strikethrough",
  code: "Computer code",
  link: "Link",
  clearFormatting: "Clear formatting",
  turnInto: "Turn into",
  formats: {
    paragraph: "Normal text",
    h2: "Heading",
    h3: "Sub-heading 1",
    pre: "Preformatted",
  },
};

const FORMATS: readonly VeBlockFormat[] = ["paragraph", "h2", "h3", "pre"];

function render(props: {
  rect?: { top: number; left: number; right: number; bottom: number } | null;
  marks?: readonly VeMark[];
  format?: VeBlockFormat;
  formats?: readonly VeBlockFormat[];
  labels?: BubbleMenuLabels;
}): string {
  return renderToStaticMarkup(
    <VeBubbleMenu
      rect={props.rect === undefined ? MIDDLE : props.rect}
      activeMarks={props.marks ?? []}
      currentFormat={props.format ?? "paragraph"}
      formats={props.formats ?? FORMATS}
      labels={props.labels ?? LABELS}
      onAction={() => {}}
    />,
  );
}

describe("VeBubbleMenu", () => {
  it("draws nothing at all without a selection rect", () => {
    // Not an empty toolbar for a screen reader to announce: nothing.
    expect(render({ rect: null })).toBe("");
  });

  it("offers the marks, the link and clear formatting, and nothing else", () => {
    const html = render({});
    expect(html).toContain(`aria-label="${LABELS.toolbarLabel}"`);
    expect(html).toContain('role="toolbar"');
    for (const label of [
      LABELS.bold,
      LABELS.italic,
      LABELS.underline,
      LABELS.strikethrough,
      LABELS.code,
      LABELS.link,
      LABELS.clearFormatting,
    ]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    // Five marks, two acts, one menu trigger — eight controls, no more. A ninth
    // would mean the bubble had started growing back into a second toolbar.
    expect(occurrences(html, 'type="button"')).toBe(8);
  });

  it("renders the marks under the selection pressed, and only those", () => {
    const html = render({ marks: ["bold", "code"] });
    expect(occurrences(html, 'aria-pressed="true"')).toBe(2);
    expect(occurrences(html, 'aria-pressed="false"')).toBe(3);
    // The link and clear formatting are acts, not states: no pressed attribute
    // at all, or a screen reader would announce them as toggles.
    expect(occurrences(html, "aria-pressed")).toBe(5);
  });

  it("names the caret's own block on the turn-into control", () => {
    const html = render({ format: "h3" });
    expect(html).toContain(`aria-label="${LABELS.turnInto}"`);
    // The face, and only the face: the panel is closed, so the rows that would
    // repeat these names are not rendered.
    expect(occurrences(html, "Sub-heading 1")).toBe(1);
    expect(html).not.toContain("Normal text");
    expect(html).toContain('aria-expanded="false"');
  });

  it("falls back to the control's own name for a format the dictionary skipped", () => {
    // h4 is offered nowhere in LABELS.formats; the face must still read as
    // something rather than as an empty box.
    const html = render({ format: "h4", formats: ["paragraph", "h4"] });
    expect(occurrences(html, LABELS.turnInto)).toBeGreaterThan(0);
    expect(html).toContain(`aria-label="${LABELS.turnInto}"`);
  });

  it("drops the turn-into control where no format is offered", () => {
    const html = render({ formats: [] });
    expect(html).not.toContain(LABELS.turnInto);
    expect(html).not.toContain('aria-haspopup="menu"');
    // The marks and the two acts stay; only the menu is gone.
    expect(occurrences(html, 'type="button"')).toBe(7);
  });

  it("parks the bar at the selection, invisibly, until it has been measured", () => {
    // Server-rendered there is no layout, so `bubblePosition` has no bar size
    // to work from: the bar must not be drawn in the wrong place and snapped.
    const html = render({});
    expect(html).toContain("opacity-0");
    expect(html).toContain("pointer-events-none");
    expect(html).toContain(`top:${MIDDLE.top}px`);
    expect(html).toContain(`left:${MIDDLE.left}px`);
  });

  it("draws itself in tokens, never in a palette colour", () => {
    const html = render({ marks: ["bold"] });
    expect(html).toContain("bg-surface");
    expect(html).toContain("border-hairline");
    expect(html).toContain("shadow-[var(--shadow-md)]");
    expect(html).toContain("bg-canvas-soft-2");
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
