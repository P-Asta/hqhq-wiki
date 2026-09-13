/**
 * Read-side query patterns (docs/engine/db-schema.md §D 1, 3–10, 12, 14 +
 * Addenda A3/A7/A8, decisions O4/O7, versioning.md §4).
 *
 * All reads are synchronous. Keyset pagination on `revisions.id` everywhere —
 * rev ids are monotonic, so they double as the global change order. Write
 * paths live in ./store.
 */

import { and, desc, eq, isNotNull, lt, ne, sql } from "drizzle-orm";

import { slugifyTitle } from "@/lib/title";

import type { WikiDb } from "./client";
import {
  DEFAULT_VERSION_KEY,
  getSetting,
  type Db,
} from "./store";
import {
  auditLog,
  categoryLinks,
  files,
  languages,
  pageLinks,
  pageLocales,
  pages,
  reports,
  parsedCache,
  revisions,
  templateLinks,
  users,
  type Namespace,
} from "./schema";

/* ------------------------------------------------------------------ */
/* 1. Page view (ns, slug, locale) — EN fallback + one-hop redirect    */
/* ------------------------------------------------------------------ */

export interface PageViewInput {
  namespace: Namespace;
  slug: string;
  locale: string;
  /** Reader's `?v=` selection; null/undefined = site default. */
  version?: string | null;
  /** Default true; `?redirect=no` passes false (routes.md). */
  followRedirect?: boolean;
}

export interface RedirectTarget {
  namespace: Namespace;
  slug: string;
  fragment: string | null;
}

export interface PageViewPage {
  kind: "page";
  pageId: number;
  namespace: Namespace;
  slug: string;
  /** Locale actually served — may differ from the request (EN fallback). */
  servedLocale: string;
  /** True when the requested locale had no head and EN was used instead. */
  fallbackFromEn: boolean;
  title: string;
  revId: number;
  pageLocaleId: number;
  updatedAt: Date;
  versionScoped: boolean;
  versionBoundaries: string[];
  /** parsed_cache key for this view: `"*"` or the selected version id. */
  cacheVersion: string;
  /** Cached HTML when fresh; null ⇒ caller renders and calls cacheParsedHtml. */
  html: string | null;
}

export type PageView =
  | { kind: "missing"; namespace: Namespace; slug: string }
  | { kind: "redirect"; pageId: number; to: RedirectTarget }
  | PageViewPage;

/**
 * db-schema §D pattern 1. Redirects are denormalized onto `pages`, so the
 * follow is O(1) and the caller resolves the target ONCE (one hop, like
 * MediaWiki) by calling again with `followRedirect: false`.
 *
 * A rev-id mismatch on the cache row means stale, so `html` comes back null
 * and the cache self-heals even if an invalidation was ever missed.
 */
export function getPageView(db: Db, input: PageViewInput): PageView {
  const slug = input.slug;
  const page = db
    .select()
    .from(pages)
    .where(and(eq(pages.namespace, input.namespace), eq(pages.slug, slug)))
    .get();
  if (!page) return { kind: "missing", namespace: input.namespace, slug };

  if (page.redirectSlug && page.redirectNs && input.followRedirect !== false) {
    return {
      kind: "redirect",
      pageId: page.id,
      to: {
        namespace: page.redirectNs,
        slug: page.redirectSlug,
        fragment: page.redirectFragment ?? null, // Addendum A2
      },
    };
  }

  const requested = db
    .select()
    .from(pageLocales)
    .where(and(eq(pageLocales.pageId, page.id), eq(pageLocales.locale, input.locale)))
    .get();
  const pl =
    requested?.currentRevId != null
      ? requested
      : db
          .select()
          .from(pageLocales)
          .where(and(eq(pageLocales.pageId, page.id), eq(pageLocales.locale, "en")))
          .get();
  if (!pl?.currentRevId) return { kind: "missing", namespace: input.namespace, slug };

  // versioning.md §4: unscoped pages are cached once under "*" and served for
  // every selection; scoped pages get one row per selected version.
  const cacheVersion = pl.versionScoped
    ? (input.version ?? getSetting<string>(db, DEFAULT_VERSION_KEY) ?? "*")
    : "*";

  const cached = db
    .select()
    .from(parsedCache)
    .where(
      and(
        eq(parsedCache.pageId, page.id),
        eq(parsedCache.locale, pl.locale),
        eq(parsedCache.version, cacheVersion),
      ),
    )
    .get();

  return {
    kind: "page",
    pageId: page.id,
    namespace: page.namespace,
    slug: page.slug,
    servedLocale: pl.locale,
    fallbackFromEn: pl.locale !== input.locale,
    title: pl.title,
    revId: pl.currentRevId,
    pageLocaleId: pl.id,
    updatedAt: pl.updatedAt,
    versionScoped: pl.versionScoped,
    versionBoundaries: parseBoundaries(pl.versionBoundaries),
    cacheVersion,
    html: cached && cached.revId === pl.currentRevId ? cached.html : null,
  };
}

function parseBoundaries(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Source + head metadata for the editor and `GET /api/pages/[...title]`. */
export function getPageSource(
  db: Db,
  input: { namespace: Namespace; slug: string; locale: string; revId?: number },
) {
  const page = db
    .select()
    .from(pages)
    .where(and(eq(pages.namespace, input.namespace), eq(pages.slug, input.slug)))
    .get();
  if (!page) return null;

  const pl = db
    .select()
    .from(pageLocales)
    .where(and(eq(pageLocales.pageId, page.id), eq(pageLocales.locale, input.locale)))
    .get();

  const revId = input.revId ?? pl?.currentRevId ?? null;
  const rev =
    revId === null
      ? null
      : (db
          .select()
          .from(revisions)
          .where(and(eq(revisions.id, revId), eq(revisions.pageId, page.id)))
          .get() ?? null);

  return {
    page,
    pageLocale: pl ?? null,
    revision: rev,
    isCurrent: rev !== null && pl?.currentRevId === rev.id,
  };
}

/** Locales that have a head for this page (language switcher / translate CTA). */
export function pageLanguages(db: Db, pageId: number) {
  return db
    .select({
      locale: pageLocales.locale,
      title: pageLocales.title,
      currentRevId: pageLocales.currentRevId,
      updatedAt: pageLocales.updatedAt,
      label: languages.label,
      nativeName: languages.nativeName,
      direction: languages.direction,
    })
    .from(pageLocales)
    .innerJoin(languages, eq(languages.code, pageLocales.locale))
    .where(and(eq(pageLocales.pageId, pageId), isNotNull(pageLocales.currentRevId)))
    .orderBy(pageLocales.locale)
    .all();
}

/* ------------------------------------------------------------------ */
/* 3. History — keyset on rev id (never OFFSET)                        */
/* ------------------------------------------------------------------ */

export interface Keyset {
  /** Return rows with id < cursor. */
  cursor?: number;
  limit?: number;
}

export function getHistory(db: Db, pageId: number, locale: string, opts: Keyset = {}) {
  const limit = opts.limit ?? 50;
  const rows = db
    .select({
      id: revisions.id,
      title: revisions.title,
      comment: revisions.comment,
      authorUid: revisions.authorUid,
      authorName: revisions.authorName,
      // The mirror's CURRENT ban state, not a snapshot — a chip that offered
      // "Ban" for an already-banned author could never lift one, and would
      // re-ban on every click.
      authorBanned: users.banned,
      isMinor: revisions.isMinor,
      parentRevId: revisions.parentRevId,
      translatedFromRevId: revisions.translatedFromRevId,
      createdAt: revisions.createdAt,
      bytes: sql<number>`length(${revisions.content})`,
    })
    .from(revisions)
    .leftJoin(users, eq(revisions.authorUid, users.uid))
    .where(
      and(
        eq(revisions.pageId, pageId),
        eq(revisions.locale, locale),
        opts.cursor ? lt(revisions.id, opts.cursor) : undefined,
      ),
    )
    .orderBy(desc(revisions.id))
    .limit(limit + 1)
    .all();
  const hasMore = rows.length > limit;
  return {
    rows: rows.slice(0, limit),
    nextCursor: hasMore ? rows[limit - 1].id : null,
  };
}

/* ------------------------------------------------------------------ */
/* 4. Diff pair                                                        */
/* ------------------------------------------------------------------ */

export function getDiffPair(db: Db, revId: number, againstId?: number) {
  const rev = db.select().from(revisions).where(eq(revisions.id, revId)).get();
  if (!rev) return null;
  const baseId = againstId ?? rev.parentRevId; // default: diff against parent
  const base = baseId
    ? (db.select().from(revisions).where(eq(revisions.id, baseId)).get() ?? null)
    : null; // page creation → diff against empty
  return { base, rev };
}

/* ------------------------------------------------------------------ */
/* 5. Recent changes (cross-locale, keyset)                            */
/* ------------------------------------------------------------------ */

export interface RecentChangesOptions extends Keyset {
  locale?: string;
  hideMinor?: boolean;
}

export function recentChanges(db: Db, opts: RecentChangesOptions = {}) {
  const limit = opts.limit ?? 50;
  // One row per (page, locale): the feed answers "what changed", and ten saves
  // to the same article in an afternoon is one thing that changed, not ten.
  // The minor filter goes INSIDE the correlated max as well, so hiding minor
  // edits surfaces a page's latest substantive revision instead of dropping the
  // page from the feed entirely.
  const latestPerPage = opts.hideMinor
    ? sql`${revisions.id} = (select max(r2.id) from revisions r2
        where r2.page_id = ${revisions.pageId} and r2.locale = ${revisions.locale}
          and r2.is_minor = 0)`
    : sql`${revisions.id} = (select max(r2.id) from revisions r2
        where r2.page_id = ${revisions.pageId} and r2.locale = ${revisions.locale})`;
  const rows = db
    .select({
      revId: revisions.id,
      locale: revisions.locale,
      title: revisions.title,
      comment: revisions.comment,
      isMinor: revisions.isMinor,
      authorUid: revisions.authorUid,
      authorName: revisions.authorName,
      authorBanned: users.banned,
      createdAt: revisions.createdAt,
      parentRevId: revisions.parentRevId,
      namespace: pages.namespace,
      slug: pages.slug,
      pageId: pages.id,
      bytes: sql<number>`length(${revisions.content})`,
    })
    .from(revisions)
    .innerJoin(pages, eq(revisions.pageId, pages.id))
    // LEFT, not inner: an author with no mirror row must not drop the change.
    .leftJoin(users, eq(revisions.authorUid, users.uid))
    .where(
      and(
        latestPerPage,
        opts.cursor ? lt(revisions.id, opts.cursor) : undefined,
        opts.locale ? eq(revisions.locale, opts.locale) : undefined,
        opts.hideMinor ? eq(revisions.isMinor, false) : undefined,
      ),
    )
    .orderBy(desc(revisions.id)) // rev id IS the global change order
    .limit(limit + 1)
    .all();
  const hasMore = rows.length > limit;
  return {
    rows: rows.slice(0, limit),
    nextCursor: hasMore ? rows[limit - 1].revId : null,
  };
}

/* ------------------------------------------------------------------ */
/* 6. Wanted pages (red-link targets, most referenced first)           */
/* ------------------------------------------------------------------ */

export interface WantedPage {
  namespace: Namespace;
  slug: string;
  refs: number;
}

export function wantedPages(db: Db, limit = 50): WantedPage[] {
  return db.all<WantedPage>(sql`
    select pl.to_namespace as "namespace", pl.to_slug as "slug",
           count(distinct pl.from_page_id) as "refs"
    from page_links pl
    left join pages p on p.namespace = pl.to_namespace and p.slug = pl.to_slug
    where p.id is null
    group by pl.to_namespace, pl.to_slug
    order by refs desc, pl.to_slug
    limit ${limit}
  `);
}

/* ------------------------------------------------------------------ */
/* 7. What links here (links + transclusions + redirects)              */
/* ------------------------------------------------------------------ */

export function whatLinksHere(db: Db, namespace: Namespace, slug: string) {
  const links = db
    .selectDistinct({
      pageId: pages.id,
      namespace: pages.namespace,
      slug: pages.slug,
      fromLocale: pageLinks.fromLocale,
    })
    .from(pageLinks)
    .innerJoin(pages, eq(pageLinks.fromPageId, pages.id))
    .where(and(eq(pageLinks.toNamespace, namespace), eq(pageLinks.toSlug, slug)))
    .orderBy(pages.namespace, pages.slug, pageLinks.fromLocale)
    .all();

  // template_links has no namespace column: it is Template-ns by definition.
  const transclusions =
    namespace === "template"
      ? db
          .selectDistinct({
            pageId: pages.id,
            namespace: pages.namespace,
            slug: pages.slug,
            fromLocale: templateLinks.fromLocale,
          })
          .from(templateLinks)
          .innerJoin(pages, eq(templateLinks.fromPageId, pages.id))
          .where(eq(templateLinks.templateSlug, slug))
          .orderBy(pages.namespace, pages.slug, templateLinks.fromLocale)
          .all()
      : [];

  const redirects = db
    .select({ pageId: pages.id, namespace: pages.namespace, slug: pages.slug })
    .from(pages)
    .where(and(eq(pages.redirectNs, namespace), eq(pages.redirectSlug, slug)))
    .orderBy(pages.namespace, pages.slug)
    .all();

  return { links, transclusions, redirects };
}

/** Pattern 12 as a read: pages whose cache a Template:X edit would drop. */
export function templateDependents(db: Db, templateSlug: string) {
  return db
    .select({
      pageId: pages.id,
      namespace: pages.namespace,
      slug: pages.slug,
      locale: templateLinks.fromLocale,
    })
    .from(templateLinks)
    .innerJoin(pages, eq(templateLinks.fromPageId, pages.id))
    .where(eq(templateLinks.templateSlug, slugifyTitle(templateSlug) || templateSlug))
    .orderBy(pages.namespace, pages.slug, templateLinks.fromLocale)
    .all();
}

/* ------------------------------------------------------------------ */
/* 8. Category listing (members + subcategories, sort-key ordered)     */
/* ------------------------------------------------------------------ */

export function categoryMembers(db: Db, categorySlug: string) {
  const rows = db
    .select({
      pageId: pages.id,
      namespace: pages.namespace,
      slug: pages.slug,
      sortKey: categoryLinks.sortKey,
    })
    .from(categoryLinks)
    .innerJoin(pages, eq(categoryLinks.pageId, pages.id))
    .where(eq(categoryLinks.categorySlug, categorySlug))
    .orderBy(categoryLinks.sortKey, pages.slug)
    .all();
  return {
    subcategories: rows.filter((r) => r.namespace === "category"),
    members: rows.filter((r) => r.namespace !== "category"),
  };
}

/* ------------------------------------------------------------------ */
/* 8b. Category browsing (decisions-v2 O13)                            */
/* ------------------------------------------------------------------ */

/**
 * `site_settings` key holding the curated home-page category order: a JSON
 * array of category slugs (decisions-v2 O13.3). Unset ⇒ order by member count.
 */
export const HOME_CATEGORIES_KEY = "home_categories";

export interface CategoryCountRow {
  /** Slug in the `category` namespace — the identity of the category (O13.2). */
  slug: string;
  /**
   * Title of the `Category:` description page, preferring `locale` and falling
   * back to EN. Null when nobody has written that page — which is normal:
   * categories need no page and no registry row to exist (O13.5/O13.6).
   */
  pageTitle: string | null;
  /** A `Category:` page with a head exists in some locale. */
  hasPage: boolean;
  /** Members in the `category` namespace (subcategories). */
  subcategories: number;
  /** Members outside the `category` namespace. */
  members: number;
  /** `members + subcategories` — the number the browse surfaces show. */
  total: number;
}

/**
 * Every category that exists, with live membership counts — the single browse
 * index behind the home grid and `/special/categories` (decisions-v2 O13.2/4).
 *
 * The slug universe is `category_links` (real `[[Category:X]]` membership)
 * UNION the `category`-namespace pages, so a written-but-empty category still
 * appears with a count of 0 and a populated category with no description page
 * appears with `hasPage: false`. Ordered by total members descending, then
 * slug — the O13.4 sort, which the home grid reuses as its fallback order.
 */
export function listCategoriesWithCounts(db: Db, locale: string): CategoryCountRow[] {
  const rows = db.all<{
    slug: string;
    pageTitle: string | null;
    subcategories: number;
    members: number;
    total: number;
  }>(sql`
    with cats as (
      select category_slug as slug from category_links
      union
      select slug from pages where namespace = 'category'
    )
    select c.slug as "slug",
           coalesce(cnt.subcategories, 0) as "subcategories",
           coalesce(cnt.members, 0) as "members",
           coalesce(cnt.total, 0) as "total",
           coalesce(loc.title, en.title) as "pageTitle"
    from cats c
    left join (
      select cl.category_slug as slug,
             count(*) as total,
             sum(case when m.namespace = 'category' then 1 else 0 end) as subcategories,
             sum(case when m.namespace = 'category' then 0 else 1 end) as members
      from category_links cl
      join pages m on m.id = cl.page_id
      group by cl.category_slug
    ) cnt on cnt.slug = c.slug
    left join pages cp on cp.namespace = 'category' and cp.slug = c.slug
    left join page_locales loc
      on loc.page_id = cp.id and loc.locale = ${locale} and loc.current_rev_id is not null
    left join page_locales en
      on en.page_id = cp.id and en.locale = 'en' and en.current_rev_id is not null
    order by "total" desc, c.slug
  `);
  return rows.map((row) => ({
    slug: row.slug,
    pageTitle: row.pageTitle,
    hasPage: row.pageTitle !== null,
    subcategories: row.subcategories,
    members: row.members,
    total: row.total,
  }));
}

export interface UncategorizedPageRow {
  pageId: number;
  namespace: Namespace;
  slug: string;
  /** Head title in `locale`, else the EN head title. */
  title: string;
}

/**
 * Article-namespace pages carrying no `[[Category:…]]` tag at all — the O13.4
 * "uncategorized pages" report on `/special/categories`. Redirects are skipped
 * (they are pointers, not content) and so are pages with no head anywhere.
 */
export function uncategorizedPages(
  db: Db,
  locale: string,
  limit = 100,
): UncategorizedPageRow[] {
  return db.all<UncategorizedPageRow>(sql`
    select p.id as "pageId", p.namespace as "namespace", p.slug as "slug",
           coalesce(loc.title, en.title) as "title"
    from pages p
    left join page_locales loc
      on loc.page_id = p.id and loc.locale = ${locale} and loc.current_rev_id is not null
    left join page_locales en
      on en.page_id = p.id and en.locale = 'en' and en.current_rev_id is not null
    where p.namespace = 'main'
      and p.redirect_slug is null
      and coalesce(loc.title, en.title) is not null
      and not exists (select 1 from category_links cl where cl.page_id = p.id)
    order by p.slug
    limit ${limit}
  `);
}

/* ------------------------------------------------------------------ */
/* 9. Full-text search (bm25, title-weighted, O7 EN union)             */
/* ------------------------------------------------------------------ */

export interface SearchResult {
  pageId: number;
  namespace: Namespace;
  slug: string;
  locale: string;
  title: string;
  snippet: string;
  rank: number;
  /** O7: this hit came from the EN index because the locale had none. */
  fallbackFromEn: boolean;
}

/**
 * Turn a user query into FTS5 MATCH syntax: each token quoted (so operators
 * and punctuation are literal) and prefix-matched, which is what makes
 * Korean particle suffixes (조사) match (db-schema §B).
 */
export function buildMatchQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/["*]/g, "").trim())
    .filter((token) => token.length > 0)
    .map((token) => `"${token}"*`)
    .join(" ");
}

interface RawSearchRow {
  pageId: number;
  namespace: Namespace;
  slug: string;
  locale: string;
  title: string;
  snippet: string;
  rank: number;
}

const SEARCH_SQL = `
  SELECT d.page_id AS pageId, d.namespace AS namespace, d.slug AS slug,
         d.locale AS locale, d.title AS title,
         snippet(search_fts, 1, '<mark>', '</mark>', '…', 24) AS snippet,
         bm25(search_fts, 5.0, 1.0) AS rank
  FROM search_fts
  JOIN search_docs d ON d.id = search_fts.rowid
  WHERE search_fts MATCH ? AND d.locale = ?
  ORDER BY rank
  LIMIT ?
`;

export interface SearchOptions {
  locale: string;
  limit?: number;
  offset?: number;
  /** Set false to skip the O7 EN union (e.g. an explicitly EN-only search). */
  enFallback?: boolean;
}

/**
 * db-schema §D pattern 9 + decisions O7: for locale ≠ en the EN index is
 * queried too, hits are deduped by page id preferring the locale's own hit,
 * and EN-only hits are flagged `fallbackFromEn` for the UI's "EN" chip.
 *
 * Malformed FTS input can never reach SQLite: `buildMatchQuery` quotes every
 * token. An empty query returns no rows.
 */
export function search(db: WikiDb, query: string, opts: SearchOptions): SearchResult[] {
  const match = buildMatchQuery(query);
  if (!match) return [];
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  const fetch = limit + offset;

  const stmt = db.$client.prepare(SEARCH_SQL);
  const primary = stmt.all(match, opts.locale, fetch) as RawSearchRow[];
  const merged = new Map<number, SearchResult>();
  for (const row of primary) {
    if (!merged.has(row.pageId)) merged.set(row.pageId, { ...row, fallbackFromEn: false });
  }

  if (opts.locale !== "en" && opts.enFallback !== false) {
    const enRows = stmt.all(match, "en", fetch) as RawSearchRow[];
    for (const row of enRows) {
      if (!merged.has(row.pageId)) merged.set(row.pageId, { ...row, fallbackFromEn: true });
    }
  }

  return [...merged.values()]
    .sort((a, b) => a.rank - b.rank || a.slug.localeCompare(b.slug))
    .slice(offset, offset + limit);
}

const SUGGEST_SQL = `
  SELECT d.page_id AS pageId, d.namespace AS namespace, d.slug AS slug,
         d.locale AS locale, d.title AS title,
         bm25(search_fts, 5.0, 1.0) AS rank
  FROM search_fts
  JOIN search_docs d ON d.id = search_fts.rowid
  WHERE search_fts MATCH ? AND d.locale = ?
  ORDER BY rank
  LIMIT ?
`;

/** Title-only prefix suggestions (routes.md /api/search/suggest, ≤8 items). */
export function searchSuggest(
  db: WikiDb,
  query: string,
  opts: { locale: string; limit?: number },
): Omit<SearchResult, "snippet" | "fallbackFromEn">[] {
  const match = buildMatchQuery(query);
  if (!match) return [];
  // FTS5 column filter: restrict the whole expression to the title column.
  const titleMatch = `title : (${match})`;
  return db.$client.prepare(SUGGEST_SQL).all(titleMatch, opts.locale, opts.limit ?? 8) as Omit<
    SearchResult,
    "snippet" | "fallbackFromEn"
  >[];
}

/* ------------------------------------------------------------------ */
/* 10. Outdated translations                                           */
/* ------------------------------------------------------------------ */

export interface OutdatedRow {
  pageId: number;
  namespace: Namespace;
  slug: string;
  locale: string;
  /** null ⇒ no EN basis: "original" per decisions O4, not "outdated". */
  basedOnRev: number | null;
  enCurrentRev: number;
  updatedAt: number;
}

/**
 * Rev ids are monotonic, so EN head > the translation's basis ⇒ stale.
 * decisions O4 keeps NULL-basis rows in the report but the caller must badge
 * them "original"; `basedOnRev === null` is the discriminator.
 */
export function outdatedTranslations(db: Db, opts: { pageId?: number } = {}): OutdatedRow[] {
  return db.all<OutdatedRow>(sql`
    select t.page_id as "pageId", p.namespace as "namespace", p.slug as "slug",
           t.locale as "locale",
           trev.translated_from_rev_id as "basedOnRev",
           en.current_rev_id as "enCurrentRev",
           t.updated_at as "updatedAt"
    from page_locales t
    join revisions trev on trev.id = t.current_rev_id
    join page_locales en on en.page_id = t.page_id and en.locale = 'en'
    join pages p on p.id = t.page_id
    where t.locale <> 'en'
      and en.current_rev_id is not null
      and (trev.translated_from_rev_id is null
           or trev.translated_from_rev_id < en.current_rev_id)
      ${opts.pageId === undefined ? sql`` : sql`and t.page_id = ${opts.pageId}`}
    order by p.namespace, p.slug, t.locale
  `);
}

/* ------------------------------------------------------------------ */
/* 14. Contributions, listings, audit log                              */
/* ------------------------------------------------------------------ */

export function contributions(db: Db, uid: string, opts: Keyset = {}) {
  const limit = opts.limit ?? 50;
  const rows = db
    .select({
      revId: revisions.id,
      locale: revisions.locale,
      title: revisions.title,
      comment: revisions.comment,
      isMinor: revisions.isMinor,
      createdAt: revisions.createdAt,
      namespace: pages.namespace,
      slug: pages.slug,
      pageId: pages.id,
    })
    .from(revisions)
    .innerJoin(pages, eq(revisions.pageId, pages.id))
    .where(
      and(
        eq(revisions.authorUid, uid), // uses revisions_author_idx
        opts.cursor ? lt(revisions.id, opts.cursor) : undefined,
      ),
    )
    .orderBy(desc(revisions.id))
    .limit(limit + 1)
    .all();
  const hasMore = rows.length > limit;
  return { rows: rows.slice(0, limit), nextCursor: hasMore ? rows[limit - 1].revId : null };
}

/** /special/all-pages: per-namespace listing, keyset on slug. */
export function listPages(
  db: Db,
  opts: { namespace?: Namespace; after?: string; limit?: number } = {},
) {
  const limit = opts.limit ?? 100;
  const rows = db
    .select({
      pageId: pages.id,
      namespace: pages.namespace,
      slug: pages.slug,
      redirectSlug: pages.redirectSlug,
    })
    .from(pages)
    .where(
      and(
        opts.namespace ? eq(pages.namespace, opts.namespace) : undefined,
        opts.after ? sql`${pages.slug} > ${opts.after}` : undefined,
      ),
    )
    .orderBy(pages.namespace, pages.slug)
    .limit(limit + 1)
    .all();
  const hasMore = rows.length > limit;
  return { rows: rows.slice(0, limit), nextCursor: hasMore ? rows[limit - 1].slug : null };
}

export function listAuditLog(db: Db, opts: Keyset = {}) {
  const limit = opts.limit ?? 50;
  const rows = db
    .select()
    .from(auditLog)
    .where(opts.cursor ? lt(auditLog.id, opts.cursor) : undefined)
    .orderBy(desc(auditLog.id))
    .limit(limit + 1)
    .all();
  const hasMore = rows.length > limit;
  return { rows: rows.slice(0, limit), nextCursor: hasMore ? rows[limit - 1].id : null };
}

/**
 * versioning.md §6 report: which pages carry which version boundaries.
 * `version_boundaries` is a JSON array, so json_each expands it.
 */
export interface VersionCoverageRow {
  pageId: number;
  namespace: Namespace;
  slug: string;
  locale: string;
  version: string;
  updatedAt: number;
}

export function versionCoverage(db: Db, versionId?: string): VersionCoverageRow[] {
  return db.all<VersionCoverageRow>(sql`
    select pl.page_id as "pageId", p.namespace as "namespace", p.slug as "slug",
           pl.locale as "locale", je.value as "version",
           pl.updated_at as "updatedAt"
    from page_locales pl
    join pages p on p.id = pl.page_id
    join json_each(pl.version_boundaries) je
    where pl.version_scoped = 1
      ${versionId === undefined ? sql`` : sql`and je.value = ${versionId}`}
    order by je.value, p.namespace, p.slug, pl.locale
  `);
}

/** Locales other than EN that have a head for this page (translation nav). */
export function translationsOf(db: Db, pageId: number) {
  return db
    .select({ locale: pageLocales.locale, title: pageLocales.title })
    .from(pageLocales)
    .where(
      and(
        eq(pageLocales.pageId, pageId),
        ne(pageLocales.locale, "en"),
        isNotNull(pageLocales.currentRevId),
      ),
    )
    .orderBy(pageLocales.locale)
    .all();
}

/* ------------------------------------------------------------------ */
/* 15. Template picker (visual-editor.md §5.1)                         */
/* ------------------------------------------------------------------ */

export interface TemplateSummary {
  slug: string;
  /** Title in the requested locale, falling back to EN and then the slug. */
  title: string;
}

/**
 * The `Template:` pages the editor's template dialog can offer, newest naming
 * rules applied: redirects are excluded (picking one would insert an indirect
 * call for no reason) and the title is the one the editor's locale would read.
 *
 * `query` is a case-insensitive substring match on that title, which is what a
 * picker needs — a template is chosen by recognising its name, not by ranking.
 */
export function listTemplates(
  db: Db,
  opts: { locale: string; query?: string; limit?: number },
): TemplateSummary[] {
  const like = `%${(opts.query ?? "").trim().toLowerCase()}%`;
  return db.all<TemplateSummary>(sql`
    select p.slug as "slug",
           coalesce(loc.title, en.title, p.slug) as "title"
    from pages p
    left join page_locales loc on loc.page_id = p.id and loc.locale = ${opts.locale}
    left join page_locales en on en.page_id = p.id and en.locale = 'en'
    where p.namespace = 'template'
      and p.redirect_slug is null
      and lower(coalesce(loc.title, en.title, p.slug)) like ${like}
    order by 2
    limit ${opts.limit ?? 20}
  `);
}

/* ------------------------------------------------------------------ */
/* 16. Media browser (visual-editor.md §5.2)                           */
/* ------------------------------------------------------------------ */

export interface MediaFileRow {
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  uploadedAt: Date;
  uploaderName: string | null;
}

/**
 * Uploads, newest first — the "already on this wiki" half of the editor's
 * media dialog. `query` is a case-insensitive substring of the canonical
 * filename, which is how an author looks for a picture they know exists.
 */
export function listFiles(
  db: Db,
  opts: { query?: string; limit?: number } = {},
): MediaFileRow[] {
  const like = `%${(opts.query ?? "").trim().toLowerCase()}%`;
  return db.all<MediaFileRow>(sql`
    select f.filename as "filename", f.mime as "mime", f.size as "size",
           f.width as "width", f.height as "height",
           f.uploaded_at as "uploadedAt", u.display_name as "uploaderName"
    from ${files} f
    left join users u on u.uid = f.uploader_uid
    where lower(f.filename) like ${like}
    order by f.uploaded_at desc, f.id desc
    limit ${opts.limit ?? 40}
  `);
}

/* ------------------------------------------------------------------ */
/* Reports (moderation queue)                                          */
/* ------------------------------------------------------------------ */

export interface ReportFilter extends Keyset {
  /** Omit for every report; "open" is what a moderator usually wants. */
  status?: "open" | "resolved" | "dismissed";
}

/** Newest first, keyset-paged on id — the same shape as listAuditLog. */
export function listReports(db: Db, opts: ReportFilter = {}) {
  const limit = opts.limit ?? 50;
  const conditions = [
    opts.status ? eq(reports.status, opts.status) : undefined,
    opts.cursor ? lt(reports.id, opts.cursor) : undefined,
  ].filter((c) => c !== undefined);

  const rows = db
    .select()
    .from(reports)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(reports.id))
    .limit(limit + 1)
    .all();

  const hasMore = rows.length > limit;
  return { rows: rows.slice(0, limit), nextCursor: hasMore ? rows[limit - 1].id : null };
}

/**
 * How many reports are still waiting — the console's queue badge.
 *
 * Counted in SQL over `reports_status_idx` rather than by materializing the
 * rows: this runs on every page of every report listing, and the badge only
 * ever needs the number.
 */
export function openReportCount(db: Db): number {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(reports)
    .where(eq(reports.status, "open"))
    .get();
  return row?.count ?? 0;
}
