/**
 * Parser conformance — docs/engine/visual-editor.md §2 (model) and §4
 * (round-trip guarantee).
 *
 * Three things are being pinned down here, in this order of importance:
 *
 * 1. **The accounting.** `leading`, every `source` and every `gapAfter` are
 *    consecutive slices of the normalized input. If that ever stops holding,
 *    §4 is dead, so `covers()` re-asserts it on every fixture in the file.
 * 2. **Classification**, branch by branch (a–l of the block rules, then every
 *    inline branch), because the wrong branch means the wrong chip and the
 *    wrong editing affordance.
 * 3. **The awkward cases** that decide whether the surface is usable on real
 *    articles: a file caption holding a link, a template opened mid-sentence,
 *    a mixed list run, and the various half-written constructs an author
 *    hits mid-keystroke.
 *
 * roundtrip.test.ts is where the seed corpus proves the same properties on
 * text nobody wrote for a test.
 */

import { describe, expect, it } from "vitest";

import {
  atomicKindOf,
  atomicLabelOf,
  parseDocument,
  parseInlineRun,
  parseTableWikitext,
} from "./parse";
import type { VeBlock, VeInline, VeTable } from "./model";
import { serializeInline } from "./serialize";

/* ---------------------------------------------------------------- */
/* Helpers                                                           */
/* ---------------------------------------------------------------- */

/** `paragraph`, `heading`, … with the chip kind spelled out for atomics. */
function kinds(wikitext: string): string[] {
  return parseDocument(wikitext).blocks.map((block) =>
    block.kind === "atomic" ? `atomic:${block.atomic}` : block.kind,
  );
}

function sources(wikitext: string): (string | null)[] {
  return parseDocument(wikitext).blocks.map((block) => block.source);
}

function gaps(wikitext: string): (string | null)[] {
  return parseDocument(wikitext).blocks.map((block) => block.gapAfter);
}

/**
 * The §4 accounting: the document is exactly `leading` followed by every
 * block's `source` and `gapAfter`, in order.
 */
function covers(wikitext: string): string {
  const doc = parseDocument(wikitext);
  let out = doc.leading;
  for (const block of doc.blocks) out += (block.source ?? "") + (block.gapAfter ?? "");
  return out;
}

function firstBlock(wikitext: string): VeBlock {
  const doc = parseDocument(wikitext);
  const block = doc.blocks[0];
  if (block === undefined) throw new Error("expected at least one block");
  return block;
}

/** The one inline node a fixture is about, when it produces exactly one. */
function onlyInline(text: string): VeInline {
  const nodes = parseInlineRun(text);
  expect(nodes).toHaveLength(1);
  const node = nodes[0];
  if (node === undefined) throw new Error("expected one inline node");
  return node;
}

/* ---------------------------------------------------------------- */
/* Block classification — rules a–l                                  */
/* ---------------------------------------------------------------- */

describe("block classification", () => {
  it("a — a run of four or more hyphens is a rule, keeping its length", () => {
    const block = firstBlock("----\n");
    expect(block.kind).toBe("rule");
    if (block.kind !== "rule") throw new Error("expected a rule");
    expect(block.dashes).toBe(4);
    if (firstBlock("-------\n").kind !== "rule") throw new Error("expected a rule");
    expect(kinds("-------\n")).toEqual(["rule"]);
    // Three hyphens are not a rule; they are prose (spec §3.4).
    expect(kinds("---\n")).toEqual(["paragraph"]);
  });

  it("b — headings take their level from the marker length", () => {
    const block = firstBlock("== Overview ==\n");
    if (block.kind !== "heading") throw new Error("expected a heading");
    expect(block.level).toBe(2);
    expect(block.children).toEqual([{ kind: "text", text: "Overview" }]);
    expect(kinds("====== Deep ======\n")).toEqual(["heading"]);
    expect(kinds("= One =\n")).toEqual(["heading"]);
    // Unbalanced markers fall through to the shorter level (blocks.ts §2.1).
    const uneven = firstBlock("=== Three =\n");
    if (uneven.kind !== "heading") throw new Error("expected a heading");
    expect(uneven.level).toBe(1);
    expect(uneven.children).toEqual([{ kind: "text", text: "== Three" }]);
  });

  it("c — #REDIRECT is a block only at the very start of the document", () => {
    const block = firstBlock("#REDIRECT [[Titan]]\n");
    if (block.kind !== "atomic") throw new Error("expected an atomic");
    expect(block.atomic).toBe("redirect");
    expect(block.label).toBe("Titan");
    expect(kinds("#redirect [[Titan]]\n")).toEqual(["atomic:redirect"]);
    // Further down it is just a numbered list line.
    expect(kinds("Intro.\n\n#REDIRECT [[Titan]]\n")).toEqual(["paragraph", "list"]);
  });

  it("d — a leading space or tab starts a preformatted block, run-length", () => {
    expect(kinds(" one\n\ttwo\nthree\n")).toEqual(["atomic:pre", "paragraph"]);
    expect(sources(" one\n\ttwo\nthree\n")).toEqual([" one\n\ttwo", "three"]);
  });

  it("e — an HTML comment consumes through its closer", () => {
    expect(kinds("<!-- a\nb -->\nAfter.\n")).toEqual(["atomic:comment", "paragraph"]);
    expect(sources("<!-- a\nb -->\nAfter.\n")).toEqual(["<!-- a\nb -->", "After."]);
    // Never terminated: the rest of the document is the comment.
    expect(kinds("<!-- forever\nand ever\n")).toEqual(["atomic:comment"]);
  });

  it("f — a category link is one atomic line", () => {
    const block = firstBlock("[[Category:Moons]]\n");
    if (block.kind !== "atomic") throw new Error("expected an atomic");
    expect(block.atomic).toBe("category");
    expect(block.label).toBe("Moons");
    expect(kinds("[[Category:Moons]]\n[[Category:Tier 3]]\n")).toEqual([
      "atomic:category",
      "atomic:category",
    ]);
  });

  it("g — a line that is exactly one file link is media, otherwise prose", () => {
    const block = firstBlock("[[File:Map.png|thumb|The map]]\n");
    if (block.kind !== "atomic") throw new Error("expected an atomic");
    expect(block.atomic).toBe("media");
    expect(block.label).toBe("Map.png");
    expect(kinds("[[Image:Map.png]]\n")).toEqual(["atomic:media"]);
    // Anything after the link makes the line a paragraph again.
    expect(kinds("[[File:Map.png]] and a caption\n")).toEqual(["paragraph"]);
  });

  it("h — a table brace-matches its close, nesting included", () => {
    // The block's extent is one question and its kind is another: both tables
    // here end at the `|}` that closes THEM, and the nested one then refuses
    // into the atomic chip it has always been (§7.9 — a cell holds inline
    // content, not a table).
    const flat = '{| class="wikitable"\n! A !! B\n|-\n| 1 || 2\n|}\nAfter.\n';
    expect(kinds(flat)).toEqual(["table", "paragraph"]);
    expect(sources(flat)[0]).toBe('{| class="wikitable"\n! A !! B\n|-\n| 1 || 2\n|}');
    const nested = "{|\n| outer\n{|\n| inner\n|}\n|}\nAfter.\n";
    expect(kinds(nested)).toEqual(["atomic:table", "paragraph"]);
    expect(sources(nested)[0]).toBe("{|\n| outer\n{|\n| inner\n|}\n|}");
  });

  it("i — a template block is one whose call ends flush with a line", () => {
    const infobox = "{{Infobox_moon\n| name = 68-Artifice\n}}\n'''68-Artifice''' is a moon.\n";
    expect(kinds(infobox)).toEqual(["atomic:template", "paragraph"]);
    const block = firstBlock(infobox);
    if (block.kind !== "atomic") throw new Error("expected an atomic");
    expect(block.label).toBe("Infobox_moon");
    // Not flush: the call is part of the sentence it was written in.
    expect(kinds("{{Verify|weather}} is the caveat.\n")).toEqual(["paragraph"]);
  });

  it("j — block tags become atomics of their mapped kind", () => {
    expect(kinds("<gallery>\nA.png\n</gallery>\n")).toEqual(["atomic:gallery"]);
    expect(kinds("<infobox>\n<title source=\"name\"/>\n</infobox>\n")).toEqual(["atomic:infobox"]);
    expect(kinds("<tabber>\nA=one\n</tabber>\n")).toEqual(["atomic:tabber"]);
    // A version tag has no fixed name to look up in the block table: the name
    // IS the range (versioning.md §2.1), so all three shapes classify by shape.
    expect(kinds("<v45+v55>x</v45+v55>\n")).toEqual(["atomic:versions"]);
    expect(kinds("<v62+>Only from v62.</v62+>\n")).toEqual(["atomic:versions"]);
    expect(kinds("<v64.1>Only in v64.1.</v64.1>\n")).toEqual(["atomic:versions"]);
    // And a name that only looks like one is not in the block table at all, so
    // it stays inline markup inside its paragraph like any unknown element.
    expect(kinds("<v62x>x</v62x>\n")).toEqual(["paragraph"]);
    expect(kinds("<pre>\ncode\n</pre>\n")).toEqual(["atomic:pre"]);
    expect(kinds("<poem>\nline\n</poem>\n")).toEqual(["atomic:pre"]);
    expect(kinds("<syntaxhighlight lang=\"js\">\nlet a = 1;\n</syntaxhighlight>\n")).toEqual([
      "atomic:pre",
    ]);
    expect(kinds("<div class=\"note\">\nText.\n</div>\n")).toEqual(["atomic:html"]);
    expect(kinds("<table>\n<tr><td>a</td></tr>\n</table>\n")).toEqual(["atomic:html"]);
    expect(kinds("<references />\nAfter.\n")).toEqual(["atomic:html", "paragraph"]);
    // Nested same-name elements are matched by depth, not by first close.
    expect(sources("<div>\n<div>in</div>\n</div>\n")[0]).toBe("<div>\n<div>in</div>\n</div>");
    // `ref`, `nowiki` and `math` are inline even at the head of a line.
    expect(kinds("<ref>A citation.</ref>\n")).toEqual(["paragraph"]);
  });

  it("j — a raw-text block ends at the first close, not a balanced one", () => {
    const source = "<pre>\n<v50+v61>130</v50+v61><v62+>180</v62+>\n</pre>\n";
    expect(kinds(source)).toEqual(["atomic:pre"]);
    expect(sources(source)[0]).toBe(source.trimEnd());
  });

  it("k — a list run keeps every literal marker, flat", () => {
    const block = firstBlock("* one\n** two\n#* three\n: four\n");
    if (block.kind !== "list") throw new Error("expected a list");
    expect(block.items.map((item) => item.marker)).toEqual(["*", "**", "#*", ":"]);
    expect(block.items.map((item) => item.children)).toEqual([
      [{ kind: "text", text: "one" }],
      [{ kind: "text", text: "two" }],
      [{ kind: "text", text: "three" }],
      [{ kind: "text", text: "four" }],
    ]);
  });

  it("k — exactly one leading space is dropped from an item, no more", () => {
    const block = firstBlock("*  two spaces\n*no space\n");
    if (block.kind !== "list") throw new Error("expected a list");
    expect(block.items[0].children).toEqual([{ kind: "text", text: " two spaces" }]);
    expect(block.items[1].children).toEqual([{ kind: "text", text: "no space" }]);
  });

  it("l — a paragraph folds its internal newlines to spaces", () => {
    const block = firstBlock("One line\nand another\n");
    if (block.kind !== "paragraph") throw new Error("expected a paragraph");
    expect(block.children).toEqual([{ kind: "text", text: "One line and another" }]);
    expect(block.source).toBe("One line\nand another");
  });

  it("l — a paragraph stops at every interrupting line shape", () => {
    expect(kinds("Text.\n----\n")).toEqual(["paragraph", "rule"]);
    expect(kinds("Text.\n== H ==\n")).toEqual(["paragraph", "heading"]);
    expect(kinds("Text.\n indented\n")).toEqual(["paragraph", "atomic:pre"]);
    expect(kinds("Text.\n[[Category:X]]\n")).toEqual(["paragraph", "atomic:category"]);
    expect(kinds("Text.\n{|\n|}\n")).toEqual(["paragraph", "atomic:table"]);
    expect(kinds("Text.\n<gallery>\nA.png\n</gallery>\n")).toEqual(["paragraph", "atomic:gallery"]);
    expect(kinds("Text.\n* item\n")).toEqual(["paragraph", "list"]);
  });

  it("l — it stops there even with a construct left open, exactly as the engine does", () => {
    // The typo repro: one missing brace on line 3. `POST /api/preview` on this
    // text renders `<p>The weather is {{Verify|storm}.</p>` and then the
    // heading, the list, the table and the category as blocks of their own, so
    // the editor has to see the same six. It used to see TWO — the second
    // holding the whole remainder of the article — and editing that paragraph
    // published the page without everything below it.
    const source =
      "Artifice is a moon with a difficulty rating of S.\n\n" +
      "The weather is {{Verify|storm}.\n\n" +
      "== Layout ==\n\n" +
      "* Main entrance\n* Fire exit\n\n" +
      '{| class="wikitable"\n! Item !! Value\n|-\n| Ship || 1\n|}\n\n' +
      "[[Category:Moons]]\n";
    expect(kinds(source)).toEqual([
      "paragraph",
      "paragraph",
      "heading",
      "list",
      "table",
      "atomic:category",
    ]);
    expect(sources(source)[1]).toBe("The weather is {{Verify|storm}.");
    expect(covers(source)).toBe(source);
  });

  it("l — an unclosed `[[`, or a tag name merely mentioned in prose, ends there too", () => {
    expect(kinds("Intro [[Titan\n\n== H ==\n")).toEqual(["paragraph", "heading"]);
    expect(kinds("Wrap it in a <div> to float it.\n\n== H ==\n")).toEqual(["paragraph", "heading"]);
    expect(kinds("A <table> is a grid.\n* item\n")).toEqual(["paragraph", "list"]);
    expect(kinds("Use <section> sparingly.\n[[Category:X]]\n")).toEqual([
      "paragraph",
      "atomic:category",
    ]);
    expect(kinds("A <pre> holds code.\n\nMore.\n")).toEqual(["paragraph", "paragraph"]);
    expect(kinds("Read <source> as a synonym.\n----\n")).toEqual(["paragraph", "rule"]);
  });

  it("l — only what the engine resolves before the block scan holds a paragraph open", () => {
    // All five verified against `POST /api/preview`. The preprocessor expands
    // `{{…}}` and lifts `<ref>` out whole before there are any blocks, so both
    // keep their paragraph together across a line that would otherwise end it.
    // The link parser and §11.2 tag balancing run per block instead, so `[[`
    // and `<div>` are literal text on either side of the break.
    expect(kinds("Text {{Foo|\n\nbar}} more\n")).toEqual(["paragraph"]);
    expect(kinds("The cost is {{#vswitch:\n* v50=1400\n}} credits.\n")).toEqual(["paragraph"]);
    expect(kinds("A <ref>x\n\ny</ref> B\n")).toEqual(["paragraph"]);
    expect(kinds("A [[Foo\n\nbar]] B\n")).toEqual(["paragraph", "paragraph"]);
    expect(kinds("A <div>x\n\ny</div> B\n")).toEqual(["paragraph", "paragraph"]);
  });
});

/* ---------------------------------------------------------------- */
/* Bookkeeping — leading, gaps, normalization                        */
/* ---------------------------------------------------------------- */

describe("document bookkeeping", () => {
  it("gives blocks positional ids", () => {
    expect(parseDocument("A\n\nB\n\nC\n").blocks.map((b) => b.id)).toEqual(["b0", "b1", "b2"]);
  });

  it("puts everything before the first block in `leading`", () => {
    const doc = parseDocument("\n\n  \nFirst.\n");
    expect(doc.leading).toBe("\n\n  \n");
    expect(doc.blocks).toHaveLength(1);
    expect(covers("\n\n  \nFirst.\n")).toBe("\n\n  \nFirst.\n");
  });

  it("records the exact gap after each block", () => {
    expect(gaps("A\n\nB\n")).toEqual(["\n\n", "\n"]);
    expect(gaps("A\n\n\n\nB")).toEqual(["\n\n\n\n", ""]);
    expect(gaps("A\n== H ==\n")).toEqual(["\n", "\n"]);
  });

  it("consumes the gap line-wise, so a following pre line survives", () => {
    const source = "Intro.\n\n   \n code\n";
    expect(gaps(source)[0]).toBe("\n\n   \n");
    expect(kinds(source)).toEqual(["paragraph", "atomic:pre"]);
    expect(covers(source)).toBe(source);
  });

  it("normalizes CRLF and lone CR before anything else", () => {
    const doc = parseDocument("A\r\n\r\nB\rC\r\n");
    expect(doc.blocks.map((b) => b.source)).toEqual(["A", "B\nC"]);
    expect(covers("A\r\n\r\nB\rC\r\n")).toBe("A\n\nB\nC\n");
  });

  it("handles an empty document, a blank one, and one with no final newline", () => {
    expect(parseDocument("")).toEqual({ leading: "", blocks: [] });
    expect(parseDocument("  \n\n")).toEqual({ leading: "  \n\n", blocks: [] });
    expect(gaps("No trailing newline")).toEqual([""]);
    expect(covers("No trailing newline")).toBe("No trailing newline");
  });

  it("stores `canonical` as the block's own serialization at parse time", () => {
    const doc = parseDocument("==Tight==\n\nOne\ntwo\n");
    expect(doc.blocks[0].canonical).toBe("== Tight ==");
    expect(doc.blocks[0].source).toBe("==Tight==");
    expect(doc.blocks[1].canonical).toBe("One two");
    expect(doc.blocks[1].source).toBe("One\ntwo");
  });
});

/* ---------------------------------------------------------------- */
/* Inline branches                                                   */
/* ---------------------------------------------------------------- */

describe("parseInlineRun", () => {
  it("coalesces plain text and returns nothing for an empty run", () => {
    expect(parseInlineRun("")).toEqual([]);
    expect(parseInlineRun("just prose")).toEqual([{ kind: "text", text: "just prose" }]);
    expect(parseInlineRun("a<b>x</b>c")).toEqual([
      { kind: "text", text: "a" },
      { kind: "mark", mark: "bold", children: [{ kind: "text", text: "x" }] },
      { kind: "text", text: "c" },
    ]);
  });

  it("takes comments, parameters and templates as atomics", () => {
    expect(onlyInline("<!-- hidden -->")).toEqual({
      kind: "atomic",
      atomic: "comment",
      source: "<!-- hidden -->",
      label: "comment",
    });
    expect(onlyInline("{{{cost|0}}}")).toEqual({
      kind: "atomic",
      atomic: "magic",
      source: "{{{cost|0}}}",
      label: "cost",
    });
    expect(onlyInline("{{Verify|weather pool}}")).toEqual({
      kind: "atomic",
      atomic: "template",
      source: "{{Verify|weather pool}}",
      label: "Verify",
    });
    // Brace matching, not a lazy `}}` search.
    expect(onlyInline("{{#if:{{{a|}}}|yes|no}}").kind).toBe("atomic");
    expect(parseInlineRun("{{#if:{{{a|}}}|yes|no}}")).toEqual([
      { kind: "atomic", atomic: "template", source: "{{#if:{{{a|}}}|yes|no}}", label: "#if:" },
    ]);
  });

  it("takes nowiki, ref and math elements whole", () => {
    expect(onlyInline("<nowiki>[[not a link]]</nowiki>")).toEqual({
      kind: "atomic",
      atomic: "nowiki",
      source: "<nowiki>[[not a link]]</nowiki>",
      label: "nowiki",
    });
    expect(onlyInline("<ref name=\"a\">A citation.</ref>").kind).toBe("atomic");
    expect(parseInlineRun("<ref name=\"a\" />")).toEqual([
      { kind: "atomic", atomic: "ref", source: "<ref name=\"a\" />", label: "ref" },
    ]);
    expect(parseInlineRun("<math>x^2</math>")).toEqual([
      { kind: "atomic", atomic: "html", source: "<math>x^2</math>", label: "math" },
    ]);
  });

  it("keeps a break's exact spelling", () => {
    for (const spelling of ["<br>", "<br/>", "<br />", "<BR />"]) {
      expect(onlyInline(spelling)).toEqual({ kind: "break", source: spelling });
    }
  });

  it("maps every HTML mark spelling onto the seven marks", () => {
    const cases: [string, string][] = [
      ["b", "bold"],
      ["strong", "bold"],
      ["i", "italic"],
      ["em", "italic"],
      ["u", "underline"],
      ["ins", "underline"],
      ["s", "strike"],
      ["del", "strike"],
      ["strike", "strike"],
      ["sup", "sup"],
      ["sub", "sub"],
      ["code", "code"],
      ["tt", "code"],
    ];
    for (const [tag, mark] of cases) {
      expect(onlyInline(`<${tag}>x</${tag}>`)).toEqual({
        kind: "mark",
        mark,
        children: [{ kind: "text", text: "x" }],
      });
    }
  });

  it("keeps any other element as one html atomic", () => {
    expect(onlyInline("<span class=\"nowrap\">1500</span>")).toEqual({
      kind: "atomic",
      atomic: "html",
      source: "<span class=\"nowrap\">1500</span>",
      label: "span",
    });
    expect(onlyInline("<small>note</small>").kind).toBe("atomic");
  });

  it("splits a wiki link on the first pipe and parses the label", () => {
    expect(onlyInline("[[Titan]]")).toEqual({
      kind: "link",
      target: "Titan",
      children: [{ kind: "text", text: "Titan" }],
    });
    expect(onlyInline("[[Teleporters|inverse teleporter]]")).toEqual({
      kind: "link",
      target: "Teleporters",
      children: [{ kind: "text", text: "inverse teleporter" }],
    });
    expect(onlyInline("[[Titan|the ''cold'' moon]]")).toEqual({
      kind: "link",
      target: "Titan",
      children: [
        { kind: "text", text: "the " },
        { kind: "mark", mark: "italic", children: [{ kind: "text", text: "cold" }] },
        { kind: "text", text: " moon" },
      ],
    });
  });

  it("routes file and category links to their own chips", () => {
    expect(onlyInline("[[File:Map.png|20px]]")).toEqual({
      kind: "atomic",
      atomic: "media",
      source: "[[File:Map.png|20px]]",
      label: "Map.png",
    });
    expect(onlyInline("[[Category:Moons|Artifice]]").kind).toBe("atomic");
  });

  it("reads a bracketed external link, with or without a label", () => {
    expect(onlyInline("[https://lethal.wiki Lethal Company Wiki]")).toEqual({
      kind: "extlink",
      href: "https://lethal.wiki",
      children: [{ kind: "text", text: "Lethal Company Wiki" }],
    });
    expect(onlyInline("[https://lethal.wiki]")).toEqual({
      kind: "extlink",
      href: "https://lethal.wiki",
      children: [],
    });
    // A bare URL has no brackets to preserve, so it stays text.
    expect(parseInlineRun("see https://lethal.wiki now")).toEqual([
      { kind: "text", text: "see https://lethal.wiki now" },
    ]);
  });

  it("reads the three apostrophe forms, bold-italic nested outside-in", () => {
    expect(onlyInline("''italic''")).toEqual({
      kind: "mark",
      mark: "italic",
      children: [{ kind: "text", text: "italic" }],
    });
    expect(onlyInline("'''bold'''")).toEqual({
      kind: "mark",
      mark: "bold",
      children: [{ kind: "text", text: "bold" }],
    });
    expect(onlyInline("'''''both'''''")).toEqual({
      kind: "mark",
      mark: "bold",
      children: [
        { kind: "mark", mark: "italic", children: [{ kind: "text", text: "both" }] },
      ],
    });
  });

  it("leaves every unmatched opener as literal text", () => {
    expect(parseInlineRun("''unclosed emphasis")).toEqual([
      { kind: "text", text: "''unclosed emphasis" },
    ]);
    expect(parseInlineRun("<b>unclosed tag")).toEqual([{ kind: "text", text: "<b>unclosed tag" }]);
    expect(parseInlineRun("{{unclosed template")).toEqual([
      { kind: "text", text: "{{unclosed template" },
    ]);
    expect(parseInlineRun("[[unclosed link")).toEqual([{ kind: "text", text: "[[unclosed link" }]);
    expect(parseInlineRun("[https://x unclosed")).toEqual([
      { kind: "text", text: "[https://x unclosed" },
    ]);
    expect(parseInlineRun("</b> stray close")).toEqual([{ kind: "text", text: "</b> stray close" }]);
    expect(parseInlineRun("don't panic")).toEqual([{ kind: "text", text: "don't panic" }]);
  });
});

/* ---------------------------------------------------------------- */
/* The awkward cases                                                 */
/* ---------------------------------------------------------------- */

describe("awkward input", () => {
  it("keeps a file caption's own wiki link inside the media chip", () => {
    const source = "[[File:Map.png|thumb|See [[Titan]] for scale]]\n";
    const block = firstBlock(source);
    if (block.kind !== "atomic") throw new Error("expected an atomic");
    expect(block.atomic).toBe("media");
    expect(block.source).toBe("[[File:Map.png|thumb|See [[Titan]] for scale]]");
    expect(covers(source)).toBe(source);
  });

  it("never splits a paragraph on a template opened mid-sentence", () => {
    const source = "The cost is {{#vswitch:\nv50=1400 |\nv62=1500\n}} credits today.\n";
    expect(kinds(source)).toEqual(["paragraph"]);
    expect(sources(source)[0]).toBe(source.trimEnd());
    expect(covers(source)).toBe(source);
  });

  it("never splits a paragraph on a ref opened mid-sentence", () => {
    const source = "Artifice pays best.<ref name=\"wiki\">Cross-checked against\nthe community wiki.</ref>\n";
    expect(kinds(source)).toEqual(["paragraph"]);
    expect(covers(source)).toBe(source);
  });

  it("holds a mixed marker run together as one flat list", () => {
    const source = "* bullet\n** deeper\n#* numbered then bullet\n: indented\n; term\n";
    const block = firstBlock(source);
    if (block.kind !== "list") throw new Error("expected a list");
    expect(block.items).toHaveLength(5);
    expect(block.items.map((item) => item.marker)).toEqual(["*", "**", "#*", ":", ";"]);
    expect(covers(source)).toBe(source);
  });

  it("treats an unterminated block tag as reaching the end of the document", () => {
    const source = "<gallery>\nA.png\nB.png\n";
    expect(kinds(source)).toEqual(["atomic:gallery"]);
    expect(sources(source)).toEqual(["<gallery>\nA.png\nB.png"]);
    expect(covers(source)).toBe(source);
  });

  it("treats an unterminated table as reaching the end of the document", () => {
    const source = "{|\n| cell\n";
    expect(kinds(source)).toEqual(["atomic:table"]);
    expect(covers(source)).toBe(source);
  });

  it("leaves the document's trailing blank lines in the gap, not in the block", () => {
    // The other half of the swallowing bug. An unclosed construct on the last
    // line used to take the terminating newline into `source` and leave
    // `gapAfter` empty, so a paragraph appended after it was written with no
    // separator at all — and every re-serialization grew another space.
    expect(sources("Hello {{Foo\n")).toEqual(["Hello {{Foo"]);
    expect(gaps("Hello {{Foo\n")).toEqual(["\n"]);
    expect(gaps("Intro.\n\nHello {{Foo\n\n\n")).toEqual(["\n\n", "\n\n\n"]);
    expect(covers("Intro.\n\nHello {{Foo\n\n\n")).toBe("Intro.\n\nHello {{Foo\n\n\n");
  });

  it("keeps an unmatched apostrophe run as prose and covers the input", () => {
    const source = "It's '''nearly bold and then the line ends\n";
    const block = firstBlock(source);
    if (block.kind !== "paragraph") throw new Error("expected a paragraph");
    expect(block.children).toEqual([
      { kind: "text", text: "It's '''nearly bold and then the line ends" },
    ]);
    expect(covers(source)).toBe(source);
  });

  it("covers every fixture in this file byte for byte", () => {
    const fixtures = [
      "",
      "\n",
      "   ",
      "Plain.\n",
      "Plain",
      "\n\n\nLate start.\n\n\n",
      "----\n\n== H ==\n\nText\nover lines.\n\n* a\n* b\n\n[[Category:X]]\n",
      "{{Infobox\n| a = 1\n}}\nLead sentence.\n\n{|\n|}\n\n <pre-ish line\n",
      "<!-- top -->\n#REDIRECT [[Titan]]\n",
      "#REDIRECT [[Titan]]\n\nBody after a redirect.\n",
    ];
    for (const fixture of fixtures) expect(covers(fixture)).toBe(fixture);
  });
});

/* ---------------------------------------------------------------- */
/* Hostile input                                                     */
/* ---------------------------------------------------------------- */

/**
 * Text nobody wrote by hand. `parseDocument` runs synchronously in the
 * surface's load effect, and a throw there costs the whole article: the catch
 * hands the author an empty editor, and publishing it saves that. So the two
 * ways this parser could fail — recursion and quadratic rescanning — are
 * pinned down here with inputs well inside the 400 KB wikitext cap.
 */
describe("hostile input", () => {
  function inlineDepth(nodes: readonly VeInline[]): number {
    let deepest = 0;
    for (const node of nodes) {
      const children =
        node.kind === "mark" || node.kind === "link" || node.kind === "extlink"
          ? node.children
          : [];
      deepest = Math.max(deepest, 1 + inlineDepth(children));
    }
    return deepest;
  }

  it("caps the nesting instead of overflowing the stack", () => {
    // Both of these used to throw `RangeError: Maximum call stack size
    // exceeded`. Past the cap the rest of the region is one literal text node,
    // so the bytes still come back — which is the whole point: the surface
    // published a lone "\n" over articles like this.
    const tags = `${"<b>".repeat(4000)}x${"</b>".repeat(4000)}`;
    expect(() => parseDocument(`${tags}\n`)).not.toThrow();
    expect(covers(`${tags}\n`)).toBe(`${tags}\n`);
    const block = firstBlock(`${tags}\n`);
    if (block.kind !== "paragraph") throw new Error("expected a paragraph");
    expect(inlineDepth(block.children)).toBeLessThan(100);

    const links = `${"[[".repeat(6000)}x${"]]".repeat(6000)}`;
    expect(() => parseDocument(`${links}\n`)).not.toThrow();
    expect(covers(`${links}\n`)).toBe(`${links}\n`);
  });

  it("stays linear on a run of openers that never close", () => {
    // Measured before the fix, on one paragraph each: 3.0 s, 11.7 s, 11.3 s,
    // 1.7 s — every one of them synchronous, on every load and every mode
    // switch. They are milliseconds now; the bound is loose enough that only a
    // return to the quadratic scan can trip it.
    const runs = [
      "<b>".repeat(10000),
      "<b>".repeat(20000),
      "<ref>".repeat(20000),
      "{{".repeat(20000),
      "[[".repeat(20000),
      // A closer that exists but never balances: the case no memo can answer,
      // held instead by the lookahead budget.
      `${"<b>".repeat(10000)}</b>`,
    ];
    for (const run of runs) {
      const started = Date.now();
      expect(covers(`${run}\n`)).toBe(`${run}\n`);
      expect(Date.now() - started).toBeLessThan(2000);
    }
  });
});

/* ---------------------------------------------------------------- */
/* Atomic identity                                                   */
/* ---------------------------------------------------------------- */

describe("atomicKindOf / atomicLabelOf", () => {
  it("classifies each fragment shape", () => {
    expect(atomicKindOf(" indented")).toBe("pre");
    expect(atomicKindOf("<!-- c -->")).toBe("comment");
    expect(atomicKindOf("{{{p}}}")).toBe("magic");
    expect(atomicKindOf("{{T}}")).toBe("template");
    expect(atomicKindOf("{| |}")).toBe("table");
    expect(atomicKindOf("[[Category:Moons]]")).toBe("category");
    expect(atomicKindOf("[[File:A.png]]")).toBe("media");
    expect(atomicKindOf("#REDIRECT [[Titan]]")).toBe("redirect");
    expect(atomicKindOf("<gallery>a</gallery>")).toBe("gallery");
    expect(atomicKindOf("<v1+>x</v1+>")).toBe("versions");
    expect(atomicKindOf("<poem>x</poem>")).toBe("pre");
    expect(atomicKindOf("<span>x</span>")).toBe("html");
    expect(atomicKindOf("plain prose")).toBe("unknown");
  });

  it("labels a chip with the construct's own name where it has one", () => {
    expect(atomicLabelOf("versions", "<v50+v61>x</v50+v61>")).toBe("v50+v61");
    expect(atomicLabelOf("template", "{{Infobox_moon\n| name = x\n}}")).toBe("Infobox_moon");
    expect(atomicLabelOf("magic", "{{{layout_size|}}}")).toBe("layout_size");
    expect(atomicLabelOf("media", "[[File:Map.png|thumb]]")).toBe("Map.png");
    expect(atomicLabelOf("category", "[[Category:Moons|Artifice]]")).toBe("Moons");
    expect(atomicLabelOf("redirect", "#REDIRECT [[The Company (71-Gordion)]]")).toBe(
      "The Company (71-Gordion)",
    );
    expect(atomicLabelOf("gallery", "<gallery>\nA.png\n</gallery>")).toBe("gallery");
    expect(atomicLabelOf("table", "{|\n|}")).toBe("table");
    expect(atomicLabelOf("comment", "<!-- x -->")).toBe("comment");
    expect(atomicLabelOf("pre", " indented")).toBe("pre");
    expect(atomicLabelOf("unknown", "???")).toBe("unknown");
  });
});

/* ---------------------------------------------------------------- */
/* Tables (spec §7)                                                  */
/* ---------------------------------------------------------------- */

/** The parsed table a fixture is about. */
function tableBlock(wikitext: string): VeTable {
  const block = firstBlock(wikitext);
  if (block.kind !== "table") throw new Error(`expected a table, got ${block.kind}`);
  return block;
}

/** Every cell as text, a header marked with the `!` its wikitext carries. */
function grid(wikitext: string): string[][] {
  return tableBlock(wikitext).rows.map((row) =>
    row.cells.map((cell) => `${cell.header ? "!" : ""}${serializeInline(cell.children)}`),
  );
}

/** Why a table refused, for a fixture that is expected to refuse. */
function refusal(wikitext: string): string {
  const parsed = parseTableWikitext(wikitext);
  return parsed.ok ? "parsed" : parsed.reason;
}

describe("table parsing", () => {
  const FULL =
    '{| class="wikitable"\n|+ Scrap values\n|-\n! Item !! Value\n|-\n| Gold bar || 210\n|}\n';

  it("reads the canonical shape: attributes, caption, rows, header and data cells", () => {
    const table = tableBlock(FULL);
    expect(table.attrs).toBe('class="wikitable"');
    expect(serializeInline(table.caption ?? [])).toBe("Scrap values");
    expect(grid(FULL)).toEqual([
      ["!Item", "!Value"],
      ["Gold bar", "210"],
    ]);
  });

  it("opens an implicit first row for cells written before any `|-`", () => {
    // Spec §7.5, and the shape every table in this wiki's seed data has.
    expect(grid("{|\n! A !! B\n|-\n| 1 || 2\n|}\n")).toEqual([
      ["!A", "!B"],
      ["1", "2"],
    ]);
  });

  it("reads one cell per line, and several cells per line, the same way", () => {
    expect(grid("{|\n|-\n! Item\n! Value\n|-\n| Gold bar\n| 210\n|}\n")).toEqual([
      ["!Item", "!Value"],
      ["Gold bar", "210"],
    ]);
  });

  it("splits a header line on `!!` and on `||`, a data line on `||` only", () => {
    // Spec §7.3: `!!` never splits a data line, which is why a data cell may
    // hold one and a header cell never can.
    expect(grid("{|\n! A !! B || C\n|}\n")).toEqual([["!A", "!B", "!C"]]);
    expect(grid("{|\n| a !! b || c\n|}\n")).toEqual([["a !! b", "c"]]);
  });

  it("keeps a caption with no text, and tells it from no caption at all", () => {
    expect(tableBlock("{|\n|+\n|-\n| a\n|}\n").caption).toEqual([]);
    expect(tableBlock("{|\n|-\n| a\n|}\n").caption).toBeNull();
  });

  it("takes the attribute half of a cell verbatim, and trims what it keeps", () => {
    const table = tableBlock('{|\n|-   bgcolor="#eee"  \n|  style="color:red"  |  Flask  \n|}\n');
    expect(table.rows[0].attrs).toBe('bgcolor="#eee"');
    expect(table.rows[0].cells[0].attrs).toBe('style="color:red"');
    expect(serializeInline(table.rows[0].cells[0].children)).toBe("Flask");
  });

  it("drops a row that ended up with no cells, exactly as the engine does", () => {
    // §7.5: such a row emits nothing at all, so carrying it would give the
    // author a row to click that the article does not have.
    expect(grid("{|\n|-\n|-\n| only cell\n|-\n|}\n")).toEqual([["only cell"]]);
  });

  it("counts `|----` as a row separator, extra dashes and all", () => {
    expect(grid("{|\n|----\n| a\n|}\n")).toEqual([["a"]]);
    expect(tableBlock('{|\n|---- class="x"\n| a\n|}\n').rows[0].attrs).toBe('class="x"');
  });

  it("never splits a cell on a pipe that belongs to a template or a link", () => {
    // The engine splits cells AFTER template expansion (§7 preamble), so the
    // pipes inside `{{Verify|x}}` are not table markup. Splitting on them
    // would show two cells where the article renders one.
    expect(grid("{|\n| ~155{{Verify|value}} || [[Gold bar|the bar]]\n|}\n")).toEqual([
      ["~155{{Verify|value}}", "[[Gold bar|the bar]]"],
    ]);
    expect(grid("{|\n| {{Foo||bar}}\n|}\n")).toEqual([["{{Foo||bar}}"]]);
    // And the attribute split is vetoed by the same constructs (§7.3 names
    // `[[`; a `{{` has to join it here for the same reason).
    expect(grid("{|\n| [[a|b]] | c\n|}\n")).toEqual([["[[a|b]] | c"]]);
    expect(tableBlock("{|\n| {{T|x}} | c\n|}\n").rows[0].cells[0].attrs).toBe("");
  });

  it("parses a cell's content as an inline run, chips and all", () => {
    const cell = tableBlock("{|\n| '''Bold''' and [[Titan]]{{Verify|x}}<ref>note</ref>\n|}\n")
      .rows[0].cells[0];
    expect(cell.children.map((node) => node.kind)).toEqual([
      "mark",
      "text",
      "link",
      "atomic",
      "atomic",
    ]);
  });
});

describe("a table that cannot be written back refuses, and says why", () => {
  it("refuses a nested table — a cell holds inline content, not a table", () => {
    expect(refusal("{|\n| outer\n{|\n| inner\n|}\n|}")).toBe("nested-table");
  });

  it("refuses a cell continued onto another line, whatever is on it", () => {
    // §7.3 hands a multi-line cell to the BLOCK parser, and `VeInline[]` has
    // nowhere to put a list, a heading or a paragraph break. One rule covers
    // all four, which is why they share a reason.
    expect(refusal("{|\n| Monsters:\n* [[Bracken]]\n|}")).toBe("cell-continuation");
    expect(refusal("{|\n| Intro\n== H ==\n|}")).toBe("cell-continuation");
    expect(refusal("{|\n| One\n\nTwo\n|}")).toBe("cell-continuation");
    expect(refusal("{|\n| One\nstill the same cell\n|}")).toBe("cell-continuation");
  });

  it("refuses fostered content, which the engine emits before the table", () => {
    expect(refusal("{|\nstray\n| a\n|}")).toBe("fostered-content");
  });

  it("refuses a caption the model cannot hold whole", () => {
    expect(refusal('{|\n|+ style="x" | Caption\n| a\n|}')).toBe("caption-attrs");
    expect(refusal("{|\n|+ First\nand more\n| a\n|}")).toBe("caption-continuation");
    expect(refusal("{|\n|+ first\n|+ second\n| a\n|}")).toBe("second-caption");
  });

  it("refuses an indented table, a table that never closes, and one with a tail", () => {
    expect(refusal(":{|\n| x\n|}")).toBe("indented");
    expect(refusal("{|\n| x")).toBe("unclosed");
    expect(refusal("{|\n| x\n|} tail")).toBe("trailing-content");
    // Below the close as well as beside it — the block scan never hands one of
    // these over, but the exported entry point may be given a whole page.
    expect(refusal("{|\n| x\n|}\nA paragraph.")).toBe("trailing-content");
    expect(refusal("{|\n| x\n|}\n")).toBe("parsed");
  });

  it("refuses a table with nothing in it to edit", () => {
    expect(refusal("{|\n|}")).toBe("no-rows");
    expect(refusal("{|\n|-\n|-\n|}")).toBe("no-rows");
  });

  it("refuses anything that is not a table at all", () => {
    expect(refusal("Not a table\n")).toBe("not-a-table");
  });

  it("hands every refusal back to the atomic chip it has always been", () => {
    const refused = [
      "{|\n| outer\n{|\n| inner\n|}\n|}\n",
      "{|\n| Monsters:\n* [[Bracken]]\n|}\n",
      "{|\nstray\n| a\n|}\n",
      '{|\n|+ style="x" | Caption\n| a\n|}\n',
      ":{|\n| x\n|}\n",
      "{|\n| x\n|} tail\n",
      "{|\n|}\n",
    ];
    for (const wikitext of refused) {
      expect(kinds(wikitext)[0]).toBe("atomic:table");
      // §4 is what makes a refusal safe rather than lossy.
      expect(covers(wikitext)).toBe(wikitext);
    }
  });
});
