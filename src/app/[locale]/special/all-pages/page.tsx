/**
 * /{locale}/special/all-pages — per-namespace listing (routes.md), keyset
 * pagination on slug via ?after= (queries.ts listPages). Redirect pages get
 * a chip.
 */

import type { Metadata } from "next";
import Link from "next/link";

import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/select";
import { CELL_MONO_CLASSES, Chip, SpecialTable } from "@/components/wiki/special-table";
import { getDb } from "@/lib/db/client";
import { listPages } from "@/lib/db/queries";
import { getDictionary } from "@/lib/i18n";
import { articleHref, specialHref, withQuery } from "@/lib/locale-path";
import { nsPrefix, STORABLE_NAMESPACES, type StorableNamespace } from "@/lib/title";

interface AllPagesProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function parseNamespace(value: string): StorableNamespace | undefined {
  return (STORABLE_NAMESPACES as readonly string[]).includes(value)
    ? (value as StorableNamespace)
    : undefined;
}

export async function generateMetadata({ params }: AllPagesProps): Promise<Metadata> {
  const { locale } = await params;
  return { title: getDictionary(decodeURIComponent(locale).toLowerCase()).special.allPagesTitle };
}

export default async function AllPagesPage({ params, searchParams }: AllPagesProps) {
  const { locale: rawLocale } = await params;
  const locale = decodeURIComponent(rawLocale).toLowerCase();
  const sp = await searchParams;
  const dict = getDictionary(locale);

  const namespace = parseNamespace(firstParam(sp.ns).toLowerCase());
  const after = firstParam(sp.after) || undefined;

  const { rows, nextCursor } = listPages(getDb(), { namespace, after, limit: 100 });

  const loadMoreHref = withQuery(specialHref(locale, "all-pages"), {
    ns: namespace,
    after: nextCursor ?? undefined,
  });

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">
        {dict.special.allPagesTitle}
      </h1>

      <form
        method="get"
        className="flex flex-wrap items-center gap-3 rounded-[var(--radius-md)] border border-hairline bg-canvas-soft px-3 py-2.5"
      >
        <Select
          name="ns"
          defaultValue={namespace ?? ""}
          aria-label={dict.special.columnNamespace}
          wrapperClassName="w-48"
          className="h-8 text-[13px]"
        >
          <option value="">{dict.special.namespaceAll}</option>
          {STORABLE_NAMESPACES.map((ns) => (
            <option key={ns} value={ns}>
              {ns}
            </option>
          ))}
        </Select>
        <button type="submit" className={buttonClasses("secondary", "sm")}>
          {dict.special.filterLabel}
        </button>
      </form>

      {rows.length === 0 ? (
        <EmptyState title={dict.special.empty} />
      ) : (
        <SpecialTable
          ariaLabel={dict.special.allPagesTitle}
          head={[dict.special.columnPage, dict.special.columnNamespace]}
        >
          {rows.map((row) => {
            const path = `${nsPrefix(row.namespace)}${row.slug}`;
            return (
              <tr key={row.pageId} className="hover:bg-canvas-soft">
                <td className={CELL_MONO_CLASSES}>
                  <span className="flex items-center gap-2">
                    <Link
                      href={articleHref(locale, row.namespace, row.slug)}
                      className="focus-ring rounded-[2px] text-link hover:underline"
                    >
                      {path}
                    </Link>
                    {row.redirectSlug ? <Chip>{dict.special.redirectBadge}</Chip> : null}
                  </span>
                </td>
                <td className={CELL_MONO_CLASSES}>{row.namespace}</td>
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
