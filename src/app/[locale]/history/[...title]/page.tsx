/**
 * /{locale}/history/[...title] — keyset-paginated revision list (routes.md).
 *
 * Server component: per-locale tabs (pageLanguages), the revision table via
 * the <HistoryList> island (radio-pair diff selection + rollback), and an
 * "Older" link driven by the keyset cursor — pagination and tabs work with
 * no JS at all.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ButtonLink } from "@/components/ui/button";
import { moderationChipLabels } from "@/components/moderation-chip";
import { HistoryList, type HistoryRowData } from "@/components/wiki/history-list";
import { getDb } from "@/lib/db/client";
import { getHistory, getPageSource, pageLanguages } from "@/lib/db/queries";
import type { Namespace } from "@/lib/db/schema";
import { formatMessage, getDictionary } from "@/lib/i18n";
import { titlePathSegment, titleRouteHref, withQuery } from "@/lib/locale-path";
import { humanizeSlug, pathToTitle, slugifyTitle } from "@/lib/title";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;

interface HistoryPageProps {
  params: Promise<{ locale: string; title: string[] }>;
  searchParams: Promise<{ l?: string; cursor?: string }>;
}

function resolveTitle(segments: string[]) {
  const parsed = pathToTitle(segments);
  if (!parsed) return null;
  const slug = slugifyTitle(parsed.slug) || parsed.slug.toLowerCase();
  return {
    namespace: parsed.nsName as Namespace,
    slug,
    titlePath: titlePathSegment(parsed.nsName, slug),
  };
}

export async function generateMetadata({ params }: HistoryPageProps): Promise<Metadata> {
  const { locale: rawLocale, title } = await params;
  const locale = decodeURIComponent(rawLocale).toLowerCase();
  const dict = getDictionary(locale);
  const resolved = resolveTitle(title);
  if (!resolved) return { title: dict.errors.notFoundTitle };
  const source = getPageSource(getDb(), { ...resolved, locale });
  const display = source?.pageLocale?.title ?? humanizeSlug(resolved.slug);
  return { title: formatMessage(dict.history.title, { title: display }) };
}

export default async function HistoryPage({ params, searchParams }: HistoryPageProps) {
  const [{ locale: rawLocale, title }, sp] = await Promise.all([params, searchParams]);
  const locale = decodeURIComponent(rawLocale).toLowerCase();
  const resolved = resolveTitle(title);
  if (!resolved) notFound();

  const db = getDb();
  const dict = getDictionary(locale);

  const contentLocale = typeof sp.l === "string" && sp.l !== "" ? sp.l.toLowerCase() : locale;
  const cursorParam = typeof sp.cursor === "string" ? Number.parseInt(sp.cursor, 10) : NaN;
  const cursor = Number.isInteger(cursorParam) && cursorParam > 0 ? cursorParam : undefined;

  const source = getPageSource(db, {
    namespace: resolved.namespace,
    slug: resolved.slug,
    locale: contentLocale,
  });
  if (!source) notFound();

  const langs = pageLanguages(db, source.page.id);
  const displayTitle =
    source.pageLocale?.title ??
    langs.find((l) => l.locale === "en")?.title ??
    langs[0]?.title ??
    humanizeSlug(resolved.slug);

  const { rows, nextCursor } = getHistory(db, source.page.id, contentLocale, {
    cursor,
    limit: PAGE_SIZE,
  });

  const listRows: HistoryRowData[] = rows.map((row) => ({
    id: row.id,
    comment: row.comment,
    isMinor: row.isMinor,
    authorName: row.authorName,
    authorUid: row.authorUid,
    // null when the author has no mirror row at all — not banned either way.
    authorBanned: row.authorBanned ?? false,
    createdAt: row.createdAt.toISOString(),
    bytes: row.bytes,
    isCurrent: row.id === source.pageLocale?.currentRevId,
  }));

  const basePath = titleRouteHref(locale, "history", resolved.titlePath);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-[-0.04em] text-ink">
          {formatMessage(dict.history.title, { title: displayTitle })}
        </h1>
        <ButtonLink
          href={titleRouteHref(locale, "wiki", resolved.titlePath)}
          variant="secondary"
          size="sm"
        >
          {dict.common.back}
        </ButtonLink>
      </div>

      {langs.length > 1 ? (
        <nav
          aria-label={dict.history.localeTabsLabel}
          className="mb-4 flex flex-wrap gap-1 border-b border-hairline pb-2"
        >
          {langs.map((lang) => (
            <Link
              key={lang.locale}
              href={withQuery(basePath, { l: lang.locale })}
              aria-current={lang.locale === contentLocale ? "page" : undefined}
              className={cn(
                "focus-ring rounded-full border px-3 py-1 font-mono text-xs transition-colors",
                lang.locale === contentLocale
                  ? "border-transparent bg-primary text-on-primary"
                  : "border-hairline text-mute hover:bg-canvas-soft-2 hover:text-ink",
              )}
            >
              {lang.nativeName || lang.locale}
            </Link>
          ))}
        </nav>
      ) : null}

      <HistoryList
        locale={locale}
        titlePath={resolved.titlePath}
        contentLocale={contentLocale}
        rows={listRows}
        labels={{
          columnRevision: dict.history.columnRevision,
          columnDate: dict.history.columnDate,
          columnAuthor: dict.history.columnAuthor,
          columnSummary: dict.history.columnSummary,
          columnSize: dict.history.columnSize,
          compare: dict.history.compare,
          rollback: dict.history.rollback,
          currentBadge: dict.history.currentBadge,
          minorBadge: dict.history.minorBadge,
          empty: dict.history.empty,
          selectFrom: dict.history.selectFrom,
          selectTo: dict.history.selectTo,
          rollbackConfirmTitle: dict.history.rollbackConfirmTitle,
          rollbackConfirmDescription: dict.history.rollbackConfirmDescription,
          rollbackFailed: dict.history.rollbackFailed,
          confirm: dict.common.confirm,
          cancel: dict.common.cancel,
          close: dict.common.close,
          moderation: moderationChipLabels(dict),
        }}
      />

      {nextCursor !== null ? (
        <div className="mt-4">
          <ButtonLink
            href={withQuery(basePath, { l: contentLocale, cursor: String(nextCursor) })}
            variant="secondary"
            size="sm"
          >
            {dict.history.older}
          </ButtonLink>
        </div>
      ) : null}
    </div>
  );
}
