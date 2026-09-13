/**
 * /{locale}/special/version-coverage — versioning.md §6 report: which pages
 * carry which game-version boundaries and when each locale head was last
 * updated (stale-article hunting). Filterable by version id via ?v=.
 */

import type { Metadata } from "next";
import Link from "next/link";

import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/select";
import { CELL_CLASSES, CELL_MONO_CLASSES, Chip, SpecialTable } from "@/components/wiki/special-table";
import { getDb } from "@/lib/db/client";
import { versionCoverage } from "@/lib/db/queries";
import { DEFAULT_VERSION_KEY, getSetting, listVersions } from "@/lib/db/store";
import { dateTimeFormat, getDictionary } from "@/lib/i18n";
import { articleHref, withQuery } from "@/lib/locale-path";
import { nsPrefix } from "@/lib/title";

interface VersionCoverageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export async function generateMetadata({ params }: VersionCoverageProps): Promise<Metadata> {
  const { locale } = await params;
  return {
    title: getDictionary(decodeURIComponent(locale).toLowerCase()).special.versionCoverageTitle,
  };
}

export default async function VersionCoveragePage({ params, searchParams }: VersionCoverageProps) {
  const { locale: rawLocale } = await params;
  const locale = decodeURIComponent(rawLocale).toLowerCase();
  const sp = await searchParams;
  const dict = getDictionary(locale);

  const db = getDb();
  const registry = listVersions(db);
  const defaultVersion = getSetting<string>(db, DEFAULT_VERSION_KEY);
  const requested = firstParam(sp.v).trim().toLowerCase();
  const filter = registry.some((v) => v.id === requested) ? requested : undefined;

  const rows = versionCoverage(db, filter);
  const dateFormat = dateTimeFormat(locale, { dateStyle: "medium" });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          {dict.special.versionCoverageTitle}
        </h1>
        <p className="text-sm text-mute">{dict.special.versionCoverageDescription}</p>
      </div>

      <form
        method="get"
        className="flex flex-wrap items-center gap-3 rounded-[var(--radius-md)] border border-hairline bg-canvas-soft px-3 py-2.5"
      >
        <Select
          name="v"
          defaultValue={filter ?? ""}
          aria-label={dict.special.columnVersion}
          wrapperClassName="w-52"
          className="h-8 font-mono text-[13px]"
        >
          <option value="">{dict.special.versionAll}</option>
          {registry.map((version) => (
            <option key={version.id} value={version.id}>
              {version.label}
              {version.id === defaultVersion ? " *" : ""}
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
          ariaLabel={dict.special.versionCoverageTitle}
          head={[
            dict.special.columnVersion,
            dict.special.columnPage,
            dict.special.columnLocale,
            dict.special.columnDate,
          ]}
        >
          {rows.map((row) => {
            const path = `${nsPrefix(row.namespace)}${row.slug}`;
            return (
              <tr key={`${row.version}:${row.pageId}:${row.locale}`} className="hover:bg-canvas-soft">
                <td className={CELL_CLASSES}>
                  <Chip
                    className={
                      row.version === defaultVersion ? "border-link text-link" : undefined
                    }
                  >
                    {row.version}
                  </Chip>
                </td>
                <td className={CELL_MONO_CLASSES}>
                  <Link
                    href={withQuery(articleHref(row.locale, row.namespace, row.slug), {
                      v: row.version,
                    })}
                    className="focus-ring rounded-[2px] text-link hover:underline"
                  >
                    {path}
                  </Link>
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
