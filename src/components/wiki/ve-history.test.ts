/**
 * The structural undo stack's policy (ve-history.ts, visual-editor.md §12).
 *
 * What is asserted here is the arithmetic — what is on each stack after each
 * call, and what falls off the end when the caps are reached. The *window* the
 * module's header is really about (a structural undo is only offered while
 * nothing has been typed since) is not policy this file can see: it is where
 * the surface calls `forgetEdits`, and `visual-editor.test.ts` pins that.
 */

import { describe, expect, it } from "vitest";

import {
  HISTORY_LIMIT,
  emptyHistory,
  forgetEdits,
  recordEdit,
  redoEdit,
  undoEdit,
  type VeSnapshot,
} from "./ve-history";

function shot(html: string, block: string | null = null): VeSnapshot {
  return { html, block };
}

describe("the structural undo stack", () => {
  it("has nothing to undo when nothing has been recorded", () => {
    // The answer that leaves Ctrl+Z to the browser, which is the state the
    // surface is in for all of an ordinary typing session.
    expect(undoEdit(emptyHistory(), shot("<p>a</p>"))).toBeNull();
    expect(redoEdit(emptyHistory(), shot("<p>a</p>"))).toBeNull();
  });

  it("gives back what the surface looked like before the edit", () => {
    const state = recordEdit(emptyHistory(), shot("<p>a</p><p>b</p>", "b1"));
    const undone = undoEdit(state, shot("<p>b</p><p>a</p>", "b1"));
    expect(undone?.restore).toEqual({ html: "<p>a</p><p>b</p>", block: "b1" });
  });

  it("puts the state it left onto the redo stack", () => {
    // Without that, a redo would have nothing to re-apply: the snapshots only
    // ever describe "before".
    const state = recordEdit(emptyHistory(), shot("<p>a</p>"));
    const undone = undoEdit(state, shot("<p>b</p>"));
    if (undone === null) throw new Error("expected an undo");
    expect(undone.state.past).toEqual([]);
    const redone = redoEdit(undone.state, shot("<p>a</p>"));
    expect(redone?.restore).toEqual(shot("<p>b</p>"));
    expect(redone?.state.future).toEqual([]);
  });

  it("walks a run of edits back one at a time, newest first", () => {
    let state = recordEdit(emptyHistory(), shot("1"));
    state = recordEdit(state, shot("2"));
    state = recordEdit(state, shot("3"));
    const first = undoEdit(state, shot("4"));
    expect(first?.restore.html).toBe("3");
    const second = undoEdit(first?.state ?? state, shot("3"));
    expect(second?.restore.html).toBe("2");
  });

  it("makes an undone edit unreachable once a new one is made", () => {
    // Every undo stack does this, and the alternative offers a "redo" that
    // pastes a document from a branch that no longer exists over this one.
    const state = recordEdit(emptyHistory(), shot("1"));
    const undone = undoEdit(state, shot("2"));
    if (undone === null) throw new Error("expected an undo");
    expect(undone.state.future.length).toBe(1);
    const next = recordEdit(undone.state, shot("3"));
    expect(next.future).toEqual([]);
  });

  it("reaches back a bounded number of edits", () => {
    let state = emptyHistory();
    for (let index = 0; index < HISTORY_LIMIT + 10; index += 1) {
      state = recordEdit(state, shot(`snapshot ${index}`));
    }
    expect(state.past.length).toBe(HISTORY_LIMIT);
    // The oldest went first, which is the order an author stops caring in.
    expect(state.past[0].html).toBe(`snapshot ${10}`);
  });

  it("drops the oldest rather than holding a long article fifty times over", () => {
    const big = "x".repeat(1_500_000);
    let state = emptyHistory();
    for (let index = 0; index < 5; index += 1) state = recordEdit(state, shot(big + index));
    // The byte cap bites long before the count does, and one snapshot always
    // survives: a stack that emptied itself would be an undo that does nothing.
    expect(state.past.length).toBeGreaterThanOrEqual(1);
    expect(state.past.length).toBeLessThan(5);
    expect(state.past[state.past.length - 1].html.endsWith("4")).toBe(true);
  });

  it("is emptied by anything that reaches the browser's own stack", () => {
    const state = recordEdit(emptyHistory(), shot("1"));
    expect(state.past.length).toBe(1);
    expect(forgetEdits()).toEqual({ past: [], future: [] });
  });

  it("remembers which block the caret was in, and nothing finer", () => {
    // A structural edit works at block resolution; an offset into markup that
    // has since moved would put the caret in a different sentence.
    const state = recordEdit(emptyHistory(), shot("<p data-ve-id='b3'>a</p>", "b3"));
    expect(undoEdit(state, shot("<p></p>"))?.restore.block).toBe("b3");
  });
});
