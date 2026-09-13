/**
 * The catalogue behind the slash menu, and the citation rows both modes share.
 *
 * The fixed toolbar this file used to test is gone (the 2026-09-04 direction);
 * what survived it is `visualSlashItems`, the one list every construct the
 * editor can insert has to appear in. So the assertions moved with the list:
 * that the twelve table operations are offered **only** where there is a table
 * to apply them to, that a table cell is offered nothing that would make the
 * model refuse its own table (spec §7.3), and that the wiring through
 * `editorLabels` leaves no row unnamed — a dictionary key that never reached
 * the catalogue would be an empty row somebody has to pick from.
 *
 * **`CITE ▾`'s re-use rows** are still asserted through `citeReuseRows`, which
 * is where both modes meet: the slash menu and the source toolbar build their
 * rows from it, so one assertion covers the promise that switching modes does
 * not change which sources an author can reach or what gets inserted.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createDb } from "@/lib/db/client";
import { seedLanguages, seedVersions } from "@/lib/db/store";
import { getDictionary } from "@/lib/i18n";
import { editorLabels, loadEditorView } from "@/lib/wiki/edit-view";
import { namedRefsUsed } from "@/lib/wikitext-refs";

import { parseDocument } from "@/lib/visual-editor/parse";

import { TABLE_OPS, tableContextOf } from "./ve-table";
import {
  TABLE_SNIPPET,
  citeReuseRows,
  snippetText,
  visualInsertItems,
  visualSlashItems,
  type VeSlashBlock,
} from "./editor-toolbar-visual";

function labels() {
  const db = createDb(":memory:");
  seedLanguages(db);
  seedVersions(db);
  const view = loadEditorView({ db, locale: "en", segments: "gold-bar", version: null });
  if (view === null) throw new Error("unresolvable title");
  return editorLabels(getDictionary("en"), view);
}

/** The caret in the middle of a 3x3 table: every operation is offered. */
function inATable() {
  return tableContextOf({ row: 1, column: 1, widths: [3, 3, 3], headerRow: false });
}

/**
 * A caret in the middle of a document, standing in a plain paragraph — the
 * default the tests below vary one term of. `null` is a different question and
 * has its own test: it means "no block to ask about", where nothing is hidden.
 */
function inAParagraph(over: Partial<VeSlashBlock> = {}): VeSlashBlock {
  return { format: "paragraph", canOutdent: false, canMoveUp: true, canMoveDown: true, ...over };
}

interface Where {
  table?: boolean;
  inCell?: boolean;
  /** The caret's own block; omitted means "do not ask", which hides nothing. */
  block?: VeSlashBlock | null;
}

/** The catalogue as the caret's surroundings decide it. */
function items(where: Where = {}) {
  const all = labels().visual;
  return visualSlashItems({
    labels: all.slashItems,
    refs: [],
    inCell: where.inCell ?? where.table ?? false,
    table: where.table === true ? inATable() : null,
    tableLabels: all.table,
    block: where.block ?? null,
    blockLabels: all.handle,
  });
}

/** The header Insert menu's rows, from the same surroundings. */
function insertItems(where: Where = {}) {
  const all = labels().visual;
  return visualInsertItems({
    labels: all.slashItems,
    refs: [],
    inCell: where.inCell ?? where.table ?? false,
    table: where.table === true ? inATable() : null,
    tableLabels: all.table,
    block: where.block ?? null,
    blockLabels: all.handle,
  });
}

describe("the slash menu's catalogue", () => {
  it("offers no table operation while the caret is outside a table", () => {
    expect(items().some((item) => item.key.startsWith("table-"))).toBe(false);
  });

  it("offers all twelve of them once the caret is in one", () => {
    const ops = items({ table: true }).filter((item) => item.key.startsWith("table-"));
    expect(ops.length).toBe(TABLE_OPS.length);
  });

  it("puts them first, where a filtered list can still show them", () => {
    // They are the contextual rows: an author who typed "/" inside a table is
    // far more likely to want one of these than a horizontal rule.
    const first = items({ table: true })[0];
    expect(first.key.startsWith("table-")).toBe(true);
  });

  it("offers a cell nothing that would make its own table refuse", () => {
    // A cell holds inline content and nothing else (spec section 7.3): a
    // heading or a list made in one is a table the model then has to refuse,
    // and a refused table goes back to being a chip.
    const keys = new Set(items({ inCell: true }).map((item) => item.key));
    for (const blockRow of ["h2", "bullet", "number", "rule", "table", "gallery", "infobox"]) {
      expect(keys.has(blockRow)).toBe(false);
    }
    // What a cell *can* have is still there, so the menu is not empty in one.
    expect(keys.has("link")).toBe(true);
    expect(keys.has("bold")).toBe(true);
  });

  it("offers a version block inside a cell, which is where it is most wanted", () => {
    // The one block-shaped row a cell keeps. A version tag is an ordinary
    // extension tag (versioning.md section 2.1) whose whole point is that it
    // works wherever the wikitext does — "inside tables, list items, infobox
    // parameters" is the first sentence of its section 2 — and scoping one
    // number of a table to a patch is the commonest reason to reach for it.
    // While it was block-only, a cell was the one place the menus refused to
    // offer the feature that spec is about.
    expect(items({ inCell: true }).some((item) => item.key === "versions")).toBe(true);
  });

  it("names every row it offers, in both of its two states", () => {
    // The wiring, end to end: a key that never reached `editorLabels` would be
    // an empty row in a list somebody has to pick from.
    for (const row of [...items(), ...items({ table: true })]) {
      expect(row.label).not.toBe("");
      expect(row.key).not.toBe("");
    }
  });

  it("gives every row a key of its own", () => {
    // The key is React's and the filter's identity for a row; two rows sharing
    // one is a row that cannot be picked.
    const all = items({ table: true });
    expect(new Set(all.map((row) => row.key)).size).toBe(all.length);
  });

  it("inserts a table the axis controls can then edit", () => {
    // The slash menu's Table hands its snippet to the surface, which puts a
    // real table in when the model can hold one (spec section 3.2). A snippet
    // edited into something that refuses would silently go back to being a
    // chip with a dialog, and the twelve controls would never appear on a
    // table anybody made in the editor.
    const doc = parseDocument(snippetText(TABLE_SNIPPET));
    expect(doc.blocks.length).toBe(1);
    expect(doc.blocks[0].kind).toBe("table");
  });

  it("still carries every construct the retired toolbar could insert", () => {
    // The catalogue is the only list now, so a construct dropped from it is a
    // construct the editor can no longer make at all.
    const keys = new Set(items().map((item) => item.key));
    for (const key of [
      "paragraph",
      "h2",
      "h3",
      "h4",
      "h5",
      "bullet",
      "number",
      "indent",
      "outdent",
      "pre",
      "link",
      "media",
      "template",
      "table",
      "gallery",
      "infobox",
      "versions",
      "tabber",
      "rule",
      "date",
      "cite-basic",
      "cite-named",
      "cite-list",
      "bold",
      "italic",
      "underline",
      "strike",
      "sup",
      "sub",
      "code",
      "clear",
    ]) {
      expect(keys.has(key)).toBe(true);
    }
  });

  it("carries the six constructs the toolbar never had a button for", () => {
    // Added 2026-09-06. Each is wikitext the engine already parses and the
    // visual surface could not write at all — a glossary, a category, an
    // external link, an escape, a code block and a note to other editors.
    const keys = new Set(items().map((item) => item.key));
    for (const key of ["deflist", "category", "extlink", "nowiki", "codeblock", "comment"]) {
      expect(keys.has(key)).toBe(true);
    }
  });

  it("writes a definition list the model reads back as one", () => {
    // It goes in as content rather than as a chip, so this has to parse: a
    // definition list the parser refused would be a chip saying `; Term`.
    const row = items().find((item) => item.key === "deflist");
    expect(row?.action).toEqual({
      kind: "wikitext",
      source: "; Term : Definition",
      block: true,
    });
    const doc = parseDocument("; Term : Definition");
    expect(doc.blocks[0].kind).toBe("list");
  });
});

/* ---------------------------------------------------------------- */
/* What the caret's own block takes out of the list                  */
/* ---------------------------------------------------------------- */

describe("the rows a caret leaves out", () => {
  it("hides the format the block already has", () => {
    // User direction, 2026-09-06: "normal같이 기본적으로 가능한거는 안뜨게".
    // "/" is pressed in an empty paragraph more often than anywhere else, and
    // "Normal text" chosen there is a row that does nothing.
    const inParagraph = new Set(items({ block: inAParagraph() }).map((item) => item.key));
    expect(inParagraph.has("paragraph")).toBe(false);
    expect(inParagraph.has("h2")).toBe(true);

    const inHeading = new Set(items({ block: inAParagraph({ format: "h2" }) }).map((i) => i.key));
    expect(inHeading.has("h2")).toBe(false);
    expect(inHeading.has("paragraph")).toBe(true);
    expect(inHeading.has("h3")).toBe(true);
  });

  it("keeps every format row for a block that has none of them", () => {
    // A list reports no format: it *can* be turned into a paragraph, and that
    // row is the way out of the list.
    const keys = new Set(items({ block: inAParagraph({ format: null }) }).map((item) => item.key));
    expect(keys.has("paragraph")).toBe(true);
    expect(keys.has("h2")).toBe(true);
  });

  it("hides an outdent with nothing to outdent, and keeps the indent", () => {
    const flat = new Set(items({ block: inAParagraph() }).map((item) => item.key));
    expect(flat.has("outdent")).toBe(false);
    expect(flat.has("indent")).toBe(true);

    const indented = new Set(
      items({ block: inAParagraph({ canOutdent: true }) }).map((item) => item.key),
    );
    expect(indented.has("outdent")).toBe(true);
  });

  it("hides a move that would land nowhere", () => {
    const first = new Set(
      items({ block: inAParagraph({ canMoveUp: false }) }).map((item) => item.key),
    );
    expect(first.has("block-move-up")).toBe(false);
    expect(first.has("block-move-down")).toBe(true);

    const only = new Set(
      items({ block: inAParagraph({ canMoveUp: false, canMoveDown: false }) }).map((i) => i.key),
    );
    expect(only.has("block-move-up")).toBe(false);
    expect(only.has("block-move-down")).toBe(false);
    // The three that always apply stay: a lone block can still be duplicated.
    expect(only.has("block-duplicate")).toBe(true);
    expect(only.has("block-delete-block")).toBe(true);
    expect(only.has("block-insert-below")).toBe(true);
  });

  it("hides nothing at all when there is no block to ask about", () => {
    // `null` is "do not ask", not "everything refuses" — a menu that hid rows
    // on a guess would be worse than one that shows a row too many.
    const keys = new Set(items({ block: null }).map((item) => item.key));
    for (const key of ["paragraph", "h2", "outdent", "block-move-up", "block-move-down"]) {
      expect(keys.has(key)).toBe(true);
    }
  });

  it("offers no block command inside a cell", () => {
    // A "block" is a direct child of the root (§3), so the block a caret in a
    // cell is standing in is the whole table: duplicating or deleting one from
    // in there would take the table the author is typing in with it.
    const keys = items({ inCell: true }).map((item) => item.key);
    expect(keys.some((key) => key.startsWith("block-"))).toBe(false);
  });

  it("keeps the block commands out of the header's Insert menu", () => {
    // That menu is the constructs — things an author *adds* — and a delete is
    // not one of them.
    const keys = insertItems({ block: inAParagraph() }).map((item) => item.key);
    expect(keys.some((key) => key.startsWith("block-"))).toBe(false);
  });
});

/* ---------------------------------------------------------------- */
/* INSERT ▾ — the header menu (editor-insert-menu.tsx)               */
/* ---------------------------------------------------------------- */

describe("the header's Insert menu", () => {
  it("offers what INSERT and CITE held, and nothing else", () => {
    const keys = new Set(insertItems().map((item) => item.key));
    for (const key of [
      "link",
      "media",
      "template",
      "table",
      "gallery",
      "infobox",
      "versions",
      "tabber",
      "rule",
      "date",
      "cite-basic",
      "cite-named",
      "cite-list",
    ]) {
      expect(keys.has(key)).toBe(true);
    }
    // A dropdown cannot be typed at: the forty characters and the seven marks
    // would bury the constructs somebody opened it for, and both have a home
    // of their own (the bubble menu, Ctrl+B/I/U, and the slash menu).
    for (const key of ["paragraph", "h2", "bullet", "bold", "clear"]) {
      expect(keys.has(key)).toBe(false);
    }
    expect([...keys].some((key) => key.startsWith("char-"))).toBe(false);
    expect([...keys].some((key) => key.startsWith("table-"))).toBe(false);
  });

  it("draws every row from the slash menu's own catalogue", () => {
    // The two menus are one list (editor-toolbar-visual.tsx). A row here that
    // the slash menu does not have would be a construct reachable by pointer
    // and not by keyboard — and the drift would be invisible until somebody
    // typed its name and got nothing.
    const slash = new Map(items().map((item) => [item.key, item]));
    for (const row of insertItems()) {
      const twin = slash.get(row.key);
      expect(twin).toBeDefined();
      expect(row.label).toBe(twin?.label);
      expect(row.action).toEqual(twin?.action);
    }
  });

  it("prunes a cell the way the slash menu prunes one", () => {
    // Same rule, spec section 7.3: a cell holds inline content, so a table or
    // a gallery made in one is a table the model then has to refuse.
    const keys = new Set(insertItems({ inCell: true }).map((item) => item.key));
    for (const key of ["table", "gallery", "infobox", "rule", "cite-list"]) {
      expect(keys.has(key)).toBe(false);
    }
    expect(keys.has("link")).toBe(true);
    expect(keys.has("media")).toBe(true);
    expect(keys.has("cite-basic")).toBe(true);
    // And the version block, for the reason the slash menu's own test gives.
    expect(keys.has("versions")).toBe(true);
  });

  it("names every row it offers", () => {
    for (const row of [...insertItems(), ...insertItems({ inCell: true })]) {
      expect(row.label).not.toBe("");
    }
  });
});

/* ---------------------------------------------------------------- */
/* CITE ▾ — citing a source the page already cites                   */
/* ---------------------------------------------------------------- */

describe("the CITE menu's re-use rows", () => {
  const page = [
    'Artifice is the hardest moon.<ref name="manual">The company manual, p. 4</ref>',
    "",
    'It has four fire exits.<ref name="manual" /><ref name="wiki">Community survey</ref>',
    "",
    '<nowiki><ref name="example">not a source</ref></nowiki>',
  ].join("\n");

  it("offers one row per named reference, in the page's own order", () => {
    const rows = citeReuseRows(namedRefsUsed(page));
    expect(rows.map((row) => row.hint)).toEqual(["manual", "wiki"]);
  });

  it("inserts the engine's reuse form, not another copy of the footnote", () => {
    // The whole point: a repeat citation is a self-closing tag naming the ref,
    // so the two share one number and one entry in the list (spec §10.3).
    const rows = citeReuseRows(namedRefsUsed(page));
    expect(rows[0].source).toBe('<ref name="manual" />');
  });

  it("reads as the footnote itself, with the name beside it", () => {
    // "Which source is this" is the question being asked, and a bare `name=`
    // rarely answers it.
    const rows = citeReuseRows(namedRefsUsed(page));
    expect(rows[0].label).toBe("The company manual, p. 4");
    expect(rows[1].label).toBe("Community survey");
  });

  it("falls back to the name for a ref the page only ever reuses", () => {
    // The definition may live in a template, so there is no body to show.
    const rows = citeReuseRows(namedRefsUsed('Text<ref name="fromTemplate" />'));
    expect(rows).toEqual([
      { source: '<ref name="fromTemplate" />', label: "fromTemplate", hint: "fromTemplate" },
    ]);
  });

  it("says which group a ref is in, because a group is half its identity", () => {
    // Two footnotes named "x" in two groups are two footnotes; one row twice
    // would be unreadable, and the wikitext differs.
    const rows = citeReuseRows(
      namedRefsUsed('<ref name="x">Plain</ref><ref name="x" group="note">Noted</ref>'),
    );
    expect(rows.map((row) => row.hint)).toEqual(["x", "x · note"]);
    expect(rows[1].source).toBe('<ref name="x" group="note" />');
  });

  it("offers nothing at all for a page with no named references", () => {
    // An empty list draws no heading and no rows — the menu simply keeps the
    // three entries it always had.
    expect(citeReuseRows(namedRefsUsed("Prose.<ref>An unnamed footnote</ref>"))).toEqual([]);
  });

  it("names the section from the dictionary", () => {
    // The wiring, end to end. The slash menu and the source toolbar build
    // their rows with the SAME function, so the two modes cannot offer
    // different sources or insert different wikitext; only the source
    // toolbar's menu still has a heading over them to name.
    const all = labels();
    expect(all.sourceToolbar.citeReuse).not.toBe("");
  });
});
