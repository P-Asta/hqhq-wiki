"use client";

/**
 * Click an article image and it opens here, full size, instead of navigating.
 *
 * The engine renders every image the way MediaWiki does — `<a class="mw-file">`
 * around the `<img>`, pointing at the `File:` description page (render.ts
 * `wrapImageLink`). On this wiki almost no `File:` page has been written, so
 * that href is a red link, and a red link is the *create* view: clicking a
 * photo in an article dropped the reader into an editor for a page they never
 * asked to write. Readers click a picture to see the picture.
 *
 * So this is an island in the `WikiHtml` shape — a hidden marker whose
 * `parentElement` scopes the query, exactly as `SortableTables` does — and NOT
 * a change to the engine. The markup stays MediaWiki's, `meta.linksTo` still
 * records the file page, and the description page is still one click away from
 * inside the viewer. Only the reader's *first* click is re-aimed.
 *
 * What is deliberately NOT intercepted:
 *
 * - a modified click (Ctrl/Cmd/Shift/Alt) or anything but the primary button —
 *   "open in a new tab" is the reader's, and stealing it would be worse than
 *   the behavior this replaces;
 * - `a.external`, which is an author writing `[[File:x|link=https://…]]`: they
 *   named a destination, and it is not ours to override;
 * - a link with no `<img>` in it — a red link for a *missing* file renders as
 *   text (§5.9), and that one really should go to the create view.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { bindDialogKeys, dialogKeyAction, openDialogFocusTrap } from "@/components/ui/dialog";

export interface ImageZoomLabels {
  /** Accessible name of the viewer overlay. */
  viewer: string;
  /** Close button (common.close). */
  close: string;
  /** Link out to the `File:` description page the image used to navigate to. */
  filePage: string;
}

/** What the overlay is showing; null while it is closed. */
export interface ZoomTarget {
  src: string;
  alt: string;
  /** The `File:` page href the anchor carried, or null when it had none. */
  href: string | null;
  /** The thumb's caption, when it sits in a `<figure>`. */
  caption: string;
}

/**
 * Enough of a `MouseEvent` to decide, without a DOM: the button and the four
 * modifiers browsers use for "open this somewhere else".
 */
export interface ClickIntent {
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}

/**
 * Is this the plain left-click the viewer may claim?
 *
 * Split out so the rule is readable and testable on its own — it is the whole
 * difference between an enhancement and a hijacked browser.
 */
export function isPlainLeftClick(event: ClickIntent): boolean {
  if (event.defaultPrevented) return false;
  if (event.button !== 0) return false;
  return !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
}

/**
 * As much of an element as reading a zoom target needs.
 *
 * Structural rather than `HTMLAnchorElement` for the reason `ui/dialog.tsx`
 * declares `DialogFocusable`/`DialogKeyHost`: vitest runs this project under
 * **node**, where there is no DOM at all, and a rule this easy to break
 * silently (a Ctrl-click that stops opening a new tab) has to stay assertable.
 * A real anchor satisfies it, so the call site passes one unchanged.
 */
export interface ZoomNode {
  getAttribute: (name: string) => string | null;
  textContent: string | null;
}

export interface ZoomAnchor extends ZoomNode {
  classList: { contains: (token: string) => boolean };
  querySelector: (selectors: string) => ZoomNode | null;
  closest: (selectors: string) => { querySelector: (selectors: string) => ZoomNode | null } | null;
}

/**
 * The image an anchor is wrapping, or null when this anchor is not one the
 * viewer handles.
 *
 * `src` comes off the `<img>` rather than the href: `file.src` is
 * `/api/media/<canonical>` — the file itself, at natural size — and the
 * `width`/`height` in the markup are only presentational hints (render.ts
 * `sizeAttrs`), so the same URL is already the full-resolution image.
 */
export function zoomTargetOf(anchor: ZoomAnchor): ZoomTarget | null {
  if (!anchor.classList.contains("mw-file")) return null;
  const img = anchor.querySelector("img");
  if (img === null) return null;
  const src = img.getAttribute("src");
  if (src === null || src === "") return null;
  const figure = anchor.closest("figure.mw-thumb");
  const figcaption = figure?.querySelector("figcaption");
  return {
    src,
    alt: img.getAttribute("alt") ?? "",
    href: anchor.getAttribute("href"),
    caption: figcaption?.textContent?.trim() ?? "",
  };
}

/**
 * Mounts once from `WikiHtml`. One delegated listener on the container rather
 * than one per image: the article HTML is written by
 * `dangerouslySetInnerHTML`, so there is no React tree here to hang props on,
 * and a gallery of thirty thumbs would otherwise be thirty listeners.
 */
export function ImageZoom({ labels }: { labels: ImageZoomLabels }) {
  const markerRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [target, setTarget] = useState<ZoomTarget | null>(null);

  const close = useCallback(() => setTarget(null), []);

  useEffect(() => {
    const scope = markerRef.current?.parentElement;
    if (!scope) return;
    const prose = scope.querySelector<HTMLElement>(".wiki-prose");
    if (prose === null) return;

    const onClick = (event: MouseEvent) => {
      if (!isPlainLeftClick(event)) return;
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest("a");
      if (anchor === null || !prose.contains(anchor)) return;
      const found = zoomTargetOf(anchor);
      if (found === null) return;
      // Claimed: the href is not followed, and the anchor keeps it for the
      // "open in a new tab" the modifier keys above still deliver.
      event.preventDefault();
      setTarget(found);
    };

    prose.addEventListener("click", onClick);
    return () => prose.removeEventListener("click", onClick);
  }, []);

  const open = target !== null;

  // The same focus contract every other modal on this wiki makes (ui/dialog):
  // the panel takes focus, the page behind it stops scrolling, and the image
  // the reader clicked gets focus back when the viewer closes.
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    const opener = active instanceof HTMLElement ? active : null;
    return openDialogFocusTrap(opener, panelRef.current, document.body);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    return bindDialogKeys(document, (event) => {
      if (dialogKeyAction(event) === "close") close();
    });
  }, [open, close]);

  return (
    <>
      <span hidden ref={markerRef} />
      {target === null ? null : (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center p-4 sm:p-8">
          {/*
            The scrim is the close affordance readers reach for first, so it is
            a real click target rather than decoration. `aria-hidden` because
            the button below is the one a screen reader should be offered.
          */}
          <div className="absolute inset-0 bg-backdrop" aria-hidden onClick={close} />
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={labels.viewer}
            tabIndex={-1}
            className="relative flex max-h-full min-h-0 w-full max-w-5xl flex-col items-center gap-3 outline-none"
          >
            {/*
              `min-h-0` above and `object-contain` here are what keep a tall
              image inside the viewport instead of pushing the caption off the
              bottom of it. The click is swallowed so that hitting the picture
              itself does not read as hitting the scrim behind it.
            */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={target.src}
              alt={target.alt}
              onClick={(event) => event.stopPropagation()}
              className="min-h-0 max-w-full flex-1 rounded-[var(--radius-md)] object-contain shadow-[var(--shadow-md)]"
            />

            <div className="flex w-full shrink-0 flex-wrap items-center justify-center gap-x-4 gap-y-1 text-center">
              {target.caption === "" ? null : (
                <p className="max-w-2xl text-sm text-ink">{target.caption}</p>
              )}
              {target.href === null ? null : (
                <a
                  href={target.href}
                  className="focus-ring rounded-[var(--radius-sm)] text-sm text-link underline underline-offset-2"
                >
                  {labels.filePage}
                </a>
              )}
            </div>

            <button
              type="button"
              onClick={close}
              aria-label={labels.close}
              className="focus-ring absolute -top-1 right-0 inline-flex size-8 items-center justify-center rounded-[var(--radius-sm)] bg-surface text-mute shadow-[var(--shadow-sm)] transition-colors hover:bg-canvas-soft hover:text-ink sm:-top-10"
            >
              <svg
                aria-hidden
                viewBox="0 0 16 16"
                className="size-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              >
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </>
  );
}
