/**
 * Serializer conformance — docs/engine/visual-editor.md §4.
 *
 * Two separate contracts are under test and they must not be confused.
 *
 * - `serializeBlock` / `serializeInline` are the *canonical* renderers: given
 *   a shape, they always produce the same wikitext, and they never look at
 *   where that shape came from. Everything in the first two sections pins
 *   that mapping down, mark by mark and block by block.
 * - `serializeDocument` is the *preservation* layer: it prefers a block's
 *   original `source` while the block still serializes to its `canonical`
 *   fingerprint. That is the whole of §4's "publishing an unedited article
 *   changes nothing", and the last section tests it from both sides —
 *   untouched blocks keep their spelling, edited ones adopt the canonical
 *   form, and one edit never disturbs its neighbours.
 */

import { describe, expect, it } from "vitest";

import { MARK_SYNTAX, newBlockBase } from "./model";
import type {
  VeBlock,
  VeDocument,
  VeHeadingLevel,
  VeInline,
  VeMark,
  VeTable,
  VeTableCell,
  VeTableRow,
} from "./model";
import { parseDocument } from "./parse";
import { serializeBlock, serializeDocument, serializeInline } from "./serialize";

/* ---------------------------------------------------------------- */
/* Fixtures                                                          */
/* ---------------------------------------------------------------- */

function text(value: string): VeInline {
  return { kind: "text", text: value };
}

function mark(name: VeMark, children: VeInline[]): VeInline {
  return { kind: "mark", mark: name, children };
}

function paragraph(id: string, children: VeInline[]): VeBlock {
  return { kind: "paragraph", ...newBlockBase(id), children };
}

function cell(value: string, header = false, attrs = ""): VeTableCell {
  return { header, attrs, children: value === "" ? [] : [text(value)] };
}

function tableBlock(rows: VeTableRow[]): VeTable {
  return { kind: "table", ...newBlockBase("n1"), attrs: "", caption: null, rows };
}

const LEVELS: readonly VeHeadingLevel[] = [1, 2, 3, 4, 5, 6];

/* ---------------------------------------------------------------- */
/* Inline                                                            */
/* ---------------------------------------------------------------- */

describe("serializeInline", () => {
  it("emits text verbatim and escapes nothing", () => {
    expect(serializeInline([])).toBe("");
    expect(serializeInline([text("plain")])).toBe("plain");
    // §4/§7: no `<nowiki>` is ever inserted, even around text that reads as
    // markup. What the author typed is what gets saved.
    expect(serializeInline([text("literal '' and {{ and [[")])).toBe("literal '' and {{ and [[");
  });

  it("wraps each mark in its own syntax", () => {
    expect(serializeInline([mark("bold", [text("x")])])).toBe("'''x'''");
    expect(serializeInline([mark("italic", [text("x")])])).toBe("''x''");
    expect(serializeInline([mark("underline", [text("x")])])).toBe("<u>x</u>");
    expect(serializeInline([mark("strike", [text("x")])])).toBe("<s>x</s>");
    expect(serializeInline([mark("sup", [text("x")])])).toBe("<sup>x</sup>");
    expect(serializeInline([mark("sub", [text("x")])])).toBe("<sub>x</sub>");
    expect(serializeInline([mark("code", [text("x")])])).toBe("<code>x</code>");
  });

  it("gets bold-italic for free by nesting — five apostrophes, both ends", () => {
    const nested = mark("bold", [mark("italic", [text("both")])]);
    expect(serializeInline([nested])).toBe("'''''both'''''");
    // The nesting, not a special case, is what produces the five: three from
    // the bold wrapper plus two from the italic one (spec §1.1).
    expect(MARK_SYNTAX.bold.before + MARK_SYNTAX.italic.before).toBe("'''''");
    expect(MARK_SYNTAX.italic.after + MARK_SYNTAX.bold.after).toBe("'''''");
    // Italic outside bold is the other legal spelling of the same five.
    expect(serializeInline([mark("italic", [mark("bold", [text("both")])])])).toBe(
      "'''''both'''''",
    );
  });

  it("writes a link bare when its label adds nothing", () => {
    expect(serializeInline([{ kind: "link", target: "Titan", children: [text("Titan")] }])).toBe(
      "[[Titan]]",
    );
    expect(
      serializeInline([{ kind: "link", target: "Titan", children: [text("the moon")] }]),
    ).toBe("[[Titan|the moon]]");
    expect(serializeInline([{ kind: "link", target: "Titan", children: [] }])).toBe("[[Titan|]]");
    expect(
      serializeInline([
        { kind: "link", target: "Titan", children: [mark("italic", [text("Titan")])] },
      ]),
    ).toBe("[[Titan|''Titan'']]");
  });

  it("writes an external link with a label only when it has one", () => {
    expect(serializeInline([{ kind: "extlink", href: "https://lethal.wiki", children: [] }])).toBe(
      "[https://lethal.wiki]",
    );
    expect(
      serializeInline([
        { kind: "extlink", href: "https://lethal.wiki", children: [text("the wiki")] },
      ]),
    ).toBe("[https://lethal.wiki the wiki]");
  });

  it("emits atomics and breaks from their remembered source", () => {
    expect(
      serializeInline([
        { kind: "atomic", atomic: "template", source: "{{Verify|weather}}", label: "Verify" },
      ]),
    ).toBe("{{Verify|weather}}");
    expect(serializeInline([{ kind: "break", source: "<br />" }])).toBe("<br />");
  });
});

/* ---------------------------------------------------------------- */
/* Blocks                                                            */
/* ---------------------------------------------------------------- */

describe("serializeBlock", () => {
  it("writes a paragraph as its inline run", () => {
    expect(serializeBlock(paragraph("n1", [text("One "), mark("bold", [text("two")])]))).toBe(
      "One '''two'''",
    );
  });

  it("writes a heading spaced, at its own level", () => {
    for (const level of LEVELS) {
      expect(
        serializeBlock({
          kind: "heading",
          ...newBlockBase("n1"),
          level,
          children: [text("Overview")],
        }),
      ).toBe(`${"=".repeat(level)} Overview ${"=".repeat(level)}`);
    }
  });

  it("writes a list one item per line, each keeping its literal marker", () => {
    expect(
      serializeBlock({
        kind: "list",
        ...newBlockBase("n1"),
        items: [
          { marker: "*", children: [text("one")] },
          { marker: "**", children: [text("two")] },
          { marker: "#*", children: [text("three")] },
          { marker: ";", children: [text("term")] },
        ],
      }),
    ).toBe("* one\n** two\n#* three\n; term");
  });

  it("writes a rule at its own length and an atomic from its source", () => {
    expect(serializeBlock({ kind: "rule", ...newBlockBase("n1"), dashes: 4 })).toBe("----");
    expect(serializeBlock({ kind: "rule", ...newBlockBase("n1"), dashes: 7 })).toBe("-------");
    expect(
      serializeBlock({
        kind: "atomic",
        ...newBlockBase("n1"),
        atomic: "table",
        source: "{|\n| a\n|}",
        label: "table",
      }),
    ).toBe("{|\n| a\n|}");
  });

  it("never adds a trailing newline — the gap belongs to the document", () => {
    const doc = parseDocument("* a\n* b\n\nAfter.\n");
    for (const block of doc.blocks) expect(serializeBlock(block).endsWith("\n")).toBe(false);
  });
});

/* ---------------------------------------------------------------- */
/* Tables — the canonical form                                       */
/* ---------------------------------------------------------------- */

describe("serializeBlock, on a table", () => {
  it("writes the canonical form of visual-editor.md's table mapping", () => {
    expect(
      serializeBlock({
        kind: "table",
        ...newBlockBase("n1"),
        attrs: 'class="wikitable"',
        caption: [text("Scrap values")],
        rows: [
          { attrs: "", cells: [cell("Item", true), cell("Value", true)] },
          { attrs: "", cells: [cell("Gold bar"), cell("210")] },
        ],
      }),
    ).toBe(
      '{| class="wikitable"\n' +
        "|+ Scrap values\n" +
        "|-\n" +
        "! Item !! Value\n" +
        "|-\n" +
        "| Gold bar || 210\n" +
        "|}",
    );
  });

  it("omits what is empty: no attributes, no caption, no `|-` attributes", () => {
    expect(serializeBlock(tableBlock([{ attrs: "", cells: [cell("a")] }]))).toBe("{|\n|-\n| a\n|}");
    // A caption that exists and is empty is not the same as no caption, and
    // both spellings read back as what they say.
    expect(serializeBlock({ ...tableBlock([{ attrs: "", cells: [cell("a")] }]), caption: [] })).toBe(
      "{|\n|+\n|-\n| a\n|}",
    );
  });

  it("writes each attribute string verbatim, in the place the parser found it", () => {
    expect(
      serializeBlock({
        ...tableBlock([{ attrs: 'bgcolor="#eee"', cells: [cell("x", false, 'colspan="2"')] }]),
        attrs: 'class="wikitable sortable"',
      }),
    ).toBe('{| class="wikitable sortable"\n|- bgcolor="#eee"\n| colspan="2" | x\n|}');
  });

  it("gives a row one line per run of like cells, because `||` splits both", () => {
    // Spec §7.3: a header line splits on `||` as well as on `!!`, so a `<td>`
    // cannot share a line with a `<th>`. A uniform row is one line; a mixed
    // one is as many lines as it has runs.
    expect(
      serializeBlock(
        tableBlock([{ attrs: "", cells: [cell("A", true), cell("b"), cell("C", true)] }]),
      ),
    ).toBe("{|\n|-\n! A\n| b\n! C\n|}");
    expect(
      serializeBlock(
        tableBlock([{ attrs: "", cells: [cell("A", true), cell("B", true), cell("c")] }]),
      ),
    ).toBe("{|\n|-\n! A !! B\n| c\n|}");
  });

  it("splits a cell an author typed `||` into, which is the trade §4 makes everywhere", () => {
    // Nothing is escaped, here or anywhere else in this file, so a cell whose
    // text an author has typed a `||` into comes back as two cells — the same
    // bargain as a typed `''` coming back italic. The parser's own splitting
    // is what guarantees a cell it produced can never hold one.
    const typed = tableBlock([{ attrs: "", cells: [cell("a || b")] }]);
    expect(serializeBlock(typed)).toBe("{|\n|-\n| a || b\n|}");
    const reread = parseDocument("{|\n|-\n| a || b\n|}\n").blocks[0];
    if (reread.kind !== "table") throw new Error("expected a table");
    expect(reread.rows[0].cells.map((one) => serializeInline(one.children))).toEqual(["a", "b"]);
  });

  it("serializes a cell's inline children like any other inline run", () => {
    expect(
      serializeBlock(
        tableBlock([
          {
            attrs: "",
            cells: [
              { header: false, attrs: "", children: [mark("bold", [text("Stalking")])] },
              { header: false, attrs: "", children: [{ kind: "link", target: "Titan", children: [text("Titan")] }] },
            ],
          },
        ]),
      ),
    ).toBe("{|\n|-\n| '''Stalking''' || [[Titan]]\n|}");
  });
});

describe("the canonical table is a fixed point", () => {
  const CANONICAL = [
    '{| class="wikitable"\n|+ Scrap values\n|-\n! Item !! Value\n|-\n| Gold bar || 210\n|}\n',
    "{|\n|-\n| a\n|}\n",
    "{|\n|+\n|-\n| a\n|}\n",
    "{|\n|-\n!  !! \n|-\n|  || \n|}\n",
    '{| class="x"\n|- bgcolor="#eee"\n| colspan="2" | wide || plain\n|}\n',
    "{|\n|-\n! A\n| b\n! C\n|}\n",
    "{|\n|-\n| [[Titan]] || '''bold''' || {{Verify|x}}\n|}\n",
    "{|\n|-\n| a | b\n|}\n",
  ];

  it.each(CANONICAL)("%j survives parse → serialize unchanged", (wikitext) => {
    // The property the whole feature rests on: what this serializer writes,
    // the parser reads back as the same table. Where that fails the parser
    // refuses the table instead (parse.test.ts), so this list is also the list
    // of shapes an author is allowed to end up with.
    const doc = parseDocument(wikitext);
    expect(doc.blocks.map((block) => block.kind)).toEqual(["table"]);
    expect(serializeDocument(doc)).toBe(wikitext);
    expect(doc.blocks[0].canonical).toBe(wikitext.slice(0, -1));
  });
});

/* ---------------------------------------------------------------- */
/* Documents — the §4 preservation rule                              */
/* ---------------------------------------------------------------- */

describe("serializeDocument", () => {
  it("gives blocks minted in the editor a blank line, and the last one a newline", () => {
    const doc: VeDocument = {
      leading: "",
      blocks: [paragraph("n1", [text("Alpha")]), paragraph("n2", [text("Beta")])],
    };
    expect(serializeDocument(doc)).toBe("Alpha\n\nBeta\n");
  });

  it("emits `leading` ahead of the first block", () => {
    const doc = parseDocument("\n\nFirst.\n");
    expect(doc.leading).toBe("\n\n");
    expect(serializeDocument(doc)).toBe("\n\nFirst.\n");
  });

  it("keeps an untouched block's own spelling even where canonical differs", () => {
    // Both of these serialize to something OTHER than their source: the
    // paragraph loses its line break, the heading gains spaces. Neither may
    // change on a save that did not touch them.
    const source = "==Tight==\n\nOne\ntwo\n";
    const doc = parseDocument(source);
    expect(doc.blocks[0].canonical).toBe("== Tight ==");
    expect(doc.blocks[1].canonical).toBe("One two");
    expect(serializeDocument(doc)).toBe(source);
  });

  it("emits the canonical form for a block the author edited", () => {
    const doc = parseDocument("==Tight==\n\nOne\ntwo\n");
    const heading = doc.blocks[0];
    if (heading.kind !== "heading") throw new Error("expected a heading");
    heading.children = [text("Loose")];
    expect(serializeDocument(doc)).toBe("== Loose ==\n\nOne\ntwo\n");
  });

  it("rewrites only the edited block, leaving every other byte alone", () => {
    const source = "== H ==\n\nOne\ntwo\n\n* item\n\n{{Infobox\n| a = 1\n}}\n";
    const doc = parseDocument(source);
    const body = doc.blocks[1];
    if (body.kind !== "paragraph") throw new Error("expected a paragraph");
    body.children = [text("One two three")];
    expect(serializeDocument(doc)).toBe(
      "== H ==\n\nOne two three\n\n* item\n\n{{Infobox\n| a = 1\n}}\n",
    );
  });

  it("re-emits an atomic from its source no matter what was done to it", () => {
    const source = "{{Infobox\n| a = 1\n}}\n";
    const doc = parseDocument(source);
    const block = doc.blocks[0];
    if (block.kind !== "atomic") throw new Error("expected an atomic");
    // The dialog is the only way to change an atomic, and it changes `source`
    // itself (§5) — which is exactly what comes back out.
    block.source = "{{Infobox\n| a = 2\n}}";
    expect(serializeDocument(doc)).toBe("{{Infobox\n| a = 2\n}}\n");
  });

  it("keeps a block's original gap, and defaults only where there is none", () => {
    const doc = parseDocument("A\n\n\n\nB");
    expect(serializeDocument(doc)).toBe("A\n\n\n\nB");
    // `B` ended the document, so its gap is the empty one. It cannot separate
    // the block that just arrived behind it, and the default takes over.
    doc.blocks.push(paragraph("n1", [text("C")]));
    expect(serializeDocument(doc)).toBe("A\n\n\n\nB\n\nC\n");
  });

  it("re-derives a gap that no longer separates the pair it now sits between", () => {
    // The commonest edit there is: caret at the end of the page, Enter, type.
    // Every seeded article ends in a lone "\n", so the last block's gap is
    // "\n" — which used to glue the new paragraph onto the previous one.
    const doc = parseDocument("Alpha.\n\nBravo.\n");
    doc.blocks.push(paragraph("n1", [text("Charlie.")]));
    expect(serializeDocument(doc)).toBe("Alpha.\n\nBravo.\n\nCharlie.\n");

    // Same for a run of list items: "\n" between two list blocks is one list.
    const list = parseDocument("* one\n");
    list.blocks.push({
      kind: "list",
      ...newBlockBase("n1"),
      items: [{ marker: "*", children: [text("two")] }],
    });
    expect(serializeDocument(list)).toBe("* one\n\n* two\n");
  });

  it("keeps a single-newline gap where it still separates the pair", () => {
    // A paragraph and the heading under it are a legal single-newline pair,
    // and re-deriving that gap would rewrite an article nobody edited (§4).
    const doc = parseDocument("Alpha.\n== H ==\nBody.\n");
    expect(doc.blocks.map((block) => block.gapAfter)).toEqual(["\n", "\n", "\n"]);
    const body = doc.blocks[2];
    if (body.kind !== "paragraph") throw new Error("expected a paragraph");
    body.children = [text("Edited.")];
    expect(serializeDocument(doc)).toBe("Alpha.\n== H ==\nEdited.\n");
  });
});
