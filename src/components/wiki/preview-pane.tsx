"use client";

/**
 * Live preview pane for the editor (routes.md /edit). Purely presentational —
 * the editor owns fetching, debouncing and which version is being rendered.
 *
 * It used to carry a registry `<select>` of its own. versioning.md §6 moved
 * that control to `EditorVersionBar`, above the editing surface: the pane only
 * exists in source mode, so a version picker living here was unreachable in the
 * default (visual) mode, and once the author has the branch chips *and* a
 * registry dropdown up there, a second dropdown down here is the two-controls-
 * for-one-job confusion §6 was rewritten to remove. The bar's dropdown still
 * lists the whole registry, so nothing this pane offered has been lost.
 */

import { WikiHtml } from "@/components/wiki-html";
import type { ImageZoomLabels } from "@/components/wiki/image-zoom";
import { cn } from "@/lib/utils";
import { StatusBanner } from "@/components/ui/status-banner";

export interface PreviewPaneLabels {
  heading: string;
  empty: string;
  failed: string;
  loading: string;
  warningsTitle: string;
  /**
   * The image viewer's own strings. The preview renders through `WikiHtml`
   * like the article does, so a click on a picture must open it here too —
   * following the `File:` link would navigate the author out of the editor
   * with unsaved wikitext in it.
   */
  imageViewer: ImageZoomLabels;
}

export interface PreviewPaneProps {
  /** Extra classes for the rendered-HTML surface (height, scrolling). */
  surfaceClassName?: string;
  html: string | null;
  warnings: string[];
  loading: boolean;
  error: boolean;
  labels: PreviewPaneLabels;
}

export function PreviewPane({
  surfaceClassName,
  html,
  warnings,
  loading,
  error,
  labels,
}: PreviewPaneProps) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-tight text-ink">
          {labels.heading}
          {loading ? <span className="ml-2 font-normal text-faint">{labels.loading}</span> : null}
        </h2>
      </div>

      {error ? <StatusBanner tone="error">{labels.failed}</StatusBanner> : null}

      {warnings.length > 0 ? (
        <StatusBanner tone="warning" title={labels.warningsTitle}>
          <ul className="mt-1 list-disc pl-4">
            {warnings.map((warning, i) => (
              <li key={i} className="font-mono text-xs">
                {warning}
              </li>
            ))}
          </ul>
        </StatusBanner>
      ) : null}

      <div className={cn("min-h-48 rounded-[var(--radius-md)] border border-hairline bg-canvas p-4", surfaceClassName)}>
        {html !== null && html !== "" ? (
          <WikiHtml html={html} labels={labels.imageViewer} />
        ) : (
          <p className="text-sm text-faint">{labels.empty}</p>
        )}
      </div>
    </section>
  );
}
