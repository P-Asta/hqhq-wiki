/**
 * /{locale}/languages — content-language registry (routes.md: anon view,
 * editor propose, admin activate/deactivate via /api/languages).
 *
 * LOCAL QUERIES (not in queries.ts, noted per task):
 * - per-language page counts: `page_locales` heads grouped by locale;
 * - per-language outdated counts: `outdatedTranslations()` grouped by locale.
 */

import type { Metadata } from "next";
import { and, isNotNull, sql } from "drizzle-orm";

import { LanguageManager, type LanguageRegistryRow } from "@/components/wiki/language-manager";
import { getDb } from "@/lib/db/client";
import { outdatedTranslations } from "@/lib/db/queries";
import { pageLocales } from "@/lib/db/schema";
import { listLanguages } from "@/lib/db/store";
import { getDictionary } from "@/lib/i18n";

interface LanguagesPageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: LanguagesPageProps): Promise<Metadata> {
  const { locale } = await params;
  return { title: getDictionary(decodeURIComponent(locale).toLowerCase()).languages.title };
}

export default async function LanguagesPage({ params }: LanguagesPageProps) {
  const { locale: rawLocale } = await params;
  const locale = decodeURIComponent(rawLocale).toLowerCase();
  const dict = getDictionary(locale);

  const db = getDb();
  const registry = listLanguages(db);

  const pageCounts = db
    .select({ locale: pageLocales.locale, count: sql<number>`count(*)` })
    .from(pageLocales)
    .where(and(isNotNull(pageLocales.currentRevId)))
    .groupBy(pageLocales.locale)
    .all();
  const pagesByLocale = new Map(pageCounts.map((row) => [row.locale, row.count]));

  const outdatedByLocale = new Map<string, number>();
  for (const row of outdatedTranslations(db)) {
    if (row.basedOnRev === null) continue; // "original" pages are not stale (O4)
    outdatedByLocale.set(row.locale, (outdatedByLocale.get(row.locale) ?? 0) + 1);
  }

  const rows: LanguageRegistryRow[] = registry.map((lang) => ({
    code: lang.code,
    label: lang.label,
    nativeName: lang.nativeName,
    direction: lang.direction,
    status: lang.status,
    pages: pagesByLocale.get(lang.code) ?? 0,
    outdated: outdatedByLocale.get(lang.code) ?? 0,
  }));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{dict.languages.title}</h1>
        <p className="text-sm text-mute">{dict.languages.description}</p>
      </div>

      <LanguageManager
        rows={rows}
        labels={{
          columnCode: dict.languages.columnCode,
          columnName: dict.languages.columnName,
          columnNativeName: dict.languages.columnNativeName,
          columnStatus: dict.languages.columnStatus,
          columnPages: dict.languages.columnPages,
          columnOutdated: dict.languages.columnOutdated,
          columnActions: dict.common.actions,
          statusActive: dict.languages.statusActive,
          statusProposed: dict.languages.statusProposed,
          proposeTitle: dict.languages.proposeTitle,
          proposeDescription: dict.languages.proposeDescription,
          directionLabel: dict.languages.directionLabel,
          directionLtr: dict.languages.directionLtr,
          directionRtl: dict.languages.directionRtl,
          proposeAction: dict.languages.proposeAction,
          activateAction: dict.languages.activateAction,
          deactivateAction: dict.languages.deactivateAction,
          signInToPropose: dict.languages.signInToPropose,
          proposeSuccess: dict.languages.proposeSuccess,
          requestFailed: dict.languages.requestFailed,
        }}
      />
    </div>
  );
}
