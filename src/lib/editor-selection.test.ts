/**
 * Selection-surgery tests for the source editor's toolbar.
 *
 * Everything here is a pure `{ value, start, end }` → `{ value, start, end }`
 * transform, so the cases that matter are the boundaries: an empty selection,
 * a selection that already carries the markers, selections at offset 0 and at
 * the end of the buffer, multi-line selections, and blank lines inside them.
 */

import { describe, expect, it } from "vitest";

import {
  applyCommand,
  insertAtCaret,
  lineEndAt,
  lineStartAt,
  prefixLines,
  setHeadingLevel,
  unlinkSelection,
  wrapSelection,
  type SelectionState,
} from "./editor-selection";

/**
 * Build a state from a string using the sentinels « » around the selection,
 * or ‸ for a bare caret. Wikitext brackets are far too common in these cases
 * for `[`/`]` to be readable, so the sentinels are characters that carry no
 * meaning in wikitext.
 */
function at(marked: string): SelectionState {
  const caret = marked.indexOf("‸");
  if (caret !== -1) {
    return { value: marked.replace("‸", ""), start: caret, end: caret };
  }
  const start = marked.indexOf("«");
  const end = marked.indexOf("»") - 1;
  return { value: marked.replace("«", "").replace("»", ""), start, end };
}

/** Render a state back into the sentinel notation for readable assertions. */
function show(state: SelectionState): string {
  const { value, start, end } = state;
  if (start === end) return value.slice(0, start) + "‸" + value.slice(start);
  return value.slice(0, start) + "«" + value.slice(start, end) + "»" + value.slice(end);
}

const BOLD = { before: "'''", after: "'''", placeholder: "bold", toggle: true };
const LINK = { before: "[[", after: "]]", placeholder: "Page name", toggle: true };

describe("lineStartAt / lineEndAt", () => {
  it("finds the bounds of the line a caret sits on", () => {
    const src = "one\ntwo\nthree";
    expect(lineStartAt(src, 0)).toBe(0);
    expect(lineEndAt(src, 0)).toBe(3);
    expect(lineStartAt(src, 5)).toBe(4);
    expect(lineEndAt(src, 5)).toBe(7);
  });

  it("treats a caret just past a newline as starting the next line", () => {
    expect(lineStartAt("a\nb", 2)).toBe(2);
    expect(lineEndAt("a\nb", 3)).toBe(3);
  });

  it("handles the empty buffer", () => {
    expect(lineStartAt("", 0)).toBe(0);
    expect(lineEndAt("", 0)).toBe(0);
  });
});

describe("wrapSelection", () => {
  it("wraps a selection and keeps the inner text selected", () => {
    expect(show(wrapSelection(at("x«abc»y"), BOLD))).toBe("x'''«abc»'''y");
  });

  it("inserts the placeholder selected when nothing is selected", () => {
    expect(show(wrapSelection(at("x‸y"), BOLD))).toBe("x'''«bold»'''y");
  });

  it("leaves the caret between the markers when there is no placeholder", () => {
    expect(show(wrapSelection(at("‸"), { before: "<u>", after: "</u>" }))).toBe("<u>‸</u>");
  });

  it("works at offset 0 and at the end of the buffer", () => {
    expect(show(wrapSelection(at("«a»bc"), BOLD))).toBe("'''«a»'''bc");
    expect(show(wrapSelection(at("bc«a»"), BOLD))).toBe("bc'''«a»'''");
  });

  it("toggles off when the selection sits inside existing markers", () => {
    expect(show(wrapSelection(at("x'''«abc»'''y"), BOLD))).toBe("x«abc»y");
  });

  it("toggles off when the selection spans the markers", () => {
    expect(show(wrapSelection(at("x«'''abc'''»y"), BOLD))).toBe("x«abc»y");
  });

  it("does not toggle when only one side carries the marker", () => {
    expect(show(wrapSelection(at("x'''«abc»y"), BOLD))).toBe("x''''''«abc»'''y");
  });

  it("does not toggle a spec that did not ask for it", () => {
    const spec = { before: "''", after: "''" };
    expect(show(wrapSelection(at("«''a''»"), spec))).toBe("''«''a''»''");
  });

  it("wraps a multi-line selection as one span", () => {
    expect(show(wrapSelection(at("«a\nb»"), LINK))).toBe("[[«a\nb»]]");
  });

  it("block snippets open their own line and close it", () => {
    const table = { before: "{|\n| ", after: "\n|}", placeholder: "cell", block: true };
    expect(show(wrapSelection(at("x‸y"), table))).toBe("x\n{|\n| «cell»\n|}\ny");
  });

  it("block snippets add no newline when the caret is already alone on a line", () => {
    const table = { before: "{|\n", after: "\n|}", block: true };
    expect(show(wrapSelection(at("a\n‸\nb"), table))).toBe("a\n{|\n‸\n|}\nb");
  });

  it("clamps and orders a reversed or out-of-range selection", () => {
    expect(show(wrapSelection({ value: "abc", start: 3, end: 1 }, BOLD))).toBe("a'''«bc»'''");
    expect(show(wrapSelection({ value: "ab", start: 99, end: 99 }, BOLD))).toBe("ab'''«bold»'''");
  });
});

describe("prefixLines", () => {
  it("prefixes every line the selection touches", () => {
    expect(prefixLines(at("«a\nb»"), "* ").value).toBe("* a\n* b");
  });

  it("prefixes the caret's line when nothing is selected", () => {
    expect(prefixLines(at("a\nb‸b\nc"), "# ").value).toBe("a\n# bb\nc");
  });

  it("expands a partial selection out to whole lines", () => {
    expect(prefixLines({ value: "one\ntwo", start: 1, end: 5 }, "* ").value).toBe("* one\n* two");
  });

  it("removes the marker when every non-blank line already has it", () => {
    expect(prefixLines(at("«* a\n* b»"), "* ").value).toBe("a\nb");
  });

  it("adds the marker when only some lines have it", () => {
    expect(prefixLines(at("«* a\nb»"), "* ").value).toBe("* * a\n* b");
  });

  it("leaves blank lines inside the selection untouched", () => {
    expect(prefixLines(at("«a\n\nb»"), "* ").value).toBe("* a\n\n* b");
  });

  it("prefixes an empty buffer so a fresh list can be started", () => {
    expect(show(prefixLines(at("‸"), "* "))).toBe("«* »");
  });

  it("supports the indent marker", () => {
    expect(prefixLines(at("a‸"), ":").value).toBe(":a");
  });
});

describe("setHeadingLevel", () => {
  it("turns a plain line into a heading", () => {
    expect(setHeadingLevel(at("Int‸ro"), 2).value).toBe("== Intro ==");
  });

  it("replaces an existing level rather than nesting", () => {
    expect(setHeadingLevel(at("== In‸tro =="), 4).value).toBe("==== Intro ====");
    expect(setHeadingLevel(at("===== D‸eep ====="), 2).value).toBe("== Deep ==");
  });

  it("strips the markers at level 0", () => {
    expect(setHeadingLevel(at("=== A‸B ==="), 0).value).toBe("AB");
  });

  it("retitles every line of a multi-line selection", () => {
    expect(setHeadingLevel(at("«a\nb»"), 3).value).toBe("=== a ===\n=== b ===");
  });

  it("produces an empty heading a caret can be typed into", () => {
    expect(setHeadingLevel(at("‸"), 2).value).toBe("==  ==");
  });

  it("leaves surrounding lines alone", () => {
    expect(setHeadingLevel(at("keep\nti‸tle\nkeep"), 2).value).toBe("keep\n== title ==\nkeep");
  });
});

describe("unlinkSelection", () => {
  it("reduces a piped internal link to its label", () => {
    expect(unlinkSelection(at("«[[Moons|the moons]]»")).value).toBe("the moons");
  });

  it("reduces a bare internal link to its target", () => {
    expect(unlinkSelection(at("«x [[Moons]] y»")).value).toBe("x Moons y");
  });

  it("reduces an external link to its label, or to its url when unlabelled", () => {
    expect(unlinkSelection(at("«[https://a.example/b Guide]»")).value).toBe("Guide");
    expect(unlinkSelection(at("«[https://a.example/b]»")).value).toBe("https://a.example/b");
  });

  it("unlinks the whole line when nothing is selected", () => {
    expect(unlinkSelection(at("a [[B]] c‸\nkeep [[D]]")).value).toBe("a B c\nkeep [[D]]");
  });

  it("leaves an unlinked selection untouched", () => {
    expect(unlinkSelection(at("«plain text»")).value).toBe("plain text");
  });

  it("keeps a category sort key as the surviving text", () => {
    expect(unlinkSelection(at("«[[Category:Moons|68]]»")).value).toBe("68");
  });
});

describe("insertAtCaret", () => {
  it("inserts at the caret and leaves the caret after the text", () => {
    expect(show(insertAtCaret(at("a‸b"), "—"))).toBe("a—‸b");
  });

  it("replaces the selection", () => {
    expect(show(insertAtCaret(at("a«XY»b"), "×"))).toBe("a×‸b");
  });

  it("appends at the end of the buffer", () => {
    expect(show(insertAtCaret(at("ab‸"), "≤"))).toBe("ab≤‸");
  });
});

describe("applyCommand", () => {
  it("dispatches every command kind", () => {
    expect(applyCommand(at("‸"), { kind: "wrap", before: "''", after: "''" }).value).toBe("''''");
    expect(applyCommand(at("a‸"), { kind: "prefix", marker: "* " }).value).toBe("* a");
    expect(applyCommand(at("a‸"), { kind: "heading", level: 2 }).value).toBe("== a ==");
    expect(applyCommand(at("«[[A]]»"), { kind: "unlink" }).value).toBe("A");
    expect(applyCommand(at("‸"), { kind: "insert", text: "×" }).value).toBe("×");
  });

  it("leaves the buffer alone for a no-op unlink", () => {
    const state = at("plain‸");
    expect(applyCommand(state, { kind: "unlink" }).value).toBe(state.value);
  });
});
