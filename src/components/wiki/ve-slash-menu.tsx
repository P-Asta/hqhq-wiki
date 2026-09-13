"use client";

/**
 * The slash menu — "/" at the caret, then a block by name.
 *
 * The toolbar's `INSERT ▾` (editor-toolbar-visual.tsx) asks the author to
 * leave the sentence, find a dropdown and read a list. Notion's answer, and
 * the one this editor adopts (user direction, 2026-09-04), is that the list
 * comes to the caret and the author keeps typing: "/tab" is a shorter road to
 * a table than the pointer's.
 *
 * Three things follow from that, and they are the whole design:
 *
 * - **It knows nothing about wikitext.** The caller passes the items, each
 *   carrying the `VisualAction` the surface will apply, so the snippets stay
 *   where they already are (editor-toolbar-visual.tsx) and the menu cannot
 *   drift from what the toolbar inserts. Two roads, one vocabulary.
 * - **It never takes focus.** The author is mid-word; moving focus would
 *   collapse the caret and lose the very selection the action is about. So
 *   the panel is drawn *outside* the contenteditable, it is not focusable, and
 *   while it is open it claims its own keys from the document in the capture
 *   phase — the surface keeps the caret and never sees them.
 * - **Its two decisions are pure functions.** `filterSlashItems` orders the
 *   matches and `slashMenuPosition` keeps the panel on screen; both are
 *   exported and tested with plain objects, because vitest runs in a node
 *   environment and those two are exactly what goes wrong in the wild — a
 *   query that ranks the wrong row first, and a panel that opens off-screen
 *   at the bottom of the page.
 *
 * The panel places itself from *nominal* geometry (a fixed width, a row
 * height) rather than by measuring itself after a first paint. Measuring would
 * mean a layout effect writing state, which this repo's lint forbids and which
 * would flash the panel at the wrong place first; the cost is that the flip
 * decision can be one row out on a list whose rows wrap, which moves a panel
 * that would have fitted, never one that would not.
 */

import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";

import { PANEL_SCROLLER_ATTR, useContainedWheel } from "@/components/wiki/ve-panel-scroll";
import { cn } from "@/lib/utils";
import type { VisualAction } from "@/lib/visual-editor/actions";

/* ------------------------------------------------------------------ */
/* Items                                                               */
/* ------------------------------------------------------------------ */

export interface SlashItem {
  key: string;
  label: string;
  /** A second line — what the block is for. */
  hint?: string;
  /** Words that should also match this item when typed. */
  keywords?: readonly string[];
  icon: ReactNode;
  action: VisualAction;
}

export interface SlashMenuLabels {
  /** Names the list; drawn as its heading and used as its accessible name. */
  title: string;
  /** The one line a query that matched nothing shows instead of rows. */
  empty: string;
  /**
   * Shown in place of that line while a search is still owed — the mention
   * panel's only extra state (§13). "Nothing matches that" is a lie about a
   * request that has not answered yet, and the two are a keystroke apart.
   */
  loading?: string;
}

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

/**
 * The comparable form of a word: no case, no diacritics. An author typing
 * "reference" must reach a row named "Référence" in a localized dictionary,
 * and one typing "Table" must reach "table" — neither is a different word.
 */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** Ranks below this one matched; the value itself means "no match at all". */
const NO_MATCH = 4;

/**
 * How well an item answers the query — **lower is better**.
 *
 * A prefix beats a containment and the label beats a keyword, which is the
 * order an author expects: "ta" is the start of *Table*, and a row that merely
 * contains those letters somewhere ("Metadata") is a fallback, not the answer.
 * Keywords rank below the label they belong to because they are the synonyms
 * an author *might* have typed, not the name they will read back.
 */
function rankOf(item: SlashItem, needle: string): number {
  const label = fold(item.label);
  if (label.startsWith(needle)) return 0;
  const keywords = (item.keywords ?? []).map(fold);
  if (keywords.some((word) => word.startsWith(needle))) return 1;
  if (label.includes(needle)) return 2;
  if (keywords.some((word) => word.includes(needle))) return 3;
  return NO_MATCH;
}

/**
 * Pure: the filtered, ordered list for a query. Exported for tests.
 *
 * An empty query offers everything in the caller's own order — that order is
 * editorial (the blocks a wiki writer reaches for first) and nothing here
 * knows better. Otherwise items are ranked, and ties keep the caller's order
 * so the list never reshuffles under a keystroke that changed no rank.
 *
 * The query is trimmed: a trailing space is a typing artefact of "/table ",
 * not a filter the author has to delete to get their row back.
 */
export function filterSlashItems(items: readonly SlashItem[], query: string): SlashItem[] {
  const needle = fold(query).trim();
  if (needle === "") return [...items];
  return items
    .map((item, index) => ({ item, index, rank: rankOf(item, needle) }))
    .filter((row) => row.rank < NO_MATCH)
    .sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank - b.rank))
    .map((row) => row.item);
}

/* ------------------------------------------------------------------ */
/* Placing                                                             */
/* ------------------------------------------------------------------ */

/** Between the caret's line and the panel. */
const GAP = 8;
/**
 * A nominal caret height. `anchor` is a point rather than a rect — a collapsed
 * range is what the surface has — so flipping above has to estimate where the
 * author's line starts. Too large only opens the panel a little higher.
 */
const CARET = 20;
/** How close to the viewport's edge the panel may sit. */
const MARGIN = 8;

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/**
 * Pure: where the panel goes so it stays on screen. Exported for tests.
 *
 * `anchor` is the caret's bottom-left in viewport coordinates, so the panel
 * hangs under the line being typed on. It flips above only when it does not
 * fit below **and** does fit above: a panel that fits nowhere stays where the
 * author is looking and is clamped into the viewport instead, which at worst
 * covers the line — flipping it would cover the line *and* put the list
 * somewhere the author was not looking.
 */
export function slashMenuPosition(
  anchor: { top: number; left: number },
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
): { top: number; left: number } {
  const below = anchor.top + GAP;
  const above = anchor.top - CARET - GAP - panel.height;
  const fitsBelow = below + panel.height + MARGIN <= viewport.height;
  const fitsAbove = above >= MARGIN;
  const top = !fitsBelow && fitsAbove ? above : below;
  return {
    top: clamp(top, MARGIN, viewport.height - panel.height - MARGIN),
    left: clamp(anchor.left, MARGIN, viewport.width - panel.width - MARGIN),
  };
}

/* ------------------------------------------------------------------ */
/* Nominal geometry                                                    */
/* ------------------------------------------------------------------ */

/** `w-72`, in pixels — the panel's width is fixed, so it is known here. */
const PANEL_WIDTH = 288;
/** One row: the icon, the label, and the hint under it. */
const ROW_HEIGHT = 46;
/** The heading over the rows. */
const HEADER_HEIGHT = 28;
/** The panel's own padding, top and bottom together. */
const PANEL_PADDING = 10;
/** `max-h-80` — past this the list scrolls rather than growing. */
const MAX_LIST_HEIGHT = 320;

/** What the panel will be, before it exists. `rows` is 1 for the empty line. */
function panelSize(rows: number): { width: number; height: number } {
  const list = Math.min(Math.max(rows, 1) * ROW_HEIGHT, MAX_LIST_HEIGHT);
  return { width: PANEL_WIDTH, height: HEADER_HEIGHT + PANEL_PADDING + list };
}

/**
 * An option's DOM id, so the *surface* — which holds the focus — can point its
 * `aria-activedescendant` at the row this menu has highlighted. The caller's
 * keys are slugs ("table", "heading"), and anything that cannot appear in an
 * id becomes a dash.
 */
function optionId(key: string): string {
  return `ve-slash-option-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/* ------------------------------------------------------------------ */
/* Menu                                                                */
/* ------------------------------------------------------------------ */

export interface SlashMenuProps {
  open: boolean;
  /** Viewport coordinates of the caret; the menu places itself near them. */
  anchor: { top: number; left: number } | null;
  /** What has been typed after the slash. */
  query: string;
  items: readonly SlashItem[];
  onSelect: (item: SlashItem) => void;
  onClose: () => void;
  labels: SlashMenuLabels;
  /**
   * Whether the query filters the items here. True for the slash menu, whose
   * catalogue is fixed and local; **false** for the mention panels (§13),
   * whose rows came back from a search that already answered this query — and
   * where filtering again would drop a page the index matched on something
   * other than the words in its title.
   */
  filter?: boolean;
  /** A search is still owed, so an empty list is not yet an empty answer. */
  busy?: boolean;
}

/**
 * The panel. Renders nothing at all when closed or unanchored — not an empty
 * frame, not a hidden one.
 *
 * **The keyboard, and what the surface must do about it.** The menu takes no
 * focus: nothing in it is focusable, nothing autofocuses, and `aria-hidden` is
 * spelled out as false because a panel outside the focused element still has
 * to be read. The author keeps typing into the surface, and while the menu is
 * open it takes ArrowUp / ArrowDown / Home / End / Enter / Escape from the
 * document in the **capture** phase — before the surface's own handlers run,
 * whichever they are. So the integration pass has to do nothing to forward
 * them, and must not bind those keys on the way in for as long as it renders
 * this open.
 *
 * Some keys stay the surface's on purpose: any Alt / Ctrl / Meta / Shift
 * combination (`Alt+ArrowUp` moves a block — visual-editor.md §3.1), every key
 * pressed while an IME is composing, and the navigation keys when the query
 * matched nothing — there is no row to move to, so the caret should move
 * instead. Escape is always the menu's: it is the author's way out.
 *
 * Selecting is `onSelect` and closing is `onClose`. The menu owns neither the
 * document nor the slash it was opened by: taking the typed "/query" back out
 * of the buffer is the surface's, which is the only side that knows where it
 * is.
 */
export function VeSlashMenu({
  open,
  anchor,
  query,
  items,
  onSelect,
  onClose,
  labels,
  filter = true,
  busy = false,
}: SlashMenuProps): ReactElement | null {
  const panelRef = useRef<HTMLDivElement | null>(null);

  // The wheel stops here rather than reaching the page. The page moving is
  // what closes this panel (visual-editor.tsx), so a list that ran out of rows
  // used to dismiss itself under a gesture meant for it.
  useContainedWheel(panelRef, open && anchor !== null);

  /**
   * The highlighted row, remembered as an item key *together with the query it
   * was chosen under*. A later keystroke re-ranks the list, so the stale
   * choice stops applying and the best match is highlighted again — Notion's
   * behaviour, and reached without an effect that resets an index (which this
   * repo's lint forbids) and without a bare key, which would keep a row
   * highlighted after the new query ranked it third.
   */
  const [chosen, setChosen] = useState<{ key: string; query: string } | null>(null);

  const results = useMemo(
    () => (filter ? filterSlashItems(items, query) : [...items]),
    [filter, items, query],
  );

  const activeIndex = useMemo(() => {
    if (results.length === 0) return -1;
    if (chosen === null || chosen.query !== query) return 0;
    const found = results.findIndex((item) => item.key === chosen.key);
    return found === -1 ? 0 : found;
  }, [results, chosen, query]);

  useEffect(() => {
    if (!open) return;

    const choose = (index: number) => {
      const item = results.at(index);
      if (item === undefined) return;
      setChosen({ key: item.key, query });
    };

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      // A modified key is never the menu's: Alt+Arrow moves a block (§3.1) and
      // the Ctrl/Meta combinations are the editor's own shortcuts.
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      // Mid-composition every key belongs to the IME, which is still choosing
      // a candidate — Enter commits that candidate, not the menu's row.
      if (event.isComposing) return;

      const take = () => {
        event.preventDefault();
        event.stopPropagation();
      };

      if (event.key === "Escape") {
        take();
        onClose();
        return;
      }

      const count = results.length;
      if (count === 0) return;

      switch (event.key) {
        case "ArrowDown":
          take();
          choose((activeIndex + 1) % count);
          break;
        case "ArrowUp":
          take();
          choose((activeIndex - 1 + count) % count);
          break;
        case "Home":
          take();
          choose(0);
          break;
        case "End":
          take();
          choose(count - 1);
          break;
        case "Enter": {
          const item = results.at(activeIndex);
          if (item === undefined) return;
          take();
          onSelect(item);
          break;
        }
        default:
          break;
      }
    };

    /**
     * A pointer that lands anywhere but the panel has left the gesture — the
     * author went back to writing, or to another block. `pointerdown` rather
     * than `click`, so the menu is gone before the surface moves the caret.
     */
    const onPointerDown = (event: PointerEvent) => {
      const panel = panelRef.current;
      if (panel !== null && event.target instanceof Node && panel.contains(event.target)) return;
      onClose();
    };

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, query, results, activeIndex, onSelect, onClose]);

  /**
   * A long list scrolls rather than growing, so keyboard navigation has to be
   * able to reach a row below its fold. Read out of the DOM rather than held
   * in a ref per row: there is exactly one highlighted row, and it says so.
   */
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const row = panelRef.current?.querySelector<HTMLElement>(
      '[role="option"][aria-selected="true"]',
    );
    row?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  if (!open || anchor === null) return null;

  /**
   * Read during render rather than through a resize listener: the panel lives
   * for a few keystrokes and every one of them re-renders it, which is more
   * often than a listener would fire. Off the browser (SSR, and vitest's node
   * environment) there is no screen to fit into, so nothing is clamped.
   */
  const viewport =
    typeof window === "undefined"
      ? { width: Number.POSITIVE_INFINITY, height: Number.POSITIVE_INFINITY }
      : { width: window.innerWidth, height: window.innerHeight };
  const position = slashMenuPosition(anchor, panelSize(results.length), viewport);

  return (
    <div
      ref={panelRef}
      // Spelled out: the panel is a live list that the focused surface drives,
      // and it has to stay in the accessibility tree while holding no focus.
      aria-hidden={false}
      // How the surface's own pointer handling recognises "not mine".
      data-ve-slash-menu=""
      style={{ top: `${position.top}px`, left: `${position.left}px` }}
      className="fixed z-40 w-72 overflow-hidden rounded-[var(--radius-md)] border border-hairline bg-surface py-1 shadow-[var(--shadow-md)]"
    >
      <div
        role="presentation"
        className="px-2 py-1 font-mono text-[11px] uppercase tracking-[0.08em] text-faint"
      >
        {labels.title}
      </div>
      {/*
        `overscroll-contain`: past the end of this list the wheel stops, rather
        than handing the rest of its delta to the page. The page scrolling is
        what closes the menu — a panel anchored to a caret cannot follow one —
        so without it an author who scrolled to the bottom of the list lost the
        list (user report, 2026-09-05).
      */}
      <ul
        role="listbox"
        aria-label={labels.title}
        {...{ [PANEL_SCROLLER_ATTR]: "" }}
        className="max-h-80 overflow-y-auto overscroll-contain px-1"
      >
        {results.map((item, index) => (
          <li
            key={item.key}
            id={optionId(item.key)}
            role="option"
            aria-selected={index === activeIndex}
            // The caret stays where it is: the action is about the block the
            // author is standing in, and a click that moved focus would first
            // destroy the very selection it is meant to act on.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(item)}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-canvas-soft",
              index === activeIndex ? "bg-canvas-soft text-ink" : "text-body",
            )}
          >
            <span
              aria-hidden
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-hairline bg-canvas-soft-2 font-mono text-mute"
            >
              {item.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{item.label}</span>
              {item.hint === undefined ? null : (
                <span className="block truncate text-[11px] text-faint">{item.hint}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {results.length === 0 ? (
        // A query that matched nothing is a typo, not a change of mind:
        // closing here would eat the slash the author still means to use. A
        // search that has not answered yet is neither, so it says so instead
        // of claiming there is nothing (§13).
        <p className="px-3 py-2 text-[13px] text-mute">
          {busy && labels.loading !== undefined ? labels.loading : labels.empty}
        </p>
      ) : null}
    </div>
  );
}
