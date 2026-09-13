"use client";

/**
 * The WYSIWYG surface — Fandom's *Visual editing* mode, and the half of
 * docs/engine/visual-editor.md (§3 DOM mapping, §5 atomic previews, §6
 * keyboard) that an author actually touches.
 *
 * **The contenteditable is uncontrolled, and that is the whole design.** React
 * writes its `innerHTML` exactly once per document load — an effect keyed on
 * `docKey` — and never again. It is never re-rendered on a keystroke, because
 * every re-render of a contenteditable destroys the caret, the IME composition
 * in progress and the browser's undo stack. Typing instead runs
 * `domToDocument` → `serializeDocument` on a ~250 ms debounce and pushes the
 * wikitext up through `onContentChange`; the parent may store it wherever it
 * likes, and only bumps `docKey` when the buffer changed from *outside* the
 * surface (a mode switch, a category chip, a conflict rebase).
 *
 * The last document read is kept in a ref and handed back to `domToDocument`
 * as its `prev`, which is what carries §4's `source`/`canonical`/`gapAfter`
 * across a read. Without it every read would look like a rewrite and
 * publishing an untouched article would no longer be byte-identical.
 *
 * **Why `document.execCommand`, a deprecated API.** Six of the seven marks,
 * both list commands, indent/outdent, plain-text insertion and undo/redo are
 * delegated to it. It is deprecated, its output differs between engines, and
 * `dom.ts` exists partly to tolerate that. We use it anyway because it is the
 * only way to get native undo/redo, IME composition, autocorrect and mobile
 * keyboards for free — a hand-rolled command layer would silently lose all
 * four, and losing Korean composition is not a trade this wiki can make.
 * `styleWithCSS` is turned off first so the browser emits `<b>`/`<i>` tags
 * rather than inline styles: `dom.ts` reads both, but tags round-trip cleanly.
 * The commands it cannot do — `code`, clear-formatting, block format — are
 * hand-rolled Range surgery in ve-selection.ts.
 *
 * **Atomic previews never reach the model.** After a load, the distinct
 * `data-ve-src` values go to `POST /api/preview/fragments` in one batch and
 * each answer is injected into that node's `data-ve-body`. `domToDocument`
 * reads the *attribute*, never the body, so nothing rendered here can change
 * what is published; a fragment that fails renders as the raw wikitext chip.
 *
 * **A version block is atomic, and no longer read-only** (versioning.md §6,
 * amended 2026-09-03 by user). It keeps its wikitext in `data-ve-src` — §4
 * depends on that — but under its preview it carries a `<textarea>` holding the
 * passage the surface is previewing, because "pick a version and change it" has
 * to mean typing, not opening a dialog. Everything about that field is in
 * `syncBranchField` and `commitBranchEdit` below, and the arithmetic it stands
 * on — which of the block's tags reaches the version on screen — is pure,
 * exported and unit-tested in src/lib/visual-editor/version-branch.ts, since
 * the one thing this must never do is write one version's words under another
 * version's id. A block may hold several tags back to back (§2.1 has no group
 * wrapper, so that is what a page with two windows looks like), and the field
 * edits the one the previewed version renders.
 *
 * **The interaction model is Notion's** (user direction, 2026-09-04). There is
 * no toolbar over the writing area any more; four controls come to the caret
 * instead, each of them a module of its own that this file only wires up:
 *
 * - **the slash menu** (`ve-slash-menu.tsx`) — "/" at the caret opens the list
 *   the retired toolbar held, and `visualSlashItems` (editor-toolbar-visual.tsx)
 *   is that list, so retiring the row could not quietly drop a construct;
 * - **the block handle** (`ve-block-handle.tsx`) — put the caret in a block and
 *   a "+" and a drag grip appear in the gutter beside it;
 * - **the bubble menu** (`ve-bubble-menu.tsx`) — select text and the formatting
 *   bar comes to the selection;
 * - **input rules** (`src/lib/visual-editor/input-rules.ts`) — "## " becomes a
 *   heading as it is typed, in markdown's spelling *and* wikitext's.
 *
 * All four are drawn by React **outside** the contenteditable, which is the one
 * rule none of them may break: a `<button>` written inside a paragraph is
 * markup `domToDocument` reads as that paragraph's content and
 * `serializeDocument` publishes. So they are positioned from measured
 * rectangles and never touch the surface's own DOM.
 *
 * **Moving a block is a DOM move and nothing else** (§3.1), whether it was
 * asked for by the grip's menu, by a drag of the grip, or by `Alt+Arrow`: all
 * three end in `moveBlockRun` (ve-selection.ts), which re-parents the block's
 * elements and rebuilds nothing. The block keeps its `data-ve-id`, so the next
 * read still matches it to the block it was parsed from and §4 still emits it
 * from `source` — a page whose paragraphs were only reordered republishes with
 * every paragraph byte-identical. A drag is the pointer's shortcut to a move
 * the keyboard can already make; it never *replaces* one, which is why the
 * grip's menu still carries Move up and Move down.
 *
 * **Dragging inside a contenteditable is the delicate part**, and three things
 * make it work. The drag starts on the grip, which is outside the surface, so
 * the browser never tries to drag the *selection*. `dragover` is prevented on
 * the wrapper, because without that there is no drop target at all and the
 * drop event never fires. And the drop is prevented too — an unprevented drop
 * on a contenteditable inserts the drag's data as text, which is an edit the
 * author never made.
 *
 * **A table is edited in place, and every edit is `table.ts`'s** (§3.2). The
 * axis controls beside a table and the slash menu's contextual rows both raise
 * one `{ kind: "table", op }` action, and `applyTableOp` below is the single
 * path it takes: read the surface back with `domToDocument`, find the block by
 * its `data-ve-id`, hand it to the pure operation, and draw the answer with
 * `blockToHtml`. **No wikitext is spelled anywhere in this file** — the table's
 * bytes are the serializer's business, and an operation that ends up changing
 * nothing therefore republishes the original ones (§4).
 *
 * The controls appear over a table the model *parsed*. A table it refused is an
 * atomic chip (§2), and a chip's cells are the engine's rendering of somebody's
 * wikitext rather than anything the model holds — so `tableAt` refuses it, the
 * raw-wikitext dialog stays the way in, and `decorateAtomic` prints the parser's
 * own reason on the chip, because "this table behaves differently" is otherwise
 * something an author can only guess at.
 *
 * Two things this component deliberately does not own: the dialogs, and the
 * chrome actions that open them. An item of the slash menu or a button of the
 * bubble menu that means "link", "media", "template" or "version block" is
 * raised through `onChromeAction` to the editor island, exactly as the toolbar
 * used to raise it; `Ctrl/Cmd+K` is left to bubble for the same reason, while
 * `B`, `I` and `U` are handled here because they are ours to apply. The one
 * dialog that IS here is the confirmation in front of a table edit that would
 * delete the table: what it is about — the row the caret is in and whether it
 * is the last one — is knowledge only the surface has, and routing it through
 * the island would mean the island holding a pending operation it cannot read.
 */

import {
  Fragment,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type FocusEvent as ReactFocusEvent,
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { LinkIcon, TemplateIcon, tableOpIcon } from "@/components/wiki/editor-icons";
import { MenuItem, MenuSeparator, ToolbarMenu } from "@/components/wiki/editor-menu";
import {
  visualInsertItems,
  visualSlashItems,
  type VeSlashBlock,
  type VeSlashLabels,
} from "@/components/wiki/editor-toolbar-visual";
import {
  VeBlockHandle,
  blockMenuRows,
  type BlockHandleLabels,
  type BlockMenuCommand,
} from "@/components/wiki/ve-block-handle";
import {
  VeBubbleMenu,
  type BubbleMenuLabels,
  type BubbleRect,
} from "@/components/wiki/ve-bubble-menu";
import { VeContextMenu, type VeContextRow } from "@/components/wiki/ve-context-menu";
import {
  sortGap,
  sortLandingStart,
  sortShift,
  sortTargetIndex,
  type SortExtent,
} from "@/components/wiki/ve-sortable";
import {
  VeSlashMenu,
  filterSlashItems,
  type SlashItem,
  type SlashMenuLabels,
} from "@/components/wiki/ve-slash-menu";
import {
  TABLE_OPS,
  clampSpot,
  spotAfterOp,
  tableContextOf,
  tableOpLabel,
  tableOpOutcome,
  tableOpStartsGroup,
  tableRowsOf,
  tableSpotOf,
  tableTabStep,
  type VeTableLabels,
  type VeTableNode,
} from "@/components/wiki/ve-table";
import { findMatches } from "@/components/wiki/editor-find";
import { linkSuggestionTarget } from "@/components/wiki/editor-link-dialog";
import type { StorableNamespace } from "@/lib/title";
import {
  emptyHistory,
  forgetEdits,
  recordEdit,
  redoEdit,
  undoEdit,
  type VeHistoryState,
  type VeSnapshot,
} from "@/components/wiki/ve-history";
import type { SectionMovePlan } from "@/components/wiki/editor-outline";
import { formatMessage } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  isChromeAction,
  type EditorChromeAction,
  type VeBlockFormat,
  type VeTableContext,
  type VeTableOp,
  type VisualAction,
} from "@/lib/visual-editor/actions";
import {
  CARET_HOLDER,
  blockToHtml,
  documentToHtml,
  domToDocument,
  escapeHtml,
  inlineToHtml,
} from "@/lib/visual-editor/dom";
import { matchBlockRule, matchInlineRule } from "@/lib/visual-editor/input-rules";
import { moveColumn, moveRow } from "@/lib/visual-editor/table";
import { mentionContext, mentionWikitext, type VeMentionKind } from "@/lib/visual-editor/mention";
import { readPaste } from "@/lib/visual-editor/paste";
import type { NamedRef } from "@/lib/wikitext-refs";
import {
  createIdFactory,
  emptyDocument,
  newBlockBase,
  type VeAtomicKind,
  type VeBlock,
  type VeDocument,
  type VeMark,
  type VeTable,
} from "@/lib/visual-editor/model";
import {
  atomicKindOf,
  atomicLabelOf,
  parseDocument,
  parseInlineRun,
  parseTableWikitext,
  type VeTableRefusal,
} from "@/lib/visual-editor/parse";
import { serializeDocument } from "@/lib/visual-editor/serialize";
import {
  replaceBranchBody,
  versionFieldState,
  type VersionFieldState,
} from "@/lib/visual-editor/version-branch";
import {
  applyRange,
  atomicBeside,
  blockMoveTarget,
  blockUnitOf,
  blockUnitPosition,
  blockUnits,
  clearFormatting,
  currentRange,
  elementFromHtml,
  ensureUniqueBlockIds,
  isAtBlockEnd,
  isInAtomic,
  isListElement,
  isMarkActive,
  liftListItem,
  lineTextOf,
  moveBlock,
  moveBlockRun,
  nearestBlock,
  nearestMatching,
  normalizeLists,
  placeCaretAfter,
  placeCaretInside,
  rangeSelectsNode,
  rangeTouchesNode,
  replaceBlockTag,
  replaceRangeWith,
  rootInsertIndex,
  selectNode,
  toggleCodeMark,
  unwrapElement,
  type VeMoveDirection,
} from "@/components/wiki/ve-selection";

/** Long enough that a fast typist is not re-serialized mid-word. */
const READ_DEBOUNCE_MS = 250;

/**
 * How long the `[[` / `@` / `{{` panel waits before searching (§13) — the
 * same 200 ms the link dialog's combobox waits, because it is the same
 * index answering the same kind of half-typed name.
 */
const MENTION_DEBOUNCE_MS = 200;

/**
 * Batch limits, kept under the route's own caps (64 fragments / 20 KB each /
 * 200 KB total) so a template-heavy page splits into requests that are
 * accepted rather than one that is rejected whole.
 */
const MAX_BATCH = 48;
const MAX_BATCH_CHARS = 150_000;
const MAX_FRAGMENT_CHARS = 20_000;

/**
 * The table's axis controls (§3.2): how thick a bar is, and the air between it
 * and the table's edge. Small on purpose — an axis control is a grip, not a
 * button with a name on it; the name is in its menu.
 */
const TABLE_AXIS = 14;
const TABLE_AXIS_GAP = 3;

/** The axis bar fills the strip the caller positions, and carries no padding. */
const TABLE_AXIS_TRIGGER = "h-full w-full min-w-0 justify-center rounded-[var(--radius-sm)] p-0";

/**
 * Which of `table.ts`'s twelve operations belong to which axis.
 *
 * Together they are exactly `TABLE_OPS`, and the two that belong to neither
 * axis ride with the row: the header toggle acts on the caret's row, and
 * "delete table" has to live somewhere a pointer can reach — repeating it on
 * both axes would be two controls for one irreversible act.
 */
const ROW_OPS: readonly VeTableOp[] = [
  "insertRowAbove",
  "insertRowBelow",
  "moveRowUp",
  "moveRowDown",
  "deleteRow",
  "toggleHeaderRow",
  "deleteTable",
];

const COLUMN_OPS: readonly VeTableOp[] = [
  "insertColumnLeft",
  "insertColumnRight",
  "moveColumnLeft",
  "moveColumnRight",
  "deleteColumn",
];

/**
 * Stable empties for the three controls that are always mounted. A fresh `[]`
 * per render is a new prop value, which for the slash menu would re-subscribe
 * its document listener on every keystroke.
 */
const EMPTY_SLASH_ITEMS: readonly SlashItem[] = [];
const EMPTY_MARKS: readonly VeMark[] = [];
const EMPTY_FORMATS: readonly VeBlockFormat[] = [];

const MARKS: readonly VeMark[] = ["bold", "italic", "underline", "strike", "sup", "sub", "code"];
const HEADING_TAGS: ReadonlySet<string> = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);

/**
 * What a block can be turned into — the retired `NORMAL TEXT ▾`'s list (§1),
 * now the "turn into" section of the gutter handle's menu and of the bubble
 * menu. h2…h5 and never h1 or h6: the page title is the h1, and the model's
 * `VeBlockFormat` stops at h5.
 */
const BLOCK_FORMATS: readonly VeBlockFormat[] = ["paragraph", "h2", "h3", "h4", "h5", "pre"];

/**
 * The tag an inline input rule wraps its text in. Only two rules exist
 * (`**bold**` and `` `code` ``), so this is the whole map — and it is a *tag*
 * rather than an `execCommand`, because writing the marked text in one
 * `insertHTML` keeps the whole rule on a single native undo step.
 */
const INLINE_RULE_TAG: Partial<Record<VeMark, string>> = { bold: "b", code: "code" };

/**
 * Elements that hold one *line* the author is typing on, as opposed to the
 * block the reader sees. The slash menu and the input rules both ask "what is
 * before the caret", and in a list or a table that question is about the item
 * or the cell — `before` taken from a whole `<ul>` would run three bullets
 * together and no rule would ever match in the second one.
 */
const LINE_HOSTS: ReadonlySet<string> = new Set(["LI", "DD", "DT", "TD", "TH", "CAPTION"]);

/**
 * Where a click that missed every character is answered with a caret of our own
 * (`caretIndexForClick`): the regions that hold **inline content**.
 *
 * A `<table>`, a `<tr>`, a rule and the surface's own padding are all things a
 * press can land on and none of them has a line in it, so a caret placed there
 * would be a caret in no text at all — which is the failure this whole path
 * exists to fix, one container out.
 */
const CARET_HOSTS: ReadonlySet<string> = new Set([
  ...LINE_HOSTS,
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
]);

/** `Node.TEXT_NODE`, spelled out — this module is read where `Node` is not. */
const TEXT_NODE = 3;

/**
 * Keys that are held rather than pressed. Pressing one is not "the author has
 * moved on", so it does not close the input rules' one-step undo window —
 * `Ctrl` arrives before the `Z` that is about to use it.
 */
const MODIFIER_KEYS: ReadonlySet<string> = new Set(["Shift", "Control", "Meta", "Alt", "AltGraph"]);

/**
 * How far a re-anchor may move the block handle before it is re-rendered. The
 * handle is `position: fixed`, so it has to follow a scroll; one pixel of
 * rounding is not worth a render, and anything above this is the pointer or
 * the page actually moving.
 */
const ANCHOR_EPSILON = 1;

/**
 * Every floating panel that owns its own scrollbar: the slash menu and the
 * `[[`/`@`/`{{` panel (one component — ve-slash-menu.tsx), and the right-click
 * menu (ve-context-menu.tsx).
 *
 * The window-level `scroll` listener skips events out of one, because a list
 * scrolling itself is not the page moving away from the caret or the pointer
 * the panel hangs off. Each of them also carries `overscroll-contain`, which is
 * the other half of the same promise: at the end of the list the wheel stops
 * rather than handing its remaining delta to the page, so scrolling to the last
 * row cannot scroll the article out from under the panel and close it.
 */
const PANEL_SCOPE_SELECTOR = "[data-ve-slash-menu], [data-ve-context-menu]";

/**
 * `Ctrl/Cmd+0` and `Ctrl/Cmd+2`…`Ctrl/Cmd+5` — the block formats a keyboard can
 * reach without the toolbar (§6, §10.2), and the numbers the wikitext itself
 * spells: `Ctrl+2` writes `== x ==`. `1` is absent because `= x =` is a page
 * title the format menu deliberately does not offer (§1), and `6` because the
 * menu stops at `h5`.
 *
 * Keyed on `event.key` — the digit the reader's keyboard actually *prints* —
 * which is why Shift is not excluded where these are read. A layout that needs
 * Shift for a digit reports the digit, and one that does not reports something
 * else entirely for the shifted key, so the same test is right on both.
 */
const FORMAT_KEYS: ReadonlyMap<string, VeBlockFormat> = new Map([
  ["0", "paragraph"],
  ["2", "h2"],
  ["3", "h3"],
  ["4", "h4"],
  ["5", "h5"],
]);

/**
 * The branch field's two attributes (§6's in-place editing).
 *
 * `data-ve-branch` is the field's *state*, not merely a marker: the branch it
 * holds, or the version it is offering to write for. Rebuilding happens when
 * that string changes and at no other time, which is what lets a version
 * switch swap the field while a keystroke lands in the branch it was typed
 * into — and what stops any other pass over the surface from rewriting a
 * textarea somebody has their caret in.
 */
const BRANCH_ATTR = "data-ve-branch";
/** Carries the branch id the textarea's words belong to, and marks it as one. */
const BRANCH_BODY_ATTR = "data-ve-branch-body";

/**
 * Marks the one empty paragraph the caret is standing in, so the stylesheet
 * can print "type / for commands" in it — Notion's answer to the
 * discoverability the retired toolbar provided, and the only thing on screen
 * that mentions the slash menu (§1).
 *
 * It is an attribute rather than an element because an element would be
 * markup: `domToDocument` reads what is inside a paragraph as that paragraph's
 * content, and a hint written as a `<span>` would be published. An attribute is
 * read by nothing — the reader classifies on tag names and `data-ve` — so it
 * cannot reach the buffer, which is the same bargain `data-ve-selected` on a
 * chip already makes.
 */
const HINT_ATTR = "data-ve-hint";

/**
 * The chip chrome is built with `document.createElement`, not JSX, because it
 * lives inside a subtree React must never diff — so these three glyphs are
 * markup rather than imports from editor-icons.tsx. Same drawing rules as that
 * file (16×16, `currentColor`, 1.5 stroke), and they are constants: nothing
 * user-supplied is ever interpolated into them.
 */
const ICON_OPEN =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"' +
  ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="size-4">';
const KIND_ICON = `${ICON_OPEN}<rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M2.5 6.5h11" /></svg>`;
const PENCIL_ICON = `${ICON_OPEN}<path d="M11.4 2.3l2.3 2.3-8 8-3 .7.7-3z" /><path d="M9.9 3.8l2.3 2.3" /></svg>`;
const TRASH_ICON =
  `${ICON_OPEN}<path d="M2.5 4.5h11" /><path d="M6.3 4.5V3a1 1 0 011-1h1.4a1 1 0 011 1v1.5" />` +
  '<path d="M4.3 4.5l.6 8.6a1 1 0 001 .9h4.2a1 1 0 001-.9l.6-8.6" /></svg>';

const ACTION_BUTTON =
  "inline-flex size-5 items-center justify-center rounded-[var(--radius-sm)] text-mute" +
  " transition-colors hover:bg-canvas-soft-2 hover:text-ink";

/* ------------------------------------------------------------------ */
/* Public shape                                                        */
/* ------------------------------------------------------------------ */

/**
 * Where the gutter handle is drawn and what it may do from there (§3.1).
 *
 * `anchor` is in **viewport** coordinates, because `VeBlockHandle` positions
 * itself `fixed` — so nothing here has to know which scroll container the
 * surface sits in, and a scroll simply re-measures. `up`/`down` are
 * `blockMoveTarget`'s answer, which is what disables a row of the grip's menu
 * at the ends of the document rather than letting it click and do nothing;
 * `formats` is empty for a block that cannot become anything else (a table, a
 * rule, a chip), which drops the menu's whole "turn into" section.
 */
interface VeBlockHandleState {
  anchor: { top: number; left: number };
  up: boolean;
  down: boolean;
  formats: readonly VeBlockFormat[];
}

/**
 * The slash menu's state (§1): where it hangs, and what has been typed after
 * the "/" that opened it.
 *
 * `consumed` is how many characters the surface will take back out of the
 * buffer when a row is chosen — the slash and the query it introduced. It is
 * carried rather than recomputed because the row is chosen at a moment when
 * the caret may already have moved (a pointer click lands on the row first).
 */
interface VeSlashState {
  anchor: { top: number; left: number };
  query: string;
  consumed: number;
  /**
   * The rows, as they were when the menu opened. They cannot change while it
   * is open — the caret stays in one block for as long as a query is being
   * typed — so they are built once rather than sixty times a word.
   */
  items: SlashItem[];
}

/**
 * The `[[` / `@` / `{{` panel (§13). It is the slash menu's own panel, drawn
 * from rows a *search* answered rather than from a catalogue — which is why it
 * carries `busy`, the one state the slash menu never has: an empty list with a
 * request still owed is not the same as no matches.
 */
interface VeMentionState {
  anchor: { top: number; left: number };
  kind: VeMentionKind;
  query: string;
  /** Characters before the caret the trigger and its query occupy together. */
  consumed: number;
  items: SlashItem[];
  busy: boolean;
}

/**
 * What the bubble menu is drawn over and drawn from (§3): the selection's box
 * in viewport coordinates, plus the two *reports* the retired toolbar read —
 * the marks under the selection and the block it sits in.
 */
interface VeBubbleState {
  rect: BubbleRect;
  marks: VeMark[];
  format: VeBlockFormat;
  formats: readonly VeBlockFormat[];
}

/**
 * What a right-click opened the menu **about** (`ve-context-menu.tsx`).
 *
 * Facts rather than rows: the rows are built during render, where the labels
 * are, and every one of them is a closure over what is stored here. What that
 * buys is the rule this menu lives by — **it is about the block and the cell
 * the POINTER was over, never the caret's.** Right-clicking the third row of a
 * table while typing in the first has to be about the third row, and the caret
 * may not have moved at all (whether a right-click moves it is the browser's
 * business, not ours). So the cell and the block are captured here, once, and
 * handed to the operations explicitly.
 */
export interface VeContextState {
  /** The pointer, in viewport coordinates: the panel places itself `fixed`. */
  at: { top: number; left: number };
  /** The cell under the pointer and its twelve operations, or null. */
  table: { cell: HTMLElement; context: VeTableContext } | null;
  /** The block unit under the pointer — what the block rows act on. */
  block: HTMLElement;
  up: boolean;
  down: boolean;
  formats: readonly VeBlockFormat[];
}

/**
 * A drag in progress (§3.4) — one shape for all three things this surface can
 * reorder.
 *
 * It lives in a **ref**, not in state, because nothing React draws depends on
 * it: the animation is `transform` written straight onto the elements being
 * moved, sixty times a second, and routing that through a re-render would put
 * the whole editor's reconciliation between the pointer and the block that is
 * supposed to be following it. The one thing React is told is *that* a drag is
 * on (`sorting`), which hides the chrome that would otherwise hang over a
 * document sliding about underneath it.
 *
 * `items` is index-ordered and each entry is a **run**, because two of the
 * three things being sorted are not single elements: a block unit can be
 * several sibling list roots (§3.1), and a column is one cell per row.
 */
interface VeSortRun {
  axis: "block" | "row" | "column";
  /** The elements of each slot, in index order. */
  items: HTMLElement[][];
  /** Their extents along the axis, in document coordinates. */
  extents: SortExtent[];
  /** The dragged run's own extent along the axis — the size of the hole. */
  size: number;
  from: number;
  /** Where it would land right now. */
  to: number;
  /** The pointer where the press began, in viewport coordinates. */
  originX: number;
  originY: number;
  /** Page scroll when the extents were measured, so a scroll does not lie. */
  originScroll: number;
  /** The table a row or column drag is inside; null for a block. */
  table: HTMLElement | null;
  pointerId: number;
  /** The press has travelled far enough to be a drag rather than a click. */
  moved: boolean;
}

/**
 * The controls beside a table (§3.2): where each of them is drawn, and which
 * of the twelve edits the caret's cell can be given.
 *
 * Notion's shape, adopted with the rest of the model on 2026-09-04: **one
 * control per axis**, over the caret's own column and beside the caret's own
 * row, each opening the operations of that axis; and a "+" at the far end of
 * each axis, which is how a table grows a row or a column without opening
 * anything. The twelve-button strip that used to sit above the table said
 * everything at once and meant nothing in particular.
 *
 * Every measurement is from the wrapper's padding box, so the controls ride
 * over the table they act on and scroll with it — unlike the gutter handle,
 * which is `fixed`, these sit inside the surface's own box and never have to
 * be re-anchored. The context is the same object the slash menu's contextual
 * rows are built from, because the two are one feature and a disagreement
 * between them would be a bug nobody could see.
 */
interface VeTableHandle {
  /** The table's own box: the two "+"s hang off its far edges. */
  top: number;
  left: number;
  width: number;
  height: number;
  /** The caret's row, so the row control sits beside it. */
  rowTop: number;
  rowHeight: number;
  /** The caret's column, so the column control sits over it. */
  columnLeft: number;
  columnWidth: number;
  /** The caret's own spot, so a drag of either tab knows what it is moving. */
  row: number;
  column: number;
  /** The table itself, which the drag's commit edits. */
  table: HTMLElement;
  context: VeTableContext;
  /**
   * The document load this was measured against. A load replaces every element
   * in the surface, so a strip left over from the previous one points at a
   * table that no longer exists — and the load effect cannot clear it, because
   * a `setState` in an effect body is forbidden here. Refusing to draw a stamp
   * that is not the current one is the same answer without the write.
   */
  docKey: number;
}

/**
 * What the surface's one dialog is open about.
 *
 * `confirm` carries the cell it was raised from rather than reading it back on
 * confirmation: a modal takes focus, so `selectionchange` stops reporting and
 * the caret would otherwise have to be *remembered* somewhere anyway — and this
 * is the somewhere. `refused` carries nothing; it is a sentence.
 */
type VeTableDialog =
  | { kind: "confirm"; op: VeTableOp; cell: HTMLElement }
  | { kind: "refused" };

/** The node a dialog is about to open on (§5): its wikitext and what it is. */
export interface VeAtomicSelection {
  source: string;
  atomic: VeAtomicKind;
  label: string;
}

export interface VisualEditorLabels {
  /** Accessible name of the edit surface itself. */
  surfaceLabel: string;
  /** Shown while the document is empty and nothing is focused in it. */
  placeholder: string;
  /**
   * Shown in the empty paragraph the caret is standing in — Notion's answer to
   * the discoverability a toolbar used to provide, and the only thing left on
   * screen that says the slash menu exists (§1).
   */
  slashHint: string;
  /** Announced while an atomic preview is still being fetched. */
  rendering: string;
  /**
   * The tooltip on a chip whose wikitext renders nothing at the version being
   * previewed — the ordinary state of a `<v69>` tag at every version but v69
   * (versioning.md §2.1), and the one an empty chip would otherwise leave the
   * author guessing at.
   */
  renderedEmpty: string;
  /** Shown instead of the document when the buffer could not be parsed. */
  loadError: string;
  /** "Edit this {label}" — `{label}` is the kind name below. */
  edit: string;
  /** "Remove this {label}". */
  remove: string;
  /** Human name per atomic kind: the chip's heading and the two messages'. */
  kinds: Record<VeAtomicKind, string>;

  /* — the in-place branch field of a versions block (versioning.md §6) — */

  /** Head row over the field: "Editing {branch}" — which version it holds. */
  branchHeading: string;
  /** The block writes nothing at the previewed version — "{version}". */
  branchMissing: string;
  /**
   * The previewed version renders nothing here and the field is holding the
   * block's nearest passage instead — "{version}" is what is being previewed,
   * "{branch}" the passage on screen.
   */
  branchElsewhere: string;

  /* — the four Notion-shaped controls (§1) — */

  /** The gutter handle's own bag: its two buttons and every row of its menu. */
  handle: BlockHandleLabels;
  /** The formatting bar that comes to a selection. */
  bubble: BubbleMenuLabels;
  /** The slash panel's heading and its no-match line. */
  slashMenu: SlashMenuLabels;
  /** Every row the slash menu can offer, which is the retired toolbar's list. */
  slashItems: VeSlashLabels;
  /**
   * The two mention panels (§13). They are two bags rather than one because
   * the heading is the whole of what tells an author which index they are
   * looking at — the rows are just names, and a page and a template can have
   * the same one.
   */
  mentionPage: SlashMenuLabels;
  mentionTemplate: SlashMenuLabels;

  /* — the table controls (§3.2) — */

  /** Accessible name of the menu a right-click opens over a block. */
  contextMenu: string;
  /** Accessible name of the group of controls drawn around a table. */
  tableControlsLabel: string;
  /** The control over the caret's column, and the menu it opens. */
  tableColumnMenu: string;
  /** The control beside the caret's row, and the menu it opens. */
  tableRowMenu: string;
  /** The twelve operations' names — the same bag the toolbar's menu draws from. */
  table: VeTableLabels;
  /** Title of the dialog in front of an edit that would delete the table. */
  tableDeleteTitle: string;
  /** Body when the author asked for the table itself to go. */
  tableDeleteBody: string;
  /** Body when it is the last row, so deleting it deletes the table (§7.5). */
  tableDeleteLastRowBody: string;
  /** The same for the last column. */
  tableDeleteLastColumnBody: string;
  /** Confirms the deletion. */
  tableDeleteConfirm: string;
  /** Title of the notice explaining a header-row toggle that refused. */
  tableHeaderRefusedTitle: string;
  /** Why: a data cell holding `!!`, which a header line splits on (§7.3). */
  tableHeaderRefusedBody: string;
  /** Printed on a refused table's chip — "{reason}". */
  tableRefusedWhy: string;
  /** One sentence per refusal, so the chip says which one this table is. */
  tableRefusals: Record<VeTableRefusal, string>;
  /** Dismisses a dialog without doing anything (common.cancel). */
  dialogCancel: string;
  /** The dialog's own close button (common.close). */
  dialogClose: string;
}

/**
 * What the editor island can ask of the surface. Everything here is
 * imperative on purpose: the surface owns the caret, so a command that needs
 * one cannot be expressed as a prop.
 */
export interface VisualEditorHandle {
  applyAction(action: VisualAction): void;
  /**
   * The rows the editor header's Insert menu should offer *right now* — the
   * catalogue pruned for the caret's surroundings (a cell takes only the rows
   * that write inline content).
   *
   * Pulled by the island when the menu opens rather than pushed on every caret
   * move: `onContextChange` deliberately reports one number, because sending
   * the caret's table and marks up would re-render the whole editor per
   * keystroke for a menu that is shut.
   */
  insertItems(): SlashItem[];
  /**
   * Run one catalogue row. The surface's own routing, so a row chosen in the
   * header does exactly what the same row chosen from the slash menu does —
   * including handing Link, Media, Template and Version block back to the
   * island as `onChromeAction`.
   */
  runAction(action: VisualAction): void;
  selectionText(): string;
  selectedLink(): { target: string; text: string } | null;
  applyLink(link: { target: string; text: string } | null): void;
  replaceAtomic(source: string): void;
  /**
   * Serializes right now and returns it — the publish path calls this first,
   * and so does anything that edits the buffer from outside. It folds in the
   * branch field's pending keystrokes before reading, so a version's text can
   * never be left behind in a textarea the caller is about to overwrite.
   */
  flush(): string;
  focus(): void;
  /**
   * Put the caret in the field holding `version`'s passage, if one is on
   * screen. The `+` menu adds a tag and then asks for this, because "adds it
   * and selects it" is only true if the author can start typing.
   */
  focusBranch(version: string): void;
  /**
   * Bring one find-and-replace match into view and select it (§9). Best effort
   * by construction — see {@link VeRevealRequest} — and it writes nothing into
   * the surface, which is the point.
   */
  revealMatch(request: VeRevealRequest): void;
  /**
   * Scroll one block into view and put the caret in it — what clicking a row of
   * the outline does (§10.1). Named the way {@link VeRevealRequest} is, by id
   * *and* by position, because the two keys fail in different places.
   */
  focusBlock(blockId: string, blockIndex: number): void;
  /**
   * Move a whole section, as `moveBlockRun` moves it: the elements are
   * re-parented, so every block in the run republishes byte for byte (§3.1,
   * §10.1). The plan is refused outright when it was computed over a document
   * with a different number of blocks — the buffer it came from can trail this
   * surface by one serialize debounce, and a plan read against the wrong
   * document names the wrong paragraphs.
   */
  moveSection(plan: SectionMovePlan): void;
}

/**
 * Where a buffer match is, said in the only terms the surface can act on.
 *
 * The panel searches the wikitext and the surface holds a *rendering* of it, so
 * an offset cannot cross between them: `'''Artifice'''` is nine characters here
 * and thirteen there, and a name inside a template call has no rendering at all.
 * What does cross is a block (`data-ve-id`, §3) plus an ordinal — the third
 * "Artifice" of that paragraph is the third one however the paragraph spells
 * its bold — so that is what this asks for. Where even that does not land, the
 * block is scrolled to and nothing is selected: a wrong selection would be the
 * editor claiming a match is somewhere it is not.
 */
export interface VeRevealRequest {
  /** `data-ve-id` of the block the match falls in (`blockSpans`). */
  blockId: string;
  /**
   * That block's position in the document, and the fallback when the id is not
   * on screen. The parser numbers blocks positionally but the surface mints an
   * id for every block the author creates, so the two disagree about anything
   * typed since the last document load — while their *order* never does.
   */
  blockIndex: number;
  /** The text to select — the query, or a replacement just written. */
  needle: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  /** Which occurrence inside that block, counted in the buffer. */
  occurrence: number;
}

export interface VisualEditorProps {
  content: string;
  /** Bumped by the parent whenever `content` changed from OUTSIDE the surface. */
  docKey: number;
  onContentChange: (next: string) => void;
  onEditAtomic: (selection: VeAtomicSelection) => void;
  /**
   * The actions the surface does not own, raised the way the retired toolbar
   * raised them: the slash menu's Link, Media, Template and Version block, and
   * the bubble menu's Link, all open a dialog the editor island holds.
   */
  onChromeAction?: (action: EditorChromeAction) => void;
  onContextChange?: (context: {
    /**
     * Which block the caret stands in, counted the way `blockUnits` counts
     * them — so it is the same number a section move is planned in — or -1 for
     * a caret that is in none. The outline marks the section holding it
     * (§10.1), and this is deliberately the *only* thing reported now that the
     * toolbar is gone: the marks and the caret's block format are read by the
     * bubble menu, which is inside this component, so sending them up would be
     * a render of the whole editor per caret move for nobody's benefit.
     */
    blockIndex: number;
  }) => void;
  /**
   * The named references the buffer already carries, so the slash menu can
   * offer to cite one again (spec §10.3). A report like the buffer itself: the
   * island scans once and hands the same list to whichever surface is on
   * screen, so both modes offer the same sources under the same names.
   */
  namedRefs?: readonly NamedRef[];
  /**
   * A modal is up. The bubble menu and the slash menu are hidden while one is,
   * because both are drawn over the page and neither is inside the dialog's
   * focus trap — a formatting bar floating over a modal is a control a screen
   * reader is told about and a pointer can reach, out of the trap that dialog
   * promised.
   */
  dialogOpen?: boolean;
  readOnly?: boolean;
  locale: string;
  /** Page name for `{{PAGENAME}}` while rendering fragments (versioning.md §6). */
  previewTitle: string;
  version: string;
  className?: string;
  labels: VisualEditorLabels;
}

/* ------------------------------------------------------------------ */
/* DOM helpers — no React, no state                                    */
/* ------------------------------------------------------------------ */

/** `execCommand` with its two failure modes (false, throw) folded into one. */
function exec(root: HTMLElement, command: string, value?: string): boolean {
  try {
    return root.ownerDocument.execCommand(command, false, value);
  } catch {
    return false;
  }
}

function newParagraph(doc: Document, id: string): HTMLElement {
  const paragraph = doc.createElement("p");
  paragraph.setAttribute("data-ve", "p");
  paragraph.setAttribute("data-ve-id", id);
  // The filler `<br>` is what gives an empty line its height. It carries the
  // same label dom.ts writes on its own filler, because an unlabelled `<br>`
  // is an authored spacer line and comes back as one.
  const filler = doc.createElement("br");
  filler.setAttribute("data-ve-filler", "");
  paragraph.appendChild(filler);
  return paragraph;
}

/**
 * The block element a caller outside the surface named — by `data-ve-id`
 * first, by position when that id is not on screen.
 *
 * Both keys are carried because they fail in different places, and the two
 * callers (a find match, §9.3; an outline row, §10.1) both cross into the
 * surface from a buffer that was parsed separately: the parser numbers blocks
 * positionally while the surface mints a fresh id for every block the author
 * creates, so the id is exact until something is typed and the position is
 * right afterwards.
 *
 * Every block writes `data-ve-id` on exactly one element — a list run split
 * across sibling roots labels only its first (§3) — so the walk below is the
 * document's blocks, in order.
 */
function blockElementAt(root: HTMLElement, blockId: string, blockIndex: number): HTMLElement | null {
  const ordered: HTMLElement[] = [];
  for (const child of Array.from(root.children)) {
    if (child instanceof HTMLElement && child.hasAttribute("data-ve-id")) ordered.push(child);
  }
  for (const candidate of ordered) {
    if (candidate.getAttribute("data-ve-id") === blockId) return candidate;
  }
  return blockIndex >= 0 && blockIndex < ordered.length ? ordered[blockIndex] : null;
}

/**
 * The text nodes of one block, in document order, that a find match could
 * possibly be selected in (§9).
 *
 * Two subtrees are stepped over rather than read. An atomic chip's body is the
 * engine's rendering of somebody's wikitext (§5) — text the buffer never held,
 * so a hit in it would be a hit in a preview. A branch field is a `<textarea>`
 * with an editing host of its own, and a document Range cannot reach inside one
 * anyway.
 */
function collectTextNodes(node: Node, out: Text[]): void {
  for (let child: Node | null = node.firstChild; child !== null; child = child.nextSibling) {
    if (child instanceof Text) {
      out.push(child);
      continue;
    }
    if (!(child instanceof HTMLElement)) continue;
    if (child.hasAttribute("data-ve-src") || child instanceof HTMLTextAreaElement) continue;
    collectTextNodes(child, out);
  }
}

/**
 * An offset into the concatenated text of {@link collectTextNodes}, as a
 * (node, offset) pair a Range boundary can be set from.
 *
 * The search runs backwards so that an offset sitting exactly on a boundary
 * resolves to the *later* node — which is the node a range end has to reach
 * when the previous one ends there and is empty.
 */
function textPosition(
  nodes: readonly Text[],
  starts: readonly number[],
  offset: number,
): { node: Text; offset: number } | null {
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    // Clamped, because the flattening has characters no node owns: `hostText`
    // writes a "\n" for every line break, and an offset that lands on one
    // belongs to no text node at all. Without this a Range boundary could be
    // asked for a position past the end of the node it resolved to, which
    // throws rather than misbehaving quietly.
    if (offset >= starts[i]) {
      return { node: nodes[i], offset: Math.min(offset - starts[i], nodes[i].data.length) };
    }
  }
  return null;
}

/* ---------------- what is in front of the caret ---------------- */

/**
 * The element holding the *line* the caret is on: a list item, a table cell,
 * a caption — or, everywhere else, the block itself.
 *
 * The slash menu and the input rules both ask "what have you typed since the
 * start of this line", and in a list that question is about the item. Asking
 * the `<ul>` would concatenate every bullet, so `"- "` typed at the start of
 * the second item would arrive as `"first item- "` and no rule would ever
 * match anywhere but the first.
 */
function caretHost(root: HTMLElement, node: Node | null): HTMLElement | null {
  const line = nearestMatching(root, node, (element) => LINE_HOSTS.has(element.nodeName));
  return line ?? nearestBlock(root, node);
}

/** One host's text nodes, flattened, with the caret's place in the flattening. */
interface VeHostText {
  nodes: Text[];
  starts: number[];
  text: string;
  /** How many characters of `text` come before the caret. */
  offset: number;
}

/**
 * Read the caret's line as a string, or null where the position cannot be said
 * in characters at all.
 *
 * The walk is `lineTextOf` (ve-selection.ts) — where a `<br>` ends the line,
 * where a wrapper does, and where the caret falls when it stands on an element
 * are the parts that can be silently wrong, and they are asserted there in a
 * node environment. This is the adapter: back into the `Text` nodes a Range
 * boundary is set from.
 */
function hostText(host: HTMLElement, range: Range): VeHostText | null {
  const reading = lineTextOf(host, range.startContainer, range.startOffset);
  if (reading === null) return null;
  const nodes: Text[] = [];
  const starts: number[] = [];
  for (const piece of reading.pieces) {
    // Every piece the walk pushes is a text node; this is that fact narrowed,
    // not a case anything is expected to hit.
    if (!(piece.node instanceof Text)) return null;
    nodes.push(piece.node);
    starts.push(piece.start);
  }
  return { nodes, starts, text: reading.text, offset: reading.offset };
}

/**
 * Select the `count` characters immediately before the caret, so the next
 * `execCommand("delete")` takes exactly them.
 *
 * Through the browser's own delete rather than by DOM surgery, because that is
 * what keeps the typed marker on the native undo stack: an author who meant
 * `"## "` literally gets it back with one Ctrl+Z (`undoInputRule` below is the
 * other half of that promise).
 */
function selectBackward(root: HTMLElement, reading: VeHostText, count: number): boolean {
  if (count <= 0) return false;
  const from = textPosition(reading.nodes, reading.starts, reading.offset - count);
  const to = textPosition(reading.nodes, reading.starts, reading.offset);
  if (from === null || to === null) return false;
  const range = root.ownerDocument.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return applyRange(root, range);
}

/**
 * The "/" that opens the slash menu, and everything typed after it — or null
 * where the caret is not in one.
 *
 * Pure, and exported for that reason: this is the whole of "when does the menu
 * open", and every case in it is a sentence somebody types by accident.
 *
 * A slash counts only at the **start of the line or after whitespace**, which
 * is what keeps `[[File:x.png]]`, `and/or` and a URL from opening a menu. The
 * search runs backwards from the caret and stops at the first slash it meets:
 * if that one is inside a word then the author is typing a word, and an
 * earlier slash on the line is behind text they have moved past.
 */
export function slashContext(before: string): { query: string; consumed: number } | null {
  for (let at = before.length - 1; at >= 0; at -= 1) {
    if (before.charAt(at) !== "/") continue;
    if (at !== 0 && !/\s/u.test(before.charAt(at - 1))) return null;
    return { query: before.slice(at + 1), consumed: before.length - at };
  }
  return null;
}

/**
 * A whole block unit's text nodes, flattened. A unit can be several elements
 * (§3: a list whose marker changes at depth 0), so the caret's place in it is
 * counted across all of them — which is what lets the input rules' one-step
 * undo put the caret back where the marker was typed.
 */
function unitReading(members: readonly Node[]): { nodes: Text[]; starts: number[]; total: number } {
  const nodes: Text[] = [];
  for (const member of members) {
    if (member instanceof Text) nodes.push(member);
    else if (member instanceof HTMLElement) collectTextNodes(member, nodes);
  }
  const starts: number[] = [];
  let total = 0;
  for (const node of nodes) {
    starts.push(total);
    total += node.data.length;
  }
  return { nodes, starts, total };
}

/** How far into a block unit's text the caret stands; 0 when it cannot be said. */
function unitCaretOffset(members: readonly Node[], range: Range): number {
  const { nodes, starts } = unitReading(members);
  const container = range.startContainer;
  if (!(container instanceof Text)) return 0;
  const index = nodes.indexOf(container);
  return index < 0 ? 0 : starts[index] + range.startOffset;
}

/** Put the caret that many characters into a block unit, or at its start. */
function placeCaretAtOffset(root: HTMLElement, members: readonly Node[], offset: number): boolean {
  const { nodes, starts, total } = unitReading(members);
  const at = textPosition(nodes, starts, Math.max(0, Math.min(offset, total)));
  if (at === null) {
    const first = members[0];
    return first instanceof Element ? placeCaretInside(first) : false;
  }
  const range = root.ownerDocument.createRange();
  range.setStart(at.node, at.offset);
  range.collapse(true);
  return applyRange(root, range);
}

/* ---------------- measuring, for the controls drawn outside ---------------- */

/**
 * The caret's bottom-left corner in viewport coordinates — where the slash
 * panel hangs from.
 *
 * A collapsed Range has no width, and in an *empty* line it often has no
 * rectangle at all; the element's own box is the honest fallback, since that
 * is exactly where the caret is standing.
 */
function caretAnchor(range: Range): { top: number; left: number } | null {
  const rects = range.getClientRects();
  const rect = rects.length > 0 ? rects[0] : range.getBoundingClientRect();
  if (rect.width !== 0 || rect.height !== 0 || rect.top !== 0 || rect.left !== 0) {
    return { top: rect.bottom, left: rect.left };
  }
  const host =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  if (host === null) return null;
  const box = host.getBoundingClientRect();
  return { top: box.bottom, left: box.left };
}

/**
 * Where the slash panel hangs: under the **"/" itself**, not under the caret.
 *
 * The caret walks right as the query is typed, and a panel that followed it
 * would slide across the screen while the author reads it. The slash does not
 * move, so the panel does not either. It is measured as a one-character range
 * rather than as a collapsed one, because a collapsed range has no rectangle
 * to speak of in several engines; where even that fails the caller falls back
 * to {@link caretAnchor}, which at worst puts the panel a word to the right.
 */
function slashAnchor(
  root: HTMLElement,
  reading: VeHostText,
  consumed: number,
): { top: number; left: number } | null {
  const at = reading.offset - consumed;
  const from = textPosition(reading.nodes, reading.starts, at);
  const to = textPosition(reading.nodes, reading.starts, at + 1);
  if (from === null || to === null) return null;
  const range = root.ownerDocument.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { top: rect.bottom, left: rect.left };
}

/**
 * One node's box, whichever kind of node it is. A block unit can be a bare run
 * of text (`blockUnits` makes one a unit of its own because the reader makes a
 * paragraph of it), and a text node has no `getBoundingClientRect` — but a
 * Range over it does, and a unit with no box would shift every drop index
 * after it by one.
 */
function nodeRect(node: Node): DOMRect | null {
  if (node instanceof Element) return node.getBoundingClientRect();
  const doc = node.ownerDocument;
  if (doc === null) return null;
  const range = doc.createRange();
  range.selectNode(node);
  return range.getBoundingClientRect();
}

/**
 * Where the caret goes for a click that landed on a **host's own box** rather
 * than on any of its content — an index among `host.childNodes`.
 *
 * The problem it answers (user report, 2026-09-05: "I clicked to the right of
 * the block and the caret went to the first position"). An inline chip is
 * `contenteditable="false"` and a cell often holds nothing else, so there is no
 * text node after it for a browser to put a caret in. Clicking past it, engines
 * fall back to the start of the cell — and then Backspace has nothing behind it
 * and does nothing, which is what made the chip feel undeletable. The chip has
 * to behave like the one character it looks like, and that starts with being
 * able to stand *after* it.
 *
 * A Range can name that position perfectly well — `(host, index + 1)` — it is
 * only the click that cannot find it. So the click is answered here instead.
 *
 * Vertical distance dominates, because a wrapped cell has several lines and the
 * line clicked on decides before anything else does; within the nearest child,
 * the pointer past its midpoint means after it. Children with no box at all
 * (an empty text node) are skipped: they are not a place, and they would win
 * every distance test by being nowhere.
 */
function caretIndexForClick(host: HTMLElement, x: number, y: number): number {
  const children = Array.from(host.childNodes);
  let index = 0;
  let nearest = Number.POSITIVE_INFINITY;
  for (let at = 0; at < children.length; at += 1) {
    const rect = nodeRect(children[at]);
    if (rect === null || (rect.width === 0 && rect.height === 0)) continue;
    const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
    const distance = dy * 10_000 + dx;
    if (distance >= nearest) continue;
    nearest = distance;
    index = x > (rect.left + rect.right) / 2 ? at + 1 : at;
  }
  return index;
}

/** One of a host's children, as much of it as the holder rule reads. */
export interface VeCaretChild {
  /** A text node: a caret can be put straight into it, so nothing is parked. */
  text: boolean;
  /** A `<br>`. It ends its line, and nothing may be parked after the last one. */
  ends: boolean;
}

/**
 * Where the caret goes for a click at `index` among children of this shape:
 * into a text node that is already there, into a holder parked at a position,
 * or nowhere this has to arrange — which is the browser's own job.
 *
 * Split out from {@link caretHolderAt} because it is the whole of the rule and
 * the DOM is the only thing keeping it from a test.
 *
 * **A blank line is not a place to park one** (user report, 2026-09-07:
 * "입력칸을 클릭할때 높이가 늘어나는 버그"). An empty region's one child is the
 * filler `<br>` that gives it its height (`editableBody`, dom.ts), and a click
 * anywhere right of its left edge asks for the position *after* that break —
 * where a holder is a character on a **second line**, so the empty paragraph
 * the author clicked into stood up twice as tall and the surface grew with it.
 * There is nothing to stand beside in an empty region and only one caret
 * position in it, which is the one an engine lands on unaided: no holder.
 *
 * The same break ends any region that finishes with one, so a holder that
 * would go last goes in front of it instead — the end of the line that was
 * clicked, rather than the start of an empty one under it.
 */
export function caretHolderSlot(
  children: readonly VeCaretChild[],
  index: number,
):
  | { kind: "text"; at: number; end: boolean }
  | { kind: "park"; at: number }
  | { kind: "none" } {
  const before = children[index - 1];
  const after = children[index];
  if (before !== undefined && before.text) return { kind: "text", at: index - 1, end: true };
  if (after !== undefined && after.text) return { kind: "text", at: index, end: false };
  if (children.every((child) => child.ends)) return { kind: "none" };
  const last = children.length - 1;
  return { kind: "park", at: index > last && children[last].ends ? last : index };
}

/**
 * A text position at `index` among `host`'s children, made if there is not one.
 *
 * The half of "click beside a chip" that a Range alone cannot do. A caret needs
 * a *text node*: an index into an element is a position the browser is free to
 * normalize away, and beside a `contenteditable="false"` chip with nothing else
 * in the cell it always does — to the start of the host, or into the next cell.
 *
 * So an existing text node on that side is used where there is one (and no
 * holder is added), and where there is not, one is parked: a single zero-width
 * space, which `withoutCaretHolders` (dom.ts) strips from every read, so the
 * document never carries a character the author did not type. It is the same
 * bargain `editableBody`'s labelled `<br>` filler already makes for an empty
 * region — markup that exists only to hold a caret, and that the reader drops.
 *
 * Which of the three a click asks for is {@link caretHolderSlot}'s; this is
 * the writing of it, and `null` is the answer that leaves the caret to the
 * browser.
 */
function caretHolderAt(
  host: HTMLElement,
  index: number,
): { node: Node; offset: number } | null {
  const children = Array.from(host.childNodes);
  const slot = caretHolderSlot(
    children.map((child) => ({
      text: child.nodeType === TEXT_NODE,
      ends: child.nodeName === "BR",
    })),
    index,
  );
  if (slot.kind === "none") return null;
  if (slot.kind === "text") {
    const node = children[slot.at];
    return { node, offset: slot.end ? (node.nodeValue ?? "").length : 0 };
  }
  const holder = host.ownerDocument.createTextNode(CARET_HOLDER);
  host.insertBefore(holder, children[slot.at] ?? null);
  return { node: holder, offset: 1 };
}

/** The vertical extent of a whole block unit — a list run can be several roots. */
function unitExtent(members: readonly Node[]): { top: number; bottom: number } | null {
  let extent: { top: number; bottom: number } | null = null;
  for (const member of members) {
    const rect = nodeRect(member);
    if (rect === null) continue;
    extent =
      extent === null
        ? { top: rect.top, bottom: rect.bottom }
        : { top: Math.min(extent.top, rect.top), bottom: Math.max(extent.bottom, rect.bottom) };
  }
  return extent;
}

/**
 * What a block can be turned into. A table, a rule and an atomic chip can be
 * turned into nothing — re-tagging any of the three loses the block outright
 * (`isFrozenBlock`) — and an empty list drops the whole "turn into" section of
 * the handle's menu rather than offering rows that would refuse.
 */
function formatsForBlock(block: HTMLElement | null): readonly VeBlockFormat[] {
  return block === null || isFrozenBlock(block) ? [] : BLOCK_FORMATS;
}

/**
 * What the slash menu needs to know about the block the caret is in, so it can
 * leave out the rows that would do nothing there (`VeSlashBlock`).
 *
 * Every term is a question this file already answers for one of the other
 * controls — the handle's two arrows are `blockMoveTarget`, and the format is
 * the one the bubble menu's "Turn into" reads — asked here on the catalogue's
 * behalf so the two cannot disagree about a block.
 *
 * A **list** reports no format at all, deliberately: `formatOfBlock` calls one
 * "paragraph" because that is what the format rows can turn it into, and
 * hiding "Normal text" in a list would hide the row that leaves the list.
 */
function slashBlockAt(root: HTMLElement, node: Node | null): VeSlashBlock | null {
  const block = nearestBlock(root, node);
  if (block === null) return null;
  const position = blockUnitPosition(root, block);
  const inList = isListElement(block);
  return {
    format: inList || isFrozenBlock(block) ? null : formatOfBlock(block),
    // Everything `execCommand("outdent")` has something to take away from: a
    // list item (it leaves the list, or one level of it) and the blockquote a
    // browser writes for an indent. In a plain paragraph it does nothing.
    canOutdent: inList || block.nodeName === "BLOCKQUOTE",
    canMoveUp: position !== null && blockMoveTarget(position.count, position.index, "up") !== null,
    canMoveDown:
      position !== null && blockMoveTarget(position.count, position.index, "down") !== null,
  };
}

/** The atomic chip an event landed in, if any. */
function atomicAt(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const found = target.closest("[data-ve-src]");
  return found instanceof HTMLElement ? found : null;
}

/**
 * The table the caret or the pointer is in, and the cell inside it — or null,
 * which is the answer everywhere the controls must not appear (§3.2).
 *
 * Three refusals, and each is one of the requirements:
 *
 * - **Not a table block.** The cell has to belong to a `<table>` that is a
 *   direct child of the root, because a direct child is what `domToDocument`
 *   reads as a block. A cell of a table nested inside another is in no row of
 *   either as far as the model is concerned (spec §7.9), so it gets nothing.
 * - **Not a refused table.** A table the model would not parse is an atomic
 *   chip whose *preview* holds a real `<table>` — the engine's rendering of the
 *   author's wikitext, which the model never held (§5). `nearestBlock` already
 *   answers the chip rather than the table inside it; `isInAtomic` says so
 *   twice, because the cost of being wrong here is a control that edits a
 *   preview and publishes nothing.
 * - **Not outside a cell.** A caret in the caption is in the table but not in
 *   a row, and every operation here is about a row or a column.
 *
 * `data-ve="table"` is deliberately NOT the test: a table the author pasted
 * carries none of our labels and is still read as a table block (dom.ts's
 * `classify`), and refusing to edit it until the next document load would be
 * this file disagreeing with the reader about what a table is.
 */
function tableAt(
  root: HTMLElement,
  node: Node | null,
): { table: HTMLElement; cell: HTMLElement } | null {
  const cell = nearestMatching(
    root,
    node,
    (element) => element.nodeName === "TD" || element.nodeName === "TH",
  );
  if (cell === null) return null;
  const block = nearestBlock(root, cell);
  if (block === null || block.nodeName !== "TABLE" || isInAtomic(block)) return null;
  return { table: block, cell };
}

/** The cell at a spot in a walked table, or null where the table is ragged past it. */
function cellAt(
  rows: readonly (readonly VeTableNode[])[],
  row: number,
  column: number,
): HTMLElement | null {
  if (row < 0 || row >= rows.length) return null;
  const cells = rows[row];
  if (column < 0 || column >= cells.length) return null;
  const cell = cells[column];
  return cell instanceof HTMLElement ? cell : null;
}

/**
 * A caret host that holds inline content and nothing else (wikitext-spec §7.3):
 * a table cell, or a table caption.
 *
 * One spelling, because three places used to carry their own copy and each was
 * a place for the rule to drift: what a paste may put here, what the menus may
 * offer here, and what an insertion may write here.
 */
function isCellHost(host: HTMLElement | null): boolean {
  if (host === null) return false;
  return host.nodeName === "TD" || host.nodeName === "TH" || host.nodeName === "CAPTION";
}

/**
 * The right-click menu's rows for one opening — pure, so what a block offers
 * can be asserted without a pointer.
 *
 * Two vocabularies, in the order the author's attention is in: the cell's
 * operations first (they are why anyone right-clicks a table), then the
 * block's own. Neither list is written here — `TABLE_OPS` and `blockMenuRows`
 * are the same two the axis menus and the gutter grip draw, so a row reached
 * one way cannot mean something else reached the other.
 *
 * A table operation the cell **cannot** be given is left out rather than
 * listed disabled, exactly as the slash menu leaves it out: a menu that is
 * read rather than filtered has no room for rows that refuse. A block row that
 * cannot fire keeps its place and is disabled, because those are the same four
 * rows every time and a list that changed length at the ends of a document
 * would move under the pointer.
 */
export function contextMenuRows(
  state: VeContextState,
  // Only the two bags it reads, so the decision can be exercised without
  // building a whole dictionary — `tableRefusalNote`'s bargain, one control on.
  labels: Pick<VisualEditorLabels, "table" | "handle">,
  applyTableOp: (cell: HTMLElement | null, op: VeTableOp, confirmed: boolean) => void,
  runBlockCommand: (block: HTMLElement | null, command: BlockMenuCommand) => void,
): VeContextRow[] {
  const rows: VeContextRow[] = [];
  const table = state.table;
  if (table !== null) {
    for (const op of TABLE_OPS) {
      if (!table.context.can[op]) continue;
      rows.push({
        key: `table-${op}`,
        label: tableOpLabel(op, labels.table, table.context.headerRow),
        icon: tableOpIcon(op),
        // The group rules are the axis menus' own, minus one that would open
        // the list with a rule above nothing.
        startsGroup: tableOpStartsGroup(op) && rows.length > 0,
        onSelect: () => applyTableOp(table.cell, op, false),
      });
    }
  }

  const blockRows = blockMenuRows({
    canMoveUp: state.up,
    canMoveDown: state.down,
    formats: state.formats,
    labels: labels.handle,
  });
  blockRows.forEach((row, index) => {
    rows.push({
      key: `block-${index}`,
      label: row.label,
      disabled: row.disabled,
      // The first block row opens a group of its own whenever a table put
      // rows above it; after that the grip menu's own grouping stands.
      startsGroup: row.startsGroup || (index === 0 && rows.length > 0),
      heading: row.heading ?? undefined,
      onSelect: () => runBlockCommand(state.block, row.command),
    });
  });
  return rows;
}

/**
 * The thing a Backspace (or a Delete) at this caret would eat **whole**, or
 * null — a chip, or a block the caret cannot type inside.
 *
 * **Why the surface has to answer this at all.** A chip is
 * `contenteditable="false"`, and what a browser does to one beside the caret is
 * its own business: one selects it, another eats a character of the wrapper,
 * and inside a table cell — where a version tag most often is — several do
 * nothing at all. The author presses Backspace next to a chip and the chip
 * stays.
 *
 * It is **every** atomic, not only a version block (user direction,
 * 2026-09-05): a template call, a picture, a category, a `<ref>` are all one
 * `[data-ve-src]` node standing in a run of text, and a rule that held for one
 * of them would be a rule the author has to remember the shape of.
 *
 * **And every frozen block, which is how a table is deleted** (user report,
 * 2026-09-06: "backspace를 사용해서 table이 지워지지도 않아"). A table and a
 * `----` are the two blocks that are *not* chips — a table's cells are ordinary
 * editable regions (§3), a rule is an `<hr>` — so this walk did not see them
 * and no browser deletes either from outside: the caret at the start of the
 * paragraph under a table pressed Backspace and nothing whatsoever happened.
 * They are only matched **as blocks of the root**, never as markup inside a
 * chip's rendered preview, which is the engine's drawing and not the buffer.
 *
 * The walk itself is `atomicBeside` in ve-selection.ts, over a node interface a
 * real `Node` satisfies structurally — which is what lets it be *tested*, in a
 * node environment with no DOM in it. This is the adapter: the caret's host,
 * and what counts as one whole thing.
 */
function frozenBesideCaret(
  root: HTMLElement,
  range: Range,
  direction: -1 | 1,
): HTMLElement | null {
  if (!range.collapsed) return null;
  const host = caretHost(root, range.startContainer);
  if (host === null) return null;
  const found = atomicBeside(
    host,
    range.startContainer,
    range.startOffset,
    direction,
    (node) =>
      node instanceof HTMLElement &&
      (node.hasAttribute("data-ve-src") || (isFrozenBlock(node) && node.parentNode === root)),
    // Past the host only from an ordinary block: a caret at the start of a line
    // with a chip standing as the block above it is the one shape where every
    // editor reaches out. A cell, a caption and a list item keep their walls —
    // which is also what stops a table from being eaten from inside itself.
    LINE_HOSTS.has(host.nodeName) ? null : root,
  );
  return found instanceof HTMLElement ? found : null;
}

/**
 * Whether `range` holds the whole of `node` — the element itself, or every
 * last thing inside it.
 *
 * **Both, because Chrome's table selection is the second** (user report,
 * 2026-09-06: "아직도 표가 한번에 안지워져", with a screenshot of every cell drawn
 * blue). The state the engine puts a table into does not select the `<table>`:
 * it runs from inside the first cell to inside the last, so a test written
 * against `selectNode` answered "no" for the very selection the author was
 * looking at, and the Backspace fell through to a plain range delete — which
 * empties the cells and leaves the table standing. `selectNodeContents` is the
 * reading that matches what is drawn on screen, and it costs nothing elsewhere:
 * the caller has already required a **frozen** block, and a run of text
 * selected inside a paragraph is not one.
 */
function rangeCoversNode(range: Range, node: Node): boolean {
  const doc = node.ownerDocument;
  if (doc === null) return false;
  const covers = (build: (target: Range) => void): boolean => {
    const whole = doc.createRange();
    try {
      build(whole);
      return (
        range.compareBoundaryPoints(Range.START_TO_START, whole) <= 0 &&
        range.compareBoundaryPoints(Range.END_TO_END, whole) >= 0
      );
    } catch {
      return false;
    }
  };
  return covers((target) => target.selectNode(node)) ||
    covers((target) => target.selectNodeContents(node));
}

/**
 * The table (or rule) a Backspace would eat because it is **already selected**
 * — the state an author is in when there is no caret on screen at all and the
 * block is drawn the way a drag-selection is (user report, 2026-09-06: "커서는
 * 안보이고 표를 드래그해서 선택한거처럼 보여").
 *
 * Chrome puts a table into that state by itself, and then wants a *second*
 * Backspace before it will delete it — while this surface's own handling bows
 * out of every non-collapsed selection, on the grounds that a selection is the
 * browser's to delete. For an ordinary run of text that is right. For a whole
 * table it is how the key came to need pressing twice.
 *
 * Deliberately strict: exactly **one** block of the root may be touched, it has
 * to be covered whole, and it has to be a block the caret cannot stand in. A
 * selection that spans a table *and* the paragraph under it is a plain range
 * delete and stays the browser's; a chip keeps `removeAtomic`, which knows
 * about its preview and its chrome.
 */
function frozenBlockInSelection(root: HTMLElement, range: Range): HTMLElement | null {
  if (range.collapsed) return null;
  let found: HTMLElement | null = null;
  for (const child of Array.from(root.children)) {
    if (!rangeTouchesNode(range, child)) continue;
    if (found !== null) return null;
    if (!rangeCoversNode(range, child)) return null;
    found = child instanceof HTMLElement ? child : null;
    if (found === null) return null;
  }
  if (found === null || !isFrozenBlock(found) || found.hasAttribute("data-ve-src")) return null;
  return found;
}

/**
 * The table a Backspace (or a Delete) would eat **from inside it**, or null.
 *
 * `frozenBesideCaret` keeps a cell's walls, and it must: Backspace at the start
 * of the third cell may not reach back into the second and delete something the
 * author cannot see the caret next to. But at the very **start of the first
 * cell** there is nothing of the table behind the caret at all — the thing
 * behind it is the table — and at the very end of the last cell, nothing ahead.
 *
 * Which is also why this takes no behaviour away: at those two positions a
 * browser does nothing whatsoever with the key. There is no cell to merge with
 * and no character to eat, so the press was already being thrown away — and the
 * author who has just made a table with `/table` and wants it gone is standing
 * in one of those two places (user report, 2026-09-06: "backspace로는 지워지지도
 * 않아", after the same key outside the table was made to work).
 */
function tableAtCaretEdge(
  root: HTMLElement,
  range: Range,
  direction: -1 | 1,
): HTMLElement | null {
  if (!range.collapsed) return null;
  const found = tableAt(root, range.startContainer);
  if (found === null) return null;
  const rows = tableRowsOf(found.table);
  if (rows.length === 0) return null;
  if (direction === -1) {
    if (cellAt(rows, 0, 0) !== found.cell) return null;
    // Nothing in front of the caret that the model would keep — a caret on the
    // cell's second line is not at its start, and a holder is not content.
    return cellSideIsBare(found.cell, range, -1) ? found.table : null;
  }
  const last = rows.length - 1;
  if (cellAt(rows, last, rows[last].length - 1) !== found.cell) return null;
  return cellSideIsBare(found.cell, range, 1) ? found.table : null;
}

/**
 * The zero-width characters the surface parks a caret in — the same pair
 * `lineTextOf` knows about (ve-selection.ts). They are markup, never content:
 * `withoutCaretHolders` takes them out of every read, so a rule that counted
 * one would be counting a character the author cannot see and never typed.
 */
const CARET_HOLDERS = /[​﻿]/g;

/** Whether a run of text is holder padding and nothing else. */
function isHolderOnly(text: string): boolean {
  return text.replace(CARET_HOLDERS, "") === "";
}

/**
 * Whether the cell holds nothing on one side of the caret that a delete could
 * take.
 *
 * **This is what a holder broke** (user report, 2026-09-06, after the rim guard
 * below was already in place: "아직도 마찬가지야"). Both rim rules used to ask
 * `hostText(...).offset === 0`, and clicking into a cell is exactly what makes
 * that answer wrong: a press on a cell's own box parks a `​` and puts the
 * caret **after** it (`caretHolderAt`), which is the only way to get a caret
 * beside a `contenteditable="false"` chip at all — and `lineTextOf` maps a
 * holder to a space to keep its offsets aligned, so the caret then reads as
 * offset **1**. Every guard returned null, the key went to Chrome, and Chrome
 * answers a Backspace at a cell's start by selecting the whole table. The
 * author's own cell — two version chips, nothing else — could not be reached
 * any other way, so for them the rim guard never once ran.
 *
 * Asked of the DOM rather than of a flattened string, so nothing has to stay
 * aligned: everything between the cell's edge and the caret is cloned and
 * looked at. An atomic is a whole thing the author can see and a `<br>` they
 * made is a line — either is something for the key to eat. A **filler** break
 * is neither: it is what gives an empty region its height (dom.ts,
 * `editableBody`), and so is a holder.
 */
function cellSideIsBare(cell: HTMLElement, range: Range, direction: -1 | 1): boolean {
  const side = cell.ownerDocument.createRange();
  try {
    side.selectNodeContents(cell);
    if (direction === -1) side.setEnd(range.startContainer, range.startOffset);
    else side.setStart(range.endContainer, range.endOffset);
  } catch {
    return false;
  }
  const piece = side.cloneContents();
  if (piece.querySelector("[data-ve-src]") !== null) return false;
  for (const line of Array.from(piece.querySelectorAll("br"))) {
    if (!line.hasAttribute("data-ve-filler")) return false;
  }
  return (piece.textContent ?? "").replace(CARET_HOLDERS, "") === "";
}

/**
 * The cell a Backspace (or a Delete) is standing on the rim of — the caret at
 * the very start of its content, or the very end — or null.
 *
 * **A cell's walls are the surface's to hold, not the browser's** (user report,
 * 2026-09-06: "table에서 backspace를 누를때 한번에 지워지지 않고 선택이 되는"). Left
 * to Chrome, a Backspace at the start of a cell does not merge the two cells
 * and does not do nothing either: it puts the **whole table** into a selection
 * — every cell drawn blue, no caret on screen — and waits for a second press,
 * which then takes the table or empties it depending on where the selection
 * landed. Neither half of that is an edit anybody asked for, and the author who
 * only meant to delete a character sees their table light up instead.
 *
 * `frozenBesideCaret` already refuses to walk out of a cell, and
 * `tableAtCaretEdge` answers for the two rims where the whole table is the
 * thing behind (or ahead of) the caret. This is every other rim, and the answer
 * there is that the key is **spent**: there is no character to eat, no cell to
 * merge with — a merged cell is not something wikitext can say (spec §7.3) —
 * and so nothing whatsoever should happen. Prevented rather than left alone,
 * because "nothing" is precisely what the browser will not do.
 */
function cellAtCaretEdge(root: HTMLElement, range: Range, direction: -1 | 1): HTMLElement | null {
  if (!range.collapsed) return null;
  const found = tableAt(root, range.startContainer);
  if (found === null) return null;
  return cellSideIsBare(found.cell, range, direction) ? found.cell : null;
}

/* ---------------- dragging something into a new place (§3.4) -------- */

/**
 * The three attributes the drag draws with, and the one inline style it
 * writes.
 *
 * **None of them can reach the buffer.** `domToDocument` reads a block out of
 * its children, a row and a cell out of `data-ve-attrs`, and an atomic out of
 * `data-ve-src`; a `style` attribute and a `data-ve-*` marker are read by
 * nothing and published by nothing. That is the same bargain §3 makes for the
 * caret's cell ring and the empty line's hint — a hint inside the
 * contenteditable is an attribute and a stylesheet rule, never markup — and it
 * is why the animation can move the author's own elements instead of a copy of
 * them. Which is what the direction asked for: *the element* goes to the
 * pointer, not a picture of it.
 *
 * They are still swept off before every commit, because an element left
 * holding a transform would sit where the drag left it rather than where the
 * document now puts it.
 */
const SORT_DRAGGING_ATTR = "data-ve-dragging";
const SORT_SHIFT_ATTR = "data-ve-shift";
const SORT_SETTLING_ATTR = "data-ve-settling";

/** How long the shift and the settle take; matched by globals.css. */
const SORT_SETTLE_MS = 160;

/**
 * How far the pointer must travel before a press on a grip becomes a drag.
 *
 * Both grips are also buttons — the block grip opens the gutter menu, the axis
 * tabs open their own — so a press that never moves has to stay a click. Five
 * pixels is the usual answer: below it a click is a click even from an unsteady
 * hand, above it nobody means to click.
 */
const SORT_THRESHOLD = 5;

/** Move `element` by `(x, y)`, or put it back where the document has it. */
function setSortOffset(element: HTMLElement, x: number, y: number): void {
  if (x === 0 && y === 0) element.style.removeProperty("transform");
  else element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

/**
 * Take every trace of a drag back off the surface.
 *
 * Swept rather than remembered: an undo, a document load or a second drag can
 * all leave an element marked that this no longer holds a reference to, and one
 * `querySelectorAll` over a page is cheaper than the element that stayed
 * translated.
 */
function clearSortStyles(root: HTMLElement | null): void {
  if (root === null) return;
  const marked = root.querySelectorAll<HTMLElement>(
    `[${SORT_DRAGGING_ATTR}], [${SORT_SHIFT_ATTR}], [${SORT_SETTLING_ATTR}]`,
  );
  for (const element of Array.from(marked)) {
    element.removeAttribute(SORT_DRAGGING_ATTR);
    element.removeAttribute(SORT_SHIFT_ATTR);
    element.removeAttribute(SORT_SETTLING_ATTR);
    element.style.removeProperty("transform");
    if (element.getAttribute("style") === "") element.removeAttribute("style");
  }
}

/** Attribute naming the cell the caret is in; read only by globals.css. */
const CELL_HERE_ATTR = "data-ve-here";

/**
 * Mark the caret's cell, and unmark whichever held the mark before.
 *
 * A cell cannot draw its own focus ring: the editing host is the surface, so
 * `:focus-within` never fires on a `<td>` and every cell of every table looks
 * the same as the one being typed into. The mark is an attribute and a
 * stylesheet rule for the reason §3 gives for all of this chrome — an
 * attribute is not content, so `domToDocument` (which reads a cell out of
 * `data-ve-attrs` and its children, and nothing else) can never publish it.
 *
 * The whole surface is swept rather than a previous cell remembered: an undo
 * or a document load can restore a marked cell we no longer hold a node for,
 * and one `querySelectorAll` over a handful of tables is cheaper than the bug.
 */
function markCellHere(root: HTMLElement | null, cell: HTMLElement | null): void {
  if (root === null) return;
  for (const marked of Array.from(root.querySelectorAll(`[${CELL_HERE_ATTR}]`))) {
    if (marked !== cell) marked.removeAttribute(CELL_HERE_ATTR);
  }
  if (cell !== null) cell.setAttribute(CELL_HERE_ATTR, "true");
}

/** The `[data-ve-body]` an atomic's preview goes into, created if missing. */
function atomicBody(node: HTMLElement, inline: boolean): HTMLElement {
  for (const child of Array.from(node.children)) {
    if (child instanceof HTMLElement && child.hasAttribute("data-ve-body")) {
      child.className = "ve-atomic-body";
      return child;
    }
  }
  // An inline atomic is written by `inlineToHtml` as a bare labelled span, so
  // the body has to be made here; the label becomes its first content.
  const body = node.ownerDocument.createElement(inline ? "span" : "div");
  body.setAttribute("data-ve-body", "");
  body.className = "ve-atomic-body";
  while (node.firstChild !== null) body.appendChild(node.firstChild);
  node.appendChild(body);
  return body;
}

/** Empties the preview, so an edited node never shows its predecessor's. */
function resetAtomicBody(node: HTMLElement): void {
  for (const child of Array.from(node.children)) {
    if (!child.hasAttribute("data-ve-body")) continue;
    child.textContent = "";
    // The placeholder is drawn by a pseudo-element, so emptying the node does
    // not take it away: an edited chip would keep the previous source's "this
    // renders nothing" dash while the new one was still being fetched.
    child.removeAttribute(BLANK_ATTR);
  }
}

function actionButton(doc: Document, act: string, label: string, icon: string): HTMLElement {
  const button = doc.createElement("button");
  button.type = "button";
  button.setAttribute("data-ve-act", act);
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  button.className = ACTION_BUTTON;
  button.innerHTML = icon;
  return button;
}

/**
 * The sentence a refused table's chip carries — the parser's own reason,
 * localized — or null for anything that is not a refused table.
 *
 * The requirement it answers is small and worth stating: a table that stayed a
 * chip behaves differently from the table beside it, and an author who is not
 * told why has to guess, or conclude that the editor cannot do tables. Every
 * one of these reasons is a construct the model cannot carry without rewriting
 * somebody's article (§4), so the honest thing is to name it and leave the
 * wikitext dialog as the way in.
 *
 * Only the labels it actually needs are taken, so the decision can be exercised
 * without building a whole dictionary.
 */
export function tableRefusalNote(
  source: string,
  labels: Pick<VisualEditorLabels, "tableRefusedWhy" | "tableRefusals">,
): string | null {
  if (atomicKindOf(source) !== "table") return null;
  const parse = parseTableWikitext(source);
  if (parse.ok) return null;
  return formatMessage(labels.tableRefusedWhy, { reason: labels.tableRefusals[parse.reason] });
}

/**
 * Dresses one atomic node as the chip §5 describes: a head row naming what it
 * is with Fandom's edit/remove affordances, over a body the preview lands in.
 *
 * Idempotent, and cheap when it has nothing to do — it runs after every
 * command and every input, because an undo can restore a node we decorated in
 * a previous life. The buttons carry no listeners of their own; the surface
 * delegates by `data-ve-act`, so a restored chip works without re-binding.
 *
 * Nothing written here can reach the serializer: `domToDocument` emits an
 * atomic from `data-ve-src` and never looks inside it.
 */
function decorateAtomic(node: HTMLElement, labels: VisualEditorLabels): void {
  const source = node.getAttribute("data-ve-src");
  if (source === null) return;
  const kind = atomicKindOf(source);
  if (node.classList.contains("ve-atomic") && node.getAttribute("data-ve-kind") === kind) return;

  const doc = node.ownerDocument;
  const inline = node.nodeName === "SPAN";
  node.setAttribute("contenteditable", "false");
  node.setAttribute("data-ve-kind", kind);
  node.classList.add("ve-atomic");
  if (inline) node.classList.add("ve-atomic--inline");

  const body = atomicBody(node, inline);
  // An inline chip sits in a run of text, so it has no head row: its label is
  // its body, and the toolbar is the way into it.
  if (inline) return;

  for (const child of Array.from(node.children)) {
    if (child.classList.contains("ve-atomic-head")) child.remove();
    else if (child.classList.contains("ve-atomic-why")) child.remove();
  }

  const name = labels.kinds[kind];
  const head = doc.createElement("div");
  head.className = "ve-atomic-head";
  head.setAttribute("contenteditable", "false");

  const icon = doc.createElement("span");
  icon.className = "ve-atomic-head-icon";
  icon.innerHTML = KIND_ICON;
  head.appendChild(icon);

  const label = doc.createElement("span");
  label.className = "ve-atomic-head-label";
  label.textContent = name;
  head.appendChild(label);

  const actions = doc.createElement("span");
  actions.className = "ve-atomic-head-actions";
  actions.appendChild(
    actionButton(doc, "edit", formatMessage(labels.edit, { label: name }), PENCIL_ICON),
  );
  actions.appendChild(
    actionButton(doc, "remove", formatMessage(labels.remove, { label: name }), TRASH_ICON),
  );
  head.appendChild(actions);

  node.insertBefore(head, body);

  // Why this table is a chip and the one three paragraphs down is a grid (§2).
  // Without it the difference looks arbitrary — and the answer is never
  // "because tables are not editable", it is one specific construct in this
  // one table, which the parser already knows the name of.
  const note = tableRefusalNote(source, labels);
  if (note !== null) {
    const why = doc.createElement("p");
    why.className = "ve-atomic-why";
    why.textContent = note;
    node.insertBefore(why, body);
  }
}

function decorateAtomics(root: HTMLElement, labels: VisualEditorLabels): void {
  for (const node of Array.from(root.querySelectorAll("[data-ve-src]"))) {
    if (node instanceof HTMLElement) decorateAtomic(node, labels);
  }
}

/* ---------------- the in-place branch field (§6) ---------------- */

/** The field element hanging off an atomic node, if it has one. */
function branchFieldOf(node: HTMLElement): HTMLElement | null {
  for (const child of Array.from(node.children)) {
    if (child instanceof HTMLElement && child.hasAttribute(BRANCH_ATTR)) return child;
  }
  return null;
}

/** True for anything inside a branch field — its textarea, its head, its button. */
function inBranchField(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${BRANCH_ATTR}]`) !== null;
}

/** The branch textarea an event came from, or null for everything else. */
function branchInputOf(target: EventTarget | null): HTMLTextAreaElement | null {
  if (!(target instanceof HTMLTextAreaElement)) return null;
  return target.hasAttribute(BRANCH_BODY_ATTR) ? target : null;
}

/**
 * The branch field's identity — and therefore the one moment it is rebuilt.
 *
 * This is the rule that keeps a live textarea safe from every pass over the
 * surface: the field is rewritten when this string changes and at no other
 * time. Two different previewed versions that render the *same* branch
 * (`[v56, v73]` at v70 and at v65) give the same key, so switching between
 * them cannot take a half-typed word away; a version that renders a different
 * branch gives a different one, which is the swap the strip promises.
 *
 * The lock is in it because a surface can become editable after it loaded —
 * `/api/auth/me` answers a moment late — and nothing else would turn the
 * textarea writable. `covers` is in it for the same kind of reason: the same
 * passage is edited at v69 and at v70, but only one of the two carries the note
 * saying the preview above is empty on purpose (§6, amended 2026-09-05), and a
 * key that ignored it would leave that note behind — or never draw it.
 *
 * Null means no field at all: a block `versionTagSpans` cannot find a passage
 * in, which keeps the read-only preview and the raw-wikitext dialog.
 */
export function branchFieldKey(
  state: VersionFieldState,
  version: string,
  locked: boolean,
): string | null {
  if (state.kind === "unsupported") return null;
  const lock = locked ? "ro" : "rw";
  if (state.kind === "missing") return `${lock}+${version}`;
  return `${lock}=${state.branch.id.trim()}${state.covers ? "" : `@${version}`}`;
}

/**
 * Draws — or leaves alone — the field that makes a versions block editable in
 * place: a `<textarea>` under the rendered preview, holding the branch this
 * surface is currently previewing (versioning.md §6, amended 2026-09-03).
 *
 * **Why a form control rather than a nested editable region.** The node stays
 * `contenteditable="false"`, which is what keeps §4 true: `domToDocument`
 * emits an atomic out of `data-ve-src` and never out of what is drawn inside
 * it, so the block's wikitext remains the only thing that gets published. A
 * `<textarea>` inside such a node is interactive in its own right — its own
 * editing host, its own caret, its own undo stack, its own IME composition —
 * and typing in it does not disturb the surrounding contenteditable at all,
 * which is exactly why it is safe here. A nested `contenteditable="true"`
 * would be the opposite bargain: one editing host holding two models, where
 * every command, paste, selection and undo has to be told which half it is in.
 *
 * The head row names the branch, never the chip's selected version, because
 * boundaries `[v56, v73]` previewed at v70 show — and therefore edit — the v56
 * branch (§6 rule 1). Naming it v70 there would be the failure this feature
 * exists to fix, one label further along.
 *
 * Idempotent, and deliberately blind while it is: the field is rebuilt only
 * when `data-ve-branch` would change, so a pass over the surface can never
 * rewrite the value of a textarea somebody is typing into.
 */
function syncBranchField(
  node: HTMLElement,
  version: string,
  labels: VisualEditorLabels,
  locked: boolean,
): void {
  const source = node.getAttribute("data-ve-src");
  const existing = branchFieldOf(node);
  // An inline construct keeps its dialog: a chip inside a run of text has no
  // head row to name a branch in, and a textarea in one would break the line.
  if (source === null || node.nodeName === "SPAN" || atomicKindOf(source) !== "versions") {
    existing?.remove();
    return;
  }

  const state = versionFieldState(source, version);
  const key = branchFieldKey(state, version, locked);
  // No field: a block with no passage this can splice — prose beside the tags,
  // an unclosed or mismatched tag, an attribute the name does not carry. It
  // keeps the read-only preview and the raw-wikitext dialog. (A null key IS
  // that case; naming it twice narrows `state` below without an assertion.)
  if (key === null || state.kind === "unsupported") {
    existing?.remove();
    return;
  }
  // Same key, same field — and the textarea is left untouched, which is what
  // stops any pass over the surface from rewriting one somebody is typing in.
  if (existing !== null && existing.getAttribute(BRANCH_ATTR) === key) return;
  existing?.remove();

  const doc = node.ownerDocument;
  const field = doc.createElement("div");
  field.className = "ve-atomic-branch";
  field.setAttribute(BRANCH_ATTR, key);
  field.setAttribute("contenteditable", "false");

  if (state.kind === "missing") {
    // No passage at all — a block whose tags this could not read. It keeps the
    // read-only preview and says why.
    const note = doc.createElement("p");
    note.className = "ve-atomic-branch-note";
    note.textContent = formatMessage(labels.branchMissing, { version });
    field.appendChild(note);

    node.appendChild(field);
    return;
  }

  // The head row names the passage's own starting version — the boundary the
  // strip has marked active — never the chip's selection (§6 rule 1).
  const id = state.branch.id.trim();
  const branchName = id;
  // A `<label>` wrapping its control associates the two without an id, which
  // is what this subtree wants: React never diffs it, and every id in here is
  // minted by hand.
  const label = doc.createElement("label");
  label.className = "ve-atomic-branch-label";

  const head = doc.createElement("span");
  head.className = "ve-atomic-branch-head";
  head.textContent = formatMessage(labels.branchHeading, { branch: branchName });
  label.appendChild(head);

  const input = doc.createElement("textarea");
  input.className = "ve-atomic-branch-input";
  input.setAttribute(BRANCH_BODY_ATTR, id);
  input.rows = 3;
  // A locked surface still shows the branch — reading which version says what
  // is half of why the field is here — but takes nothing back from it.
  input.readOnly = locked;
  input.value = state.branch.body;
  label.appendChild(input);

  field.appendChild(label);

  // The previewed version renders nothing from this block, and the field is
  // showing the nearest passage it does have (amended 2026-09-05 by user:
  // version blocks are editable at every version). The head row already names
  // that passage's own id, so nothing is written under a version it was not
  // typed for — but the preview above is empty, and an author who is not told
  // why reads it as the field having failed. So the note that used to stand
  // *instead of* the field now stands under it.
  if (!state.covers) {
    const note = doc.createElement("p");
    note.className = "ve-atomic-branch-note";
    note.textContent = formatMessage(labels.branchElsewhere, { version, branch: branchName });
    field.appendChild(note);
  }

  node.appendChild(field);
}

function syncBranchFields(
  root: HTMLElement,
  version: string,
  labels: VisualEditorLabels,
  locked: boolean,
): void {
  for (const node of Array.from(root.querySelectorAll("[data-ve-src]"))) {
    if (node instanceof HTMLElement) syncBranchField(node, version, labels, locked);
  }
}

/**
 * What one fragment came back as: the engine's HTML — `""` included, which
 * means "this renders nothing at this version" — or {@link FRAGMENT_FAILED}.
 */
type VeFragmentResult = string | null;

/** A render that threw, was too big to send, or never arrived. */
const FRAGMENT_FAILED = null;

/** Marks a chip body the engine rendered to nothing; drawn by globals.css. */
const BLANK_ATTR = "data-ve-blank";

/**
 * A chip whose wikitext renders nothing at the version being previewed.
 *
 * It cannot simply be left empty. An inline chip is `contenteditable="false"`
 * and zero characters wide with nothing in it — invisible, unclickable, and
 * impossible to delete or to scope to another version, while still being
 * published. So the node keeps a mark the stylesheet draws a placeholder for,
 * and says in its tooltip what an empty chip means. The placeholder is
 * punctuation rather than words, because no user-visible English may live in a
 * stylesheet; the sentence is a `title`, which comes from the dictionary.
 */
function paintBlank(body: HTMLElement, labels: VisualEditorLabels): void {
  body.textContent = "";
  body.setAttribute(BLANK_ATTR, "true");
  body.setAttribute("title", labels.renderedEmpty);
}

/** The wikitext itself, shown when a fragment failed or was too big to send. */
function paintSource(node: HTMLElement, body: HTMLElement, inline: boolean): void {
  const chip = node.ownerDocument.createElement(inline ? "span" : "div");
  chip.className = "ve-atomic-source";
  chip.textContent = node.getAttribute("data-ve-src") ?? "";
  body.textContent = "";
  body.appendChild(chip);
}

/**
 * Puts a rendered fragment into a node.
 *
 * `innerHTML` is safe here for the same reason `WikiHtml` uses it: the string
 * came from `renderPreview()`, which is the engine's own sanitized output.
 *
 * Three outcomes, and the middle one is the fix this signature exists for:
 *
 * - {@link FRAGMENT_FAILED} — the render threw, or the request never landed.
 *   The wikitext itself is drawn, which is what the dialog will open anyway.
 * - `""` — the engine rendered this fragment to **nothing**, on purpose. A
 *   version tag whose range does not reach the version being previewed says
 *   nothing at that version (versioning.md §2.1); so does a false `{{#if:}}`.
 *   Drawing the wikitext there — which is what happened while `""` meant
 *   "failed" — showed an author raw markup in a table cell every time they
 *   picked a version their tag was not written for.
 * - HTML — painted.
 */
function paintFragment(
  node: HTMLElement,
  html: VeFragmentResult,
  labels: VisualEditorLabels,
): void {
  const inline = node.nodeName === "SPAN";
  const body = atomicBody(node, inline);
  body.removeAttribute("data-ve-loading");
  body.removeAttribute("aria-busy");
  body.removeAttribute("title");
  body.removeAttribute(BLANK_ATTR);
  if (html === FRAGMENT_FAILED) {
    paintSource(node, body, inline);
    return;
  }
  if (html === "") {
    paintBlank(body, labels);
    return;
  }
  body.innerHTML = html;
  // `renderPreview` wraps even a one-word fragment in a paragraph, which would
  // put a block inside a run of text. An inline chip keeps the words and drops
  // the wrapper.
  if (!inline) return;
  for (const child of Array.from(body.children)) {
    if (child.nodeName === "P" || child.nodeName === "DIV") unwrapElement(child);
  }
}

function markLoading(node: HTMLElement, labels: VisualEditorLabels): void {
  const body = atomicBody(node, node.nodeName === "SPAN");
  body.removeAttribute(BLANK_ATTR);
  body.setAttribute("data-ve-loading", "true");
  body.setAttribute("aria-busy", "true");
  body.setAttribute("title", labels.rendering);
}

/**
 * What one fragment batch was fetched for: which document load, and the locale
 * and version its HTML was rendered at (versioning.md §6).
 */
interface VeFragmentScope {
  generation: number;
  locale: string;
  version: string;
}

/**
 * Whether a batch that has just come back may still be painted.
 *
 * A request outlives the surface it was made for: switching to another version
 * and back paints the cached fragments synchronously and issues no request of
 * its own, so nothing cancels the first one — and its `paint()` closure still
 * holds the version it was fetched at. Left unguarded it repaints every atomic
 * on screen with another patch's HTML, and nothing corrects that until the
 * whole document reloads: the author then reads and edits around an infobox
 * for a version they are not writing.
 *
 * `generation` is the load the batch belongs to and is the test that matters;
 * locale and version are compared too so that a batch can never paint into a
 * surface showing something other than what it rendered.
 */
export function fragmentScopeIsCurrent(batch: VeFragmentScope, surface: VeFragmentScope): boolean {
  return (
    batch.generation === surface.generation &&
    batch.locale === surface.locale &&
    batch.version === surface.version
  );
}

/** Cache key: two documents at different versions render differently (§6). */
function fragmentKey(locale: string, version: string, source: string): string {
  return `${locale} ${version} ${source}`;
}

/** Splits the distinct sources into requests the route will accept. */
function fragmentBatches(sources: readonly string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let chars = 0;
  for (const source of sources) {
    if (batch.length >= MAX_BATCH || chars + source.length > MAX_BATCH_CHARS) {
      if (batch.length > 0) batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(source);
    chars += source.length;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/**
 * `{ htmls, failed }` out of an untyped response; anything else counts as a
 * failure of the whole batch.
 *
 * The two answers a fragment can give are spelled apart here and nowhere else:
 * a string is HTML the engine produced (`""` included — a version tag outside
 * the previewed version renders nothing, and that is the right answer), and
 * {@link FRAGMENT_FAILED} is a render that threw or never arrived. Folding them
 * together is what showed authors the raw `<v69>aaa</v69>` in a table cell at
 * every version but v69.
 */
export function readFragments(body: unknown): (string | null)[] | null {
  if (body === null || typeof body !== "object" || !("htmls" in body)) return null;
  const value: unknown = body.htmls;
  if (!Array.isArray(value)) return null;
  const failedAt = new Set<number>();
  if ("failed" in body && Array.isArray(body.failed)) {
    for (const index of body.failed as unknown[]) {
      if (typeof index === "number") failedAt.add(index);
    }
  }
  const out: (string | null)[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const item: unknown = value[i];
    // A body that is not what the route promised is a failure of that index,
    // not an empty render: the route always sends a string.
    out.push(typeof item !== "string" || failedAt.has(i) ? FRAGMENT_FAILED : item);
  }
  return out;
}

/**
 * One document load: the HTML to write, or the news that the buffer could not
 * be read at all.
 *
 * The parse is handed in rather than reached for so this decision can be
 * exercised without one — and it is a decision, not plumbing: a load that
 * throws must not leave an empty *editable* surface behind. `domToDocument`
 * over that surface reads an empty article, `serializeDocument` makes `"\n"`
 * of it, and Publish posts that over a page nobody edited (§4).
 */
export function loadOutcome(
  content: string,
  parse: (text: string) => VeDocument,
): { ok: true; doc: VeDocument; html: string } | { ok: false } {
  try {
    const doc = parse(content);
    return { ok: true, doc, html: documentToHtml(doc) };
  } catch {
    return { ok: false };
  }
}

/**
 * Which sentence the delete dialog says, which is entirely a question of what
 * the author asked for.
 *
 * "Delete table" is a request; the other two are consequences — the last row
 * and the last column each take the table with them, because a table with no
 * rows renders nothing (spec §7.5) and the model holds no such thing. Saying
 * which of the three it is *before* it happens is the whole point of the
 * dialog: an author who meant to clear a row is entitled to know that the
 * table goes with it.
 */
export function tableDeleteMessage(
  op: VeTableOp,
  labels: Pick<
    VisualEditorLabels,
    "tableDeleteBody" | "tableDeleteLastRowBody" | "tableDeleteLastColumnBody"
  >,
): string {
  if (op === "deleteRow") return labels.tableDeleteLastRowBody;
  if (op === "deleteColumn") return labels.tableDeleteLastColumnBody;
  return labels.tableDeleteBody;
}

/**
 * Draws the read-only fallback for a buffer that could not be parsed: what went
 * wrong, over the wikitext itself, which is the one thing still known to be
 * true. Source mode is a click away and shows the same text, editable.
 */
function paintLoadFailure(root: HTMLElement, content: string, labels: VisualEditorLabels): void {
  const doc = root.ownerDocument;
  root.innerHTML = "";

  const notice = doc.createElement("div");
  notice.className = "ve-load-error";
  notice.setAttribute("role", "alert");
  notice.textContent = labels.loadError;
  root.appendChild(notice);

  const source = doc.createElement("div");
  source.className = "ve-load-source";
  // `textContent`, never `innerHTML`: this is the author's raw wikitext, and
  // the whole reason we are here is that nothing has made sense of it yet.
  source.textContent = content;
  root.appendChild(source);
}

/** Locks or unlocks the surface itself — the load effect's, not React's, call. */
function setSurfaceLocked(root: HTMLElement, locked: boolean): void {
  root.setAttribute("contenteditable", locked ? "false" : "true");
  if (locked) root.setAttribute("aria-readonly", "true");
  else root.removeAttribute("aria-readonly");
}

/** True while nothing an author could see is in the surface. */
function isSurfaceEmpty(root: HTMLElement): boolean {
  if (root.querySelector("[data-ve-src],hr,img") !== null) return false;
  return (root.textContent ?? "").trim() === "";
}

/** Which entry of `NORMAL TEXT ▾` the caret's block corresponds to. */
function formatOfBlock(block: HTMLElement | null): VeBlockFormat {
  if (block === null) return "paragraph";
  switch (block.nodeName) {
    case "H2":
      return "h2";
    case "H3":
      return "h3";
    case "H4":
      return "h4";
    case "H5":
      return "h5";
    default:
      // h1/h6 exist in the model but not in the menu (§1 offers 2–5), and a
      // list is "normal text" as far as that menu is concerned.
      return "paragraph";
  }
}

/** The tag and `data-ve` a format rewrites its block to. */
function tagForFormat(format: Exclude<VeBlockFormat, "pre">): { tag: string; ve: string } {
  switch (format) {
    case "paragraph":
      return { tag: "p", ve: "p" };
    case "h2":
      return { tag: "h2", ve: "h" };
    case "h3":
      return { tag: "h3", ve: "h" };
    case "h4":
      return { tag: "h4", ve: "h" };
    case "h5":
      return { tag: "h5", ve: "h" };
  }
}

/**
 * How `NORMAL TEXT ▾` has to reach the block the caret is standing in before
 * that block can wear another tag.
 *
 * - `"command"` — a `<ul>`/`<ol>`, which the browser's own list command
 *   toggles off, splitting the run at the caret as an author expects.
 * - `"lift"` — a list no command can leave. `<dl>` is one by definition: it is
 *   §3's mapping for `:`/`;` indentation and there is no `insertDefinitionList`,
 *   so the command toggles a list *on* instead. So is anything still list-shaped
 *   after that command has run. Renaming such a root in place is the trap:
 *   `<h2 data-ve="h">` over `<dd>`/`<li>` children reads back through a
 *   `pushInline` that has no case for an item, and the whole line collapses to
 *   one run of plain text — every link and mark on it silently gone.
 * - `"retag"` — a plain block, which `replaceBlockTag` rewrites in place.
 *
 * `commandTried` is what separates "a list the command can still fix" from
 * "a list the command has already failed to fix", which is why it is asked
 * twice per format and not once.
 */
export function formatStep(nodeName: string, commandTried: boolean): "command" | "lift" | "retag" {
  if (nodeName !== "UL" && nodeName !== "OL" && nodeName !== "DL") return "retag";
  return commandTried || nodeName === "DL" ? "lift" : "command";
}

/** A target with a scheme is an external link; everything else is a page. */
function hasScheme(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");
}

function setLinkTarget(anchor: HTMLElement, target: string): void {
  if (hasScheme(target)) {
    anchor.setAttribute("data-ve", "extlink");
    anchor.setAttribute("data-ve-href", target);
    anchor.removeAttribute("data-ve-target");
  } else {
    anchor.setAttribute("data-ve", "link");
    anchor.setAttribute("data-ve-target", target);
    anchor.removeAttribute("data-ve-href");
  }
  // Never an `href`: a link inside the surface is text you type into, and a
  // stray navigation would take the buffer with it (§3).
  anchor.removeAttribute("href");
}

function isAnchor(element: HTMLElement): boolean {
  return element.nodeName === "A";
}

/**
 * A block no command may rewrite: an atomic keeps its wikitext in an attribute,
 * a rule has no content, and a table's content is its cells — so re-tagging any
 * of the three loses the block outright.
 *
 * The table is here because it stopped being unreachable. While every table was
 * `contenteditable="false"` the caret could not stand in one, and `NORMAL TEXT
 * ▾` had nothing to act on; now that its cells are ordinary editable regions
 * (§3), `applyFormat` resolves the caret to the root's direct child and that
 * child is the `<table>` itself. `formatStep` calls a `<table>` a plain block,
 * so without this term choosing "Normal text" with the caret in a cell would
 * rewrite the whole table as a `<p>` and flatten every row into one line of
 * text — a whole table's worth of markup gone for a click that meant nothing of
 * the kind.
 */
function isFrozenBlock(element: HTMLElement): boolean {
  return (
    element.hasAttribute("data-ve-src") ||
    element.getAttribute("data-ve") === "rule" ||
    element.nodeName === "TABLE"
  );
}

/** The atomic markup for one raw wikitext snippet, as a detached element. */
function atomicElement(doc: Document, source: string, block: boolean, id: string): HTMLElement | null {
  const kind = atomicKindOf(source);
  const label = atomicLabelOf(kind, source);
  const html = block
    ? blockToHtml({ ...newBlockBase(id), kind: "atomic", atomic: kind, source, label })
    : inlineToHtml([{ kind: "atomic", atomic: kind, source, label }]);
  return elementFromHtml(html, doc);
}

/**
 * The markup one INSERT-ed block becomes.
 *
 * **A table the model can hold goes in as a table**, not as a chip: "insert a
 * table" is followed immediately by "type in it", and a chip has no cells to
 * put a caret in — the author would have had to reload the surface before any
 * of §3.2's controls would look at it. Everything else is an atomic, which is
 * what every other INSERT entry is and always was.
 *
 * The block is one the author has just created, so §4's three fields are null
 * and it publishes canonically. That is the same bargain every insertion makes:
 * there are no original bytes to keep.
 */
/**
 * What {@link mediaFile} needs of a `DataTransfer` — the structural subset, so
 * the decision can be asked with a plain object under vitest's node
 * environment, where there is no clipboard and no drag. The same bargain
 * `VeDomNode` makes for `domToDocument` (dom.ts).
 */
export interface VeFileSource {
  files: ArrayLike<File>;
}

/**
 * The one picture on a clipboard or a drag, or null (§15).
 *
 * Exactly one: a drop of a folder full of images is a batch upload, which this
 * editor does not have and which §5.2's dialog — one file, then its caption,
 * layout, alignment and width — is not shaped like. Taking the first of five
 * silently would be worse than taking none, so a multi-file drop is left to
 * the browser's own default, which this handler has already prevented: it
 * simply does nothing.
 *
 * The **type** is read off the file rather than off its name: a drag of a file
 * with no extension still says `image/png`, and `src/lib/media.ts` is the one
 * that gets to refuse anything (the dialog runs it before uploading). This is
 * only the question "is this a picture at all", which decides whether the drop
 * is a picture or a block move.
 */
export function mediaFile(source: VeFileSource | null): File | null {
  const files = source === null ? null : Array.from(source.files);
  if (files === null || files.length !== 1) return null;
  const file = files[0];
  return file.type.startsWith("image/") ? file : null;
}

/**
 * Was the click in the empty space *under* the article (§14)?
 *
 * The surface's own bottom padding is that space (`globals.css`, `.ve-surface`),
 * and a click in it lands on the root rather than on any block — but so does a
 * click in the **left gutter** beside a paragraph, which is padding too and
 * must go on meaning what it always meant. So the question is asked with the
 * pointer's `y` against the last block's bottom edge, which is the only thing
 * that tells the two apart.
 */
function clickedBelowArticle(root: HTMLElement, clientY: number): boolean {
  const last = root.lastElementChild;
  if (last === null) return true;
  return clientY > last.getBoundingClientRect().bottom;
}

/**
 * One search's answer, as rows of the mention panel (§13).
 *
 * The two routes answer different shapes and this is the only place that knows
 * it. Everything is read defensively — a body that is not what the route
 * promised produces no rows rather than a row with `undefined` in it, which is
 * the same discipline `readHtmls` keeps for the fragment batch.
 *
 * A **page** row writes its own link. Its target is `linkSuggestionTarget`'s,
 * so `Category:` and `File:` keep the leading colon that makes them links
 * rather than a filing and an embed (§5.4) — one rule, drawn in three places
 * now that a paste can write one too (`paste.ts`).
 *
 * A **template** row raises the dialog on itself: `{{Infobox moon}}` with no
 * parameters is a call that renders nothing, so the braces are never the
 * answer for a template that has any (§5.1).
 */
export function mentionRows(kind: VeMentionKind, body: unknown): SlashItem[] {
  if (typeof body !== "object" || body === null) return [];
  if (kind === "page") {
    const rows = (body as { suggestions?: unknown }).suggestions;
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((row: unknown, index): SlashItem[] => {
      if (typeof row !== "object" || row === null) return [];
      const { namespace, title } = row as { namespace?: unknown; title?: unknown };
      if (typeof title !== "string" || typeof namespace !== "string") return [];
      const target = linkSuggestionTarget({
        namespace: namespace as StorableNamespace,
        title,
      });
      return [
        {
          key: `page-${index}-${target}`,
          label: title,
          hint: namespace === "main" ? undefined : target,
          icon: <LinkIcon />,
          action: { kind: "wikitext", source: mentionWikitext("page", target) },
        },
      ];
    });
  }
  const rows = (body as { templates?: unknown }).templates;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row: unknown, index): SlashItem[] => {
    if (typeof row !== "object" || row === null) return [];
    const { title } = row as { title?: unknown };
    if (typeof title !== "string") return [];
    return [
      {
        key: `template-${index}-${title}`,
        label: title,
        icon: <TemplateIcon />,
        action: { kind: "template", name: title },
      },
    ];
  });
}

/**
 * A parsed block, as a block the author has just made: a fresh id and none of
 * §4's bookkeeping, so it publishes canonically — there are no original bytes
 * of this page's to keep.
 *
 * An **atomic** keeps its `source`, because for an atomic that field is not
 * bookkeeping at all: it is the wikitext the chip stands for, and the model
 * narrows it to a string for exactly that reason (model.ts).
 */
function asNewBlock(block: VeBlock, id: string): VeBlock {
  const base = { id, canonical: null, gapAfter: null };
  return block.kind === "atomic" ? { ...block, ...base } : { ...block, ...base, source: null };
}

function insertedBlockElement(doc: Document, source: string, id: string): HTMLElement | null {
  try {
    const parsed = parseDocument(source);
    const first = parsed.blocks[0];
    if (parsed.blocks.length === 1 && first !== undefined && first.kind === "table") {
      return elementFromHtml(blockToHtml({ ...first, ...newBlockBase(id) }), doc);
    }
  } catch {
    // A snippet the parser cannot finish is still a snippet: the chip carries
    // it verbatim, which is what an atomic is for.
  }
  return atomicElement(doc, source, true, id);
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export const VisualEditor = forwardRef<VisualEditorHandle, VisualEditorProps>(
  function VisualEditor(props, ref) {
    const { className, docKey, labels, readOnly = false } = props;

    const surfaceRef = useRef<HTMLDivElement | null>(null);
    /** The bordered box the gutter handle is positioned inside. */
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    /**
     * The same element, kept where React cannot clear it: the unmount flush
     * below still has to read a surface whose ref has already been detached.
     */
    const liveRef = useRef<HTMLDivElement | null>(null);
    /** Latest props for the handlers and effects that must not re-subscribe. */
    const propsRef = useRef(props);
    /** §4's bookkeeping: the document the surface was last read from. */
    const docRef = useRef<VeDocument>(emptyDocument());
    /** Set while the surface holds the load fallback rather than a document. */
    const loadFailedRef = useRef(false);
    const emittedRef = useRef<string | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /**
     * Keystrokes the branch field is holding: which node, which branch, and
     * what the textarea said when they were made.
     *
     * The branch id is captured *with* the words rather than looked up when
     * the timer fires, because between the two the author may have switched
     * versions — and a write that resolved "the current branch" late would
     * land v70's sentence in v71.
     */
    const branchRef = useRef<{ node: HTMLElement; branch: string; body: string } | null>(null);
    const branchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const idsRef = useRef(createIdFactory("n"));
    const cacheRef = useRef(new Map<string, VeFragmentResult>());
    /** The version the atomic previews on screen were rendered for. */
    const paintedVersionRef = useRef<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    /**
     * Bumped by every document load and every version switch, so a fragment
     * batch still in flight can tell that the surface it was fetched for is
     * gone. The AbortController alone cannot: a repaint at another version
     * issues no request to hang one on.
     */
    const generationRef = useRef(0);
    /** The last caret position inside the surface, for toolbar commands. */
    const savedRangeRef = useRef<Range | null>(null);
    const selectedRef = useRef<HTMLElement | null>(null);
    /** Fingerprint of the last reported context, so the toolbar re-renders once. */
    const contextRef = useRef("");
    /**
     * The gutter handle (§3.1): the block it is pointing at, and a fingerprint
     * of what is drawn for it.
     *
     * The fingerprint is the whole re-render budget of this feature.
     * `selectionchange` fires on every caret move and `scroll` fires on every
     * wheel notch, so the handle is recomputed constantly and `setState` is
     * called only where the answer actually changed — which, inside one block
     * the caret is walking along, it does not.
     */
    const moveBlockRef = useRef<HTMLElement | null>(null);
    const moveKeyRef = useRef<string | null>(null);
    const [blockHandle, setBlockHandle] = useState<VeBlockHandleState | null>(null);

    /**
     * The slash menu (§1), and the "/" it must not reopen on.
     *
     * `slashOffRef` remembers the line *as it read* when the author dismissed
     * the menu, so Escape leaves the slash on screen as ordinary text and
     * typing after it does not bring the panel back — while a slash typed
     * anywhere else reads differently and opens one again.
     */
    const [slash, setSlash] = useState<VeSlashState | null>(null);
    const slashOffRef = useRef<string | null>(null);

    /**
     * The `[[` / `@` / `{{` panel (§13), and the trigger it must not reopen on
     * — the same pair, for the same reason: dismissing one has to leave the
     * brackets on screen as the ordinary characters they are, and typing on
     * after that must not bring the panel back over the words being typed.
     */
    const [mention, setMention] = useState<VeMentionState | null>(null);
    const mentionOffRef = useRef<string | null>(null);

    /**
     * The bubble menu (§3), and the selection it was dismissed over.
     *
     * Dismissal is keyed on the selection's own rectangle rather than on a
     * boolean: Escape hides the bar over *this* selection, and the next
     * selection — which is a different rectangle — gets one again without any
     * event having to clear a flag.
     */
    const [bubble, setBubble] = useState<VeBubbleState | null>(null);
    const bubbleOffRef = useRef<string | null>(null);
    /** Fingerprint of what the bar is currently drawing, so it renders once. */
    const bubbleKeyRef = useRef<string | null>(null);

    /** A drag of the gutter grip, and the block extents it is measured against. */
    /** Only *that* a drag is running: what it draws, it draws itself. */
    const [sorting, setSorting] = useState(false);
    const sortRef = useRef<VeSortRun | null>(null);
    /**
     * How the drag lets go of the window.
     *
     * The move and the release are listened for on **`window`**, not on the
     * grip that was pressed, and that is not a detail: the first thing a drag
     * does is hide the chrome that would otherwise hang over a document sliding
     * about underneath it — which unmounts the very button the press landed
     * on. A pointer capture on that button, or handlers bound to it, would go
     * with it and the drag would end on its own first frame.
     */
    const sortOffRef = useRef<(() => void) | null>(null);
    /** The settle's timer, so a second drag cannot land on top of the first. */
    const settleRef = useRef<number | null>(null);
    /**
     * The same two states where a *handler* can read them. The slash menu's
     * `onSelect` is bound inside a document listener and may not take a
     * dependency that re-subscribes on every keystroke; a ref is how those
     * handlers stay stable.
     */
    const slashRef = useRef<VeSlashState | null>(null);
    const mentionRef = useRef<VeMentionState | null>(null);

    /**
     * `runBlockCommand`, reachable from `applyAction` — which is declared
     * above it and now has a row that asks for one (§3.1's five commands, as
     * slash rows).
     *
     * A ref rather than a re-ordering: `runBlockCommand` is built out of half
     * this component (`duplicateBlockUnit`, `moveBlockUnit`, `applyFormat` …)
     * and moving it above `applyAction` would move all of them. It is written
     * where it is defined, by an effect, exactly as `propsRef` is.
     */
    const runBlockCommandRef = useRef<
      ((block: HTMLElement | null, command: BlockMenuCommand) => void) | null
    >(null);

    /**
     * The surface exactly as it read before the last input rule fired, so one
     * `Ctrl+Z` can give the author back the literal characters they typed
     * (input-rules.ts, "What the rules assume about undo").
     *
     * It is the whole `innerHTML` because a rule is not always a re-format: the
     * horizontal rule *replaces* the block, so there is no single element an
     * inverse could be applied to. Taking one string costs nothing on the path
     * that matters — a rule fires once per marker typed, not once per keystroke
     * — and it cannot get an inverse wrong, which is the failure that would
     * publish something the author never wrote.
     */
    const ruleUndoRef = useRef<{ html: string; block: number; offset: number } | null>(null);

    /**
     * Whether Shift was down on the last key the surface saw — the one thing a
     * `beforeinput` cannot tell you about the key that made it.
     *
     * §3.2 hangs a distinction on it that the author feels every time they type
     * in a table: Enter steps to the next cell, `Shift+Enter` writes the cell's
     * `<br>`. Chrome answers a plain Enter inside a `<td>` with an
     * `insertLineBreak` — the *same* edit Shift+Enter makes, because Blink
     * refuses to split a table cell — so the `inputType` alone cannot separate
     * the two, and reading it alone let the browser's `<br>` through (user
     * report, 2026-09-06: "새로운 줄이 생기는게 아니라 shift enter를 누른거처럼").
     *
     * A modifier is not a spelling, so this survives what `event.key` does not:
     * while an IME composes, Chrome names the key "Process" — but it still
     * reports `shiftKey` on the very same event.
     */
    const breakShiftRef = useRef(false);

    /**
     * A break inside a cell that the surface may not be able to cancel, and the
     * cell's `<br>`s and wrappers as they stood **before** it — everything that
     * is in this snapshot the author put there, and anything that is not was
     * put there by the break.
     *
     * **`preventDefault` is not always a promise, and that is round four of
     * this bug.** Measured in the author's own Chrome against this very page:
     * an ordinary Enter's `beforeinput` is cancelable and refusing it works,
     * but **every `beforeinput` an IME is composing on is dispatched
     * `cancelable: false`** — `insertCompositionText` and whatever the commit
     * carries with it. Korean composes every syllable, so the Enter that ends a
     * cell's last word is exactly the one the surface cannot refuse. Three
     * rounds of prevention could not have worked, and the `<br>` went in every
     * time (user reports, 2026-09-06, four rounds: "shift+enter과 같은 효과가
     * 지속적으로 나는 버그", "아직도 마찬가지야").
     *
     * So the rule stops depending on the answer. Prevention still runs first
     * and still does the work wherever it is allowed to; where it is not, the
     * break lands and is **taken back off** — `healCellBreak` removes exactly
     * the nodes the break added, which is what the snapshot is for. Nothing the
     * author typed, and nothing the IME committed, is in it.
     */
    const cellBreakRef = useRef<{
      cell: HTMLElement;
      breaks: Set<Node>;
      wrappers: Set<Node>;
      /** Whether the key that armed this was Enter, whose repair takes Tab's step. */
      step: boolean;
    } | null>(null);

    /**
     * The structural undo stack (§12, `ve-history.ts`) — the edits of ours the
     * browser's own `Ctrl+Z` never saw, because they are DOM surgery rather
     * than `execCommand`: a block move, a drop, a section move, a table
     * operation, a duplicate, a deletion, an insertion, a paste of blocks.
     *
     * It is emptied by `onInput`, and that is the whole window: an input event
     * is the browser recording an edit of its own, and from then on the two
     * stacks describe two different documents.
     */
    const historyRef = useRef<VeHistoryState>(emptyHistory());

    /**
     * True while this component is applying something of its own. `execCommand`
     * dispatches `input` synchronously, so without this an input rule's own
     * deletion would re-enter the handler that fired it and be read as another
     * keystroke.
     */
    const applyingRef = useRef(false);
    /**
     * True between `compositionstart` and `compositionend`. Korean is a
     * first-class locale here and a rule that fires mid-composition corrupts
     * the syllable being assembled, so nothing below reads the buffer while
     * this is set.
     */
    const composingRef = useRef(false);
    /**
     * The table control (§3.2): the cell it acts on, and a fingerprint of what
     * is drawn for it — the same two-ref, one-state shape the move handle uses,
     * and for the same reason.
     *
     * Unlike the move handle it follows the **caret only**, never the pointer.
     * A strip that appeared on hover would vanish on the way to being clicked:
     * it is drawn outside the contenteditable, so the pointer crossing the
     * surface between a cell and the strip is a `mouseover` on something that
     * is not a table. Following the caret makes the control's life exactly as
     * long as the author's interest in that table.
     */
    const tableCellRef = useRef<HTMLElement | null>(null);
    const tableKeyRef = useRef<string | null>(null);
    const [tableHandle, setTableHandle] = useState<VeTableHandle | null>(null);
    const [contextMenu, setContextMenu] = useState<VeContextState | null>(null);
    /** Which axis menu is open — never both, and never one of each table. */
    const [tableMenu, setTableMenu] = useState<"row" | "column" | null>(null);
    /** Open while a table edit is being confirmed or a refusal explained (§3.2). */
    const [tableDialog, setTableDialog] = useState<VeTableDialog | null>(null);

    // Declared first so it runs before every effect below: they read props out
    // of this ref rather than depending on them, which is what keeps the
    // document-load effect keyed on `docKey` alone. The two control states
    // ride along for the same reason — a handler that closed over them would
    // re-subscribe its listener on every keystroke.
    useEffect(() => {
      propsRef.current = props;
      slashRef.current = slash;
      mentionRef.current = mention;
    });

    const mint = useCallback((): string => idsRef.current(), []);

    /**
     * Run something that edits the surface programmatically.
     *
     * `execCommand` dispatches `input` synchronously, so without this an input
     * rule's own deletion would re-enter the handler that fired it and be read
     * as a keystroke — and a paste of "## " would become a heading nobody
     * asked for. Everything that edits on the author's behalf goes through it.
     */
    const applying = useCallback(<T,>(run: () => T): T => {
      const was = applyingRef.current;
      applyingRef.current = true;
      try {
        return run();
      } finally {
        applyingRef.current = was;
      }
    }, []);

    /**
     * Whether the surface may be edited and read back at all.
     *
     * `readOnly` is the caller's answer; a failed load is ours. The markup on
     * screen then belongs to the fallback, not to the buffer, so reading it
     * back would publish the fallback over the article.
     */
    const isLocked = useCallback(
      (): boolean => propsRef.current.readOnly === true || loadFailedRef.current,
      [],
    );

    /* ---------------- reading the surface ---------------- */

    const readNow = useCallback((): string => {
      const root = liveRef.current;
      const { content, onContentChange } = propsRef.current;
      if (root === null || isLocked()) return content;
      let next: string;
      try {
        const doc = domToDocument(root, docRef.current, idsRef.current);
        docRef.current = doc;
        next = serializeDocument(doc);
      } catch {
        // A read that cannot complete leaves the buffer as it was; the author
        // keeps typing and the next one will succeed.
        return content;
      }
      if (next !== emittedRef.current) {
        emittedRef.current = next;
        onContentChange(next);
      }
      return next;
    }, [isLocked]);

    const scheduleRead = useCallback((): void => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        readNow();
      }, READ_DEBOUNCE_MS);
    }, [readNow]);

    /* ---------------- caret context ---------------- */

    const updateEmpty = useCallback((root: HTMLElement): void => {
      root.setAttribute("data-ve-empty", isSurfaceEmpty(root) ? "true" : "false");
    }, []);

    /**
     * Tell the island which block the caret is in, and nothing else.
     *
     * It used to report the caret's format, its marks and its table as well,
     * because the toolbar drew from all three. The toolbar is gone and the two
     * controls that need them — the bubble menu and the slash menu's
     * contextual rows — are inside this component, so sending them up would be
     * a render of the whole editor per caret move for nobody. What is left is
     * the outline's current-section mark (§10.1), which changes only when the
     * caret *crosses* a block; the fingerprint is that index and the report
     * therefore costs one render per crossing.
     */
    const reportContext = useCallback((): void => {
      const root = liveRef.current;
      const onContextChange = propsRef.current.onContextChange;
      if (root === null || onContextChange === undefined) return;
      const range = currentRange(root);
      // A chip holds no caret (§5), so the block it stands in is the chip
      // itself — which is also the unit `Alt+Arrow` moves from there.
      const at = selectedRef.current ?? (range === null ? null : range.startContainer);
      const blockIndex = at === null ? -1 : (blockUnitPosition(root, at)?.index ?? -1);
      const fingerprint = String(blockIndex);
      if (fingerprint === contextRef.current) return;
      contextRef.current = fingerprint;
      onContextChange({ blockIndex });
    }, []);

    /** Which block format the caret's block corresponds to, chip included. */
    const caretFormat = useCallback((root: HTMLElement, range: Range | null): VeBlockFormat => {
      const selected = selectedRef.current;
      if (selected !== null && selected.getAttribute("data-ve-kind") === "pre") return "pre";
      return formatOfBlock(nearestBlock(root, range === null ? null : range.startContainer));
    }, []);

    /**
     * The table the caret is standing in, said the way both of its controls
     * want it: the cell, and what that cell's row and column can be given.
     *
     * One answer, used twice — by the axis controls and by the slash menu's
     * contextual rows — because two ways of asking would be two ways for the
     * pointer's affordance and the keyboard's to disagree about a table.
     */
    const tableStateAt = useCallback(
      (node: Node | null): { cell: HTMLElement; context: VeTableContext } | null => {
        const root = liveRef.current;
        if (root === null) return null;
        const found = tableAt(root, node);
        if (found === null) return null;
        const spot = tableSpotOf(found.table, found.cell);
        return spot === null ? null : { cell: found.cell, context: tableContextOf(spot) };
      },
      [],
    );

    const selectAtomic = useCallback((node: HTMLElement | null): void => {
      const previous = selectedRef.current;
      if (previous !== null && previous !== node) previous.removeAttribute("data-ve-selected");
      selectedRef.current = node;
      if (node !== null) node.setAttribute("data-ve-selected", "true");
    }, []);

    /* ---------------- atomic previews (§5) ---------------- */

    /** What a fragment has to have been rendered for to be painted right now. */
    const currentScope = useCallback(
      (): VeFragmentScope => ({
        generation: generationRef.current,
        locale: propsRef.current.locale,
        version: propsRef.current.version,
      }),
      [],
    );

    const loadFragments = useCallback((root: HTMLElement): void => {
      const { locale, previewTitle, version, labels: current } = propsRef.current;
      const cache = cacheRef.current;
      const scope: VeFragmentScope = { generation: generationRef.current, locale, version };

      /** Paints everything the cache already knows; returns what it does not. */
      const paint = (): string[] => {
        const missing: string[] = [];
        const seen = new Set<string>();
        for (const node of Array.from(root.querySelectorAll("[data-ve-src]"))) {
          if (!(node instanceof HTMLElement)) continue;
          const source = node.getAttribute("data-ve-src");
          if (source === null) continue;
          const cached = cache.get(fragmentKey(locale, version, source));
          if (cached !== undefined) {
            paintFragment(node, cached, current);
            continue;
          }
          markLoading(node, current);
          // Over the route's per-fragment cap: sending it would fail the whole
          // batch, so it goes straight to its wikitext chip.
          if (source.length > MAX_FRAGMENT_CHARS) {
            cache.set(fragmentKey(locale, version, source), FRAGMENT_FAILED);
            paintFragment(node, FRAGMENT_FAILED, current);
            continue;
          }
          if (seen.has(source)) continue;
          seen.add(source);
          missing.push(source);
        }
        return missing;
      };

      const missing = paint();
      if (missing.length === 0) return;

      const controller = abortRef.current;
      void (async () => {
        for (const batch of fragmentBatches(missing)) {
          let answer: (string | null)[] | null = null;
          try {
            const response = await fetch("/api/preview/fragments", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ fragments: batch, title: previewTitle, locale, version }),
              signal: controller === null ? undefined : controller.signal,
            });
            if (response.ok) answer = readFragments(await response.json());
          } catch (err) {
            // A cancelled load is the document changing under us; stop quietly.
            if (err instanceof DOMException && err.name === "AbortError") return;
          }
          // A failed batch caches the failure so the chips settle on their
          // wikitext instead of re-requesting on every keystroke. The key
          // carries the scope this batch was rendered at, so the entries stay
          // right even where the surface has moved on and the paint below is
          // refused.
          for (let i = 0; i < batch.length; i += 1) {
            const html = answer === null ? FRAGMENT_FAILED : (answer[i] ?? FRAGMENT_FAILED);
            cache.set(fragmentKey(locale, version, batch[i]), html);
          }
          if (controller !== null && controller.signal.aborted) return;
          if (!fragmentScopeIsCurrent(scope, currentScope())) return;
          paint();
        }
      })();
    }, [currentScope]);

    /* ---------------- the gutter handle (§3.1) ---------------- */

    /**
     * Point the gutter handle at the block holding `target`, or take it away.
     *
     * Drawn from React state rather than injected into the surface, because
     * the surface's markup is what gets published: a button written inside a
     * paragraph would be read back by `domToDocument` as content, and a
     * `contenteditable="false"` wrapper around it would be read back as an
     * atomic. The gutter is the one place a control can sit beside a block
     * without being *in* it.
     *
     * `VeBlockHandle` places itself `fixed`, so what it is handed is the
     * block's **viewport** corner: this component then knows nothing about
     * which container scrolls, and a scroll is answered by measuring again
     * rather than by a second coordinate system.
     *
     * Every early return clears the handle rather than leaving the last one
     * hanging over a block that is gone: a locked surface, a load failure, a
     * caret in no block at all.
     */
    const refreshBlockHandle = useCallback(
      (target: Node | null): void => {
        const root = liveRef.current;
        const clear = (): void => {
          if (moveKeyRef.current === null) return;
          moveKeyRef.current = null;
          moveBlockRef.current = null;
          setBlockHandle(null);
        };
        if (root === null || target === null || isLocked()) {
          clear();
          return;
        }
        const block = nearestBlock(root, target);
        if (block === null) {
          clear();
          return;
        }
        const position = blockUnitPosition(root, block);
        if (position === null) {
          clear();
          return;
        }
        // Measured every time, and cheap because of it: these are layout
        // *reads* with no write between them. What the fingerprint below saves
        // is the re-render, which is the part that would be felt — and inside
        // one block that has not moved the answer does not change, so it
        // settles even under a stream of `mouseover`s.
        const rect = block.getBoundingClientRect();
        const anchor = { top: rect.top, left: rect.left };
        const up = blockMoveTarget(position.count, position.index, "up") !== null;
        const down = blockMoveTarget(position.count, position.index, "down") !== null;
        const formats = formatsForBlock(block);
        const key = `${Math.round(anchor.top / ANCHOR_EPSILON)}:${Math.round(
          anchor.left / ANCHOR_EPSILON,
        )}:${up ? "u" : ""}${down ? "d" : ""}:${formats.length}`;
        if (moveBlockRef.current === block && moveKeyRef.current === key) return;
        moveBlockRef.current = block;
        moveKeyRef.current = key;
        setBlockHandle({ anchor, up, down, formats });
      },
      [isLocked],
    );

    /* ---------------- the table controls (§3.2) ---------------- */

    /**
     * Point the axis controls at the table holding `target`, or take them
     * away.
     *
     * Four boxes are measured, and each of them is a control: the table's own,
     * which the two "+"s hang off; the caret's row, which the row menu sits
     * beside; and the caret's column, which the column menu sits over. That is
     * the difference between this and the strip it replaces — a control that
     * points at *this row* can be named after it, and a menu of six rows is
     * read where twelve icons in a line were scanned.
     *
     * Every early return clears them, and the clears matter more here than for
     * the gutter handle: a control left hanging over a paragraph would offer
     * to delete a row of a table the caret has left. The cell is stored on
     * every pass (it is a ref, so it costs nothing) while the fingerprint
     * gates the re-render, so typing across a cell does not make the controls
     * flicker.
     */
    const refreshTableHandle = useCallback(
      (target: Node | null): void => {
        const root = liveRef.current;
        const wrapper = wrapperRef.current;
        const clear = (): void => {
          markCellHere(root, null);
          tableCellRef.current = null;
          if (tableKeyRef.current === null) return;
          tableKeyRef.current = null;
          setTableHandle(null);
        };
        if (root === null || wrapper === null || target === null || isLocked()) {
          clear();
          return;
        }
        const found = tableAt(root, target);
        if (found === null) {
          clear();
          return;
        }
        const spot = tableSpotOf(found.table, found.cell);
        if (spot === null) {
          clear();
          return;
        }
        tableCellRef.current = found.cell;
        markCellHere(root, found.cell);
        const box = wrapper.getBoundingClientRect();
        const originTop = box.top + wrapper.clientTop;
        const originLeft = box.left + wrapper.clientLeft;
        const rect = found.table.getBoundingClientRect();
        const cell = found.cell.getBoundingClientRect();
        const row = (found.cell.parentElement ?? found.cell).getBoundingClientRect();
        const context = tableContextOf(spot);
        // A table that is the page's first block leaves no room above it, and
        // a control drawn outside the box it belongs to reads as belonging to
        // whatever is above — so it overlaps the first row instead.
        const handle: VeTableHandle = {
          top: Math.max(0, rect.top - originTop),
          left: Math.max(0, rect.left - originLeft),
          width: rect.width,
          height: rect.height,
          rowTop: row.top - originTop,
          rowHeight: row.height,
          columnLeft: Math.max(0, cell.left - originLeft),
          columnWidth: cell.width,
          // Which row and column the two tabs are pointing at, and the table
          // they are on: a drag of either has to name its own index, and the
          // context above deliberately carries neither (it answers "what can
          // this cell be given", not "where is it").
          row: spot.row,
          column: spot.column,
          table: found.table,
          context,
          docKey: propsRef.current.docKey,
        };
        const offered = TABLE_OPS.map((op) => (context.can[op] ? "1" : "0")).join("");
        const key = [
          Math.round(handle.top),
          Math.round(handle.left),
          Math.round(handle.width),
          Math.round(handle.height),
          Math.round(handle.rowTop),
          Math.round(handle.columnLeft),
          Math.round(handle.columnWidth),
          context.headerRow ? "h" : "d",
          offered,
        ].join(":");
        if (tableKeyRef.current === key) return;
        tableKeyRef.current = key;
        setTableHandle(handle);
      },
      [isLocked],
    );

    /* ---------------- the empty-paragraph hint (§1) ---------------- */

    /**
     * Mark the empty paragraph the caret is in, and unmark every other.
     *
     * This is what replaces a toolbar's discoverability: with no row of
     * buttons on screen, the only thing that can say "there is a menu, and
     * this is how you open it" is the line the author is already looking at.
     * It is drawn from an attribute and a stylesheet rule (globals.css), so
     * nothing is written into the document that `domToDocument` could read.
     *
     * Only a paragraph, only while the surface has focus, and only while it
     * holds nothing at all — a heading is already telling the author what it
     * is, and a hint under a chip would be a hint about somebody else's block.
     */
    const refreshHint = useCallback((): void => {
      const root = liveRef.current;
      if (root === null) return;
      const range = currentRange(root);
      const focused = root.ownerDocument.activeElement === root;
      const block = focused && range !== null ? nearestBlock(root, range.startContainer) : null;
      const wanted =
        block !== null &&
        block.nodeName === "P" &&
        !isLocked() &&
        (block.textContent ?? "") === "" &&
        block.querySelector("[data-ve-src],hr,img") === null
          ? block
          : null;
      for (const marked of Array.from(root.querySelectorAll(`[${HINT_ATTR}]`))) {
        if (marked !== wanted) marked.removeAttribute(HINT_ATTR);
      }
      if (wanted !== null && !wanted.hasAttribute(HINT_ATTR)) wanted.setAttribute(HINT_ATTR, "");
    }, [isLocked]);

    /* ---------------- the bubble menu (§3) ---------------- */

    /**
     * Draw the formatting bar over the selection, or take it away.
     *
     * Everything that hides it is a case where the bar would be lying about
     * what it acts on: a collapsed caret (nothing to format), a selected chip
     * (whose wikitext is edited in a dialog, not with a B), a selection of
     * pure whitespace, a locked surface, and a dialog — a bar floating over a
     * modal is a control outside the focus trap that modal promised.
     *
     * The fingerprint is the selection's rectangle plus what the bar would
     * draw, so dragging across a word re-renders once per changed pixel row
     * rather than once per `selectionchange`, and typing under an unchanged
     * selection re-renders not at all.
     */
    const refreshBubble = useCallback((): void => {
      const root = liveRef.current;
      if (root === null) return;
      const hide = (): void => {
        if (bubbleKeyRef.current === null) return;
        bubbleKeyRef.current = null;
        setBubble(null);
      };
      if (isLocked() || propsRef.current.dialogOpen === true) {
        hide();
        return;
      }
      const range = currentRange(root);
      if (range === null || range.collapsed || selectedRef.current !== null) {
        hide();
        return;
      }
      if (range.toString().trim() === "") {
        hide();
        return;
      }
      const box = range.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) {
        hide();
        return;
      }
      const rect: BubbleRect = {
        top: box.top,
        left: box.left,
        right: box.right,
        bottom: box.bottom,
      };
      const where = [rect.top, rect.left, rect.right, rect.bottom].map(Math.round).join(":");
      // Dismissed over *this* selection: Escape and a scroll both leave the
      // selection alone, so a boolean would have to be cleared by some later
      // event and the rectangle needs no such thing.
      if (bubbleOffRef.current === where) {
        hide();
        return;
      }
      bubbleOffRef.current = null;
      const marks = MARKS.filter((mark) => isMarkActive(root, range, mark));
      const format = caretFormat(root, range);
      const formats = formatsForBlock(nearestBlock(root, range.startContainer));
      const key = `${where}|${format}|${marks.join(",")}|${formats.length}`;
      if (bubbleKeyRef.current === key) return;
      bubbleKeyRef.current = key;
      setBubble({ rect, marks, format, formats });
    }, [caretFormat, isLocked]);

    /** Escape, and a scroll: the bar goes, and this selection does not get another. */
    const dismissBubble = useCallback((): void => {
      const current = bubbleKeyRef.current;
      if (current === null) return;
      bubbleOffRef.current = current.slice(0, current.indexOf("|"));
      bubbleKeyRef.current = null;
      setBubble(null);
    }, []);

    /* ---------------- the slash menu (§1) ---------------- */

    /**
     * Everything the menu can offer at this caret. Built once, when the menu
     * opens, and kept while it stays open: the list is fixed for as long as
     * the author is typing a query into one block, and rebuilding sixty rows
     * per keystroke to get the same sixty rows back is work nobody asked for.
     */
    const buildSlashItems = useCallback(
      (node: Node | null, inCell: boolean): SlashItem[] => {
        const root = liveRef.current;
        const { labels: current, namedRefs } = propsRef.current;
        const table = tableStateAt(node);
        return visualSlashItems({
          labels: current.slashItems,
          refs: namedRefs ?? [],
          inCell,
          table: table?.context ?? null,
          tableLabels: current.table,
          block: root === null ? null : slashBlockAt(root, node),
          blockLabels: current.handle,
        });
      },
      [tableStateAt],
    );

    /**
     * The same catalogue, cut to what the header's Insert menu shows (§1's
     * `INSERT ▾` and `CITE ▾`).
     *
     * It works out `inCell` for itself rather than being told, because its
     * caller is the island — which does not know where the caret is, and must
     * not be made to, for the reason `reportContext` gives. The rule is the
     * one the paste path uses: a cell and a caption hold inline content and
     * nothing else (spec §7.3).
     */
    const buildInsertItems = useCallback(
      (node: Node | null): SlashItem[] => {
        const root = liveRef.current;
        const { labels: current, namedRefs } = propsRef.current;
        const inCell = isCellHost(root === null ? null : caretHost(root, node));
        const table = tableStateAt(node);
        return visualInsertItems({
          labels: current.slashItems,
          refs: namedRefs ?? [],
          inCell,
          table: table?.context ?? null,
          tableLabels: current.table,
          // This menu offers only constructs — nothing it holds can be a row
          // that would do nothing — so it asks the block no questions.
          block: null,
          blockLabels: current.handle,
        });
      },
      [tableStateAt],
    );

    /**
     * Open, update or close the slash menu from what is in front of the caret.
     *
     * Called after every input and every caret move, so it is written to do
     * nothing cheaply: a line with no "/" in it costs one string and one
     * backwards scan.
     */
    const syncSlash = useCallback((): void => {
      const root = liveRef.current;
      if (root === null) return;
      const close = (): void => setSlash((current) => (current === null ? current : null));
      // Not `composingRef`: a panel that refuses to read a line while an IME is
      // assembling a syllable is a panel Korean never gets to see at all
      // (`onCompositionStart`).
      if (isLocked() || propsRef.current.dialogOpen === true) {
        close();
        return;
      }
      const range = currentRange(root);
      if (range === null || !range.collapsed) {
        close();
        return;
      }
      const host = caretHost(root, range.startContainer);
      // A chip's body is the engine's rendering of somebody's wikitext (§5),
      // not a place anything can be inserted into.
      if (host === null || isInAtomic(host)) {
        close();
        return;
      }
      const reading = hostText(host, range);
      if (reading === null) {
        close();
        return;
      }
      const before = reading.text.slice(0, reading.offset);
      const context = slashContext(before);
      if (context === null) {
        slashOffRef.current = null;
        close();
        return;
      }
      // Two panels can never be open at once: both claim the arrows and Enter
      // from the document in the capture phase, and two listeners answering one
      // key is a row taken in a list the author was not looking at. The trigger
      // **nearer the caret** is the one being typed, so it wins (§13).
      const rival = mentionContext(before);
      if (rival !== null && rival.consumed < context.consumed) {
        close();
        return;
      }
      // The line up to and including the "/" — the identity of *this* slash,
      // so a dismissed one stays dismissed however much is typed after it, and
      // deleting it back out clears the dismissal with it.
      const head = before.slice(0, before.length - context.consumed + 1);
      if (slashOffRef.current === head) {
        close();
        return;
      }
      slashOffRef.current = null;
      const anchor = slashAnchor(root, reading, context.consumed) ?? caretAnchor(range);
      if (anchor === null) {
        close();
        return;
      }
      // One spelling of "a cell holds inline content and nothing else"
      // (spec §7.3): this used to name the tags itself and was a copy waiting
      // to drift from the one the paste path and the Insert menu ask.
      const inCell = isCellHost(host);
      setSlash((current) => {
        const items = current?.items ?? buildSlashItems(range.startContainer, inCell);
        // A query with a space in it that matches nothing is a sentence, not a
        // command: the menu gets out of the way and leaves the slash as text.
        // With a match it stays — "Version block" is two words.
        if (/\s/u.test(context.query) && filterSlashItems(items, context.query).length === 0) {
          slashOffRef.current = head;
          return null;
        }
        return { anchor, query: context.query, consumed: context.consumed, items };
      });
    }, [buildSlashItems, isLocked]);

    /** Escape, an outside click: the slash stays on screen as ordinary text. */
    const dismissSlash = useCallback((): void => {
      setSlash((current) => {
        if (current === null) return current;
        const root = liveRef.current;
        const range = root === null ? null : currentRange(root);
        const host = root === null || range === null ? null : caretHost(root, range.startContainer);
        const reading = host === null || range === null ? null : hostText(host, range);
        slashOffRef.current =
          reading === null
            ? null
            : reading.text.slice(0, reading.offset - current.consumed + 1);
        return null;
      });
    }, []);

    /* ---------------- post-command housekeeping ---------------- */

    /**
     * What every command ends with: put the markup back into §3's shape, hand
     * the island its new context, and queue a read.
     *
     * The normalisation is a plain DOM edit, so it is outside the browser's
     * undo transaction — undoing an indent can therefore land a step short of
     * where it started. That is the price of letting `execCommand` do the
     * indenting at all, and it is smaller than the price of a hand-rolled
     * command layer with no undo, no IME and no mobile keyboard.
     */
    const afterCommand = useCallback(
      (root: HTMLElement): void => {
        normalizeLists(root);
        ensureUniqueBlockIds(root, mint);
        decorateAtomics(root, propsRef.current.labels);
        // A versions node restored by an undo has to get its branch field back
        // with the rest of its chrome. Nothing is rebuilt whose branch has not
        // changed, so this cannot disturb a field being typed into — and it is
        // not on the keystroke path, which is why the parse it costs is fine.
        syncBranchFields(root, propsRef.current.version, propsRef.current.labels, isLocked());
        updateEmpty(root);
        reportContext();
        // Any structural command moves the tops of the blocks below it, and the
        // handle is anchored to one of those. It follows the caret, which is
        // where the command happened.
        const range = currentRange(root);
        refreshBlockHandle(range === null ? moveBlockRef.current : range.startContainer);
        // The table controls are anchored to a table's boxes, which any command
        // above them moves — and they follow the caret rather than the pointer,
        // so a command that put the caret in another block takes them away.
        refreshTableHandle(range === null ? tableCellRef.current : range.startContainer);
        // The command may have emptied the block the caret is in (or filled
        // it), and the hint is what says the slash menu exists.
        refreshHint();
        // A command acts on the selection and usually collapses it, so the bar
        // it was raised from has to go with it.
        refreshBubble();
        scheduleRead();
      },
      [
        isLocked,
        mint,
        refreshBlockHandle,
        refreshBubble,
        refreshHint,
        refreshTableHandle,
        reportContext,
        scheduleRead,
        updateEmpty,
      ],
    );

    /* ---------------- undoing a structural edit (§12) ---------------- */

    /**
     * The surface as it stands, and the block the caret is in — what
     * `ve-history.ts` stores before a structural edit and hands back to undo
     * one.
     */
    const snapshotOf = useCallback((root: HTMLElement): VeSnapshot => {
      const range = currentRange(root);
      const block = range === null ? null : nearestBlock(root, range.startContainer);
      const unit = block ?? (selectedRef.current as HTMLElement | null);
      return { html: root.innerHTML, block: unit?.getAttribute("data-ve-id") ?? null };
    }, []);

    /**
     * Remember the state a structural edit is about to leave behind.
     *
     * Called by every edit the *browser* does not record: a block move, a drop
     * after a drag, a section move, a table operation, a duplicate, a deletion,
     * an insertion and a paste that arrived as blocks. Everything else — the
     * marks, the lists, typing — goes through `execCommand` and is already on
     * the browser's own stack, which is also what clears this one (`onInput`).
     */
    const pushHistory = useCallback(
      (root: HTMLElement): void => {
        historyRef.current = recordEdit(historyRef.current, snapshotOf(root));
      },
      [snapshotOf],
    );

    /**
     * Put a snapshot back.
     *
     * The markup goes in whole, which is the point: every element comes back
     * carrying the `data-ve-id` and `data-ve-src` it went in with, so the next
     * read still matches each block to the block it was parsed from and §4
     * still publishes an untouched one from its `source`. Restoring is
     * therefore as byte-safe as the move it undoes.
     *
     * What has to be redone by hand is the chrome that is not markup: the
     * atomic chips' buttons and previews (`decorateAtomics`, `loadFragments` —
     * the fragment cache is keyed by source, so a block nobody changed costs no
     * request), and the caret, which is put back in the block it was in rather
     * than at an offset into markup that has moved.
     */
    const restoreSnapshot = useCallback(
      (root: HTMLElement, snapshot: VeSnapshot): void => {
        root.innerHTML = snapshot.html;
        decorateAtomics(root, propsRef.current.labels);
        const block = snapshot.block === null ? null : blockElementAt(root, snapshot.block, -1);
        if (block !== null) {
          if (isFrozenBlock(block)) selectNode(block);
          else placeCaretInside(block);
          block.scrollIntoView({ block: "nearest" });
        }
        loadFragments(root);
        afterCommand(root);
      },
      [afterCommand, loadFragments],
    );

    /**
     * `Ctrl+Z` / `Ctrl+Shift+Z` over the structural stack, or `false` to let
     * the browser have the key — which is the answer for all of an ordinary
     * typing session, since the stack is empty unless a structural edit was the
     * last thing that happened (§12).
     */
    const stepHistory = useCallback(
      (direction: "undo" | "redo"): boolean => {
        const root = liveRef.current;
        if (root === null || isLocked()) return false;
        const step = direction === "undo" ? undoEdit : redoEdit;
        const taken = step(historyRef.current, snapshotOf(root));
        if (taken === null) return false;
        historyRef.current = taken.state;
        restoreSnapshot(root, taken.restore);
        return true;
      },
      [isLocked, restoreSnapshot, snapshotOf],
    );

    /**
     * Move the block holding `target` one place up or down (§3.1) — the gutter
     * buttons and `Alt+Arrow` both end here.
     *
     * The caret is put back rather than trusted: its nodes came along with the
     * block, so the saved Range is still valid, but re-parenting a subtree
     * drops the selection outright in some engines and "the caret stays in the
     * block you moved" is the whole promise of the shortcut. A chip has no
     * caret to keep — it is `contenteditable="false"` (§5) — so what is
     * restored there is the unit selection the surface calls "selected", which
     * is also what arms the next `Alt+Arrow` on the same chip.
     *
     * The move is a plain DOM edit and therefore outside the browser's undo
     * transaction, the same trade `normalizeLists` already makes: Ctrl+Z will
     * not walk a move back. Ctrl+Z that *rebuilt* the block would be worse —
     * it would canonicalize bytes the move was careful not to touch.
     */
    const moveBlockUnit = useCallback(
      (target: Node | null, direction: VeMoveDirection): void => {
        const root = liveRef.current;
        if (root === null || target === null || isLocked()) return;
        const block = nearestBlock(root, target);
        if (block === null) return;
        const saved = currentRange(root);
        // Before the move, not after: the snapshot is the state to come back
        // to (§12), and a move the browser never sees has no other way back.
        pushHistory(root);
        if (!moveBlock(root, block, direction)) return;
        if (selectedRef.current === block) selectNode(block);
        else if (saved !== null) applyRange(root, saved);
        // A block moved past the fold is a block the author cannot see land.
        block.scrollIntoView({ block: "nearest" });
        afterCommand(root);
        // After `afterCommand`, which pointed the handle at the caret: a chip's
        // caret is the root itself, and the handle belongs on the chip.
        refreshBlockHandle(block);
      },
      [afterCommand, isLocked, pushHistory, refreshBlockHandle],
    );

    /* ---------------- the outline (§10.1) ---------------- */

    /**
     * Scroll to a block and put the caret in it — what clicking an outline row
     * does. `block: "start"` rather than the `"nearest"` the rest of this file
     * uses: a heading scrolled to the bottom edge of the viewport is a heading
     * whose section is entirely off screen, and the row was clicked to read
     * what is *under* it.
     */
    const focusBlockAt = useCallback(
      (blockId: string, blockIndex: number): void => {
        const root = liveRef.current;
        if (root === null) return;
        const block = blockElementAt(root, blockId, blockIndex);
        if (block === null) return;
        // Focus first: a contenteditable taking focus afterwards can drop the
        // caret that was just put in it, and the promise of the row is that
        // typing carries on from the heading that was clicked.
        if (root.ownerDocument.activeElement !== root) root.focus({ preventScroll: true });
        if (isFrozenBlock(block)) {
          // A chip holds no caret (§5). What it holds instead is the surface's
          // own selection — which is also what arms `Alt+Arrow` on it.
          selectAtomic(block);
          selectNode(block);
        } else {
          selectAtomic(null);
          placeCaretInside(block);
        }
        block.scrollIntoView({ block: "start" });
        reportContext();
        refreshBlockHandle(block);
      },
      [refreshBlockHandle, reportContext, selectAtomic],
    );

    /**
     * Move a whole section: `moveBlockRun` over the run the outline planned.
     *
     * It is `moveBlockUnit` above with a longer run, deliberately — one mover,
     * so §3.1's promise carries over without being re-argued. The elements are
     * re-parented, so every block in the section keeps its `data-ve-id` and
     * republishes from `source`: an article whose sections were swapped comes
     * back byte-identical, in a new order.
     *
     * The one thing a run needs that a single block does not is the refusal.
     * A plan is computed over the *buffer*, which trails this surface by up to
     * one serialize debounce, so a plan whose document had a different number
     * of blocks is a plan naming the wrong paragraphs — and moving the wrong
     * six paragraphs is a great deal worse than moving none.
     */
    const moveSectionUnits = useCallback(
      (plan: SectionMovePlan): void => {
        const root = liveRef.current;
        if (root === null || isLocked()) return;
        const units = blockUnits(Array.from(root.childNodes));
        if (units.length !== plan.blockCount) return;
        const head = units[plan.from]?.[0] ?? null;
        const saved = currentRange(root);
        pushHistory(root);
        if (!moveBlockRun(root, plan.from, plan.count, plan.to)) return;
        // The caret's nodes came along with the section, so the saved Range is
        // still made of live nodes; it is re-applied because re-parenting a
        // subtree drops the selection outright in some engines.
        if (saved !== null) applyRange(root, saved);
        // A section moved past the fold is a section the author cannot see land.
        if (head instanceof HTMLElement) head.scrollIntoView({ block: "nearest" });
        afterCommand(root);
      },
      [afterCommand, isLocked, pushHistory],
    );

    /* ---------------- the table controls (§3.2) ---------------- */

    /**
     * Take the whole table out — what "Delete table" does, and what deleting
     * the last row or the last column comes to (spec §7.5: a table with no rows
     * renders nothing, so there is no smaller table to leave behind).
     *
     * Through the browser's own delete, like an atomic chip's removal, so the
     * table stays on the native undo stack and `Ctrl+Z` brings it back with
     * every cell in it. The caret is handed to the block that follows unless
     * that block cannot hold one, and a document left with nothing at all gets
     * a paragraph, because a childless contenteditable gives the caret nowhere
     * to stand.
     */
    const removeTable = useCallback(
      (root: HTMLElement, table: HTMLElement): void => {
        const neighbour = table.nextElementSibling ?? table.previousElementSibling;
        selectAtomic(null);
        if (!(selectNode(table) && exec(root, "delete")) || table.isConnected) table.remove();
        if (root.firstElementChild === null) {
          const paragraph = newParagraph(root.ownerDocument, mint());
          root.appendChild(paragraph);
          placeCaretInside(paragraph);
        } else if (
          neighbour instanceof HTMLElement &&
          neighbour.isConnected &&
          !isFrozenBlock(neighbour)
        ) {
          placeCaretInside(neighbour);
        }
        afterCommand(root);
      },
      [afterCommand, mint, selectAtomic],
    );

    /**
     * **The one path every table edit takes** — the floating strip, the
     * toolbar's menu and Tab at the last cell all end here.
     *
     * The shape of it is the requirement: read the surface back the way every
     * other read does (`domToDocument`), find the block the caret's table
     * became, hand it to the pure operation in `table.ts`, and draw what comes
     * back with `blockToHtml`. Nothing in this file writes wikitext, and
     * nothing in it decides what an operation means; both belong to modules
     * that can be tested without a browser.
     *
     * §4 survives because the block keeps its `data-ve-id`: the next read
     * matches it to the block it was parsed from, so `source`, `canonical` and
     * `gapAfter` ride across and the serializer makes the same "did this
     * change?" decision it makes for every other block. An operation that
     * changed nothing republishes the original bytes; one that changed
     * something publishes §4's canonical form of the table, and only of that
     * table.
     *
     * `land` names the cell the caret should end in, in the coordinates of the
     * table the operation produced, for the one caller whose answer differs
     * from the general rule: Tab grows a row and belongs at the *start* of it,
     * where "insert row below" belongs under the column it was raised from.
     */
    /**
     * The table block this element was parsed from, read back fresh.
     *
     * The read half of every table edit, shared so the operations and the drag
     * cannot disagree about what they are editing. A table the author **pasted**
     * carries no id of ours (§3), and `domToDocument` would mint one that never
     * reaches the markup — so the block would be read, changed, and then not
     * found again. Minting it here costs a pasted table nothing: it has no
     * history to keep (§4).
     */
    const readTableBlock = useCallback(
      (root: HTMLElement, table: HTMLElement): VeTable | null => {
        let id = table.getAttribute("data-ve-id");
        if (id === null || id === "") {
          id = mint();
          table.setAttribute("data-ve-id", id);
        }
        let doc: VeDocument;
        try {
          doc = domToDocument(root, docRef.current, idsRef.current);
        } catch {
          // A read that cannot complete leaves the markup alone; the author's
          // table is still on screen and still theirs.
          return null;
        }
        docRef.current = doc;
        const block = doc.blocks.find((one) => one.id === id);
        return block !== undefined && block.kind === "table" ? block : null;
      },
      [mint],
    );

    /**
     * Draw an edited table back over the one on screen, and land the caret.
     *
     * The write half, shared for the same reason as the read. `want` is where
     * the caret should end up — an operation's `spotAfterOp`, or the row or
     * column a drag just moved — clamped to the table as it now is, because a
     * deletion can leave that spot off the end of it.
     */
    const replaceTableBlock = useCallback(
      (
        root: HTMLElement,
        table: HTMLElement,
        next: VeTable,
        want: { row: number; column: number },
      ): void => {
        const element = elementFromHtml(blockToHtml(next), root.ownerDocument);
        if (element === null) return;
        table.replaceWith(element);
        const rows = tableRowsOf(element);
        const spot = clampSpot(next, want);
        const landing = spot === null ? null : cellAt(rows, spot.row, spot.column);
        if (landing !== null) placeCaretInside(landing);
        afterCommand(root);
        // `afterCommand` pointed both handles at wherever the caret ended up,
        // and the caret is gone with the old element if it could not be placed.
        // The control still belongs on the table, so it is pointed at the first
        // cell rather than left over the block that replaced one it no longer
        // knows.
        if (landing === null) refreshTableHandle(cellAt(rows, 0, 0));
      },
      [afterCommand, refreshTableHandle],
    );

    const applyTableOp = useCallback(
      (
        cellNode: Node | null,
        op: VeTableOp,
        confirmed: boolean,
        land: { row: number; column: number } | null = null,
      ): void => {
        const root = liveRef.current;
        if (root === null || isLocked()) return;
        const found = tableAt(root, cellNode);
        if (found === null || !root.contains(found.table)) return;
        const spot = tableSpotOf(found.table, found.cell);
        if (spot === null) return;
        // All twelve of §3.2's operations end here, so one push covers them
        // (§12) — including the two deletions, which come back through this
        // function a second time with `confirmed`, and push again over a table
        // that is by then unchanged.
        pushHistory(root);

        const block = readTableBlock(root, found.table);
        if (block === null) return;

        const outcome = tableOpOutcome(block, spot, op);
        switch (outcome.kind) {
          case "none":
            return;
          case "refused":
            // `toggleHeaderRow` would have split a cell in two (spec §7.3). It
            // did nothing, which is right, and saying nothing would leave an
            // author clicking a button that visibly does not work.
            setTableDialog({ kind: "refused" });
            return;
          case "delete":
            if (!confirmed) {
              setTableDialog({ kind: "confirm", op, cell: found.cell });
              return;
            }
            removeTable(root, found.table);
            return;
          case "table":
            replaceTableBlock(root, found.table, outcome.table, land ?? spotAfterOp(spot, op));
            return;
        }
      },
      [
        isLocked,
        pushHistory,
        readTableBlock,
        removeTable,
        replaceTableBlock,
      ],
    );

    /**
     * Move a whole row or column to another index — the drag's commit (§3.3).
     *
     * Not a thirteenth operation: `VeTableOp` is positional by design, every
     * one of the twelve acts on the row and column the caret is in, and "put
     * this row at index 4" is not a shape any of them has. It is instead the
     * pure `moveRow` / `moveColumn` (src/lib/visual-editor/table.ts) — which
     * `moveRowUp` and `moveColumnLeft` already reach one step at a time —
     * driven straight from the model, so a drag across six rows is one history
     * step and one re-render rather than six.
     *
     * The caret follows what moved, which is what makes a dragged row still
     * feel like the author's place in the table afterwards.
     */
    const applyTableMove = useCallback(
      (table: HTMLElement, axis: "row" | "column", from: number, to: number): void => {
        const root = liveRef.current;
        if (root === null || isLocked() || from === to) return;
        if (!root.contains(table)) return;
        pushHistory(root);
        const block = readTableBlock(root, table);
        if (block === null) return;
        const next = axis === "row" ? moveRow(block, from, to) : moveColumn(block, from, to);
        // The movers return the table unchanged where the move is not one they
        // can make (an index out of range, a row too short to hold both ends of
        // a column swap). Redrawing it would be a history step for nothing.
        if (next === block) return;
        replaceTableBlock(root, table, next, axis === "row" ? { row: to, column: 0 } : { row: 0, column: to });
      },
      [isLocked, pushHistory, readTableBlock, replaceTableBlock],
    );

    /* ---------------- one atomic node's wikitext ---------------- */

    /**
     * **The only way a new wikitext source reaches an atomic node**, and
     * through `domToDocument` the buffer: the dialog's apply and the branch
     * field's debounce both end here, so a version's words travel one path and
     * there is one place to get it wrong.
     *
     * `repaint` is the difference between the two callers, and it is about the
     * caret rather than about correctness. A dialog closed over a node wants
     * its preview redrawn at once; a keystroke does not, because re-rendering
     * the preview under a live textarea on every debounce costs a fetch per
     * word and moves the ground the author is standing on. The field asks for
     * its repaint when it is left instead (`onBlur` below).
     */
    const applyAtomicSource = useCallback(
      (node: HTMLElement, source: string, repaint: boolean): void => {
        const root = liveRef.current;
        if (root === null || isLocked()) return;
        // The dialog outlives the node it was opened on, and so does a
        // debounced keystroke: a reload or a deletion behind either leaves
        // nothing to write to.
        if (!root.contains(node)) return;
        node.setAttribute("data-ve-src", source);
        if (repaint) {
          resetAtomicBody(node);
          // Force a redraw of the head: the kind, and with it the chip's name
          // and both button labels, may have changed with the wikitext.
          node.classList.remove("ve-atomic");
          decorateAtomic(node, propsRef.current.labels);
          loadFragments(root);
        }
        afterCommand(root);
      },
      [afterCommand, isLocked, loadFragments],
    );

    /* ---------------- the branch field (§6) ---------------- */

    /**
     * Fold the keystrokes the branch field is holding into the block's
     * wikitext, and hand them up the way any other atomic edit is handed up.
     *
     * Everything it refuses is a refusal to guess: a node that has gone, a
     * block with no passage to splice into, a version the block no longer
     * writes for. In each case the keystrokes are dropped rather than written
     * somewhere they were not typed — which is the one outcome worse than
     * losing them.
     */
    const commitBranchEdit = useCallback((): boolean => {
      if (branchTimerRef.current !== null) {
        clearTimeout(branchTimerRef.current);
        branchTimerRef.current = null;
      }
      const pending = branchRef.current;
      branchRef.current = null;
      if (pending === null) return false;
      const root = liveRef.current;
      if (root === null || !root.contains(pending.node)) return false;
      const source = pending.node.getAttribute("data-ve-src");
      if (source === null) return false;
      const next = replaceBranchBody(source, pending.branch, pending.body);
      if (next === null || next === source) return false;
      applyAtomicSource(pending.node, next, false);
      return true;
    }, [applyAtomicSource]);

    const scheduleBranchWrite = useCallback(
      (input: HTMLTextAreaElement): void => {
        const node = input.closest("[data-ve-src]");
        if (!(node instanceof HTMLElement)) return;
        const branch = input.getAttribute(BRANCH_BODY_ATTR);
        if (branch === null) return;

        const pending = branchRef.current;
        // Two branches may never share this one slot. The author who typed
        // into v70, switched to v71 and typed again would otherwise have v70's
        // words replaced by v71's before either was written down — so the one
        // being left is committed before the new one takes the slot.
        if (pending !== null && (pending.node !== node || pending.branch !== branch)) {
          commitBranchEdit();
        }
        branchRef.current = { node, branch, body: input.value };
        if (branchTimerRef.current !== null) clearTimeout(branchTimerRef.current);
        branchTimerRef.current = setTimeout(() => {
          branchTimerRef.current = null;
          commitBranchEdit();
        }, READ_DEBOUNCE_MS);
      },
      [commitBranchEdit],
    );

    /**
     * Everything that reads the buffer comes through here — publish, a mode
     * switch, an edit made outside the surface, choosing another version — so
     * this is where a keystroke still sitting in a debounce is rescued. Both
     * debounces: the field's, into the node's wikitext, and then the surface's,
     * into the string the caller is about to take away.
     */
    const flushNow = useCallback((): string => {
      commitBranchEdit();
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return readNow();
    }, [commitBranchEdit, readNow]);

    const focusSurface = useCallback((): HTMLElement | null => {
      const root = liveRef.current;
      if (root === null) return null;
      if (currentRange(root) === null) {
        const saved = savedRangeRef.current;
        if (saved !== null) applyRange(root, saved);
      }
      if (root.ownerDocument.activeElement !== root) root.focus({ preventScroll: true });
      return root;
    }, []);

    /** The live range, or the last one the surface owned (a toolbar stole focus). */
    const workingRange = useCallback((root: HTMLElement): Range | null => {
      const live = currentRange(root);
      if (live !== null) return live;
      const saved = savedRangeRef.current;
      if (saved === null) return null;
      return root.contains(saved.commonAncestorContainer) ? saved : null;
    }, []);

    /* ---------------- atomic nodes ---------------- */

    const openAtomic = useCallback((node: HTMLElement): void => {
      const source = node.getAttribute("data-ve-src");
      if (source === null) return;
      const kind = atomicKindOf(source);
      propsRef.current.onEditAtomic({ source, atomic: kind, label: atomicLabelOf(kind, source) });
    }, []);

    const removeAtomic = useCallback(
      (node: HTMLElement): void => {
        const root = liveRef.current;
        if (root === null) return;
        selectAtomic(null);
        // Deleting through the browser keeps the node on the native undo stack;
        // a bare `remove()` would make Ctrl+Z step straight past the deletion.
        if (!(selectNode(node) && exec(root, "delete")) || node.isConnected) node.remove();
        if (root.firstElementChild === null) {
          const paragraph = newParagraph(root.ownerDocument, mint());
          root.appendChild(paragraph);
          placeCaretInside(paragraph);
        }
        afterCommand(root);
      },
      [afterCommand, mint, selectAtomic],
    );

    /** The branch textarea holding `version`, once one is on screen. */
    const branchInputFor = useCallback((version: string): HTMLTextAreaElement | null => {
      const root = liveRef.current;
      if (root === null) return null;
      const key = version.trim().toLowerCase();
      for (const input of Array.from(root.querySelectorAll("textarea"))) {
        if ((input.getAttribute(BRANCH_BODY_ATTR) ?? "").trim().toLowerCase() === key) return input;
      }
      return null;
    }, []);

    /* ---------------- find and replace (§9) ---------------- */

    /**
     * Put one buffer match on screen: scroll its block into view and select the
     * text with a Range.
     *
     * **It writes nothing.** No wrapper, no class, no attribute — a selection is
     * made of nodes that are already there, so `domToDocument` sees exactly what
     * it saw before and §4's byte-identical republish is untouched. That is the
     * whole reason the panel does not highlight every hit the way a code editor
     * would: markup wearing none of our labels is read back as the author's (§3),
     * and a marker left behind by a stripping pass that ran a moment late would
     * publish itself into a block nobody edited.
     *
     * Everything about the crossing is best effort, and deliberately fails by
     * doing *less* rather than by guessing: no block, no scroll; a chip, or a
     * needle the rendering does not spell (a match that spans `'''`), and the
     * block is scrolled to with nothing selected.
     */
    const revealMatch = useCallback((request: VeRevealRequest): void => {
      const root = liveRef.current;
      if (root === null) return;
      const block = blockElementAt(root, request.blockId, request.blockIndex);
      if (block === null) return;
      block.scrollIntoView({ block: "nearest" });
      // An atomic chip's body is the engine's rendering of the author's
      // wikitext (§5), not the buffer's text: nothing in it is the match.
      if (block.hasAttribute("data-ve-src")) return;

      const nodes: Text[] = [];
      collectTextNodes(block, nodes);
      const starts: number[] = [];
      let text = "";
      for (const node of nodes) {
        starts.push(text.length);
        text += node.data;
      }

      const hits = findMatches(text, request.needle, {
        caseSensitive: request.caseSensitive,
        wholeWord: request.wholeWord,
      });
      if (hits.length === 0) return;
      // The ordinal was counted in the wikitext, which can hold occurrences the
      // rendering does not (inside an inline template's source); clamping is
      // how "the last one I can see" beats refusing to move at all.
      const hit = hits[Math.min(request.occurrence, hits.length - 1)];
      const from = textPosition(nodes, starts, hit.start);
      const to = textPosition(nodes, starts, hit.end);
      if (from === null || to === null) return;

      const range = root.ownerDocument.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      applyRange(root, range);
      // A tall block scrolled to its top can leave the hit below the fold, so
      // the hit's own line gets the last word.
      from.node.parentElement?.scrollIntoView({ block: "nearest" });
    }, []);

    /* ---------------- toolbar commands ---------------- */

    const applyMark = useCallback((root: HTMLElement, mark: VeMark): void => {
      if (mark === "code") {
        toggleCodeMark(root);
        return;
      }
      // Tags, not inline styles: both read back (§3), but only tags round-trip
      // into wikitext without the serializer having to invent markup.
      exec(root, "styleWithCSS", "false");
      switch (mark) {
        case "bold":
          exec(root, "bold");
          return;
        case "italic":
          exec(root, "italic");
          return;
        case "underline":
          exec(root, "underline");
          return;
        case "strike":
          exec(root, "strikeThrough");
          return;
        case "sup":
          exec(root, "superscript");
          return;
        case "sub":
          exec(root, "subscript");
          return;
      }
    }, []);

    const applyFormat = useCallback(
      (root: HTMLElement, format: VeBlockFormat): void => {
        const range = workingRange(root);
        let block = nearestBlock(root, range === null ? null : range.startContainer);
        if (block === null || isFrozenBlock(block)) return;

        if (formatStep(block.nodeName, false) === "command") {
          // Leaving a list is the browser's own job — toggling the command off
          // splits the run at the caret, which is what an author expects — and
          // it hands back a plain block for the rewrite below.
          exec(root, block.nodeName === "OL" ? "insertOrderedList" : "insertUnorderedList");
          const after = currentRange(root);
          block = nearestBlock(root, after === null ? null : after.startContainer);
          if (block === null || isFrozenBlock(block)) return;
        }
        if (formatStep(block.nodeName, true) === "lift") {
          // Still standing in a list: pull the caret's line out as its own
          // block, which is what the command was asked to do. A line the lift
          // cannot take out safely keeps the format it has.
          const caret = workingRange(root);
          const lifted = liftListItem(
            root,
            caret === null ? null : caret.startContainer,
            mint(),
          );
          if (lifted === null) return;
          block = lifted;
        }

        if (format === "pre") {
          // §2 has no preformatted *block*: leading-space lines are an atomic,
          // so the format turns the block into one and the chip renders it.
          const text = block.textContent ?? "";
          const source = text
            .split("\n")
            .map((line) => ` ${line}`)
            .join("\n");
          const node = atomicElement(root.ownerDocument, source, true, mint());
          if (node === null) return;
          block.replaceWith(node);
          decorateAtomic(node, propsRef.current.labels);
          if (node.nextElementSibling === null) {
            node.after(newParagraph(root.ownerDocument, mint()));
          }
          placeCaretAfter(node);
          loadFragments(root);
          return;
        }

        const { tag, ve } = tagForFormat(format);
        if (block.nodeName.toLowerCase() === tag) return;
        const next = replaceBlockTag(block, tag, ve);
        // **An empty block loses the caret to that replacement.** The children
        // are moved rather than cloned, so a caret standing in a text node
        // rides across on its own — but an empty line has no text node, the
        // caret stands on the *element*, and `replaceBlockTag` takes that
        // element out of the document. The range is then anchored to a node
        // the tree no longer holds: `currentRange` says the surface has no
        // caret, and the heading the author just asked for takes no typing.
        //
        // It is not an edge case. It is the line "/" is pressed in — the slash
        // and its query are deleted first, which is what empties it — and the
        // "## " input rule reaches this by the same road.
        //
        // "Is the caret still there" rather than "is there a caret at all",
        // because engines disagree about what a removed node does to the
        // selection: one leaves the range detached (and `currentRange` calls
        // that no caret), another slides it onto the *root* at the child index
        // — which reads as a perfectly good caret standing outside every block,
        // where the next character typed is a bare text node the model has to
        // make a paragraph of.
        if (next !== null) {
          const after = currentRange(root);
          if (after === null || !next.contains(after.startContainer)) placeCaretInside(next);
        }
      },
      [loadFragments, mint, workingRange],
    );

    const removeLinks = useCallback(
      (root: HTMLElement): void => {
        const range = workingRange(root);
        if (range === null) return;
        const anchors: HTMLElement[] = [];
        const enclosing = nearestMatching(root, range.startContainer, isAnchor);
        if (enclosing !== null && !isInAtomic(enclosing)) anchors.push(enclosing);
        for (const node of Array.from(root.querySelectorAll("a"))) {
          if (!(node instanceof HTMLElement) || anchors.includes(node)) continue;
          // A selection that spans a chip also spans the links inside its
          // rendered preview, and those are not the author's markup — the
          // preview is painted from `/api/preview/fragments` and is thrown away
          // on the next repaint. Unwrapping them would mangle what is on screen
          // and change nothing that gets saved (§5).
          if (isInAtomic(node)) continue;
          if (rangeTouchesNode(range, node)) anchors.push(node);
        }
        for (const anchor of anchors) unwrapElement(anchor);
      },
      [workingRange],
    );

    const insertAtomic = useCallback(
      (root: HTMLElement, source: string, block: boolean): void => {
        // The insertion is DOM surgery rather than `execCommand`, so it needs
        // §12's stack to be undoable at all.
        pushHistory(root);
        // **A cell takes it inline, whatever the caller asked for.** A cell
        // holds inline content and nothing else (wikitext-spec §7.3), and
        // `nearestBlock` inside one answers with the *table* — so a block
        // insertion made from a cell used to land after the whole table. That
        // is what happened to a version block composed from inside a cell: the
        // author aimed the tag at the cell and the editor put it below the
        // grid (versioning.md §6). The menus already keep genuinely
        // block-shaped constructs out of a cell, so what reaches here is a
        // construct that can be inline — a version tag, a link, a picture, a
        // template call. A multi-line source is the one thing that cannot:
        // §7.3 has no way to spell it in a cell, so it keeps the old placement
        // rather than being written as markup the next parse would refuse.
        const range = workingRange(root);
        const inCell = isCellHost(caretHost(root, range === null ? null : range.startContainer));
        const asBlock = block && !(inCell && !source.includes("\n"));
        const node = asBlock
          ? insertedBlockElement(root.ownerDocument, source, mint())
          : atomicElement(root.ownerDocument, source, false, mint());
        if (node === null) return;
        if (asBlock) {
          const host = nearestBlock(root, range === null ? null : range.startContainer);
          if (host !== null) {
            host.after(node);
          } else if (range !== null && range.startContainer === root) {
            // The boundary is the root itself, which names a gap rather than a
            // block — where the surface leaves the caret after every insertion
            // and every click on a chip. Reading the offset puts the new block
            // in that gap; appending would put it at the end of the article.
            const children = Array.from(root.childNodes);
            const at = range.startOffset;
            const child = at < children.length ? children[at] : null;
            const index = rootInsertIndex(
              children.length,
              at,
              child !== null && rangeSelectsNode(range, child),
            );
            root.insertBefore(node, index < children.length ? children[index] : null);
          } else {
            root.appendChild(node);
          }
          // A document ending in a chip has nowhere left to click, so an
          // insertion at the end brings its own paragraph with it.
          if (node.nextElementSibling === null) {
            node.after(newParagraph(root.ownerDocument, mint()));
          }
        } else if (range === null) {
          root.appendChild(node);
        } else {
          replaceRangeWith(range, node);
        }
        decorateAtomic(node, propsRef.current.labels);
        // A table lands the caret in its first cell rather than behind the
        // whole block: it went in to be filled, and that is the cell §3.2's
        // controls are then about.
        const cell = node.nodeName === "TABLE" ? cellAt(tableRowsOf(node), 0, 0) : null;
        if (cell !== null) placeCaretInside(cell);
        else placeCaretAfter(node);
        loadFragments(root);
      },
      [loadFragments, mint, pushHistory, workingRange],
    );

    /**
     * The clipboard, in the units this surface puts things in (§11).
     *
     * `readPaste` decides *what* the clipboard means and this decides *where*
     * it goes, which is the same split every other control in this file keeps.
     * Two placements, because the two answers are different kinds of thing:
     *
     * - **inline** goes in through `insertHTML`, so the browser splits nothing,
     *   deletes the selection itself and — the part that matters — records the
     *   paste in its own undo stack. That is the common paste: a link, a name,
     *   a sentence with emphasis in it, landing mid-sentence.
     * - **blocks** are placed the way every other block insertion is placed
     *   (`insertAtomic`): after the block the caret is in, or *over* it where
     *   that block is empty, which is the paste an author actually makes — the
     *   caret on a blank line, a document on the clipboard. Splitting a
     *   paragraph around them would be a second insertion path to keep, and
     *   `ve-history.ts` covers the undo either way.
     */
    const insertPaste = useCallback(
      (root: HTMLElement, wikitext: string, blocks: boolean): void => {
        if (!blocks) {
          const html = inlineToHtml(parseInlineRun(wikitext));
          if (html !== "") exec(root, "insertHTML", html);
          return;
        }
        const doc = parseDocument(wikitext);
        if (doc.blocks.length === 0) return;
        const made = doc.blocks
          .map((block) => elementFromHtml(blockToHtml(asNewBlock(block, mint())), root.ownerDocument))
          .filter((node): node is HTMLElement => node !== null);
        if (made.length === 0) return;

        const range = workingRange(root);
        const host = nearestBlock(root, range === null ? null : range.startContainer);
        // An empty paragraph is what the author is standing on, not content
        // they wrote: the paste takes its place rather than leaving a blank
        // line above itself.
        const empty =
          host !== null &&
          host.nodeName === "P" &&
          (host.textContent ?? "") === "" &&
          host.querySelector("[data-ve-src],hr,img,table") === null;
        if (host !== null) {
          host.after(...made);
          if (empty) host.remove();
        } else {
          for (const node of made) root.appendChild(node);
        }
        const last = made[made.length - 1];
        // A document ending in a chip has nowhere left to click, so a paste at
        // the end brings its own paragraph with it — the rule `insertAtomic`
        // already keeps.
        if (last.nextElementSibling === null) {
          last.after(newParagraph(root.ownerDocument, mint()));
        }
        // The root, not each block: `decorateAtomics` looks *inside* what it is
        // given, so handing it a block that is itself a chip would skip that
        // chip's own chrome — and a pasted `{{Infobox}}` is exactly that.
        decorateAtomics(root, propsRef.current.labels);
        const cell = last.nodeName === "TABLE" ? cellAt(tableRowsOf(last), 0, 0) : null;
        if (cell !== null) placeCaretInside(cell);
        else placeCaretAfter(last);
        loadFragments(root);
      },
      [loadFragments, mint, workingRange],
    );

    const applyAction = useCallback(
      (action: VisualAction): void => {
        const root = focusSurface();
        if (root === null || isLocked()) return;

        switch (action.kind) {
          case "undo":
          case "redo":
            // The structural stack first, exactly as `Ctrl+Z` asks it (§12):
            // an undo button that could not walk back the move a menu row just
            // made would be the same control answering two different questions.
            if (!stepHistory(action.kind)) exec(root, action.kind);
            break;
          case "help":
          case "toggleRail":
          case "link":
          case "media":
            // Chrome the editor island owns (actions.ts); the surface has no
            // dialogs of its own and nothing to do with them.
            return;
          case "format":
            applyFormat(root, action.format);
            break;
          case "mark":
            applyMark(root, action.mark);
            break;
          case "clearFormatting":
            clearFormatting(root);
            break;
          case "list":
            exec(root, action.list === "bullet" ? "insertUnorderedList" : "insertOrderedList");
            break;
          case "indent":
            exec(root, action.delta === 1 ? "indent" : "outdent");
            break;
          case "unlink":
            removeLinks(root);
            break;
          case "insert":
            insertAtomic(root, action.source, action.block);
            break;
          case "wikitext":
            insertPaste(root, action.source, action.block === true);
            break;
          case "text":
            exec(root, "insertText", action.text);
            break;
          case "table": {
            // The table edit reads the surface back itself, runs its own
            // `afterCommand`, and may open a dialog instead of touching
            // anything — so it returns rather than falling through to a second
            // pass that would have nothing to do.
            const range = workingRange(root);
            applyTableOp(
              range === null ? tableCellRef.current : range.startContainer,
              action.op,
              false,
            );
            return;
          }
          case "block": {
            // The caret's block, because an action names none (§3.1): the
            // grip's menu is the road that points at a block with a pointer,
            // and it calls `runBlockCommand` itself. Each of those commands
            // does its own housekeeping — several of them ARE structural edits
            // with a history entry to push — so this returns too.
            const range = workingRange(root);
            const at = selectedRef.current ?? (range === null ? null : range.startContainer);
            runBlockCommandRef.current?.(at === null ? null : nearestBlock(root, at), action.command);
            return;
          }
        }
        afterCommand(root);
      },
      [
        afterCommand,
        applyFormat,
        applyMark,
        applyTableOp,
        focusSurface,
        insertAtomic,
        insertPaste,
        isLocked,
        removeLinks,
        stepHistory,
        workingRange,
      ],
    );

    /**
     * One action, wherever it came from — a slash row, a bubble button, an
     * input rule.
     *
     * The split is the retired toolbar's, unchanged: what the surface can do
     * to its own document it does, and what needs a dialog goes up to the
     * island. Nothing here knows which dialog, which is why the vocabulary is
     * still `EditorChromeAction` and not a callback per flow.
     */
    const runAction = useCallback(
      (action: VisualAction): void => {
        if (isChromeAction(action)) {
          propsRef.current.onChromeAction?.(action);
          return;
        }
        applying(() => applyAction(action));
      },
      [applyAction, applying],
    );

    /* ---------------- the slash menu, applied (§1) ---------------- */

    /**
     * Open the menu where the caret is, by **typing the slash**.
     *
     * The "+" could have shown the panel out of nowhere, and that is what
     * Notion does; writing the character instead means there is exactly one
     * way in and one way out. The menu is a reading of what is in the block,
     * so Escape leaves an ordinary "/" behind whether it was typed by hand or
     * put there by a button — and one Backspace is the whole undo.
     */
    const openSlashHere = useCallback((): void => {
      const root = liveRef.current;
      if (root === null || isLocked()) return;
      applying(() => exec(root, "insertText", "/"));
      syncSlash();
    }, [applying, isLocked, syncSlash]);

    /**
     * A row was chosen: take the "/query" the author typed back out, then run
     * the row's action.
     *
     * The deletion goes through the browser's own delete so it stays on the
     * native undo stack. What it measures is **the line as it reads now**,
     * falling back to the `consumed` the menu captured: the live line is the
     * one being deleted from, so where it still has a slash in front of the
     * caret it is the better answer — a remembered count can only be a count
     * from before the last keystroke, and that is how "/제목" used to lose its
     * "제목" into the heading it had just made. The fallback is what a pointer
     * click needs, which may have moved the caret out of the line entirely
     * before this runs.
     */
    const chooseSlashItem = useCallback(
      (item: SlashItem): void => {
        const root = liveRef.current;
        const state = slashRef.current;
        setSlash(null);
        slashRef.current = null;
        slashOffRef.current = null;
        if (root === null || state === null || isLocked()) return;
        applying(() => {
          const range = currentRange(root);
          const host = range === null ? null : caretHost(root, range.startContainer);
          const reading = host === null || range === null ? null : hostText(host, range);
          if (reading === null) return;
          const live = slashContext(reading.text.slice(0, reading.offset));
          if (selectBackward(root, reading, live?.consumed ?? state.consumed)) {
            exec(root, "delete");
          }
        });
        runAction(item.action);
      },
      [applying, isLocked, runAction],
    );

    /* ---------------- `[[`, `@` and `{{` (§13) ---------------- */

    /**
     * Notice a trigger in front of the caret, or take the panel away.
     *
     * This is `syncSlash`'s shape, deliberately: both are a reading of the
     * text before the caret and neither writes anything, so an author who
     * ignores the panel and closes their own brackets ends up with exactly the
     * wikitext they typed. What differs is only which reading — `mentionContext`
     * rather than `slashContext` — and that the rows arrive from a search
     * instead of from a catalogue, which is why the query is kept and the
     * items are not built here.
     */
    const syncMention = useCallback((): void => {
      const root = liveRef.current;
      if (root === null) return;
      const close = (): void => setMention((current) => (current === null ? current : null));
      // Composing is not a reason to close this one either — and it matters
      // most here, where the query is a **page title** and this wiki's titles
      // are Korean (`onCompositionStart`).
      if (isLocked() || propsRef.current.dialogOpen === true) {
        close();
        return;
      }
      const range = currentRange(root);
      if (range === null || !range.collapsed) {
        close();
        return;
      }
      const host = caretHost(root, range.startContainer);
      if (host === null || isInAtomic(host)) {
        close();
        return;
      }
      const reading = hostText(host, range);
      if (reading === null) {
        close();
        return;
      }
      const before = reading.text.slice(0, reading.offset);
      const context = mentionContext(before);
      if (context === null) {
        mentionOffRef.current = null;
        close();
        return;
      }
      // The other half of the rule `syncSlash` keeps: the nearer trigger wins,
      // and here a tie goes to the slash, which is checked first.
      const rival = slashContext(before);
      if (rival !== null && rival.consumed <= context.consumed) {
        close();
        return;
      }
      // The line up to and including the trigger — the identity of *this* one,
      // so a dismissed panel stays dismissed however much is typed after it.
      const head = before.slice(0, before.length - context.query.length);
      if (mentionOffRef.current === head) {
        close();
        return;
      }
      mentionOffRef.current = null;
      const anchor = slashAnchor(root, reading, context.consumed) ?? caretAnchor(range);
      if (anchor === null) {
        close();
        return;
      }
      setMention((current) => {
        // The same trigger and the same query is the same panel: a caret move
        // inside it must not restart the search, and must not put `busy` back
        // on over an answer that has already arrived.
        if (current !== null && current.kind === context.kind && current.query === context.query) {
          if (current.anchor.top === anchor.top && current.anchor.left === anchor.left) {
            return current;
          }
          return { ...current, anchor, consumed: context.consumed };
        }
        return {
          anchor,
          kind: context.kind,
          query: context.query,
          consumed: context.consumed,
          // The rows already on screen stay while the next answer is owed: a
          // panel that emptied itself on every keystroke would flash once a
          // letter, and the rows it is showing are still the best answer known.
          items: current !== null && current.kind === context.kind ? current.items : [],
          busy: true,
        };
      });
    }, [isLocked]);

    /**
     * The search behind the panel — the page index for `[[` and `@`, the
     * `Template:` namespace for `{{`.
     *
     * Both routes are the ones the dialogs already use (§5.1, §5.4), so a row
     * here and a row there name the same pages: this is a second *way in*, not
     * a second index. The debounce and the abort are `editor-link-dialog.tsx`'s
     * discipline for the same reason it has them — a request per keystroke
     * answers a query the author has already finished typing.
     */
    const mentionKind = mention === null ? null : mention.kind;
    const mentionQuery = mention === null ? null : mention.query;
    useEffect(() => {
      // **Never on the whole state object.** The answer lands by calling
      // `setMention`, so an effect keyed on that state would schedule the next
      // request out of its own result and search forever. The trigger and the
      // query are the only things a search depends on.
      if (mentionKind === null || mentionQuery === null) return;
      const kind = mentionKind;
      const query = mentionQuery;
      const controller = new AbortController();
      const locale = propsRef.current.locale;
      const handle = setTimeout(() => {
        const url =
          kind === "page"
            ? `/api/search/suggest?q=${encodeURIComponent(query)}&locale=${encodeURIComponent(locale)}`
            : `/api/templates?q=${encodeURIComponent(query)}&locale=${encodeURIComponent(locale)}`;
        fetch(url, { signal: controller.signal })
          .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
          .then((body: unknown) => {
            const items = mentionRows(kind, body);
            setMention((current) =>
              // Only *this* query's answer lands: a slower request for an
              // earlier query must not overwrite a later one's rows.
              current === null || current.kind !== kind || current.query !== query
                ? current
                : { ...current, items, busy: false },
            );
          })
          .catch(() => {
            // A failed search is not an empty index. The panel stops saying it
            // is searching and keeps whatever rows it had.
            setMention((current) =>
              current === null || current.kind !== kind || current.query !== query
                ? current
                : { ...current, busy: false },
            );
          });
      }, MENTION_DEBOUNCE_MS);
      return () => {
        clearTimeout(handle);
        controller.abort();
      };
    }, [mentionKind, mentionQuery]);

    /**
     * A row was taken: delete the `[[query` the author typed, then write what
     * the row means.
     *
     * A page writes its own link, because that is what was being spelled. A
     * template raises §5.1's dialog on itself instead — the braces are never
     * the answer for a template that has parameters, and an infobox with none
     * renders nothing at all.
     */
    const chooseMention = useCallback(
      (item: SlashItem): void => {
        const root = liveRef.current;
        const state = mentionRef.current;
        setMention(null);
        mentionRef.current = null;
        mentionOffRef.current = null;
        if (root === null || state === null || isLocked()) return;
        applying(() => {
          const range = currentRange(root);
          const host = range === null ? null : caretHost(root, range.startContainer);
          const reading = host === null || range === null ? null : hostText(host, range);
          if (reading === null) return;
          // The live trigger, for the reason `chooseSlashItem` gives: the line
          // being deleted from is the one that knows how much of it is the
          // "[[query" — and a Korean title is where a stale count showed.
          const live = mentionContext(reading.text.slice(0, reading.offset));
          const consumed = live !== null && live.kind === state.kind ? live.consumed : state.consumed;
          if (selectBackward(root, reading, consumed)) exec(root, "delete");
        });
        runAction(item.action);
      },
      [applying, isLocked, runAction],
    );

    /** Escape, or a click away: leave the brackets, take the panel. */
    const dismissMention = useCallback((): void => {
      const state = mentionRef.current;
      if (state === null) return;
      const root = liveRef.current;
      const range = root === null ? null : currentRange(root);
      const host = root === null || range === null ? null : caretHost(root, range.startContainer);
      const reading = host === null || range === null ? null : hostText(host, range);
      mentionOffRef.current =
        reading === null
          ? null
          : reading.text.slice(0, reading.offset - state.query.length);
      setMention(null);
      focusSurface();
    }, [focusSurface]);

    /* ---------------- the gutter handle's menu (§3.1) ---------------- */

    /**
     * Notion's main gesture: a new empty paragraph under this block, with the
     * menu already open on it. "+" and the grip menu's "Insert below" are the
     * same act, which is why they are one function.
     */
    const insertParagraphBelow = useCallback(
      (target: Node): void => {
        const root = liveRef.current;
        if (root === null || isLocked()) return;
        const unit = blockUnitOf(root, target);
        if (unit === null) return;
        const last = unit.members[unit.members.length - 1];
        const paragraph = newParagraph(root.ownerDocument, mint());
        root.insertBefore(paragraph, last.nextSibling);
        focusSurface();
        placeCaretInside(paragraph);
        afterCommand(root);
        openSlashHere();
      },
      [afterCommand, focusSurface, isLocked, mint, openSlashHere],
    );

    /**
     * The click in the empty space under the article (§14).
     *
     * Where the page already ends in an empty paragraph the caret simply goes
     * into it — clicking below a blank line twice must not leave two blank
     * lines behind, and an author who does it repeatedly would otherwise fill
     * the end of the article with them. Otherwise one paragraph is added, and
     * that insertion is structural (§12), so it pushes a snapshot.
     *
     * No slash menu opens here, unlike the handle's "+": the pointer went to
     * the end of the page to write, not to pick a block, and a panel over the
     * first keystroke would be in the way.
     */
    const appendParagraph = useCallback(
      (root: HTMLElement): void => {
        if (isLocked()) return;
        const last = root.lastElementChild;
        const reuse =
          last instanceof HTMLElement &&
          last.nodeName === "P" &&
          (last.textContent ?? "") === "" &&
          last.querySelector("[data-ve-src],hr,img,table") === null
            ? last
            : null;
        focusSurface();
        if (reuse !== null) {
          placeCaretInside(reuse);
          afterCommand(root);
          return;
        }
        pushHistory(root);
        const paragraph = newParagraph(root.ownerDocument, mint());
        root.appendChild(paragraph);
        placeCaretInside(paragraph);
        afterCommand(root);
      },
      [afterCommand, focusSurface, isLocked, mint, pushHistory],
    );

    /**
     * A copy of the block, immediately under it.
     *
     * The copy is given **fresh ids**, and that is the whole of §4 here: an id
     * is what `domToDocument` matches a block to the one it was parsed from,
     * so a copy carrying the original's id would be two blocks claiming one
     * history and the serializer would emit somebody's original bytes twice.
     * A new id has no `prev` entry, which is exactly what a block created in
     * the editor is — it publishes canonically, and the original beside it
     * still publishes from `source`.
     */
    const duplicateBlockUnit = useCallback(
      (target: Node): void => {
        const root = liveRef.current;
        if (root === null || isLocked()) return;
        const unit = blockUnitOf(root, target);
        if (unit === null) return;
        pushHistory(root);
        let anchor: Node = unit.members[unit.members.length - 1];
        for (const member of unit.members) {
          const copy = member.cloneNode(true);
          if (copy instanceof HTMLElement) {
            for (const element of [copy, ...Array.from(copy.querySelectorAll("[data-ve-id]"))]) {
              if (element.hasAttribute("data-ve-id")) element.setAttribute("data-ve-id", mint());
            }
            // A `<textarea>`'s live value is not in its markup, so a copied
            // branch field would come out blank. Dropping it lets
            // `syncBranchFields` build a real one from the block's wikitext,
            // which is the only place that text was ever kept anyway (§5).
            for (const field of Array.from(copy.querySelectorAll(`[${BRANCH_ATTR}]`))) {
              field.remove();
            }
          }
          root.insertBefore(copy, anchor.nextSibling);
          anchor = copy;
        }
        afterCommand(root);
      },
      [afterCommand, isLocked, mint, pushHistory],
    );

    /**
     * Take the block out, through the browser's own delete so `Ctrl+Z` brings
     * it back whole — the same bargain `removeAtomic` and `removeTable` make.
     * A document left with nothing at all gets a paragraph, because a
     * childless contenteditable gives the caret nowhere to stand.
     */
    const deleteBlockUnit = useCallback(
      (target: Node): void => {
        const root = liveRef.current;
        if (root === null || isLocked()) return;
        const unit = blockUnitOf(root, target);
        if (unit === null) return;
        const first = unit.members[0];
        const last = unit.members[unit.members.length - 1];
        const after = last.nextSibling;
        const before = first.previousSibling;
        selectAtomic(null);
        applying(() => {
          const range = root.ownerDocument.createRange();
          range.setStartBefore(first);
          range.setEndAfter(last);
          if (!(applyRange(root, range) && exec(root, "delete"))) {
            for (const member of unit.members) member.parentNode?.removeChild(member);
          }
          for (const member of unit.members) {
            if (member.isConnected) member.parentNode?.removeChild(member);
          }
        });
        if (root.firstElementChild === null) {
          const paragraph = newParagraph(root.ownerDocument, mint());
          root.appendChild(paragraph);
          placeCaretInside(paragraph);
        } else {
          const neighbour = after instanceof HTMLElement ? after : before;
          if (
            neighbour instanceof HTMLElement &&
            neighbour.isConnected &&
            !isFrozenBlock(neighbour)
          ) {
            placeCaretInside(neighbour);
          }
        }
        afterCommand(root);
      },
      [afterCommand, applying, isLocked, mint, selectAtomic],
    );

    /**
     * One block command, against a block named by the caller.
     *
     * Split out of `onBlockCommand` for the right-click menu, which is about
     * the block the *pointer* was over: the gutter handle's block and the
     * context menu's are different questions, and only the handle's is the one
     * `moveBlockRef` answers.
     */
    const runBlockCommand = useCallback(
      (block: HTMLElement | null, command: BlockMenuCommand): void => {
        const root = liveRef.current;
        if (root === null || block === null || isLocked() || !root.contains(block)) return;
        switch (command.kind) {
          case "insertBelow":
            insertParagraphBelow(block);
            return;
          case "duplicate":
            duplicateBlockUnit(block);
            return;
          case "delete":
            deleteBlockUnit(block);
            return;
          case "move":
            moveBlockUnit(block, command.direction);
            return;
          case "turnInto":
            // The menu acts on the block the caller named, which need not be
            // the block the caret is in — so the caret is moved there first,
            // since every format command is written against it.
            focusSurface();
            placeCaretInside(block);
            applying(() => {
              applyFormat(root, command.format);
              afterCommand(root);
            });
            return;
        }
      },
      [
        afterCommand,
        applyFormat,
        applying,
        deleteBlockUnit,
        duplicateBlockUnit,
        focusSurface,
        insertParagraphBelow,
        isLocked,
        moveBlockUnit,
      ],
    );

    const onBlockCommand = useCallback(
      (command: BlockMenuCommand): void => runBlockCommand(moveBlockRef.current, command),
      [runBlockCommand],
    );

    /**
     * Walk the caret to the next cell, or grow a row at the last one (§3.2) —
     * `false` where the caret is not in a table, which leaves the key alone.
     *
     * One implementation, two callers, because the two keys that reach it
     * arrive on **different events**: Tab on `keydown`, Enter on `beforeinput`.
     */
    const stepTableCell = useCallback(
      (back: boolean): boolean => {
        const root = liveRef.current;
        if (root === null || isLocked()) return false;
        const caret = currentRange(root);
        const found = tableAt(root, caret === null ? null : caret.startContainer);
        const spot = found === null ? null : tableSpotOf(found.table, found.cell);
        if (found === null || spot === null) return false;
        const step = tableTabStep(spot, back);
        if (step.kind === "cell") {
          const target = cellAt(tableRowsOf(found.table), step.row, step.column);
          // A caret move and nothing else: no markup changes, so nothing is
          // re-serialized and §4 is not even consulted.
          if (target !== null) {
            placeCaretInside(target);
            reportContext();
            refreshBlockHandle(target);
            refreshTableHandle(target);
          }
          return true;
        }
        if (step.kind === "append") {
          // The new row is written at the start, not under the column the key
          // happened to be in: the author is about to type the row.
          applyTableOp(found.cell, "insertRowBelow", false, { row: spot.row + 1, column: 0 });
          return true;
        }
        return false;
      },
      [applyTableOp, isLocked, refreshBlockHandle, refreshTableHandle, reportContext],
    );

    /**
     * Remember a cell exactly as it stands, so a break that lands in it anyway
     * can be told from everything that was already there.
     *
     * The `<br>`s and block wrappers are held **by node**, not by count: a
     * count cannot say *which* one is new, and the break Blink makes at the end
     * of a cell is two `<br>`s while the one it makes mid-word is a single. A
     * chip's rendered preview is the engine's drawing rather than the author's
     * markup (§5), so nothing inside one is ever counted or touched.
     */
    const armCellBreak = useCallback((cell: HTMLElement, step: boolean): void => {
      const mine = (node: Node): boolean =>
        !(node instanceof HTMLElement && node.closest("[data-ve-src]") !== null);
      cellBreakRef.current = {
        cell,
        step,
        breaks: new Set(Array.from(cell.querySelectorAll("br")).filter(mine)),
        wrappers: new Set(Array.from(cell.querySelectorAll("p,div")).filter(mine)),
      };
    }, []);

    /**
     * Take a landed break back off the cell, and then take Tab's step (§3.2).
     *
     * The inverse of `armCellBreak`, and deliberately the narrowest one that
     * can be written: every `<br>` and every wrapper in the cell that the
     * snapshot does not hold is removed, and nothing else is looked at. A
     * wrapper is unwrapped rather than deleted, because Blink's own Enter can
     * put the author's words inside one — the model folds two blocks in a cell
     * into one run anyway (dom.ts, `isCellWrapper`), so this only makes the
     * screen agree with what would have published.
     *
     * Runs on `input`, on `compositionend` and on the next key, because the
     * break can land on any of the three and the surface must not be caught
     * reading a buffer that has one in it. Idempotent: a pass that finds
     * nothing new leaves the snapshot armed for the pass that will.
     *
     * The step waits for the IME exactly as the refusal does — a caret may not
     * leave a cell with a half-assembled syllable in it — so an Enter the
     * composition ended on heals the cell now and steps on the author's next
     * press.
     */
    const healCellBreak = useCallback((step: boolean): void => {
      const armed = cellBreakRef.current;
      if (armed === null) return;
      const root = liveRef.current;
      if (root === null || !root.contains(armed.cell)) {
        cellBreakRef.current = null;
        return;
      }
      const { cell, breaks, wrappers } = armed;
      const mine = (node: Node): boolean =>
        !(node instanceof HTMLElement && node.closest("[data-ve-src]") !== null);
      let healed = false;
      for (const node of Array.from(cell.querySelectorAll("br"))) {
        if (breaks.has(node) || !mine(node)) continue;
        node.remove();
        healed = true;
      }
      for (const node of Array.from(cell.querySelectorAll("p,div"))) {
        if (wrappers.has(node) || !mine(node) || !cell.contains(node)) continue;
        unwrapElement(node);
        healed = true;
      }
      if (!healed) return;
      cellBreakRef.current = null;
      // A cell emptied by all of that needs its height back, and it has to be
      // the **labelled** filler: an unlabelled `<br>` is an authored spacer
      // line and comes back as one (dom.ts, `editableBody`).
      if (cell.querySelector("br,[data-ve-src]") === null && isHolderOnly(cell.textContent ?? "")) {
        const filler = cell.ownerDocument.createElement("br");
        filler.setAttribute("data-ve-filler", "");
        cell.appendChild(filler);
      }
      // The caret may have been standing in what has just been removed.
      if (currentRange(root) === null) placeCaretInside(cell);
      // A delete's repair leaves the caret where the author put it: only an
      // Enter's means "and go to the next cell".
      if (!step || !armed.step || composingRef.current) return;
      placeCaretInside(cell);
      stepTableCell(false);
    }, [stepTableCell]);

    /**
     * **A cell never takes a paragraph break** (§3.2), and this is the only
     * place that can promise it.
     *
     * The first two cuts of this read the *key*, and both were wrong for the
     * same reason: while an IME is composing, Chrome does not report `Enter` at
     * all. It reports `key: "Process"`, `keyCode: 229` — the key belongs to the
     * IME, and the browser says so by refusing to name it. Korean composes
     * every syllable, so the last one is always still composing when Enter is
     * pressed, and `event.key === "Enter"` was therefore *never* true for the
     * author who reported this. The break went in, every time, and the fix that
     * "worked" in a synthetic test worked only because the test spelled the
     * event the way the code expected (user report, 2026-09-06, three rounds of
     * it: "shift+enter과 같은 효과가 지속적으로 나는 버그").
     *
     * `beforeinput` cannot be spelled wrong. Whatever key made the break — a
     * plain Enter, an Enter the IME committed on, a paste, a shortcut — the
     * break itself arrives here, once, cancelable. So the rule is written
     * against the *edit* rather than against the keyboard.
     *
     * **Under two names, though, and the third cut is that** (user report,
     * 2026-09-06): Blink refuses to split a table cell, so its own Enter inside
     * a `<td>` degrades to `InsertLineBreakCommand` and announces itself as
     * `insertLineBreak` — the same name Shift+Enter's edit carries. Matching
     * `insertParagraph` alone therefore held everywhere except inside a table,
     * which is the only place the rule exists for. The two are told apart by
     * `breakShiftRef` — the modifier off the key, which an IME cannot garble —
     * and Shift+Enter still writes its `<br>`: inline content a cell may hold
     * (§3.4), the one way to put two lines in a cell and have the model keep
     * them.
     *
     * `onKeyDown` prevents the plain, un-composed Enter *before* it gets this
     * far, and deliberately: a key that can be recognised is cheapest to stop
     * at the source. This listener is what catches every Enter that cannot be —
     * and both of them call the one `stepTableCell`, so they cannot drift.
     *
     * Bound by hand rather than through React's `onBeforeInput`, whose
     * synthetic event is a different, older thing and does not carry
     * `inputType` reliably.
     */
    useEffect(() => {
      const root = surfaceRef.current;
      if (root === null) return;
      const onBeforeInput = (event: globalThis.InputEvent): void => {
        // Both spellings of "the author pressed Enter", because inside a table
        // cell the browser uses the second: Blink will not split a `<td>`, so
        // its own Enter degrades to `InsertLineBreakCommand` and the edit
        // arrives named after the `<br>` it is about to write rather than after
        // the key that asked for it. Refusing only `insertParagraph` therefore
        // refused the break everywhere it was never going to happen and let it
        // through in the one place §3.2 forbids it.
        //
        // Shift+Enter is told apart by the modifier rather than by the name —
        // it makes the identical edit — and it is the one that goes through: a
        // `<br>` is inline content a cell may hold (§3.4) and the only way to
        // put two lines in a cell that the model keeps.
        const made = event.inputType;
        if (made !== "insertParagraph" && made !== "insertLineBreak") return;
        if (made === "insertLineBreak" && breakShiftRef.current) return;
        const surface = liveRef.current;
        if (surface === null || isLocked()) return;
        const range = currentRange(surface);
        const found = range === null ? null : tableAt(surface, range.startContainer);
        if (found === null) return;
        // Prevented first and unconditionally: wherever the engine allows it,
        // this is the whole of the rule and nothing lands.
        event.preventDefault();
        // And where it does not — `cancelable: false`, which is how every
        // `beforeinput` an IME is composing on arrives — the break is coming
        // whatever this says, so the cell is remembered and it is taken back
        // off when it gets here.
        if (event.cancelable) cellBreakRef.current = null;
        else armCellBreak(found.cell, true);
        // The step waits for the IME. The caret may not leave a cell with a
        // half-assembled syllable in it, and the composition ends on this very
        // keystroke — so the author's next Enter steps. Read off the event,
        // never off a `composingRef`: a flag that missed one `compositionend`
        // would disable Enter in tables for the rest of the session.
        if (event.isComposing) return;
        stepTableCell(false);
      };
      root.addEventListener("beforeinput", onBeforeInput);
      return () => root.removeEventListener("beforeinput", onBeforeInput);
    }, [armCellBreak, isLocked, stepTableCell]);

    // The wire back to `applyAction`, which routes a slash row's block command
    // here and is declared above this. Written on every render, like `propsRef`.
    useEffect(() => {
      runBlockCommandRef.current = runBlockCommand;
    }, [runBlockCommand]);

    /* ---------------- dragging a block (§3.1) ---------------- */

    /* ---------------- dragging something into place (§3.4) ---------------- */

    /**
     * The slots of one axis: what can be dragged, and where each of them is.
     *
     * Measured **once**, when a drag begins, in document coordinates. A drag
     * can scroll the page, and re-measuring every block on every pointer move
     * would be a layout read sixty times a second down the length of an
     * article — with a transform on half of them, which is precisely the read
     * that forces the browser to flush the animation it is in the middle of.
     */
    const sortSlots = useCallback(
      (
        root: HTMLElement,
        axis: "block" | "row" | "column",
        table: HTMLElement | null,
      ): { items: HTMLElement[][]; extents: SortExtent[] } => {
        const scroll = window.scrollY;
        if (axis === "block") {
          const units = blockUnits(Array.from(root.childNodes));
          const items: HTMLElement[][] = [];
          const extents: SortExtent[] = [];
          let previous = 0;
          for (const members of units) {
            items.push(
              members.filter((member): member is HTMLElement => member instanceof HTMLElement),
            );
            const extent = unitExtent(members);
            // A unit with no measurable box collapses to a zero-height slot
            // where it stands, which keeps the extents in document order — a
            // box of (0,0) would sort every slot after it to the wrong side.
            const box =
              extent === null
                ? { start: previous, end: previous }
                : { start: extent.top + scroll, end: extent.bottom + scroll };
            previous = box.end;
            extents.push(box);
          }
          return { items, extents };
        }

        const rows = table === null ? [] : tableRowsOf(table);
        if (axis === "row") {
          const items: HTMLElement[][] = [];
          const extents: SortExtent[] = [];
          for (let index = 0; index < rows.length; index += 1) {
            const first = cellAt(rows, index, 0);
            const row = first?.parentElement ?? null;
            if (row === null) continue;
            const rect = row.getBoundingClientRect();
            items.push([row]);
            extents.push({ start: rect.top + scroll, end: rect.bottom + scroll });
          }
          return { items, extents };
        }

        // A column is one cell per row, and its extent is read off the widest
        // row that reaches it — a ragged table (§7.3) has rows that do not.
        // Horizontal, so the page's vertical scroll is none of its business.
        const width = rows.reduce((most, row) => Math.max(most, row.length), 0);
        const items: HTMLElement[][] = [];
        const extents: SortExtent[] = [];
        for (let column = 0; column < width; column += 1) {
          const cells: HTMLElement[] = [];
          let extent: SortExtent | null = null;
          for (let row = 0; row < rows.length; row += 1) {
            const cell = cellAt(rows, row, column);
            if (cell === null) continue;
            cells.push(cell);
            const rect = cell.getBoundingClientRect();
            extent =
              extent === null
                ? { start: rect.left, end: rect.right }
                : { start: Math.min(extent.start, rect.left), end: Math.max(extent.end, rect.right) };
          }
          if (extent === null) continue;
          items.push(cells);
          extents.push(extent);
        }
        return { items, extents };
      },
      [],
    );

    /**
     * Draw the drag: the run under the pointer follows it, and everything it
     * has passed slides one run-size the other way.
     *
     * This is the whole of what the direction asked for — "the element goes to
     * the mouse, and the slot it will fill empties out as it moves" — and it
     * is `transform` and nothing else: no element changes size, none is taken
     * out of the flow, and the document underneath is exactly as it was. What
     * makes the hole *look* like a hole is that every shift is one dragged-size
     * (`sortShift`), so the gap that opens is the shape of the thing aimed at
     * it.
     */
    const paintSort = useCallback((run: VeSortRun, dx: number, dy: number): void => {
      const horizontal = run.axis === "column";
      for (let index = 0; index < run.items.length; index += 1) {
        const shift = sortShift(run.from, run.to, index, run.size);
        for (const element of run.items[index]) {
          if (index === run.from) {
            element.setAttribute(SORT_DRAGGING_ATTR, "");
            setSortOffset(element, horizontal ? dx : 0, horizontal ? 0 : dy);
            continue;
          }
          // The attribute is what carries the transition (globals.css), so it
          // goes on every slot and not only the ones currently moved: a slot
          // that shifts back to zero has to animate back too.
          element.setAttribute(SORT_SHIFT_ATTR, "");
          setSortOffset(element, horizontal ? shift : 0, horizontal ? 0 : shift);
        }
      }
    }, []);

    /** Stop listening to the window; the run itself is the caller's to clear. */
    const releaseSort = useCallback((): void => {
      sortOffRef.current?.();
      sortOffRef.current = null;
    }, []);

    /** Give up on a drag without moving anything. */
    const cancelSort = useCallback((): void => {
      sortRef.current = null;
      releaseSort();
      clearSortStyles(liveRef.current);
      setSorting(false);
    }, [releaseSort]);

    /**
     * Commit the move, once the dragged run has finished sliding into its slot.
     *
     * A **DOM move of the existing elements** for a block — `moveBlockRun`, the
     * very mover the grip's menu and `Alt+Arrow` use — so the block keeps its
     * `data-ve-id` and republishes from `source` (§3.1, §4). A row or a column
     * goes through the model instead (`applyTableMove`), because a table is one
     * block and its rows are not blocks at all: what has to change is that
     * block's wikitext.
     *
     * The styles come off **first**. They are read by nothing, so the buffer is
     * safe either way, but an element still holding a transform would sit where
     * the drag left it rather than where the document now puts it.
     */
    const commitSort = useCallback(
      (run: VeSortRun): void => {
        const root = liveRef.current;
        clearSortStyles(root);
        if (root === null || isLocked() || run.from === run.to) return;

        if (run.axis === "block") {
          const block = moveBlockRef.current;
          const saved = currentRange(root);
          pushHistory(root);
          if (!moveBlockRun(root, run.from, 1, sortGap(run.from, run.to))) return;
          // Re-parenting a subtree drops the selection outright in some
          // engines, and the caret's nodes came along with the block, so the
          // saved Range is still made of live nodes.
          if (saved !== null) applyRange(root, saved);
          afterCommand(root);
          if (block !== null && block.isConnected) {
            block.scrollIntoView({ block: "nearest" });
            refreshBlockHandle(block);
          }
          return;
        }
        if (run.table === null || !root.contains(run.table)) return;
        applyTableMove(run.table, run.axis, run.from, run.to);
      },
      [afterCommand, applyTableMove, isLocked, pushHistory, refreshBlockHandle],
    );

    /**
     * Let go. The run slides from wherever the pointer left it into the slot
     * that has been standing open for it, and only then does the document
     * change — so what the author watched land is what landed.
     */
    const finishSort = useCallback((): void => {
      const run = sortRef.current;
      sortRef.current = null;
      releaseSort();
      if (run === null) return;
      if (!run.moved) {
        // A press, not a drag. Nothing was drawn and nothing is undone; the
        // grip's own `onClick` opens its menu, as it always did.
        setSorting(false);
        return;
      }
      // The click this release is about to synthesise would open a menu over a
      // block that has just moved. One capture-phase listener, once.
      const swallow = (click: Event): void => {
        click.stopPropagation();
        click.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);

      const horizontal = run.axis === "column";
      const landing = sortLandingStart(run.extents, run.from, run.to);
      const rest = landing === null ? 0 : landing - run.extents[run.from].start;
      for (const element of run.items[run.from]) {
        element.removeAttribute(SORT_DRAGGING_ATTR);
        element.setAttribute(SORT_SETTLING_ATTR, "");
        setSortOffset(element, horizontal ? rest : 0, horizontal ? 0 : rest);
      }
      settleRef.current = window.setTimeout(() => {
        settleRef.current = null;
        setSorting(false);
        commitSort(run);
      }, SORT_SETTLE_MS);
    }, [commitSort, releaseSort]);

    /**
     * A press on a grip. It is not a drag yet — both grips are also buttons,
     * so a press that never travels {@link SORT_THRESHOLD} stays a click and
     * opens the menu it was always going to open.
     *
     * The press lands on React's markup **outside** the contenteditable, so the
     * surface never sees it and the browser never starts a selection drag of
     * its own — the thing that makes dragging inside a contenteditable unusable
     * when it begins in the text.
     */
    const beginSort = useCallback(
      (
        event: ReactPointerEvent<HTMLElement>,
        axis: "block" | "row" | "column",
        index: number,
        table: HTMLElement | null,
      ): void => {
        const root = liveRef.current;
        if (root === null || isLocked() || event.button !== 0) return;
        // A second drag started on top of a settling one: land the first where
        // it was going before measuring anything for the second.
        if (settleRef.current !== null) {
          window.clearTimeout(settleRef.current);
          settleRef.current = null;
          clearSortStyles(root);
        }
        const { items, extents } = sortSlots(root, axis, table);
        const extent = extents[index];
        // Nothing to sort into: one block, one row, one column.
        if (extent === undefined || items.length < 2) return;

        sortRef.current = {
          axis,
          items,
          extents,
          size: extent.end - extent.start,
          from: index,
          to: index,
          originX: event.clientX,
          originY: event.clientY,
          originScroll: window.scrollY,
          table,
          pointerId: event.pointerId,
          moved: false,
        };

        const onMove = (move: PointerEvent): void => {
          const run = sortRef.current;
          if (run === null || move.pointerId !== run.pointerId) return;
          const dx = move.clientX - run.originX;
          const dy = move.clientY - run.originY;
          if (!run.moved) {
            if (Math.abs(dx) < SORT_THRESHOLD && Math.abs(dy) < SORT_THRESHOLD) return;
            run.moved = true;
            setSorting(true);
          }
          // Two different corrections, and they are not the same one twice.
          //
          // The *slot* is chosen in the coordinates the extents were taken in:
          // document ones down the page, so `scrollY` goes back on; viewport
          // ones across a table, where a vertical scroll changes nothing.
          //
          // The *transform* is what keeps the element under the pointer, and
          // the element scrolls with the page while `clientY` does not — so a
          // page that has scrolled since the press has to be added back, or the
          // block slides out from under the hand holding it. A drag near the
          // edge of the window is exactly when that happens.
          const scrolled = window.scrollY - run.originScroll;
          const pointer = run.axis === "column" ? move.clientX : move.clientY + window.scrollY;
          run.to = sortTargetIndex(run.extents, pointer);
          paintSort(run, dx, dy + scrolled);
        };
        const onUp = (up: PointerEvent): void => {
          if (sortRef.current !== null && up.pointerId !== sortRef.current.pointerId) return;
          finishSort();
        };
        const onCancel = (): void => cancelSort();

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onCancel);
        sortOffRef.current = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          window.removeEventListener("pointercancel", onCancel);
        };
      },
      [cancelSort, finishSort, isLocked, paintSort, sortSlots],
    );

    /** Escape gives up mid-drag, which is the only way out that keeps the page. */
    useEffect(() => {
      if (!sorting) return;
      const onKeyDown = (event: globalThis.KeyboardEvent): void => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        cancelSort();
      };
      window.addEventListener("keydown", onKeyDown, true);
      return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [sorting, cancelSort]);

    /** Nothing of a drag outlives the surface it was running on. */
    useEffect(
      () => () => {
        sortOffRef.current?.();
        if (settleRef.current !== null) window.clearTimeout(settleRef.current);
      },
      [],
    );

    /**
     * A drop of a **file** onto the page (§15) is the one thing still on the
     * browser's own drag-and-drop: it comes from outside the window, so there
     * is no press of ours to have captured. Reordering left that road on
     * 2026-09-05 — `dragover` gives coarse coordinates and a drag image nothing
     * can animate, and the direction asked for an animation.
     */
    const onSurfaceDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>): void => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }, []);

    const onSurfaceDrop = useCallback((event: ReactDragEvent<HTMLDivElement>): void => {
      // `preventDefault` is not optional: an unprevented drop on a
      // contenteditable inserts the transfer's data as text, which would be an
      // edit the author never made, in a place they never put the caret.
      event.preventDefault();
      event.stopPropagation();
      if (isLocked()) return;
      const dropped = mediaFile(event.dataTransfer);
      if (dropped !== null) propsRef.current.onChromeAction?.({ kind: "media", file: dropped });
    }, [isLocked]);

    /* ---------------- input rules (§1) ---------------- */

    /**
     * Give back the literal characters the last input rule swallowed.
     *
     * **Why the surface's whole markup is the snapshot.** A rule is not always
     * a re-format that could be inverted: `"--- "` *replaces* the block with a
     * horizontal rule, so there is no single element an inverse could act on,
     * and a wrong inverse would publish something the author never wrote. One
     * string cannot be wrong, and it is taken only when a rule actually fires
     * — once per marker typed, never once per keystroke.
     *
     * **What this does not undo is the step after it.** The native stack still
     * holds the rule's own commands, so a *second* `Ctrl+Z` walks into edits
     * made against markup this restore has already replaced; the honest
     * summary is that one undo is exact and the next one is the browser's
     * guess. That is stated in docs/engine/visual-editor.md §1 rather than
     * hidden, and it is the same trade `moveBlock` and `normalizeLists`
     * already make for every plain DOM edit in this surface.
     */
    const undoInputRule = useCallback((): boolean => {
      const snapshot = ruleUndoRef.current;
      ruleUndoRef.current = null;
      const root = liveRef.current;
      if (snapshot === null || root === null || isLocked()) return false;
      commitBranchEdit();
      applying(() => {
        root.innerHTML = snapshot.html;
        // A `<textarea>`'s live value is not in its markup, so the restored
        // fields would come back empty. Removing them lets `syncBranchFields`
        // — which `afterCommand` runs below — rebuild each from the block's
        // own `data-ve-src`, which is where that text really lives (§5).
        for (const field of Array.from(root.querySelectorAll(`[${BRANCH_ATTR}]`))) field.remove();
      });
      const members = blockUnits(Array.from(root.childNodes))[snapshot.block];
      if (members !== undefined) placeCaretAtOffset(root, members, snapshot.offset);
      afterCommand(root);
      return true;
    }, [afterCommand, applying, commitBranchEdit, isLocked]);

    /**
     * Test what is in front of the caret against the input rules, and apply
     * the first that matches (`src/lib/visual-editor/input-rules.ts`).
     *
     * Three places a rule may not fire, and each of them is a way of
     * destroying something: **mid-composition**, where Korean's syllable is
     * still being assembled and a re-format would take it apart; inside a
     * **frozen block**, which has no text to re-format; and inside a **table
     * cell**, which holds inline content and nothing else (spec §7.3) — a
     * heading or a list made in one is a table the model then has to refuse,
     * so the whole table would silently become a chip.
     *
     * The marker is deleted through the browser's own delete and an inline
     * rule writes its result with one `insertHTML`, so each half of the edit
     * is a single native step; `undoInputRule` above is what makes the pair of
     * them one keystroke to walk back.
     */
    const applyInputRules = useCallback((): boolean => {
      const root = liveRef.current;
      if (root === null || isLocked() || composingRef.current) return false;
      const range = currentRange(root);
      if (range === null || !range.collapsed) return false;
      const block = nearestBlock(root, range.startContainer);
      if (block === null || isFrozenBlock(block)) return false;
      const host = caretHost(root, range.startContainer);
      if (host === null || isInAtomic(host) || host.nodeName === "TD" || host.nodeName === "TH") {
        return false;
      }
      const reading = hostText(host, range);
      if (reading === null) return false;
      const before = reading.text.slice(0, reading.offset);
      if (before === "") return false;

      // `empty` is the horizontal rule's own question — it replaces the block
      // rather than re-formatting it, so it may only fire where there is
      // nothing to lose.
      const match = matchBlockRule(before, reading.text === before) ?? matchInlineRule(before);
      if (match === null) return false;
      // An inline rule marks the text it re-inserts, and only two marks have a
      // tag to write it with; anything else would have to be applied as a
      // second command, which is a second undo step.
      const tag =
        match.text === undefined
          ? null
          : match.action.kind === "mark"
            ? (INLINE_RULE_TAG[match.action.mark] ?? null)
            : null;
      if (match.text !== undefined && tag === null) return false;

      const unit = blockUnitOf(root, block);
      if (unit === null) return false;
      const snapshot = {
        html: root.innerHTML,
        block: unit.index,
        offset: unitCaretOffset(unit.members, range),
      };

      const took = applying(() => {
        if (!selectBackward(root, reading, match.consumed) || !exec(root, "delete")) return false;
        if (match.text === undefined || tag === null) return true;
        exec(root, "insertHTML", `<${tag}>${escapeHtml(match.text)}</${tag}>`);
        // The caret is left AFTER the mark, or the next word typed would join
        // it — an author who wrote `**bold**` meant the emphasis to end there.
        const after = currentRange(root);
        const marked =
          after === null
            ? null
            : nearestMatching(root, after.startContainer, (element) => element.nodeName === tag.toUpperCase());
        if (marked !== null) placeCaretAfter(marked);
        return true;
      });
      if (!took) return false;

      ruleUndoRef.current = snapshot;
      // A block rule re-formats what is left behind; an inline one has already
      // written its own markup, so running its action would mark the mark.
      if (match.text === undefined) runAction(match.action);
      else afterCommand(root);
      return true;
    }, [afterCommand, applying, isLocked, runAction]);

    /* ---------------- imperative handle ---------------- */

    useImperativeHandle(
      ref,
      (): VisualEditorHandle => ({
        applyAction,
        insertItems: () => {
          const root = liveRef.current;
          if (root === null) return [];
          const range = workingRange(root);
          return buildInsertItems(range === null ? null : range.startContainer);
        },
        runAction,
        selectionText: () => {
          const root = liveRef.current;
          if (root === null) return "";
          const range = workingRange(root);
          return range === null ? "" : range.toString();
        },
        selectedLink: () => {
          const root = liveRef.current;
          if (root === null) return null;
          const range = workingRange(root);
          if (range === null) return null;
          const anchor = nearestMatching(root, range.startContainer, isAnchor);
          if (anchor === null) return null;
          const target =
            anchor.getAttribute("data-ve-target") ??
            anchor.getAttribute("data-ve-href") ??
            anchor.getAttribute("href") ??
            "";
          return { target, text: anchor.textContent ?? "" };
        },
        applyLink: (link) => {
          const root = focusSurface();
          if (root === null || isLocked()) return;
          const range = workingRange(root);
          if (range === null) return;
          const anchor = nearestMatching(root, range.startContainer, isAnchor);

          if (link === null) {
            if (anchor !== null) unwrapElement(anchor);
            afterCommand(root);
            return;
          }
          // A link with no label of its own is `[[Foo]]`, which reads as its
          // target — so that is what the surface shows.
          const text = link.text === "" ? link.target : link.text;
          if (anchor !== null) {
            setLinkTarget(anchor, link.target);
            if ((anchor.textContent ?? "") !== text) anchor.textContent = text;
            placeCaretAfter(anchor);
          } else {
            // The dialog decided the label, so a selection spanning marks is
            // replaced by it rather than wrapped — wrapping would have to
            // reconcile two answers to the same question.
            const created = root.ownerDocument.createElement("a");
            setLinkTarget(created, link.target);
            created.textContent = text;
            if (replaceRangeWith(range, created)) placeCaretAfter(created);
          }
          afterCommand(root);
        },
        replaceAtomic: (source) => {
          const node = selectedRef.current;
          if (node === null) return;
          applyAtomicSource(node, source, true);
        },
        flush: flushNow,
        focus: () => {
          const root = focusSurface();
          if (root === null) return;
          if (currentRange(root) === null) placeCaretInside(root);
        },
        focusBranch: (version) => {
          // Scrolls itself into view on purpose: the block the `+` menu just
          // gave a branch to may be anywhere on the page, and a field nobody
          // can see is not one the author is typing into.
          branchInputFor(version)?.focus();
        },
        revealMatch,
        focusBlock: focusBlockAt,
        moveSection: moveSectionUnits,
      }),
      [
        afterCommand,
        applyAction,
        applyAtomicSource,
        branchInputFor,
        buildInsertItems,
        flushNow,
        focusBlockAt,
        focusSurface,
        isLocked,
        moveSectionUnits,
        revealMatch,
        runAction,
        workingRange,
      ],
    );

    /* ---------------- surface events ---------------- */

    /**
     * `input` bubbles out of the branch field as well as out of the
     * contenteditable, and the two mean different things: one is a keystroke
     * in the document, the other is a keystroke in one version's branch. They
     * are told apart here, once, so nothing downstream has to.
     */
    const onInput = useCallback(
      (event: ReactFormEvent<HTMLDivElement>): void => {
        const root = liveRef.current;
        if (root === null || isLocked()) return;
        const branch = branchInputOf(event.target);
        if (branch !== null) {
          scheduleBranchWrite(branch);
          return;
        }
        // An input event *is* the browser recording an edit on its own undo
        // stack — typing, an IME's composition, and every `execCommand` this
        // file runs, since all of them dispatch one. From here the two stacks
        // describe two different documents and only one of them can be walked
        // back, so the structural one is dropped (§12). No structural edit of
        // ours fires this event: they are DOM surgery, which is exactly why
        // they needed a stack of their own.
        historyRef.current = forgetEdits();
        // A command of ours is running and will do its own housekeeping when
        // it is finished; reading the buffer half-way through one is how a
        // rule fires on its own deletion.
        if (applyingRef.current) return;
        // Then, before anything reads the buffer: a break the engine refused to
        // let this surface cancel is in the cell right now, and §4 would
        // publish it as a space (dom.ts folds a cell's newlines) — an edit the
        // author can see on screen and never made. Below the guard above,
        // because an `input` of ours is our own edit and never that break.
        if (cellBreakRef.current !== null) healCellBreak(true);
        // Enter clones the paragraph it splits, `data-ve-id` included; clearing
        // the duplicate here keeps the DOM's ids as unique as the model's.
        ensureUniqueBlockIds(root, mint);
        decorateAtomics(root, propsRef.current.labels);
        updateEmpty(root);
        // A keystroke that is not the undo of a rule ends that rule's undo:
        // the snapshot is only ever the *immediately* preceding state.
        ruleUndoRef.current = null;

        // No *rule* may read a buffer the IME is still assembling: this event
        // fires per composed keystroke in Korean, and a rule that re-formatted
        // the block mid-syllable would take the syllable apart. The panels
        // below only read the line, and they read it now — see
        // `onCompositionStart` for why waiting for the syllable lost the menu.
        const native = event.nativeEvent;
        const composing = composingRef.current || (native instanceof InputEvent && native.isComposing);
        if (!composing && applyInputRules()) return;
        syncSlash();
        syncMention();
        refreshHint();
        scheduleRead();
      },
      [
        applyInputRules,
        healCellBreak,
        isLocked,
        mint,
        refreshHint,
        scheduleBranchWrite,
        scheduleRead,
        syncMention,
        syncSlash,
        updateEmpty,
      ],
    );

    /**
     * Composition brackets every **rule** in this surface. Korean is a
     * first-class locale here, and an input rule rewrites the block it fires
     * in — mid-syllable that would take the syllable apart, so `applyInputRules`
     * is gated on this and stays gated.
     *
     * **The panels are not, and used to be** (user report, 2026-09-06: "slash로
     * 크기를 바꾸는 게 가끔 안 된다"). They only *read* the line, which is the
     * whole difference: reading a half-assembled syllable shows a query that
     * matches nothing for one keystroke, while refusing to read it loses the
     * menu outright. And it did, because in Korean every syllable is a
     * composition of its own: "/제목" is three compositions end to end and
     * `syncSlash` never once got to run, so the panel that opened on "/"
     * closed on "제" and only came back if a `selectionchange` happened to land
     * after a `compositionend` — which is exactly what "sometimes" was. Enter
     * then reached the surface as a paragraph break instead of the menu, or,
     * worse, the menu came back holding the `consumed` of an older line and
     * the deletion took the wrong characters.
     *
     * So composition now only says *what has just changed*: it never closes a
     * panel, and its end is one more moment to re-read the line — for the
     * engines that fire `compositionend` after their last `input` rather than
     * before it. Enter is still safe mid-composition: the menu ignores every
     * key whose `isComposing` is set, so the first Enter commits the IME's
     * candidate and only the second takes the highlighted row.
     */
    const onCompositionStart = useCallback((): void => {
      composingRef.current = true;
    }, []);

    const onCompositionEnd = useCallback((): void => {
      composingRef.current = false;
      // The other end of the same promise: some engines land the composition's
      // own break here rather than on an `input`, and this is also the first
      // moment the caret is allowed to leave the cell — so an Enter that
      // committed a syllable heals *and* steps, which is what §3.2 asks for.
      if (cellBreakRef.current !== null) healCellBreak(true);
      syncSlash();
      syncMention();
    }, [healCellBreak, syncMention, syncSlash]);

    /**
     * Leaving the branch field is when its preview catches up: the block above
     * the words is re-rendered at the version being previewed, which is what
     * "type it, then check it" wants and what a fetch per keystroke would make
     * unaffordable.
     */
    const onBlur = useCallback(
      (event: ReactFocusEvent<HTMLDivElement>): void => {
        const branch = branchInputOf(event.target);
        if (branch === null) return;
        const node = branch.closest("[data-ve-src]");
        if (!(node instanceof HTMLElement)) return;
        // Whatever is still in the field goes into the block first; the
        // repaint below is of the block as it now reads.
        commitBranchEdit();
        const root = liveRef.current;
        if (root === null || !root.contains(node)) return;
        // Unconditional, and affordable because it is: the fragment cache is
        // keyed by (locale, version, source), so a block nobody changed is
        // repainted from the cache without a request, and one that changed
        // costs exactly one.
        resetAtomicBody(node);
        loadFragments(root);
      },
      [commitBranchEdit, loadFragments],
    );

    /**
     * Copying out of the surface puts **wikitext** on the clipboard (§11.1).
     *
     * What the browser would put there instead is the rendered text, and a
     * rendering is lossy in exactly the places this editor is about: a link
     * comes out as its label, an infobox as the words inside its preview, a
     * heading as a line of prose. Copy a paragraph, paste it into the next
     * article, and the links were gone.
     *
     * The selection is read back with `domToDocument` — the same reader a save
     * runs — over a *clone* of the selected markup, so nothing on screen is
     * touched and no id is claimed. `prev` is an empty document, so every block
     * comes out canonical: there are no original bytes for a fragment of a
     * page, and §4's bookkeeping belongs to the blocks that stayed behind.
     *
     * Only `text/plain` is written. The one thing this editor edits is
     * wikitext, pasting it back in is lossless (§11's second reading pastes it
     * verbatim), and a `text/html` flavour would mean deciding what our own
     * chrome — the chips' buttons, a version block's field — looks like in
     * somebody else's document.
     */
    const writeWikitext = useCallback(
      (event: ReactClipboardEvent<HTMLDivElement>): boolean => {
        const root = liveRef.current;
        if (root === null) return false;
        const range = currentRange(root);
        if (range === null || range.collapsed) return false;
        const holder = root.ownerDocument.createElement("div");
        holder.appendChild(range.cloneContents());
        let wikitext: string;
        try {
          wikitext = serializeDocument(
            domToDocument(holder, emptyDocument(), createIdFactory("c")),
          ).trim();
        } catch {
          // A fragment the reader cannot make sense of is left to the browser,
          // which will at least copy the words.
          return false;
        }
        if (wikitext === "") return false;
        event.clipboardData.setData("text/plain", wikitext);
        event.preventDefault();
        return true;
      },
      [],
    );

    const onCopy = useCallback(
      (event: ReactClipboardEvent<HTMLDivElement>): void => {
        // The branch field is a textarea holding plain wikitext already, and
        // its selection is its own.
        if (inBranchField(event.target)) return;
        writeWikitext(event);
      },
      [writeWikitext],
    );

    const onCut = useCallback(
      (event: ReactClipboardEvent<HTMLDivElement>): void => {
        if (inBranchField(event.target)) return;
        const root = liveRef.current;
        if (root === null || isLocked()) return;
        // Preventing the default cancels the browser's deletion along with its
        // copy, so the deletion is made again here — through `execCommand`, so
        // it stays on the browser's undo stack like any other cut.
        if (!writeWikitext(event)) return;
        applying(() => exec(root, "delete"));
        afterCommand(root);
      },
      [afterCommand, applying, isLocked, writeWikitext],
    );

    const onPaste = useCallback(
      (event: ReactClipboardEvent<HTMLDivElement>): void => {
        // A paste into the branch field is the textarea's own business: it is
        // plain text there by construction, and preventing it would drop it.
        if (inBranchField(event.target)) return;
        // Plain text only, always: the clipboard's `text/html` flavour is the
        // one door foreign markup could walk through, and §3's reader would
        // then have to make sense of a whole other editor's DOM. Everything
        // §11 recovers is recovered from the plain text instead.
        event.preventDefault();
        const root = liveRef.current;
        if (root === null || isLocked()) return;
        // A picture on the clipboard, which is what a screenshot is (§15). It
        // comes before the text, because a screenshot copied out of a browser
        // arrives with a `text/plain` flavour naming the page it came from.
        const pasted = mediaFile(event.clipboardData);
        if (pasted !== null) {
          propsRef.current.onChromeAction?.({ kind: "media", file: pasted });
          return;
        }
        const text = event.clipboardData.getData("text/plain");
        if (text === "") return;

        const range = workingRange(root);
        // A cell and a caption hold inline content and nothing else
        // (wikitext-spec §7.3): a block pasted into one is a table the model
        // then has to refuse, and a refused table is a chip with a dialog.
        const inCell = isCellHost(caretHost(root, range === null ? null : range.startContainer));
        const answer = readPaste({
          text,
          selection: range === null ? "" : range.toString(),
          inCell,
          origin: root.ownerDocument.defaultView?.location.origin ?? "",
        });

        // Inside `applying`, so the `input` this dispatches cannot be read as
        // typing: a paste ending in "## " is a paste, not a heading.
        applying(() => {
          if (answer.kind === "text") {
            exec(root, "insertText", answer.text);
            return;
          }
          if (answer.kind === "blocks") pushHistory(root);
          insertPaste(root, answer.wikitext, answer.kind === "blocks");
        });
        afterCommand(root);
      },
      [afterCommand, applying, insertPaste, isLocked, pushHistory, workingRange],
    );

    const onKeyDown = useCallback(
      (event: ReactKeyboardEvent<HTMLDivElement>): void => {
        // Before anything can return: the `beforeinput` that this key's default
        // action is about to raise carries no modifiers, and §3.2's Enter needs
        // to know whether Shift was down. Written for every key, in the branch
        // field as much as in the surface, so it can never be stale.
        breakShiftRef.current = event.shiftKey;
        // A break that outlived every other pass is taken off here, one key
        // late — without the step, which belongs to the Enter that asked for it
        // and not to whatever is being typed now.
        //
        // **And then the snapshot is dropped, always.** One armed for the last
        // key is not a claim about this one: left standing, it made the surface
        // take a `<br>` back off that Shift+Enter had just legitimately put
        // there, because the snapshot predating both did not hold it. Each key
        // arms its own below, or arms none.
        if (cellBreakRef.current !== null) {
          healCellBreak(false);
          cellBreakRef.current = null;
        }
        const root = liveRef.current;
        if (root === null || isLocked()) return;
        // Keys pressed in the branch field belong to the textarea, and every
        // rule below would misread them: Enter would open the node's dialog,
        // Backspace would delete the whole block out from under the author,
        // Ctrl+B would embolden a document selection they cannot see. Nothing
        // is stopped from bubbling — Ctrl+Enter still publishes.
        if (inBranchField(event.target)) return;
        const meta = event.metaKey || event.ctrlKey;

        // The input rules' own undo comes first, and only immediately after
        // one fired: `Ctrl+Z` then gives back the literal "## " the author
        // typed, rather than un-making the heading and leaving the marker
        // deleted (input-rules.ts, "What the rules assume about undo").
        if (meta && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "z") {
          if (undoInputRule()) {
            event.preventDefault();
            return;
          }
        } else if (!MODIFIER_KEYS.has(event.key)) {
          // Any other key closes that window: the snapshot is only ever the
          // state immediately before the rule, and a stale one would undo an
          // edit made since.
          ruleUndoRef.current = null;
        }

        // Then the structural stack (§12): the moves, drops, table edits and
        // block pastes the browser never saw. It answers `false` for all of an
        // ordinary typing session — it is emptied by every edit the browser
        // *did* record — and the key is then the browser's, untouched.
        if (meta && !event.altKey) {
          const key = event.key.toLowerCase();
          const direction =
            key === "z" ? (event.shiftKey ? "redo" : "undo") : key === "y" ? "redo" : null;
          if (direction !== null && stepHistory(direction)) {
            event.preventDefault();
            return;
          }
        }

        // Escape takes the bubble menu away and leaves the selection alone, so
        // the author can go on typing over it. The slash menu claims Escape
        // for itself while it is open (it binds the document in the capture
        // phase), so this is never the two of them arguing over one key.
        if (event.key === "Escape" && !meta && !event.altKey && bubbleKeyRef.current !== null) {
          event.preventDefault();
          dismissBubble();
          return;
        }

        // Tab walks a table's cells and grows a row at the last one — the
        // behaviour every table editor has and the one authors try before they
        // look for a control (§3.2). Everywhere else Tab is left entirely
        // alone, because it is how a keyboard gets out of the surface; and
        // Shift+Tab at the very first cell is left alone for the same reason,
        // which is what keeps a table from trapping focus inside itself.
        //
        // **Enter is only half here.** It walks the cells too (§3.2), and the
        // half that can be recognised on this event is answered further down —
        // an Enter no IME is composing on. The other half cannot be named here
        // at all, and the `beforeinput` listener is where it is caught.
        if (event.key === "Tab" && !meta && !event.altKey) {
          if (stepTableCell(event.shiftKey)) {
            event.preventDefault();
            return;
          }
        }

        // **Nothing typed in a cell may add a line to it**, and this is where
        // every key promises it. Two of them were reported — the Enter an IME
        // owns, which no `key` can name because Chrome calls it `"Process"`
        // with `keyCode: 229`, and a Backspace between two chips, which Chrome
        // answers by putting a `<br>` where the text it removed had been — but
        // the engine's inventiveness is not a list anyone can keep in step. So
        // the cell is remembered before *every* key, and whatever of that shape
        // lands in it that the author did not put there is taken back off by
        // `healCellBreak` on the `input` that follows. A pass that finds
        // nothing costs two walks of one cell.
        //
        // The press itself is never prevented here on that account: an IME
        // Enter is committing a syllable, and preventing it would swallow the
        // syllable along with the break.
        //
        // **Shift+Enter is the one key not armed**, because a `<br>` is exactly
        // what it means (§3.4), and `code` names the physical key even while an
        // IME has renamed `key`.
        const enterKey = event.code === "Enter" || event.code === "NumpadEnter";
        if (!(event.shiftKey && enterKey) && !meta && !event.altKey) {
          const caret = currentRange(root);
          const cell = caret === null ? null : tableAt(root, caret.startContainer);
          if (cell !== null) armCellBreak(cell.cell, enterKey);
        }

        // Alt+Arrow moves the block holding the caret and keeps the caret in
        // it (§3.1, §6) — the binding every editor uses, and the only way to
        // reorder a page without a pointer. A chip cannot hold a caret, so
        // there the block that moves is the selected one (§5).
        if (event.altKey && !meta && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
          event.preventDefault();
          const caret = currentRange(root);
          const target = selectedRef.current ?? (caret === null ? null : caret.startContainer);
          moveBlockUnit(target, event.key === "ArrowUp" ? "up" : "down");
          return;
        }

        // A caret standing beside a chip deletes the chip, in either direction
        // (§5). The selected-chip case below is the same removal reached by
        // clicking one first; this is the one an author reaches by typing, and
        // it is the one that was missing.
        //
        // Beside a **table** or a `----` it is the whole block that goes, and
        // it goes at once rather than through the axis menu's confirmation
        // (user direction, 2026-09-06: "바로 삭제"): the grip menu's Delete
        // already removes a table with no question asked, and a Backspace that
        // opened a dialog would be the one road out of three that argues. The
        // structural stack has it, so `Ctrl+Z` puts it back.
        if (!meta && !event.altKey && (event.key === "Backspace" || event.key === "Delete")) {
          const range = currentRange(root);
          const neighbour =
            range === null
              ? null
              : frozenBesideCaret(root, range, event.key === "Backspace" ? -1 : 1);
          if (neighbour !== null) {
            event.preventDefault();
            if (neighbour.hasAttribute("data-ve-src")) removeAtomic(neighbour);
            else deleteBlockUnit(neighbour);
            return;
          }
          // From inside, at the one end of the table the key has nothing else
          // to do at. `frozenBesideCaret` above answers for the caret standing
          // *outside* it; this is the author who has just made a table and is
          // still in its first cell.
          const edge =
            range === null
              ? null
              : tableAtCaretEdge(root, range, event.key === "Backspace" ? -1 : 1);
          if (edge !== null) {
            event.preventDefault();
            deleteBlockUnit(edge);
            return;
          }
          // And the table that is already selected, which is the state with no
          // caret on screen at all — Chrome's own first Backspace puts a table
          // there and then asks for a second one.
          const whole = range === null ? null : frozenBlockInSelection(root, range);
          if (whole !== null) {
            event.preventDefault();
            deleteBlockUnit(whole);
            return;
          }
          // And every other rim of every other cell, where the key is spent:
          // the two above have already taken the presses that mean something,
          // so what is left is the one Chrome answers by selecting the whole
          // table. `cellAtCaretEdge` says why nothing is the right answer.
          const rim =
            range === null
              ? null
              : cellAtCaretEdge(root, range, event.key === "Backspace" ? -1 : 1);
          if (rim !== null) {
            event.preventDefault();
            return;
          }
        }

        const selected = selectedRef.current;
        if (selected !== null && !meta && !event.altKey) {
          if (event.key === "Delete" || event.key === "Backspace") {
            event.preventDefault();
            removeAtomic(selected);
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            openAtomic(selected);
            return;
          }
        }

        if (meta && !event.altKey) {
          const key = event.key.toLowerCase();
          // `k` is deliberately absent: the link dialog belongs to the editor
          // island, which owns the wrapper's key handling.
          if (key === "b" || key === "i" || key === "u") {
            event.preventDefault();
            applyMark(root, key === "b" ? "bold" : key === "i" ? "italic" : "underline");
            afterCommand(root);
            return;
          }
          // `Ctrl/Cmd+D` duplicates the block the caret is in (§14) — Notion's
          // binding, and the keyboard's way to the row the gutter menu already
          // offers. It takes the key from the browser's bookmark dialog, which
          // is what every editor that binds it does; the row and the shortcut
          // are one act, so an author who learns either has learned both.
          if (key === "d") {
            event.preventDefault();
            const range = currentRange(root);
            const target = range === null ? selectedRef.current : range.startContainer;
            if (target !== null) duplicateBlockUnit(target);
            return;
          }
          const format = FORMAT_KEYS.get(key);
          if (format !== undefined) {
            event.preventDefault();
            applyFormat(root, format);
            afterCommand(root);
          }
          return;
        }

        if (event.key === "Enter" && !event.shiftKey) {
          const range = currentRange(root);
          // A cell takes Tab's step (§3.2). The `beforeinput` listener promises
          // this for every Enter, including the ones an IME leaves nameless —
          // but an Enter that *is* named is stopped here instead, one event
          // earlier, because `beforeinput` is that key's own default action and
          // a `preventDefault` here means the break is never even proposed.
          // Only when nothing is composing: preventing a key the IME is still
          // holding would swallow the syllable rather than the break, and that
          // Enter's break is refused downstream anyway.
          if (
            !meta &&
            !event.altKey &&
            !event.nativeEvent.isComposing &&
            range !== null &&
            tableAt(root, range.startContainer) !== null
          ) {
            event.preventDefault();
            // Nothing landed, so there is nothing to take back off — and a
            // snapshot left armed points at the cell the caret has just left.
            cellBreakRef.current = null;
            stepTableCell(false);
            return;
          }
          const block = nearestBlock(root, range === null ? null : range.startContainer);
          if (
            range !== null &&
            block !== null &&
            HEADING_TAGS.has(block.nodeName) &&
            isAtBlockEnd(block, range)
          ) {
            // Enter at the end of a heading opens body text, not another
            // heading — engines disagree here, so the split is ours.
            event.preventDefault();
            const paragraph = newParagraph(root.ownerDocument, mint());
            block.after(paragraph);
            placeCaretInside(paragraph);
            afterCommand(root);
          }
        }
      },
      [
        afterCommand,
        applyFormat,
        applyMark,
        armCellBreak,
        deleteBlockUnit,
        dismissBubble,
        duplicateBlockUnit,
        healCellBreak,
        isLocked,
        mint,
        moveBlockUnit,
        openAtomic,
        removeAtomic,
        stepHistory,
        stepTableCell,
        undoInputRule,
      ],
    );

    const closeTableDialog = useCallback((): void => setTableDialog(null), []);

    /**
     * The author said yes to losing the table. The operation is run again from
     * the top rather than from a decision cached when the dialog opened — the
     * second run reads the surface as it now stands, and `confirmed` is the
     * only thing that differs.
     */
    const confirmTableDialog = useCallback((): void => {
      const pending = tableDialog;
      setTableDialog(null);
      if (pending === null || pending.kind !== "confirm") return;
      applyTableOp(pending.cell, pending.op, true);
    }, [applyTableOp, tableDialog]);

    const onMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>): void => {
      // Putting the caret somewhere else is moving on, and the rule's one-step
      // undo only ever describes the state immediately before it.
      ruleUndoRef.current = null;
      const root = liveRef.current;
      if (!(event.target instanceof Element)) return;
      // The chip buttons act on the node, not on the caret: keeping the caret
      // where it is means the author does not lose their place to a click.
      if (event.target.closest("[data-ve-act]") !== null) {
        event.preventDefault();
        return;
      }
      if (root === null || isLocked() || event.button !== 0) return;

      // The click landed on a host's own box rather than on any of its content
      // — beside a chip, in a cell that holds nothing else. Engines answer that
      // with the start of the host, which is not where the author pointed and
      // is why the chip could not be backspaced: there was never a caret behind
      // it. `caretIndexForClick` reads the position the click actually means.
      const host = event.target;
      if (!(host instanceof HTMLElement)) return;
      // Only somewhere that holds inline content. A press that lands on a
      // `<table>`, a `<tr>` or the surface's own padding is about none of this,
      // and answering it would put the caret in a place with no line in it.
      if (!CARET_HOSTS.has(host.nodeName)) return;
      if (host.childNodes.length === 0) return;
      const index = caretIndexForClick(host, event.clientX, event.clientY);
      // **Naming the position is not enough.** `(cell, 1)` past a chip is a
      // place with nothing in it, and engines normalize a caret out of one — to
      // the start of the host, or, as the author found, into the next cell. So
      // the position is *made*: a zero-width space parked there, which
      // `withoutCaretHolders` takes back out of every read (dom.ts) so it can
      // never be published.
      const holder = caretHolderAt(host, index);
      if (holder === null) return;
      event.preventDefault();
      if (root.ownerDocument.activeElement !== root) root.focus({ preventScroll: true });
      const range = root.ownerDocument.createRange();
      range.setStart(holder.node, holder.offset);
      range.collapse(true);
      applyRange(root, range);
      selectAtomic(null);
    }, [isLocked, selectAtomic]);

    const onClick = useCallback(
      (event: ReactMouseEvent<HTMLDivElement>): void => {
        const root = liveRef.current;
        if (root === null) return;
        const target = event.target;
        if (!(target instanceof Element)) {
          selectAtomic(null);
          return;
        }
        // The empty space under the article (§14). A page that ends in a
        // table, an infobox or any other chip ends in something a caret cannot
        // be put into, so clicking below it did nothing at all and there was no
        // pointer way to write another paragraph — the block's own "+" was the
        // only one. Notion's answer, and this one: the space below the last
        // block is a place to start writing.
        if (target === root && clickedBelowArticle(root, event.clientY) && !isLocked()) {
          event.preventDefault();
          appendParagraph(root);
          return;
        }
        // A link in the surface is text, not a destination.
        if (target.closest("a") !== null) event.preventDefault();

        const node = atomicAt(target);
        if (node === null) {
          selectAtomic(null);
          return;
        }
        const action = target.closest("[data-ve-act]");
        const act = action === null ? null : action.getAttribute("data-ve-act");
        if (act !== null) {
          event.preventDefault();
          selectAtomic(node);
          if (act === "edit") openAtomic(node);
          else if (act === "remove" && !isLocked()) removeAtomic(node);
          return;
        }
        // A click into the branch field is a click into a control, not onto a
        // chip: selecting the node here would put the document's selection over
        // the whole block and arm Delete for it while the caret is in a
        // textarea. Any other node's selection is dropped, as any click does.
        if (inBranchField(target)) {
          selectAtomic(null);
          return;
        }
        selectAtomic(node);
        selectNode(node);
        reportContext();
      },
      [appendParagraph, isLocked, openAtomic, removeAtomic, reportContext, selectAtomic],
    );

    /**
     * **Right-click a block and get what can be done to it** (user direction,
     * 2026-09-05). The third road to §3.1's block commands and §3.2's twelve
     * table operations, and the one that needs no control on screen: the axis
     * menus and the gutter handle both have to be aimed at, while this is
     * aimed at the thing itself.
     *
     * The browser's own menu is handed through wherever this has nothing
     * better — a locked surface, the branch field's textarea (where
     * spellcheck, cut and paste are the whole point of a right-click), and the
     * surface's padding, which is in no block.
     *
     * What is captured is the block and the cell under the **pointer**, not
     * under the caret. Whether a right-click moves the caret is the browser's
     * business; "insert a row below" meaning the row you clicked is not
     * something that may depend on it. The visible chrome is pointed at the
     * same place, so the ring on the cell and the menu agree.
     */
    const onContextMenu = useCallback(
      (event: ReactMouseEvent<HTMLDivElement>): void => {
        const root = liveRef.current;
        if (root === null || isLocked()) return;
        if (inBranchField(event.target)) return;
        if (!(event.target instanceof Node)) return;
        const block = nearestBlock(root, event.target);
        if (block === null) return;
        const position = blockUnitPosition(root, block);
        if (position === null) return;

        event.preventDefault();
        const found = tableAt(root, event.target);
        const spot = found === null ? null : tableSpotOf(found.table, found.cell);
        const table =
          found === null || spot === null
            ? null
            : { cell: found.cell, context: tableContextOf(spot) };
        // The axis controls and the cell ring follow the pointer here, so what
        // is highlighted is what the menu is about.
        if (table !== null) refreshTableHandle(table.cell);
        refreshBlockHandle(block);
        setContextMenu({
          at: { top: event.clientY, left: event.clientX },
          table,
          block,
          up: blockMoveTarget(position.count, position.index, "up") !== null,
          down: blockMoveTarget(position.count, position.index, "down") !== null,
          formats: formatsForBlock(block),
        });
      },
      [isLocked, refreshBlockHandle, refreshTableHandle],
    );

    /**
     * The two commands as the right-click menu runs them: the writing surface
     * is taken back first.
     *
     * A row of the panel had focus and is about to unmount, so without this the
     * caret an operation places is in a document nothing is focused on — the
     * edit lands, and the author has to click back into the page to keep
     * typing. `focusSurface` restores the range the surface last owned, which
     * the operations do not depend on: both are handed the cell and the block
     * the pointer was over.
     */
    const runTableOpFromMenu = useCallback(
      (cell: HTMLElement | null, op: VeTableOp, confirmed: boolean): void => {
        focusSurface();
        applyTableOp(cell, op, confirmed);
      },
      [applyTableOp, focusSurface],
    );

    const runBlockFromMenu = useCallback(
      (block: HTMLElement | null, command: BlockMenuCommand): void => {
        focusSurface();
        runBlockCommand(block, command);
      },
      [focusSurface, runBlockCommand],
    );

    const closeContextMenu = useCallback(
      (restoreFocus: boolean): void => {
        setContextMenu(null);
        // Escape hands the writing surface back; a pointer has already put
        // focus wherever it clicked, so taking it would fight the author.
        if (restoreFocus) focusSurface();
      },
      [focusSurface],
    );

    const onDoubleClick = useCallback(
      (event: ReactMouseEvent<HTMLDivElement>): void => {
        // Double-clicking a word in the branch field selects that word, as it
        // does in any textarea; it does not open the node's dialog.
        if (inBranchField(event.target)) return;
        const node = atomicAt(event.target);
        if (node === null) return;
        event.preventDefault();
        selectAtomic(node);
        openAtomic(node);
      },
      [openAtomic, selectAtomic],
    );

    /* ---------------- effects ---------------- */

    // Engine defaults, set once: a split makes `<p>` rather than `<div>`, and
    // marks are emitted as tags (§3) instead of inline styles.
    useEffect(() => {
      const root = surfaceRef.current;
      if (root === null) return;
      exec(root, "defaultParagraphSeparator", "p");
      exec(root, "styleWithCSS", "false");
    }, []);

    // The placeholder and the slash hint are copy, so they reach the
    // stylesheet as values rather than living in it; `JSON.stringify` is also
    // a valid CSS string literal. Two of them, because they answer two
    // different questions: the placeholder says the page is empty, the hint
    // says what the empty line the caret is on can become (§1).
    useEffect(() => {
      const root = surfaceRef.current;
      if (root === null) return;
      root.style.setProperty("--ve-placeholder", JSON.stringify(labels.placeholder));
      root.style.setProperty("--ve-hint", JSON.stringify(labels.slashHint));
    }, [labels.placeholder, labels.slashHint]);

    /**
     * The one write React makes to the surface. Keyed on `docKey` only — never
     * on `content` — because a load on every keystroke is exactly what an
     * uncontrolled contenteditable exists to avoid.
     */
    useEffect(() => {
      const root = surfaceRef.current;
      if (root === null) return;
      liveRef.current = root;
      const { content, labels: current } = propsRef.current;

      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      generationRef.current += 1;

      const load = loadOutcome(content, parseDocument);
      if (load.ok) {
        root.innerHTML = load.html;
      } else {
        // The surface cannot stand for a buffer it could not read, so it does
        // not pretend to: it shows the wikitext, says so, and takes no edits.
        // An empty editable surface would look like an emptied article, and
        // Publish would then serialize *that* over the real one.
        paintLoadFailure(root, content, current);
      }
      // A load replaces every element in the surface, so a drag that was still
      // running is over — and the run it was holding points at elements that no
      // longer exist. Nothing to clear off the new markup, but the listeners
      // and the settle have to go with the old.
      sortRef.current = null;
      sortOffRef.current?.();
      sortOffRef.current = null;
      if (settleRef.current !== null) {
        window.clearTimeout(settleRef.current);
        settleRef.current = null;
      }
      setSorting(false);
      loadFailedRef.current = !load.ok;
      setSurfaceLocked(root, !load.ok || propsRef.current.readOnly === true);
      docRef.current = load.ok ? load.doc : emptyDocument();
      // The load matches the buffer exactly, so an untouched read emits nothing
      // and §4's byte-identical republish survives a visit to visual mode.
      emittedRef.current = content;
      selectedRef.current = null;
      contextRef.current = "";
      savedRangeRef.current = null;
      // The element the handle was drawn for is about to be thrown away with
      // the rest of the document; the fingerprint has to go with it or the
      // next `mouseover` on a block at the same height would match it.
      moveBlockRef.current = null;
      moveKeyRef.current = null;
      // Same for the table control — and the strip already on screen is refused
      // by the `docKey` stamped into it (below), since a `setState` here would
      // be a state write in an effect body, which this repo forbids.
      tableCellRef.current = null;
      tableKeyRef.current = null;

      // A brand-new page has no blocks at all, and a contenteditable with no
      // element children gives the caret nowhere to stand.
      if (root.firstElementChild === null) {
        root.appendChild(newParagraph(root.ownerDocument, mint()));
      }
      decorateAtomics(root, current);
      syncBranchFields(root, propsRef.current.version, current, isLocked());
      updateEmpty(root);
      loadFragments(root);
      paintedVersionRef.current = propsRef.current.version;
      // The fields were just rebuilt from the buffer, so anything the old ones
      // were holding is either already in it or was never going to be.
      branchRef.current = null;
      if (branchTimerRef.current !== null) {
        clearTimeout(branchTimerRef.current);
        branchTimerRef.current = null;
      }

      return () => controller.abort();
    }, [docKey, isLocked, loadFragments, mint, updateEmpty]);

    /**
     * Reading the page at another version (the rail's version chips,
     * versioning.md §6) has to repaint the atomic nodes — a version block
     * or a `{{#ifversion:}}` template renders differently per patch, and the
     * fragment cache is keyed by version, so this is a repaint, not a reload.
     * Doing it here rather than by bumping `docKey` is what keeps the caret:
     * the document itself has not changed, only what its chips show.
     */
    useEffect(() => {
      const root = surfaceRef.current;
      if (root === null || paintedVersionRef.current === props.version) return;
      paintedVersionRef.current = props.version;
      // A repaint the cache can answer in full issues no request, so there is
      // nothing to abort and nothing to stop the *previous* version's batch
      // from landing on top of it afterwards. The generation is what says the
      // surface has moved on.
      generationRef.current += 1;
      loadFragments(root);
      // And the branch fields swap with the previews, because the whole point
      // of the strip is that choosing a version chooses what you are writing.
      // Nothing is committed here — that would be a `setState` in an effect
      // body, which this repo forbids — and nothing needs to be: whoever
      // changed the version flushed first (editor.tsx), and a keystroke still
      // in flight carries the branch it was typed into, so it lands there even
      // if it lands late.
      syncBranchFields(root, props.version, propsRef.current.labels, isLocked());
    }, [props.version, isLocked, loadFragments]);

    /**
     * The surface can become editable *after* it has loaded: `/api/auth/me`
     * answers a moment late, and `readOnly` answers with it. React updates the
     * contenteditable itself, but the branch field is a control of its own —
     * its textarea would stay read-only and its "write for this version" offer
     * would stay absent — so the fields are re-synced when the lock moves. The
     * lock is part of their key, so nothing else is rebuilt.
     */
    useEffect(() => {
      const root = surfaceRef.current;
      if (root === null) return;
      syncBranchFields(root, propsRef.current.version, propsRef.current.labels, isLocked());
    }, [readOnly, isLocked]);

    /**
     * The caret is a document-level concern: `selectionchange` is the only
     * event that fires for every way of moving it (mouse, keys, IME, undo).
     * A selection that has left the surface is ignored rather than cleared —
     * that is a dialog taking focus, and the atomic it was opened on must stay
     * selected for `replaceAtomic` to land on it.
     */
    useEffect(() => {
      const onSelectionChange = (): void => {
        const root = liveRef.current;
        if (root === null) return;
        const range = currentRange(root);
        if (range === null) return;
        savedRangeRef.current = range.cloneRange();
        const selected = selectedRef.current;
        if (
          selected !== null &&
          !selected.contains(range.startContainer) &&
          !rangeSelectsNode(range, selected)
        ) {
          selectAtomic(null);
        }
        reportContext();
        // The handle belongs to the block being edited (§3.1), so the caret is
        // the only thing that moves it: a pointer wandering over the article
        // must not take the buttons away from the block they were reached for.
        refreshBlockHandle(selectedRef.current ?? range.startContainer);
        // Same rule as the gutter handle: the controls are anchored to the
        // table being edited, and the caret is what says which one that is.
        refreshTableHandle(range.startContainer);
        // The three caret-following controls, in the order they are cheapest:
        // the hint is an attribute, the bar is a rectangle, the menu is a
        // backwards scan of one line.
        refreshHint();
        refreshBubble();
        syncSlash();
        syncMention();
      };
      document.addEventListener("selectionchange", onSelectionChange);
      return () => document.removeEventListener("selectionchange", onSelectionChange);
    }, [
      refreshBlockHandle,
      refreshBubble,
      refreshHint,
      refreshTableHandle,
      reportContext,
      selectAtomic,
      syncMention,
      syncSlash,
    ]);

    /**
     * The gutter handle and the bubble bar are `position: fixed`, so a scroll
     * moves the page out from under them.
     *
     * They answer it differently, and the difference is what each is *for*.
     * The handle points at a block that is still there and still holds the
     * caret, so it is re-measured and follows. The bar points at a selection the author
     * has scrolled away from, so it goes — and `dismissBubble` remembers that
     * selection, which is what stops the bar from popping back the moment
     * anything else fires.
     *
     * Bound in the capture phase because the editor may sit inside a scroller
     * of its own, and a `scroll` event does not bubble.
     */
    useEffect(() => {
      const onScroll = (event: Event): void => {
        // A panel scrolling ITSELF is not the page moving out from under it.
        // `scroll` does not bubble, but a capture listener on `window` is an
        // ancestor of everything, so a panel's own list arrived here too — and
        // closed the menu the moment an author scrolled it, which read as "the
        // list cannot be scrolled at all".
        const target = event.target;
        if (target instanceof Element && target.closest(PANEL_SCOPE_SELECTOR) !== null) {
          return;
        }
        if (moveKeyRef.current !== null) refreshBlockHandle(moveBlockRef.current);
        if (bubbleKeyRef.current !== null) dismissBubble();
        if (slashRef.current !== null) setSlash(null);
        // It hangs off a pointer that is not there any more, over a block the
        // scroll has moved: there is nothing sensible to re-anchor it to.
        setContextMenu(null);
      };
      const onResize = (): void => onScroll(new Event("resize"));
      window.addEventListener("scroll", onScroll, { capture: true, passive: true });
      window.addEventListener("resize", onResize);
      return () => {
        window.removeEventListener("scroll", onScroll, { capture: true });
        window.removeEventListener("resize", onResize);
      };
    }, [dismissBubble, refreshBlockHandle]);

    // Unmounting is usually a switch to source mode, which reads the same
    // buffer: a debounced read still in flight has to land first or the last
    // few keystrokes would be dropped on the way across. The branch field's
    // debounce is the same promise about a different textarea, so `flushNow`
    // rather than `readNow` — a version's words must survive the trip to
    // source mode as surely as the article's do.
    useEffect(
      () => () => {
        if (timerRef.current === null && branchRef.current === null) return;
        flushNow();
      },
      [flushNow],
    );

    return (
      <>
      <div
        ref={wrapperRef}
        // Read by globals.css: while a drag is on, the pointer selects nothing
        // and says grabbing wherever it goes.
        data-ve-sorting={sorting ? "true" : undefined}
        onDragOver={onSurfaceDragOver}
        onDrop={onSurfaceDrop}
        className={cn(
          // A flex column so the surface itself fills whatever height the
          // caller asked for: dead space below the text would look editable
          // and not be. `relative` is the table controls' positioning context.
          "ve-shell relative flex min-w-0 flex-col rounded-[var(--radius-md)] border border-hairline bg-canvas",
          "focus-within:border-link focus-within:ring-2 focus-within:ring-link/40",
          className,
        )}
      >
        {/*
          `wiki-prose` and `ve-surface` together: the first draws the content
          with the published article's own typography, the second adds only
          what editing needs (globals.css). React renders no children here, so
          it never touches the markup after the load effect writes it.

          `onDrop` is prevented here as well as on the wrapper: an unprevented
          drop on a contenteditable inserts the transfer's data as text, and
          the surface is the element the browser would do that to.
        */}
        <div
          ref={surfaceRef}
          role="textbox"
          aria-multiline="true"
          aria-label={labels.surfaceLabel}
          aria-readonly={readOnly ? true : undefined}
          contentEditable={!readOnly}
          suppressContentEditableWarning
          className="wiki-prose ve-surface grow"
          onInput={onInput}
          onBlur={onBlur}
          onCopy={onCopy}
          onCut={onCut}
          onPaste={onPaste}
          onDrop={(event) => event.preventDefault()}
          onKeyDown={onKeyDown}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          onMouseDown={onMouseDown}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
        />

        {/*
          The table's axis controls (§3.2), drawn over the table they act on
          and OUTSIDE the contenteditable, because a button written inside a
          cell is markup `domToDocument` reads as that cell's content.

          One menu per axis and one "+" at the end of each, which is Notion's
          shape: a control that points at *this row* can be named after it, and
          six rows are read where twelve icons in a line were scanned. The
          keyboard's way to the same twelve is the slash menu, which offers
          them as contextual rows while the caret is in a table — a control
          only a pointer can reach is a control half the readers of this wiki
          do not have.

          `onMouseDown` is prevented on the group rather than on each button,
          so it covers the menu panels and the gaps as well: no click in here
          can take the caret out of the cell the operation is about, and the
          caret is what tells every operation which cell that is.
        */}
        {tableHandle === null || tableHandle.docKey !== docKey || sorting ? null : (
          <div
            role="group"
            aria-label={labels.tableControlsLabel}
            onMouseDown={(event) => event.preventDefault()}
            className="pointer-events-none absolute inset-0 z-10"
          >
            {/*
              The tab is the column's grip as well as its menu (§3.4). The
              press is taken on the *wrapper* rather than on the trigger for
              the reason the block grip is our own `<button>`: `ToolbarMenu`
              owns its trigger and cannot carry these, and the wrapper is
              exactly the tab's own box. A press that never travels still opens
              the menu; one that does is a drag, and the click it would have
              synthesised is swallowed.
            */}
            <div
              className="pointer-events-auto absolute"
              onPointerDown={(event) =>
                beginSort(event, "column", tableHandle.column, tableHandle.table)
              }
              style={{
                top: `${tableHandle.top - TABLE_AXIS - TABLE_AXIS_GAP}px`,
                left: `${tableHandle.columnLeft}px`,
                width: `${Math.max(tableHandle.columnWidth, TABLE_AXIS)}px`,
                height: `${TABLE_AXIS}px`,
              }}
            >
              <ToolbarMenu
                label={labels.tableColumnMenu}
                trigger={<span aria-hidden className="sr-only" />}
                open={tableMenu === "column"}
                onOpenChange={(next) => setTableMenu(next ? "column" : null)}
                triggerClassName={TABLE_AXIS_TRIGGER}
                panelClassName="min-w-56"
              >
                {COLUMN_OPS.map((op) => (
                  <Fragment key={op}>
                    {tableOpStartsGroup(op) ? <MenuSeparator /> : null}
                    <MenuItem
                      label={tableOpLabel(op, labels.table, tableHandle.context.headerRow)}
                      icon={tableOpIcon(op)}
                      disabled={!tableHandle.context.can[op]}
                      onSelect={() => {
                        setTableMenu(null);
                        applyTableOp(tableCellRef.current, op, false);
                      }}
                    />
                  </Fragment>
                ))}
              </ToolbarMenu>
            </div>

            <div
              className="pointer-events-auto absolute"
              onPointerDown={(event) => beginSort(event, "row", tableHandle.row, tableHandle.table)}
              style={{
                top: `${tableHandle.rowTop}px`,
                left: `${tableHandle.left - TABLE_AXIS - TABLE_AXIS_GAP}px`,
                width: `${TABLE_AXIS}px`,
                height: `${Math.max(tableHandle.rowHeight, TABLE_AXIS)}px`,
              }}
            >
              <ToolbarMenu
                label={labels.tableRowMenu}
                trigger={<span aria-hidden className="sr-only" />}
                open={tableMenu === "row"}
                onOpenChange={(next) => setTableMenu(next ? "row" : null)}
                triggerClassName={TABLE_AXIS_TRIGGER}
                panelClassName="min-w-56"
              >
                {ROW_OPS.map((op) => (
                  <Fragment key={op}>
                    {tableOpStartsGroup(op) ? <MenuSeparator /> : null}
                    <MenuItem
                      label={tableOpLabel(op, labels.table, tableHandle.context.headerRow)}
                      icon={tableOpIcon(op)}
                      disabled={!tableHandle.context.can[op]}
                      onSelect={() => {
                        setTableMenu(null);
                        applyTableOp(tableCellRef.current, op, false);
                      }}
                    />
                  </Fragment>
                ))}
              </ToolbarMenu>
            </div>
          </div>
        )}
      </div>

      {/*
        The right-click menu (ve-context-menu.tsx). Two vocabularies in one
        list, and neither is invented here: the caret's cell contributes §3.2's
        twelve operations — the ones it can actually be given, since a list you
        read has no room for rows that refuse — and the block contributes
        §3.1's own rows, straight out of `blockMenuRows`, so a command reached
        by right-click and the same command reached from the gutter grip cannot
        drift apart.
      */}
      {contextMenu === null ? null : (
        <VeContextMenu
          at={contextMenu.at}
          label={labels.contextMenu}
          onClose={closeContextMenu}
          rows={contextMenuRows(contextMenu, labels, runTableOpFromMenu, runBlockFromMenu)}
        />
      )}

      {/*
        The gutter handle (§3.1). React's markup, positioned `fixed` from the
        block's own corner — never inside the contenteditable, where
        `domToDocument` would read a button as the paragraph's content and
        publish it. It is rendered after the wrapper so the writing area keeps
        the first tab stop; the handle is the next one, which is how a keyboard
        reaches the grip's menu at all.
      */}
      {blockHandle === null || sorting ? null : (
        <VeBlockHandle
          anchor={blockHandle.anchor}
          canMoveUp={blockHandle.up}
          canMoveDown={blockHandle.down}
          formats={blockHandle.formats}
          onCommand={onBlockCommand}
          onSortPointerDown={(event) => {
            const root = liveRef.current;
            const block = moveBlockRef.current;
            const unit = root === null || block === null ? null : blockUnitOf(root, block);
            if (unit === null) return;
            beginSort(event, "block", unit.index, null);
          }}
          disabled={readOnly}
          labels={labels.handle}
        />
      )}

      {/*
        The slash menu (§1). It takes no focus — the author is mid-word — and
        claims its own keys from the document while it is open, so nothing here
        forwards anything to it. What it hands back is the row; taking the
        typed "/query" out of the buffer is this surface's job, because only
        this side knows where it is.
      */}
      <VeSlashMenu
        open={slash !== null}
        anchor={slash?.anchor ?? null}
        query={slash?.query ?? ""}
        items={slash?.items ?? EMPTY_SLASH_ITEMS}
        onSelect={chooseSlashItem}
        onClose={dismissSlash}
        labels={labels.slashMenu}
      />

      {/*
        The `[[` / `@` / `{{` panel (§13) — the same panel, so the two lists
        share one keyboard contract and one set of manners, and an author who
        learns the arrows on one has learned them on the other. `filter` is off
        because these rows came back from a search that already answered this
        query: filtering them again here would drop a page the index matched on
        something other than the words in its title.
      */}
      <VeSlashMenu
        open={mention !== null}
        anchor={mention?.anchor ?? null}
        query={mention?.query ?? ""}
        items={mention?.items ?? EMPTY_SLASH_ITEMS}
        onSelect={chooseMention}
        onClose={dismissMention}
        filter={false}
        busy={mention?.busy ?? false}
        labels={mention?.kind === "template" ? labels.mentionTemplate : labels.mentionPage}
      />

      {/*
        The bubble menu (§3). Every control in it cancels its own `mousedown`
        and so does the bar — without that, the press that is about to format
        the selection destroys it first.
      */}
      <VeBubbleMenu
        rect={bubble?.rect ?? null}
        activeMarks={bubble?.marks ?? EMPTY_MARKS}
        currentFormat={bubble?.format ?? "paragraph"}
        formats={bubble?.formats ?? EMPTY_FORMATS}
        onAction={runAction}
        labels={labels.bubble}
      />
      {/*
        The one dialog the surface owns. Both faces of it are about the table
        under the caret, which is knowledge no other component has: what the
        last row of a table is, and why a header row refused. It is drawn
        outside the editor's box rather than in it — the box grows a focus ring
        while anything inside it has focus, and a modal's buttons are not the
        author being in the article.
      */}
      <Dialog
        open={tableDialog !== null && tableDialog.kind === "refused"}
        onClose={closeTableDialog}
        title={labels.tableHeaderRefusedTitle}
        closeLabel={labels.dialogClose}
      >
        <p className="text-sm text-body">{labels.tableHeaderRefusedBody}</p>
      </Dialog>
      <Dialog
        open={tableDialog !== null && tableDialog.kind === "confirm"}
        onClose={closeTableDialog}
        title={labels.tableDeleteTitle}
        closeLabel={labels.dialogClose}
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-body">
            {tableDialog !== null && tableDialog.kind === "confirm"
              ? tableDeleteMessage(tableDialog.op, labels)
              : ""}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={closeTableDialog}>
              {labels.dialogCancel}
            </Button>
            <Button variant="danger" size="sm" onClick={confirmTableDialog}>
              {labels.tableDeleteConfirm}
            </Button>
          </div>
        </div>
      </Dialog>
      </>
    );
  },
);
