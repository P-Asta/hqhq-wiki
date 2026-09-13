/**
 * /{locale}/special/what-links-here/[...title] — backlinks, transclusions,
 * and redirects targeting one page (routes.md; queries.ts whatLinksHere).
 * The catch-all carries `nsPrefix+slug` per decisions O1.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { EmptyState } from "@/components/ui/empty-state";
import { CELL_CLASSES, CELL_MONO_CLASSES, Chip, SpecialTable } from "@/components/wiki/special-table";
import { getDb } from "@/lib/db/client";
import { whatLinksHere } from "@/lib/db/queries";
import { formatMessage, getDictionary, type Dictionary } from "@/lib/i18n";
import { articleHref } from "@/lib/locale-path";
import { nsPrefix, pathToTitle, type StorableNamespace } from "@/lib/title";

interface WhatLinksHereProps {
  params: Promise<{ locale: string; title: string[] }>;
}

interface BacklinkRow {
  pageId: number;
  namespace: StorableNamespace;
  slug: string;
  fromLocale?: string;
}

export async function generateMetadata({ params }: WhatLinksHereProps): Promise<Metadata> {
  const { locale: rawLocale, title } = await params;
  const locale = decodeURIComponent(rawLocale).toLowerCase();
  const dict = getDictionary(locale);
  const target = pathToTitle(title.map((segment) => decodeURIComponent(segment)));
  if (!target) return { title: dict.special.empty };
  return {
    title: formatMessage(dict.special.whatLinksHereTitle, {
      title: `${nsPrefix(target.nsName)}${target.slug}`,
    }),
  };
}

function BacklinkSection({
  heading,
  rows,
  locale,
  dict,
}: {
  heading: string;
  rows: BacklinkRow[];
  locale: string;
  dict: Dictionary;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold tracking-tight text-ink">{heading}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-mute">{dict.special.empty}</p>
      ) : (
        <SpecialTable ariaLabel={heading} head={[dict.special.columnPage, dict.special.columnLocale]}>
          {rows.map((row, index) => {
            const path = `${nsPrefix(row.namespace)}${row.slug}`;
            return (
              <tr key={`${row.pageId}:${row.fromLocale ?? ""}:${index}`} className="hover:bg-canvas-soft">
                <td className={CELL_MONO_CLASSES}>
                  <Link
                    href={articleHref(locale, row.namespace, row.slug)}
                    className="focus-ring rounded-[2px] text-link hover:underline"
                  >
                    {path}
                  </Link>
                </td>
                <td className={CELL_CLASSES}>
                  {row.fromLocale ? <Chip>{row.fromLocale}</Chip> : <span className="text-faint">—</span>}
                </td>
              </tr>
            );
          })}
        </SpecialTable>
      )}
    </section>
  );
}

export default async function WhatLinksHerePage({ params }: WhatLinksHereProps) {
  const { locale: rawLocale, title } = await params;
  const locale = decodeURIComponent(rawLocale).toLowerCase();
  const dict = getDictionary(locale);

  const target = pathToTitle(title.map((segment) => decodeURIComponent(segment)));
  if (!target) notFound();

  const targetPath = `${nsPrefix(target.nsName)}${target.slug}`;
  const { links, transclusions, redirects } = whatLinksHere(getDb(), target.nsName, target.slug);
  const total = links.length + transclusions.length + redirects.length;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          {formatMessage(dict.special.whatLinksHereTitle, { title: targetPath })}
        </h1>
        <Link
          href={articleHref(locale, target.nsName, target.slug)}
          className="focus-ring w-fit rounded-[2px] font-mono text-xs text-link hover:underline"
        >
          {targetPath}
        </Link>
      </div>

      {total === 0 ? (
        <EmptyState title={dict.special.empty} />
      ) : (
        <>
          <BacklinkSection heading={dict.special.linksSection} rows={links} locale={locale} dict={dict} />
          {target.nsName === "template" || transclusions.length > 0 ? (
            <BacklinkSection
              heading={dict.special.transclusionsSection}
              rows={transclusions}
              locale={locale}
              dict={dict}
            />
          ) : null}
          <BacklinkSection
            heading={dict.special.redirectsSection}
            rows={redirects}
            locale={locale}
            dict={dict}
          />
        </>
      )}
    </div>
  );
}
