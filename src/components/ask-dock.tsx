"use client";

/**
 * Ask dock: the header toggle plus a right-docked chat panel (VS Code-style
 * side panel) hosting the wiki Q&A agent. Lives in the site shell so it is
 * available on every page; the panel stays MOUNTED while closed, so the
 * conversation (and its WebSocket) survives closing, reopening, and
 * client-side navigation.
 *
 * The aside is PORTALED to document.body — rendered inline it would sit
 * inside the sticky header's z-40 stacking context, where its own z-index is
 * meaningless against root-level overlays. While open it also publishes its
 * width as --ask-dock-w on <html>, which the site shell reads to push the
 * content area aside (≥sm) instead of covering it, and locks body scroll at
 * the full-width (<sm) breakpoint.
 */

import { ChatCircleText, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { AskView, type AskViewLabels } from "@/components/ask-view";
import { cn } from "@/lib/utils";

/** Panel width ≥sm; must match the sm:w-[400px] class on the aside. */
const DOCK_WIDTH = "400px";
/** Tailwind's sm breakpoint, below which the panel is a full-width sheet. */
const SHEET_QUERY = "(max-width: 639px)";

export interface AskDockLabels {
  /** Header button text (ask.toggle). */
  toggle: string;
  /** Panel heading (ask.title). */
  title: string;
  /** Close button accessible name (common.close). */
  close: string;
  view: AskViewLabels;
}

export interface AskDockProps {
  locale: string;
  labels: AskDockLabels;
}

const emptySubscribe = () => () => {};

export function AskDock({ locale, labels }: AskDockProps) {
  const [open, setOpen] = useState(false);
  // Hydration-safe mounted guard (theme-toggle.tsx pattern): portals need a
  // DOM, so the panel renders only after hydration.
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
  const toggleRef = useRef<HTMLButtonElement | null>(null);

  // Publish the dock width for the shell's content push, and lock body
  // scroll while the panel is a full-width sheet (<sm) — touch scrolling
  // would otherwise chain to the page behind it.
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    root.style.setProperty("--ask-dock-w", DOCK_WIDTH);
    const sheet = window.matchMedia(SHEET_QUERY);
    const applyLock = () => {
      document.body.style.overflow = sheet.matches ? "hidden" : "";
    };
    applyLock();
    sheet.addEventListener("change", applyLock);
    return () => {
      sheet.removeEventListener("change", applyLock);
      document.body.style.overflow = "";
      root.style.removeProperty("--ask-dock-w");
    };
  }, [open]);

  /** Close and hand focus back to the toggle — the panel subtree is about to
   *  go display:none, which would otherwise strand focus on <body>. */
  const close = () => {
    setOpen(false);
    toggleRef.current?.focus();
  };

  const panel = (
    <aside
      id="ask-panel"
      aria-label={labels.title}
      onKeyDown={(e) => {
        // Escape closes the dock — but only an Escape that happened INSIDE
        // it (this is not a document listener), was not consumed by an inner
        // layer, and is not an IME composition cancel.
        if (
          e.key === "Escape" &&
          !e.defaultPrevented &&
          !e.nativeEvent.isComposing &&
          e.keyCode !== 229
        ) {
          close();
        }
      }}
      className={cn(
        // Root-level z-30: above page content, below header popovers and the
        // fullscreen editor (z-40) and dialogs/image viewer (z-50).
        "fixed bottom-0 right-0 top-16 z-30 w-full flex-col border-l border-hairline bg-canvas shadow-[var(--shadow-md)] sm:w-[400px]",
        open ? "flex" : "hidden",
      )}
    >
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-hairline pl-3 pr-2">
        <h2 className="text-sm font-semibold tracking-tight text-ink">{labels.title}</h2>
        <button
          type="button"
          onClick={close}
          aria-label={labels.close}
          className="focus-ring inline-flex size-7 items-center justify-center rounded-[var(--radius-sm)] text-mute transition-colors hover:bg-canvas-soft hover:text-ink"
        >
          <X size={16} weight="regular" aria-hidden />
        </button>
      </header>
      <AskView locale={locale} labels={labels.view} open={open} />
    </aside>
  );

  return (
    <>
      <button
        ref={toggleRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="ask-panel"
        aria-label={labels.toggle}
        className={cn(
          "focus-ring inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-sm)] border border-hairline px-2.5 text-[13px] font-medium transition-colors",
          open ? "bg-canvas-soft text-ink" : "text-mute hover:bg-canvas-soft hover:text-ink",
        )}
      >
        <ChatCircleText size={16} weight="regular" aria-hidden />
        <span className="hidden sm:inline">{labels.toggle}</span>
      </button>

      {/* Kept mounted while closed (display class swap) so chat state and the
          WebSocket persist across close/reopen. */}
      {mounted ? createPortal(panel, document.body) : null}
    </>
  );
}
