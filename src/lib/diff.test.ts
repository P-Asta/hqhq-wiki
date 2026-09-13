import { describe, expect, it } from "vitest";

import { diffLines, diffWords, hasChanges, type DiffRow, type DiffSegment } from "./diff";

/** Rebuild one side's text from rows (round-trip check). */
function rebuild(rows: DiffRow[], side: "left" | "right"): string {
  return rows
    .filter((row) => row[side] !== null)
    .map((row) => row[side]!.segments.map((s) => s.text).join(""))
    .join("\n");
}

function joined(segments: DiffSegment[], kind: DiffSegment["kind"]): string {
  return segments
    .filter((s) => s.kind === kind)
    .map((s) => s.text)
    .join("");
}

describe("diffWords", () => {
  it("returns a single equal segment for identical text", () => {
    expect(diffWords("same text here", "same text here")).toEqual([
      { kind: "equal", text: "same text here" },
    ]);
  });

  it("returns no segments for two empty strings", () => {
    expect(diffWords("", "")).toEqual([]);
  });

  it("marks everything added when the old text is empty", () => {
    expect(diffWords("", "brand new")).toEqual([{ kind: "added", text: "brand new" }]);
  });

  it("marks everything removed when the new text is empty", () => {
    expect(diffWords("all gone", "")).toEqual([{ kind: "removed", text: "all gone" }]);
  });

  it("isolates a single changed word", () => {
    const segments = diffWords("The quota is 130 credits.", "The quota is 180 credits.");
    expect(joined(segments, "removed")).toBe("130");
    expect(joined(segments, "added")).toBe("180");
    expect(joined(segments, "equal")).toContain("The quota is");
  });

  it("detects a pure insertion in the middle", () => {
    const segments = diffWords("sell at the Company", "sell it at the Company");
    expect(joined(segments, "removed")).toBe("");
    expect(joined(segments, "added").trim()).toBe("it");
  });

  it("never emits two adjacent segments of the same kind", () => {
    const segments = diffWords("a b c d e", "a X c Y e");
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i].kind).not.toBe(segments[i - 1].kind);
    }
  });

  it("treats whitespace-only changes as changes", () => {
    const segments = diffWords("a b", "a  b");
    expect(segments.some((s) => s.kind !== "equal")).toBe(true);
  });

  it("handles unicode (Korean) words", () => {
    const segments = diffWords("기본 할당량은 130입니다", "기본 할당량은 180입니다");
    expect(joined(segments, "removed")).toBe("130입니다");
    expect(joined(segments, "added")).toBe("180입니다");
  });

  it("round-trips both sides through the segment list", () => {
    const a = "one two three four";
    const b = "zero two 3 four five";
    const segments = diffWords(a, b);
    const left = segments
      .filter((s) => s.kind !== "added")
      .map((s) => s.text)
      .join("");
    const right = segments
      .filter((s) => s.kind !== "removed")
      .map((s) => s.text)
      .join("");
    expect(left).toBe(a);
    expect(right).toBe(b);
  });
});

describe("diffLines", () => {
  it("yields only context rows for identical documents", () => {
    const text = "line one\nline two\nline three";
    const rows = diffLines(text, text);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.kind === "context")).toBe(true);
    expect(hasChanges(rows)).toBe(false);
  });

  it("treats page creation (empty old text) as pure additions", () => {
    const rows = diffLines("", "first\nsecond");
    expect(rows.map((r) => r.kind)).toEqual(["added", "added"]);
    expect(rows[0].left).toBeNull();
    expect(rows[0].right?.lineNo).toBe(1);
    expect(rows[1].right?.lineNo).toBe(2);
  });

  it("treats blanking (empty new text) as pure removals", () => {
    const rows = diffLines("first\nsecond", "");
    expect(rows.map((r) => r.kind)).toEqual(["removed", "removed"]);
    expect(rows.every((r) => r.right === null)).toBe(true);
  });

  it("reports an inserted line without touching its neighbours", () => {
    const rows = diffLines("a\nc", "a\nb\nc");
    expect(rows.map((r) => r.kind)).toEqual(["context", "added", "context"]);
    expect(rows[1].right?.segments).toEqual([{ kind: "added", text: "b" }]);
    // Line numbers advance independently per side.
    expect(rows[2].left?.lineNo).toBe(2);
    expect(rows[2].right?.lineNo).toBe(3);
  });

  it("reports a deleted line", () => {
    const rows = diffLines("a\nb\nc", "a\nc");
    expect(rows.map((r) => r.kind)).toEqual(["context", "removed", "context"]);
    expect(rows[1].left?.segments).toEqual([{ kind: "removed", text: "b" }]);
  });

  it("pairs a changed line and word-diffs it inline", () => {
    const rows = diffLines("intro\nThe quota is 130.\noutro", "intro\nThe quota is 180.\noutro");
    expect(rows.map((r) => r.kind)).toEqual(["context", "changed", "context"]);
    const changed = rows[1];
    expect(joined(changed.left!.segments, "removed")).toBe("130.");
    expect(joined(changed.right!.segments, "added")).toBe("180.");
    expect(changed.left!.segments.some((s) => s.kind === "added")).toBe(false);
    expect(changed.right!.segments.some((s) => s.kind === "removed")).toBe(false);
  });

  it("pairs positionally and spills extra lines as pure adds", () => {
    const rows = diffLines("old line", "new line\nsecond new line");
    expect(rows.map((r) => r.kind)).toEqual(["changed", "added"]);
    expect(rows[1].right?.lineNo).toBe(2);
  });

  it("handles multiple separated hunks", () => {
    const rows = diffLines("a\nb\nc\nd\ne", "a\nB\nc\nd\nE");
    expect(rows.map((r) => r.kind)).toEqual([
      "context",
      "changed",
      "context",
      "context",
      "changed",
    ]);
    expect(hasChanges(rows)).toBe(true);
  });

  it("keeps trailing-newline differences visible", () => {
    const rows = diffLines("a", "a\n");
    // "a\n" splits into ["a", ""] — the empty final line is an addition.
    expect(rows.map((r) => r.kind)).toEqual(["context", "added"]);
    expect(rows[1].right?.segments.map((s) => s.text).join("")).toBe("");
  });

  it("round-trips both documents through the rows", () => {
    const a = "alpha\nbeta\ngamma\ndelta";
    const b = "alpha\nbeta 2\ngamma\nepsilon\ndelta";
    const rows = diffLines(a, b);
    expect(rebuild(rows, "left")).toBe(a);
    expect(rebuild(rows, "right")).toBe(b);
  });

  it("survives completely disjoint documents (cutoff fallback path)", () => {
    const a = Array.from({ length: 50 }, (_, i) => `left ${i}`).join("\n");
    const b = Array.from({ length: 60 }, (_, i) => `right ${i}`).join("\n");
    const rows = diffLines(a, b);
    expect(rebuild(rows, "left")).toBe(a);
    expect(rebuild(rows, "right")).toBe(b);
    expect(hasChanges(rows)).toBe(true);
  });

  it("aligns long documents with a small change efficiently and correctly", () => {
    const base = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    const edited = [...base];
    edited[250] = "line 250 EDITED";
    const rows = diffLines(base.join("\n"), edited.join("\n"));
    expect(rows.filter((r) => r.kind !== "context")).toHaveLength(1);
    expect(rows[250].kind).toBe("changed");
    expect(rows[250].left?.lineNo).toBe(251);
  });

  it("returns an empty row list for two empty documents", () => {
    expect(diffLines("", "")).toEqual([]);
    expect(hasChanges([])).toBe(false);
  });
});
