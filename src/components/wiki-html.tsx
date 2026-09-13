import { TocToggle } from "@/components/toc-toggle";
import { ImageZoom, type ImageZoomLabels } from "@/components/wiki/image-zoom";
import { SortableTables } from "@/components/wiki/sortable-table";

/**
 * Renders engine-produced (already sanitized) article HTML inside the
 * `.wiki-prose` article surface. Server component; the only client code is
 * three tiny islands — TocToggle, which enhances the TOC with a [hide] toggle,
 * SortableTables, which makes `table.sortable` headers clickable
 * (Fandom ext §F.2.4), and ImageZoom, which opens a clicked image full size
 * rather than following its `File:` link into the create view.
 *
 * Order matters: TocToggle locates its host through `previousElementSibling`,
 * so it must stay immediately after the `.wiki-prose` div.
 */
export function WikiHtml({ html, labels }: { html: string; labels: ImageZoomLabels }) {
  return (
    <>
      <div className="wiki-prose" dangerouslySetInnerHTML={{ __html: html }} />
      <TocToggle />
      <SortableTables />
      <ImageZoom labels={labels} />
    </>
  );
}
