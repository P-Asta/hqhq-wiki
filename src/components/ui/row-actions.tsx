"use client";

/**
 * Row overflow menu — the "⋯" button that collapses a table row's actions.
 *
 * A row with three buttons spends more width on verbs than on data; this puts
 * them one click away and lets the columns breathe. Unlike the editor's
 * `ToolbarMenu` (src/components/wiki/editor-menu.tsx) this owns its open state,
 * because a table has one menu per row and no toolbar to arbitrate between
 * them — only one can be open anyway, since opening a second closes the first
 * through the outside-pointerdown listener.
 *
 * Dependency-free, same as the editor menus: Escape, outside pointer-down, and
 * a roving arrow-key loop over the panel's `menuitem`s.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

/**
 * Broadcast that a menu is opening, so every other one closes. The pointer
 * path gets this for free from the outside-pointerdown listener; the keyboard
 * path has no such event, and two menus open at once is the one state this
 * component promises cannot happen.
 */
const CLOSE_OTHERS = "hqhq:row-actions-open";

/** Every enabled row of a panel, in DOM order. */
function menuItemsOf(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>('[role="menuitem"]')).filter(
    (item) => !item.hasAttribute("disabled"),
  );
}

function focusItemAt(panel: HTMLElement | null, index: number): void {
  if (panel === null) return;
  const items = menuItemsOf(panel);
  if (items.length === 0) return;
  // Wrap, so ArrowDown off the last row returns to the first, as menus do.
  items[((index % items.length) + items.length) % items.length]?.focus();
}

export interface RowActionsProps {
  /** Accessible name of the trigger — name the row, e.g. "Actions for v64". */
  label: string;
  disabled?: boolean;
  /** `RowAction` / `RowActionSeparator` children. */
  children: ReactNode;
  className?: string;
}

export function RowActions({ label, disabled, children, className }: RowActionsProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  /** Set by the keyboard openers, consumed once the panel has mounted. */
  const focusFirstRef = useRef(false);
  const panelId = useId();

  /**
   * Closing by keyboard hands focus back to the trigger; closing by pointer
   * does not, because the pointer already put focus wherever it clicked.
   */
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
      if (event.key !== "Escape") return;
      const root = rootRef.current;
      const inside =
        root !== null &&
        document.activeElement instanceof Node &&
        root.contains(document.activeElement);
      close(inside);
    };
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
        setOpen(false);
      }
    };
    const onOther = () => setOpen(false);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener(CLOSE_OTHERS, onOther);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener(CLOSE_OTHERS, onOther);
    };
  }, [open, close]);

  useEffect(() => {
    if (!open || !focusFirstRef.current) return;
    focusFirstRef.current = false;
    focusItemAt(panelRef.current, 0);
  }, [open]);

  /** Enter/Space/ArrowDown open the menu *and* land on its first row. */
  const onTriggerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "Enter" && event.key !== " " && event.key !== "ArrowDown") return;
      event.preventDefault();
      if (open) focusItemAt(panelRef.current, 0);
      else {
        // Opening one row's menu closes any other, matching what an outside
        // pointer-down already does for the mouse — only one is ever open.
        document.dispatchEvent(new CustomEvent(CLOSE_OTHERS));
        focusFirstRef.current = true;
        setOpen(true);
      }
    },
    [open],
  );

  const onPanelKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
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

  return (
    <div ref={rootRef} className={cn("relative inline-block", className)}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          "focus-ring inline-flex size-8 items-center justify-center rounded-[var(--radius-sm)] border border-hairline text-mute transition-colors hover:bg-canvas-soft hover:text-ink disabled:pointer-events-none disabled:opacity-50",
          open && "bg-canvas-soft text-ink",
        )}
      >
        <span aria-hidden className="text-base leading-none">
          ⋯
        </span>
      </button>
      {open ? (
        // Closes on any activation inside, so each RowAction need not do it.
        // Focus goes back to the trigger whenever the activation came from the
        // keyboard (detail === 0 on a click synthesized by Enter/Space);
        // a mouse click has already put focus where the pointer was.
        <div
          ref={panelRef}
          id={panelId}
          role="menu"
          aria-label={label}
          onKeyDown={onPanelKeyDown}
          onClick={(event) => close(event.detail === 0)}
          className="absolute right-0 top-full z-30 mt-1 min-w-44 rounded-[var(--radius-md)] border border-hairline bg-surface p-1 text-left shadow-[var(--shadow-md)]"
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

export interface RowActionProps {
  label: string;
  onSelect: () => void;
  /** Destructive verbs read in the error color, as their buttons did. */
  danger?: boolean;
  disabled?: boolean;
}

export function RowAction({ label, onSelect, danger, disabled }: RowActionProps) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "focus-ring flex w-full items-center rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-canvas-soft disabled:pointer-events-none disabled:opacity-50",
        danger ? "text-error hover:text-error" : "text-body hover:text-ink",
      )}
    >
      {label}
    </button>
  );
}

/** A rule between two runs of actions — presentational, so it takes no focus. */
export function RowActionSeparator() {
  return <div role="separator" className="my-1 h-px bg-hairline" />;
}
