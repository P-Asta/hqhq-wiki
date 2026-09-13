"use client";

/**
 * Modal dialog: `--backdrop` scrim, surface panel on hairline, radius-lg,
 * shadow-md. Escape and scrim-click close; body scroll locks while open.
 * `closeLabel` comes from the dictionary (common.close).
 *
 * `aria-modal="true"` is a promise to a screen reader that the rest of the page
 * is unreachable, so this component keeps it: Tab cycles inside the panel, the
 * panel takes focus when nothing in it claimed it, and the element that opened
 * the dialog gets focus back when it closes. Without that last part the panel
 * unmounts with focus inside it and the caret lands on `<body>` — which, from
 * the editor, means losing your place in the article you were writing.
 */

import { useEffect, useRef, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name + header text. */
  title: string;
  /** Dictionary string for the close button (common.close). */
  closeLabel: string;
  children?: ReactNode;
  className?: string;
}

/** Everything inside the panel a Tab can land on, in document order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** What the dialog does with a key it sees while it is open. */
export type DialogKeyAction = "ignore" | "close" | "trap";

/**
 * Next.js's App Router mounts React on the document itself, so React's
 * delegated keydown listener and this dialog's own listener sit on the *same*
 * node — and `stopPropagation()` only stops an event moving to the *next*
 * node, never the listeners already registered on the current one. A popper
 * inside the panel (TokenPicker's list eats Escape to close itself) therefore
 * cannot keep Escape away from us by stopping propagation; what it can do is
 * `preventDefault()`. So a key that already carries `defaultPrevented` is one
 * a descendant has answered, and the dialog leaves it alone — otherwise
 * dismissing a combobox list would also discard the form around it.
 */
export function dialogKeyAction(
  event: Pick<KeyboardEvent, "key" | "defaultPrevented">,
): DialogKeyAction {
  if (event.defaultPrevented) return "ignore";
  if (event.key === "Escape") return "close";
  if (event.key === "Tab") return "trap";
  return "ignore";
}

/** Anything the trap moves focus to: `document.activeElement` and the panel. */
export interface DialogFocusable {
  focus: () => void;
}

/** Enough of `document.body` to lock and restore the page's scrollbar. */
export interface DialogScrollLock {
  style: { overflow: string };
}

/**
 * Give `claim` focus (null when a field with `autoFocus` already took it) and
 * lock the page scroll; the teardown restores both, `opener` last.
 *
 * It lives apart from the key listener because the two have different
 * lifetimes: callers pass an inline arrow for `onClose`, so the handler's
 * identity changes on every render of the editor island, and rebinding a
 * listener must never be able to pull the caret out of the field the author is
 * typing in. Only opening and closing may move focus.
 */
export function openDialogFocusTrap(
  opener: DialogFocusable | null,
  claim: DialogFocusable | null,
  body: DialogScrollLock,
): () => void {
  claim?.focus();
  const previousOverflow = body.style.overflow;
  body.style.overflow = "hidden";
  return () => {
    body.style.overflow = previousOverflow;
    opener?.focus();
  };
}

/** The document, as far as the dialog's key trap is concerned. */
export interface DialogKeyHost {
  addEventListener: (type: "keydown", handler: (event: KeyboardEvent) => void) => void;
  removeEventListener: (type: "keydown", handler: (event: KeyboardEvent) => void) => void;
}

/** Listen for the dialog's keys; the teardown removes the listener and nothing else. */
export function bindDialogKeys(
  host: DialogKeyHost,
  handler: (event: KeyboardEvent) => void,
): () => void {
  host.addEventListener("keydown", handler);
  return () => {
    host.removeEventListener("keydown", handler);
  };
}

export function Dialog({ open, onClose, title, closeLabel, children, className }: DialogProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Read through a ref so the key effect depends on `open` alone; see
  // openDialogFocusTrap for why a re-run must not reach the focus trap.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    const opener = active instanceof HTMLElement ? active : null;
    // A field with `autoFocus` has already claimed focus by the time effects
    // run; only when nothing did does the panel take it, so Escape and Tab
    // start from inside the dialog rather than from wherever the page was.
    const panel = panelRef.current;
    const claim = panel !== null && !panel.contains(active) ? panel : null;
    return openDialogFocusTrap(opener, claim, document.body);
  }, [open]);

  useEffect(() => {
    if (!open) return;

    // `getClientRects` rather than `offsetParent`, which is null for anything
    // positioned fixed — the panel's own container is.
    const focusable = (): HTMLElement[] => {
      const panel = panelRef.current;
      if (panel === null) return [];
      return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.getClientRects().length > 0,
      );
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const action = dialogKeyAction(event);
      if (action === "ignore") return;
      if (action === "close") {
        closeRef.current();
        return;
      }
      const items = focusable();
      const host = panelRef.current;
      if (items.length === 0 || host === null) return;
      const active = document.activeElement;
      if (!(active instanceof Node) || !host.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? items[items.length - 1] : items[0]).focus();
        return;
      }
      if (!event.shiftKey && active === items[items.length - 1]) {
        event.preventDefault();
        items[0].focus();
      } else if (event.shiftKey && active === items[0]) {
        event.preventDefault();
        items[items.length - 1].focus();
      }
    };

    return bindDialogKeys(document, onKeyDown);
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-backdrop" aria-hidden onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          "relative w-full max-w-md rounded-[var(--radius-lg)] border border-hairline bg-surface p-6 shadow-[var(--shadow-md)]",
          className,
        )}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-base font-semibold tracking-tight text-ink">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="focus-ring -m-1 inline-flex size-7 items-center justify-center rounded-[var(--radius-sm)] text-mute transition-colors hover:bg-canvas-soft hover:text-ink"
          >
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              className="size-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <path d="M3.5 3.5l9 9m0-9l-9 9" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
