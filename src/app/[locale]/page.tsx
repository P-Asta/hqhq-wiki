/**
 * `/[locale]` — the home page (routes.md `/`): hero with ONE gradient word
 * (theme.md "Hero"), a no-JS GET search form, the category grid, the
 * recent-changes teaser, a small stats row and the version-registry strip.
 *
 * The grid is category-driven (decisions-v2 O13.3): its cards are real
 * `[[Category:…]]` categories with live member counts, ordered by the
 * `home_categories` site setting when set and by count otherwise, capped at
 * eight, with `/special/categories` one link away. Nothing on this page is a
 * registry — a page in no category is still a page.
 *
 * Server component; every read goes through the frozen data loader
 * `loadHomeView` (src/lib/wiki/read-view.ts).
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CategoryGrid } from "@/components/wiki/category-grid";
import { RecentChangesTeaser } from "@/components/wiki/recent-changes-teaser";
import { getDb } from "@/lib/db/client";
import { getDictionary } from "@/lib/i18n";
import { isKnownUrlLocale } from "@/lib/locale-path";
import { homeViewLabels, loadHomeView } from "@/lib/wiki/read-view";

export const dynamic = "force-dynamic";

export interface HomePageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: HomePageProps): Promise<Metadata> {
  const { locale: rawLocale } = await params;
  const dict = getDictionary(decodeURIComponent(rawLocale).toLowerCase());
  return { description: dict.home.description };
}

/** The hero heading with its LAST word in the `--grad-b-*` gradient. */
function GradientHeadline({ text }: { text: string }) {
  const space = text.lastIndexOf(" ");
  const lead = space === -1 ? "" : text.slice(0, space + 1);
  const accent = space === -1 ? text : text.slice(space + 1);
  return (
    <h1 className="text-4xl font-semibold tracking-[-0.04em] text-ink sm:text-5xl">
      {lead}
      <span className="grad-text-b">{accent}</span>
    </h1>
  );
}

export default async function HomePage({ params }: HomePageProps) {
  const { locale: rawLocale } = await params;
  const locale = decodeURIComponent(rawLocale).toLowerCase();
  // `/[locale]` is the only route a non-locale root segment can match, and the
  // middleware hands the app the static-asset paths it skips (`/robots.txt`,
  // `/favicon.ico`) untouched — without this guard they render the home page
  // with HTTP 200, because the layout's own notFound() loses the race with a
  // page that has already started streaming (O12 rule 2).
  if (!isKnownUrlLocale(locale)) notFound();

  const view = loadHomeView({ db: getDb(), locale });
  const labels = homeViewLabels(locale, getDictionary(locale));

  const stats: { label: string; value: number }[] = [
    { label: labels.statsPages, value: view.stats.pages },
    { label: labels.statsTranslations, value: view.stats.translations },
    { label: labels.statsVersions, value: view.stats.versions },
  ];

  return (
    <div className="flex flex-col gap-14 py-6">
      {/* Hero — theme.md "Hero" */}
      <section className="flex flex-col items-center gap-5 text-center">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-mute">{labels.eyebrow}</p>
        <GradientHeadline text={labels.headline} />
        <p className="max-w-xl text-base text-mute">{labels.description}</p>

        <form
          action={view.searchAction}
          method="get"
          role="search"
          className="flex w-full max-w-xl gap-2"
        >
          <Input
            type="search"
            name="q"
            aria-label={labels.searchLabel}
            placeholder={labels.searchPlaceholder}
            className="h-11"
          />
          <Button type="submit" size="lg">
            {labels.searchSubmit}
          </Button>
        </form>

        <dl className="flex flex-wrap items-center justify-center gap-x-8 gap-y-2">
          {stats.map((stat) => (
            <div key={stat.label} className="flex items-baseline gap-2">
              <dd className="font-mono text-sm font-medium text-ink">{stat.value}</dd>
              <dt className="text-[13px] text-mute">{stat.label}</dt>
            </div>
          ))}
        </dl>
      </section>

      {/* Category grid — decisions-v2 O13.3: real categories, live counts */}
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold tracking-[-0.02em] text-ink">
              {labels.categoriesTitle}
            </h2>
            <p className="mt-1 text-sm text-mute">{labels.categoriesDescription}</p>
          </div>
          <Link
            href={view.allCategoriesHref}
            className="focus-ring rounded-[2px] text-sm text-link hover:underline"
          >
            {labels.browseAllCategories}
          </Link>
        </div>
        <CategoryGrid
          categories={view.categories}
          emptyLabel={labels.emptyCategories}
          countLabel={labels.categoryPageCount}
        />
      </section>

      {/* Recent changes teaser */}
      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-[-0.02em] text-ink">
            {labels.recentTitle}
          </h2>
          <p className="mt-1 text-sm text-mute">{labels.recentDescription}</p>
        </div>
        <RecentChangesTeaser
          locale={locale}
          changes={view.recentChanges}
          viewAllHref={view.recentChangesHref}
          labels={labels}
        />
      </section>

      {/* Version registry strip — versioning.md §1/§6 */}
      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-[-0.02em] text-ink">
            {labels.versionsTitle}
          </h2>
          <p className="mt-1 text-sm text-mute">{labels.versionsDescription}</p>
        </div>
        <ul className="flex flex-wrap gap-2">
          {view.versions.map((version) => {
            const isDefault = version.id === view.defaultVersion;
            return (
              <li key={version.id}>
                <Link
                  href={view.versionHref(version.id)}
                  className={`focus-ring inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-xs transition-colors ${
                    isDefault
                      ? "border-transparent bg-primary text-on-primary"
                      : "border-hairline bg-surface text-mute hover:bg-canvas-soft-2 hover:text-ink"
                  }`}
                >
                  {version.label}
                  {isDefault ? (
                    <span className="text-[10px] uppercase tracking-wide">{labels.defaultBadge}</span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
