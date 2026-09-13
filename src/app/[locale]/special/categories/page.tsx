/**
 * `/{locale}/special/categories` — the full category browse index
 * (decisions-v2 O13.4).
 *
 * Every category that exists, with its live `category_links` member count,
 * sorted by count descending then slug. A category needs neither a registry
 * row nor a `Category:` description page to appear here: the ones missing a
 * description page are simply marked, and their link lands on the auto member
 * listing (which doubles as the create flow for that title, O14).
 *
 * The "uncategorized pages" report lives on this page too, per O13.4 — it is
 * the other half of the same question, "where does everything live?".
 */

import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState } from "@/components/ui/empty-state";
import { CELL_CLASSES, CELL_MONO_CLASSES, Chip, SpecialTable } from "@/components/wiki/special-table";
import { getDb } from "@/lib/db/client";
import { listCategoriesWithCounts, uncategorizedPages } from "@/lib/db/queries";
import { getDictionary } from "@/lib/i18n";
import { articleHref } from "@/lib/locale-path";
import { humanizeSlug } from "@/lib/title";

export const dynamic = "force-dynamic";

interface CategoriesPageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: CategoriesPageProps): Promise<Metadata> {
  const { locale } = await params;
  const dict = getDictionary(decodeURIComponent(locale).toLowerCase());
  return { title: dict.special.categoriesTitle, description: dict.special.categoriesDescription };
}

export default async function CategoriesPage({ params }: CategoriesPageProps) {
  const { locale: rawLocale } = await params;
  const locale = decodeURIComponent(rawLocale).toLowerCase();
  const dict = getDictionary(locale);
  const db = getDb();

  // Already sorted by total members descending, then slug (O13.4).
  const categories = listCategoriesWithCounts(db, locale);
  const uncategorized = uncategorizedPages(db, locale, 200);

  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            {dict.special.categoriesTitle}
          </h1>
          <p className="mt-1 text-sm text-mute">{dict.special.categoriesDescription}</p>
        </div>

        {categories.length === 0 ? (
          <EmptyState title={dict.special.categoriesEmpty} />
        ) : (
          <SpecialTable
            ariaLabel={dict.special.categoriesTitle}
            head={[
              dict.special.columnCategory,
              dict.special.columnMembers,
              dict.special.columnSubcategories,
            ]}
          >
            {categories.map((row) => (
              <tr key={row.slug} className="hover:bg-canvas-soft">
                <td className={CELL_CLASSES}>
                  <span className="flex flex-wrap items-center gap-2">
                    <Link
                      href={articleHref(locale, "category", row.slug)}
                      className={`focus-ring rounded-[2px] font-medium hover:underline ${
                        row.hasPage ? "text-link" : "text-link-red"
                      }`}
                    >
                      {row.pageTitle ?? humanizeSlug(row.slug)}
                    </Link>
                    {row.hasPage ? null : <Chip>{dict.special.noDescriptionPageBadge}</Chip>}
                  </span>
                </td>
                <td className={`${CELL_MONO_CLASSES} whitespace-nowrap`}>{row.members}</td>
                <td className={`${CELL_MONO_CLASSES} whitespace-nowrap`}>{row.subcategories}</td>
              </tr>
            ))}
          </SpecialTable>
        )}
      </section>

      <section className="flex flex-col gap-6">
        <div>
          <h2 className="text-xl font-semibold tracking-[-0.02em] text-ink">
            {dict.special.uncategorizedTitle}
          </h2>
          <p className="mt-1 text-sm text-mute">{dict.special.uncategorizedDescription}</p>
        </div>

        {uncategorized.length === 0 ? (
          <p className="text-sm text-mute">{dict.special.uncategorizedEmpty}</p>
        ) : (
          <ul className="columns-1 gap-8 sm:columns-2 lg:columns-3">
            {uncategorized.map((row) => (
              <li key={row.pageId} className="break-inside-avoid py-0.5">
                <Link
                  className="focus-ring rounded-[2px] text-sm text-link hover:underline"
                  href={articleHref(locale, row.namespace, row.slug)}
                >
                  {row.title}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
