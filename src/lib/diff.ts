/**
 * Dependency-free revision diff — line-level alignment with word-level
 * refinement inside changed line pairs.
 *
 * Used by the /{locale}/diff view (side-by-side + inline word highlights,
 * routes.md) and by the editor's 409 conflict UI (theirs vs yours), so this
 * module is isomorphic: no "server-only", no imports beyond the language.
 *
 * Algorithm: common prefix/suffix trim + Myers O(ND) greedy diff on the
 * middle. A pathological middle (edit distance beyond MAX_EDIT_DISTANCE) is
 * degraded to a whole-block replace instead of burning quadratic memory —
 * still a correct diff, just a coarse one.
 */

export type DiffSegmentKind = "equal" | "added" | "removed";

/** One run of text inside a line (word-level granularity). */
export interface DiffSegment {
  kind: DiffSegmentKind;
  text: string;
}

export type DiffRowKind = "context" | "added" | "removed" | "changed";

/** One side of a side-by-side row. */
export interface DiffSide {
  /** 1-based line number in that side's document. */
  lineNo: number;
  segments: DiffSegment[];
}

/**
 * One rendered row of the side-by-side view.
 * - context: both sides, identical text;
 * - removed: left only;  added: right only;
 * - changed: both sides, word-diffed against each other.
 */
export interface DiffRow {
  kind: DiffRowKind;
  left: DiffSide | null;
  right: DiffSide | null;
}

/** Beyond this Myers depth the middle is treated as a full replace. */
const MAX_EDIT_DISTANCE = 2000;

/* ------------------------------------------------------------------ */
/* Generic sequence diff (Myers greedy, with trim + cutoff)            */
/* ------------------------------------------------------------------ */

type SeqOpKind = "equal" | "add" | "del";

interface SeqOp {
  kind: SeqOpKind;
  /** Items from `a` (equal/del) or `b` (add). */
  items: string[];
}

function pushOp(ops: SeqOp[], kind: SeqOpKind, items: string[]): void {
  if (items.length === 0) return;
  const last = ops[ops.length - 1];
  if (last && last.kind === kind) last.items.push(...items);
  else ops.push({ kind, items: [...items] });
}

/** Myers greedy diff over the (already trimmed) middle of two sequences. */
function myers(a: string[], b: string[]): SeqOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return [{ kind: "add", items: [...b] }];
  if (m === 0) return [{ kind: "del", items: [...a] }];

  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max;
  // v[k + offset] = furthest x on diagonal k.
  let v = new Array<number>(2 * max + 2).fill(0);
  const trace: number[][] = [];

  let found = false;
  outer: for (let d = 0; d <= max; d++) {
    trace.push([...v]);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        x = v[k + 1 + offset]; // move down (insert from b)
      } else {
        x = v[k - 1 + offset] + 1; // move right (delete from a)
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) {
        found = true;
        break outer;
      }
    }
  }

  if (!found) {
    // Cutoff hit: coarse fallback — replace everything.
    return [
      { kind: "del", items: [...a] },
      { kind: "add", items: [...b] },
    ];
  }

  // Backtrack the trace into ops (built in reverse, then flipped).
  const reversed: { kind: SeqOpKind; item: string }[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; x > 0 || y > 0; d--) {
    v = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
      prevK = k + 1; // came from an insert
    } else {
      prevK = k - 1; // came from a delete
    }
    const prevX = d === 0 ? 0 : v[prevK + offset];
    const prevY = prevX - prevK;

    // Snake (equal run) back to the previous point.
    while (x > prevX && y > prevY) {
      reversed.push({ kind: "equal", item: a[x - 1] });
      x--;
      y--;
    }
    if (d === 0) break;
    if (x === prevX) {
      reversed.push({ kind: "add", item: b[y - 1] });
      y = prevY;
    } else {
      reversed.push({ kind: "del", item: a[x - 1] });
      x = prevX;
    }
  }

  const ops: SeqOp[] = [];
  for (let i = reversed.length - 1; i >= 0; i--) {
    pushOp(ops, reversed[i].kind, [reversed[i].item]);
  }
  return ops;
}

/** Diff two token sequences: trim common ends, Myers the middle. */
function diffSequences(a: string[], b: string[]): SeqOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const ops: SeqOp[] = [];
  pushOp(ops, "equal", a.slice(0, start));
  for (const op of myers(a.slice(start, endA), b.slice(start, endB))) {
    pushOp(ops, op.kind, op.items);
  }
  pushOp(ops, "equal", a.slice(endA));
  return ops;
}

/* ------------------------------------------------------------------ */
/* Word diff (inline, within a line or a whole short text)             */
/* ------------------------------------------------------------------ */

/** Words and whitespace runs, both kept, so joins reproduce the input. */
function tokenizeWords(text: string): string[] {
  return text.split(/(\s+)/u).filter((t) => t !== "");
}

const SEGMENT_KIND: Record<SeqOpKind, DiffSegmentKind> = {
  equal: "equal",
  add: "added",
  del: "removed",
};

/**
 * Word-level diff of two texts as a flat segment list: `removed` segments
 * carry text only in `a`, `added` only in `b`, `equal` in both. Adjacent
 * segments always have distinct kinds; empty inputs yield no segments.
 */
export function diffWords(a: string, b: string): DiffSegment[] {
  const segments: DiffSegment[] = [];
  for (const op of diffSequences(tokenizeWords(a), tokenizeWords(b))) {
    const kind = SEGMENT_KIND[op.kind];
    const text = op.items.join("");
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) last.text += text;
    else segments.push({ kind, text });
  }
  return segments;
}

/* ------------------------------------------------------------------ */
/* Line diff (side-by-side rows)                                       */
/* ------------------------------------------------------------------ */

/** "" has zero lines, so creating a page diffs as pure additions. */
function splitLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

function sideOf(lineNo: number, segments: DiffSegment[]): DiffSide {
  return { lineNo, segments };
}

function wholeLine(kind: DiffSegmentKind, text: string): DiffSegment[] {
  return [{ kind, text }];
}

/**
 * Side-by-side line diff. A run of removed lines immediately followed by a
 * run of added lines is paired positionally into `changed` rows whose sides
 * are word-diffed against each other (left keeps equal+removed segments,
 * right keeps equal+added); leftover lines stay pure removed/added rows.
 */
export function diffLines(a: string, b: string): DiffRow[] {
  const ops = diffSequences(splitLines(a), splitLines(b));
  const rows: DiffRow[] = [];
  let leftNo = 0;
  let rightNo = 0;

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.kind === "equal") {
      for (const line of op.items) {
        leftNo++;
        rightNo++;
        rows.push({
          kind: "context",
          left: sideOf(leftNo, wholeLine("equal", line)),
          right: sideOf(rightNo, wholeLine("equal", line)),
        });
      }
      continue;
    }

    if (op.kind === "del" && ops[i + 1]?.kind === "add") {
      const removed = op.items;
      const added = ops[i + 1].items;
      i++; // consume the add run
      const paired = Math.min(removed.length, added.length);
      for (let j = 0; j < paired; j++) {
        leftNo++;
        rightNo++;
        const segments = diffWords(removed[j], added[j]);
        rows.push({
          kind: "changed",
          left: sideOf(leftNo, segments.filter((s) => s.kind !== "added")),
          right: sideOf(rightNo, segments.filter((s) => s.kind !== "removed")),
        });
      }
      for (let j = paired; j < removed.length; j++) {
        leftNo++;
        rows.push({
          kind: "removed",
          left: sideOf(leftNo, wholeLine("removed", removed[j])),
          right: null,
        });
      }
      for (let j = paired; j < added.length; j++) {
        rightNo++;
        rows.push({
          kind: "added",
          left: null,
          right: sideOf(rightNo, wholeLine("added", added[j])),
        });
      }
      continue;
    }

    if (op.kind === "del") {
      for (const line of op.items) {
        leftNo++;
        rows.push({
          kind: "removed",
          left: sideOf(leftNo, wholeLine("removed", line)),
          right: null,
        });
      }
    } else {
      for (const line of op.items) {
        rightNo++;
        rows.push({
          kind: "added",
          left: null,
          right: sideOf(rightNo, wholeLine("added", line)),
        });
      }
    }
  }

  return rows;
}

/** True when any row differs (drives the "identical revisions" empty state). */
export function hasChanges(rows: DiffRow[]): boolean {
  return rows.some((row) => row.kind !== "context");
}
