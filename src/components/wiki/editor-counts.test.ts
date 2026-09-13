/**
 * The publish bar's word and character count — docs/engine/visual-editor.md
 * §10.2.
 *
 * A counter looks too small to test until you write down what it has to be
 * true about. Three things, and each of them is a rule a one-line
 * `split(/\s+/).length` gets wrong:
 *
 * 1. **Korean.** Words are eojeol, separated by spaces — including U+3000, the
 *    ideographic space CJK text is actually written with, which is in `\s` and
 *    which a hand-rolled `[ \t\n]` test is not.
 * 2. **Characters are what a reader counts**, so an emoji is one and not the
 *    two UTF-16 units `String.length` reports.
 * 3. **The edges.** An empty buffer, a buffer of nothing but whitespace, and
 *    leading or trailing space, which is where an off-by-one lives.
 *
 * The last block asserts the thing the number is *for*: it counts the buffer,
 * wikitext and all, which is a limitation stated rather than hidden.
 */

import { describe, expect, it } from "vitest";

import { countText } from "./editor-counts";

describe("countText — words", () => {
  it("counts runs of non-whitespace", () => {
    expect(countText("one two three").words).toBe(3);
  });

  it("is not fooled by the edges or by runs of spaces", () => {
    expect(countText("  leading and trailing  ").words).toBe(3);
    expect(countText("two\n\n\nblank   lines").words).toBe(3);
    expect(countText("").words).toBe(0);
    expect(countText("   \n\t  ").words).toBe(0);
  });

  it("counts Korean by eojeol, which is what a space separates", () => {
    expect(countText("리썰 컴퍼니의 기본 할당량").words).toBe(4);
  });

  it("counts the ideographic space as a space", () => {
    // U+3000. A rule written against ASCII spaces would call this one word.
    expect(countText("달　탐사　보고").words).toBe(3);
  });

  it("counts every other separator JavaScript calls whitespace", () => {
    // NBSP, en quad, line separator, BOM — all in `\s`, all real in pasted text.
    expect(countText("a b c d﻿e").words).toBe(5);
  });

  it("does not split on a zero-width space, because `\\s` does not", () => {
    // U+200B is not whitespace in JavaScript, and inventing a rule for it here
    // would put this count out of step with every other scan in the editor.
    expect(countText("a​b").words).toBe(1);
  });
});

describe("countText — characters", () => {
  it("counts whitespace, which is text somebody typed", () => {
    expect(countText("a b").characters).toBe(3);
    expect(countText("\n\n").characters).toBe(2);
  });

  it("counts a Hangul syllable once", () => {
    expect(countText("달").characters).toBe(1);
    expect(countText("리썰 컴퍼니").characters).toBe(6);
  });

  it("counts an astral character once, not twice", () => {
    // "🌑".length is 2; a reader sees one character, and the bar says so.
    expect("🌑".length).toBe(2);
    expect(countText("🌑").characters).toBe(1);
    expect(countText("a🌑b").characters).toBe(3);
  });

  it("agrees with the code-point count on everything", () => {
    for (const sample of ["", "abc", "달 탐사", "a🌑b🌒c", "  ", "　x"]) {
      expect(countText(sample).characters).toBe([...sample].length);
    }
  });

  it("is zero for an empty buffer", () => {
    expect(countText("")).toEqual({ words: 0, characters: 0 });
  });
});

describe("countText — what it is a count of", () => {
  it("counts the wikitext, braces and all", () => {
    // Stated, not hidden (§10.2): the buffer is the one string both editing
    // modes share, and counting rendered prose would mean running the engine
    // on every keystroke for a figure in the corner of the screen.
    const counts = countText("{{Infobox moon|cost=1400}}");
    expect(counts.words).toBe(2);
    expect(counts.characters).toBe(26);
  });
});
