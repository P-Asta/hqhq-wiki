"use client";

/**
 * The editor's mode pill — docs/engine/visual-editor.md §1 ("Mode pill"):
 * `👁 VISUAL EDITOR ▾` / `[[ ]] SOURCE EDITOR ▾` over a menu of exactly four
 * rows, with the surface you are already in shown selected.
 *
 * It is the loudest affordance on the edit page (`--primary` / `--on-primary`,
 * theme.md "Buttons & forms") because Fandom makes it so: an author who lands
 * in the wrong surface has to be able to find the way out without hunting for
 * it among the toolbar's grey chrome. That colour is also why the trigger is
 * not `ToolbarMenu` — that furniture is deliberately quiet, and its chevron
 * never flips. Only the trigger differs: the panel below it is the same
 * `MenuItem` / `MenuSeparator` rows every other editor menu uses, so the two
 * cannot drift.
 *
 * Picking the mode already in use is a no-op rather than a disabled row. The
 * spec calls the active entry inert, and a row that cannot be focused reads as
 * missing to a screen reader, where a focusable row that announces itself
 * checked says exactly what an author needs to hear.
 */

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { buttonClasses } from "@/components/ui/button";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  EyeIcon,
  HelpIcon,
  KeyboardIcon,
  SourceIcon,
} from "@/components/wiki/editor-icons";
import { MenuItem, MenuSeparator } from "@/components/wiki/editor-menu";
import type { EditorMode } from "@/lib/visual-editor/actions";

export interface EditorModeMenuLabels {
  /** Accessible name of the panel — the pill's own name is the mode face. */
  menuLabel: string;
  /** Pill face while the visual surface is active. */
  visualPill: string;
  /** Pill face while the source surface is active. */
  sourcePill: string;
  visual: string;
  source: string;
  userGuide: string;
  shortcuts: string;
}

export interface EditorModeMenuProps {
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
  onUserGuide: () => void;
  onShortcuts: () => void;
  disabled?: boolean;
  labels: EditorModeMenuLabels;
}

/** Every focusable row of the panel, in DOM order. */
function rowsOf(panel: HTMLElement): HTMLElement[] {
  const selector = '[role="menuitem"],[role="menuitemradio"]';
  return Array.from(panel.querySelectorAll<HTMLElement>(selector));
}

function focusRowAt(panel: HTMLElement | null, index: number): void {
  if (panel === null) return;
  const rows = rowsOf(panel);
  if (rows.length === 0) return;
  // Wrap, so ArrowDown off the last row returns to the first, as menus do.
  const target = rows[((index % rows.length) + rows.length) % rows.length];
  if (target !== undefined) target.focus();
}

export function EditorModeMenu({
  mode,
  onModeChange,
  onUserGuide,
  onShortcuts,
  disabled,
  labels,
}: EditorModeMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** Set by the keyboard openers, consumed once the panel has mounted. */
  const focusFirstRef = useRef(false);
  const panelId = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) {
      focusFirstRef.current = false;
      return;
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      // Escape returns the caret to the pill; an outside click does not, since
      // the pointer has already chosen where focus should go.
      if (event.key === "Escape") close(true);
    };
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
        close(false);
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
    focusRowAt(panelRef.current, 0);
  }, [open]);

  const onTriggerKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Enter" && event.key !== " " && event.key !== "ArrowDown") return;
    event.preventDefault();
    if (open) focusRowAt(panelRef.current, 0);
    else {
      focusFirstRef.current = true;
      setOpen(true);
    }
  }, [open]);

  const onPanelKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (panel === null) return;
    const rows = rowsOf(panel);
    const current = rows.findIndex((row) => row === document.activeElement);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusRowAt(panel, current + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusRowAt(panel, current <= 0 ? rows.length - 1 : current - 1);
        break;
      case "Home":
        event.preventDefault();
        focusRowAt(panel, 0);
        break;
      case "End":
        event.preventDefault();
        focusRowAt(panel, rows.length - 1);
        break;
      default:
        break;
    }
  }, []);

  const choose = useCallback(
    (next: EditorMode) => {
      close(true);
      if (next !== mode) onModeChange(next);
    },
    [close, mode, onModeChange],
  );

  const run = useCallback(
    (action: () => void) => {
      close(false);
      action();
    },
    [close],
  );

  const visual = mode === "visual";

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={onTriggerKeyDown}
        className={buttonClasses(
          "primary",
          "sm",
          "h-9 gap-2 px-3 font-mono text-[11px] uppercase tracking-[0.08em]",
        )}
      >
        {visual ? <EyeIcon className="size-3.5" /> : <SourceIcon className="size-3.5" />}
        <span className="truncate">{visual ? labels.visualPill : labels.sourcePill}</span>
        {open ? <ChevronUpIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />}
      </button>

      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="menu"
          aria-label={labels.menuLabel}
          onKeyDown={onPanelKeyDown}
          className="absolute right-0 top-full z-30 mt-1 min-w-52 rounded-[var(--radius-md)] border border-hairline bg-surface p-1 shadow-[var(--shadow-md)]"
        >
          <MenuItem
            label={labels.visual}
            icon={<EyeIcon />}
            selected={visual}
            onSelect={() => choose("visual")}
          />
          <MenuItem
            label={labels.source}
            icon={<SourceIcon />}
            selected={!visual}
            onSelect={() => choose("source")}
          />
          <MenuSeparator />
          <MenuItem
            label={labels.userGuide}
            icon={<HelpIcon />}
            onSelect={() => run(onUserGuide)}
          />
          <MenuItem
            label={labels.shortcuts}
            icon={<KeyboardIcon />}
            onSelect={() => run(onShortcuts)}
          />
        </div>
      ) : null}
    </div>
  );
}
