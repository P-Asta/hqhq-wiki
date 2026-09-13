/**
 * Article title row — the display title (a sanitized `{{DISPLAYTITLE:}}`
 * override when one exists, engine-emitted HTML) with the secondary
 * Edit / History actions on the right (routes.md `/wiki/[...title]`).
 */

import { ButtonLink } from "@/components/ui/button";
import type { ArticleViewLabels } from "@/lib/wiki/read-view";

export interface ArticleHeaderProps {
  /** Plain-text title (`page_locales.title`). */
  title: string;
  /** Sanitized `{{DISPLAYTITLE:}}` HTML, or null (cache hit / no override). */
  displayTitleHtml: string | null;
  editHref: string;
  historyHref: string;
  labels: ArticleViewLabels;
}

export function ArticleHeader({
  title,
  displayTitleHtml,
  editHref,
  historyHref,
  labels,
}: ArticleHeaderProps) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-hairline pb-3">
      {displayTitleHtml ? (
        <h1
          className="text-3xl font-semibold tracking-[-0.04em] text-ink"
          // Engine output: already sanitized by stage 3 (§13.1).
          dangerouslySetInnerHTML={{ __html: displayTitleHtml }}
        />
      ) : (
        <h1 className="text-3xl font-semibold tracking-[-0.04em] text-ink">{title}</h1>
      )}
      <div className="flex shrink-0 gap-2">
        <ButtonLink href={editHref} variant="secondary" size="sm">
          {labels.edit}
        </ButtonLink>
        <ButtonLink href={historyHref} variant="secondary" size="sm">
          {labels.history}
        </ButtonLink>
      </div>
    </header>
  );
}
