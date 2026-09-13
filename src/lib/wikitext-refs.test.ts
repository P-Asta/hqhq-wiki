/**
 * The named-reference scan behind the CITE menu's re-use rows
 * (docs/engine/visual-editor.md §1, wikitext-spec §10.3).
 *
 * Three things are asserted, in this order of importance:
 *
 * 1. **What it finds** — a name in any attribute spelling, once per (group,
 *    name), in the order a reader meets them.
 * 2. **What it refuses to see** — anything inside `<nowiki>`, `<pre>` or a
 *    comment, which is writing *about* a citation rather than one.
 * 3. **That the reuse form is the engine's.** The wikitext is pinned here and
 *    was confirmed against `POST /api/preview`: `<ref name="x" />` reuses the
 *    footnote, and dropping a `group=` does not.
 *
 * The name rule is a browser-side copy of the engine's (see the module's own
 * comment), so it is pinned against `isValidRefName` itself rather than
 * restated — a copy nothing compares is a copy that drifts.
 */

import { describe, expect, it } from "vitest";

import { isValidRefName } from "@/lib/wikitext/refs";
import {
  isUsableRefName,
  namedRefsUsed,
  refExcerpt,
  refReuseWikitext,
  REF_EXCERPT_MAX,
} from "@/lib/wikitext-refs";

/* ---------------------------------------------------------------- */
/* What it finds                                                     */
/* ---------------------------------------------------------------- */

describe("namedRefsUsed", () => {
  it("finds a named ref and keeps its body", () => {
    const refs = namedRefsUsed('Artifice is hard.<ref name="wiki">The manual, p. 4</ref>');
    expect(refs).toEqual([{ name: "wiki", group: "", body: "The manual, p. 4" }]);
  });

  it("ignores a ref with no name — there is nothing to cite again", () => {
    // An unnamed footnote can only be repeated by writing it out again, which
    // is what `citeBasic` already does.
    expect(namedRefsUsed("Loud.<ref>Observed in v70</ref>")).toEqual([]);
  });

  it("reads the name in every attribute spelling the engine accepts", () => {
    const source = [
      '<ref name="dq">A</ref>',
      "<ref name='sq'>B</ref>",
      "<ref name=bare>C</ref>",
      '<ref NAME="upper">D</ref>',
      '<ref  name = "spaced" >E</ref>',
    ].join("\n\n");
    expect(namedRefsUsed(source).map((ref) => ref.name)).toEqual([
      "dq",
      "sq",
      "bare",
      "upper",
      "spaced",
    ]);
  });

  it("lists a name once, in the order a reader meets it", () => {
    // Cite numbers footnotes by first use, so the menu reads like the list the
    // page will print.
    const source =
      'A<ref name="b">Beta</ref> B<ref name="a">Alpha</ref> C<ref name="b" /> D<ref name="a" />';
    expect(namedRefsUsed(source).map((ref) => ref.name)).toEqual(["b", "a"]);
  });

  it("keeps the FIRST definition's body, as the engine does", () => {
    // §10.3: a second body that differs only raises a warning; the first one
    // still renders, so it is the one the menu must show.
    const source = '<ref name="x">First</ref> then <ref name="x">Second</ref>';
    expect(namedRefsUsed(source)[0].body).toBe("First");
  });

  it("fills a body in from a definition that comes after the reuse", () => {
    // Reuse before definition is legal (§10.3) and normal in a page whose
    // sources are all declared inside `<references>` at the foot.
    const source = 'Text<ref name="x" />\n\n<references>\n<ref name="x">Late</ref>\n</references>';
    expect(namedRefsUsed(source)).toEqual([{ name: "x", group: "", body: "Late" }]);
  });

  it("offers a name it has only ever seen reused, with no body", () => {
    // The definition may live in a template. The name is still citable, and
    // the row falls back to showing it.
    expect(namedRefsUsed('Text<ref name="fromTemplate" />')).toEqual([
      { name: "fromTemplate", group: "", body: "" },
    ]);
  });

  it("keeps a group and a name apart", () => {
    // Cite keys a footnote by BOTH: the same name in two groups is two
    // footnotes, and a row for either has to say which.
    const source = '<ref name="x">Plain</ref><ref name="x" group="note">Noted</ref>';
    expect(namedRefsUsed(source)).toEqual([
      { name: "x", group: "", body: "Plain" },
      { name: "x", group: "note", body: "Noted" },
    ]);
  });

  it("does not confuse a group holding a space with a name holding one", () => {
    const source = '<ref name="b c" group="a">One</ref><ref name="c" group="a b">Two</ref>';
    expect(namedRefsUsed(source)).toHaveLength(2);
  });

  it("reads a self-closing tag written without the space", () => {
    // `<ref name=x/>` — the slash has to end the tag rather than join the
    // attribute, or the name comes back as "x/".
    expect(namedRefsUsed("Text<ref name=x/>")).toEqual([{ name: "x", group: "", body: "" }]);
  });

  it("finds a ref inside a table cell and a template argument", () => {
    const source = [
      "{| class=\"wikitable\"",
      '| Gold<ref name="gold">50 credits</ref> || Bar',
      "|}",
      "",
      '{{Verify|reason=stale<ref name="stale">v70</ref>}}',
    ].join("\n");
    expect(namedRefsUsed(source).map((ref) => ref.name)).toEqual(["gold", "stale"]);
  });

  it("finds nothing in an empty buffer", () => {
    // The menu offers no re-use rows at all for this, which is the whole of
    // the "empty list" behaviour.
    expect(namedRefsUsed("")).toEqual([]);
    expect(namedRefsUsed("Just prose, no citations.")).toEqual([]);
  });
});

/* ---------------------------------------------------------------- */
/* What it refuses to see                                            */
/* ---------------------------------------------------------------- */

describe("namedRefsUsed, on writing that only quotes a citation", () => {
  it("ignores one inside <nowiki>", () => {
    expect(namedRefsUsed('Type <nowiki><ref name="x">Source</ref></nowiki> to cite.')).toEqual([]);
  });

  it("ignores one inside <pre>, which is how the help page documents it", () => {
    expect(namedRefsUsed('<pre>\n<ref name="example">Book</ref>\n</pre>')).toEqual([]);
  });

  it("ignores one inside an HTML comment", () => {
    expect(namedRefsUsed('<!-- <ref name="todo">find a source</ref> -->')).toEqual([]);
  });

  it("ignores one inside <syntaxhighlight>", () => {
    expect(namedRefsUsed('<syntaxhighlight lang="text"><ref name="x" /></syntaxhighlight>')).toEqual(
      [],
    );
  });

  it("still finds the real ones around the quoted ones", () => {
    const source = [
      'Cited.<ref name="real">A real source</ref>',
      '<nowiki><ref name="quoted">not a source</ref></nowiki>',
      '<!-- <ref name="hidden" /> -->',
      'Cited again.<ref name="real" />',
    ].join("\n\n");
    expect(namedRefsUsed(source)).toEqual([
      { name: "real", group: "", body: "A real source" },
    ]);
  });

  it("treats the text after an unclosed <ref> as that ref's body, as the engine does", () => {
    // §10: an extension tag that never closes swallows the rest of the input,
    // so the `<ref name="later">` below is text inside the first footnote and
    // not a footnote anybody can cite.
    const refs = namedRefsUsed('Broken<ref name="open">start\n\nmore<ref name="later">x</ref>');
    expect(refs.map((ref) => ref.name)).toEqual(["open"]);
  });

  it("ignores a stray closing tag", () => {
    expect(namedRefsUsed("Text</ref> more")).toEqual([]);
  });
});

/* ---------------------------------------------------------------- */
/* Names the engine would refuse                                     */
/* ---------------------------------------------------------------- */

describe("isUsableRefName", () => {
  it("agrees with the engine's own rule, character for character", () => {
    // The browser copy exists because the engine is server-side; a copy
    // nothing compares is a copy that drifts.
    const names = [
      "wiki",
      "Hutchins 2024",
      "manual-p4",
      "a.b:c_d",
      "패치노트",
      "",
      "   ",
      "12",
      " 42 ",
      "1a",
      'say"what',
      "a<b",
      "a|b",
      "a\nb",
      "a{{b}}",
    ];
    for (const name of names) {
      expect(isUsableRefName(name), name).toBe(isValidRefName(name));
    }
  });

  it("keeps a ref the engine would reject out of the menu", () => {
    // `<ref name="7">` already renders "Cite error: invalid ref name" where it
    // was written; a re-use row would put a second one further down the page.
    expect(namedRefsUsed('<ref name="7">Numeric</ref>')).toEqual([]);
    expect(namedRefsUsed('<ref name="a|b">Piped</ref>')).toEqual([]);
  });

  it("keeps a ref whose group cannot be quoted out of the menu", () => {
    // The reuse form must repeat `group=`, and escaping is forbidden (§4), so
    // a group there is no faithful spelling for is left alone.
    expect(namedRefsUsed(`<ref name="x" group='say"what'>Body</ref>`)).toEqual([]);
  });
});

/* ---------------------------------------------------------------- */
/* The reuse form                                                    */
/* ---------------------------------------------------------------- */

describe("refReuseWikitext", () => {
  it("writes the self-closing form the engine reuses on", () => {
    // Confirmed against POST /api/preview: this renders the SAME footnote
    // number as the definition and adds a backlink to it.
    expect(refReuseWikitext({ name: "wiki", group: "" })).toBe('<ref name="wiki" />');
  });

  it("repeats the group, because a group is half the identity", () => {
    // Without it the reuse names a different footnote in the default group,
    // which renders "Cite error: no text provided for ref".
    expect(refReuseWikitext({ name: "x", group: "note" })).toBe(
      '<ref name="x" group="note" />',
    );
  });

  it("spells back exactly what the scan found, for every ref it offers", () => {
    // The round trip that matters: a name read off the page and written again
    // has to come back as the same name, or the reuse is a new footnote.
    const source = '<ref name="Hutchins 2024">A</ref><ref name=\'a.b:c-d_e\' group="note">B</ref>';
    for (const ref of namedRefsUsed(source)) {
      const reused = namedRefsUsed(refReuseWikitext(ref));
      expect(reused).toEqual([{ name: ref.name, group: ref.group, body: "" }]);
    }
  });
});

/* ---------------------------------------------------------------- */
/* The excerpt a menu row shows                                      */
/* ---------------------------------------------------------------- */

describe("refExcerpt", () => {
  it("folds a footnote written over several lines onto one", () => {
    expect(refExcerpt("The manual,\n  page 4.\t\tSecond edition.")).toBe(
      "The manual, page 4. Second edition.",
    );
  });

  it("elides a long one rather than stretching the menu", () => {
    const excerpt = refExcerpt("x".repeat(200));
    expect(excerpt.endsWith("…")).toBe(true);
    expect(Array.from(excerpt)).toHaveLength(REF_EXCERPT_MAX + 1);
  });

  it("never cuts a character in half", () => {
    // Counting UTF-16 units would split a surrogate pair and print U+FFFD.
    const excerpt = refExcerpt("🌑".repeat(40), 4);
    expect(excerpt).toBe("🌑🌑🌑🌑…");
  });

  it("is empty for a ref the page only ever reuses", () => {
    expect(refExcerpt("")).toBe("");
  });
});
