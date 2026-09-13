/**
 * /[locale] layout — validates the segment against the db languages registry,
 * resolves the dictionary server-side (EN fallback for registered content
 * locales without a shipped UI dictionary), and mounts the site shell.
 */

import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { asc } from "drizzle-orm";

import { SiteShell, type SiteShellLanguage } from "@/components/site-shell";
import { getDb } from "@/lib/db/client";
import { languages } from "@/lib/db/schema";
import { formatMessage, getDictionary, UI_LOCALES } from "@/lib/i18n";
import { isKnownUrlLocale } from "@/lib/locale-path";

/** Autonym fallbacks for shipped UI locales when the registry is empty. */
const UI_LOCALE_FALLBACKS: Record<string, SiteShellLanguage> = {
  en: { code: "en", label: "English", nativeName: "English" },
  ko: { code: "ko", label: "Korean", nativeName: "한국어" },
};

export interface LocaleLayoutProps {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}

export default async function LocaleLayout({ children, params }: LocaleLayoutProps) {
  const { locale: rawLocale } = await params;
  const locale = decodeURIComponent(rawLocale).toLowerCase();

  const rows = getDb()
    .select({
      code: languages.code,
      label: languages.label,
      nativeName: languages.nativeName,
      status: languages.status,
    })
    .from(languages)
    .orderBy(asc(languages.code))
    .all();

  // Valid segments are exactly the URL-addressable locales (O12 rule 2): the
  // middleware rewrites every other first segment into the English tree, so a
  // registered-but-undictionaried content locale never legitimately arrives
  // here. NOTE: a layout's notFound() cannot stop a page that is already
  // streaming, so the one route a junk segment can still reach — the home
  // page — repeats this guard itself.
  if (!isKnownUrlLocale(locale)) notFound();

  // Switcher options: active registry rows; guarantee the shipped UI locales
  // and the current locale always appear.
  const options = new Map<string, SiteShellLanguage>();
  for (const row of rows) {
    if (row.status === "active") {
      options.set(row.code, { code: row.code, label: row.label, nativeName: row.nativeName });
    }
  }
  for (const ui of UI_LOCALES) {
    if (!options.has(ui)) options.set(ui, UI_LOCALE_FALLBACKS[ui]);
  }
  if (!options.has(locale)) {
    const row = rows.find((r) => r.code === locale);
    if (row) options.set(locale, { code: row.code, label: row.label, nativeName: row.nativeName });
  }

  const dict = getDictionary(locale);

  return (
    <SiteShell
      locale={locale}
      languages={[...options.values()].sort((a, b) => a.code.localeCompare(b.code))}
      labels={{
        siteName: dict.common.siteName,
        skipToContent: dict.common.skipToContent,
        searchLabel: dict.search.label,
        searchPlaceholder: dict.search.placeholder,
        searchSubmit: dict.search.submit,
        languageLabel: dict.common.languageLabel,
        signIn: dict.common.signIn,
        signOut: dict.common.signOut,
        profile: dict.common.profile,
        admin: dict.common.admin,
        loading: dict.common.loading,
        anonymous: dict.common.anonymous,
        unverified: dict.common.unverified,
        roleNames: dict.roles,
        footerLicense: dict.common.footerLicense,
        footerCopyright: formatMessage(dict.common.footerCopyright, {
          name: dict.common.siteName,
        }),
      }}
      ask={{
        toggle: dict.ask.toggle,
        title: dict.ask.title,
        close: dict.common.close,
        view: {
          inputLabel: dict.ask.inputLabel,
          placeholder: dict.ask.placeholder,
          send: dict.ask.send,
          thinking: dict.ask.thinking,
          searchingLine: dict.ask.searchingLine,
          readingLine: dict.ask.readingLine,
          sourcesLabel: dict.ask.sourcesLabel,
          emptyTitle: dict.ask.emptyTitle,
          emptyDescription: dict.ask.emptyDescription,
          errorLine: dict.ask.errorLine,
          connectionError: dict.ask.connectionError,
        },
      }}
    >
      {children}
    </SiteShell>
  );
}
