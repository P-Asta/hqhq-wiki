/**
 * Home recent-changes teaser (routes.md `/`) — the latest revisions as a
 * hairline-divided list: title link, edit comment, and a mono meta line
 * (locale, author, time, minor marker), plus a "view all" link.
 */

import Link from "next/link";

import { EmptyState } from "@/components/ui/empty-state";
import type { Locale } from "@/lib/i18n";
import {
  formatDateTime,
  type HomeChangeView,
  type HomeViewLabels,
} from "@/lib/wiki/read-view";

export interface RecentChangesTeaserProps {
  locale: Locale;
  changes: HomeChangeView[];
  viewAllHref: string;
  labels: HomeViewLabels;
}

export function RecentChangesTeaser({
  locale,
  changes,
  viewAllHref,
  labels,
}: RecentChangesTeaserProps) {
  if (changes.length === 0) {
    return <EmptyState title={labels.recentTitle} description={labels.emptyChanges} />;
  }

  return (
    <div>
      <ul className="divide-y divide-hairline rounded-[var(--radius-lg)] border border-hairline bg-surface">
        {changes.map((change) => (
          <li key={change.revId} className="flex flex-col gap-1 px-4 py-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <Link className="font-medium text-link hover:underline" href={change.href}>
                {change.title}
              </Link>
              {change.comment !== "" ? (
                <span className="text-[13px] text-mute">{change.comment}</span>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 font-mono text-xs text-faint">
              <span className="uppercase">{change.locale}</span>
              <span>{change.authorName}</span>
              <time dateTime={change.createdAt.toISOString()}>
                {formatDateTime(locale, change.createdAt)}
              </time>
              {change.isMinor ? <span>{labels.minor}</span> : null}
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-sm">
        <Link className="text-link hover:underline" href={viewAllHref}>
          {labels.recentAll} →
        </Link>
      </p>
    </div>
  );
}
