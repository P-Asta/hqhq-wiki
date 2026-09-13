/**
 * The slash menu's two decisions, and the markup they produce.
 *
 * Everything about this control that can be wrong without anyone noticing is
 * in the two pure functions, which is why they are exported and why this file
 * spends most of its length on them:
 *
 * 1. **The order of the matches.** A menu driven by Enter puts the author's
 *    block one keystroke away or three, depending only on ranking. So "ta"
 *    has to reach *Table* before *Metadata* — a prefix is what the author was
 *    spelling, a containment is a coincidence — and a keyword has to be a way
 *    in without outranking the name a row is read by.
 * 2. **Where the panel lands.** A panel that opens off the bottom of the
 *    viewport is a menu that does not exist. Under vitest's node environment
 *    there is no layout to ask, which is precisely why the placement is
 *    arithmetic over plain objects rather than a `getBoundingClientRect`.
 *
 * The markup is then checked with `renderToStaticMarkup`, the way
 * version-chips.test.tsx does: that the rows are options in a listbox, that
 * exactly one of them is selected, that a query matching nothing still shows
 * the panel (closing on a typo would eat the author's slash), and that a
 * closed or unanchored menu draws nothing whatsoever.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  VeSlashMenu,
  filterSlashItems,
  slashMenuPosition,
  type SlashItem,
  type SlashMenuLabels,
} from "./ve-slash-menu";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function item(
  key: string,
  label: string,
  keywords: readonly string[] = [],
  hint?: string,
): SlashItem {
  return {
    key,
    label,
    hint,
    keywords,
    icon: <span>{label.slice(0, 1)}</span>,
    action: { kind: "insert", source: `<${key}>`, block: true },
  };
}

/**
 * Deliberately ordered so that ranking has something to undo: *Metadata* is
 * offered before *Table* and merely contains the letters "ta".
 */
const ITEMS: readonly SlashItem[] = [
  item("heading", "Heading", ["h2", "title"], "Section title"),
  item("bullets", "Bulleted list", ["ul", "point"]),
  item("metadata", "Metadata"),
  item("table", "Table", ["grid"]),
  item("tabs", "Tabs", ["tabber"]),
];

const LABELS: SlashMenuLabels = { title: "Blocks", empty: "No matching block" };

const keys = (items: readonly SlashItem[]) => items.map((entry) => entry.key);

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

describe("filterSlashItems", () => {
  it("offers every item, in the caller's order, for an empty query", () => {
    expect(keys(filterSlashItems(ITEMS, ""))).toEqual(keys(ITEMS));
    // A slash followed by a space is still no query — the author has typed
    // nothing to filter by, so the whole list stands.
    expect(keys(filterSlashItems(ITEMS, "   "))).toEqual(keys(ITEMS));
  });

  it("puts a prefix match before a containment — 'ta' means Table", () => {
    // Metadata is offered first and contains "ta"; Table and Tabs begin with
    // it, and hold the caller's order between themselves.
    expect(keys(filterSlashItems(ITEMS, "ta"))).toEqual(["table", "tabs", "metadata"]);
  });

  it("matches keywords, and ranks them under a name that begins the same way", () => {
    // "ul" is Bulleted list's keyword and sits inside Bulleted's own label —
    // the keyword prefix is the stronger claim either way.
    expect(keys(filterSlashItems(ITEMS, "ul"))).toEqual(["bullets"]);
    expect(keys(filterSlashItems(ITEMS, "tabber"))).toEqual(["tabs"]);
    expect(keys(filterSlashItems(ITEMS, "grid"))).toEqual(["table"]);

    // A keyword's prefix outranks a label's containment, whichever came first:
    // "Formula" holds those letters by accident, "Bulleted list" answers to
    // them on purpose.
    const rows = [item("formula", "Formula"), item("bullets", "Bulleted list", ["ul"])];
    expect(keys(filterSlashItems(rows, "ul"))).toEqual(["bullets", "formula"]);
  });

  it("ignores case and diacritics in both directions", () => {
    expect(keys(filterSlashItems(ITEMS, "TABLE"))).toEqual(["table"]);
    const accented = [item("ref", "Référence", ["citação"])];
    expect(keys(filterSlashItems(accented, "reference"))).toEqual(["ref"]);
    expect(keys(filterSlashItems(accented, "Réf"))).toEqual(["ref"]);
    expect(keys(filterSlashItems(accented, "citacao"))).toEqual(["ref"]);
    // …and the plain query still reaches a plain label.
    expect(keys(filterSlashItems([item("ref", "Reference")], "référence"))).toEqual(["ref"]);
  });

  it("returns nothing for a query nothing answers, and keeps its hands off the input", () => {
    expect(filterSlashItems(ITEMS, "zzz")).toEqual([]);
    // The list is copied rather than handed back, so a caller sorting the
    // result cannot reorder the menu it passed in.
    const all = filterSlashItems(ITEMS, "");
    expect(all).not.toBe(ITEMS);
    expect(keys(ITEMS)).toEqual(["heading", "bullets", "metadata", "table", "tabs"]);
  });
});

/* ------------------------------------------------------------------ */
/* Placing                                                             */
/* ------------------------------------------------------------------ */

const PANEL = { width: 288, height: 300 };
const VIEWPORT = { width: 1000, height: 800 };

describe("slashMenuPosition", () => {
  it("hangs under the caret and lines up with it", () => {
    const at = slashMenuPosition({ top: 100, left: 400 }, PANEL, VIEWPORT);
    expect(at.left).toBe(400);
    expect(at.top).toBeGreaterThan(100);
    expect(at.top + PANEL.height).toBeLessThan(VIEWPORT.height);
  });

  it("flips above a caret near the bottom edge", () => {
    const at = slashMenuPosition({ top: 700, left: 400 }, PANEL, VIEWPORT);
    // Wholly above the caret's own line, and still on screen.
    expect(at.top + PANEL.height).toBeLessThan(700);
    expect(at.top).toBeGreaterThanOrEqual(0);
    expect(at.left).toBe(400);
  });

  it("stays below — clamped — when it fits neither below nor above", () => {
    // A viewport shorter than the panel: flipping would only move the list
    // somewhere the author is not looking, so it pins to the top edge.
    const at = slashMenuPosition({ top: 150, left: 400 }, PANEL, { width: 1000, height: 200 });
    expect(at.top).toBeGreaterThanOrEqual(0);
    expect(at.top).toBeLessThan(150);
  });

  it("clamps at the right edge, keeping the whole panel on screen", () => {
    const at = slashMenuPosition({ top: 100, left: 980 }, PANEL, VIEWPORT);
    expect(at.left + PANEL.width).toBeLessThanOrEqual(VIEWPORT.width);
    expect(at.left).toBe(VIEWPORT.width - PANEL.width - 8);
  });

  it("clamps at the left edge, including a caret reported off it", () => {
    expect(slashMenuPosition({ top: 100, left: 0 }, PANEL, VIEWPORT).left).toBe(8);
    expect(slashMenuPosition({ top: 100, left: -40 }, PANEL, VIEWPORT).left).toBe(8);
  });

  it("clamps at the top edge rather than opening above it", () => {
    // A caret on the first line of a short viewport: above is off-screen.
    const at = slashMenuPosition({ top: 10, left: 400 }, PANEL, { width: 1000, height: 260 });
    expect(at.top).toBeGreaterThanOrEqual(0);
  });

  it("is the same answer twice — no hidden state between calls", () => {
    const anchor = { top: 700, left: 980 };
    expect(slashMenuPosition(anchor, PANEL, VIEWPORT)).toEqual(
      slashMenuPosition(anchor, PANEL, VIEWPORT),
    );
  });
});

/* ------------------------------------------------------------------ */
/* Markup                                                              */
/* ------------------------------------------------------------------ */

function render(props: Partial<Parameters<typeof VeSlashMenu>[0]> = {}): string {
  return renderToStaticMarkup(
    <VeSlashMenu
      open
      anchor={{ top: 100, left: 400 }}
      query=""
      items={ITEMS}
      onSelect={() => {}}
      onClose={() => {}}
      labels={LABELS}
      {...props}
    />,
  );
}

describe("VeSlashMenu", () => {
  it("draws the items as options of one listbox, named by the caller", () => {
    const html = render();
    expect(html).toContain('role="listbox"');
    expect(html).toContain(`aria-label="${LABELS.title}"`);
    expect(occurrences(html, 'role="option"')).toBe(ITEMS.length);
    expect(html).toContain("Table");
    expect(html).toContain("Bulleted list");
    // The second line of a row is the caller's hint, drawn only where given.
    expect(html).toContain("Section title");
  });

  it("selects exactly one row — the best match — and says which", () => {
    const html = render();
    expect(occurrences(html, 'aria-selected="true"')).toBe(1);
    expect(occurrences(html, 'aria-selected="false"')).toBe(ITEMS.length - 1);
    // With no query that is the first row, and it carries the fill.
    expect(html.slice(0, html.indexOf("Bulleted list"))).toContain('aria-selected="true"');

    // Filtered, the fill moves to whatever the ranking put first.
    const filtered = render({ query: "ta" });
    expect(occurrences(filtered, 'role="option"')).toBe(3);
    expect(occurrences(filtered, 'aria-selected="true"')).toBe(1);
    expect(filtered.slice(0, filtered.indexOf("Tabs"))).toContain('aria-selected="true"');
  });

  it("gives each row an id the surface can point aria-activedescendant at", () => {
    const html = render();
    expect(html).toContain('id="ve-slash-option-table"');
    expect(html).toContain('id="ve-slash-option-bullets"');
  });

  it("shows the empty line for a query nothing answers, and stays open", () => {
    const html = render({ query: "zzz" });
    expect(html).toContain(LABELS.empty);
    expect(html).not.toContain('role="option"');
    // The panel itself is still there — a typo must not eat the slash.
    expect(html).toContain('role="listbox"');
    expect(html).toContain(LABELS.title);
  });

  it("places itself under the caret and stays in the accessibility tree", () => {
    const html = render();
    // No window in a node environment, so nothing is clamped: the panel sits
    // a gap below the caret and flush with it.
    expect(html).toContain("top:108px");
    expect(html).toContain("left:400px");
    expect(html).toContain('aria-hidden="false"');
  });

  it("takes no focus: nothing in it is focusable or autofocused", () => {
    const html = render();
    expect(html).not.toContain("autofocus");
    expect(html).not.toContain("tabindex");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
  });

  it("draws nothing at all when closed or unanchored", () => {
    expect(render({ open: false })).toBe("");
    expect(render({ anchor: null })).toBe("");
    // Not even when it has matches to show.
    expect(render({ open: false, query: "ta" })).toBe("");
  });
});
