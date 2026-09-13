/**
 * The input rules — input-rules.ts, the typing that becomes structure.
 *
 * Four things are being pinned down, in this order of importance:
 *
 * 1. **Both syntaxes, every row of the table.** Markdown and wikitext are
 *    recognised together, so every row is asserted twice; a regression that
 *    quietly drops one spelling would still look fine to whoever wrote the
 *    other.
 * 2. **The decided collision.** "# " is a numbered list and never an h1, and
 *    "## " / "== " are the only ways to a heading. This is the decision that
 *    was made rather than guessed, so it gets a test that says so by name.
 * 3. **The refusals.** A rule that fires when the author meant the characters
 *    literally is worse than no rule: mid-block prefixes, a marker without its
 *    completing space, an unclosed inline pair and text that merely resembles
 *    a rule all have to come back null.
 * 4. **Totality.** Nothing throws. These strings come from a keystroke, so
 *    every shape — empty, whitespace, delimiters alone, a paragraph — is
 *    answered rather than raised on.
 */

import { describe, expect, it } from "vitest";

import { matchBlockRule, matchInlineRule, type InputRuleMatch } from "./input-rules";

/* ---------------------------------------------------------------- */
/* Helpers                                                           */
/* ---------------------------------------------------------------- */

/** A match, or a failure that names the input rather than reading "null". */
function block(before: string, empty = true): InputRuleMatch {
  const match = matchBlockRule(before, empty);
  if (match === null) throw new Error(`no block rule matched ${JSON.stringify(before)}`);
  return match;
}

function inline(before: string): InputRuleMatch {
  const match = matchInlineRule(before);
  if (match === null) throw new Error(`no inline rule matched ${JSON.stringify(before)}`);
  return match;
}

/* ---------------------------------------------------------------- */
/* Headings                                                          */
/* ---------------------------------------------------------------- */

describe("headings", () => {
  const rows: readonly { markdown: string; wikitext: string; format: string }[] = [
    { markdown: "## ", wikitext: "== ", format: "h2" },
    { markdown: "### ", wikitext: "=== ", format: "h3" },
    { markdown: "#### ", wikitext: "==== ", format: "h4" },
    { markdown: "##### ", wikitext: "===== ", format: "h5" },
  ];

  for (const row of rows) {
    it(`${row.markdown.trim()} and ${row.wikitext.trim()} both make ${row.format}`, () => {
      for (const before of [row.markdown, row.wikitext]) {
        expect(matchBlockRule(before, true)).toEqual({
          consumed: before.length,
          action: { kind: "format", format: row.format },
        });
      }
    });
  }

  it("formats a block that already holds text — the heading keeps it", () => {
    // `empty` is false: the author put the caret in front of a written
    // paragraph and typed the marker. Unlike the rule block, a heading has
    // somewhere to put the words.
    expect(block("## ", false).action).toEqual({ kind: "format", format: "h2" });
    expect(block("== ", false).action).toEqual({ kind: "format", format: "h2" });
  });

  it("offers no h1 and no h6 — the page title is the h1", () => {
    expect(matchBlockRule("= ", true)).toBeNull();
    expect(matchBlockRule("###### ", true)).toBeNull();
    expect(matchBlockRule("====== ", true)).toBeNull();
    expect(matchBlockRule("======= ", true)).toBeNull();
  });
});

/* ---------------------------------------------------------------- */
/* Lists, indent, rule                                               */
/* ---------------------------------------------------------------- */

describe("lists", () => {
  it("makes a bullet from a dash or an asterisk", () => {
    for (const before of ["- ", "* "]) {
      expect(matchBlockRule(before, true)).toEqual({
        consumed: 2,
        action: { kind: "list", list: "bullet" },
      });
    }
  });

  it('makes a numbered list from "1. "', () => {
    expect(matchBlockRule("1. ", true)).toEqual({
      consumed: 3,
      action: { kind: "list", list: "number" },
    });
  });

  it('THE DECISION: "# " is a numbered list, not a heading', () => {
    // Markdown would read it as an h1. Wikitext reads it as an ordered list
    // item, articles do not use h1, and "## " / "== " already reach every
    // heading this wiki writes — so the wikitext meaning wins.
    expect(matchBlockRule("# ", true)).toEqual({
      consumed: 2,
      action: { kind: "list", list: "number" },
    });
  });
});

describe("indent", () => {
  it("indents from a blockquote arrow or a wikitext colon", () => {
    for (const before of ["> ", ": "]) {
      expect(matchBlockRule(before, true)).toEqual({
        consumed: 2,
        action: { kind: "indent", delta: 1 },
      });
    }
  });
});

describe("horizontal rule", () => {
  it("takes three dashes or more, in either syntax", () => {
    for (const before of ["--- ", "---- ", "-------- "]) {
      expect(matchBlockRule(before, true)).toEqual({
        consumed: before.length,
        action: { kind: "insert", source: "----", block: true },
      });
    }
  });

  it("emits the same wikitext the toolbar's Insert → rule emits", () => {
    const match = block("---- ");
    expect(match.action).toEqual({ kind: "insert", source: "----", block: true });
  });

  it("refuses a block that holds anything else — a rule replaces it", () => {
    expect(matchBlockRule("--- ", false)).toBeNull();
    expect(matchBlockRule("---- ", false)).toBeNull();
  });

  it("is not one or two dashes", () => {
    expect(matchBlockRule("-- ", true)).toBeNull();
    // One dash is the bullet, and stays the bullet.
    expect(block("- ").action).toEqual({ kind: "list", list: "bullet" });
  });
});

/* ---------------------------------------------------------------- */
/* Refusals                                                          */
/* ---------------------------------------------------------------- */

describe("a block rule fires only at the start of a block", () => {
  const sentences = [
    "see ## below ",
    "see == below ",
    "a - b ",
    "step 1. ",
    "quoth he > ",
    "em -- dash --- ",
    " ## ",
    "\t- ",
  ];

  for (const before of sentences) {
    it(`leaves ${JSON.stringify(before)} as text`, () => {
      expect(matchBlockRule(before, false)).toBeNull();
      expect(matchBlockRule(before, true)).toBeNull();
    });
  }
});

describe("a block rule fires on the space that completes it, never earlier", () => {
  const markers = ["#", "##", "=", "==", "-", "*", "1.", ">", ":", "---", "----"];

  for (const marker of markers) {
    it(`leaves a bare ${JSON.stringify(marker)} alone`, () => {
      expect(matchBlockRule(marker, true)).toBeNull();
    });
  }

  it("wants the space last, not merely present", () => {
    // "## x" is a heading marker followed by a word: the moment to fire has
    // passed, and the author is writing.
    expect(matchBlockRule("## x", true)).toBeNull();
    expect(matchBlockRule("- x", true)).toBeNull();
  });
});

describe("nothing throws", () => {
  const odd = ["", " ", "  ", "\t", "\n", "x", "###", "***", "``", "%%% ", "1) ", "a".repeat(500)];

  for (const before of odd) {
    it(`answers ${JSON.stringify(before)} without raising`, () => {
      expect(() => matchBlockRule(before, true)).not.toThrow();
      expect(() => matchBlockRule(before, false)).not.toThrow();
      expect(() => matchInlineRule(before)).not.toThrow();
    });
  }

  it("returns null for an unrecognised prefix", () => {
    expect(matchBlockRule("%%% ", true)).toBeNull();
    expect(matchBlockRule("1) ", true)).toBeNull();
    expect(matchBlockRule("", true)).toBeNull();
    expect(matchBlockRule(" ", true)).toBeNull();
  });
});

/* ---------------------------------------------------------------- */
/* Inline                                                            */
/* ---------------------------------------------------------------- */

describe("inline rules", () => {
  it("marks a closed bold pair, delimiters and all", () => {
    expect(matchInlineRule("**bold**")).toEqual({
      consumed: 8,
      text: "bold",
      action: { kind: "mark", mark: "bold" },
    });
  });

  it("marks a closed code pair", () => {
    expect(matchInlineRule("`code`")).toEqual({
      consumed: 6,
      text: "code",
      action: { kind: "mark", mark: "code" },
    });
  });

  it("consumes only its own pair, not the sentence before it", () => {
    const bold = inline("the **Bracken** is **shy**");
    expect(bold.text).toBe("shy");
    expect(bold.consumed).toBe(7);

    const code = inline("run `yarn dev` then `yarn test`");
    expect(code.text).toBe("yarn test");
    expect(code.consumed).toBe(11);
  });

  it("leaves an unclosed pair alone", () => {
    expect(matchInlineRule("**bold")).toBeNull();
    expect(matchInlineRule("`code")).toBeNull();
    expect(matchInlineRule("**")).toBeNull();
    expect(matchInlineRule("`")).toBeNull();
  });

  it("wants something between the delimiters", () => {
    expect(matchInlineRule("****")).toBeNull();
    expect(matchInlineRule("``")).toBeNull();
    expect(matchInlineRule("***")).toBeNull();
  });

  it("leaves asterisks that are arithmetic or footnotes literal", () => {
    // Padded content is the tell: an author writing "2 ** 3 **" means powers.
    expect(matchInlineRule("2 ** 3 **")).toBeNull();
    expect(matchInlineRule("**bold **")).toBeNull();
    expect(matchInlineRule("** bold**")).toBeNull();
    // A stray asterisk inside would make the pairing a guess.
    expect(matchInlineRule("***x***")).toBeNull();
  });

  it("has no italic rule — a lone asterisk stays a lone asterisk", () => {
    expect(matchInlineRule("*italic*")).toBeNull();
    expect(matchInlineRule("*")).toBeNull();
    // Nor does wikitext's own emphasis get re-read as one.
    expect(matchInlineRule("''italic''")).toBeNull();
  });

  it("ignores text that merely resembles a rule", () => {
    expect(matchInlineRule("bold")).toBeNull();
    expect(matchInlineRule("a ** b")).toBeNull();
    expect(matchInlineRule("")).toBeNull();
  });

  it("says nothing about blocks, and block rules say nothing about marks", () => {
    // The two entry points are independent: the surface calls one on the space
    // and the other on a closing delimiter.
    expect(matchInlineRule("## ")).toBeNull();
    expect(matchBlockRule("**bold**", true)).toBeNull();
  });
});
