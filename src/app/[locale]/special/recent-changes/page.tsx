/**
 * /{locale}/special/recent-changes — all locales by default, filterable by
 * locale and minor-ness (routes.md). Keyset pagination on revision id (the
 * global change order); "Load more" is a plain link carrying ?cursor=, so
 * the page works without JS.
 */

import type { Metadata } from "next";
import Link from "next/link";

import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ModerationChip, moderationChipLabels } from "@/components/moderation-chip";
import { Select } from "@/components/ui/select";
import { CELL_CLASSES, CELL_MONO_CLASSES, Chip, SpecialTable } from "@/components/wiki/special-table";
import { getDb } from "@/lib/db/client";
import { recentChanges } from "@/lib/db/queries";
import { listLanguages } from "@/lib/db/store";
import { dateTimeFormat, getDictionary } from "@/lib/i18n";
import { articleHref, specialHref, withQuery } from "@/lib/locale-path";
import { nsPrefix } from "@/lib/title";

interface RecentChangesPageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export async function generateMetadata({ params }: RecentChangesPageProps): Promise<Metadata> {
  const { locale } = await params;
  return { title: getDictionary(decodeURIComponent(locale).toLowerCase()).special.recentChangesTitle };
}

export default async function RecentChangesPage({ params, searchParams }: RecentChangesPageProps) {
  const { locale: rawLocale } = await params;
  const locale = decodeURIComponent(rawLocale).toLowerCase();
  const sp = await searchParams;
  const dict = getDictionary(locale);

  const filterLocale = firstParam(sp.locale).toLowerCase();
  const hideMinor = firstParam(sp.hideMinor) === "1";
  const rawCursor = Number(firstParam(sp.cursor));
  const cursor = Number.isInteger(rawCursor) && rawCursor > 0 ? rawCursor : undefined;

  const db = getDb();
  const registry = listLanguages(db, "active");
  const { rows, nextCursor } = recentChanges(db, {
    locale: filterLocale || undefined,
    hideMinor,
    cursor,
    limit: 50,
  });

  const dateFormat = dateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  // Built once: every row's chip shares one bundle of resolved strings.
  const chipLabels = moderationChipLabels(dict);

  const loadMoreHref = withQuery(specialHref(locale, "recent-changes"), {
    locale: filterLocale || undefined,
    hideMinor: hideMinor ? "1" : undefined,
    cursor: nextCursor ? String(nextCursor) : undefined,
  });

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">
        {dict.special.recentChangesTitle}
      </h1>

      <form
        method="get"
        className="flex flex-wrap items-center gap-3 rounded-[var(--radius-md)] border border-hairline bg-canvas-soft px-3 py-2.5"
      >
        <Select
          name="locale"
          defaultValue={filterLocale}
          aria-label={dict.special.columnLocale}
          wrapperClassName="w-44"
          className="h-8 text-[13px]"
        >
          <option value="">{dict.special.columnLocale} — *</option>
          {registry.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.nativeName} ({lang.code})
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-2 text-[13px] text-body">
          <input type="checkbox" name="hideMinor" value="1" defaultChecked={hideMinor} className="focus-ring size-4 accent-[var(--link)]" />
          {dict.special.hideMinorLabel}
        </label>
        <button type="submit" className={buttonClasses("secondary", "sm")}>
          {dict.special.filterLabel}
        </button>
      </form>

      {rows.length === 0 ? (
        <EmptyState title={dict.special.empty} />
      ) : (
        <SpecialTable
          ariaLabel={dict.special.recentChangesTitle}
          head={[
            dict.special.columnDate,
            dict.special.columnPage,
            dict.special.columnLocale,
            dict.special.columnUser,
            dict.special.columnSummary,
          ]}
        >
          {rows.map((row) => {
            const path = `${nsPrefix(row.namespace)}${row.slug}`;
            // Each row links into its OWN content locale (O12 prefixes).
            const href = articleHref(row.locale, row.namespace, row.slug);
            return (
              <tr key={row.revId} className="hover:bg-canvas-soft">
                <td className={`${CELL_CLASSES} whitespace-nowrap text-mute`}>
                  {dateFormat.format(row.createdAt)}
                </td>
                <td className={CELL_CLASSES}>
                  <div className="flex items-center gap-2">
                    <Link href={href} className="focus-ring rounded-[2px] font-medium text-link hover:underline">
                      {row.title}
                    </Link>
                    {row.isMinor ? <Chip>{dict.special.minorBadge}</Chip> : null}
                  </div>
                  <span className="font-mono text-[11px] text-faint">{path}</span>
                </td>
                <td className={CELL_MONO_CLASSES}>
                  <Chip>{row.locale}</Chip>
                </td>
                <td className={CELL_CLASSES}>
                  <ModerationChip
                    user={{
                      uid: row.authorUid,
                      displayName: row.authorName,
                      banned: row.authorBanned ?? false,
                    }}
                    labels={chipLabels}
                    context={`revision:${row.revId}`}
                    compact
                  />
                </td>
                <td className={`${CELL_CLASSES} max-w-72 text-mute`}>{row.comment}</td>
              </tr>
            );
          })}
        </SpecialTable>
      )}

      {nextCursor ? (
        <div>
          <Link
            href={loadMoreHref}
            className={buttonClasses("secondary", "sm")}
          >
            {dict.special.loadMore}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
