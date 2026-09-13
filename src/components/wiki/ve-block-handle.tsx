"use client";

/**
 * The gutter handle — Notion's left-hand pair of controls, replacing the two
 * up/down buttons docs/engine/visual-editor.md §3.1 describes.
 *
 * **The trap this file exists to avoid: none of this may be written inside the
 * contenteditable.** A `<button>` placed in a paragraph is markup
 * `domToDocument` reads back as that paragraph's content and `serializeDocument`
 * publishes — the article would gain a "+" nobody typed. So the handle is
 * React's own markup, positioned over the surface from *viewport* coordinates
 * the caller measures, and the surface's own DOM is never touched. That is also
 * why `anchor` is a plain pair of numbers rather than an element: this module
 * never holds a node it could accidentally mutate.
 *
 * §3.1 argued against a drag handle, because dragging cannot be reached from a
 * keyboard. The 2026-09-04 direction keeps the argument and answers it instead
 * of dropping it: the grip's menu carries **Move up / Move down as ordinary
 * items**, and `Alt+ArrowUp` / `Alt+ArrowDown` stay bound in the surface. Drag
 * is the pointer's shortcut to a move every keyboard can already make.
 *
 * Two things are deliberately not the same as the toolbar's dropdowns:
 *
 * - The grip is **our** `<button>`, not `ToolbarMenu`'s. `ToolbarMenu` owns its
 *   trigger and cannot carry the drag's pointer handlers, which have to sit on
 *   the element the pointer presses. So the panel's keyboard contract — roving
 *   arrows over the rows, Home/End, Escape closing and handing focus back to
 *   the trigger, an outside pointer-down dismissing — is matched here against
 *   `editor-menu.tsx`, and every row is still a `MenuItem` from it, so a row
 *   cannot drift from the rows of any other menu in this editor.
 * - The **"+" prevents its `mousedown` and the grip does not.** Preventing it
 *   is what stops a click from taking the caret out of the block the command is
 *   about; but the same `preventDefault` also cancels the browser's drag, so
 *   the grip has to let the press through. While its menu is open the caller
 *   must keep the handle anchored where it is — clicking the grip can blur the
 *   surface, and a handle that re-anchored on that would close its own menu.
 *
 * The drag's arithmetic — which slot the pointer is over, how far everything
 * else has to shift to open a hole for it — is `ve-sortable.ts`, shared with
 * the table's rows and columns, which are dragged the same way (§3.4).
 */

import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";

import { Button } from "@/components/ui/button";
import { MenuItem, MenuSeparator } from "@/components/wiki/editor-menu";
import { cn } from "@/lib/utils";
import type { VeBlockCommand, VeBlockFormat } from "@/lib/visual-editor/actions";

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

/**
 * What the grip's menu can ask for — `VeBlockCommand` under the name this file
 * gave it, kept so every caller reads the same word.
 *
 * The union itself moved to `actions.ts` when the slash menu grew rows for
 * these (§1): a menu row emits `{ kind: "block", command }` like any other
 * action, and a type owned by this component would have made the catalogue
 * import a panel. What has NOT changed is that a command carries no block —
 * this menu is about the block a *pointer* chose, which the caller names
 * explicitly, and the slash menu's rows are about the caret's.
 */
export type BlockMenuCommand = VeBlockCommand;

export interface BlockHandleLabels {
  /** The "+" button — it adds a block below, so say that, not "add". */
  add: string;
  /** The grip button, which both drags and opens the menu. */
  grip: string;
  /** The panel's own name, announced when focus enters it. */
  menu: string;
  insertBelow: string;
  duplicate: string;
  delete: string;
  moveUp: string;
  moveDown: string;
  /** Heading over the format rows; never a row itself. */
  turnInto: string;
  /** One per format the "turn into" submenu offers, keyed by VeBlockFormat. */
  formats: Record<string, string>;
}

export interface BlockHandleProps {
  /** Viewport coordinates of the block's top-left; null hides the handle. */
  anchor: { top: number; left: number } | null;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** Formats the "turn into" submenu should offer for THIS block. */
  formats: readonly VeBlockFormat[];
  onCommand: (command: BlockMenuCommand) => void;
  /**
   * A press on the grip (§3.4). It is not a drag until the pointer travels, so
   * the same button still opens the menu — the surface decides which it was,
   * listens for the move on the *window* rather than here (this button is
   * unmounted the moment a drag starts, so handlers bound to it would go with
   * it), and swallows the click when it turned out to be a drag.
   */
  onSortPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  disabled?: boolean;
  labels: BlockHandleLabels;
}

/* ------------------------------------------------------------------ */
/* What the menu offers                                                */
/* ------------------------------------------------------------------ */

/**
 * One row of the grip's menu. Pulling the rows out of the markup is what lets
 * "a table does not offer to become a heading" and "the first block cannot move
 * up" be asserted under vitest's node environment: a panel exists only while it
 * is open, and `renderToStaticMarkup` renders it closed.
 */
export interface BlockMenuRow {
  command: BlockMenuCommand;
  label: string;
  disabled: boolean;
  /** A rule above this row — it opens a new group. */
  startsGroup: boolean;
  /** A presentational heading under that rule; only "Turn into" has one. */
  heading: string | null;
}

export function blockMenuRows(input: {
  canMoveUp: boolean;
  canMoveDown: boolean;
  formats: readonly VeBlockFormat[];
  labels: BlockHandleLabels;
}): BlockMenuRow[] {
  const { canMoveUp, canMoveDown, formats, labels } = input;
  const rows: BlockMenuRow[] = [
    {
      command: { kind: "insertBelow" },
      label: labels.insertBelow,
      disabled: false,
      startsGroup: false,
      heading: null,
    },
    {
      command: { kind: "duplicate" },
      label: labels.duplicate,
      disabled: false,
      startsGroup: false,
      heading: null,
    },
    // The keyboard's way to a reorder, which is why the grip alone would not do
    // (§3.1). Where a move lands nowhere the row is disabled, not inert.
    {
      command: { kind: "move", direction: "up" },
      label: labels.moveUp,
      disabled: !canMoveUp,
      startsGroup: true,
      heading: null,
    },
    {
      command: { kind: "move", direction: "down" },
      label: labels.moveDown,
      disabled: !canMoveDown,
      startsGroup: false,
      heading: null,
    },
  ];

  // Only what the caller offered, in the caller's order — a table or a chip
  // passes none and gets no section at all. Deduplicated because a repeated
  // format would otherwise be two identical rows sharing one identity.
  const offered = [...new Set(formats)];
  offered.forEach((format, index) => {
    // A dictionary that has not been given this format still renders a row an
    // author can read, rather than an empty one they cannot.
    const named: string | undefined = labels.formats[format];
    rows.push({
      command: { kind: "turnInto", format },
      label: named ?? format,
      disabled: false,
      startsGroup: index === 0,
      heading: index === 0 ? labels.turnInto : null,
    });
  });

  // Last, alone, behind a rule: the one row a second click cannot undo should
  // not sit where the pointer lands.
  rows.push({
    command: { kind: "delete" },
    label: labels.delete,
    disabled: false,
    startsGroup: true,
    heading: null,
  });
  return rows;
}

/** A stable identity per row — the commands are objects, and React needs a key. */
function rowKey(command: BlockMenuCommand): string {
  switch (command.kind) {
    case "move":
      return `move:${command.direction}`;
    case "turnInto":
      return `turnInto:${command.format}`;
    default:
      return command.kind;
  }
}

/* ------------------------------------------------------------------ */
/* Menu keyboard plumbing (matched against editor-menu.tsx)            */
/* ------------------------------------------------------------------ */

/** Every enabled row of the panel, in DOM order. */
function menuItemsOf(panel: HTMLElement): HTMLElement[] {
  const selector = '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]';
  return Array.from(panel.querySelectorAll<HTMLElement>(selector)).filter(
    (item) => !item.hasAttribute("disabled"),
  );
}

function focusItemAt(panel: HTMLElement | null, index: number): void {
  if (panel === null) return;
  const items = menuItemsOf(panel);
  if (items.length === 0) return;
  // Wrap, so ArrowDown off the last row returns to the first, as menus do.
  const target = items[((index % items.length) + items.length) % items.length];
  if (target !== undefined) target.focus();
}

/* ------------------------------------------------------------------ */
/* Glyphs                                                              */
/* ------------------------------------------------------------------ */

/**
 * `editor-icons.tsx` is the editor's one icon set and these two belong in it;
 * they are drawn here so this module renders and tests on its own, and the
 * integration pass is free to lift them across. Same rules as that file: a
 * 16×16 box, `currentColor`, no width/height so the size comes from a caller's
 * class, and `aria-hidden` — a button's name comes from the dictionary, never
 * from its icon.
 */
function PlusGlyph({ className }: { className?: string }): ReactElement {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={cn("size-3.5", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="M8 3.75v8.5M3.75 8h8.5" />
    </svg>
  );
}

/** Six dots: what a draggable row has worn since desktop lists had them. */
function GripGlyph({ className }: { className?: string }): ReactElement {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={cn("size-3.5", className)}
      fill="currentColor"
      stroke="none"
    >
      <circle cx="6" cy="4" r="1.15" />
      <circle cx="10" cy="4" r="1.15" />
      <circle cx="6" cy="8" r="1.15" />
      <circle cx="10" cy="8" r="1.15" />
      <circle cx="6" cy="12" r="1.15" />
      <circle cx="10" cy="12" r="1.15" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* The handle                                                          */
/* ------------------------------------------------------------------ */

/** Both gutter controls: small enough to live beside a line of body text. */
const GUTTER_BUTTON =
  "h-6 w-5 min-w-0 shrink-0 rounded-[var(--radius-sm)] px-0 text-faint hover:bg-canvas-soft-2 hover:text-ink";

export function VeBlockHandle({
  anchor,
  canMoveUp,
  canMoveDown,
  formats,
  onCommand,
  onSortPointerDown,
  disabled = false,
  labels,
}: BlockHandleProps): ReactElement | null {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const gripRef = useRef<HTMLButtonElement | null>(null);
  /** Set by the keyboard openers, consumed once the panel has mounted. */
  const focusFirstRef = useRef(false);
  const panelId = useId();

  /**
   * The menu belongs to the block the handle is pointing at, so what is stored
   * is *which anchor it was opened for* rather than a bare boolean. A handle
   * that has moved to another block — or been taken away entirely — is not
   * carrying the same menu any more, and this closes it by comparison instead
   * of by an effect writing state, which the lint rules forbid and which would
   * have left one frame of a menu belonging to the wrong block.
   */
  const anchorKey = anchor === null ? "" : `${anchor.top}:${anchor.left}`;
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = !disabled && openFor !== null && openFor === anchorKey;

  /**
   * Closing by keyboard hands focus back to the grip; closing by pointer does
   * not, because the pointer has already put focus wherever it clicked.
   */
  const close = useCallback((restoreFocus: boolean) => {
    setOpenFor(null);
    if (restoreFocus) gripRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) {
      focusFirstRef.current = false;
      return;
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const root = rootRef.current;
      // Only reclaim focus when it was ours: Escape pressed while the caret is
      // back in the article should not yank it into the gutter.
      const inside =
        root !== null &&
        document.activeElement instanceof Node &&
        root.contains(document.activeElement);
      close(inside);
    };
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
        setOpenFor(null);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, close]);

  useEffect(() => {
    if (!open || !focusFirstRef.current) return;
    focusFirstRef.current = false;
    focusItemAt(panelRef.current, 0);
  }, [open]);

  /** Enter/Space/ArrowDown open the menu *and* land on its first row. */
  const onGripKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "Enter" && event.key !== " " && event.key !== "ArrowDown") return;
      event.preventDefault();
      if (open) focusItemAt(panelRef.current, 0);
      else {
        focusFirstRef.current = true;
        setOpenFor(anchorKey);
      }
    },
    [open, anchorKey],
  );

  const onPanelKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (panel === null) return;
    const items = menuItemsOf(panel);
    const current = items.findIndex((item) => item === document.activeElement);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusItemAt(panel, current + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusItemAt(panel, current <= 0 ? items.length - 1 : current - 1);
        break;
      case "Home":
        event.preventDefault();
        focusItemAt(panel, 0);
        break;
      case "End":
        event.preventDefault();
        focusItemAt(panel, items.length - 1);
        break;
      default:
        break;
    }
  }, []);

  // Every hook above runs unconditionally; only the markup is withheld.
  if (anchor === null) return null;

  const rows = blockMenuRows({ canMoveUp, canMoveDown, formats, labels });

  return (
    <div
      ref={rootRef}
      // Fixed, because `anchor` is measured in viewport coordinates — the caller
      // reads a block's rect and hands it over, and nothing here has to know
      // which scroll container the surface sits in. `-translate-x-full` puts the
      // pair wholly in the gutter so it never covers the first character, and
      // the right padding travels with the translation and becomes the gap.
      style={{ top: `${anchor.top}px`, left: `${anchor.left}px` }}
      className="fixed z-30 -translate-x-full pr-1.5 pt-0.5"
      // The surface's `mouseleave` reads this off `relatedTarget`: a pointer
      // leaving the text *for these buttons* must not make the surface
      // re-anchor them, or the pair moves out from under the press it was
      // reaching for. An attribute rather than a shared ref, because the
      // handle is drawn from state the surface owns and re-mounts freely.
      data-ve-handle="true"
    >
      <div className="relative flex items-start gap-0.5">
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          title={labels.add}
          aria-label={labels.add}
          // Keeps the caret in the block this is about: a click that focused the
          // button would take it, and the new block would land after whatever
          // the surface then thought the caret was.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onCommand({ kind: "insertBelow" })}
          className={GUTTER_BUTTON}
        >
          <PlusGlyph />
        </Button>
        <Button
          ref={gripRef}
          variant="ghost"
          size="sm"
          disabled={disabled}
          title={labels.grip}
          aria-label={labels.grip}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          // No `mousedown` guard here, unlike the "+": the press has to reach
          // the pointer handlers, and dragging is half the point of the grip.
          // The browser's own drag-and-drop is not used at all any more (§3.4)
          // — it draws a picture nothing can animate.
          onPointerDown={onSortPointerDown}
          onClick={() => setOpenFor(open ? null : anchorKey)}
          onKeyDown={onGripKeyDown}
          className={cn(GUTTER_BUTTON, "cursor-grab active:cursor-grabbing")}
        >
          <GripGlyph />
        </Button>

        {open ? (
          <div
            ref={panelRef}
            id={panelId}
            role="menu"
            aria-label={labels.menu}
            onKeyDown={onPanelKeyDown}
            className="absolute left-0 top-full mt-1 min-w-48 rounded-[var(--radius-md)] border border-hairline bg-surface p-1 shadow-[var(--shadow-md)]"
          >
            {rows.map((row) => (
              <Fragment key={rowKey(row.command)}>
                {row.startsGroup ? <MenuSeparator /> : null}
                {row.heading === null ? null : (
                  // Presentational: the rows under it are the menu's own items.
                  <div
                    role="presentation"
                    className="px-2 py-1 font-mono text-[11px] uppercase tracking-[0.08em] text-faint"
                  >
                    {row.heading}
                  </div>
                )}
                <MenuItem
                  label={row.label}
                  disabled={row.disabled}
                  onSelect={() => {
                    // Close first, then emit: the caller's handler is where the
                    // caret lands next, and it should not be racing a panel that
                    // still holds focus.
                    setOpenFor(null);
                    onCommand(row.command);
                  }}
                />
              </Fragment>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
