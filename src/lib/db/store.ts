/**
 * Write-side data access: the engine's PageStore, the save transaction, and
 * the registries (versions, languages, nav categories, admin grants, site
 * settings, files).
 *
 * Normative sources:
 * - docs/engine/db-schema.md §D (query patterns) + Addenda A1–A8
 * - docs/engine/decisions.md O1, O3, O4, O5, O6, O7
 * - docs/engine/versioning.md §4/§5 (decision O10)
 *
 * Everything here is synchronous (better-sqlite3). Write transactions that
 * read before writing use { behavior: "immediate" } so the write lock is
 * taken up front.
 *
 * Read-side query patterns live in ./queries.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  NS_ID_BY_STORABLE,
  STORABLE_NS_BY_ID,
  canonicalFilename,
  normalizeTitle,
  parseTitle,
  slugifyTitle,
  type StorableNamespace,
} from "@/lib/title";
import type {
  PageMeta,
  PageStore,
  ParseResult,
  Title,
  TitleKey,
  VersionTable,
} from "@/lib/wikitext/types";

import type { WikiDb } from "./client";
import {
  adminGrants,
  auditLog,
  categories,
  categoryLinks,
  files,
  languages,
  pageLinks,
  pageLocales,
  pages,
  parsedCache,
  reports,
  revisions,
  searchDocs,
  siteSettings,
  templateLinks,
  users,
  versions,
  type Namespace,
} from "./schema";

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/**
 * Base class for store errors. The shape (`status` + `code` + `message`) is
 * what src/lib/api-response.ts branches on, so the API layer can map these
 * straight onto the unified error body.
 */
export class WikiStoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Optimistic-lock failure: someone saved since the editor loaded the page. */
export class EditConflictError extends WikiStoreError {
  constructor(readonly currentRevId: number | null) {
    super(409, "edit-conflict", "The page was edited by someone else.");
  }
}

export class PageMissingError extends WikiStoreError {
  constructor(readonly detail: string) {
    super(404, "page-not-found", `Page not found: ${detail}`);
  }
}

export class PageExistsError extends WikiStoreError {
  constructor(readonly detail: string) {
    super(409, "page-exists", `Page already exists: ${detail}`);
  }
}

export class RevisionMissingError extends WikiStoreError {
  constructor(readonly revId: number) {
    super(404, "revision-not-found", `Revision not found: r${revId}`);
  }
}

export class LanguageMissingError extends WikiStoreError {
  constructor(readonly locale: string) {
    super(400, "unknown-locale", `Unknown locale: ${locale}`);
  }
}

export class InvalidTitleError extends WikiStoreError {
  constructor(readonly detail: string) {
    super(400, "invalid-title", `Invalid title: ${detail}`);
  }
}

export class VersionMissingError extends WikiStoreError {
  constructor(readonly versionId: string) {
    super(404, "unknown-version", `Unknown version: ${versionId}`);
  }
}

/** deleteVersion refused: pages still name the id in version_boundaries. */
export class VersionInUseError extends WikiStoreError {
  constructor(
    readonly versionId: string,
    readonly referencedBy: VersionReference[],
  ) {
    super(
      409,
      "version-in-use",
      `Version ${versionId} is still used by ${referencedBy.length} page(s).`,
    );
  }
}

export class ReportMissingError extends WikiStoreError {
  constructor(readonly id: number) {
    super(404, "report-not-found", `No report #${id}.`);
  }
}

/**
 * Another manager closed it first; 409, not 404 — the report does exist.
 * `reportStatus`, not `status`: the base class already spends that name on the
 * HTTP status the API layer reads off it.
 */
export class ReportClosedError extends WikiStoreError {
  constructor(
    readonly id: number,
    readonly reportStatus: string,
  ) {
    super(409, "report-closed", `Report #${id} was already ${reportStatus}.`);
  }
}

export class GrantMissingError extends WikiStoreError {
  constructor(readonly uid: string) {
    super(404, "grant-not-found", `No active admin grant for ${uid}.`);
  }
}

/** Addendum A1: an admin may never revoke their own grant. */
export class SelfRevokeError extends WikiStoreError {
  constructor() {
    super(400, "self-revoke", "Admins cannot revoke their own grant.");
  }
}

/* ------------------------------------------------------------------ */
/* Shared types                                                        */
/* ------------------------------------------------------------------ */

/** Drizzle transaction handle for this schema. */
export type Tx = Parameters<Parameters<WikiDb["transaction"]>[0]>[0];

/** Either a db handle or an open transaction — reads work on both. */
export type Db = WikiDb | Tx;

export interface Actor {
  uid: string;
  displayName: string;
}

/**
 * The save-time parse. The API layer owns parsing (the store never calls the
 * engine); pass either a ready `ParseResult` or a callback producing one from
 * the content — the callback form is what `rollback` needs, since the content
 * is only known once the target revision has been read.
 *
 * Per versioning.md §5 this parse MUST be the version-agnostic one
 * (`ctx.version = null`), so links, categories, redirect and the search body
 * never depend on which version a reader happens to select.
 */
export type ParseForSave = ParseResult | ((content: string) => ParseResult);

function resolveParse(parse: ParseForSave, content: string): ParseResult {
  return typeof parse === "function" ? parse(content) : parse;
}

export interface VersionReference {
  pageId: number;
  namespace: Namespace;
  slug: string;
  locale: string;
}

/* ------------------------------------------------------------------ */
/* Title keys (spec §14.10: "ns:Normalized_page_name")                 */
/* ------------------------------------------------------------------ */

export interface StoreTitle {
  namespace: number;
  /** Storable string name (db-schema A7) or null when the ns has no storage. */
  nsName: StorableNamespace | null;
  storable: boolean;
  pageName: string;
  /** Identity per decisions O1 — also what makes lookups case-insensitive. */
  slug: string;
  fragment: string | null;
}

/** `Title` → the canonical cache-key form `"<nsId>:Page_name"`. */
export function titleKey(title: Pick<Title, "namespace" | "pageName">): TitleKey {
  return `${title.namespace}:${normalizeTitle(title.pageName).replace(/ /g, "_")}`;
}

/**
 * Parse a `TitleKey` as produced by the engine. Accepts both the numeric
 * cache-key form (`"10:Infobox_moon"`) and a plain prefixed title
 * (`"Template:Infobox moon"`), so the store is robust to either. Returns null
 * for an empty page name.
 */
export function parseTitleKey(key: TitleKey): StoreTitle | null {
  const raw = key.trim();
  const numeric = /^(\d{1,3}):([\s\S]*)$/.exec(raw);
  if (numeric) {
    const namespace = Number(numeric[1]);
    let rest = numeric[2];
    let fragment: string | null = null;
    const hash = rest.indexOf("#");
    if (hash >= 0) {
      fragment = rest.slice(hash + 1);
      rest = rest.slice(0, hash);
    }
    const pageName = normalizeTitle(rest);
    if (pageName === "") return null;
    const nsName = STORABLE_NS_BY_ID[namespace] ?? null;
    return {
      namespace,
      nsName,
      storable: nsName !== null,
      pageName,
      slug: slugifyTitle(pageName),
      fragment,
    };
  }
  const parsed = parseTitle(raw);
  if (!parsed) return null;
  return {
    namespace: parsed.namespace,
    nsName: parsed.nsName,
    storable: parsed.storable,
    pageName: parsed.pageName,
    slug: parsed.slug,
    fragment: parsed.fragment,
  };
}

/** `Title` (engine AST) → storable (namespace, slug), or null when unstorable. */
export function storableTarget(
  title: Title,
): { nsName: StorableNamespace; slug: string; fragment: string | null } | null {
  const nsName = STORABLE_NS_BY_ID[title.namespace] ?? null;
  if (!nsName) return null;
  const slug = slugifyTitle(title.pageName);
  if (!slug) return null;
  return { nsName, slug, fragment: title.fragment ?? null };
}

/* ------------------------------------------------------------------ */
/* Plain-text extraction for search_docs.body (Addendum A4)            */
/* ------------------------------------------------------------------ */

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/**
 * Rendered HTML → plain text for the FTS mirror. Deliberately simple and
 * deterministic: drop script/style, drop tags, decode the handful of entities
 * the renderer emits, collapse whitespace.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/gi, (m) => ENTITY_MAP[m.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Users mirror (db-schema §D pattern 15)                              */
/* ------------------------------------------------------------------ */

/** Keeps the SQLite users mirror in step with Firebase on every write path. */
export function upsertUser(db: Db, actor: Actor): void {
  db.insert(users)
    .values({ uid: actor.uid, displayName: actor.displayName })
    .onConflictDoUpdate({ target: users.uid, set: { displayName: actor.displayName } })
    .run();
}

/**
 * `upsertUser` is for the person DOING something: the name comes from their
 * own verified principal, so refreshing it on every action is right. There is
 * deliberately no variant that writes a name somebody ELSE supplied — a name
 * from untrusted input would let any signed-in user relabel any account
 * throughout the audit log and the admin console. Where a caller only has
 * another person's uid, it looks the account up and refuses if there is none
 * (api/reports/route.ts).
 */

/* ------------------------------------------------------------------ */
/* PageStore for the engine (spec §14.9)                               */
/* ------------------------------------------------------------------ */

export interface PageStoreOptions {
  /** Media URL prefix (decisions O6): `getFile().src` = prefix + canonical name. */
  mediaPath?: string;
}

/**
 * Build the engine-facing `PageStore` over a database handle.
 *
 * Lookups go through `slugifyTitle`, which lowercases — that is what gives
 * MediaWiki's first-letter case-insensitivity (here: full case-insensitivity,
 * matching decisions O1's identity rule `(namespace, slug)`).
 *
 * Transclusion resolves to the template page's **EN head, always**
 * (Addendum A8); the rendering locale is irrelevant. Pages created
 * non-EN-first (decisions O4) have no EN head, so those fall back to the
 * earliest-created locale head — deterministic, and the only way such a page
 * is transcludable at all.
 *
 * A store instance memoizes its lookups, so create one per render (they are
 * cheap) rather than sharing one across requests.
 */
export function createPageStore(db: Db, options: PageStoreOptions = {}): PageStore {
  const mediaPath = options.mediaPath ?? "/api/media/";
  const sourceCache = new Map<string, string | null>();
  const existsCache = new Map<string, boolean>();
  const fileCache = new Map<string, { src: string; width: number; height: number } | null>();

  function locate(key: TitleKey): { nsName: StorableNamespace; slug: string } | null {
    const parsed = parseTitleKey(key);
    if (!parsed || !parsed.storable || !parsed.nsName || parsed.slug === "") return null;
    return { nsName: parsed.nsName, slug: parsed.slug };
  }

  return {
    getSource(key: TitleKey): string | null {
      if (sourceCache.has(key)) return sourceCache.get(key) ?? null;
      const at = locate(key);
      let source: string | null = null;
      if (at) {
        const row = db
          .select({ content: revisions.content })
          .from(pages)
          .innerJoin(pageLocales, eq(pageLocales.pageId, pages.id))
          .innerJoin(revisions, eq(revisions.id, pageLocales.currentRevId))
          .where(and(eq(pages.namespace, at.nsName), eq(pages.slug, at.slug)))
          // EN first (A8), then the earliest-created locale head (O4).
          .orderBy(
            sql`case when ${pageLocales.locale} = 'en' then 0 else 1 end`,
            pageLocales.id,
          )
          .limit(1)
          .get();
        source = row?.content ?? null;
      }
      sourceCache.set(key, source);
      return source;
    },

    exists(key: TitleKey): boolean {
      const cached = existsCache.get(key);
      if (cached !== undefined) return cached;
      const at = locate(key);
      let found = false;
      if (at) {
        const row = db
          .select({ id: pages.id })
          .from(pages)
          .innerJoin(pageLocales, eq(pageLocales.pageId, pages.id))
          .where(
            and(
              eq(pages.namespace, at.nsName),
              eq(pages.slug, at.slug),
              sql`${pageLocales.currentRevId} is not null`,
            ),
          )
          .limit(1)
          .get();
        found = row !== undefined;
      }
      existsCache.set(key, found);
      return found;
    },

    getFile(name: string) {
      if (fileCache.has(name)) return fileCache.get(name) ?? null;
      const canonical = canonicalFilename(name);
      const row = db
        .select({ width: files.width, height: files.height, filename: files.filename })
        .from(files)
        .where(eq(files.filename, canonical))
        .get();
      const result = row
        ? {
            src: `${mediaPath}${encodeURIComponent(row.filename)}`,
            width: row.width ?? 0,
            height: row.height ?? 0,
          }
        : null;
      fileCache.set(name, result);
      return result;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Render-cache invalidation (Addendum A3/A5 + versioning.md §4)       */
/* ------------------------------------------------------------------ */

/** Drop every cached version row of one (page, locale) — versioning.md §4. */
export function invalidatePageCache(db: Db, pageId: number, locale?: string): void {
  db.delete(parsedCache)
    .where(
      locale === undefined
        ? eq(parsedCache.pageId, pageId)
        : and(eq(parsedCache.pageId, pageId), eq(parsedCache.locale, locale)),
    )
    .run();
}

/**
 * Addendum A3: a page's existence or address changed ⇒ every page whose
 * cached HTML embeds a red/blue link to it must re-render (all versions).
 */
export function invalidateLinkTargets(db: Db, nsName: StorableNamespace, slug: string): void {
  db.run(sql`
    delete from parsed_cache where (page_id, locale) in (
      select from_page_id, from_locale from page_links
      where to_namespace = ${nsName} and to_slug = ${slug}
    )
  `);
  if (nsName === "template") {
    db.run(sql`
      delete from parsed_cache where (page_id, locale) in (
        select from_page_id, from_locale from template_links
        where template_slug = ${slug}
      )
    `);
  }
}

/**
 * db-schema §D pattern 12: editing Template:X drops the cache of everything
 * that transcludes it. `template_links` is fed by `meta.templatesUsed`, which
 * is transitive (Addendum A4), so this single lookup covers indirect users.
 */
export function invalidateTemplateDependents(db: Db, templateSlug: string): void {
  db.run(sql`
    delete from parsed_cache where (page_id, locale) in (
      select from_page_id, from_locale from template_links
      where template_slug = ${templateSlug}
    )
  `);
}

/** versioning.md §4: a registry / default-version change flushes everything. */
export function flushParsedCache(db: Db): void {
  db.delete(parsedCache).run();
}

export interface CacheEntry {
  pageId: number;
  locale: string;
  /** `"*"` for pages without version constructs (versioning.md §4). */
  version: string;
  revId: number;
  html: string;
}

/** Store a rendered page. Callers must skip volatile output (Addendum A5). */
export function cacheParsedHtml(db: Db, entry: CacheEntry): void {
  const renderedAt = new Date();
  db.insert(parsedCache)
    .values({
      pageId: entry.pageId,
      locale: entry.locale,
      version: entry.version,
      revId: entry.revId,
      html: entry.html,
      renderedAt,
    })
    .onConflictDoUpdate({
      target: [parsedCache.pageId, parsedCache.locale, parsedCache.version],
      set: { revId: entry.revId, html: entry.html, renderedAt },
    })
    .run();
}

/* ------------------------------------------------------------------ */
/* Link / category / search refresh from ParseResult.meta (A4)         */
/* ------------------------------------------------------------------ */

function refreshPageLinks(tx: Tx, pageId: number, locale: string, meta: PageMeta): void {
  tx.delete(pageLinks)
    .where(and(eq(pageLinks.fromPageId, pageId), eq(pageLinks.fromLocale, locale)))
    .run();
  const seen = new Set<string>();
  const rows: {
    fromPageId: number;
    fromLocale: string;
    toNamespace: Namespace;
    toSlug: string;
  }[] = [];
  for (const key of meta.linksTo) {
    const parsed = parseTitleKey(key);
    // A7: non-storable namespaces are never recorded (the enum would reject).
    if (!parsed || !parsed.storable || !parsed.nsName || parsed.slug === "") continue;
    const dedupe = `${parsed.nsName}:${parsed.slug}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    rows.push({
      fromPageId: pageId,
      fromLocale: locale,
      toNamespace: parsed.nsName,
      toSlug: parsed.slug,
    });
  }
  if (rows.length) tx.insert(pageLinks).values(rows).onConflictDoNothing().run();
}

function refreshTemplateLinks(tx: Tx, pageId: number, locale: string, meta: PageMeta): void {
  tx.delete(templateLinks)
    .where(and(eq(templateLinks.fromPageId, pageId), eq(templateLinks.fromLocale, locale)))
    .run();
  const seen = new Set<string>();
  const rows: { fromPageId: number; fromLocale: string; templateSlug: string }[] = [];
  for (const key of meta.templatesUsed) {
    const parsed = parseTitleKey(key);
    // template_links carries no namespace column: it means Template ns.
    // Transclusions of other namespaces ({{:Main page}}) are not tracked for
    // invalidation — documented limitation.
    if (!parsed || parsed.nsName !== "template" || parsed.slug === "") continue;
    if (seen.has(parsed.slug)) continue;
    seen.add(parsed.slug);
    rows.push({ fromPageId: pageId, fromLocale: locale, templateSlug: parsed.slug });
  }
  if (rows.length) tx.insert(templateLinks).values(rows).onConflictDoNothing().run();
}

/** EN-only: category membership is a property of the page, not a translation. */
function refreshCategoryLinks(tx: Tx, pageId: number, meta: PageMeta): void {
  tx.delete(categoryLinks).where(eq(categoryLinks.pageId, pageId)).run();
  const seen = new Set<string>();
  const rows: { pageId: number; categorySlug: string; sortKey: string }[] = [];
  for (const cat of meta.categories) {
    const slug = slugifyTitle(cat.name); // decisions O1
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    rows.push({ pageId, categorySlug: slug, sortKey: cat.sortKey ?? "" });
  }
  if (rows.length) tx.insert(categoryLinks).values(rows).onConflictDoNothing().run();
}

function upsertSearchDoc(
  tx: Tx,
  row: {
    id: number;
    pageId: number;
    locale: string;
    namespace: Namespace;
    slug: string;
    title: string;
    body: string;
  },
): void {
  tx.insert(searchDocs)
    .values(row)
    .onConflictDoUpdate({
      target: searchDocs.id,
      set: {
        pageId: row.pageId,
        locale: row.locale,
        namespace: row.namespace,
        slug: row.slug,
        title: row.title,
        body: row.body,
      },
    })
    .run();
}

/* ------------------------------------------------------------------ */
/* Save (db-schema §D pattern 2 + Addenda A3/A4/A5, versioning §4)     */
/* ------------------------------------------------------------------ */

/**
 * Every action the audit log records. One union so a new action cannot be
 * spelled two ways, and so the console can translate each one.
 *
 * Content actions (`page.*`) are new: revisions already record who wrote what,
 * but they answer "what happened to this page", never "what has this account
 * been doing" — which is the question a moderator actually asks. The audit log
 * is that second reading, across pages, uploads, languages and the registry.
 */
export type AuditAction =
  | "page.create"
  | "page.edit"
  | "page.rollback"
  | "page.delete"
  | "media.upload"
  | "lang.propose"
  | "lang.approve"
  | "lang.deactivate"
  | "version.create"
  | "version.update"
  | "version.delete"
  | "version.default"
  | "setting.update"
  | "admin.grant"
  | "admin.revoke"
  | "user.ban"
  | "user.unban"
  | "user.report"
  | "report.resolve";

/**
 * Append one audit row. Always called inside the caller's transaction, so an
 * action and its record commit together or not at all — a log that can
 * disagree with what happened is worse than no log.
 *
 * The actor is upserted first because `audit_log.actor_uid` is a foreign key
 * into `users`, and the person doing an admin action may have no row there:
 * a manager who registers a version without ever having edited a page exists
 * only in Firestore. Doing it here rather than at each call site means a new
 * audited action cannot forget and fail with a bare FOREIGN KEY error.
 */
export function writeAudit(
  tx: Db,
  entry: {
    action: AuditAction;
    actor: Actor;
    target: string;
    payload?: Record<string, unknown>;
  },
): void {
  upsertUser(tx, entry.actor);
  tx.insert(auditLog)
    .values({
      action: entry.action,
      actorUid: entry.actor.uid,
      target: entry.target,
      payload: entry.payload ?? {},
    })
    .run();
}

export interface SaveEditInput {
  pageId: number;
  locale: string;
  /** Display title for this locale (snapshotted onto the revision). */
  title: string;
  content: string;
  comment?: string;
  isMinor?: boolean;
  /** Head the editor loaded; null when creating this locale. */
  parentRevId: number | null;
  /**
   * EN basis for a translation. `undefined` = derive it from the current EN
   * head; `null` = explicitly no basis ⇒ "original", not "outdated" (O4).
   * Always forced to null for EN saves.
   */
  translatedFromRevId?: number | null;
  author: Actor;
  /**
   * What the audit log should call this save. Defaults to `page.edit`;
   * createPage and rollback pass their own so the three read apart in the
   * moderation timeline.
   */
  auditAction?: Extract<AuditAction, "page.create" | "page.edit" | "page.rollback">;
  /** Extra audit payload — the rollback target, for instance. */
  auditPayload?: Record<string, unknown>;
  /** Version-agnostic parse of `content` (versioning.md §5). */
  parse: ParseForSave;
  /** Override for search_docs.body; defaults to the rendered HTML flattened. */
  searchBody?: string;
}

export interface SaveEditResult {
  revId: number;
  pageId: number;
  locale: string;
  pageLocaleId: number;
  meta: PageMeta;
  /** True when the render was cached under `"*"` (not volatile, not scoped). */
  cached: boolean;
}

/**
 * The whole save, in one immediate transaction: users mirror, optimistic
 * conflict check, revision insert, head update, EN-branch redirect/category
 * refresh, link/template/search refresh, and cache invalidation.
 */
export function saveEdit(db: WikiDb, input: SaveEditInput): SaveEditResult {
  return db.transaction((tx) => applySave(tx, input), { behavior: "immediate" });
}

function applySave(tx: Tx, input: SaveEditInput): SaveEditResult {
  upsertUser(tx, input.author);

  const page = tx.select().from(pages).where(eq(pages.id, input.pageId)).get();
  if (!page) throw new PageMissingError(`#${input.pageId}`);

  const lang = tx
    .select({ code: languages.code })
    .from(languages)
    .where(eq(languages.code, input.locale))
    .get();
  if (!lang) throw new LanguageMissingError(input.locale);

  let pl = tx
    .select()
    .from(pageLocales)
    .where(and(eq(pageLocales.pageId, input.pageId), eq(pageLocales.locale, input.locale)))
    .get();

  if (!pl) {
    // Creating this locale (a new page, or a new translation of one).
    if (input.parentRevId !== null) throw new EditConflictError(null);
    pl = tx
      .insert(pageLocales)
      .values({ pageId: input.pageId, locale: input.locale, title: input.title })
      .returning()
      .get();
  } else if (pl.currentRevId !== input.parentRevId) {
    throw new EditConflictError(pl.currentRevId);
  }

  const parsed = resolveParse(input.parse, input.content);
  const meta = parsed.meta;

  // O4: EN basis for translations. undefined ⇒ derive from the EN head;
  // null ⇒ deliberately unbased ("original" badge, never "outdated").
  let basis: number | null = null;
  if (input.locale !== "en") {
    if (input.translatedFromRevId === undefined) {
      const en = tx
        .select({ currentRevId: pageLocales.currentRevId })
        .from(pageLocales)
        .where(and(eq(pageLocales.pageId, input.pageId), eq(pageLocales.locale, "en")))
        .get();
      basis = en?.currentRevId ?? null;
    } else {
      basis = input.translatedFromRevId;
    }
  }

  const rev = tx
    .insert(revisions)
    .values({
      pageId: input.pageId,
      locale: input.locale,
      title: input.title,
      content: input.content,
      comment: input.comment ?? "",
      isMinor: input.isMinor ?? false,
      parentRevId: input.parentRevId,
      translatedFromRevId: basis,
      authorUid: input.author.uid,
      authorName: input.author.displayName,
    })
    .returning({ id: revisions.id })
    .get();

  tx.update(pageLocales)
    .set({
      currentRevId: rev.id,
      title: input.title,
      versionScoped: meta.versionScoped,
      versionBoundaries: JSON.stringify(meta.versionBoundaries),
      updatedAt: new Date(),
    })
    .where(eq(pageLocales.id, pl.id))
    .run();

  // EN is canonical: redirect target and category membership follow EN.
  if (input.locale === "en") {
    const target = meta.redirect ? storableTarget(meta.redirect.target) : null;
    tx.update(pages)
      .set({
        redirectNs: target?.nsName ?? null,
        redirectSlug: target?.slug ?? null,
        redirectFragment: target?.fragment ?? null, // Addendum A2
      })
      .where(eq(pages.id, input.pageId))
      .run();
    refreshCategoryLinks(tx, input.pageId, meta);
  }

  refreshPageLinks(tx, input.pageId, input.locale, meta);
  refreshTemplateLinks(tx, input.pageId, input.locale, meta);
  upsertSearchDoc(tx, {
    id: pl.id,
    pageId: input.pageId,
    locale: input.locale,
    namespace: page.namespace,
    slug: page.slug,
    title: input.title,
    body: input.searchBody ?? htmlToPlainText(parsed.html),
  });

  // versioning.md §4: editing a page drops ALL of its version rows.
  invalidatePageCache(tx, input.pageId, input.locale);

  // A5: volatile output is never cached. Version-scoped pages render lazily
  // per selection; unscoped pages warm the shared "*" row from this parse.
  let cached = false;
  if (!meta.volatile && !meta.versionScoped) {
    cacheParsedHtml(tx, {
      pageId: input.pageId,
      locale: input.locale,
      version: "*",
      revId: rev.id,
      html: parsed.html,
    });
    cached = true;
  }

  // Pattern 12 + versioning.md §4: template edits invalidate dependents.
  if (page.namespace === "template") invalidateTemplateDependents(tx, page.slug);

  writeAudit(tx, {
    action: input.auditAction ?? "page.edit",
    actor: input.author,
    target: `page:${page.namespace}/${page.slug}`,
    payload: {
      revId: rev.id,
      locale: input.locale,
      comment: input.comment ?? "",
      minor: input.isMinor === true,
      ...input.auditPayload,
    },
  });

  return {
    revId: rev.id,
    pageId: input.pageId,
    locale: input.locale,
    pageLocaleId: pl.id,
    meta,
    cached,
  };
}

export interface CreatePageInput extends Omit<SaveEditInput, "pageId" | "parentRevId"> {
  namespace: Namespace;
  /** Defaults to slugifyTitle(title) — decisions O1. */
  slug?: string;
}

export interface CreatePageResult extends SaveEditResult {
  namespace: Namespace;
  slug: string;
}

/** Create a page and its first revision in one transaction. */
export function createPage(db: WikiDb, input: CreatePageInput): CreatePageResult {
  const slug = input.slug ?? slugifyTitle(input.title);
  if (!slug) throw new InvalidTitleError(input.title);

  return db.transaction(
    (tx) => {
      const existing = tx
        .select({ id: pages.id })
        .from(pages)
        .where(and(eq(pages.namespace, input.namespace), eq(pages.slug, slug)))
        .get();
      if (existing) throw new PageExistsError(`${input.namespace}:${slug}`);

      const page = tx
        .insert(pages)
        .values({ namespace: input.namespace, slug })
        .returning({ id: pages.id })
        .get();

      const saved = applySave(tx, {
        ...input,
        pageId: page.id,
        parentRevId: null,
        auditAction: "page.create",
      });

      // A3: a red link just turned blue — everything pointing here re-renders.
      invalidateLinkTargets(tx, input.namespace, slug);

      return { ...saved, namespace: input.namespace, slug };
    },
    { behavior: "immediate" },
  );
}

export interface RollbackInput {
  pageId: number;
  locale: string;
  targetRevId: number;
  actor: Actor;
  /** Parses the target revision's content (version-agnostic). */
  parse: ParseForSave;
  comment?: string;
}

/**
 * db-schema §D pattern 11: a new revision copying old content. Going through
 * the save path keeps links, search, cache and history append-only.
 */
export function rollback(db: WikiDb, input: RollbackInput): SaveEditResult {
  return db.transaction(
    (tx) => {
      const target = tx
        .select()
        .from(revisions)
        .where(
          and(
            eq(revisions.id, input.targetRevId),
            eq(revisions.pageId, input.pageId), // guard: rev must belong to page
            eq(revisions.locale, input.locale),
          ),
        )
        .get();
      if (!target) throw new RevisionMissingError(input.targetRevId);

      const head = tx
        .select({ currentRevId: pageLocales.currentRevId })
        .from(pageLocales)
        .where(and(eq(pageLocales.pageId, input.pageId), eq(pageLocales.locale, input.locale)))
        .get();
      if (!head) throw new PageMissingError(`#${input.pageId}/${input.locale}`);

      return applySave(tx, {
        pageId: input.pageId,
        locale: input.locale,
        title: target.title,
        content: target.content,
        comment: input.comment ?? `Rollback to r${target.id}`,
        isMinor: false,
        parentRevId: head.currentRevId,
        translatedFromRevId: target.translatedFromRevId,
        author: input.actor,
        // The comment is the caller's to overwrite, so the fact that this WAS
        // a rollback — and to which revision — only survives structurally here.
        auditAction: "page.rollback",
        auditPayload: { targetRevId: target.id },
        parse: input.parse,
      });
    },
    { behavior: "immediate" },
  );
}

export interface DeletePageInput {
  pageId: number;
  actor: Actor;
  reason?: string;
}

/**
 * Addendum A6 ordering: search_docs rows first (FK-free, so the FTS delete
 * trigger must fire before the cascade), then the page (cascades revisions,
 * locales, links, cache), then A3 invalidation, then the audit row.
 */
export function deletePage(
  db: WikiDb,
  input: DeletePageInput,
): { namespace: Namespace; slug: string } {
  return db.transaction(
    (tx) => {
      upsertUser(tx, input.actor);
      const page = tx.select().from(pages).where(eq(pages.id, input.pageId)).get();
      if (!page) throw new PageMissingError(`#${input.pageId}`);

      const localeIds = tx
        .select({ id: pageLocales.id })
        .from(pageLocales)
        .where(eq(pageLocales.pageId, input.pageId))
        .all()
        .map((r) => r.id);
      if (localeIds.length) {
        tx.delete(searchDocs).where(inArray(searchDocs.id, localeIds)).run();
      }

      tx.delete(pages).where(eq(pages.id, input.pageId)).run();
      invalidateLinkTargets(tx, page.namespace, page.slug);

      writeAudit(tx, {
        action: "page.delete",
        actor: input.actor,
        target: `page:${page.namespace}/${page.slug}`,
        payload: { reason: input.reason ?? "" },
      });

      return { namespace: page.namespace, slug: page.slug };
    },
    { behavior: "immediate" },
  );
}

/* ------------------------------------------------------------------ */
/* Site settings                                                       */
/* ------------------------------------------------------------------ */

export const DEFAULT_VERSION_KEY = "default_version";

/** Values are JSON-encoded (db-schema §A). */
export function getSetting<T = unknown>(db: Db, key: string): T | null {
  const row = db.select().from(siteSettings).where(eq(siteSettings.key, key)).get();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return row.value as unknown as T;
  }
}

/**
 * Write a setting. Changing `default_version` flushes the whole render cache
 * (versioning.md §4) — cheap, derived data.
 */
export function setSetting(
  db: WikiDb,
  key: string,
  value: unknown,
  updatedBy?: string,
  actor?: Actor,
): void {
  db.transaction(
    (tx) => {
      const encoded = JSON.stringify(value);
      const updatedAt = new Date();
      tx.insert(siteSettings)
        .values({ key, value: encoded, updatedBy: updatedBy ?? null, updatedAt })
        .onConflictDoUpdate({
          target: siteSettings.key,
          set: { value: encoded, updatedBy: updatedBy ?? null, updatedAt },
        })
        .run();
      // Every setting is worth a row, not just the default version — an
      // unaudited settings key would be a quiet way to change the site.
      if (actor) {
        writeAudit(tx, {
          action: key === DEFAULT_VERSION_KEY ? "version.default" : "setting.update",
          actor,
          target: key === DEFAULT_VERSION_KEY ? `version:${String(value)}` : `setting:${key}`,
          payload: key === DEFAULT_VERSION_KEY ? {} : { value: encoded.slice(0, 500) },
        });
      }
      if (key === DEFAULT_VERSION_KEY) {
        flushParsedCache(tx);
      }
    },
    { behavior: "immediate" },
  );
}

/* ------------------------------------------------------------------ */
/* Version registry (versioning.md §1/§4 — decision O10)               */
/* ------------------------------------------------------------------ */

/** versioning.md §1 seed list; ordinal = major*1000 (+ minor). */
export const SEED_VERSION_IDS = [
  "v45",
  "v47",
  "v49",
  "v50",
  "v55",
  "v56",
  "v60",
  "v62",
  "v64",
  "v66",
  "v68",
  "v69",
  "v70",
] as const;

export const SEED_DEFAULT_VERSION = "v70";

/**
 * `v64.1` → 64001. Throws for ids that are not `v<major>[.<minor>]`, and for
 * ones whose ordinal would not be a real sort key: `v` followed by 400 digits
 * matches the shape but arrives as `Infinity`, which SQLite stores happily in
 * an INTEGER column and which then sorts above every real version in every
 * selector, in a registry each page render reads (versioning.md §1: all range
 * math runs on ordinals). A number that cannot be compared is not an ordinal.
 */
export function versionOrdinal(id: string): number {
  const m = /^v(\d+)(?:\.(\d+))?$/i.exec(id.trim());
  if (!m) throw new InvalidTitleError(`version id ${id}`);
  const ordinal = Number(m[1]) * 1000 + (m[2] ? Number(m[2]) : 0);
  if (!Number.isSafeInteger(ordinal)) throw new InvalidTitleError(`version id ${id}`);
  return ordinal;
}

export interface VersionInput {
  id: string;
  label?: string;
  ordinal?: number;
  releasedAt?: Date | null;
  notes?: string | null;
  status?: "current" | "supported" | "legacy";
}

/** Idempotent §1 seed: the 13 ids, newest `current`, plus default_version. */
export function seedVersions(db: WikiDb): void {
  db.transaction(
    (tx) => {
      const newest = SEED_VERSION_IDS[SEED_VERSION_IDS.length - 1];
      for (const id of SEED_VERSION_IDS) {
        tx.insert(versions)
          .values({
            id,
            label: id,
            ordinal: versionOrdinal(id),
            status: id === newest ? "current" : "legacy",
          })
          .onConflictDoNothing()
          .run();
      }
      tx.insert(siteSettings)
        .values({
          key: DEFAULT_VERSION_KEY,
          value: JSON.stringify(SEED_DEFAULT_VERSION),
          updatedAt: new Date(),
        })
        .onConflictDoNothing()
        .run();
    },
    { behavior: "immediate" },
  );
}

export function listVersions(db: Db) {
  return db.select().from(versions).orderBy(versions.ordinal).all();
}

/** Registry snapshot for `ParseContext.versions` (versioning.md §3). */
export function loadVersionTable(db: Db): VersionTable {
  const ordered = listVersions(db).map((r) => ({
    id: r.id,
    label: r.label,
    ordinal: r.ordinal,
    status: r.status,
  }));
  const byId: VersionTable["byId"] = {};
  for (const entry of ordered) byId[entry.id] = entry;
  const setting = getSetting<string>(db, DEFAULT_VERSION_KEY);
  const defaultId =
    setting && byId[setting] ? setting : (ordered[ordered.length - 1]?.id ?? setting ?? "");
  return { byId, ordered, defaultId };
}

export function createVersion(db: WikiDb, input: VersionInput, actor?: Actor) {
  const id = input.id.trim().toLowerCase();
  return db.transaction(
    (tx) => {
      const created = tx
        .insert(versions)
        .values({
          id,
          label: input.label ?? id,
          ordinal: input.ordinal ?? versionOrdinal(id),
          releasedAt: input.releasedAt ?? null,
          notes: input.notes ?? null,
          status: input.status ?? "legacy",
        })
        .returning()
        .get();
      if (actor) {
        writeAudit(tx, { action: "version.create", actor, target: `version:${id}` });
      }
      flushParsedCache(tx); // versioning.md §4
      return created;
    },
    { behavior: "immediate" },
  );
}

export function updateVersion(
  db: WikiDb,
  id: string,
  patch: Omit<VersionInput, "id">,
  actor?: Actor,
) {
  return db.transaction(
    (tx) => {
      const existing = tx.select().from(versions).where(eq(versions.id, id)).get();
      if (!existing) throw new VersionMissingError(id);
      const updated = tx
        .update(versions)
        .set({
          label: patch.label ?? existing.label,
          ordinal: patch.ordinal ?? existing.ordinal,
          releasedAt: patch.releasedAt === undefined ? existing.releasedAt : patch.releasedAt,
          notes: patch.notes === undefined ? existing.notes : patch.notes,
          status: patch.status ?? existing.status,
        })
        .where(eq(versions.id, id))
        .returning()
        .get();
      if (actor) {
        writeAudit(tx, {
          action: "version.update",
          actor,
          target: `version:${id}`,
          payload: { label: updated.label },
        });
      }
      flushParsedCache(tx);
      return updated;
    },
    { behavior: "immediate" },
  );
}

/** Pages whose `version_boundaries` still name `versionId` (JSON1 scan). */
export function versionReferences(db: Db, versionId: string): VersionReference[] {
  return db.all<VersionReference>(sql`
    select pl.page_id as "pageId", p.namespace as "namespace",
           p.slug as "slug", pl.locale as "locale"
    from page_locales pl
    join pages p on p.id = pl.page_id
    join json_each(pl.version_boundaries) je
    where je.value = ${versionId}
    order by p.namespace, p.slug, pl.locale
  `);
}

/** versioning.md §6: DELETE refuses while any page still names the id. */
export function deleteVersion(db: WikiDb, id: string, actor?: Actor): void {
  db.transaction(
    (tx) => {
      const existing = tx.select().from(versions).where(eq(versions.id, id)).get();
      if (!existing) throw new VersionMissingError(id);
      const refs = versionReferences(tx, id);
      if (refs.length) throw new VersionInUseError(id, refs);
      tx.delete(versions).where(eq(versions.id, id)).run();
      if (actor) {
        writeAudit(tx, { action: "version.delete", actor, target: `version:${id}` });
      }
      flushParsedCache(tx);
    },
    { behavior: "immediate" },
  );
}

/* ------------------------------------------------------------------ */
/* Languages registry                                                  */
/* ------------------------------------------------------------------ */

export interface LanguageInput {
  code: string;
  label: string;
  nativeName: string;
  direction?: "ltr" | "rtl";
  status?: "active" | "proposed";
  createdBy?: string | null;
}

export function listLanguages(db: Db, status?: "active" | "proposed") {
  const rows = status
    ? db.select().from(languages).where(eq(languages.status, status)).all()
    : db.select().from(languages).all();
  return rows.sort((a, b) => a.code.localeCompare(b.code));
}

export function getLanguage(db: Db, code: string) {
  return db.select().from(languages).where(eq(languages.code, code)).get() ?? null;
}

/** Idempotent: EN is always present and active (db-schema §E seed note). */
export function seedLanguages(db: Db): void {
  db.insert(languages)
    .values({ code: "en", label: "English", nativeName: "English", status: "active" })
    .onConflictDoNothing()
    .run();
}

/** Editors propose languages; admins activate them (routes.md /api/languages). */
export function createLanguage(db: WikiDb, input: LanguageInput, actor?: Actor) {
  return db.transaction(
    (tx) => {
      const row = tx
        .insert(languages)
        .values({
          code: input.code,
          label: input.label,
          nativeName: input.nativeName,
          direction: input.direction ?? "ltr",
          status: input.status ?? "proposed",
          createdBy: input.createdBy ?? null,
        })
        .onConflictDoUpdate({
          target: languages.code,
          set: { label: input.label, nativeName: input.nativeName },
        })
        .returning()
        .get();

      // After the write, and inside it: an audit row for a language that
      // failed to insert would be a record of something that never happened.
      if (actor) {
        writeAudit(tx, {
          action: "lang.propose",
          actor,
          target: `lang:${input.code}`,
          payload: { label: input.label },
        });
      }
      return row;
    },
    { behavior: "immediate" },
  );
}

export function setLanguageStatus(
  db: WikiDb,
  code: string,
  status: "active" | "proposed",
  actor: Actor,
) {
  return db.transaction(
    (tx) => {
      upsertUser(tx, actor);
      const existing = tx.select().from(languages).where(eq(languages.code, code)).get();
      if (!existing) throw new LanguageMissingError(code);
      const updated = tx
        .update(languages)
        .set({ status })
        .where(eq(languages.code, code))
        .returning()
        .get();
      writeAudit(tx, {
        action: status === "active" ? "lang.approve" : "lang.deactivate",
        actor,
        target: `lang:${code}`,
        payload: { status },
      });
      return updated;
    },
    { behavior: "immediate" },
  );
}

/* ------------------------------------------------------------------ */
/* Navigation categories (decisions O3)                                */
/* ------------------------------------------------------------------ */

export interface NavCategoryInput {
  slug: string;
  sortOrder: number;
  labels: Record<string, string>;
  description?: Record<string, string> | null;
}

export interface NavCategory {
  slug: string;
  sortOrder: number;
  labels: Record<string, string>;
  description: Record<string, string> | null;
}

function parseJsonRecord(value: string | null): Record<string, string> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : null;
  } catch {
    return null;
  }
}

/** Nav menu source of truth — NOT wiki [[Category:]] membership (O3). */
export function listNavCategories(db: Db): NavCategory[] {
  return db
    .select()
    .from(categories)
    .orderBy(categories.sortOrder)
    .all()
    .map((row) => ({
      slug: row.slug,
      sortOrder: row.sortOrder,
      labels: parseJsonRecord(row.labels) ?? {},
      description: parseJsonRecord(row.description),
    }));
}

export function upsertNavCategory(db: Db, input: NavCategoryInput): void {
  const labels = JSON.stringify(input.labels);
  const description = input.description ? JSON.stringify(input.description) : null;
  db.insert(categories)
    .values({ slug: input.slug, sortOrder: input.sortOrder, labels, description })
    .onConflictDoUpdate({
      target: categories.slug,
      set: { sortOrder: input.sortOrder, labels, description },
    })
    .run();
}

export function seedNavCategories(db: WikiDb, entries: NavCategoryInput[]): void {
  db.transaction(
    (tx) => {
      for (const entry of entries) upsertNavCategory(tx, entry);
    },
    { behavior: "immediate" },
  );
}

/* ------------------------------------------------------------------ */
/* Admin grants + bans (Addendum A1, decisions O5)                     */
/* ------------------------------------------------------------------ */

/**
 * Addendum A1: an active grant is a row with `revoked_at IS NULL`. A banned
 * user is never an admin, whatever their grants say.
 */
export function hasActiveGrant(db: Db, uid: string): boolean {
  const user = db.select({ banned: users.banned }).from(users).where(eq(users.uid, uid)).get();
  if (user?.banned) return false;
  const row = db
    .select({ id: adminGrants.id })
    .from(adminGrants)
    .where(and(eq(adminGrants.uid, uid), isNull(adminGrants.revokedAt)))
    .limit(1)
    .get();
  return row !== undefined;
}

export function listGrants(db: Db, opts: { uid?: string; activeOnly?: boolean } = {}) {
  const conditions = [
    opts.uid ? eq(adminGrants.uid, opts.uid) : undefined,
    opts.activeOnly ? isNull(adminGrants.revokedAt) : undefined,
  ].filter((c) => c !== undefined);
  const rows = conditions.length
    ? db
        .select()
        .from(adminGrants)
        .where(and(...conditions))
        .all()
    : db.select().from(adminGrants).all();
  return rows.sort((a, b) => b.id - a.id);
}

export function grantAdmin(
  db: WikiDb,
  opts: { uid: string; grantedBy: Actor; displayName?: string },
) {
  return db.transaction(
    (tx) => {
      upsertUser(tx, opts.grantedBy);
      upsertUser(tx, { uid: opts.uid, displayName: opts.displayName ?? opts.uid });

      const active = tx
        .select()
        .from(adminGrants)
        .where(and(eq(adminGrants.uid, opts.uid), isNull(adminGrants.revokedAt)))
        .get();
      if (active) return active; // already an admin: idempotent, no audit noise

      const created = tx
        .insert(adminGrants)
        .values({ uid: opts.uid, grantedBy: opts.grantedBy.uid })
        .returning()
        .get();
      writeAudit(tx, {
        action: "admin.grant",
        actor: opts.grantedBy,
        target: `user:${opts.uid}`,
        payload: { grantId: created.id },
      });
      return created;
    },
    { behavior: "immediate" },
  );
}

export function revokeAdmin(db: WikiDb, opts: { uid: string; revokedBy: Actor }): void {
  // A1: no self-revoke.
  if (opts.uid === opts.revokedBy.uid) throw new SelfRevokeError();
  db.transaction(
    (tx) => {
      upsertUser(tx, opts.revokedBy);
      const active = tx
        .select()
        .from(adminGrants)
        .where(and(eq(adminGrants.uid, opts.uid), isNull(adminGrants.revokedAt)))
        .all();
      if (!active.length) throw new GrantMissingError(opts.uid);
      tx.update(adminGrants)
        .set({ revokedBy: opts.revokedBy.uid, revokedAt: new Date() })
        .where(and(eq(adminGrants.uid, opts.uid), isNull(adminGrants.revokedAt)))
        .run();
      writeAudit(tx, {
        action: "admin.revoke",
        actor: opts.revokedBy,
        target: `user:${opts.uid}`,
        payload: { revoked: active.map((g) => g.id) },
      });
    },
    { behavior: "immediate" },
  );
}

/** O5: SQLite `users.banned` is the moderation-view mirror of Firestore. */
export function setUserBanned(
  db: WikiDb,
  opts: { uid: string; banned: boolean; actor: Actor; reason?: string; displayName?: string },
): void {
  db.transaction(
    (tx) => {
      upsertUser(tx, opts.actor);
      upsertUser(tx, { uid: opts.uid, displayName: opts.displayName ?? opts.uid });
      tx.update(users).set({ banned: opts.banned }).where(eq(users.uid, opts.uid)).run();
      writeAudit(tx, {
        action: opts.banned ? "user.ban" : "user.unban",
        actor: opts.actor,
        target: `user:${opts.uid}`,
        payload: { reason: opts.reason ?? "" },
      });
    },
    { behavior: "immediate" },
  );
}

/* ------------------------------------------------------------------ */
/* Files (decisions O6)                                                */
/* ------------------------------------------------------------------ */

export interface FileInput {
  filename: string;
  storedPath: string;
  mime: string;
  size: number;
  sha1: string;
  width?: number | null;
  height?: number | null;
  uploaderUid: string;
}

/** Upserts on the canonical filename (O6: NFC, lowercase, runs → `-`). */
export function upsertFile(db: WikiDb, input: FileInput, actor?: Actor) {
  const filename = canonicalFilename(input.filename);
  const uploadedAt = new Date();
  return db.transaction(
    (tx) => {
      const row = tx
        .insert(files)
        .values({
          filename,
          storedPath: input.storedPath,
          mime: input.mime,
          size: input.size,
          sha1: input.sha1,
          width: input.width ?? null,
          height: input.height ?? null,
          uploaderUid: input.uploaderUid,
          uploadedAt,
        })
        .onConflictDoUpdate({
          target: files.filename,
          set: {
            storedPath: input.storedPath,
            mime: input.mime,
            size: input.size,
            sha1: input.sha1,
            width: input.width ?? null,
            height: input.height ?? null,
            uploadedAt,
          },
        })
        .returning()
        .get();

      // Same transaction as the upsert — a re-upload replaces the bytes
      // behind a name, so it earns a row of its own just as a first one does.
      if (actor) {
        writeAudit(tx, {
          action: "media.upload",
          actor,
          target: `file:${filename}`,
          payload: { mime: input.mime, size: input.size },
        });
      }
      return row;
    },
    { behavior: "immediate" },
  );
}

/** Lookup by any spelling of the name; canonicalized per O6. */
export function getFileRecord(db: Db, name: string) {
  return db.select().from(files).where(eq(files.filename, canonicalFilename(name))).get() ?? null;
}

/* ------------------------------------------------------------------ */
/* Page lookup shared with ./queries and the API layer                 */
/* ------------------------------------------------------------------ */

/**
 * Page row by identity `(namespace, slug)` — decisions O1. The slug argument
 * may be either an already-slugified path segment or a raw title; both land
 * on the same row because `slugifyTitle` is idempotent.
 */
export function findPage(db: Db, nsName: Namespace, slug: string) {
  return (
    db
      .select()
      .from(pages)
      .where(and(eq(pages.namespace, nsName), eq(pages.slug, slugifyTitle(slug) || slug)))
      .get() ?? null
  );
}

export { NS_ID_BY_STORABLE, STORABLE_NS_BY_ID };

/* ------------------------------------------------------------------ */
/* Reports — what an ordinary editor can do about a bad actor          */
/* ------------------------------------------------------------------ */

export interface ReportInput {
  /**
   * Who is being reported — a uid that must ALREADY have a `users` row. The
   * caller verifies that (api/reports/route.ts); the foreign key here is the
   * backstop. Nothing about the target is taken from the reporter, so filing a
   * report cannot create or rename an account.
   */
  targetUid: string;
  reporter: Actor;
  reason?: string;
  /** What prompted it — e.g. "revision:1841" or "page:main/titan". */
  context?: string;
}

/**
 * File a report. Any signed-in account may; only a manager may act on one.
 *
 * The audit row is written alongside deliberately: filing a report IS an
 * action, and a moderator looking at somebody's history should see that they
 * report people — a pattern that only shows up when reports and edits sit in
 * the same timeline.
 */
export function fileReport(db: WikiDb, input: ReportInput) {
  return db.transaction(
    (tx) => {
      // Only the reporter, whose name comes from their own verified
      // principal. The target is looked up, never written: see ReportInput.
      upsertUser(tx, input.reporter);

      const created = tx
        .insert(reports)
        .values({
          targetUid: input.targetUid,
          reporterUid: input.reporter.uid,
          reason: input.reason ?? "",
          context: input.context ?? "",
        })
        .returning()
        .get();

      writeAudit(tx, {
        action: "user.report",
        actor: input.reporter,
        target: `user:${input.targetUid}`,
        payload: { reportId: created.id, context: input.context ?? "" },
      });

      return created;
    },
    { behavior: "immediate" },
  );
}

/** Close a report. `dismissed` records "looked at it, nothing to do". */
export function resolveReport(
  db: WikiDb,
  opts: { id: number; status: "resolved" | "dismissed"; actor: Actor },
): void {
  db.transaction(
    (tx) => {
      upsertUser(tx, opts.actor);
      const existing = tx.select().from(reports).where(eq(reports.id, opts.id)).get();
      if (!existing) throw new ReportMissingError(opts.id);
      // Whoever got here first owns the outcome. Two managers working the same
      // queue is the normal case, not an edge one, and re-closing would
      // overwrite the record of who actually dealt with it.
      if (existing.status !== "open") throw new ReportClosedError(opts.id, existing.status);

      tx.update(reports)
        .set({ status: opts.status, resolvedBy: opts.actor.uid, resolvedAt: new Date() })
        .where(eq(reports.id, opts.id))
        .run();

      writeAudit(tx, {
        action: "report.resolve",
        actor: opts.actor,
        target: `user:${existing.targetUid}`,
        payload: { reportId: opts.id, status: opts.status },
      });
    },
    { behavior: "immediate" },
  );
}
