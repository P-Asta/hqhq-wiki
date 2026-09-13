/**
 * The decisions the visual surface makes that need no browser
 * (docs/engine/visual-editor.md §4 round-trip, §5 atomic previews, §13 the
 * mention panels, §15 a dropped picture, versioning.md §6 in-place passage
 * editing).
 *
 * The component itself is a contenteditable, and this suite runs in vitest's
 * `node` environment, so what is asserted here is what the surface *decides* —
 * exported for that reason, as `isExternalTarget` is next door. Each of the
 * three was previously not a decision at all: the load path treated an
 * unreadable buffer as an empty document, a fragment batch painted whatever it
 * came back with, and a block format rewrote whatever block it was standing
 * on. All three are silent data loss, which is why they are pinned here.
 */

import { describe, expect, it } from "vitest";

import { emptyDocument, newBlockBase, type VeDocument } from "@/lib/visual-editor/model";
import { parseDocument } from "@/lib/visual-editor/parse";
import { serializeDocument } from "@/lib/visual-editor/serialize";

import { versionFieldState } from "@/lib/visual-editor/version-branch";

import { tableContextOf } from "./ve-table";
import {
  branchFieldKey,
  caretHolderSlot,
  contextMenuRows,
  formatStep,
  fragmentScopeIsCurrent,
  loadOutcome,
  mediaFile,
  mentionRows,
  readFragments,
  slashContext,
  tableDeleteMessage,
  tableRefusalNote,
} from "./visual-editor";

/* ---------------------------------------------------------------- */
/* loadOutcome — a buffer that cannot be parsed (§4)                 */
/* ---------------------------------------------------------------- */

const ARTICLE = "68-Artifice is a moon.\n\n== Interior ==\nMostly the factory.\n";

describe("loadOutcome", () => {
  it("hands back the document and its markup when the buffer parses", () => {
    const load = loadOutcome(ARTICLE, parseDocument);
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    expect(serializeDocument(load.doc)).toBe(ARTICLE);
    expect(load.html).toContain("data-ve=\"h\"");
  });

  it("refuses the load rather than standing in for the article with nothing", () => {
    // What a parse failure costs is not a bad render, it is the page. The
    // fallback surface is one empty paragraph — a childless contenteditable
    // gives the caret nowhere to stand — which reads back and serializes to a
    // single newline, and Publish posts that over the article. So the load has
    // to say it failed, and nothing may be emitted at all.
    const emptied: VeDocument = {
      ...emptyDocument(),
      blocks: [{ ...newBlockBase("n1"), kind: "paragraph", children: [] }],
    };
    expect(serializeDocument(emptied)).toBe("\n");

    const throwing = (): VeDocument => {
      throw new RangeError("Maximum call stack size exceeded");
    };
    const load = loadOutcome(ARTICLE, throwing);
    expect(load).toEqual({ ok: false });
  });

  it("treats a parse that fails on one page like any other", () => {
    // The measured input was deep nesting, but the load may not care which
    // input it was: anything the parser cannot finish is the same refusal.
    const deep = "[[".repeat(6000) + "x" + "]]".repeat(6000);
    const throwing = (text: string): VeDocument => {
      if (text.length > 1000) throw new RangeError("Maximum call stack size exceeded");
      return parseDocument(text);
    };
    expect(loadOutcome(deep, throwing).ok).toBe(false);
    expect(loadOutcome("plain", throwing).ok).toBe(true);
  });
});

/* ---------------------------------------------------------------- */
/* fragmentScopeIsCurrent — a batch that outlived its surface (§5)   */
/* ---------------------------------------------------------------- */

describe("fragmentScopeIsCurrent", () => {
  const v62 = { generation: 2, locale: "en", version: "v62" };

  it("paints a batch into the surface that asked for it", () => {
    expect(fragmentScopeIsCurrent(v62, { generation: 2, locale: "en", version: "v62" })).toBe(true);
  });

  it("refuses the previous version's batch once the author has switched back", () => {
    // The rail's version chips: v50 → v62 (fetch starts) → v50 again before it
    // lands. The switch back is answered entirely from the cache, so it issues
    // no request and there is nothing to abort — only the generation says that
    // the surface the v62 batch was fetched for is gone.
    const back = { generation: 3, locale: "en", version: "v50" };
    expect(fragmentScopeIsCurrent(v62, back)).toBe(false);
  });

  it("refuses a batch that survived a document load at the same version", () => {
    expect(fragmentScopeIsCurrent(v62, { ...v62, generation: 3 })).toBe(false);
  });

  it("refuses a batch rendered in another locale", () => {
    expect(fragmentScopeIsCurrent(v62, { ...v62, locale: "ko" })).toBe(false);
  });
});

/* ---------------------------------------------------------------- */
/* formatStep — NORMAL TEXT ▾ over a list (§3)                       */
/* ---------------------------------------------------------------- */

describe("formatStep", () => {
  it("lets the browser take the caret out of a bullet or numbered list", () => {
    expect(formatStep("UL", false)).toBe("command");
    expect(formatStep("OL", false)).toBe("command");
  });

  it("never asks a browser command to leave a <dl>", () => {
    // §3 maps `:` and `;` to `<dl>`, and there is no command for one: asking
    // for `insertUnorderedList` there toggles a list *on*. The line has to be
    // lifted out by hand instead.
    expect(formatStep("DL", false)).toBe("lift");
  });

  it("never rewrites a list root's tag once the command has failed", () => {
    // The bug this pins: `Visit the [[Artifice]] '''bridge'''`, indented with
    // ⇥▾ and then set to Heading, was published as `== Visit the Artifice
    // bridge ==` — `<h2>` renamed the `<dl>` in place, kept its `<dd>`, and
    // the read-back flattened the whole line to plain text.
    expect(formatStep("DL", true)).toBe("lift");
    expect(formatStep("UL", true)).toBe("lift");
    expect(formatStep("OL", true)).toBe("lift");
  });

  it("rewrites a plain block in place, before and after the command", () => {
    for (const tag of ["P", "H2", "H3", "DIV", "BLOCKQUOTE"]) {
      expect(formatStep(tag, false)).toBe("retag");
      expect(formatStep(tag, true)).toBe("retag");
    }
  });
});

/* ---------------------------------------------------------------- */
/* branchFieldKey — when the in-place branch field is rebuilt (§6)   */
/* ---------------------------------------------------------------- */

/** §6's own example: what the page says from v56 until v72 (versioning.md §2.1). */
const VERSIONS_BLOCK = "<v56+v72>The base quota is 130 credits.</v56+v72>";

const keyAt = (version: string, locked = false): string | null =>
  branchFieldKey(versionFieldState(VERSIONS_BLOCK, version), version, locked);

describe("branchFieldKey", () => {
  it("does not change while the version being previewed renders the same branch", () => {
    // The field is rebuilt exactly when this string changes, so this is the
    // guarantee that switching v65 → v70 → v72 cannot take a half-typed word
    // out of the textarea: all three read the v56 branch, and the surface
    // therefore leaves it alone. (Rebuilding would call `.value =`, which
    // moves the caret and drops an IME composition in progress.)
    expect(keyAt("v56")).toBe(keyAt("v65"));
    expect(keyAt("v65")).toBe(keyAt("v70"));
    expect(keyAt("v70")).toBe(keyAt("v72"));
  });

  it("changes when the version leaves the passage's range", () => {
    // Which is the swap the strip promises: choosing v73 means this block has
    // nothing to say, and the field says so instead of holding v56's words.
    expect(keyAt("v73")).not.toBe(keyAt("v70"));
    expect(keyAt("v73")).toContain("v73");
    expect(keyAt("v70")).toContain("v56");
  });

  it("names the version, not a passage, where the block writes nothing", () => {
    // Outside the range there is no passage to key on — and the field is not a
    // field there but a sentence, so the version it is about identifies it.
    expect(keyAt("v50")).not.toBe(keyAt("v56"));
    expect(keyAt("v50")).toContain("v50");
  });

  it("changes when the surface stops being read-only", () => {
    // `/api/auth/me` answers after the document loaded. Nothing else would
    // turn the textarea writable.
    expect(keyAt("v70", true)).not.toBe(keyAt("v70", false));
  });

  it("draws no field at all where the block keeps its dialog", () => {
    // A block `parseVersionBlock` refuses is one a rebuild would quietly
    // damage: an attribute the tag name does not carry, a closer that does not
    // repeat its opener, or the retired grammar the engine no longer reads.
    const attributed = '<v70+ label="Launch">Seventy.</v70+>';
    const mismatched = "<v70+>Seventy.</v71+>";
    const retired = '<version since="v62">Added in v62.</version>';
    for (const source of [attributed, mismatched, retired]) {
      expect(branchFieldKey(versionFieldState(source, "v70"), "v70", false)).toBeNull();
    }
  });
});

/* ---------------------------------------------------------------- */
/* tableRefusalNote — why THIS table is a chip (§2, §3.2)            */
/* ---------------------------------------------------------------- */

/**
 * Enough of the bag to answer the question, which is the point of the decision
 * taking only what it reads: the reasons are the parser's own
 * (`VeTableRefusal`), so a test can name them without a dictionary.
 */
const REFUSAL_LABELS = {
  tableRefusedWhy: "Edited as wikitext: {reason}",
  tableRefusals: {
    "not-a-table": "this is not a table.",
    indented: "the table is indented with a colon.",
    unclosed: "the table is never closed with |}.",
    "trailing-content": "there is text after the closing |}.",
    "nested-table": "it contains another table.",
    "fostered-content": "there is text before its first cell.",
    "cell-continuation": "a cell continues onto the next line.",
    "caption-continuation": "the caption continues onto the next line.",
    "caption-attrs": "the caption carries attributes.",
    "second-caption": "it has more than one caption.",
    "no-rows": "it has no cells.",
    "not-a-fixed-point": "its wikitext cannot be written back unchanged.",
  },
};

/** Wikitext is line-based (spec §7.1), so the fixtures are written as lines. */
const lines = (...parts: string[]): string => parts.join("\n");

describe("tableRefusalNote", () => {
  it("names the construct that kept a table out of the editable form", () => {
    // A cell continued onto another line is parsed as BLOCK wikitext (spec
    // §7.3), which a cell of the model cannot hold — so the table stays a chip,
    // and the chip says which of the twelve reasons this one is.
    expect(
      tableRefusalNote(lines("{|", "| first line", "still the same cell", "|}"), REFUSAL_LABELS),
    ).toBe("Edited as wikitext: a cell continues onto the next line.");

    // A `{|` on a continuation line opens a table inside a cell (spec §7.9),
    // which is a cell holding a block and so a cell this model has no room for.
    expect(
      tableRefusalNote(lines("{|", "| outer", "{|", "| inner", "|}", "|}"), REFUSAL_LABELS),
    ).toBe("Edited as wikitext: it contains another table.");

    expect(tableRefusalNote(lines("::{|", "| a", "|}"), REFUSAL_LABELS)).toBe(
      "Edited as wikitext: the table is indented with a colon.",
    );

    expect(
      tableRefusalNote(lines("{|", "loose text", "| a", "|}"), REFUSAL_LABELS),
    ).toBe("Edited as wikitext: there is text before its first cell.");

    expect(
      tableRefusalNote(lines("{|", "|+ one", "|+ two", "| cell", "|}"), REFUSAL_LABELS),
    ).toBe("Edited as wikitext: it has more than one caption.");

    expect(tableRefusalNote(lines("{|", "| cell"), REFUSAL_LABELS)).toBe(
      "Edited as wikitext: the table is never closed with |}.",
    );
  });

  it("says nothing about a table the model can edit", () => {
    // The chip is never drawn over one of these, but the decision has to be
    // right on its own: a note on a table that parsed would be a false alarm.
    expect(
      tableRefusalNote(lines("{|", "! A !! B", "|-", "| c || d", "|}"), REFUSAL_LABELS),
    ).toBeNull();
  });

  it("says nothing about a chip that is not a table at all", () => {
    for (const source of [
      "{{Infobox moon}}",
      lines("<gallery>", "File:X.png", "</gallery>"),
      "[[Category:Moons]]",
    ]) {
      expect(tableRefusalNote(source, REFUSAL_LABELS)).toBeNull();
    }
  });
});

/* ---------------------------------------------------------------- */
/* tableDeleteMessage — what the dialog says before the table goes   */
/* ---------------------------------------------------------------- */

const DELETE_LABELS = {
  tableDeleteBody: "The table and everything in it will be removed.",
  tableDeleteLastRowBody: "This is the table's last row, so deleting it deletes the whole table.",
  tableDeleteLastColumnBody:
    "This is the table's last column, so deleting it deletes the whole table.",
};

describe("tableDeleteMessage", () => {
  it("tells an author who asked for a row that the table goes with it", () => {
    // The requirement in one line: deleting the last row deletes the table, and
    // that has to be *said* before it happens rather than discovered after.
    expect(tableDeleteMessage("deleteRow", DELETE_LABELS)).toBe(
      DELETE_LABELS.tableDeleteLastRowBody,
    );
    expect(tableDeleteMessage("deleteColumn", DELETE_LABELS)).toBe(
      DELETE_LABELS.tableDeleteLastColumnBody,
    );
  });

  it("says the plain thing when the table itself is what was asked for", () => {
    expect(tableDeleteMessage("deleteTable", DELETE_LABELS)).toBe(DELETE_LABELS.tableDeleteBody);
  });
});

/* ---------------------------------------------------------------- */
/* mediaFile — a picture dropped on the page (§15)                   */
/* ---------------------------------------------------------------- */

/** A `File` as far as this decision looks at one: only its type is read. */
function fileOf(type: string): File {
  return { type } as File;
}

describe("mediaFile", () => {
  it("takes the one picture on a drag", () => {
    expect(mediaFile({ files: [fileOf("image/png")] })?.type).toBe("image/png");
  });

  it("takes nothing from a drop of several", () => {
    // A batch upload is not what §5.2's dialog is shaped like — one file, then
    // its caption, layout, alignment and width — and taking the first of five
    // silently is worse than taking none.
    expect(mediaFile({ files: [fileOf("image/png"), fileOf("image/jpeg")] })).toBeNull();
  });

  it("takes nothing at all from a drag that is not a file", () => {
    // Which is what dragging the gutter grip is: the drop is a block move
    // (§3.1), and reading it as a picture would cancel the move.
    expect(mediaFile({ files: [] })).toBeNull();
    expect(mediaFile(null)).toBeNull();
  });

  it("reads the type off the file, not off its name", () => {
    // A drag of a file with no extension still says `image/png`. Whether the
    // wiki will *accept* it is `src/lib/media.ts`'s answer, run by the dialog;
    // this decides only whether the drop is a picture or a block move.
    expect(mediaFile({ files: [fileOf("application/pdf")] })).toBeNull();
    expect(mediaFile({ files: [fileOf("image/webp")] })).not.toBeNull();
  });
});

/* ---------------------------------------------------------------- */
/* mentionRows — a search's answer, as rows (§13)                    */
/* ---------------------------------------------------------------- */

describe("mentionRows", () => {
  it("writes a page's link as content rather than as a chip", () => {
    const rows = mentionRows("page", {
      suggestions: [{ pageId: 1, namespace: "main", slug: "gold-bar", title: "Gold bar" }],
    });
    expect(rows.length).toBe(1);
    expect(rows[0].label).toBe("Gold bar");
    // `wikitext`, not `insert`: a link is content the caret can walk through,
    // and `insert` is for the constructs the model does not understand.
    expect(rows[0].action).toEqual({ kind: "wikitext", source: "[[Gold bar]]" });
  });

  it("keeps the colon that stops a category link from filing the page", () => {
    // `[[Category:X]]` files the page into that category and renders nothing
    // (spec §5.8) — the same rule the link dialog and a paste keep.
    const rows = mentionRows("page", {
      suggestions: [{ pageId: 2, namespace: "category", slug: "moons", title: "Moons" }],
    });
    expect(rows[0].action).toEqual({ kind: "wikitext", source: "[[:Category:Moons]]" });
  });

  it("opens the parameter form for a template instead of writing braces", () => {
    // `{{Infobox moon}}` with no parameters is a call that renders nothing
    // (§5.1), so the row raises the dialog on that template.
    const rows = mentionRows("template", { templates: [{ slug: "infobox-moon", title: "Infobox moon" }] });
    expect(rows[0].action).toEqual({ kind: "template", name: "Infobox moon" });
  });

  it("makes no row at all out of a body that is not what the route promised", () => {
    // The rows come off the network. A shape this did not expect has to produce
    // nothing, not a row with `undefined` in it that inserts "[[undefined]]".
    expect(mentionRows("page", null)).toEqual([]);
    expect(mentionRows("page", {})).toEqual([]);
    expect(mentionRows("page", { suggestions: "nope" })).toEqual([]);
    expect(mentionRows("page", { suggestions: [{ title: 4 }, null, {}] })).toEqual([]);
    expect(mentionRows("template", { templates: [{ slug: "x" }] })).toEqual([]);
  });

  it("gives every row a key of its own", () => {
    // Two pages can share a title across namespaces; two rows sharing a key is
    // a row that cannot be picked.
    const rows = mentionRows("page", {
      suggestions: [
        { pageId: 1, namespace: "main", slug: "titan", title: "Titan" },
        { pageId: 2, namespace: "category", slug: "titan", title: "Titan" },
      ],
    });
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
  });
});

/* ---------------------------------------------------------------- */
/* readFragments — "renders nothing" is not "could not render"       */
/* ---------------------------------------------------------------- */

describe("readFragments", () => {
  // The bug this decides: a version tag outside the version being previewed
  // renders "" and MEANS it (versioning.md section 2.1). While "" also stood
  // for a failed render, the surface fell back to drawing the wikitext — so a
  // cell holding <v69>aaa</v69> showed raw markup at every version but v69.
  it("keeps an empty render as an empty render", () => {
    expect(readFragments({ htmls: ["", "<p>x</p>"], failed: [] })).toEqual(["", "<p>x</p>"]);
  });

  it("marks only the indices the route says threw", () => {
    expect(readFragments({ htmls: ["", "<p>x</p>", ""], failed: [2] })).toEqual([
      "",
      "<p>x</p>",
      null,
    ]);
  });

  it("treats a missing failed list as no failures, so an old body still reads", () => {
    expect(readFragments({ htmls: ["", "<p>x</p>"] })).toEqual(["", "<p>x</p>"]);
  });

  it("counts a non-string entry as that index failing, not as an empty render", () => {
    // The route always sends strings; anything else is a body that is not what
    // it promised, and a chip is honest about that where an empty node is not.
    expect(readFragments({ htmls: [null, 7, "<p>x</p>"], failed: [] })).toEqual([
      null,
      null,
      "<p>x</p>",
    ]);
  });

  it("refuses a body that is not the route's shape at all", () => {
    expect(readFragments(null)).toBeNull();
    expect(readFragments({})).toBeNull();
    expect(readFragments({ htmls: "nope" })).toBeNull();
  });

  it("ignores a failed list that is not a list of numbers", () => {
    expect(readFragments({ htmls: [""], failed: "1" })).toEqual([""]);
    expect(readFragments({ htmls: [""], failed: ["0"] })).toEqual([""]);
  });
});

/* ---------------------------------------------------------------- */
/* contextMenuRows — what a right-click offers (section 3.1, 3.2)    */
/* ---------------------------------------------------------------- */

/**
 * Enough of the two bags the decision reads. Naming them after the operations
 * rather than after real copy is what lets the assertions below be about which
 * rows appear, in which order — which is the whole of what this decides.
 */
const CONTEXT_LABELS = {
  table: {
    insertRowAbove: "insertRowAbove",
    insertRowBelow: "insertRowBelow",
    moveRowUp: "moveRowUp",
    moveRowDown: "moveRowDown",
    deleteRow: "deleteRow",
    insertColumnLeft: "insertColumnLeft",
    insertColumnRight: "insertColumnRight",
    moveColumnLeft: "moveColumnLeft",
    moveColumnRight: "moveColumnRight",
    deleteColumn: "deleteColumn",
    headerRowOn: "headerRowOn",
    headerRowOff: "headerRowOff",
    deleteTable: "deleteTable",
  },
  handle: {
    add: "add",
    grip: "grip",
    menu: "menu",
    insertBelow: "insertBelow",
    duplicate: "duplicate",
    delete: "delete",
    moveUp: "moveUp",
    moveDown: "moveDown",
    turnInto: "Turn into",
    formats: { paragraph: "paragraph", h2: "h2" },
  },
};

/** A stand-in for the block element; the decision only ever passes it back. */
const BLOCK = { nodeName: "TABLE" } as unknown as HTMLElement;
const CELL = { nodeName: "TD" } as unknown as HTMLElement;

function state(where: { table?: boolean; up?: boolean; down?: boolean; formats?: string[] } = {}) {
  return {
    at: { top: 0, left: 0 },
    table:
      where.table === true
        ? {
            cell: CELL,
            // The caret in the middle of a 3x3: every operation is offered.
            context: tableContextOf({ row: 1, column: 1, widths: [3, 3, 3], headerRow: false }),
          }
        : null,
    block: BLOCK,
    up: where.up ?? true,
    down: where.down ?? true,
    formats: (where.formats ?? []) as never,
  };
}

function rowsFor(where: Parameters<typeof state>[0] = {}) {
  return contextMenuRows(state(where), CONTEXT_LABELS as never, () => undefined, () => undefined);
}

describe("contextMenuRows", () => {
  it("offers the table operations first, then the block commands", () => {
    // A right-click inside a table is almost always about the table; the
    // block rows are what every block has and can wait below them.
    const keys = rowsFor({ table: true }).map((row) => row.key);
    const firstBlock = keys.findIndex((key) => key.startsWith("block-"));
    const lastTable = keys.map((key) => key.startsWith("table-")).lastIndexOf(true);
    expect(firstBlock).toBeGreaterThan(0);
    expect(lastTable).toBeLessThan(firstBlock);
  });

  it("carries the two the direction asked for by name", () => {
    // "add one to the right, add one below" is the whole reason this exists,
    // and it is why the two "+"s could go.
    const labels = rowsFor({ table: true }).map((row) => row.label);
    expect(labels).toContain("insertColumnRight");
    expect(labels).toContain("insertRowBelow");
  });

  it("offers no table operation outside a table", () => {
    expect(rowsFor().every((row) => row.key.startsWith("block-"))).toBe(true);
  });

  it("leaves out an operation the cell cannot be given rather than disabling it", () => {
    // The slash menu's rule, one control along: a list that is read rather
    // than filtered has no room for rows that refuse. In the first row there
    // is nowhere up, and in the first column nowhere left.
    const corner = contextMenuRows(
      {
        ...state({ table: true }),
        table: {
          cell: CELL,
          context: tableContextOf({ row: 0, column: 0, widths: [3, 3, 3], headerRow: false }),
        },
      },
      CONTEXT_LABELS as never,
      () => undefined,
      () => undefined,
    );
    const labels = corner.map((row) => row.label);
    expect(labels).not.toContain("moveRowUp");
    expect(labels).not.toContain("moveColumnLeft");
    expect(labels).toContain("insertRowBelow");
    expect(labels).toContain("insertColumnRight");
  });

  it("keeps a block command that cannot fire, and disables it", () => {
    // Those four rows are the same four every time; a list that changed
    // length at the ends of a document would move under the pointer.
    const top = rowsFor({ up: false });
    const moveUp = top.find((row) => row.label === "moveUp");
    expect(moveUp?.disabled).toBe(true);
  });

  it("never opens the list with a rule above nothing", () => {
    expect(rowsFor({ table: true })[0].startsGroup).not.toBe(true);
    expect(rowsFor()[0].startsGroup).not.toBe(true);
  });

  it("rules off the block commands from the table's, so the two read apart", () => {
    const rows = rowsFor({ table: true });
    const firstBlock = rows.find((row) => row.key.startsWith("block-"));
    expect(firstBlock?.startsGroup).toBe(true);
  });

  it("offers the formats the block can become, under their own heading", () => {
    const rows = rowsFor({ formats: ["paragraph", "h2"] });
    const heading = rows.find((row) => row.heading !== undefined);
    expect(heading?.heading).toBe("Turn into");
    expect(rows.map((row) => row.label)).toContain("h2");
  });

  it("gives every row a key of its own", () => {
    const rows = rowsFor({ table: true, formats: ["paragraph", "h2"] });
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });
});

/* ---------------------------------------------------------------- */
/* slashContext — when "/" is a menu and when it is a character      */
/* ---------------------------------------------------------------- */

describe("slashContext", () => {
  it("opens on a slash at the start of the line", () => {
    expect(slashContext("/")).toEqual({ query: "", consumed: 1 });
    expect(slashContext("/tab")).toEqual({ query: "tab", consumed: 4 });
  });

  it("opens on one after a space, and on no other", () => {
    expect(slashContext("see /tab")).toEqual({ query: "tab", consumed: 4 });
    // The three that must never open a menu: a file link, a fraction and a URL.
    expect(slashContext("[[File:x.png")).toBeNull();
    expect(slashContext("and/or")).toBeNull();
    expect(slashContext("https://example.com")).toBeNull();
  });

  it("opens on one that starts a line inside the block", () => {
    // Shift+Enter in a paragraph, or Enter in a table cell: `lineTextOf`
    // (ve-selection.ts) writes a "\n" where the line breaks, and this is the
    // half of that fix that has to agree — a "\n" is whitespace, so the slash
    // behind it starts a line. Without the break the reading arrived as
    // "counts/tab", where the slash is inside a word and opens nothing.
    expect(slashContext("counts\n/tab")).toEqual({ query: "tab", consumed: 4 });
    expect(slashContext("counts\n/")).toEqual({ query: "", consumed: 1 });
  });

  it("reads the nearest slash, because that is the one being typed", () => {
    expect(slashContext("/tab /med")).toEqual({ query: "med", consumed: 4 });
    // The nearest one is inside a word, so the author is typing a word — an
    // earlier slash is behind text they have already moved past.
    expect(slashContext("/tab and/or")).toBeNull();
  });
});

/* ---------------------------------------------------------------- */
/* caretHolderSlot — where a click on a host's own box puts a caret  */
/* ---------------------------------------------------------------- */

/** The three shapes the rule tells apart, spelled once. */
const TEXT = { text: true, ends: false };
const BREAK = { text: false, ends: true };
const CHIP = { text: false, ends: false };

describe("caretHolderSlot", () => {
  it("parks nothing in a blank line, whichever end of it was clicked", () => {
    // The bug this rule exists to stop (user report, 2026-09-07: "입력칸을
    // 클릭할때 높이가 늘어나는"). A click right of an empty paragraph's left
    // edge asks for the position after its filler `<br>`, and a holder there
    // is a character on a second line: the blank line the author clicked into
    // doubles in height, and the surface grows under them.
    expect(caretHolderSlot([BREAK], 1)).toEqual({ kind: "none" });
    expect(caretHolderSlot([BREAK], 0)).toEqual({ kind: "none" });
    expect(caretHolderSlot([BREAK, BREAK], 2)).toEqual({ kind: "none" });
  });

  it("parks one beside a chip, which is what it is for", () => {
    // A cell holding two version chips and nothing else: without a text node
    // there is no caret behind the chip and no way to backspace it.
    expect(caretHolderSlot([CHIP, CHIP], 2)).toEqual({ kind: "park", at: 2 });
    expect(caretHolderSlot([CHIP, CHIP], 1)).toEqual({ kind: "park", at: 1 });
    expect(caretHolderSlot([CHIP], 0)).toEqual({ kind: "park", at: 0 });
  });

  it("uses the text that is already there rather than adding to it", () => {
    expect(caretHolderSlot([TEXT, CHIP], 1)).toEqual({ kind: "text", at: 0, end: true });
    expect(caretHolderSlot([CHIP, TEXT], 1)).toEqual({ kind: "text", at: 1, end: false });
  });

  it("parks in front of the break a region ends with, never after it", () => {
    // Same second line, one step along: the click was on the line the content
    // is on, so the caret belongs at the end of it.
    expect(caretHolderSlot([CHIP, BREAK], 2)).toEqual({ kind: "park", at: 1 });
  });
});
