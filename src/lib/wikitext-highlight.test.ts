/**
 * Tokenizer tests for the source editor's syntax highlighting.
 *
 * The tokenizer is a display device, so the contract under test is
 * (a) losslessness — token texts always concatenate back to the input,
 * (b) termination on any input, and (c) the specific spans the editor
 * colors. The Fandom reference article
 * (docs/engine/fixtures/fandom-artifice.wikitext) is used as a realistic
 * round-trip corpus.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  addCategory,
  categoriesUsed,
  highlight,
  highlightLines,
  removeCategory,
  templatesUsed,
  repairVersionMarkup,
  versionMarkupProblems,
  versionsUsed,
  type HighlightToken,
  type HighlightTokenType,
} from "./wikitext-highlight";

/** Token texts of a given type, in order. */
function textsOf(source: string, type: HighlightTokenType): string[] {
  return highlight(source)
    .filter((t) => t.type === type)
    .map((t) => t.text);
}

function pairs(source: string): Array<[HighlightTokenType, string]> {
  return highlight(source).map((t): [HighlightTokenType, string] => [t.type, t.text]);
}

function roundTrips(source: string): boolean {
  return highlight(source)
    .map((t: HighlightToken) => t.text)
    .join("") === source;
}

const FIXTURE = readFileSync(
  new URL("../../docs/engine/fixtures/fandom-artifice.wikitext", import.meta.url),
  "utf8",
);

describe("highlight: losslessness and termination", () => {
  it("round-trips the empty string", () => {
    expect(highlight("")).toEqual([]);
    expect(roundTrips("")).toBe(true);
  });

  it("round-trips the Fandom reference article verbatim", () => {
    expect(roundTrips(FIXTURE)).toBe(true);
  });

  it("round-trips tabs, CJK and astral characters", () => {
    const src = "\t한국어 위키\t{{틀|매개}}\n\t* 목록 😀\n";
    expect(roundTrips(src)).toBe(true);
  });

  it("terminates and round-trips on unbalanced/pathological markup", () => {
    const cases = [
      "[[",
      "]]",
      "{{",
      "}}}}",
      "{{{",
      "<ref",
      "<nowiki>",
      "<!--",
      "[https://a",
      "'''''",
      "{|",
      "|}",
      "=",
      "======",
      "|||||",
      "[[a|[[b|c]]]]",
    ];
    for (const src of cases) expect(roundTrips(src), src).toBe(true);
  });
});

describe("highlight: headings (spec §2)", () => {
  it("colors the = runs and leaves the title text plain", () => {
    expect(pairs("==Moon Map==")).toEqual([
      ["heading", "=="],
      ["text", "Moon Map"],
      ["heading", "=="],
    ]);
  });

  it("supports levels 1-6 and trailing spaces", () => {
    expect(textsOf("===== Deep =====  ", "heading")).toEqual(["=====", "=====  "]);
    expect(textsOf("= One =", "heading")).toEqual(["=", "="]);
  });

  it("still highlights links inside a heading", () => {
    expect(pairs("== [[Moons]] ==")).toEqual([
      ["heading", "=="],
      ["text", " "],
      ["link", "[[Moons"],
      ["link", "]]"],
      ["text", " "],
      ["heading", "=="],
    ]);
  });

  it("does not treat a bare = run or mid-line = as a heading", () => {
    expect(textsOf("==", "heading")).toEqual([]);
    expect(textsOf("a == b ==", "heading")).toEqual([]);
  });
});

describe("highlight: emphasis (spec §1)", () => {
  it("marks ''' and '' runs", () => {
    expect(pairs("'''68-Artifice''' is ''a'' moon")).toEqual([
      ["bold", "'''"],
      ["text", "68-Artifice"],
      ["bold", "'''"],
      ["text", " is "],
      ["italic", "''"],
      ["text", "a"],
      ["italic", "''"],
      ["text", " moon"],
    ]);
  });

  it("prefers bold over italic on a 5-apostrophe run", () => {
    expect(pairs("'''''x'''''")).toEqual([
      ["bold", "'''"],
      ["italic", "''"],
      ["text", "x"],
      ["bold", "'''"],
      ["italic", "''"],
    ]);
  });

  it("leaves a lone apostrophe alone", () => {
    expect(textsOf("it's", "italic")).toEqual([]);
  });
});

describe("highlight: links (spec §5, §6)", () => {
  it("colors target, pipes and label separately", () => {
    expect(pairs("[[Moons|the moon list]]")).toEqual([
      ["link", "[[Moons"],
      ["link", "|"],
      ["link-label", "the moon list"],
      ["link", "]]"],
    ]);
  });

  it("colors every option of a file link as a label", () => {
    expect(pairs("[[File:X.gif|none|thumb|480x480px|cap]]")).toEqual([
      ["link", "[[File:X.gif"],
      ["link", "|"],
      ["link-label", "none"],
      ["link", "|"],
      ["link-label", "thumb"],
      ["link", "|"],
      ["link-label", "480x480px"],
      ["link", "|"],
      ["link-label", "cap"],
      ["link", "]]"],
    ]);
  });

  it("keeps templates inside a link label highlighted", () => {
    expect(pairs("[[A|{{B}}]]")).toEqual([
      ["link", "[[A"],
      ["link", "|"],
      ["template", "{{B"],
      ["template", "}}"],
      ["link", "]]"],
    ]);
  });

  it("does not let an unterminated [[ bleed past the newline", () => {
    expect(pairs("[[Broken\nplain")).toEqual([
      ["link", "[[Broken"],
      ["text", "\nplain"],
    ]);
  });

  it("colors external links and their labels", () => {
    expect(pairs("[https://example.com/a?b=1 Steam guide]")).toEqual([
      ["external", "[https://example.com/a?b=1"],
      ["link-label", " Steam guide"],
      ["external", "]"],
    ]);
  });

  it("leaves a bracket that is not an external link as text", () => {
    expect(textsOf("[not a link]", "external")).toEqual([]);
  });
});

describe("highlight: templates and parameters (spec §8)", () => {
  it("colors braces, name and pipe separators", () => {
    expect(pairs("{{Stub|reason=x}}")).toEqual([
      ["template", "{{Stub"],
      ["template", "|"],
      ["text", "reason=x"],
      ["template", "}}"],
    ]);
  });

  it("keeps a multi-line template call colored across newlines", () => {
    expect(pairs("{{Location\n|title=68-Artifice\n}}")).toEqual([
      ["template", "{{Location"],
      ["text", "\n"],
      ["template", "|"],
      ["text", "title=68-Artifice\n"],
      ["template", "}}"],
    ]);
  });

  it("distinguishes {{{parameters}}} from templates", () => {
    expect(pairs("{{{name|default}}}")).toEqual([
      ["parameter", "{{{name"],
      ["parameter", "|"],
      ["text", "default"],
      ["parameter", "}}}"],
    ]);
  });

  it("handles a parameter nested in a template", () => {
    expect(textsOf("{{A|{{{p}}}}}", "parameter")).toEqual(["{{{p", "}}}"]);
    expect(textsOf("{{A|{{{p}}}}}", "template")).toEqual(["{{A", "|", "}}"]);
  });
});

describe("highlight: tags, comments and raw text (spec §10, §11)", () => {
  it("colors extension tags including Fandom's infobox and tabber", () => {
    expect(textsOf('<ref name=":02">a</ref><references />', "tag")).toEqual([
      '<ref name=":02">',
      "</ref>",
      "<references />",
    ]);
    expect(textsOf('<infobox><title source="t"/></infobox>', "tag")).toEqual([
      "<infobox>",
      '<title source="t"/>',
      "</infobox>",
    ]);
    expect(textsOf('<tabber><versions>x</versions></tabber>', "tag")).toEqual([
      "<tabber>",
      "<versions>",
      "</versions>",
      "</tabber>",
    ]);
  });

  it("keeps the body of raw-text tags opaque", () => {
    expect(pairs("<nowiki>[[not a link]]</nowiki>")).toEqual([
      ["tag", "<nowiki>"],
      ["nowiki", "[[not a link]]"],
      ["tag", "</nowiki>"],
    ]);
    expect(textsOf("<pre>{{x}}</pre>", "template")).toEqual([]);
  });

  it("swallows an unterminated raw-text tag to the end", () => {
    expect(pairs("<nowiki>tail")).toEqual([
      ["tag", "<nowiki>"],
      ["nowiki", "tail"],
    ]);
  });

  it("colors multi-line HTML comments as one token", () => {
    expect(pairs("a<!-- hi\nthere -->b")).toEqual([
      ["text", "a"],
      ["comment", "<!-- hi\nthere -->"],
      ["text", "b"],
    ]);
  });

  it("colors character references", () => {
    expect(textsOf("&nbsp;&#8594;&#x2192; &notanentity", "entity")).toEqual([
      "&nbsp;",
      "&#8594;",
      "&#x2192;",
    ]);
  });
});

describe("highlight: block structure (spec §3, §4, §7)", () => {
  it("colors list markers only at line start", () => {
    expect(pairs("** deep\na * b")).toEqual([
      ["list", "**"],
      ["text", " deep\na * b"],
    ]);
    expect(textsOf(";term\n:def", "list")).toEqual([";", ":"]);
  });

  it("colors horizontal rules", () => {
    expect(textsOf("----\n---", "hr")).toEqual(["----"]);
  });

  it("colors table markup and inline cell separators", () => {
    const src = '{| class="wikitable"\n! H1 !! H2\n|-\n| a || b\n|}';
    expect(textsOf(src, "table")).toEqual(["{|", "!", "!!", "|-", "|", "||", "|}"]);
  });

  it("does not treat a bare pipe outside a table as markup", () => {
    expect(textsOf("a || b", "table")).toEqual([]);
  });
});

describe("highlightLines", () => {
  it("splits into one entry per textarea line, trailing newline included", () => {
    expect(highlightLines("a\n").length).toBe(2);
    expect(highlightLines("")).toEqual([[]]);
    expect(highlightLines("a\nb").length).toBe(2);
  });

  it("splits multi-line tokens across lines keeping their type", () => {
    const lines = highlightLines("<!-- a\nb -->");
    expect(lines.length).toBe(2);
    expect(lines[0]).toEqual([{ type: "comment", text: "<!-- a" }]);
    expect(lines[1]).toEqual([{ type: "comment", text: "b -->" }]);
  });

  it("keeps blank lines empty rather than dropping them", () => {
    expect(highlightLines("a\n\nb")).toEqual([
      [{ type: "text", text: "a" }],
      [],
      [{ type: "text", text: "b" }],
    ]);
  });
});

describe("templatesUsed", () => {
  it("lists unique names in first-use order", () => {
    expect(templatesUsed("{{Stub}} {{Infobox moon|a=1}} {{stub}}")).toEqual([
      "Stub",
      "Infobox moon",
    ]);
  });

  it("skips parser functions and magic words", () => {
    expect(templatesUsed("{{#ifexist:X|y|n}} {{PAGENAME}} {{Map:Artifice}}")).toEqual([
      "Map:Artifice",
    ]);
  });

  it("ignores template syntax inside comments and nowiki", () => {
    expect(templatesUsed("<!-- {{Hidden}} --><nowiki>{{Literal}}</nowiki>{{Real}}")).toEqual([
      "Real",
    ]);
  });

  it("finds the infobox call of the Fandom reference article", () => {
    expect(templatesUsed(FIXTURE)).toContain("Location");
  });
});

describe("categoriesUsed / addCategory / removeCategory", () => {
  it("parses category tags with and without sort keys", () => {
    expect(categoriesUsed("[[Category:Moons]]\n[[Category:Hard|68]]")).toEqual([
      { name: "Moons", sortKey: null },
      { name: "Hard", sortKey: "68" },
    ]);
  });

  it("ignores ordinary links and de-duplicates", () => {
    expect(categoriesUsed("[[Moons]][[Category:A]][[category:a]]")).toEqual([
      { name: "A", sortKey: null },
    ]);
  });

  it("appends a category below the body, separated by a blank line", () => {
    expect(addCategory("Body text.", "Moons")).toBe("Body text.\n\n[[Category:Moons]]\n");
  });

  it("keeps an existing category block together", () => {
    expect(addCategory("Body.\n\n[[Category:A]]\n", "B")).toBe(
      "Body.\n\n[[Category:A]]\n[[Category:B]]\n",
    );
  });

  it("is a no-op for a category already present, and for a blank name", () => {
    const src = "x\n\n[[Category:Moons]]\n";
    expect(addCategory(src, "moons")).toBe(src);
    expect(addCategory(src, "  ")).toBe(src);
  });

  it("is a no-op for a category already present under another spelling", () => {
    // The picker's "Create tier-3-moons" row, taken while the page already
    // carries the same tag as "Tier 3 moons": membership is per slug (O13.2),
    // so both tags file the page under `tier-3-moons` and the category box
    // would list it twice, under two names.
    const src = "x\n\n[[Category:Tier 3 moons]]\n";
    expect(addCategory(src, "tier-3-moons")).toBe(src);
    expect(addCategory(src, "Tier_3_moons")).toBe(src);
    expect(addCategory(src, "Tier 4 moons")).toBe(
      "x\n\n[[Category:Tier 3 moons]]\n[[Category:Tier 4 moons]]\n",
    );
  });

  it("strips a Category: prefix typed into the add field", () => {
    expect(addCategory("x", "Category:Moons")).toBe("x\n\n[[Category:Moons]]\n");
  });

  it("removes a category and the line it owned", () => {
    expect(removeCategory("x\n\n[[Category:A]]\n[[Category:B]]\n", "A")).toBe(
      "x\n\n[[Category:B]]\n",
    );
  });

  it("removes a sort-keyed tag but keeps surrounding text on the line", () => {
    expect(removeCategory("tail [[Category:A|68]] end", "a")).toBe("tail  end");
  });

  it("leaves the source untouched when the category is absent", () => {
    expect(removeCategory("x\n[[Category:A]]", "B")).toBe("x\n[[Category:A]]");
  });
});

describe("versionsUsed", () => {
  it("is empty for a page that is not version-scoped", () => {
    expect(versionsUsed("Plain text with a [[link]] and {{Template}}.")).toEqual([]);
  });

  it("reads both ends of a version tag's name, in ordinal order", () => {
    // The NAME is the range (§2.1), so the scan reads the tag rather than an
    // attribute — and reads BOTH ids of a window, because the page says one
    // thing up to `to` and another after it, which is what the engine records.
    const src = "<v62>new</v62>\n<v50+v55>old</v50+v55>";
    expect(versionsUsed(src)).toEqual(["v50", "v55", "v62"]);
  });

  it("reads the three forms, and names an open-ended tag's one boundary", () => {
    expect(versionsUsed("<v70>exactly</v70>")).toEqual(["v70"]);
    expect(versionsUsed("<v50+v61>window</v50+v61>")).toEqual(["v50", "v61"]);
    // `<v70+>` names v70 and nothing above it: there is no second boundary to
    // record, and inventing "v70 — latest" would put a registry fact on a chip.
    expect(versionsUsed("<v70+>onward</v70+>")).toEqual(["v70"]);
  });

  it("names a version tag once however often the page spells it", () => {
    // `<v70>` is a window on itself, and the engine records its id once; two
    // chips for one version would be one boundary shadowing itself.
    expect(versionsUsed("<v70>a</v70> and <v70+v70>b</v70+v70>")).toEqual(["v70"]);
  });

  it("leaves an ordinary tag alone, however close its name reads", () => {
    // The grammar is anchored on the whole name (§2.1): `<var>` is HTML,
    // `<v70x>` is nothing, and `v70v80` without the `+` is not a window.
    expect(versionsUsed("<var>x</var><video>y</video>")).toEqual([]);
    expect(versionsUsed("<v70x>x</v70x><v70v80>y</v70v80>")).toEqual([]);
    // The retired grammar is not a version construct any more: the engine
    // renders these escaped (§2.2), so a chip for them would offer to preview
    // writing nobody can see.
    expect(versionsUsed('<versions><variant since="v50">a</variant></versions>')).toEqual([]);
    expect(versionsUsed('<version since="v62">a</version>')).toEqual([]);
  });

  it("names no boundary for a stray closing tag", () => {
    // A closer that does not repeat its opener closes nothing and renders
    // escaped (§10.7); the opener it does not match is what put the chip up.
    expect(versionsUsed("</v66+>")).toEqual([]);
    expect(versionsUsed("<v50+>x</v66+>")).toEqual(["v50"]);
  });

  it("reads an {{#ifversion:}} range, operators and spans alike", () => {
    expect(versionsUsed("{{#ifversion: >=v62 | a | b }}")).toEqual(["v62"]);
    expect(versionsUsed("{{#ifversion:v50-v61,>=v64|a}}")).toEqual(["v50", "v61", "v64"]);
    // `*` is §2.3's "always true", not a version — the engine keeps it out of
    // `meta.versionBoundaries` too, and a `*` chip would preview nothing.
    expect(versionsUsed("{{#ifversion: * | always }}")).toEqual([]);
  });

  it("reads {{#vswitch:}} keys only — never its values or `default`", () => {
    expect(versionsUsed("{{#vswitch: v50=1400 | v62=1500 | default = ? }}")).toEqual([
      "v50",
      "v62",
    ]);
    expect(versionsUsed("{{#vswitch: v64 = added in v50 }}")).toEqual(["v64"]);
  });

  it("survives nested calls and piped links inside a #vswitch argument", () => {
    expect(versionsUsed("{{#vswitch: v50=[[Moon|the moon]] | v62={{Icon|x}} }}")).toEqual([
      "v50",
      "v62",
    ]);
  });

  it("ignores version markup inside comments and nowiki", () => {
    const src =
      "<!-- <v45+>hidden</v45+> -->" +
      "<nowiki>{{#vswitch: v47=x }}</nowiki>" +
      "<v66+>real</v66+>";
    expect(versionsUsed(src)).toEqual(["v66"]);
  });

  it("orders by major*1000+minor, not by string", () => {
    const src = "<v9>a</v9><v64+v70>b</v64+v70><v64.1>c</v64.1>";
    expect(versionsUsed(src)).toEqual(["v9", "v64", "v64.1", "v70"]);
  });

  it("de-duplicates across constructs and sorts unregistrable ids last", () => {
    // One version, two spellings: the first one seen is the one shown, and the
    // id nothing can order keeps its place at the end rather than vanishing.
    const src = "<V50+>a</V50+>{{#ifversion: v50 | b }}{{#vswitch: beta=c }}";
    expect(versionsUsed(src)).toEqual(["V50", "beta"]);
  });

  it("does not take a positional #vswitch argument for a boundary", () => {
    // `180` is the value of the else branch, not an id: the expander reads
    // argument names, and this one has none. A chip labelled "180" would set a
    // preview version the registry cannot resolve.
    expect(versionsUsed("{{#vswitch: v50=130 | 180 }}")).toEqual(["v50"]);
  });

  it("stays fast when the buffer repeats an unterminated call", () => {
    // An unclosed call has no end to find, so reading its body used to walk the
    // rest of the buffer — once per call. The rail re-runs this on every
    // keystroke, and 400 KB of it froze the tab for ninety seconds.
    const source = "{{#ifversion: v50 | ok }}\n" + "{{#vswitch:v62=a\n".repeat(23529);
    const started = performance.now();
    const used = versionsUsed(source);
    expect(performance.now() - started).toBeLessThan(5000);
    // The well-formed call is still read; the unterminated ones name nothing.
    expect(used).toEqual(["v50"]);
  }, 30000);
});

/* ---------------------------------------------------------------- */
/* versionMarkupProblems — where the editor and the page disagree    */
/* ---------------------------------------------------------------- */

/**
 * The page a user reported on 2026-09-05: the editor showed chips for v68 and
 * v69, the article's boundaries held only v69, and nothing on either screen
 * said why. One character is the whole story — `</69>` closes nothing, so
 * `<v69>` runs on to the `</v69>` at the bottom of the page and swallows the
 * row's third cell and the entire `<v68>` block with it.
 */
const REPORTED = [
  '{| class="wikitable"',
  "|-",
  "! Header 1 !! Header 3333 !! aaaa",
  "|-",
  "| Cell1 || <v69>aaa</69> || a",
  "|}",
  "",
  "<v68></v68>",
  "",
  "<v69></v69>",
  "",
].join("\n");

describe("versionMarkupProblems", () => {
  it("names the closer that closes nothing, and what it should have said", () => {
    const problems = versionMarkupProblems(REPORTED);
    const stray = problems.find((problem) => problem.kind === "stray-closer");
    expect(stray?.tag).toBe("</69>");
    expect(stray?.suggestion).toBe("</v69>");
  });

  it("also reports the opener that is left without one", () => {
    // Two `<v69>` openers, one `</v69>`: whichever way they are paired, one
    // opener runs to the end of the page (spec §10.7).
    const problems = versionMarkupProblems(REPORTED);
    expect(problems.some((problem) => problem.kind === "unclosed")).toBe(true);
  });

  it("says nothing once the closer is repaired", () => {
    // Which is the assertion that matters: this has to go quiet, or it is one
    // more thing on screen the author learns to ignore.
    expect(versionMarkupProblems(REPORTED.replace("</69>", "</v69>"))).toEqual([]);
  });

  it("says nothing about healthy version markup", () => {
    expect(versionMarkupProblems("a <v50+v61>x</v50+v61><v62+>y</v62+> b")).toEqual([]);
    expect(versionMarkupProblems("<v70>a</v70> and <v70>b</v70>")).toEqual([]);
    expect(versionMarkupProblems("Prose with no version markup at all.")).toEqual([]);
  });

  it("says nothing about other markup that merely looks like a tag", () => {
    // The rule has to be tight or it becomes noise: a closer for a real tag, a
    // stray HTML closer and a comparison in prose are all none of its business.
    expect(versionMarkupProblems("<ref>a note</ref> and </div> and 3 </ 69>")).toEqual([]);
    expect(versionMarkupProblems("Damage fell from 70 to 69 </em>")).toEqual([]);
  });

  it("catches a window's closer with the same letter missing", () => {
    const problems = versionMarkupProblems("<v70+v80>x</70+v80>");
    const stray = problems.find((problem) => problem.kind === "stray-closer");
    expect(stray?.tag).toBe("</70+v80>");
    expect(stray?.suggestion).toBe("</v70+v80>");
  });

  it("reports an opener nothing closes anywhere", () => {
    expect(versionMarkupProblems("Hello <v69>aaa world")).toEqual([
      { kind: "unclosed", tag: "<v69>", at: 6 },
    ]);
  });

  it("pairs openers with closers in order, so a repeated range is fine", () => {
    // Nesting one range inside itself is not something the grammar has, so
    // pairing in order is the reading that reports a problem only where the
    // counts really do not match.
    expect(versionMarkupProblems("<v70>a</v70><v70>b")).toEqual([
      { kind: "unclosed", tag: "<v70>", at: 12 },
    ]);
  });

  it("points at the offending markup, so a repair can land on it", () => {
    // The offset is what makes the repair exact: the same broken closer can
    // appear twice, or appear once for real and once as documentation, and a
    // replace-the-string repair would edit whichever it found first.
    const source = "x</69>y</69>";
    const [first, second] = versionMarkupProblems(source);
    expect(source.slice(first.at, first.at + first.tag.length)).toBe("</69>");
    expect(source.slice(second.at, second.at + second.tag.length)).toBe("</69>");
    expect(second.at).toBeGreaterThan(first.at);
  });

  it("reports in source order, so the strip reads down the page", () => {
    const problems = versionMarkupProblems(REPORTED);
    const offsets = problems.map((problem) => problem.at);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
  });
});

describe("repairVersionMarkup", () => {
  it("writes the missing v back, in place", () => {
    const [stray] = versionMarkupProblems(REPORTED);
    const fixed = repairVersionMarkup(REPORTED, stray);
    expect(fixed).toContain("<v69>aaa</v69>");
    // And that is the whole repair: it says nothing else about the page.
    expect(versionMarkupProblems(fixed)).toEqual([]);
  });

  it("repairs the one it was given, not the next one that looks like it", () => {
    const source = "a</69>b</69>";
    const [, second] = versionMarkupProblems(source);
    expect(repairVersionMarkup(source, second)).toBe("a</69>b</v69>");
  });

  it("refuses to guess where an unclosed passage was meant to end", () => {
    // Guessing would file somebody's paragraph under a version they never
    // wrote it for — the same line this editor draws when it will not pick a
    // half of an `{{#ifversion:}}` to delete.
    const source = "Hello <v69>aaa world";
    const [unclosed] = versionMarkupProblems(source);
    expect(repairVersionMarkup(source, unclosed)).toBe(source);
  });

  it("does nothing when the buffer has moved under the report", () => {
    // The strip is redrawn from a debounced buffer, so a report can name an
    // offset the author has already typed past.
    const stale = { kind: "stray-closer" as const, tag: "</69>", at: 0, suggestion: "</v69>" };
    expect(repairVersionMarkup("nothing like it here", stale)).toBe("nothing like it here");
  });

  it("leaves the chips alone — they are what the author wrote", () => {
    // The two answers are allowed to differ; that difference is the report.
    // Dropping v68 from the chips would hide the author's own markup from
    // them, which is the opposite of explaining the disagreement.
    expect(versionsUsed(REPORTED)).toEqual(["v68", "v69"]);
  });
});
