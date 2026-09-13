"use client";

/**
 * Shared toolbar chrome for both editor toolbars — visual-editor.md §1
 * ("Toolbars"), drawn in the token system of theme.md.
 *
 * The visual and source toolbars differ only in which commands they carry:
 * their bar, groups, dividers, buttons and dropdowns are the same furniture.
 * That furniture used to be private to the source toolbar; it lives here so
 * the two modes cannot drift apart visually or in keyboard behaviour.
 *
 * `ToolbarMenu` stays dependency-free (no popover library) because the panels
 * are small and same-origin: an Escape listener, an outside pointer-down and a
 * roving arrow-key loop over the panel's `menuitem`s cover Fandom's behaviour.
 * Focus is moved imperatively rather than tracked in state — the DOM already
 * knows which row is focused, and mirroring it would only add a second source
 * of truth.
 *
 * Nothing here holds open/closed state: the owning toolbar does, so it can
 * enforce "only one menu open at a time" across every dropdown in the row.
 */

import { useCallback, useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* The bar                                                             */
/* ------------------------------------------------------------------ */

/**
 * The full-width bar under the edit header: a hairline well on
 * `--canvas-soft`, wrapping so a narrow viewport stacks the groups rather
 * than clipping them.
 */
export function ToolbarRow({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="toolbar"
      aria-orientation="horizontal"
      aria-label={label}
      className={cn(
        "flex flex-wrap items-center gap-1 rounded-[var(--radius-md)] border border-hairline bg-canvas-soft px-1.5 py-1",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** One Fandom toolbar group — buttons inside sit tighter than the groups do. */
export function ToolbarGroup({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-0.5">{children}</div>;
}

/** The hairline rule between two groups. */
export function ToolbarDivider() {
  return <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-hairline" />;
}

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

export function ToolButton({
  label,
  onClick,
  disabled,
  active,
  children,
  className,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** A sticky state (the mark under the caret), not a momentary press. */
  active?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      onClick={onClick}
      className={cn(
        "h-9 min-w-9 px-2 font-mono text-[13px]",
        active === true && "bg-canvas-soft-2 text-ink",
        className,
      )}
    >
      {children}
    </Button>
  );
}

/* ------------------------------------------------------------------ */
/* Dropdown menus                                                      */
/* ------------------------------------------------------------------ */

/** Every enabled row of a panel, in DOM order. */
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

export function ToolbarMenu({
  label,
  trigger,
  open,
  onOpenChange,
  disabled,
  align = "start",
  triggerClassName,
  panelClassName,
  children,
}: {
  label: string;
  /** Rendered inside the trigger; the accessible name is `label`. */
  trigger: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  /** Which edge the panel hangs from — `"end"` for triggers near the right edge. */
  align?: "start" | "end";
  /**
   * Extra classes for the trigger. The menus in a toolbar want none of these;
   * it exists for the one that is not in a toolbar — the version strip's `+`,
   * which is chip-shaped because it stands in a row of chips (versioning.md
   * §6) and would otherwise have to be a second popover to keep that shape.
   */
  triggerClassName?: string;
  /** Extra classes for the floating panel (width, grid…). */
  panelClassName?: string;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  /** Set by the keyboard openers, consumed once the panel has mounted. */
  const focusFirstRef = useRef(false);
  const panelId = useId();

  /**
   * Closing by keyboard hands focus back to the trigger; closing by pointer
   * does not, because the pointer has already put focus wherever it clicked.
   * Without the first half, Escape unmounts the panel with focus inside it and
   * the next Tab restarts from the top of the page.
   */
  const close = useCallback(
    (restoreFocus: boolean) => {
      onOpenChange(false);
      if (restoreFocus) triggerRef.current?.focus();
    },
    [onOpenChange],
  );

  useEffect(() => {
    if (!open) {
      focusFirstRef.current = false;
      return;
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const root = rootRef.current;
      // Only reclaim focus when it was ours to begin with: Escape pressed while
      // focus sits elsewhere should not yank the caret into the toolbar.
      const inside =
        root !== null && document.activeElement instanceof Node && root.contains(document.activeElement);
      close(inside);
    };
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
        onOpenChange(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, onOpenChange, close]);

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
        focusFirstRef.current = true;
        onOpenChange(true);
      }
    },
    [open, onOpenChange],
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
    <div ref={rootRef} className="relative">
      <Button
        ref={triggerRef}
        variant="ghost"
        size="sm"
        disabled={disabled}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => onOpenChange(!open)}
        onKeyDown={onTriggerKeyDown}
        className={cn("h-9 gap-1 px-2 text-[13px]", triggerClassName)}
      >
        {trigger}
        <span aria-hidden className="text-[9px] leading-none">
          ▾
        </span>
      </Button>
      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="menu"
          aria-label={label}
          onKeyDown={onPanelKeyDown}
          className={cn(
            "absolute top-full z-30 mt-1 min-w-44 rounded-[var(--radius-md)] border border-hairline bg-surface p-1 shadow-[var(--shadow-md)]",
            align === "end" ? "right-0" : "left-0",
            panelClassName,
          )}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem({
  label,
  onSelect,
  icon,
  hint,
  selected,
  disabled,
}: {
  label: string;
  onSelect: () => void;
  /** Leading slot with a fixed width, so labels align down the panel. */
  icon?: ReactNode;
  /** Right-aligned muted hint — a keyboard shortcut, usually. */
  hint?: string;
  /** Present only in one-of-many menus (the mode pill, the block-type menu). */
  selected?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role={selected === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={selected === undefined ? undefined : selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "focus-ring flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[13px] text-body transition-colors hover:bg-canvas-soft hover:text-ink disabled:pointer-events-none disabled:opacity-50",
        selected === true && "bg-canvas-soft text-ink",
      )}
    >
      {icon !== undefined ? (
        <span aria-hidden className="w-7 shrink-0 text-center font-mono text-mute">
          {icon}
        </span>
      ) : null}
      <span className="flex-1 truncate">{label}</span>
      {hint !== undefined ? (
        <span aria-hidden className="shrink-0 font-mono text-[11px] text-faint">
          {hint}
        </span>
      ) : null}
      {selected === undefined ? null : (
        // The mark keeps its box when unselected, so rows never shift width.
        <span aria-hidden className="w-3 shrink-0 text-center text-ink">
          {selected ? "✓" : ""}
        </span>
      )}
    </button>
  );
}

/** A rule between two runs of items — presentational, so it takes no focus. */
export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-hairline" />;
}
