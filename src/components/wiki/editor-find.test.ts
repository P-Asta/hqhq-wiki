/**
 * The find-and-replace matcher, tested where it has to be exact —
 * docs/engine/visual-editor.md §9.
 *
 * Every claim here is one an author feels immediately and cannot work around:
 * a count that is wrong by one, a `[[` that is read as a character class, a
 * whole-word toggle that refuses Korean, a "Replace all" that finds its own
 * output and runs until the tab dies. The module is pure precisely so all of
 * that can be pinned down without a browser, which is the same bargain
 * `editor-draft.ts` and `table.ts` take.
 *
 * The block-span section is the one piece that talks to the parser. It is
 * asserted over the wiki's real corpus rather than over fixtures, for the
 * reason roundtrip.test.ts gives: the fixtures a parser's author writes inherit
 * that author's blind spots, and this arithmetic is only correct if it agrees
 * with `serializeDocument` on every article the wiki actually ships.
 */

import { describe, expect, it } from "vitest";

import { ENTITY_ARTICLES } from "@/lib/db/seed-content/entities";
import { MOON_ARTICLES } from "@/lib/db/seed-content/moons";
import { ARTICLES, HELP_PAGES, TEMPLATES } from "@/lib/db/seed-data";

import {
  applyFindReplace,
  blockSpanAt,
  blockSpans,
  findMatches,
  matchContext,
  matchIndexBefore,
  matchIndexFrom,
  occurrenceInSpan,
  seedQuery,
  type FindMatch,
  type FindOptions,
} from "./editor-find";

const PLAIN: FindOptions = { caseSensitive: false, wholeWord: false };
const EXACT: FindOptions = { caseSensitive: true, wholeWord: false };
const WORDS: FindOptions = { caseSensitive: false, wholeWord: true };

/** Matches as `[start, end]` pairs — easier to read than the objects. */
function spans(text: string, query: string, options: FindOptions): [number, number][] {
  return findMatches(text, query, options).map((match) => [match.start, match.end]);
}

/** What each match actually covers, which is the claim an offset is making. */
function hits(text: string, query: string, options: FindOptions): string[] {
  return findMatches(text, query, options).map((match) => text.slice(match.start, match.end));
}

describe("findMatches — the offsets", () => {
  it("finds every occurrence, left to right", () => {
    expect(spans("Artifice, then Artifice again", "Artifice", PLAIN)).toEqual([
      [0, 8],
      [15, 23],
    ]);
  });

  it("an empty query matches nothing at all — not every gap between characters", () => {
    expect(findMatches("Artifice", "", PLAIN)).toEqual([]);
    expect(findMatches("", "", PLAIN)).toEqual([]);
    // …and neither does a query longer than the buffer.
    expect(findMatches("v70", "v70 and v71", PLAIN)).toEqual([]);
  });

  it("an empty buffer is searched without incident", () => {
    expect(findMatches("", "Artifice", PLAIN)).toEqual([]);
  });

  it("offsets slice back to the query, case-insensitively too", () => {
    expect(hits("ARTIFICE artifice ArTiFiCe", "artifice", PLAIN)).toEqual([
      "ARTIFICE",
      "artifice",
      "ArTiFiCe",
    ]);
  });

  it("case sensitivity is a refusal, not a re-ranking", () => {
    expect(spans("Titan titan TITAN", "titan", EXACT)).toEqual([[6, 11]]);
    expect(findMatches("Titan titan TITAN", "titan", PLAIN)).toHaveLength(3);
  });

  it("folding never moves an offset, even where lowercasing would grow a character", () => {
    // `İ` (U+0130) lowercases to two code units. Folding it would shift every
    // offset after it by one, so it is left alone — the match that follows is
    // still reported at its true index.
    const text = "İstanbul artifice";
    expect(hits(text, "artifice", PLAIN)).toEqual(["artifice"]);
    expect(spans(text, "artifice", PLAIN)).toEqual([[9, 17]]);
  });

  it("astral characters are matched whole and do not disturb neighbours", () => {
    const text = "a 🌑 moon, a 🌑 moon";
    expect(hits(text, "🌑", PLAIN)).toEqual(["🌑", "🌑"]);
    expect(hits(text, "moon", PLAIN)).toEqual(["moon", "moon"]);
  });
});

describe("findMatches — overlapping candidates", () => {
  it("takes non-overlapping matches: 'aa' occurs once in 'aaa'", () => {
    expect(spans("aaa", "aa", PLAIN)).toEqual([[0, 2]]);
  });

  it("…and twice in 'aaaa', which is what replacing them all has to produce", () => {
    expect(spans("aaaa", "aa", PLAIN)).toEqual([
      [0, 2],
      [2, 4],
    ]);
    expect(applyFindReplace("aaaa", { query: "aa", replacement: "b", options: PLAIN, index: null }))
      .toMatchObject({ text: "bb", replaced: 2 });
  });

  it("counts a self-overlapping query the way it can be replaced", () => {
    // "abab" occurs at 0 and would occur again at 2 if matches could overlap;
    // both cannot be replaced, so only the first is reported.
    expect(spans("ababab", "abab", PLAIN)).toEqual([[0, 4]]);
  });

  it("a refused whole-word candidate does not consume the text it overlapped", () => {
    // The `ab` at 1 is inside `xab`; the one at 3 is a word of its own, and a
    // scan that had skipped past the refusal would have missed it.
    expect(spans("xab ab", "ab", WORDS)).toEqual([[4, 6]]);
  });
});

describe("findMatches — the query is literal", () => {
  it("regex metacharacters are characters", () => {
    const text = "a.c and abc";
    expect(spans(text, "a.c", PLAIN)).toEqual([[0, 3]]);
    expect(findMatches(text, "a.c", PLAIN)).toHaveLength(1);
  });

  it("wikitext punctuation is searchable as written", () => {
    const text = "see [[Artifice]] and {{Infobox moon|name=Artifice}}";
    expect(hits(text, "[[", PLAIN)).toEqual(["[["]);
    expect(hits(text, "{{Infobox moon|", PLAIN)).toEqual(["{{Infobox moon|"]);
    expect(hits(text, "*", PLAIN)).toEqual([]);
    expect(hits(text, "(?:", PLAIN)).toEqual([]);
  });

  it("a query of backslashes is not an escape", () => {
    expect(hits("path \\d here", "\\d", PLAIN)).toEqual(["\\d"]);
    expect(hits("path 7 here", "\\d", PLAIN)).toEqual([]);
  });

  it("an unbalanced bracket is a query, not a syntax error", () => {
    expect(() => findMatches("a [ b", "[", PLAIN)).not.toThrow();
    expect(spans("a [ b", "[", PLAIN)).toEqual([[2, 3]]);
  });
});

describe("findMatches — whole word", () => {
  it("refuses a hit that continues into a word", () => {
    expect(hits("Artifice Artifices", "Artifice", WORDS)).toEqual(["Artifice"]);
    expect(spans("Artifice Artifices", "Artifice", WORDS)).toEqual([[0, 8]]);
  });

  it("refuses a hit that a word runs into", () => {
    expect(findMatches("preArtifice", "Artifice", WORDS)).toEqual([]);
  });

  it("counts digits and underscores as word characters", () => {
    expect(findMatches("v70 v70b v70_1", "v70", WORDS)).toEqual([{ start: 0, end: 3 }]);
  });

  it("is Unicode-aware, so Korean is a word rather than a wall of boundaries", () => {
    // Without `\\p{L}`, every Hangul syllable would read as a boundary and the
    // toggle would match inside a longer word.
    expect(findMatches("달 표면과 달빛", "달", WORDS)).toEqual([{ start: 0, end: 1 }]);
  });

  it("punctuation and brackets bound a word", () => {
    expect(findMatches("[[Artifice]], Artifice.", "Artifice", WORDS)).toHaveLength(2);
  });

  it("asks nothing of an edge the query does not begin or end a word on", () => {
    // `[[` cannot be "inside a word", so whole-word must not silently refuse
    // every hit of it — that reads as a broken toggle rather than a rule.
    expect(findMatches("see [[Artifice]]", "[[", WORDS)).toEqual([{ start: 4, end: 6 }]);
  });

  it("still applies the edge the query DOES end a word on", () => {
    // The trailing `e` is a word character, so `x` after it refuses the hit.
    expect(findMatches("[[Artificex", "[[Artifice", WORDS)).toEqual([]);
  });
});

describe("matchIndexFrom", () => {
  const matches: FindMatch[] = [
    { start: 4, end: 8 },
    { start: 20, end: 24 },
    { start: 40, end: 44 },
  ];

  it("stands on the first match at or after the offset", () => {
    expect(matchIndexFrom(matches, -1)).toBe(0);
    expect(matchIndexFrom(matches, 4)).toBe(0);
    expect(matchIndexFrom(matches, 5)).toBe(1);
    expect(matchIndexFrom(matches, 40)).toBe(2);
  });

  it("wraps to the first when nothing follows the offset", () => {
    expect(matchIndexFrom(matches, 41)).toBe(0);
    expect(matchIndexFrom(matches, 9_999)).toBe(0);
  });

  it("has nothing to stand on in an empty list", () => {
    expect(matchIndexFrom([], 0)).toBe(-1);
  });
});

describe("matchIndexBefore", () => {
  const matches: FindMatch[] = [
    { start: 4, end: 8 },
    { start: 20, end: 24 },
    { start: 40, end: 44 },
  ];

  it("stands on the last match that starts before the offset", () => {
    expect(matchIndexBefore(matches, 41)).toBe(2);
    expect(matchIndexBefore(matches, 40)).toBe(1);
    expect(matchIndexBefore(matches, 20)).toBe(0);
  });

  it("wraps to the last match from before the buffer", () => {
    // The strip opens standing before everything, so its FIRST "previous" is
    // the end of the article rather than the same hit its "next" would give.
    expect(matchIndexBefore(matches, -1)).toBe(2);
    expect(matchIndexFrom(matches, -1)).toBe(0);
  });

  it("wraps from the first match to the last", () => {
    expect(matchIndexBefore(matches, 4)).toBe(2);
  });

  it("has nothing to stand on in an empty list", () => {
    expect(matchIndexBefore([], 10)).toBe(-1);
  });
});

describe("applyFindReplace — one match", () => {
  const text = "Artifice, Artifice, Artifice";

  it("replaces the match the index names and nothing else", () => {
    const outcome = applyFindReplace(text, {
      query: "Artifice",
      replacement: "Embrion",
      options: PLAIN,
      index: 1,
    });
    expect(outcome.text).toBe("Artifice, Embrion, Artifice");
    expect(outcome.replaced).toBe(1);
  });

  it("says where the replacement landed in the NEW text", () => {
    const outcome = applyFindReplace(text, {
      query: "Artifice",
      replacement: "Embrion",
      options: PLAIN,
      index: 1,
    });
    expect(outcome.landed).toEqual({ start: 10, end: 17 });
    const { landed } = outcome;
    expect(landed === null ? "" : outcome.text.slice(landed.start, landed.end)).toBe("Embrion");
  });

  it("an index past the end changes nothing", () => {
    const outcome = applyFindReplace(text, {
      query: "Artifice",
      replacement: "Embrion",
      options: PLAIN,
      index: 7,
    });
    expect(outcome).toEqual({ text, replaced: 0, landed: null });
  });

  it("an empty replacement deletes the match and lands as an empty range", () => {
    const outcome = applyFindReplace("keep [[Artifice]] here", {
      query: "[[Artifice]] ",
      replacement: "",
      options: PLAIN,
      index: 0,
    });
    expect(outcome.text).toBe("keep here");
    expect(outcome.landed).toEqual({ start: 5, end: 5 });
  });

  it("an empty query is not a replacement of everything", () => {
    expect(applyFindReplace(text, { query: "", replacement: "x", options: PLAIN, index: 0 }))
      .toEqual({ text, replaced: 0, landed: null });
    expect(applyFindReplace(text, { query: "", replacement: "x", options: PLAIN, index: null }))
      .toEqual({ text, replaced: 0, landed: null });
  });
});

describe("applyFindReplace — replace all does not walk over its own output", () => {
  it("a replacement containing the query is written once per original match", () => {
    const outcome = applyFindReplace("cat cat cat", {
      query: "cat",
      replacement: "cats",
      options: PLAIN,
      index: null,
    });
    expect(outcome.text).toBe("cats cats cats");
    expect(outcome.replaced).toBe(3);
  });

  it("a replacement that grows the query still terminates and counts the originals", () => {
    const outcome = applyFindReplace("aaa", {
      query: "a",
      replacement: "aa",
      options: PLAIN,
      index: null,
    });
    expect(outcome.text).toBe("aaaaaa");
    expect(outcome.replaced).toBe(3);
  });

  it("a replacement that is the query wrapped in itself is copied through once", () => {
    const outcome = applyFindReplace("[[Moon]]", {
      query: "Moon",
      replacement: "Moon (Moon)",
      options: PLAIN,
      index: null,
    });
    expect(outcome.text).toBe("[[Moon (Moon)]]");
    expect(outcome.replaced).toBe(1);
  });

  it("replacing one at a time steps PAST the output rather than back into it", () => {
    // The panel's loop: replace the match it is standing on, then take the
    // first match at or after where the replacement ended.
    let text = "cat cat cat";
    let anchor = -1;
    const request = { query: "cat", replacement: "cats", options: PLAIN };
    for (let round = 0; round < 3; round += 1) {
      const index = matchIndexFrom(findMatches(text, request.query, request.options), anchor);
      const outcome = applyFindReplace(text, { ...request, index });
      expect(outcome.replaced).toBe(1);
      text = outcome.text;
      anchor = outcome.landed === null ? -1 : outcome.landed.end;
    }
    expect(text).toBe("cats cats cats");
    // Every hit that remains is one this loop already wrote; nothing was
    // replaced twice on the way.
    expect(findMatches(text, "cats", PLAIN)).toHaveLength(3);
  });

  it("honours the toggles", () => {
    expect(
      applyFindReplace("Titan titan", {
        query: "titan",
        replacement: "X",
        options: EXACT,
        index: null,
      }).text,
    ).toBe("Titan X");
    expect(
      applyFindReplace("Artifice Artifices", {
        query: "Artifice",
        replacement: "X",
        options: WORDS,
        index: null,
      }).text,
    ).toBe("X Artifices");
  });

  it("lands on the FIRST replacement, which is the one worth scrolling to", () => {
    const outcome = applyFindReplace("a, a, a", {
      query: "a",
      replacement: "bb",
      options: PLAIN,
      index: null,
    });
    expect(outcome.text).toBe("bb, bb, bb");
    expect(outcome.landed).toEqual({ start: 0, end: 2 });
  });

  it("leaves the buffer alone when there is nothing to replace", () => {
    const text = "nothing here";
    expect(
      applyFindReplace(text, { query: "Artifice", replacement: "X", options: PLAIN, index: null }),
    ).toEqual({ text, replaced: 0, landed: null });
  });

  it("replaces inside a template call, which the visual surface never shows", () => {
    // The point of searching the buffer: this text has no rendering to click.
    const text = "{{Infobox moon\n| name = Artifice\n}}\n\nArtifice is a moon.";
    const outcome = applyFindReplace(text, {
      query: "Artifice",
      replacement: "Embrion",
      options: PLAIN,
      index: null,
    });
    expect(outcome.replaced).toBe(2);
    expect(outcome.text).toBe("{{Infobox moon\n| name = Embrion\n}}\n\nEmbrion is a moon.");
  });
});

describe("matchContext", () => {
  const text = "The moon Artifice has a difficulty rating of S+, and Artifice is expensive.";

  it("cuts the buffer either side of the match", () => {
    const context = matchContext(text, { start: 9, end: 17 }, 9);
    expect(context.match).toBe("Artifice");
    expect(context.before).toBe("The moon ");
    expect(context.after).toBe(" has a di");
    expect(context.clippedBefore).toBe(false);
    expect(context.clippedAfter).toBe(true);
  });

  it("says which side was clipped, so the panel can print an ellipsis", () => {
    const context = matchContext(text, { start: 52, end: 60 }, 5);
    expect(context.clippedBefore).toBe(true);
    expect(context.clippedAfter).toBe(true);
  });

  it("collapses whitespace, so a match at the end of a paragraph still shows", () => {
    const context = matchContext("one\n\n  two\ttip", { start: 7, end: 10 }, 7);
    expect(context.match).toBe("two");
    expect(context.before).toBe("one ");
    expect(context.after).toBe(" tip");
  });

  it("a match at either end of the buffer is not clipped", () => {
    const context = matchContext("Artifice", { start: 0, end: 8 });
    expect(context).toEqual({
      before: "",
      match: "Artifice",
      after: "",
      clippedBefore: false,
      clippedAfter: false,
    });
  });
});

describe("seedQuery", () => {
  it("opens with the selected word", () => {
    expect(seedQuery("Artifice")).toBe("Artifice");
    expect(seedQuery("  Artifice  ")).toBe("Artifice");
  });

  it("opens empty for nothing, for a paragraph, and for a run of lines", () => {
    expect(seedQuery("")).toBe("");
    expect(seedQuery("   ")).toBe("");
    expect(seedQuery("first\nsecond")).toBe("");
    expect(seedQuery("x".repeat(121))).toBe("");
    expect(seedQuery("x".repeat(120))).toBe("x".repeat(120));
  });
});

/* ------------------------------------------------------------------ */
/* Buffer offset → block                                               */
/* ------------------------------------------------------------------ */

/** Every wikitext string the wiki ships, which is text no fixture author chose. */
const CORPUS: { name: string; wikitext: string }[] = [
  ...TEMPLATES.map((template) => ({
    name: `Template:${template.title}`,
    wikitext: template.wikitext,
  })),
  ...[...ARTICLES, ...MOON_ARTICLES, ...ENTITY_ARTICLES].flatMap((article) => [
    { name: article.title, wikitext: article.wikitext },
    ...article.translations.map((translation) => ({
      name: `${article.title} [${translation.locale}]`,
      wikitext: translation.wikitext,
    })),
  ]),
  ...HELP_PAGES.map((help) => ({ name: `Help:${help.title}`, wikitext: help.wikitext })),
];

describe("blockSpans", () => {
  it("has a corpus to run over", () => {
    expect(CORPUS.length).toBeGreaterThan(20);
  });

  it("tiles every real article end to end, in order, with no overlap", () => {
    for (const { name, wikitext } of CORPUS) {
      const spanList = blockSpans(wikitext);
      expect(spanList.length, name).toBeGreaterThan(0);
      let previousEnd = 0;
      for (const span of spanList) {
        expect(span.start, name).toBeGreaterThanOrEqual(previousEnd);
        expect(span.end, name).toBeGreaterThan(span.start);
        previousEnd = span.end;
      }
      expect(previousEnd, name).toBeLessThanOrEqual(wikitext.length);
    }
  });

  it("every span slices out exactly the block's own wikitext", () => {
    const text = "Intro line.\n\n== Layout ==\nA cave.\n\n* one\n* two\n\n{{Stub}}\n";
    expect(blockSpans(text).map((span) => text.slice(span.start, span.end))).toEqual([
      "Intro line.",
      "== Layout ==",
      "A cave.",
      "* one\n* two",
      "{{Stub}}",
    ]);
  });

  it("ids are the ones the surface writes into data-ve-id", () => {
    expect(blockSpans("one\n\ntwo\n").map((span) => span.id)).toEqual(["b0", "b1"]);
  });

  it("numbers the blocks in order, which is the key that survives an edit", () => {
    // The surface mints its own id for a block the author creates, so a
    // re-parse of the buffer disagrees about ids and never about order.
    const text = "one\n\n== Two ==\n\n----\n\n{{Stub}}\n";
    expect(blockSpans(text).map((span) => span.index)).toEqual([0, 1, 2, 3]);
  });

  it("counts the leading whitespace a document opens with", () => {
    const text = "\n\nfirst\n";
    expect(blockSpans(text)).toEqual([{ id: "b0", index: 0, start: 2, end: 7 }]);
  });

  it("refuses rather than answering approximately when the buffer holds CRLF", () => {
    // The parser folds CRLF and the buffer did not, so the arithmetic would be
    // one byte short per line. No spans means no scroll; wrong spans would mean
    // scrolling to the wrong paragraph and calling it the match.
    expect(blockSpans("one\r\n\r\ntwo\r\n")).toEqual([]);
    expect(blockSpans("one\n\ntwo\n")).toHaveLength(2);
  });

  it("an empty buffer has no blocks", () => {
    expect(blockSpans("")).toEqual([]);
  });
});

describe("blockSpanAt", () => {
  const text = "Intro line.\n\n== Layout ==\nA cave.\n";
  const spanList = blockSpans(text);

  it("finds the block an offset falls inside", () => {
    expect(blockSpanAt(spanList, 0)?.id).toBe("b0");
    expect(blockSpanAt(spanList, 10)?.id).toBe("b0");
    expect(blockSpanAt(spanList, 13)?.id).toBe("b1");
  });

  it("gives the preceding block for an offset in the gap between two", () => {
    // The blank line after "Intro line." was written as part of leaving it.
    expect(blockSpanAt(spanList, 11)?.id).toBe("b0");
    expect(blockSpanAt(spanList, 12)?.id).toBe("b0");
  });

  it("has no answer before the first block, or without spans", () => {
    expect(blockSpanAt(blockSpans("\n\nfirst\n"), 0)).toBeNull();
    expect(blockSpanAt([], 4)).toBeNull();
  });
});

describe("occurrenceInSpan", () => {
  const text = "Artifice and Artifice.\n\nArtifice again, and Artifice.\n";
  const spanList = blockSpans(text);
  const matches = findMatches(text, "Artifice", PLAIN);

  it("counts from the block's own start, not the buffer's", () => {
    expect(matches).toHaveLength(4);
    const second = spanList[1];
    // Match 2 is the first "Artifice" of the second paragraph.
    expect(occurrenceInSpan(matches, second, 2)).toBe(0);
    expect(occurrenceInSpan(matches, second, 3)).toBe(1);
  });

  it("counts the earlier matches of the first block normally", () => {
    const first = spanList[0];
    expect(occurrenceInSpan(matches, first, 0)).toBe(0);
    expect(occurrenceInSpan(matches, first, 1)).toBe(1);
  });

  it("an index past the list is not an error", () => {
    expect(occurrenceInSpan(matches, spanList[0], 99)).toBe(2);
  });
});
