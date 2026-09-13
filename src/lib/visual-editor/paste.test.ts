/**
 * What the clipboard means (paste.ts, visual-editor.md §11).
 *
 * The assertions are grouped the way the module decides: a URL first, then
 * text that is already this wiki's markup, then markdown and grids. Two
 * promises run underneath all of them and are asserted on their own:
 *
 * - **what comes out is wikitext this editor can hold** — every `blocks`
 *   answer is parsed back, and a pasted table has to arrive as a `table`
 *   block rather than as an atomic, or the whole point of pasting a
 *   spreadsheet is lost;
 * - **a table cell is never handed a block** (wikitext-spec §7.3), because a
 *   cell that gets one turns its table into a chip.
 */

import { describe, expect, it } from "vitest";

import { parseDocument } from "./parse";
import { serializeDocument } from "./serialize";
import {
  gridWikitext,
  headingMarks,
  inlineMarkdown,
  internalTarget,
  isUrl,
  linkWikitext,
  listDepth,
  looksLikeWikitext,
  markdownWikitext,
  readGrid,
  readPaste,
} from "./paste";

const ORIGIN = "https://hqhq.wiki";

function paste(text: string, extra: Partial<Parameters<typeof readPaste>[0]> = {}) {
  return readPaste({ text, selection: "", inCell: false, origin: ORIGIN, ...extra });
}

/* ---------------------------------------------------------------- */
/* URLs                                                              */
/* ---------------------------------------------------------------- */

describe("a pasted URL", () => {
  it("is a link around the selection it replaces", () => {
    const result = paste("https://lethal.wiki/moons", { selection: "the other wiki" });
    expect(result).toEqual({
      kind: "inline",
      wikitext: "[https://lethal.wiki/moons the other wiki]",
    });
  });

  it("becomes a page link when it names a page of this wiki", () => {
    expect(paste(`${ORIGIN}/wiki/gold-bar`, { selection: "the bar" })).toEqual({
      kind: "inline",
      wikitext: "[[Gold bar|the bar]]",
    });
  });

  it("keeps the leading colon that stops a category link from filing the page", () => {
    // `[[Category:X]]` files the page into the category and renders nothing
    // (spec §5.8). A paste that wrote one would silently categorise an article
    // instead of linking to a page.
    expect(internalTarget(`${ORIGIN}/wiki/category:moons`, ORIGIN)).toBe(":Category:Moons");
    expect(internalTarget(`${ORIGIN}/wiki/file:ship.png`, ORIGIN)).toBe(":File:Ship.png");
  });

  it("reads a language prefix, because only English has no prefix", () => {
    expect(internalTarget(`${ORIGIN}/ko/wiki/titan`, ORIGIN)).toBe("Titan");
    expect(internalTarget(`${ORIGIN}/wiki/titan`, ORIGIN)).toBe("Titan");
  });

  it("is not a page link when the route is not an article", () => {
    // A link to a search or a history is a link to a URL. Only `/wiki/…` names
    // a page, and only a page has a page name.
    expect(internalTarget(`${ORIGIN}/search?q=titan`, ORIGIN)).toBeNull();
    expect(internalTarget(`${ORIGIN}/history/titan`, ORIGIN)).toBeNull();
    expect(internalTarget("https://elsewhere.example/wiki/titan", ORIGIN)).toBeNull();
  });

  it("is left as text at a bare caret, because the engine already links it", () => {
    // A free URL in running text is linkified with itself as its label (spec
    // §6.2). Writing `[url]` instead would replace it on screen with `[1]`.
    expect(paste("https://lethal.wiki/moons")).toEqual({
      kind: "text",
      text: "https://lethal.wiki/moons",
    });
  });

  it("still becomes a page link at a bare caret when it is one of ours", () => {
    expect(paste(`${ORIGIN}/wiki/gold-bar`)).toEqual({ kind: "inline", wikitext: "[[Gold bar]]" });
  });

  it("drops a label that only repeats the target", () => {
    expect(linkWikitext(`${ORIGIN}/wiki/gold-bar`, "Gold bar", ORIGIN)).toBe("[[Gold bar]]");
  });

  it("says no to a scheme the engine would never link", () => {
    // `javascript:` renders as literal text (spec §6.1), so a paste that wrote
    // a link out of one would be writing markup that shows its own source.
    expect(isUrl("javascript:alert(1)")).toBe(false);
    expect(isUrl("data:text/html,<b>x")).toBe(false);
    expect(isUrl("https://example.com/a b")).toBe(false);
    expect(isUrl("https://example.com")).toBe(true);
    expect(isUrl("mailto:crew@company.example")).toBe(true);
  });

  it("does not read a URL as a page link where the wiki has no origin", () => {
    // Server-rendered, or any surface with no `window`: the reading is simply
    // off, and the URL stays a URL.
    expect(internalTarget(`${ORIGIN}/wiki/titan`, "")).toBeNull();
  });
});

/* ---------------------------------------------------------------- */
/* Wikitext                                                          */
/* ---------------------------------------------------------------- */

describe("pasted wikitext", () => {
  it("is pasted verbatim, markers and all", () => {
    const source = "== Layout ==\n\nThe [[main entrance]] is {{Verify|unconfirmed}}.";
    expect(paste(source)).toEqual({ kind: "blocks", wikitext: source });
  });

  it("is recognised by any of this wiki's own constructs", () => {
    for (const source of [
      "See [[Titan]].",
      "{{Infobox moon}}",
      "{| class=\"wikitable\"\n|-\n| a\n|}",
      "== Heading ==",
      "----",
      "A fact.<ref>A source</ref>",
      "<v70>Only in v70</v70>",
    ]) {
      expect(looksLikeWikitext(source)).toBe(true);
    }
  });

  it("is not claimed by a pair of apostrophes in ordinary prose", () => {
    // `''` is also how a sentence spells a quotation inside a quotation, and
    // reading a novel excerpt as markup would be the worse mistake.
    expect(looksLikeWikitext("She said ''hello'' twice.")).toBe(false);
  });

  it("stays inline when it is one paragraph, so a link lands mid-sentence", () => {
    expect(paste("the [[Gold bar]] itself")).toEqual({
      kind: "inline",
      wikitext: "the [[Gold bar]] itself",
    });
  });
});

/* ---------------------------------------------------------------- */
/* Markdown                                                          */
/* ---------------------------------------------------------------- */

describe("pasted markdown", () => {
  it("turns its emphases into this wiki's", () => {
    expect(inlineMarkdown("**bold**, *italic*, ~~gone~~ and `code`", ORIGIN)).toBe(
      "'''bold''', ''italic'', <s>gone</s> and <code>code</code>",
    );
  });

  it("leaves a word with an underscore in it alone", () => {
    // `snake_case_name` is a word, not an emphasis: a rule that italicised it
    // would corrupt every identifier anybody pastes.
    expect(inlineMarkdown("snake_case_name", ORIGIN)).toBe("snake_case_name");
    expect(inlineMarkdown("_yes_ and no", ORIGIN)).toBe("''yes'' and no");
  });

  it("reads nothing inside a code span", () => {
    expect(inlineMarkdown("`**not bold**`", ORIGIN)).toBe("<code>**not bold**</code>");
  });

  it("honours the backslash that says a character is a character", () => {
    expect(inlineMarkdown("2 \\* 3 \\* 4", ORIGIN)).toBe("2 * 3 * 4");
  });

  it("writes a link, and a page link where the URL is ours", () => {
    expect(inlineMarkdown("[the wiki](https://lethal.wiki)", ORIGIN)).toBe(
      "[https://lethal.wiki the wiki]",
    );
    expect(inlineMarkdown(`[bars](${ORIGIN}/wiki/gold-bar)`, ORIGIN)).toBe("[[Gold bar|bars]]");
  });

  it("starts its headings where a wiki article starts", () => {
    // The page title is the h1, which is why the format menu offers h2…h5
    // (§1): a pasted document's own top level is this page's top level.
    expect(headingMarks(1)).toBe("==");
    expect(headingMarks(2)).toBe("===");
    expect(headingMarks(6)).toBe("======");
    expect(markdownWikitext("# Artifice", ORIGIN)).toBe("== Artifice ==");
  });

  it("keeps a nested list nested", () => {
    expect(listDepth("")).toBe(0);
    expect(listDepth("  ")).toBe(1);
    expect(listDepth("\t")).toBe(1);
    expect(listDepth("    ")).toBe(2);
    expect(markdownWikitext("- one\n  - two\n1. three", ORIGIN)).toBe("* one\n** two\n# three");
  });

  it("writes a quote as the indent the editor's own control writes", () => {
    expect(markdownWikitext("> quoted", ORIGIN)).toBe(": quoted");
  });

  it("writes a fence as preformatted lines, and reads nothing inside it", () => {
    expect(markdownWikitext("```\n**as typed**\n```", ORIGIN)).toBe(" **as typed**");
  });

  it("writes a rule for every spelling of one", () => {
    for (const rule of ["---", "***", "___", "- - -"]) {
      expect(markdownWikitext(rule, ORIGIN)).toBe("----");
    }
  });

  it("keeps two paragraphs two paragraphs", () => {
    const result = paste("First one.\n\nSecond one.");
    expect(result).toEqual({ kind: "blocks", wikitext: "First one.\n\nSecond one." });
    expect(parseDocument(result.kind === "blocks" ? result.wikitext : "").blocks.length).toBe(2);
  });

  it("stays inline for one line of it, so it lands mid-sentence", () => {
    expect(paste("**loud**")).toEqual({ kind: "inline", wikitext: "'''loud'''" });
  });

  it("collapses a run of blank lines to one break", () => {
    expect(markdownWikitext("a\n\n\n\nb", ORIGIN)).toBe("a\n\nb");
  });
});

/* ---------------------------------------------------------------- */
/* Grids                                                             */
/* ---------------------------------------------------------------- */

describe("a pasted grid", () => {
  it("reads a spreadsheet's tabs as cells", () => {
    expect(readGrid("Moon\tPrice\nTitan\t700")).toEqual({
      header: false,
      rows: [
        ["Moon", "Price"],
        ["Titan", "700"],
      ],
    });
  });

  it("refuses lines that are not all the same width", () => {
    // A ragged grid is prose that happens to hold a tab, and turning that into
    // a table would be a guess an author then has to undo.
    expect(readGrid("Moon\tPrice\nTitan")).toBeNull();
    expect(readGrid("no tabs here\nnor here")).toBeNull();
  });

  it("reads a markdown table, and takes its header row", () => {
    expect(readGrid("| Moon | Price |\n|---|---:|\n| Titan | 700 |")).toEqual({
      header: true,
      rows: [
        ["Moon", "Price"],
        ["Titan", "700"],
      ],
    });
  });

  it("gives a spreadsheet no header, because guessing one costs the same click", () => {
    const grid = readGrid("Titan\t700\nArtifice\t1500");
    expect(grid?.header).toBe(false);
  });

  it("writes a table the editor can then edit, not a chip", () => {
    // The whole point: a pasted spreadsheet has to arrive as a `table` block,
    // where §3.2's controls act on its rows and columns. A shape the parser
    // refuses would come back as an atomic with a raw-wikitext dialog.
    const result = paste("Moon\tPrice\nTitan\t700\nArtifice\t1500");
    expect(result.kind).toBe("blocks");
    const doc = parseDocument(result.kind === "blocks" ? result.wikitext : "");
    expect(doc.blocks.length).toBe(1);
    expect(doc.blocks[0].kind).toBe("table");
  });

  it("writes header cells with `!`, so the header row is a header row", () => {
    const wikitext = gridWikitext(
      { header: true, rows: [["Moon", "Price"], ["Titan", "700"]] },
      ORIGIN,
    );
    expect(wikitext).toContain("! Moon !! Price");
    expect(wikitext).toContain("| Titan || 700");
    const doc = parseDocument(wikitext);
    expect(doc.blocks[0].kind).toBe("table");
    if (doc.blocks[0].kind !== "table") throw new Error("unreachable");
    expect(doc.blocks[0].rows[0].cells.every((cell) => cell.header)).toBe(true);
  });

  it("reads the emphases inside a cell", () => {
    const wikitext = gridWikitext({ header: false, rows: [["**Titan**", "700"]] }, ORIGIN);
    expect(wikitext).toContain("| '''Titan''' || 700");
  });

  it("drops the alignment colons rather than inventing an attribute", () => {
    // §7: the editor never writes a `style=`/`class=` of its own. Alignment is
    // one, so it is not carried across.
    const wikitext = gridWikitext(readGrid("| a | b |\n|:--|--:|\n| 1 | 2 |") ?? { header: false, rows: [] }, ORIGIN);
    expect(wikitext).not.toContain("text-align");
  });
});

/* ---------------------------------------------------------------- */
/* Inside a table                                                    */
/* ---------------------------------------------------------------- */

describe("a paste into a table cell", () => {
  it("is always inline, whatever the clipboard held", () => {
    // A cell holds inline content and nothing else (spec §7.3): a heading or a
    // list made in one is a table the model then has to refuse, and a refused
    // table is a chip with a dialog.
    for (const text of ["# Heading", "- one\n- two", "Moon\tPrice\nTitan\t700", "a\n\nb"]) {
      expect(paste(text, { inCell: true }).kind).toBe("inline");
    }
  });

  it("folds the lines it was given to spaces", () => {
    // Every table marker sits at the start of a line (§7.1), so a cell cannot
    // hold a newline at all.
    const result = paste("first\nsecond", { inCell: true });
    expect(result).toEqual({ kind: "inline", wikitext: "first second" });
  });

  it("still reads the emphases", () => {
    expect(paste("**loud**", { inCell: true })).toEqual({ kind: "inline", wikitext: "'''loud'''" });
  });

  it("keeps wikitext it was handed", () => {
    expect(paste("see [[Titan]]", { inCell: true })).toEqual({
      kind: "inline",
      wikitext: "see [[Titan]]",
    });
  });
});

/* ---------------------------------------------------------------- */
/* What every answer has to be                                       */
/* ---------------------------------------------------------------- */

describe("every answer", () => {
  const clipboard = [
    "plain prose",
    "# Title\n\nSome prose.\n\n- a\n- b",
    "Moon\tPrice\nTitan\t700",
    "| a | b |\n|---|---|\n| 1 | 2 |",
    "== Wiki ==\n\n[[Titan]]",
    "> quoted\n> lines",
    "```\ncode\n```",
    `${ORIGIN}/wiki/titan`,
    "https://example.com",
    "",
  ];

  it("parses back into blocks the model can hold", () => {
    for (const text of clipboard) {
      const result = paste(text);
      if (result.kind === "text") continue;
      expect(() => parseDocument(result.wikitext)).not.toThrow();
    }
  });

  it("writes wikitext the parser reproduces, which is what the surface draws", () => {
    // The surface parses this answer and draws the blocks it gets (§3). A
    // paste whose wikitext did not survive its own round trip would put
    // something on screen that is not what publishes — the one failure §4
    // exists to make impossible.
    for (const text of clipboard) {
      const result = paste(text);
      if (result.kind !== "blocks") continue;
      expect(serializeDocument(parseDocument(result.wikitext))).toBe(result.wikitext);
    }
  });

  it("is never a block answer inside a cell", () => {
    for (const text of clipboard) {
      expect(paste(text, { inCell: true }).kind).not.toBe("blocks");
    }
  });

  it("gives an empty clipboard nothing to insert", () => {
    expect(paste("")).toEqual({ kind: "text", text: "" });
    expect(paste("   \n  ")).toEqual({ kind: "text", text: "" });
  });

  it("folds CRLF, which is what the parser does first anyway (§4)", () => {
    expect(paste("a\r\n\r\nb")).toEqual({ kind: "blocks", wikitext: "a\n\nb" });
  });
});
