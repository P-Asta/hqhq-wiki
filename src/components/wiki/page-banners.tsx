/**
 * Article status banners (routes.md `/wiki/[...title]`, versioning.md §6,
 * decisions O4), theme.md "Banners" tones via StatusBanner:
 *
 *  - unknown `?v=` fell back to the default version (warning);
 *  - `?rev=` old-revision view (warning + link to the current revision);
 *  - EN fallback: no head in the requested locale (info + translate CTA);
 *  - translation status: outdated vs the EN basis (warning + update CTA), or
 *    an "original article" badge for NULL-basis pages (info);
 *  - "Redirected from …" — a quiet note, not a tonal banner.
 *
 * There is deliberately no "your `?v=` changed nothing here" banner: that
 * sentence belongs to <VersionSelector>, which now renders on every article
 * and prints it as the note under its compact form — one place, and the one
 * with the control that can act on it (versioning.md §6). An *unknown* id is a
 * different condition and keeps its warning: the registry has no such version,
 * so the page fell back to the default rather than showing what was asked for.
 */

import Link from "next/link";

import { StatusBanner } from "@/components/ui/status-banner";
import { withQuery } from "@/lib/locale-path";
import {
  formatDateTime,
  type ArticleView,
  type ArticleViewLabels,
} from "@/lib/wiki/read-view";

export interface PageBannersProps {
  view: ArticleView;
  /**
   * The reader's non-default version, so a banner's escape hatch does not
   * quietly drop it. Leaving an old revision should change the revision and
   * nothing else (versioning.md §6).
   */
  carryVersion?: string;
  labels: ArticleViewLabels;
}

const BANNER_LINK = "font-medium underline underline-offset-2";

export function PageBanners({ view, carryVersion, labels }: PageBannersProps) {
  const { revision, translationStatus, paths } = view;

  return (
    <div className="flex flex-col gap-2 empty:hidden">
      {view.redirectedFrom ? (
        <p className="text-[13px] text-mute">
          {labels.redirectedFrom}{" "}
          <Link className="text-link hover:underline" href={view.redirectedFrom.href}>
            {view.redirectedFrom.title}
          </Link>
        </p>
      ) : null}

      {view.unknownVersionRequested ? (
        <StatusBanner tone="warning" title={labels.unknownVersionTitle}>
          {labels.unknownVersionDescription}
        </StatusBanner>
      ) : null}

      {!revision.isCurrent ? (
        <StatusBanner tone="warning" title={labels.oldRevisionTitle}>
          {labels.oldRevisionDescription}{" "}
          <span className="font-mono">
            {labels.revisionLabel} {revision.id} · {formatDateTime(view.locale, revision.createdAt)}
          </span>{" "}
          ·{" "}
          <Link className={BANNER_LINK} href={withQuery(paths.article, { v: carryVersion })}>
            {labels.oldRevisionAction}
          </Link>
        </StatusBanner>
      ) : null}

      {view.fallbackFromEn ? (
        <StatusBanner tone="info" title={labels.fallbackTitle}>
          {labels.fallbackDescription}{" "}
          <Link className={BANNER_LINK} href={paths.edit}>
            {labels.translate}
          </Link>
        </StatusBanner>
      ) : null}

      {translationStatus?.outdated ? (
        <StatusBanner tone="warning" title={labels.outdatedTitle}>
          {labels.outdatedDescription}{" "}
          <Link className={BANNER_LINK} href={paths.edit}>
            {labels.outdatedAction}
          </Link>
        </StatusBanner>
      ) : null}

      {translationStatus?.original ? (
        <StatusBanner tone="info" title={labels.originalTitle}>
          {labels.originalDescription}
        </StatusBanner>
      ) : null}
    </div>
  );
}
