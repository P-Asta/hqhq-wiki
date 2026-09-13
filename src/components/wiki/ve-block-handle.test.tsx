/**
 * The gutter handle, tested where it is static and where it is arithmetic.
 *
 * Two halves, for two different reasons:
 *
 * 1. **The rows the menu offers** are arithmetic over labels, so "a table does
 *    not offer to become a heading" and "the first block cannot move up" can be
 *    asserted without a browser. (The *drag's* arithmetic moved to
 *    `ve-sortable.test.ts` on 2026-09-05, where the table's rows and columns
 *    are tested with it — one axis, one set of sums.)
 * 2. **The markup claims are the ones the file exists to keep.** The two
 *    controls are real buttons with names, neither carries `draggable` (§3.4 —
 *    the drag is pointer events now), and a null anchor renders *nothing* — an
 *    empty gutter is not a hidden handle, it is no handle, because anything
 *    left behind would be a control floating over an article it no longer
 *    points at.
 *
 * The menu's own rows are asserted through `blockMenuRows` rather than through
 * markup, for the reason `editor-toolbar-visual.test.tsx` gives about `CITE ▾`:
 * a panel exists only while it is open and `renderToStaticMarkup` renders it
 * closed. That is also where "a table does not offer to become a heading" and
 * "the first block cannot move up" actually live.
 *
 * Labels are literals here, not dictionary values: `BlockHandleLabels` is this
 * module's own interface and the integration pass owns wiring it to `en`.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { VeBlockFormat } from "@/lib/visual-editor/actions";

import {
  VeBlockHandle,
  blockMenuRows,
  type BlockHandleLabels,
} from "./ve-block-handle";

const LABELS: BlockHandleLabels = {
  add: "Add a block below",
  grip: "Drag to move, or click for block options",
  menu: "Block options",
  insertBelow: "Insert below",
  duplicate: "Duplicate",
  delete: "Delete",
  moveUp: "Move up",
  moveDown: "Move down",
  turnInto: "Turn into",
  formats: {
    paragraph: "Normal text",
    h2: "Heading",
    h3: "Sub-heading 1",
    h4: "Sub-heading 2",
    h5: "Sub-heading 3",
    pre: "Preformatted",
  },
};

const TEXT_FORMATS: readonly VeBlockFormat[] = ["paragraph", "h2", "h3", "h4", "h5", "pre"];

function render(props: Partial<Parameters<typeof VeBlockHandle>[0]> = {}): string {
  return renderToStaticMarkup(
    <VeBlockHandle
      anchor={{ top: 120, left: 240 }}
      canMoveUp
      canMoveDown
      formats={TEXT_FORMATS}
      onCommand={() => {}}
      onSortPointerDown={() => {}}
      labels={LABELS}
      {...props}
    />,
  );
}

/** The `<button>` carrying an accessible name, with its attributes. */
function buttonFor(html: string, name: string): string {
  const found = html.match(new RegExp(`<button[^>]*aria-label="${name}"[^>]*>`));
  if (found === null) throw new Error(`no control named "${name}" in the gutter`);
  return found[0];
}

/** The rows a given block would offer, by their labels. */
function labelsOf(rows: ReturnType<typeof blockMenuRows>): string[] {
  return rows.map((row) => row.label);
}

describe("blockMenuRows", () => {
  it("disables the move that lands nowhere, and only that one", () => {
    const first = blockMenuRows({
      canMoveUp: false,
      canMoveDown: true,
      formats: TEXT_FORMATS,
      labels: LABELS,
    });
    const disabled = first.filter((row) => row.disabled).map((row) => row.label);
    expect(disabled).toEqual([LABELS.moveUp]);

    const last = blockMenuRows({
      canMoveUp: true,
      canMoveDown: false,
      formats: TEXT_FORMATS,
      labels: LABELS,
    });
    expect(last.filter((row) => row.disabled).map((row) => row.label)).toEqual([LABELS.moveDown]);

    const only = blockMenuRows({
      canMoveUp: false,
      canMoveDown: false,
      formats: [],
      labels: LABELS,
    });
    expect(only.filter((row) => row.disabled).map((row) => row.label)).toEqual([
      LABELS.moveUp,
      LABELS.moveDown,
    ]);
  });

  it("keeps Move up and Move down as ordinary items — the grip's keyboard half", () => {
    const rows = blockMenuRows({
      canMoveUp: true,
      canMoveDown: true,
      formats: [],
      labels: LABELS,
    });
    expect(rows.map((row) => row.command)).toContainEqual({ kind: "move", direction: "up" });
    expect(rows.map((row) => row.command)).toContainEqual({ kind: "move", direction: "down" });
  });

  it("offers only the formats the caller passed", () => {
    const rows = blockMenuRows({
      canMoveUp: true,
      canMoveDown: true,
      formats: ["paragraph", "h2"],
      labels: LABELS,
    });
    const turns = rows.flatMap((row) =>
      row.command.kind === "turnInto" ? [row.command.format] : [],
    );
    expect(turns).toEqual(["paragraph", "h2"]);
    expect(labelsOf(rows)).toContain("Heading");
    expect(labelsOf(rows)).not.toContain("Preformatted");
  });

  it("offers no Turn into at all for a block that cannot become anything", () => {
    // A table or an atomic chip passes no formats: there is then no section and
    // no heading, rather than an empty submenu that opens onto nothing.
    const rows = blockMenuRows({
      canMoveUp: true,
      canMoveDown: true,
      formats: [],
      labels: LABELS,
    });
    expect(rows.some((row) => row.command.kind === "turnInto")).toBe(false);
    expect(rows.some((row) => row.heading !== null)).toBe(false);
    expect(labelsOf(rows)).toEqual([
      LABELS.insertBelow,
      LABELS.duplicate,
      LABELS.moveUp,
      LABELS.moveDown,
      LABELS.delete,
    ]);
  });

  it("heads the format run once, and only the first of them opens the group", () => {
    const rows = blockMenuRows({
      canMoveUp: true,
      canMoveDown: true,
      formats: ["h2", "h3"],
      labels: LABELS,
    });
    const headed = rows.filter((row) => row.heading !== null);
    expect(headed).toHaveLength(1);
    expect(headed[0]?.heading).toBe(LABELS.turnInto);
    expect(headed[0]?.command).toEqual({ kind: "turnInto", format: "h2" });
  });

  it("puts the one irreversible row last, behind a rule of its own", () => {
    const rows = blockMenuRows({
      canMoveUp: true,
      canMoveDown: true,
      formats: TEXT_FORMATS,
      labels: LABELS,
    });
    const last = rows[rows.length - 1];
    expect(last?.command).toEqual({ kind: "delete" });
    expect(last?.startsGroup).toBe(true);
  });

  it("gives a repeated format one row, not two rows with one identity", () => {
    const rows = blockMenuRows({
      canMoveUp: true,
      canMoveDown: true,
      formats: ["h2", "h2", "h3"],
      labels: LABELS,
    });
    const turns = rows.flatMap((row) =>
      row.command.kind === "turnInto" ? [row.command.format] : [],
    );
    expect(turns).toEqual(["h2", "h3"]);
  });

  it("falls back to the format's own name when the dictionary has no label", () => {
    const rows = blockMenuRows({
      canMoveUp: true,
      canMoveDown: true,
      formats: ["pre"],
      labels: { ...LABELS, formats: {} },
    });
    expect(labelsOf(rows)).toContain("pre");
  });
});

describe("VeBlockHandle", () => {
  it("renders nothing at all when the anchor is null", () => {
    expect(render({ anchor: null })).toBe("");
  });

  it("draws two real buttons, each with its own accessible name", () => {
    const html = render();
    expect(buttonFor(html, LABELS.add)).toContain('type="button"');
    expect(buttonFor(html, LABELS.grip)).toContain('type="button"');
    // Exactly two: the panel is closed, so the menu's rows are not markup yet.
    expect(html.split("<button").length - 1).toBe(2);
  });

  it("does not use the browser's drag-and-drop at all", () => {
    // Reordering moved to pointer events on 2026-09-05 (§3.4): HTML5 dragging
    // draws a picture of the element that nothing can animate, and the
    // direction asked for the element itself to follow the pointer.
    const html = render();
    expect(html).not.toContain("draggable");
  });

  it("says the grip opens a menu, and that the menu is shut", () => {
    const html = render();
    const grip = buttonFor(html, LABELS.grip);
    expect(grip).toContain('aria-haspopup="menu"');
    expect(grip).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="menu"');
  });

  it("disables both controls together", () => {
    const html = render({ disabled: true });
    expect(buttonFor(html, LABELS.add)).toContain("disabled");
    // A control that refuses a click refuses a drag with it: a disabled button
    // takes no pointer events, so the press never reaches `beginSort` and the
    // block cannot move while the surface is locked.
    expect(buttonFor(html, LABELS.grip)).toContain("disabled");
  });

  it("is positioned from the viewport coordinates it was handed", () => {
    const html = render({ anchor: { top: 512, left: 96 } });
    expect(html).toContain("top:512px");
    expect(html).toContain("left:96px");
  });

  it("carries the repo's focus ring on both controls", () => {
    const html = render();
    expect(buttonFor(html, LABELS.add)).toContain("focus-ring");
    expect(buttonFor(html, LABELS.grip)).toContain("focus-ring");
  });
});
