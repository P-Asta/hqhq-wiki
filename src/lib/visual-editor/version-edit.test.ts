/**
 * Removing one version's writing — src/lib/visual-editor/version-edit.ts.
 *
 * This transform deletes prose, so the assertions are on the *exact* resulting
 * buffer rather than on a substring: "the v56 text is gone" is also true of a
 * function that ate the paragraph after it. The two shapes below are what an
 * author will actually click the X on — a lone open-ended tag in an article,
 * and a help page's run of windows — and the second carries the trap as well:
 * its `<pre>` block documents the grammar in the grammar, and none of that is
 * a passage.
 *
 * Both are shaped like the seeded pages, frozen here rather than read out of
 * `seed-data.ts` so that a later seed rewrite cannot quietly empty this suite.
 *
 * Grammar references are to docs/engine/versioning.md §2.1 — the tag NAME is
 * the range — and the control they serve is §6.
 */

import { describe, expect, it } from "vitest";

import { versionsUsed } from "@/lib/wikitext-highlight";

import { parseDocument } from "./parse";
import { serializeDocument } from "./serialize";
import { previewVersionRemoval, removeVersionBranch } from "./version-edit";

/** An article carrying one open-ended tag between two blank lines. */
const CRUISER_PAGE = `The '''Company Cruiser''' is a drivable utility truck ordered from the store.

<v55+>''Added in v55, the vehicle update.''</v55+>

== Driving and cargo ==
The ignition is deliberately unreliable, so start the engine '''before''' you need to leave.

[[Category:Equipment]]
`;

/**
 * A help page shaped like the seeded one: three back-to-back windows, two
 * parser functions naming a boundary the transform must not touch, and a
 * `<pre>` block documenting the grammar with an id (v50) that is therefore
 * never a passage of this page.
 */
const HELP_PAGE = `{{Version note}}
'''Version scoping''' lets a single article carry facts for several game versions at once.

== Live demonstration ==

<v45+v55>You are viewing a version between '''v45''' and v55. This sentence lives in the first window.</v45+v55><v56+v60>You are viewing '''v56''' to v60. The second window replaced the first at v56.</v56+v60><v62+>You are viewing '''v62''' or later. The third window replaced the second at v62.</v62+>

Selected version: '''{{VERSION}}'''.{{#ifversion: >=v56 | This note only appears from v56 onward.}}

A value picked per version: '''{{#vswitch: v45=first | v56=second | v62=third | default=none}}'''.

== The version tag ==

<pre>
The base quota is <v50+v61>'''130'''</v50+v61><v62+>'''180'''</v62+> credits.
</pre>

[[Category:Help]]
`;

/** Wikitext the visual editor can read back byte for byte (visual-editor.md §4). */
function roundTrips(wikitext: string): boolean {
  return serializeDocument(parseDocument(wikitext)) === wikitext;
}

/* ------------------------------------------------------------------ */

describe("removeVersionBranch — the shapes an author clicks the X on", () => {
  const CRUISER_LINE = `<v55+>''Added in v55, the vehicle update.''</v55+>`;

  it("takes a standalone tag and the blank line it was holding open", () => {
    const source = CRUISER_PAGE;
    expect(source).toContain(CRUISER_LINE);

    const result = removeVersionBranch(source, "v55");

    expect(result.text).toBe(source.replace(`\n${CRUISER_LINE}\n`, ""));
    // The italics are the author's; the tags are not.
    expect(result.removedChars).toBe(`''Added in v55, the vehicle update.''`.length);
    expect(result.leftBehind).toBe(0);
    expect(versionsUsed(result.text)).toEqual([]);
  });

  const HELP_V56 = `<v56+v60>You are viewing '''v56''' to v60. The second window replaced the first at v56.</v56+v60>`;

  it("takes one window out of a run of them and leaves its neighbours alone", () => {
    const source = HELP_PAGE;
    expect(source).toContain(HELP_V56);

    const result = removeVersionBranch(source, "v56");

    expect(result.text).toBe(source.replace(HELP_V56, ""));
    expect(result.removedChars).toBe(
      `You are viewing '''v56''' to v60. The second window replaced the first at v56.`.length,
    );
    // `{{#vswitch: … v56=second …}}` and the `{{#ifversion: >=v56 …}}` note.
    expect(result.leftBehind).toBe(2);
  });

  it("leaves a page whose only mention of the id is documentation byte for byte", () => {
    // The help page teaches the grammar with a `<pre>` block that writes v50,
    // so v50 is never a passage of the page — its chip never appears, and
    // asking for it anyway must change nothing.
    const source = HELP_PAGE;
    expect(source).toContain(`<v50+v61>'''130'''</v50+v61>`);
    expect(versionsUsed(source)).not.toContain("v50");

    expect(removeVersionBranch(source, "v50")).toEqual({
      text: source,
      removedChars: 0,
      leftBehind: 0,
    });
  });

  it("keeps the help page parseable after every one of its boundaries is removed", () => {
    const source = HELP_PAGE;
    expect(roundTrips(source)).toBe(true);

    let text = source;
    for (const id of versionsUsed(source)) text = removeVersionBranch(text, id).text;

    expect(text).not.toContain(HELP_V56);
    expect(roundTrips(text)).toBe(true);
    // No blank line grew a second one anywhere on the page.
    expect(/\n[ \t]*\n[ \t]*\n/.test(text)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("the three forms", () => {
  it("removes a passage that applies to exactly that version", () => {
    expect(removeVersionBranch(`a\n\n<v62>gone</v62>\n\nb\n`, "v62")).toEqual({
      text: "a\n\nb\n",
      removedChars: 4,
      leftBehind: 0,
    });
  });

  it("removes a window that STARTS at the version, and its whole body", () => {
    // `<v62+v70>` is what the page says from v62; the upper end says how far
    // the saying runs, not whose it is.
    expect(removeVersionBranch(`a\n\n<v62+v70>gone</v62+v70>\n\nb\n`, "v62")).toEqual({
      text: "a\n\nb\n",
      removedChars: 4,
      leftBehind: 0,
    });
  });

  it("removes an open-ended passage", () => {
    expect(removeVersionBranch(`a\n\n<v62+>gone</v62+>\n\nb\n`, "v62")).toEqual({
      text: "a\n\nb\n",
      removedChars: 4,
      leftBehind: 0,
    });
  });

  it("removes a self-closing tag, which names a boundary and writes nothing", () => {
    expect(removeVersionBranch(`a\n\n<v62+/>\n\nb\n`, "v62")).toEqual({
      text: "a\n\nb\n",
      removedChars: 0,
      leftBehind: 0,
    });
  });

  it("removes an empty passage — the one the `+` menu makes to be typed into", () => {
    // Nothing authored goes with it, but the buffer does change: the chip has
    // to be able to go away again, and the confirmation says no text is lost.
    const result = removeVersionBranch(`a\n\n<v72></v72>\n\nb\n`, "v72");
    expect(result).toEqual({ text: "a\n\nb\n", removedChars: 0, leftBehind: 0 });
  });

  it("cuts a tag sharing its line with prose exactly, spacing untouched", () => {
    // Rewriting the author's sentence spacing is a bigger liberty than the
    // double space it would fix, and the renderer collapses it anyway.
    expect(removeVersionBranch(`Intro <v62+>gone</v62+> outro.\n`, "v62")).toEqual({
      text: "Intro  outro.\n",
      removedChars: 4,
      leftBehind: 0,
    });
  });

  it("removes every occurrence, not just the first", () => {
    const source = `<v62+>one</v62+>\n\nmiddle\n\n<v62>two</v62>\n`;
    expect(removeVersionBranch(source, "v62")).toEqual({
      text: "middle\n",
      removedChars: 6,
      leftBehind: 0,
    });
  });

  it("takes back-to-back windows one at a time, then the line they shared", () => {
    // What the conversion produces, and what the seed writes by hand: windows
    // written with nothing between them, because a newline there would render
    // for every version (§2.2).
    const source = `Intro.\n\n<v45+v55>A</v45+v55><v56+v60>B</v56+v60><v62+>C</v62+>\n\nOutro.\n`;
    let text = removeVersionBranch(source, "v45").text;
    expect(text).toBe(`Intro.\n\n<v56+v60>B</v56+v60><v62+>C</v62+>\n\nOutro.\n`);
    text = removeVersionBranch(text, "v56").text;
    expect(text).toBe(`Intro.\n\n<v62+>C</v62+>\n\nOutro.\n`);
    expect(removeVersionBranch(text, "v62")).toEqual({
      text: "Intro.\n\nOutro.\n",
      removedChars: 1,
      leftBehind: 0,
    });
  });

  it("reaches a passage nested inside one it keeps", () => {
    const source = `<v45+>kept <v62+>gone</v62+>text</v45+>\n`;
    expect(removeVersionBranch(source, "v62")).toEqual({
      text: `<v45+>kept text</v45+>\n`,
      removedChars: 4,
      leftBehind: 0,
    });
  });

  it("compares ids trimmed and case-insensitively, the closer included", () => {
    const source = `<V56+>x</v56+>\n`;
    for (const id of ["v56", "V56", " v56 ", "  V56"]) {
      expect(removeVersionBranch(source, id).text).toBe("");
    }
  });

  it("refuses `*` and the empty id, which name no version", () => {
    const source = `<v56+>x</v56+>\n`;
    for (const id of ["*", "", "   "]) {
      expect(removeVersionBranch(source, id)).toEqual({
        text: source,
        removedChars: 0,
        leftBehind: 0,
      });
    }
  });

  it("leaves an ordinary tag alone, however close its name reads", () => {
    // The grammar is anchored on the whole name: `<var>` is HTML and `<v56x>`
    // is nothing, so neither is anybody's version writing.
    for (const source of [`<var>x</var>\n`, `<v56x>x</v56x>\n`, `<v56v60>x</v56v60>\n`]) {
      expect(removeVersionBranch(source, "v56").text).toBe(source);
    }
  });
});

/* ------------------------------------------------------------------ */

describe("what it refuses to touch", () => {
  it("counts a window that ENDS at the id and leaves it standing", () => {
    // `<v50+v61>` is v50's passage: cutting it because v61 was asked for would
    // delete v50's writing under another version's name. The author moves the
    // end themselves, and the count is how they learn there is one.
    const source = `<v50+v61>x</v50+v61>\n`;
    expect(removeVersionBranch(source, "v61")).toEqual({
      text: source,
      removedChars: 0,
      leftBehind: 1,
    });
  });

  it("does not count a window on itself, which it removes outright", () => {
    // `<v56+v56>` is `<v56>`: both ends are the same version, and the passage
    // is that version's, so there is nothing left to visit afterwards.
    expect(removeVersionBranch(`<v56+v56>x</v56+v56>\n`, "v56")).toEqual({
      text: "",
      removedChars: 1,
      leftBehind: 0,
    });
    expect(removeVersionBranch(`<v56>x</v56>\n`, "v56").leftBehind).toBe(0);
  });

  it("does not count an end that rode out on a removed passage", () => {
    // Counted off the RESULT: the `<v56+v60>` window went with v56, so v60 is
    // no longer named anywhere and nothing is reported for it.
    const source = `<v56+v60>x</v56+v60>\n`;
    expect(removeVersionBranch(source, "v56").leftBehind).toBe(0);
    expect(removeVersionBranch(source, "v60").leftBehind).toBe(1);
  });

  it("counts an #ifversion naming the id and leaves it exactly as written", () => {
    const source = "Cost: {{#ifversion: >=v62 | 1500 | 1400}}.\n";
    expect(removeVersionBranch(source, "v62")).toEqual({
      text: source,
      removedChars: 0,
      leftBehind: 1,
    });
  });

  it("counts both ends of an #ifversion span", () => {
    const source = "{{#ifversion: v50-v61 | old}}\n";
    expect(removeVersionBranch(source, "v50").leftBehind).toBe(1);
    expect(removeVersionBranch(source, "v61").leftBehind).toBe(1);
    expect(removeVersionBranch(source, "v55").leftBehind).toBe(0);
  });

  it("counts a #vswitch boundary key", () => {
    const source = "| cost = {{#vswitch: v50=1400 | v62=1500 }}\n";
    expect(removeVersionBranch(source, "v62")).toEqual({
      text: source,
      removedChars: 0,
      leftBehind: 1,
    });
  });

  it("does not count a #vswitch default or a positional argument", () => {
    const source = "{{#vswitch: v50=1400 | default=v62 | v62 }}\n";
    expect(removeVersionBranch(source, "v62").leftBehind).toBe(0);
  });

  it("counts one call once however often it names the id", () => {
    // The number is places to visit, not mentions to fix.
    const source = "{{#ifversion: v56,>=v56 | a | b}}\n";
    expect(removeVersionBranch(source, "v56").leftBehind).toBe(1);
  });

  it("counts the calls that survive alongside the passages it removed", () => {
    const source = `<v62+>gone</v62+>\n\n{{#vswitch: v50=a | v62=b }} and {{#ifversion: v62 | c}}\n`;
    expect(removeVersionBranch(source, "v62")).toEqual({
      text: "{{#vswitch: v50=a | v62=b }} and {{#ifversion: v62 | c}}\n",
      removedChars: 4,
      leftBehind: 2,
    });
  });

  it("counts an unclosed call, which is what put the chip on screen", () => {
    expect(removeVersionBranch("{{#ifversion: v62 | orphan\n", "v62").leftBehind).toBe(1);
  });
});

/* ------------------------------------------------------------------ */

describe("comments and raw text are not markup", () => {
  it("does not let a closer inside a nowiki end the passage early", () => {
    const source = `<v56+v60>a<nowiki></v56+v60></nowiki>b</v56+v60>\n<v62+>c</v62+>\n`;
    expect(removeVersionBranch(source, "v56")).toEqual({
      text: `<v62+>c</v62+>\n`,
      removedChars: "a<nowiki></v56+v60></nowiki>b".length,
      leftBehind: 0,
    });
  });

  it("does not let a closer inside a comment end the passage early", () => {
    const source = `<v56+>a<!-- </v56+> -->b</v56+>\n<v62+>c</v62+>\n`;
    expect(removeVersionBranch(source, "v56").text).toBe(`<v62+>c</v62+>\n`);
  });

  it("leaves version markup that is only being quoted", () => {
    const source = `<pre>\n<v56+>example</v56+>\n</pre>\n`;
    expect(removeVersionBranch(source, "v56")).toEqual({
      text: source,
      removedChars: 0,
      leftBehind: 0,
    });
  });

  it("leaves version markup inside a comment, and does not count a call there", () => {
    const source = `<!-- <v56+>x</v56+> {{#ifversion: v56 | y}} -->\n`;
    expect(removeVersionBranch(source, "v56")).toEqual({
      text: source,
      removedChars: 0,
      leftBehind: 0,
    });
  });

  it("removes a real passage that follows a quoted one", () => {
    const source = `<nowiki><v56+>quoted</v56+></nowiki>\n\n<v56+>real</v56+>\n`;
    expect(removeVersionBranch(source, "v56")).toEqual({
      text: `<nowiki><v56+>quoted</v56+></nowiki>\n`,
      removedChars: "real".length,
      leftBehind: 0,
    });
  });
});

/* ------------------------------------------------------------------ */

describe("nesting", () => {
  it("works inside a table cell", () => {
    const source = `{|\n|-\n| <v56+v60>a</v56+v60><v62+>b</v62+>\n|}\n`;
    expect(removeVersionBranch(source, "v56").text).toBe(`{|\n|-\n| <v62+>b</v62+>\n|}\n`);
  });

  it("works inside a template argument", () => {
    const source = `{{Infobox moon\n| cost = <v56+v60>1400</v56+v60><v62+>1500</v62+>\n}}\n`;
    expect(removeVersionBranch(source, "v56")).toEqual({
      text: `{{Infobox moon\n| cost = <v62+>1500</v62+>\n}}\n`,
      removedChars: 4,
      leftBehind: 0,
    });
  });

  it("works inside a list item", () => {
    const source = `* one <v56+>two</v56+>\n* three\n`;
    expect(removeVersionBranch(source, "v56").text).toBe("* one \n* three\n");
  });
});

/* ------------------------------------------------------------------ */

describe("whitespace", () => {
  it("leaves one blank line where a block had one on each side", () => {
    expect(removeVersionBranch(`a\n\n<v62+>x</v62+>\n\nb\n`, "v62").text).toBe("a\n\nb\n");
  });

  it("keeps the document's trailing newline when the last block goes", () => {
    expect(removeVersionBranch(`a\n\n<v62+>x</v62+>\n`, "v62").text).toBe("a\n");
  });

  it("does not invent a trailing newline the document never had", () => {
    expect(removeVersionBranch(`a\n\n<v62+>x</v62+>`, "v62").text).toBe("a");
  });

  it("does not leave a blank line at the top when the first block goes", () => {
    expect(removeVersionBranch(`<v62+>x</v62+>\n\nb\n`, "v62").text).toBe("b\n");
  });

  it("empties a document that was nothing but the passage", () => {
    expect(removeVersionBranch(`<v62+>x</v62+>\n`, "v62").text).toBe("");
  });

  it("removes two adjacent blocks without collapsing what is around them", () => {
    const source = `a\n\n<v62>x</v62>\n\n<v62+>y</v62+>\n\nb\n`;
    expect(removeVersionBranch(source, "v62").text).toBe("a\n\nb\n");
  });

  it("keeps a heading's own blank line", () => {
    const source = `== Head ==\n\n<v62+>x</v62+>\n\n== Next ==\n`;
    expect(removeVersionBranch(source, "v62").text).toBe("== Head ==\n\n== Next ==\n");
  });

  it("removes an indented tag with its indentation", () => {
    const source = `{|\n|-\n  <v56+>x</v56+>\n  <v62+>y</v62+>\n|}\n`;
    expect(removeVersionBranch(source, "v56").text).toBe(`{|\n|-\n  <v62+>y</v62+>\n|}\n`);
  });
});

/* ------------------------------------------------------------------ */

describe("malformed markup is left alone", () => {
  it.each([
    [`a\n<v56+\nb\n`, "an unfinished tag"],
    ["a\n</v56+>\nb\n", "a stray closer"],
    [`a\n<!-- <v56+>x\n`, "an unterminated comment"],
  ])("returns the buffer unchanged for %#: %s", (source) => {
    const result = removeVersionBranch(source, "v56");
    expect(result.text).toBe(source);
    expect(result.removedChars).toBe(0);
  });

  it("removes nothing for an unclosed passage, where the engine would take the page", () => {
    // `findClosingTag` (preprocessor.ts) ends an unclosed extension tag at the
    // end of the input, so the engine reads everything below as v56's writing.
    // Acting on that reading would delete the rest of the article over a typo,
    // so this is the one place the engine is deliberately not followed.
    const source = `a\n\n<v56+>no closer ever\n\n== Later heading ==\n\nStill here.\n`;
    expect(removeVersionBranch(source, "v56")).toEqual({
      text: source,
      removedChars: 0,
      leftBehind: 0,
    });
  });

  it("removes nothing when the closing name does not repeat the opening one", () => {
    // §10.7: `</v70+>` does not close `<v56+>`, so the passage has no end this
    // can trust — and the stray closer names no passage of its own.
    const source = `a\n\n<v56+>x</v70+>\n\nb\n`;
    expect(removeVersionBranch(source, "v56")).toEqual({
      text: source,
      removedChars: 0,
      leftBehind: 0,
    });
  });

  it("treats everything below an unclosed nowiki as quoted, exactly as the engine does", () => {
    const source = `a\n<nowiki><v56+>x</v56+>\n\nmore prose\n`;
    expect(removeVersionBranch(source, "v56")).toEqual({
      text: source,
      removedChars: 0,
      leftBehind: 0,
    });
  });

  it("never throws on hostile input", () => {
    const hostile = [
      "<v56 ".repeat(2000),
      "<v56+>".repeat(200) + "x",
      "<!--".repeat(500),
      "{{#ifversion:".repeat(500),
      "<v56+>".repeat(80) + "deep" + "</v56+>".repeat(80),
      "",
    ];
    for (const source of hostile) {
      expect(() => removeVersionBranch(source, "v56")).not.toThrow();
    }
  });
});

/* ------------------------------------------------------------------ */

describe("idempotence and the preview contract", () => {
  const SOURCE = `Intro.\n\n<v56+v60>B</v56+v60><v62+>C</v62+>\n`;

  it("returns the source unchanged for an id the page never writes for", () => {
    expect(removeVersionBranch(SOURCE, "v70")).toEqual({
      text: SOURCE,
      removedChars: 0,
      leftBehind: 0,
    });
  });

  it("is a fixed point: removing the same id twice changes nothing the second time", () => {
    const once = removeVersionBranch(SOURCE, "v56");
    const twice = removeVersionBranch(once.text, "v56");
    expect(twice.text).toBe(once.text);
    expect(twice.removedChars).toBe(0);
  });

  it("previews exactly what it applies, so the confirmation cannot lie", () => {
    for (const id of ["v56", "v60", "v62", "v70", "*"]) {
      expect(previewVersionRemoval(SOURCE, id)).toEqual(removeVersionBranch(SOURCE, id));
    }
  });

  it("leaves a document the editor can still read after every version goes", () => {
    const source = `{{Infobox moon\n| cost = 1400\n}}\nLead paragraph.\n\n== Head ==\n\n<v45+v55>A</v45+v55><v56+>B</v56+>\n\n<v62>C</v62>\n\n* list item\n\n[[Category:Moons]]\n`;
    expect(roundTrips(source)).toBe(true);

    let text = source;
    for (const id of versionsUsed(source)) text = removeVersionBranch(text, id).text;

    expect(text).toBe(
      `{{Infobox moon\n| cost = 1400\n}}\nLead paragraph.\n\n== Head ==\n\n* list item\n\n[[Category:Moons]]\n`,
    );
    expect(versionsUsed(text)).toEqual([]);
    expect(roundTrips(text)).toBe(true);
  });
});
