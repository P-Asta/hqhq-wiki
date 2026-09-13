/**
 * Article footer — the `[[Category:…]]` membership chips and the last-edited
 * line (routes.md `/wiki/[...title]`), separated from the article surface by
 * a top hairline. Category chips are mono per theme.md (technical labels).
 */

import Link from "next/link";

import type { Locale } from "@/lib/i18n";
import {
  formatDateTime,
  type ArticleViewLabels,
  type PageRefView,
} from "@/lib/wiki/read-view";
import type { RenderedRevision } from "@/lib/wiki/service";

export interface ArticleFooterProps {
  locale: Locale;
  categories: PageRefView[];
  /** Applied to every category href (e.g. a non-default `?v=`). */
  hrefFor?: (ref: PageRefView) => string;
  revision: RenderedRevision;
  updatedAt: Date;
  whatLinksHereHref: string;
  labels: ArticleViewLabels;
}

export function ArticleFooter({
  locale,
  categories,
  hrefFor,
  revision,
  updatedAt,
  whatLinksHereHref,
  labels,
}: ArticleFooterProps) {
  const href = hrefFor ?? ((ref: PageRefView) => ref.href);
  const editedAt = revision.isCurrent ? updatedAt : revision.createdAt;

  return (
    <footer className="mt-10 flex flex-col gap-3 border-t border-hairline pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs uppercase tracking-wide text-mute">
          {labels.categories}
        </span>
        {categories.length > 0 ? (
          categories.map((category) => (
            <Link
              key={category.slug}
              href={href(category)}
              className="focus-ring rounded-full border border-hairline bg-surface px-3 py-1 font-mono text-xs text-body transition-colors hover:bg-canvas-soft hover:text-ink"
            >
              {category.title}
            </Link>
          ))
        ) : (
          <span className="text-[13px] text-mute">{labels.noCategories}</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-mute">
        <span>
          {labels.lastEdited} {formatDateTime(locale, editedAt)} {labels.by} {revision.authorName}
        </span>
        <span className="font-mono text-xs text-faint">
          {labels.revisionLabel} {revision.id}
        </span>
        <Link className="text-link hover:underline" href={whatLinksHereHref}>
          {labels.whatLinksHere}
        </Link>
      </div>
    </footer>
  );
}
