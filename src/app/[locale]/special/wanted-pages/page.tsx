/**
 * /{locale}/special/wanted-pages — red-link targets ranked by how many
 * distinct pages reference them (routes.md; queries.ts wantedPages). Links
 * use the red-link color: following one lands on the "create this page" CTA.
 */

import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState } from "@/components/ui/empty-state";
import { CELL_CLASSES, SpecialTable } from "@/components/wiki/special-table";
import { getDb } from "@/lib/db/client";
import { wantedPages } from "@/lib/db/queries";
import { formatMessage, getDictionary } from "@/lib/i18n";
import { articleHref } from "@/lib/locale-path";
import { nsPrefix } from "@/lib/title";

interface WantedPagesProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: WantedPagesProps): Promise<Metadata> {
  const { locale } = await params;
  return { title: getDictionary(decodeURIComponent(locale).toLowerCase()).special.wantedPagesTitle };
}

export default async function WantedPagesPage({ params }: WantedPagesProps) {
  const { locale: rawLocale } = await params;
  const locale = decodeURIComponent(rawLocale).toLowerCase();
  const dict = getDictionary(locale);

  const rows = wantedPages(getDb(), 100);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">
        {dict.special.wantedPagesTitle}
      </h1>

      {rows.length === 0 ? (
        <EmptyState title={dict.special.empty} />
      ) : (
        <SpecialTable
          ariaLabel={dict.special.wantedPagesTitle}
          head={[dict.special.columnPage, dict.special.linksSection]}
        >
          {rows.map((row) => {
            const path = `${nsPrefix(row.namespace)}${row.slug}`;
            return (
              <tr key={path} className="hover:bg-canvas-soft">
                <td className={CELL_CLASSES}>
                  <Link
                    // O14.6: a wanted page is addressed by its article URL — visiting it
                    // is the create flow.
                    href={articleHref(locale, row.namespace, row.slug)}
                    className="focus-ring rounded-[2px] font-mono text-[13px] font-medium text-link-red hover:underline"
                  >
                    {path}
                  </Link>
                </td>
                <td className={`${CELL_CLASSES} whitespace-nowrap text-mute`}>
                  {formatMessage(dict.special.columnInboundLinks, { count: row.refs })}
                </td>
              </tr>
            );
          })}
        </SpecialTable>
      )}
    </div>
  );
}
