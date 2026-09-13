/**
 * Site shell — theme.md "Site chrome". Server component; the only client
 * islands are the search box, ask dock (Q&A side panel), locale switcher,
 * theme toggle, and account menu. 64px header on a bottom hairline, wordmark
 * left, controls right, hairline footer. All strings arrive pre-resolved
 * from the dictionary.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import { AccountMenu } from "@/components/account-menu";
import { AskDock, type AskDockLabels } from "@/components/ask-dock";
import { HeaderSearch } from "@/components/header-search";
import { LocaleSwitcher, type LocaleOption } from "@/components/locale-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { homeHref } from "@/lib/locale-path";
import type { RoleId } from "@/lib/roles";

export type SiteShellLanguage = LocaleOption;

export interface SiteShellLabels {
  /** Wordmark text (common.siteName). */
  siteName: string;
  skipToContent: string;
  searchLabel: string;
  searchPlaceholder: string;
  searchSubmit: string;
  languageLabel: string;
  signIn: string;
  signOut: string;
  profile: string;
  admin: string;
  loading: string;
  anonymous: string;
  /** Account-menu note for an unverifiable session (common.unverified). */
  unverified: string;
  /** Role display names for the account menu badges. */
  roleNames: Partial<Record<RoleId, string>>;
  footerLicense: string;
  /** Pre-formatted (common.footerCopyright with {name} resolved). */
  footerCopyright: string;
}

export interface SiteShellProps {
  /** The active /[locale] segment (content + UI locale). */
  locale: string;
  labels: SiteShellLabels;
  /** Strings for the ask dock (header toggle + right-docked Q&A panel). */
  ask: AskDockLabels;
  /** Registered languages for the switcher (active registry rows). */
  languages: SiteShellLanguage[];
  children: ReactNode;
}

export function SiteShell({ locale, labels, ask, languages, children }: SiteShellProps) {
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#content"
        className="focus-ring sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-[var(--radius-sm)] focus:border focus:border-hairline focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:text-ink"
      >
        {labels.skipToContent}
      </a>

      <header className="sticky top-0 z-40 border-b border-hairline bg-canvas">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-3 px-4 sm:gap-4 sm:px-6">
          <Link
            href={homeHref(locale)}
            className="focus-ring flex shrink-0 items-center gap-2.5 rounded-[var(--radius-sm)]"
          >
            <span
              aria-hidden
              className="flex size-7 items-center justify-center rounded-[var(--radius-sm)] bg-primary font-mono text-[13px] font-semibold text-on-primary"
            >
              HQ
            </span>
            <span className="hidden text-sm font-semibold tracking-tight text-ink md:inline">
              {labels.siteName}
            </span>
          </Link>

          <div className="flex min-w-0 flex-1 justify-center px-1">
            <HeaderSearch
              locale={locale}
              label={labels.searchLabel}
              placeholder={labels.searchPlaceholder}
              submitLabel={labels.searchSubmit}
            />
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <AskDock locale={locale} labels={ask} />
            <LocaleSwitcher current={locale} options={languages} ariaLabel={labels.languageLabel} />
            <ThemeToggle />
            <AccountMenu
              locale={locale}
              labels={{
                signIn: labels.signIn,
                signOut: labels.signOut,
                profile: labels.profile,
                admin: labels.admin,
                loading: labels.loading,
                anonymous: labels.anonymous,
                unverified: labels.unverified,
                roleNames: labels.roleNames,
              }}
            />
          </div>
        </div>
      </header>

      {/* --ask-dock-w is set on <html> by AskDock while its panel is open
          (≥sm): the content area shrinks so the panel docks beside the page
          instead of covering it. The header stays full-width, VS Code-style. */}
      <div className="flex flex-1 flex-col transition-[padding] duration-150 sm:pr-[var(--ask-dock-w,0px)]">
        <main id="content" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
          {children}
        </main>

        <footer className="border-t border-hairline">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-1 px-4 py-6 text-[13px] text-mute sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <p>{labels.footerCopyright}</p>
            <p>{labels.footerLicense}</p>
          </div>
        </footer>
      </div>
    </div>
  );
}
