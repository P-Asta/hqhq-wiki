/**
 * The protocol between the editor's two toolbars and the two editing
 * surfaces (docs/engine/visual-editor.md §1).
 *
 * Toolbars own no buffer and no selection: a button emits one action and the
 * surface that owns the caret applies it. That is the same split the source
 * editor already used with `EditorCommand` (src/lib/editor-selection.ts) — the
 * source toolbar still speaks that language, and this module adds the parts
 * that are not selection surgery (undo, the rail toggle, the dialogs) plus the
 * visual surface's own vocabulary.
 *
 * Wikitext snippets travel inside these actions as raw strings because
 * wikitext is not localized; only the button's accessible name comes from the
 * dictionary.
 */

import type { EditorCommand } from "@/lib/editor-selection";
import type { VeMark } from "@/lib/visual-editor/model";

/* ------------------------------------------------------------------ */
/* Shared                                                              */
/* ------------------------------------------------------------------ */

/** The two interchangeable modes behind Fandom's mode pill. */
export type EditorMode = "visual" | "source";

/**
 * Chrome actions neither surface owns — they belong to the editor island, and
 * both toolbars can raise them.
 */
export type EditorChromeAction =
  | { kind: "undo" }
  | { kind: "redo" }
  /** Opens the syntax-help drawer ("Read the user guide"). */
  | { kind: "help" }
  /** Toggles the page-tools rail (the source toolbar's hamburger). */
  | { kind: "toggleRail" }
  /** Opens the link dialog for the current selection. */
  | { kind: "link" }
  /**
   * Opens the media picker / file snippet flow.
   *
   * `file` is a picture the author **dropped or pasted onto the surface**
   * (§15). The dialog opens already uploading it and the rest of §5.2's flow
   * is unchanged, which is the point: one uploader, one validation, one set of
   * placement controls. The surface never uploads anything itself.
   */
  | { kind: "media"; file?: File }
  /**
   * Opens the template dialog (§5.1) — search, then a parameter form. Both
   * toolbars raise it instead of inserting braces, which is the whole point of
   * Fandom's template flow.
   *
   * `name` skips the search step and opens the form on that template, which is
   * what a row of the `{{` mention panel means (§13): the author has already
   * named the template, and asking them to name it again in a dialog would be
   * the one step the panel exists to remove. Braces are still never typed —
   * the name becomes the dialog's `initialSource`, not the buffer's bytes.
   */
  | { kind: "template"; name?: string }
  /**
   * Opens the version-scope dialog (§5.3). Both toolbars raise it instead of
   * dropping a tag skeleton, so an author picks versions rather than spelling a
   * range into a tag name.
   */
  | { kind: "versions" };

/* ------------------------------------------------------------------ */
/* Visual surface                                                      */
/* ------------------------------------------------------------------ */

/** What `NORMAL TEXT ▾` can turn the current block into. */
export type VeBlockFormat = "paragraph" | "h2" | "h3" | "h4" | "h5" | "pre";

/**
 * The five things that can be done to a *whole block* (visual-editor.md §3.1,
 * §14) — the gutter grip's menu, the right-click menu's second half, and the
 * slash menu's contextual rows are three roads to this one union.
 *
 * It lives here rather than in `ve-block-handle.tsx` (which named it first)
 * because it is now part of `VisualAction`: a row of the slash menu emits it
 * like any other, and a type owned by one of its three consumers would make
 * that consumer an import of the other two.
 *
 * Like `VeTableOp` it is *positional* — "the block" is the one the caret is in,
 * or the one a pointer was over, and only the surface knows which.
 */
export type VeBlockCommand =
  | { kind: "insertBelow" }
  | { kind: "duplicate" }
  | { kind: "delete" }
  | { kind: "move"; direction: "up" | "down" }
  | { kind: "turnInto"; format: VeBlockFormat };

/**
 * The twelve edits the table controls offer (visual-editor.md §3.2), named
 * after what the author asked for rather than after the function that answers
 * it: every one of them is applied by `src/lib/visual-editor/table.ts`, and
 * this union is only the way a click gets there.
 *
 * They are *positional* — each acts on the row and column the caret is in — so
 * the action carries no indices. Which cell that is belongs to the surface,
 * which owns the caret; a toolbar that tried to say it would be guessing.
 */
export type VeTableOp =
  | "insertRowAbove"
  | "insertRowBelow"
  | "moveRowUp"
  | "moveRowDown"
  | "deleteRow"
  | "insertColumnLeft"
  | "insertColumnRight"
  | "moveColumnLeft"
  | "moveColumnRight"
  | "deleteColumn"
  | "toggleHeaderRow"
  | "deleteTable";

/**
 * What the surface tells the toolbar about the table the caret is standing in,
 * or `null` for a caret that is not in one — which is what disables the whole
 * table group.
 *
 * It is a *report*, like `VeBlockFormat` and the active marks: the toolbar
 * draws from it and decides nothing, because only the surface knows where the
 * caret is.
 */
export interface VeTableContext {
  /** Which operations can do something from the caret's cell. */
  can: Readonly<Record<VeTableOp, boolean>>;
  /** The caret's row is written as `<th>`, so the toggle offers the way out. */
  headerRow: boolean;
}

/**
 * Everything the visual toolbar can ask the contenteditable surface to do.
 * `insert` carries the wikitext of a construct that becomes an atomic node;
 * `block: true` places it as its own block rather than at the caret.
 */
export type VisualAction =
  | EditorChromeAction
  | { kind: "format"; format: VeBlockFormat }
  | { kind: "mark"; mark: VeMark }
  | { kind: "clearFormatting" }
  | { kind: "list"; list: "bullet" | "number" }
  | { kind: "indent"; delta: 1 | -1 }
  | { kind: "unlink" }
  | { kind: "insert"; source: string; block: boolean }
  /**
   * Inline wikitext, parsed and inserted as **content** rather than as a chip:
   * `[[Gold bar]]` becomes a link the caret can walk through and the author can
   * retype, which is what a page link is. `insert` is for the constructs the
   * model does not understand, and a link is not one of them.
   *
   * Raised by the `[[` panel's rows (§13); the same path a paste takes for the
   * inline half of its answer (§11).
   *
   * `block: true` takes the *block* half of that path instead, for the two
   * constructs the model understands but has no other vocabulary for — a
   * definition list is `; term : definition`, which is neither a chip nor a
   * run of inline content. It is the paste's own block insertion, so the
   * source is parsed as a document and lands as real blocks.
   */
  | { kind: "wikitext"; source: string; block?: boolean }
  | { kind: "text"; text: string }
  /**
   * One block command, applied to the block the caret is standing in. The
   * gutter menu names a block explicitly because it is about the block a
   * *pointer* chose (§3.3); an action carries no block for the same reason a
   * table op carries no indices.
   */
  | { kind: "block"; command: VeBlockCommand }
  /**
   * One table edit, applied to the table the caret is standing in (§3.2). The
   * surface refuses it anywhere else, which is also why the toolbar's table
   * group is disabled while the caret is outside one.
   */
  | { kind: "table"; op: VeTableOp };

/* ------------------------------------------------------------------ */
/* Source surface                                                      */
/* ------------------------------------------------------------------ */

/**
 * The source toolbar keeps emitting the selection commands the textarea
 * already understands, wrapped so chrome actions can ride the same channel.
 */
export type SourceAction = EditorChromeAction | { kind: "command"; command: EditorCommand };

/** Narrowing helper: chrome actions are the ones both toolbars share. */
export function isChromeAction(action: VisualAction | SourceAction): action is EditorChromeAction {
  switch (action.kind) {
    case "undo":
    case "redo":
    case "help":
    case "toggleRail":
    case "link":
    case "media":
    case "template":
    case "versions":
      return true;
    default:
      return false;
  }
}
