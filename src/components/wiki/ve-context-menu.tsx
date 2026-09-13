"use client";

/**
 * **The right-click menu** (user direction, 2026-09-05: "put in something where
 * you right-click a block — a table, say — and get its special functions: add a
 * column to the right, add a row below").
 *
 * It is the third road to the operations §3.2 and §3.1 already own, and it
 * exists because the other two ask the author to find a control first. The axis
 * menus sit beside the table and the gutter handle sits beside the block; both
 * are pointer affordances that have to be *aimed at*. Right-clicking the thing
 * you mean is the gesture every grid in every application answers, and it needs
 * no control on screen at all — which is what makes it the right replacement
 * for the two "+"s the same direction removed.
 *
 * Three things it deliberately is not:
 *
 * - **Not a new vocabulary.** Every row is a `VeTableOp` or a
 *   `BlockMenuCommand` the caller already routes, named out of the same
 *   dictionary. A menu with an operation of its own would be a fourth road
 *   able to disagree with the other three.
 * - **Not the browser's menu everywhere.** The surface hands the native menu
 *   through wherever this has nothing to offer — outside a block, and inside
 *   the branch field's textarea, where spellcheck, cut and paste are exactly
 *   what a right-click is for.
 * - **Not drawn inside the contenteditable.** Like every other control here it
 *   is React's markup outside the surface, positioned from viewport
 *   coordinates, so `domToDocument` can never read a button as content (§3).
 *
 * `contextMenuPosition` is the one decision worth testing on its own: a menu
 * opened near the bottom-right corner has to come back on screen, and it has to
 * do it by flipping about the pointer rather than by sliding out from under it.
 */

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { MenuItem, MenuSeparator } from "@/components/wiki/editor-menu";
import { PANEL_SCROLLER_ATTR, useContainedWheel } from "@/components/wiki/ve-panel-scroll";

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

export interface VeContextRow {
  key: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  /** A rule above this row — it opens a new group. */
  startsGroup?: boolean;
  /** A presentational heading over that rule; only "Turn into" has one. */
  heading?: string;
  onSelect: () => void;
}

/* ------------------------------------------------------------------ */
/* Where it opens                                                      */
/* ------------------------------------------------------------------ */

/** Nominal row height in pixels — `MenuItem`'s padding plus its line box. */
const ROW_HEIGHT = 30;
/** A separator's own height (`my-1` either side of a 1px rule). */
const RULE_HEIGHT = 9;
/** A presentational group heading ("Turn into"). */
const HEADING_HEIGHT = 24;
/** The panel's padding, top and bottom together. */
const PANEL_PADDING = 8;
/** Fixed width, so the flip decision needs no measurement. */
export const CONTEXT_MENU_WIDTH = 224;
/** Past this the list scrolls rather than growing. */
const MAX_HEIGHT = 420;
/** How close to the viewport's edge the panel may sit. */
const MARGIN = 8;

/** Nominal height of a panel holding `rows`, so it can be placed before paint. */
export function contextMenuHeight(rows: readonly VeContextRow[]): number {
  const rules = rows.filter((row) => row.startsGroup === true).length;
  const headings = rows.filter((row) => row.heading !== undefined).length;
  const height =
    PANEL_PADDING +
    rows.length * ROW_HEIGHT +
    rules * RULE_HEIGHT +
    headings * HEADING_HEIGHT;
  return Math.min(height, MAX_HEIGHT);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/**
 * Pure: where the panel goes so it stays on screen. Exported for tests.
 *
 * `at` is the pointer, in viewport coordinates. The panel hangs down and to the
 * right of it — the direction every context menu opens in — and **flips about
 * the pointer** rather than sliding when it does not fit: sliding would leave
 * the panel under the pointer, so its first row would be armed beneath a finger
 * that has not moved yet. A panel that fits in neither direction is clamped,
 * because at that size the viewport is the constraint and no flip helps.
 */
export function contextMenuPosition(
  at: { top: number; left: number },
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
): { top: number; left: number } {
  const fitsBelow = at.top + panel.height + MARGIN <= viewport.height;
  const fitsAbove = at.top - panel.height >= MARGIN;
  const top = !fitsBelow && fitsAbove ? at.top - panel.height : at.top;

  const fitsRight = at.left + panel.width + MARGIN <= viewport.width;
  const fitsLeft = at.left - panel.width >= MARGIN;
  const left = !fitsRight && fitsLeft ? at.left - panel.width : at.left;

  return {
    top: clamp(top, MARGIN, viewport.height - panel.height - MARGIN),
    left: clamp(left, MARGIN, viewport.width - panel.width - MARGIN),
  };
}

/* ------------------------------------------------------------------ */
/* The panel                                                           */
/* ------------------------------------------------------------------ */

const MENU_ITEM_SELECTOR = "[role=\"menuitem\"]";

function menuItemsOf(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)).filter(
    (item) => !(item instanceof HTMLButtonElement && item.disabled),
  );
}

function focusItemAt(panel: HTMLElement | null, index: number): void {
  if (panel === null) return;
  const items = menuItemsOf(panel);
  if (items.length === 0) return;
  items[((index % items.length) + items.length) % items.length].focus();
}

export function VeContextMenu({
  at,
  rows,
  label,
  onClose,
}: {
  /** The pointer, in viewport coordinates. */
  at: { top: number; left: number };
  rows: readonly VeContextRow[];
  /** The panel's accessible name. */
  label: string;
  /** Every way out; `restoreFocus` asks for the writing surface back. */
  onClose: (restoreFocus: boolean) => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  // The wheel stops here rather than reaching the page: a page scroll closes
  // this menu, and running out of rows is not a reason to be closed.
  useContainedWheel(panelRef);

  // A context menu is opened deliberately, so it takes focus — unlike the slash
  // menu, which the author is still typing into. That is also what makes Escape
  // meaningful here: there is somewhere for focus to go back to.
  useEffect(() => {
    focusItemAt(panelRef.current, 0);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose(true);
    };
    const onPointerDown = (event: PointerEvent): void => {
      const panel = panelRef.current;
      if (panel !== null && event.target instanceof Node && panel.contains(event.target)) return;
      onClose(false);
    };
    // Capture, so a press anywhere closes this before that press is acted on: a
    // right-click on another block should open *that* block's menu rather than
    // land on a row of this one.
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [onClose]);

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

  /**
   * Read during render rather than through a resize listener: the panel lives
   * for one gesture, and a resize while it is open closes it anyway. Off the
   * browser (SSR, vitest's node environment) there is no screen to fit into.
   */
  const viewport =
    typeof window === "undefined"
      ? { width: Number.POSITIVE_INFINITY, height: Number.POSITIVE_INFINITY }
      : { width: window.innerWidth, height: window.innerHeight };
  const position = contextMenuPosition(
    at,
    { width: CONTEXT_MENU_WIDTH, height: contextMenuHeight(rows) },
    viewport,
  );

  return (
    <div
      ref={panelRef}
      role="menu"
      aria-label={label}
      onKeyDown={onPanelKeyDown}
      // How the surface's own pointer handling recognises "not mine", the way
      // it does for the slash menu and the gutter handle.
      data-ve-context-menu=""
      // It is its own scroller: the rows are all it holds.
      {...{ [PANEL_SCROLLER_ATTR]: "" }}
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
        width: `${CONTEXT_MENU_WIDTH}px`,
        maxHeight: `${MAX_HEIGHT}px`,
      }}
      // `overscroll-contain`: the wheel stops at the ends of this list instead
      // of handing the rest of its delta to the page. A page scroll closes this
      // menu — it hangs off a pointer that is no longer over anything — so
      // chaining turned "scroll to the last row" into "lose the menu".
      className="fixed z-40 overflow-y-auto overscroll-contain rounded-[var(--radius-md)] border border-hairline bg-surface p-1 shadow-[var(--shadow-md)]"
    >
      {rows.map((row) => (
        <Fragment key={row.key}>
          {row.startsGroup === true ? <MenuSeparator /> : null}
          {row.heading === undefined ? null : (
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
            icon={row.icon}
            disabled={row.disabled}
            onSelect={() => {
              onClose(false);
              row.onSelect();
            }}
          />
        </Fragment>
      ))}
    </div>
  );
}
