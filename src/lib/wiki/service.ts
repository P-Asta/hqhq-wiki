/**
 * Render service — the ONE module the app routes use to turn stored wikitext
 * into HTML, and to run the save-time parse.
 *
 * Normative sources:
 * - docs/engine/engine-status.md §5 (`parse()` API)
 * - docs/engine/decisions.md O1 (identity = namespace + slug), O4 (EN
 *   fallback), O10/versioning.md §3–§5 (cache keys, version independence)
 * - docs/engine/db-schema.md §D pattern 1 + Addenda A3/A5 (cache rules)
 * - docs/engine/routes.md (`?rev=`, `?redirect=no`, `/api/preview`)
 *
 * Rules encoded here, so no route has to re-derive them:
 *  - one-hop redirect follow, disabled by `followRedirect: false`;
 *  - locale head with EN fallback — the render (and its cache row) is keyed on
 *    the locale actually served, never on the requested one;
 *  - `parsed_cache` read via `getPageView` (rev-id mismatch ⇒ miss ⇒ self-heal),
 *    written back unless `meta.volatile` (Addendum A5), under version `'*'`
 *    when `!meta.versionScoped` (versioning.md §4);
 *  - previews and `?rev=` renders never read or write the cache;
 *  - every save parses ONCE with `version: null` (versioning.md §5) and hands
 *    that ParseResult to the db layer, which owns the transaction.
 *
 * Everything is synchronous (better-sqlite3 + a sync engine).
 */

import "server-only";

import type { WikiDb } from "@/lib/db/client";
import { getPageSource, getPageView } from "@/lib/db/queries";
import type { Namespace } from "@/lib/db/schema";
import {
  cacheParsedHtml,
  createPage,
  htmlToPlainText,
  loadVersionTable,
  rollback,
  saveEdit,
  type Actor,
  type CreatePageResult,
  type Db,
  type SaveEditResult,
} from "@/lib/db/store";
import type { Locale } from "@/lib/i18n";
import { normalizeTitle, parseTitle } from "@/lib/title";
import { parse } from "@/lib/wikitext/index";
import type {
  PageMeta,
  ParseResult,
  Title,
  TocEntry,
  VersionEntry,
  VersionTable,
} from "@/lib/wikitext/types";

import { buildParseContext, buildWikiConfig, toEngineTitle } from "./context";

/* ------------------------------------------------------------------ */
/* Result shapes                                                       */
/* ------------------------------------------------------------------ */

export interface RenderedRevision {
  id: number;
  /** False for a `?rev=` view of an older revision (routes.md banner). */
  isCurrent: boolean;
  title: string;
  comment: string;
  isMinor: boolean;
  authorUid: string;
  authorName: string;
  createdAt: Date;
  parentRevId: number | null;
  /** EN revision this translation was based on (decisions O4); null = none. */
  translatedFromRevId: number | null;
}

export interface RenderedPageRef {
  id: number;
  namespace: Namespace;
  slug: string;
  /** Display title of the locale actually served (`page_locales.title`). */
  title: string;
  pageLocaleId: number;
  updatedAt: Date;
}

export interface RedirectedFrom {
  namespace: Namespace;
  slug: string;
  title: string;
  /** Addendum A2: `#REDIRECT [[Moons#Titan]]` fragment, or null. */
  fragment: string | null;
}

export interface RenderedPage {
  html: string;
  /**
   * `null` when the HTML came from `parsed_cache` — the cache stores HTML
   * only, so no meta exists without re-parsing. Pass `forceParse: true` when
   * a route genuinely needs `meta` (categories, warnings, displayTitle).
   */
  meta: PageMeta | null;
  /** Empty on a cache hit; the TOC is already spliced into `html`. */
  toc: TocEntry[];
  page: RenderedPageRef;
  /** Locale that was requested (the `/{locale}` route segment). */
  locale: Locale;
  /** Locale actually served — differs from `locale` on EN fallback. */
  usedLocale: string;
  /** True ⇒ show the "showing the English version" banner + translate CTA. */
  fallbackFromEn: boolean;
  /** Set when a one-hop redirect was followed ("Redirected from …" note). */
  redirectedFrom?: RedirectedFrom;
  versionScoped: boolean;
  versionBoundaries: string[];
  /** Whole registry, ordinal-ascending — the selector's dropdown. */
  availableVersions: VersionEntry[];
  /** Version this render resolved to (never null; the site default by default). */
  selectedVersion: string;
  revision: RenderedRevision;
  /** True when `html` was served from `parsed_cache`. */
  cached: boolean;
}

export interface RenderedPreview {
  html: string;
  meta: PageMeta;
}

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

export interface RenderPageInput {
  db: Db;
  namespace: Namespace;
  slug: string;
  /** UI locale from the route segment; also the preferred content locale. */
  locale: Locale;
  /** Reader's `?v=`; unknown or absent ⇒ the site default version. */
  version?: string | null;
  /** `?rev=<id>`: render that revision instead of the head. Never cached. */
  revId?: number;
  /** `?redirect=no` passes false (routes.md). Default true. */
  followRedirect?: boolean;
  /** Ignore a cached row and re-parse (used when the caller needs `meta`). */
  forceParse?: boolean;
  /** Injected clock for `CURRENT*` (tests). */
  now?: Date;
}

export interface RenderPreviewInput {
  db: Db;
  wikitext: string;
  locale: Locale;
  /** Title the preview renders as (drives `{{PAGENAME}}` and self-links). */
  title: string;
  version?: string | null;
  now?: Date;
}

export interface SaveEditWithParseInput {
  db: WikiDb;
  pageId: number;
  namespace: Namespace;
  locale: string;
  /** Display title for this locale; also the parsed page's name. */
  title: string;
  content: string;
  comment?: string;
  isMinor?: boolean;
  /** Head the editor loaded; null when creating this locale. */
  parentRevId: number | null;
  translatedFromRevId?: number | null;
  author: Actor;
}

export interface CreatePageWithParseInput
  extends Omit<SaveEditWithParseInput, "pageId" | "parentRevId"> {
  /** Defaults to `slugifyTitle(title)` in the db layer (decisions O1). */
  slug?: string;
}

export interface RollbackWithParseInput {
  db: WikiDb;
  pageId: number;
  namespace: Namespace;
  /** Page name for the save-time parse context (`{{PAGENAME}}`). */
  pageName: string;
  locale: string;
  targetRevId: number;
  actor: Actor;
  comment?: string;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Resolve the reader's selection against the registry. An unknown or absent
 * id falls back to the site default, so a bookmarked `?v=v99` still renders
 * (versioning.md §2.6 covers unknown ids *inside* markup, not the selection).
 */
export function resolveVersion(versions: VersionTable, selected?: string | null): string {
  if (selected && versions.byId[selected]) return selected;
  return versions.defaultId;
}

/**
 * Rendered HTML → the plain text stored in `search_docs.body`. Exactly the db
 * layer's own flattener (`store.htmlToPlainText`), which `saveEdit` already
 * applies by default — callers only need this to inspect or override
 * `searchBody`.
 */
export function extractPlainText(input: string | ParseResult): string {
  return htmlToPlainText(typeof input === "string" ? input : input.html);
}

function engineTitleFor(namespace: Namespace, title: string): Title {
  return toEngineTitle(namespace, title);
}

/* ------------------------------------------------------------------ */
/* Render — the article route                                          */
/* ------------------------------------------------------------------ */

/**
 * Render one page view. Returns `null` when nothing is renderable (no page,
 * no head in any locale, or a `revId` that does not belong to the page) —
 * the route then shows the "create this page" CTA / 404 (routes.md).
 */
export function renderPage(input: RenderPageInput): RenderedPage | null {
  const { db, locale } = input;
  const versions = loadVersionTable(db);
  const selectedVersion = resolveVersion(versions, input.version);

  if (input.revId !== undefined) {
    return renderRevision(input, versions, selectedVersion);
  }

  let view = getPageView(db, {
    namespace: input.namespace,
    slug: input.slug,
    locale,
    version: selectedVersion,
    followRedirect: input.followRedirect !== false,
  });

  let redirectedFrom: RedirectedFrom | undefined;
  if (view.kind === "redirect") {
    // One hop only, like MediaWiki: resolve the target without following it.
    const from = getPageView(db, {
      namespace: input.namespace,
      slug: input.slug,
      locale,
      version: selectedVersion,
      followRedirect: false,
    });
    redirectedFrom = {
      namespace: input.namespace,
      slug: input.slug,
      title: from.kind === "page" ? from.title : input.slug,
      fragment: view.to.fragment,
    };
    view = getPageView(db, {
      namespace: view.to.namespace,
      slug: view.to.slug,
      locale,
      version: selectedVersion,
      followRedirect: false,
    });
  }

  if (view.kind !== "page") return null;

  const source = getPageSource(db, {
    namespace: view.namespace,
    slug: view.slug,
    locale: view.servedLocale,
  });
  if (!source?.revision) return null;

  const common = {
    page: {
      id: view.pageId,
      namespace: view.namespace,
      slug: view.slug,
      title: view.title,
      pageLocaleId: view.pageLocaleId,
      updatedAt: view.updatedAt,
    },
    locale,
    usedLocale: view.servedLocale,
    fallbackFromEn: view.fallbackFromEn,
    ...(redirectedFrom ? { redirectedFrom } : {}),
    availableVersions: versions.ordered,
    selectedVersion,
    revision: toRenderedRevision(source.revision, true),
  };

  if (view.html !== null && input.forceParse !== true) {
    return {
      ...common,
      html: view.html,
      meta: null,
      toc: [],
      versionScoped: view.versionScoped,
      versionBoundaries: view.versionBoundaries,
      cached: true,
    };
  }

  const result = parse(
    source.revision.content,
    buildParseContext({
      db,
      // The cache row is keyed on the served locale, so the render must use
      // that locale's messages and articlePath — otherwise an EN-fallback
      // view would poison the EN cache row with another locale's chrome.
      locale: view.servedLocale,
      page: engineTitleFor(view.namespace, view.title),
      version: selectedVersion,
      versions,
      now: input.now,
    }),
  );

  // Addendum A5: volatile output (CURRENT*, #ifexist) is never cached.
  if (!result.meta.volatile) {
    cacheParsedHtml(db, {
      pageId: view.pageId,
      locale: view.servedLocale,
      // versioning.md §4: unscoped pages share one row under "*".
      version: result.meta.versionScoped ? selectedVersion : "*",
      revId: view.revId,
      html: result.html,
    });
  }

  return {
    ...common,
    html: result.html,
    meta: result.meta,
    toc: result.toc,
    versionScoped: result.meta.versionScoped,
    versionBoundaries: result.meta.versionBoundaries,
    cached: false,
  };
}

/** `?rev=<id>` — always parsed fresh, never read from or written to the cache. */
function renderRevision(
  input: RenderPageInput,
  versions: VersionTable,
  selectedVersion: string,
): RenderedPage | null {
  const { db, locale, revId } = input;
  const found = getPageSource(db, {
    namespace: input.namespace,
    slug: input.slug,
    locale,
    revId,
  });
  if (!found?.revision) return null;

  // The revision may belong to a different locale than the one requested;
  // re-read with that locale so ids and titles stay consistent.
  const source =
    found.revision.locale === locale
      ? found
      : (getPageSource(db, {
          namespace: input.namespace,
          slug: input.slug,
          locale: found.revision.locale,
          revId,
        }) ?? found);
  const revision = source.revision;
  if (!revision) return null;

  const result = parse(
    revision.content,
    buildParseContext({
      db,
      locale: revision.locale,
      page: engineTitleFor(source.page.namespace, revision.title),
      version: selectedVersion,
      versions,
      now: input.now,
    }),
  );

  return {
    html: result.html,
    meta: result.meta,
    toc: result.toc,
    page: {
      id: source.page.id,
      namespace: source.page.namespace,
      slug: source.page.slug,
      title: source.pageLocale?.title ?? revision.title,
      pageLocaleId: source.pageLocale?.id ?? 0,
      updatedAt: source.pageLocale?.updatedAt ?? revision.createdAt,
    },
    locale,
    usedLocale: revision.locale,
    fallbackFromEn: revision.locale !== locale,
    versionScoped: result.meta.versionScoped,
    versionBoundaries: result.meta.versionBoundaries,
    availableVersions: versions.ordered,
    selectedVersion,
    revision: toRenderedRevision(revision, source.isCurrent),
    cached: false,
  };
}

function toRenderedRevision(
  rev: {
    id: number;
    title: string;
    comment: string;
    isMinor: boolean;
    authorUid: string;
    authorName: string;
    createdAt: Date;
    parentRevId: number | null;
    translatedFromRevId: number | null;
  },
  isCurrent: boolean,
): RenderedRevision {
  return {
    id: rev.id,
    isCurrent,
    title: rev.title,
    comment: rev.comment,
    isMinor: rev.isMinor,
    authorUid: rev.authorUid,
    authorName: rev.authorName,
    createdAt: rev.createdAt,
    parentRevId: rev.parentRevId,
    translatedFromRevId: rev.translatedFromRevId,
  };
}

/* ------------------------------------------------------------------ */
/* Preview — POST /api/preview                                         */
/* ------------------------------------------------------------------ */

/**
 * Render unsaved wikitext. `preview: true` surfaces version warnings inline
 * (versioning.md §2.6); nothing is read from or written to `parsed_cache`,
 * and volatile output is fine here.
 */
export function renderPreview(input: RenderPreviewInput): RenderedPreview {
  const versions = loadVersionTable(input.db);
  const parsed = parseTitle(input.title);
  const page: Title = parsed
    ? { namespace: parsed.namespace, pageName: parsed.pageName }
    : { namespace: 0, pageName: normalizeTitle(input.title) || "Preview" };

  const result = parse(
    input.wikitext,
    buildParseContext({
      db: input.db,
      locale: input.locale,
      page,
      version: resolveVersion(versions, input.version),
      versions,
      preview: true,
      now: input.now,
    }),
  );
  return { html: result.html, meta: result.meta };
}

/* ------------------------------------------------------------------ */
/* Save paths — parse once, version-agnostic (versioning.md §5)        */
/* ------------------------------------------------------------------ */

/**
 * The version-independent parse every write path uses: `version: null`, so
 * links, categories, redirect and the search body never depend on which
 * version a reader happens to select.
 */
function parseForSave(
  db: Db,
  namespace: Namespace,
  pageName: string,
  locale: string,
  versions: VersionTable,
): (content: string) => ParseResult {
  const ctx = buildParseContext({
    db,
    locale,
    page: engineTitleFor(namespace, pageName),
    version: null,
    versions,
  });
  return (content: string) => parse(content, ctx);
}

/**
 * Save an edit to an existing page: parse once (version-agnostic) and hand
 * the ParseResult to the db layer, which owns the transaction (links,
 * categories, search, cache invalidation — db-schema §D2 + addenda).
 */
export function saveEditWithParse(input: SaveEditWithParseInput): SaveEditResult {
  const { db, namespace, ...rest } = input;
  const versions = loadVersionTable(db);
  const parsed = parseForSave(db, namespace, input.title, input.locale, versions)(input.content);
  return saveEdit(db, { ...rest, parse: parsed });
}

/** Same orchestration for a page that does not exist yet (PUT on a red link). */
export function createPageWithParse(input: CreatePageWithParseInput): CreatePageResult {
  const { db, namespace, ...rest } = input;
  const versions = loadVersionTable(db);
  const parsed = parseForSave(db, namespace, input.title, input.locale, versions)(input.content);
  return createPage(db, { ...rest, namespace, parse: parsed });
}

/**
 * Restore an older revision. The content is only known once the transaction
 * has read the target revision, so the db layer gets the callback form of
 * `ParseForSave` — still exactly one parse, still version-agnostic.
 */
export function rollbackWithParse(input: RollbackWithParseInput): SaveEditResult {
  const { db } = input;
  const versions = loadVersionTable(db);
  return rollback(db, {
    pageId: input.pageId,
    locale: input.locale,
    targetRevId: input.targetRevId,
    actor: input.actor,
    comment: input.comment,
    parse: parseForSave(db, input.namespace, input.pageName, input.locale, versions),
  });
}

export { buildParseContext, buildWikiConfig };
