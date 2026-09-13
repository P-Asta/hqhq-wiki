/**
 * Undoing an edit the browser never saw — docs/engine/visual-editor.md §12.
 *
 * Typing, the marks, the list commands and `insertHTML` all go through
 * `document.execCommand`, which puts them on the **browser's** undo stack:
 * `Ctrl+Z` walks them back, IME composition survives, and none of that is this
 * module's business. But four of this editor's edits are plain DOM surgery and
 * the browser knows nothing about them — moving a block (§3.1), dropping one
 * after a drag, a table operation (§3.2), and a paste that arrived as whole
 * blocks (§11). Before this module `Ctrl+Z` did nothing at all after any of
 * them, which with a *drag* on the page is no longer a footnote: a block
 * dropped in the wrong gap by a slipped pointer was an edit with no way back.
 *
 * ## Why a snapshot, and not an inverse operation
 *
 * Every one of those four edits is a **DOM move that rebuilds nothing**, which
 * is the whole reason §4 can promise a reordered page republishes
 * byte-for-byte. An undo written as "the opposite move" would have to know
 * that promise as well as the move did, in four places; a snapshot of the
 * surface's own markup knows it by construction — the elements come back
 * carrying the `data-ve-id`s and `data-ve-src`s they went in with, so the next
 * read still matches every block to the block it was parsed from and an
 * undone-and-redone page still publishes its original bytes.
 *
 * ## The window, which is the one thing to understand here
 *
 * **A structural undo is only offered while nothing has been typed since.**
 * The moment the author types, this stack is dropped and `Ctrl+Z` is the
 * browser's again.
 *
 * That is a deliberate refusal to guess. There are two undo stacks — the
 * browser's, which cannot be read, and this one — and no way to interleave
 * them: after "move a block, then type a word", nothing here can tell whether
 * the browser's next undo will take back the word or something older, so a
 * snapshot restored on top of it could resurrect text the author had just
 * removed. Dropping the stack instead is the same rule the input rules already
 * keep for their own one-step undo (`input-rules.ts`, "What the rules assume
 * about undo"), and it covers the case that actually happens: a drag lands
 * wrong, and `Ctrl+Z` immediately after puts it back.
 *
 * Everything here is pure — it sees two strings and a stack — so the policy is
 * tested without a browser. The surface owns the snapshots' contents
 * (visual-editor.tsx: `pushHistory`, `restoreSnapshot`).
 */

/** The surface as it stood, and where the caret was standing in it. */
export interface VeSnapshot {
  /** The contenteditable's `innerHTML`, with every `data-ve-id` in it. */
  html: string;
  /**
   * The `data-ve-id` of the block the caret was in, or null. Restoring puts
   * the caret back in that block — the block is the resolution a structural
   * edit works at, and an offset into markup that has moved would be a caret
   * in a different sentence.
   */
  block: string | null;
}

export interface VeHistoryState {
  /** Snapshots of what the surface looked like *before* each edit, oldest first. */
  past: readonly VeSnapshot[];
  /** Snapshots undone but not yet re-applied, oldest first. */
  future: readonly VeSnapshot[];
}

/**
 * How many structural edits back the stack reaches, and how much markup it may
 * hold while doing it.
 *
 * The count is generous because these edits are rare — nobody drags fifty
 * blocks in a row — and the byte budget is what stops a long article from
 * being held in memory fifty times over. The oldest snapshots go first, which
 * is also the order an author stops caring about them in.
 */
export const HISTORY_LIMIT = 50;
export const HISTORY_BYTES = 4_000_000;

export function emptyHistory(): VeHistoryState {
  return { past: [], future: [] };
}

/** Total markup a stack is holding — what {@link HISTORY_BYTES} caps. */
function weigh(snapshots: readonly VeSnapshot[]): number {
  let total = 0;
  for (const snapshot of snapshots) total += snapshot.html.length;
  return total;
}

/** Drop the oldest until the stack fits both caps. */
function trim(past: readonly VeSnapshot[]): readonly VeSnapshot[] {
  let kept = past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past;
  while (kept.length > 1 && weigh(kept) > HISTORY_BYTES) kept = kept.slice(1);
  return kept;
}

/**
 * Remember the state one structural edit is about to leave behind.
 *
 * The redo stack is cleared, because a new edit makes every undone one
 * unreachable — the branch it belonged to no longer exists. That is what every
 * undo stack does, and the alternative (keeping it) would offer a "redo" that
 * pastes an old document over the current one.
 */
export function recordEdit(state: VeHistoryState, before: VeSnapshot): VeHistoryState {
  return { past: trim([...state.past, before]), future: [] };
}

/**
 * The state to restore, and the stack that is left — or null when there is
 * nothing to undo, which is the answer that leaves `Ctrl+Z` to the browser.
 *
 * `current` is the surface as it stands *now*, and it goes onto the redo stack
 * rather than being thrown away: without it a redo would have nothing to
 * re-apply, since the snapshots only ever describe "before".
 */
export function undoEdit(
  state: VeHistoryState,
  current: VeSnapshot,
): { state: VeHistoryState; restore: VeSnapshot } | null {
  const restore = state.past[state.past.length - 1];
  if (restore === undefined) return null;
  return {
    state: { past: state.past.slice(0, -1), future: [...state.future, current] },
    restore,
  };
}

/** The same, the other way. */
export function redoEdit(
  state: VeHistoryState,
  current: VeSnapshot,
): { state: VeHistoryState; restore: VeSnapshot } | null {
  const restore = state.future[state.future.length - 1];
  if (restore === undefined) return null;
  return {
    state: { past: trim([...state.past, current]), future: state.future.slice(0, -1) },
    restore,
  };
}

/**
 * The stack, emptied.
 *
 * **Where the surface calls this is the window's definition**, and there is
 * exactly one funnel for it rather than a list of keys: every edit the
 * *browser* records goes through this editor's `exec()` wrapper (the marks,
 * the lists, the indents, `insertText`, `insertHTML`) or arrives as a plain
 * `input` event (typing, IME composition, a drop of text, a paste taken from
 * the context menu). Both clear the stack; `exec("undo")` and `exec("redo")`
 * do not, since those consume a stack rather than invalidating one.
 *
 * Asking the funnel rather than the keyboard is what keeps the rule honest on
 * a layout nobody here has tried: it is about what reached the document, not
 * about which keycap was pressed.
 */
export function forgetEdits(): VeHistoryState {
  return emptyHistory();
}
