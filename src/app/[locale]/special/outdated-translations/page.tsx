/**
 * /{locale}/special/outdated-translations — freshness report (routes.md,
 * db-schema query #10). A NULL basis means the page was authored in its
 * locale, not translated — badged "original" per decisions O4.
 *
 * LOCAL QUERY: `enRevisionsBehindCounts` — for each stale translation the
 * report shows how many EN revisions landed after the translation's basis;
 * queries.ts exposes only the rev-id delta, so the count is computed here
 * with one grouped drizzle query over `revisions`.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { and, eq, gt, inArray, sql } from "drizzle-orm";

import { EmptyState } from "@/components/ui/empty-state";
import { CELL_CLASSES, CELL_MONO_CLASSES, Chip, SpecialTable } from "@/components/wiki/special-table";
import { getDb, type WikiDb } from "@/lib/db/client";
import { outdatedTranslations, type OutdatedRow } from "@/lib/db/queries";
import { revisions } from "@/lib/db/schema";
import { dateTimeFormat, formatMessage, getDictionary } from "@/lib/i18n";
import { articleHref } from "@/lib/locale-path";
import { nsPrefix } from "@/lib/title";

interface OutdatedTranslationsProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: OutdatedTranslationsProps): Promise<Metadata> {
  const { locale } = await params;
  return {
    title: getDictionary(decodeURIComponent(locale).toLowerCase()).special.outdatedTranslationsTitle,
  };
}

/**
 * Count EN revisions newer than each stale translation's basis, per page.
 * Returns a map keyed `pageId:basedOnRev`.
 */
function enRevisionsBehindCounts(db: WikiDb, rows: OutdatedRow[]): Map<string, number> {
  const behind = new Map<string, number>();
  const translated = rows.filter(
    (row): row is OutdatedRow & { basedOnRev: number } => row.basedOnRev !== null,
  );
  if (translated.length === 0) return behind;

  const pageIds = [...new Set(translated.map((row) => row.pageId))];
  const minBasis = Math.min(...translated.map((row) => row.basedOnRev));
  const enRevs = db
    .select({ pageId: revisions.pageId, id: revisions.id })
    .from(revisions)
    .where(
      and(
        eq(revisions.locale, "en"),
        inArray(revisions.pageId, pageIds),
        gt(revisions.id, sql`${minBasis}`),
      ),
    )
    .all();

  for (const row of translated) {
    const count = enRevs.filter((rev) => rev.pageId === row.pageId && rev.id > row.basedOnRev).length;
    behind.set(`${row.pageId}:${row.basedOnRev}`, count);
  }
  return behind;
}

export default async function OutdatedTranslationsPage({ params }: OutdatedTranslationsProps) {
  const { locale: rawLocale } = await params;
  const locale = decodeURIComponent(rawLocale).toLowerCase();
  const dict = getDictionary(locale);

  const db = getDb();
  const rows = outdatedTranslations(db);
  const behind = enRevisionsBehindCounts(db, rows);
  const dateFormat = dateTimeFormat(locale, { dateStyle: "medium" });

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">
        {dict.special.outdatedTranslationsTitle}
      </h1>

      {rows.length === 0 ? (
        <EmptyState title={dict.special.empty} />
      ) : (
        <SpecialTable
          ariaLabel={dict.special.outdatedTranslationsTitle}
          head={[
            dict.special.columnPage,
            dict.special.columnTranslation,
            dict.special.columnLocale,
            dict.special.columnDate,
          ]}
        >
          {rows.map((row) => {
            const path = `${nsPrefix(row.namespace)}${row.slug}`;
            const behindCount =
              row.basedOnRev === null ? null : (behind.get(`${row.pageId}:${row.basedOnRev}`) ?? 0);
            return (
              <tr key={`${row.pageId}:${row.locale}`} className="hover:bg-canvas-soft">
                <td className={CELL_MONO_CLASSES}>
                  <Link
                    href={articleHref("en", row.namespace, row.slug)}
                    className="focus-ring rounded-[2px] text-link hover:underline"
                  >
                    {path}
                  </Link>
                </td>
                <td className={CELL_CLASSES}>
                  <span className="flex items-center gap-2">
                    <Link
                      href={articleHref(row.locale, row.namespace, row.slug)}
                      className="focus-ring rounded-[2px] text-link hover:underline"
                    >
                      {path}
                    </Link>
                    {behindCount === null ? (
                      <Chip>{dict.special.originalBadge}</Chip>
                    ) : (
                      <span className="text-[13px] text-mute">
                        {formatMessage(dict.special.columnRevisionsBehind, { count: behindCount })}
                      </span>
                    )}
                  </span>
                </td>
                <td className={CELL_CLASSES}>
                  <Chip>{row.locale}</Chip>
                </td>
                <td className={`${CELL_CLASSES} whitespace-nowrap text-mute`}>
                  {dateFormat.format(new Date(row.updatedAt))}
                </td>
              </tr>
            );
          })}
        </SpecialTable>
      )}
    </div>
  );
}
