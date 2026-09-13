/**
 * Read-view data loaders — everything the two anonymous read routes
 * (`/[locale]` and `/[locale]/wiki/[...title]`) need, extracted from the page
 * components so it is testable without React.
 *
 * Normative sources:
 * - docs/engine/routes.md — Pages table rows `/` and `/wiki/[...title]`
 * - docs/engine/decisions.md O1 (pathToTitle / articlePath), O3 (nav
 *   categories), O4 (EN fallback + "original" translations)
 * - docs/engine/decisions-v2.md O12 (locale-optional URLs)
 * - docs/engine/versioning.md §6 (selector, `?v=` propagation)
 *
 * The routes only turn these plain objects into JSX; every database read lives
 * here. Every *URL* comes from src/lib/locale-path.ts (O12) — the href helpers
 * below are re-exports so the read views keep one import site.
 */

import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import type { WikiDb } from "@/lib/db/client";
import {
  categoryMembers,
  HOME_CATEGORIES_KEY,
  listCategoriesWithCounts,
  outdatedTranslations,
  pageLanguages,
  recentChanges,
  type CategoryCountRow,
} from "@/lib/db/queries";
import { categoryLinks, pageLocales, pages, type Namespace } from "@/lib/db/schema";
import { getSetting, listNavCategories, loadVersionTable } from "@/lib/db/store";
import { dateTimeFormat, type Dictionary, type Locale } from "@/lib/i18n";
import {
  articleHref,
  editHref,
  historyHref,
  localePath,
  searchHref,
  specialHref,
  whatLinksHereHref,
  withQuery,
} from "@/lib/locale-path";
import { humanizeSlug, pathToTitle, slugifyTitle } from "@/lib/title";
import type { PageMeta, TocEntry, VersionEntry } from "@/lib/wikitext/types";

import { renderPage, type RenderedRevision } from "./service";

/* ------------------------------------------------------------------ */
/* URLs (decisions O1 + decisions-v2 O12)                              */
/* ------------------------------------------------------------------ */

/**
 * The URL scheme lives in src/lib/locale-path.ts — English is prefix-free,
 * every other locale prefixes (O12). These re-exports keep the read views and
 * the article chrome importing their hrefs from one place; nothing here (or
 * anywhere else) builds a locale URL by string concatenation.
 */
export {
  articleHref,
  editHref,
  historyHref,
  titlePathSegment,
  whatLinksHereHref,
  withQuery,
} from "@/lib/locale-path";

/**
 * The `?v=` every outgoing link must carry — versioning.md §6 "Reader
 * affordances", one rule for the article HTML (`propagateVersion` below) and
 * for the chrome links the route builds.
 *
 * `undefined` means "nothing to carry": the reader is on the site default, so
 * clean URLs stay clean. The rule deliberately does NOT consult
 * `versionScoped`. A version choice is a reading preference for the whole wiki
 * — that is why it lives in the query string rather than in the page — so a
 * page with no version markup is a page that has nothing version-specific to
 * *show*, never a page that may swallow the selection on the way out. Doing
 * that once dropped a reader browsing at v56 back to the site default for the
 * rest of their session, which is the complaint this rule exists to answer.
 */
export function carriedVersion(selected: string, defaultVersion: string): string | undefined {
  return selected === defaultVersion ? undefined : selected;
}

/**
 * versioning.md §6 "Reader affordances": a non-default `?v=` must survive
 * internal navigation. The engine renderer does NOT append it — its hrefs come
 * straight from `config.articlePath` (see `buildWikiLinkHref` in
 * src/lib/wikitext/links.ts, which only ever substitutes `$1` and a fragment),
 * and the engine is frozen. So the read view rewrites the article HTML here,
 * server-side, before it reaches <WikiHtml>: no-JS readers keep their
 * selection too.
 *
 * Only article hrefs for the rendering locale are touched — `/wiki/…` in
 * English, `/{locale}/wiki/…` elsewhere (O12), taken from `localePath` so the
 * prefix matches whatever `config.articlePath` emitted. External links, media
 * and fragment-only self-anchors are left exactly as the engine wrote them,
 * and an href that already carries `v=` is never rewritten.
 */
export function propagateVersion(html: string, locale: Locale, version: string): string {
  const prefix = localePath(locale, "/wiki/");
  return html.replace(/href="([^"]*)"/g, (match, raw: string) => {
    if (!raw.startsWith(prefix)) return match;
    const hashAt = raw.indexOf("#");
    const hash = hashAt === -1 ? "" : raw.slice(hashAt);
    const base = hashAt === -1 ? raw : raw.slice(0, hashAt);
    const queryAt = base.indexOf("?");
    const path = queryAt === -1 ? base : base.slice(0, queryAt);
    const search = new URLSearchParams(queryAt === -1 ? "" : base.slice(queryAt + 1));
    if (search.has("v")) return match;
    search.set("v", version);
    // A bare `&` inside an HTML attribute value is written as an entity.
    return `href="${path}?${search.toString().replace(/&/g, "&amp;")}${hash}"`;
  });
}

/* ------------------------------------------------------------------ */
/* Small HTML helpers                                                  */
/* ------------------------------------------------------------------ */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  rarr: "→",
  hellip: "…",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Tag-stripped, whitespace-collapsed text of an HTML fragment. */
export function htmlToText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * SEO description: the first paragraph of the rendered article that carries
 * real prose (infobox and notice paragraphs are short), trimmed to `limit`.
 */
export function firstParagraphText(html: string, limit = 200): string {
  const paragraphs = html.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) ?? [];
  let best = "";
  for (const paragraph of paragraphs) {
    const text = htmlToText(paragraph);
    if (text.length >= 60) {
      best = text;
      break;
    }
    if (text.length > best.length) best = text;
  }
  if (best.length <= limit) return best;
  const cut = best.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/* ------------------------------------------------------------------ */
/* Shared title lookups                                                */
/* ------------------------------------------------------------------ */

/** Display title per page id, preferring `locale` and falling back to EN. */
function titlesForPages(db: WikiDb, pageIds: number[], locale: Locale): Map<number, string> {
  const titles = new Map<number, string>();
  if (pageIds.length === 0) return titles;
  const rows = db
    .select({
      pageId: pageLocales.pageId,
      locale: pageLocales.locale,
      title: pageLocales.title,
    })
    .from(pageLocales)
    .where(inArray(pageLocales.pageId, pageIds))
    .all();
  const fallback = new Map<number, string>();
  for (const row of rows) {
    if (row.locale === locale) titles.set(row.pageId, row.title);
    else if (row.locale === "en") fallback.set(row.pageId, row.title);
  }
  for (const [pageId, title] of fallback) if (!titles.has(pageId)) titles.set(pageId, title);
  return titles;
}

export interface PageRefView {
  namespace: Namespace;
  slug: string;
  title: string;
  href: string;
}

function toPageRefs(
  rows: { pageId: number; namespace: Namespace; slug: string }[],
  titles: Map<number, string>,
  locale: Locale,
): PageRefView[] {
  return rows.map((row) => ({
    namespace: row.namespace,
    slug: row.slug,
    title: titles.get(row.pageId) ?? humanizeSlug(row.slug),
    href: articleHref(locale, row.namespace, row.slug),
  }));
}

/** Member listing of one category slug — used on both written and red-link category pages. */
function buildCategoryListing(db: WikiDb, categorySlug: string, locale: Locale) {
  const listing = categoryMembers(db, categorySlug);
  const ids = [...listing.subcategories, ...listing.members].map((row) => row.pageId);
  const titles = titlesForPages(db, ids, locale);
  return {
    subcategories: toPageRefs(listing.subcategories, titles, locale),
    members: toPageRefs(listing.members, titles, locale),
  };
}

/**
 * `[[Category:…]]` membership of one page, read from `category_links` (written
 * from the canonical EN parse) rather than from `meta` — a cache hit returns
 * no `meta` at all (service.ts `RenderedPage.meta`).
 */
export function categoriesOfPage(db: WikiDb, pageId: number, locale: Locale): PageRefView[] {
  const links = db
    .select({ slug: categoryLinks.categorySlug, sortKey: categoryLinks.sortKey })
    .from(categoryLinks)
    .where(eq(categoryLinks.pageId, pageId))
    .orderBy(categoryLinks.sortKey, categoryLinks.categorySlug)
    .all();
  if (links.length === 0) return [];

  const slugs = links.map((link) => link.slug);
  const categoryPages = db
    .select({ id: pages.id, slug: pages.slug })
    .from(pages)
    .where(and(eq(pages.namespace, "category"), inArray(pages.slug, slugs)))
    .all();
  const titles = titlesForPages(
    db,
    categoryPages.map((row) => row.id),
    locale,
  );
  const titleBySlug = new Map<string, string>();
  for (const row of categoryPages) {
    const title = titles.get(row.id);
    if (title !== undefined) titleBySlug.set(row.slug, title);
  }

  return links.map((link) => ({
    namespace: "category" as Namespace,
    slug: link.slug,
    title: titleBySlug.get(link.slug) ?? humanizeSlug(link.slug),
    href: articleHref(locale, "category", link.slug),
  }));
}

/* ------------------------------------------------------------------ */
/* Home view (routes.md: hero, categories, recent changes, search)     */
/* ------------------------------------------------------------------ */

export interface HomeCategoryView {
  slug: string;
  /** `categories` metadata label → `Category:` page title → humanized slug. */
  label: string;
  description: string | null;
  href: string;
  /** Live `category_links` membership count (decisions-v2 O13.3). */
  count: number;
  /** False ⇒ nobody has written the `Category:` description page yet. */
  hasPage: boolean;
}

export interface HomeChangeView {
  revId: number;
  title: string;
  href: string;
  historyHref: string;
  locale: string;
  authorName: string;
  comment: string;
  isMinor: boolean;
  createdAt: Date;
}

export interface HomeView {
  locale: Locale;
  /**
   * Real categories with live member counts (decisions-v2 O13.3): ordered by
   * the `home_categories` site setting when set, else by count descending,
   * capped at `HOME_CATEGORY_LIMIT`.
   */
  categories: HomeCategoryView[];
  /** `/special/categories` — the full browse index (O13.3/O13.4). */
  allCategoriesHref: string;
  recentChanges: HomeChangeView[];
  recentChangesHref: string;
  /** Whole registry, ordinal-ascending (versioning.md §1). */
  versions: VersionEntry[];
  defaultVersion: string;
  /** GET target of the hero search box. */
  searchAction: string;
  /** Per-version link target of the registry chips (versioning.md §6). */
  versionHref: (id: string) => string;
  stats: { pages: number; translations: number; versions: number };
}

/** Pick the localized label, falling back to the base language, then EN. */
function localized(labels: Record<string, string>, locale: Locale): string {
  return labels[locale] ?? labels[locale.split("-")[0] ?? ""] ?? labels.en ?? "";
}

/** decisions-v2 O13.3: at most eight cards on the home grid. */
export const HOME_CATEGORY_LIMIT = 8;

/**
 * decisions-v2 O13.3 ordering. `pinned` is the `home_categories` site setting
 * — a JSON array of category slugs. When it holds at least one slug that
 * really exists, it *is* the order (unknown slugs are dropped: the setting is
 * a curation hint, never a source of phantom categories, and a page with no
 * category still exists and is reachable). Otherwise the natural order wins,
 * which `listCategoriesWithCounts` already returns: count descending, then
 * slug. Either way the list is capped at `limit`.
 */
export function orderHomeCategories<T extends { slug: string }>(
  rows: readonly T[],
  pinned: readonly string[] | null,
  limit: number = HOME_CATEGORY_LIMIT,
): T[] {
  if (pinned && pinned.length > 0) {
    const bySlug = new Map(rows.map((row) => [row.slug, row]));
    const picked = pinned
      .map((slug) => bySlug.get(slug))
      .filter((row): row is T => row !== undefined);
    if (picked.length > 0) return picked.slice(0, limit);
  }
  return rows.slice(0, limit);
}

/** The `home_categories` setting, coerced to a slug array (null when unset). */
export function readHomeCategorySetting(db: WikiDb): string[] | null {
  const raw = getSetting<unknown>(db, HOME_CATEGORIES_KEY);
  if (!Array.isArray(raw)) return null;
  const slugs = raw.filter((value): value is string => typeof value === "string" && value !== "");
  return slugs.length > 0 ? slugs : null;
}

/**
 * Home cards from REAL membership (O13.3). The `categories` metadata row is
 * optional decoration (O13.6): it supplies a nicer label and a description
 * when present, and its absence is normal — the `Category:` page title, then
 * the humanized slug, stand in.
 */
function buildHomeCategories(db: WikiDb, locale: Locale, limit: number): HomeCategoryView[] {
  const counts = listCategoriesWithCounts(db, locale);
  const meta = new Map(listNavCategories(db).map((row) => [row.slug, row]));
  const selected = orderHomeCategories(counts, readHomeCategorySetting(db), limit);
  return selected.map((row: CategoryCountRow) => {
    const decoration = meta.get(row.slug);
    const label = decoration ? localized(decoration.labels, locale) : "";
    return {
      slug: row.slug,
      label: label || row.pageTitle || humanizeSlug(row.slug),
      description:
        decoration?.description ? localized(decoration.description, locale) || null : null,
      href: articleHref(locale, "category", row.slug),
      count: row.total,
      hasPage: row.hasPage,
    };
  });
}

export function loadHomeView(input: {
  db: WikiDb;
  locale: Locale;
  recentLimit?: number;
  /** Cards on the home grid; defaults to `HOME_CATEGORY_LIMIT` (O13.3). */
  categoryLimit?: number;
}): HomeView {
  const { db, locale } = input;
  const versions = loadVersionTable(db);

  const categories = buildHomeCategories(db, locale, input.categoryLimit ?? HOME_CATEGORY_LIMIT);

  const changes: HomeChangeView[] = recentChanges(db, {
    limit: input.recentLimit ?? 6,
  }).rows.map((row) => ({
    revId: row.revId,
    title: row.title,
    href: articleHref(locale, row.namespace, row.slug),
    historyHref: historyHref(locale, row.namespace, row.slug),
    locale: row.locale,
    authorName: row.authorName,
    comment: row.comment,
    isMinor: row.isMinor,
    createdAt: row.createdAt,
  }));

  const counted = db.all<{ pages: number; translations: number }>(sql`
    select (select count(*) from pages) as "pages",
           (select count(*) from page_locales where current_rev_id is not null)
             as "translations"
  `);

  return {
    locale,
    categories,
    allCategoriesHref: specialHref(locale, "categories"),
    recentChanges: changes,
    recentChangesHref: specialHref(locale, "recent-changes"),
    versions: versions.ordered,
    defaultVersion: versions.defaultId,
    searchAction: searchHref(locale),
    // versioning.md §6 routes: the per-version coverage report is the only
    // "what changed for this release" surface in the route map.
    versionHref: (id: string) => withQuery(specialHref(locale, "version-coverage"), { v: id }),
    stats: {
      pages: counted[0]?.pages ?? 0,
      translations: counted[0]?.translations ?? 0,
      versions: versions.ordered.length,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Article view (routes.md `/wiki/[...title]`)                         */
/* ------------------------------------------------------------------ */

export interface ArticleTranslationView {
  locale: string;
  title: string;
  href: string;
  isCurrent: boolean;
}

export interface ArticleViewInput {
  db: WikiDb;
  locale: Locale;
  /** The `[...title]` catch-all value (decisions O1). */
  segments: string | string[];
  /** `?v=` — unknown ids fall back to the site default (versioning.md §6). */
  version?: string | null;
  /** `?rev=` — renders an old revision, never cached. */
  revId?: number;
  /** `?redirect=no` ⇒ false. */
  followRedirect?: boolean;
  now?: Date;
}

/** The catch-all did not resolve to a storable (namespace, slug) — a 404. */
export interface InvalidTitleView {
  kind: "invalid";
}

/**
 * No head in any locale — the page does not exist yet.
 *
 * decisions-v2 **O14**: this is the create flow, not a dead end. A visitor who
 * may edit gets the editor for this title rendered inline (the route seeds it
 * from `loadEditorView`, src/lib/wiki/edit-view.ts, so `/wiki/<missing>` and
 * `/edit/<missing>` render the same editor state); a visitor who may not gets
 * the classic "no text in this page" notice, which still carries `signInHref`
 * and `paths.edit`.
 */
export interface MissingArticleView {
  kind: "missing";
  namespace: Namespace;
  slug: string;
  /** Best-effort display name for a page nobody has written yet. */
  title: string;
  locale: Locale;
  paths: ArticlePaths;
  /** O14.2: where the "may not edit" notice's sign-in CTA points. */
  signInHref: string;
  /**
   * routes.md: `category:` pages append their member listing even when the
   * category page itself has not been written (memberships come from
   * `[[Category:…]]` tags on other pages). Null off the category namespace
   * or when the category has no members.
   */
  categoryListing: CategoryListingView | null;
}

export interface CategoryListingView {
  subcategories: PageRefView[];
  members: PageRefView[];
}

export interface ArticlePaths {
  article: string;
  edit: string;
  history: string;
  whatLinksHere: string;
}

export interface ArticleView {
  kind: "article";
  locale: Locale;
  /** Locale actually rendered — differs on EN fallback (decisions O4). */
  usedLocale: string;
  fallbackFromEn: boolean;
  namespace: Namespace;
  slug: string;
  /** Plain-text title (`page_locales.title`). */
  title: string;
  /** `{{DISPLAYTITLE:}}` override — sanitized HTML; null on a cache hit. */
  displayTitleHtml: string | null;
  /** Article HTML with the reader's `?v=` propagated into internal links. */
  html: string;
  toc: TocEntry[];
  meta: PageMeta | null;
  cached: boolean;
  revision: RenderedRevision;
  updatedAt: Date;
  redirectedFrom: { title: string; href: string } | null;
  categories: PageRefView[];
  translations: ArticleTranslationView[];
  /**
   * Non-EN renderings only. `outdated` ⇒ the EN head moved past this
   * translation's basis; `original` is decisions O4's NULL-basis case, badged
   * "original" and never "outdated".
   */
  translationStatus: { outdated: boolean; original: boolean } | null;
  versionScoped: boolean;
  versionBoundaries: string[];
  availableVersions: VersionEntry[];
  selectedVersion: string;
  defaultVersion: string;
  /**
   * Reader asked for a version outside the registry (§6: fall back, warn).
   * Its sibling — "you passed `?v=` on a page with no version constructs" —
   * is not a view flag any more: <VersionSelector> renders on every article
   * and says it in its compact form, beside the control that can change it.
   */
  unknownVersionRequested: string | null;
  /** `category:` namespace only — the member listing appended to the page. */
  categoryListing: CategoryListingView | null;
  paths: ArticlePaths;
  /** Query params selector links must carry (`rev`, `redirect`). */
  carryQuery: Record<string, string>;
  description: string;
}

export type ArticlePageView = InvalidTitleView | MissingArticleView | ArticleView;

/**
 * The single loader behind `/[locale]/wiki/[...title]`. Resolves the catch-all
 * (O1), renders through the render service (redirect follow, EN fallback,
 * cache and version selection all live there), then decorates the result with
 * the view-only data the article chrome needs.
 */
export function loadArticleView(input: ArticleViewInput): ArticlePageView {
  const { db, locale } = input;
  const parsed = pathToTitle(input.segments);
  if (!parsed) return { kind: "invalid" };

  const namespace: Namespace = parsed.nsName;
  const slug = slugifyTitle(parsed.slug) || parsed.slug;

  const rendered = renderPage({
    db,
    namespace,
    slug,
    locale,
    version: input.version ?? null,
    revId: input.revId,
    followRedirect: input.followRedirect,
    now: input.now,
  });

  if (!rendered) {
    // An unwritten category page still lists its members (routes.md), but an
    // empty listing would just clutter the red-link landing — keep it null.
    let missingListing: CategoryListingView | null = null;
    if (namespace === "category") {
      const listing = buildCategoryListing(db, slug, locale);
      if (listing.subcategories.length > 0 || listing.members.length > 0) {
        missingListing = listing;
      }
    }
    return {
      kind: "missing",
      namespace,
      slug,
      title: humanizeSlug(slug),
      locale,
      paths: {
        article: articleHref(locale, namespace, slug),
        edit: editHref(locale, namespace, slug),
        history: historyHref(locale, namespace, slug),
        whatLinksHere: whatLinksHereHref(locale, namespace, slug),
      },
      signInHref: localePath(locale, "/login"),
      categoryListing: missingListing,
    };
  }

  const target = rendered.page;
  const versionTable = loadVersionTable(db);
  const requested = input.version?.trim();
  const unknownVersionRequested = requested && !versionTable.byId[requested] ? requested : null;

  // §6: the reader's selection rides along on every internal link this page
  // renders, whether or not the page itself branches — an unscoped article is
  // a stop on the way, not the end of the session. Unknown ids never travel:
  // `selectedVersion` is the resolved one (service.resolveVersion), so a
  // bookmarked `?v=v99` falls back to the default and carries nothing.
  const carried = carriedVersion(rendered.selectedVersion, versionTable.defaultId);
  const html =
    carried === undefined
      ? rendered.html
      : // The article HTML carries the *served* locale's `articlePath`
        // (service.ts keys the cache on `usedLocale`), so an EN-fallback view
        // must be rewritten with the EN prefix, not the requested one.
        propagateVersion(rendered.html, rendered.usedLocale, carried);

  const translations: ArticleTranslationView[] = pageLanguages(db, target.id).map((row) => ({
    locale: row.locale,
    title: row.title,
    href: articleHref(row.locale, target.namespace, target.slug),
    isCurrent: row.locale === rendered.usedLocale,
  }));

  let translationStatus: ArticleView["translationStatus"] = null;
  if (rendered.usedLocale !== "en") {
    const row = outdatedTranslations(db, { pageId: target.id }).find(
      (candidate) => candidate.locale === rendered.usedLocale,
    );
    if (row) {
      translationStatus = { outdated: row.basedOnRev !== null, original: row.basedOnRev === null };
    }
  }

  const categoryListing =
    target.namespace === "category" ? buildCategoryListing(db, target.slug, locale) : null;

  const carryQuery: Record<string, string> = {};
  if (input.revId !== undefined) carryQuery.rev = String(input.revId);
  if (input.followRedirect === false) carryQuery.redirect = "no";

  return {
    kind: "article",
    locale,
    usedLocale: rendered.usedLocale,
    fallbackFromEn: rendered.fallbackFromEn,
    namespace: target.namespace,
    slug: target.slug,
    title: target.title,
    displayTitleHtml: rendered.meta?.displayTitle ?? null,
    html,
    toc: rendered.toc,
    meta: rendered.meta,
    cached: rendered.cached,
    revision: rendered.revision,
    updatedAt: target.updatedAt,
    redirectedFrom: rendered.redirectedFrom
      ? {
          title: rendered.redirectedFrom.title,
          // `?redirect=no` shows the redirect page itself (routes.md), and the
          // reader's version rides along like everywhere else (versioning.md §6).
          href: withQuery(
            articleHref(locale, rendered.redirectedFrom.namespace, rendered.redirectedFrom.slug),
            {
              redirect: "no",
              v: carriedVersion(rendered.selectedVersion, versionTable.defaultId),
            },
          ),
        }
      : null,
    categories: categoriesOfPage(db, target.id, locale),
    translations,
    translationStatus,
    versionScoped: rendered.versionScoped,
    versionBoundaries: rendered.versionBoundaries,
    availableVersions: rendered.availableVersions,
    selectedVersion: rendered.selectedVersion,
    defaultVersion: versionTable.defaultId,
    unknownVersionRequested,
    categoryListing,
    paths: {
      article: articleHref(locale, target.namespace, target.slug),
      edit: editHref(locale, target.namespace, target.slug),
      history: historyHref(locale, target.namespace, target.slug),
      whatLinksHere: whatLinksHereHref(locale, target.namespace, target.slug),
    },
    carryQuery,
    description: firstParagraphText(rendered.html),
  };
}

/* ------------------------------------------------------------------ */
/* Search-param parsing (routes.md query contract)                     */
/* ------------------------------------------------------------------ */

export type RawSearchParams = Record<string, string | string[] | undefined>;

export function firstParam(params: RawSearchParams, key: string): string | undefined {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

export interface ArticleQuery {
  version: string | null;
  revId: number | undefined;
  followRedirect: boolean;
}

/** `?v=`, `?rev=`, `?redirect=no` (routes.md + versioning.md §6). */
export function parseArticleQuery(params: RawSearchParams): ArticleQuery {
  const version = firstParam(params, "v")?.trim().toLowerCase() || null;
  const rawRev = firstParam(params, "rev");
  const revId = rawRev !== undefined && /^\d+$/.test(rawRev) ? Number(rawRev) : undefined;
  return {
    version,
    revId,
    followRedirect: firstParam(params, "redirect") !== "no",
  };
}

/* ------------------------------------------------------------------ */
/* Labels — read views only (view-labels.ts covers the salvaged pages) */
/* ------------------------------------------------------------------ */

function pick<T>(locale: Locale, ko: T, en: T): T {
  return locale.toLowerCase().startsWith("ko") ? ko : en;
}

export function homeViewLabels(locale: Locale, dictionary: Dictionary) {
  return {
    eyebrow: pick(locale, "커뮤니티 버전 위키", "Community version wiki"),
    wordmark: "HIGH QUOTA WIKI",
    headline: dictionary.home.title,
    description: dictionary.home.description,
    searchLabel: dictionary.search.label,
    searchPlaceholder: dictionary.search.placeholder,
    searchSubmit: dictionary.search.submit,
    categoriesTitle: dictionary.home.browseCategories,
    categoriesDescription: dictionary.home.categoriesDescription,
    browseAllCategories: dictionary.home.browseAllCategories,
    categoryPageCount: dictionary.home.categoryPageCount,
    recentTitle: dictionary.home.recentChanges,
    recentDescription: pick(
      locale,
      "모든 편집과 복원은 리비전으로 기록됩니다.",
      "Every edit and restore is recorded as a revision.",
    ),
    recentAll: dictionary.navigation.recentChanges,
    emptyChanges: dictionary.home.noRecentChanges,
    emptyCategories: dictionary.home.noCategories,
    versionsTitle: dictionary.version.title,
    versionsDescription: pick(
      locale,
      "게임 버전을 고르면 그 버전이 적용된 문서 목록을 볼 수 있습니다.",
      "Pick a release to see the articles that changed for it.",
    ),
    defaultBadge: dictionary.version.defaultBadge,
    statsPages: dictionary.search.pages,
    statsTranslations: pick(locale, "페이지 번역", "Page translations"),
    statsVersions: dictionary.version.title,
    minor: pick(locale, "사소한 편집", "minor"),
  };
}

export function articleViewLabels(locale: Locale, dictionary: Dictionary) {
  return {
    edit: dictionary.wiki.edit,
    history: dictionary.wiki.history,
    translate: dictionary.wiki.translatePage,
    tocHide: pick(locale, "숨기기", "hide"),
    tocShow: pick(locale, "보기", "show"),
    categories: pick(locale, "분류", "Categories"),
    noCategories: pick(locale, "분류가 없습니다.", "This page is in no categories."),
    lastEdited: pick(locale, "마지막 편집", "Last edited"),
    by: pick(locale, "편집자", "by"),
    whatLinksHere: pick(locale, "여기를 가리키는 문서", "What links here"),
    revisionLabel: pick(locale, "리비전", "Revision"),
    fallbackTitle: dictionary.wiki.missingTranslationTitle,
    fallbackDescription: dictionary.wiki.missingTranslationDescription,
    oldRevisionTitle: pick(locale, "과거 리비전입니다", "You are viewing an old revision"),
    oldRevisionDescription: pick(
      locale,
      "이 문서의 최신 판이 아닙니다.",
      "This is not the current version of this page.",
    ),
    oldRevisionAction: pick(locale, "최신 판 보기", "View the current revision"),
    redirectedFrom: pick(locale, "다음에서 넘어옴", "Redirected from"),
    outdatedTitle: pick(locale, "원문이 변경되었습니다", "The source article changed"),
    outdatedDescription: pick(
      locale,
      "이 번역은 최신 영어 원문보다 오래되었습니다.",
      "This translation is older than the current English article.",
    ),
    outdatedAction: pick(locale, "번역 갱신", "Update this translation"),
    originalTitle: pick(locale, "원본 문서", "Original article"),
    originalDescription: pick(
      locale,
      "이 문서는 번역이 아니라 이 언어로 직접 작성되었습니다.",
      "This page was written in this language rather than translated.",
    ),
    unknownVersionTitle: pick(locale, "알 수 없는 게임 버전", "Unknown game version"),
    unknownVersionDescription: pick(
      locale,
      "요청한 버전이 등록되어 있지 않아 기본 버전으로 표시합니다.",
      "That version is not in the registry, so the default one is shown.",
    ),
    missingTitle: dictionary.wiki.pageNotFoundTitle,
    missingDescription: dictionary.wiki.pageNotFoundDescription,
    // O14.2 — the classic notice shown when the visitor may not edit.
    noTextTitle: dictionary.wiki.noTextTitle,
    noTextDescription: dictionary.wiki.noTextDescription,
    signIn: dictionary.common.signIn,
    createAction: dictionary.wiki.createPage,
    subcategories: pick(locale, "하위 분류", "Subcategories"),
    members: pick(locale, "이 분류에 속한 문서", "Pages in this category"),
    emptyCategory: pick(locale, "이 분류에는 문서가 없습니다.", "This category is empty."),
    version: dictionary.version.label,
    // The image viewer (wiki-html.tsx → ImageZoom): a clicked photo opens full
    // size here instead of following its `File:` link into the create view.
    imageViewer: dictionary.wiki.imageViewer,
    imageViewerFilePage: dictionary.wiki.imageViewerFilePage,
    close: dictionary.common.close,

    /* — the branch chip row, shared with the editor (versioning.md §6) —
       No "latest is …", no reset link: the site default decides what a URL
       with no `?v=` renders and nothing else, so the article never names it
       as the version the reader has strayed from (§6). */
    versionBoundariesTitle: dictionary.version.boundaries,
    versionUnregistered: dictionary.version.unregistered,
    versionShowingBranch: dictionary.version.showingBranch,
  };
}

export type ArticleViewLabels = ReturnType<typeof articleViewLabels>;
export type HomeViewLabels = ReturnType<typeof homeViewLabels>;

/** Shared date formatting for the read views (UTC — deterministic output). */
export function formatDateTime(locale: Locale, value: Date): string {
  return dateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value);
}
