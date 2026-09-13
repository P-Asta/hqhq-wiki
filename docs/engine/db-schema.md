# Database Schema & Data Access — hqhq-wiki

SQLite via `better-sqlite3` + Drizzle ORM (`sqlite-core`). Single-file DB at
`wiki-data/wiki.db`, uploads on disk under `wiki-data/uploads/`. Auth is Firebase
(uid strings); anonymous read, logged-in edit, admins manage.

Packages to add:

```
yarn add better-sqlite3 drizzle-orm
yarn add -D drizzle-kit @types/better-sqlite3
```

`next.config.ts` must list better-sqlite3 as a server external (it is a native
addon; Turbopack/webpack must not try to bundle it):

```ts
serverExternalPackages: ["firebase-admin", "better-sqlite3"],
```

## Decisions at a glance

| Concern | Decision | Why |
| --- | --- | --- |
| Page identity | `pages` is language-neutral (`namespace` + `slug`); per-locale state lives in `page_locales`; content lives in immutable `revisions` | Matches the "EN is canonical, translations attach to the page" model; slugs never fork per locale |
| Translation freshness | Each non-EN revision stores `translated_from_rev_id` (the EN revision it was based on). Revision ids are monotonic, so *outdated* = `translated_from_rev_id < en.current_rev_id` | One integer comparison, no timestamps, no separate freshness table |
| Redirects | Denormalized onto `pages.redirect_ns/redirect_slug`, parsed from the **EN** revision on save; one-hop follow, O(1) | Redirects are structural, so they follow the canonical language; no revision scan on view |
| Link graph | `page_links` (per source locale, target may not exist), `category_links` (EN-only, language-neutral membership), `template_links` (per source locale) | Wanted pages / what-links-here are single indexed queries; category membership must not differ per translation |
| Render cache | `parsed_cache` keyed `(page_id, locale)` storing HTML + the `rev_id` it was rendered from. **Dependency-based invalidation** (delete dependents' rows on template save via `template_links`), no TTL. A rev-id mismatch at read time also forces re-render, so the cache self-heals | Per-revision caching wastes space on history views nobody re-reads; TTL either serves stale pages or re-renders hot pages for no reason. Template edits are the only cross-page staleness source and `template_links` tracks them exactly |
| Search | FTS5 external-content table over a plain `search_docs` mirror (current revision per page-locale), synced by triggers on `search_docs`; app updates `search_docs` inside the save transaction. Tokenizer `unicode61 remove_diacritics 2` | See §B for the trigger/tokenizer rationale |
| Migrations | `drizzle-kit generate` SQL migrations, applied automatically at boot with `migrate()`; FTS + triggers live in a custom migration | See §E |

Entity overview:

```
users ─┬─< revisions >─┬─ pages ──< page_locales >── languages
       │               │             │ current_rev_id ─→ revisions
audit_log              ├─< page_links      (target = ns+slug, may not exist)
files                  ├─< category_links  (EN-parsed, language-neutral)
site_settings          ├─< template_links  (per locale)
                       └─< parsed_cache    (page_id+locale → html, rev_id)
search_docs (mirror of current revs) ══triggers══ search_fts (FTS5)
```

---

## A. Drizzle schema (`src/lib/db/schema.ts`)

```ts
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const NAMESPACES = [
  "main",
  "template",
  "category",
  "file",
  "project",
] as const;
export type Namespace = (typeof NAMESPACES)[number];

const now = () => new Date();

/* ------------------------------------------------------------------ */
/* Users (mirror of Firebase auth)                                     */
/* ------------------------------------------------------------------ */

export const users = sqliteTable("users", {
  uid: text("uid").primaryKey(), // Firebase uid
  displayName: text("display_name").notNull(),
  role: text("role", { enum: ["admin", "editor"] })
    .notNull()
    .default("editor"),
  banned: integer("banned", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(now),
});

/* ------------------------------------------------------------------ */
/* Languages registry (user-addable)                                   */
/* ------------------------------------------------------------------ */

export const languages = sqliteTable("languages", {
  code: text("code").primaryKey(), // BCP-47-ish: "en", "ko", "ja", "zh-hans"
  label: text("label").notNull(), // English label: "Korean"
  nativeName: text("native_name").notNull(), // "한국어"
  direction: text("direction", { enum: ["ltr", "rtl"] })
    .notNull()
    .default("ltr"),
  status: text("status", { enum: ["active", "proposed"] })
    .notNull()
    .default("proposed"),
  createdBy: text("created_by").references(() => users.uid),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(now),
});

/* ------------------------------------------------------------------ */
/* Pages — language-neutral entity                                     */
/* ------------------------------------------------------------------ */

export const pages = sqliteTable(
  "pages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    namespace: text("namespace", { enum: NAMESPACES })
      .notNull()
      .default("main"),
    slug: text("slug").notNull(), // canonical, EN-derived, URL-safe
    // Denormalized #REDIRECT target parsed from the current EN revision.
    // Both null when the page is not a redirect. One-hop follow only.
    redirectNs: text("redirect_ns", { enum: NAMESPACES }),
    redirectSlug: text("redirect_slug"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(now),
  },
  (t) => [
    uniqueIndex("pages_ns_slug_uq").on(t.namespace, t.slug),
    index("pages_redirect_idx").on(t.redirectNs, t.redirectSlug),
  ],
);

/* ------------------------------------------------------------------ */
/* Revisions — immutable, append-only                                  */
/* ------------------------------------------------------------------ */

export const revisions = sqliteTable(
  "revisions",
  {
    // AUTOINCREMENT rowid: strictly monotonic. Doubles as the global
    // recent-changes ordering AND the translation-freshness comparator.
    id: integer("id").primaryKey({ autoIncrement: true }),
    pageId: integer("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    locale: text("locale")
      .notNull()
      .references(() => languages.code),
    title: text("title").notNull(), // display title in this locale, snapshot
    content: text("content").notNull(), // raw wikitext/markdown source
    comment: text("comment").notNull().default(""),
    authorUid: text("author_uid")
      .notNull()
      .references(() => users.uid),
    authorName: text("author_name").notNull(), // display-name snapshot at save
    isMinor: integer("is_minor", { mode: "boolean" }).notNull().default(false),
    // Previous head of this (page, locale); null = first revision.
    // Deliberately no FK: it is a historical pointer, never dereferenced
    // for integrity, and keeping it FK-free avoids deep cascade work.
    parentRevId: integer("parent_rev_id"),
    // For non-EN revisions: the EN revision id this translation was based
    // on. Null for EN revisions (and for translations saved without a
    // confirmed basis — those count as outdated).
    translatedFromRevId: integer("translated_from_rev_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(now),
  },
  (t) => [
    index("revisions_page_locale_idx").on(t.pageId, t.locale, t.id),
    index("revisions_author_idx").on(t.authorUid, t.id),
  ],
);

/* ------------------------------------------------------------------ */
/* Page locales — current head per (page, locale)                      */
/* ------------------------------------------------------------------ */

export const pageLocales = sqliteTable(
  "page_locales",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    pageId: integer("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    locale: text("locale")
      .notNull()
      .references(() => languages.code),
    title: text("title").notNull(), // denormalized copy of head revision title
    // Head revision. Null only in the instant between page_locales insert
    // and first revision insert inside the create transaction.
    currentRevId: integer("current_rev_id").references(() => revisions.id, {
      onDelete: "set null",
    }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(now),
  },
  (t) => [
    uniqueIndex("page_locales_page_locale_uq").on(t.pageId, t.locale),
    index("page_locales_locale_idx").on(t.locale),
  ],
);

/* ------------------------------------------------------------------ */
/* Link graph                                                          */
/* ------------------------------------------------------------------ */

// [[wikilinks]] from the current revision of (page, locale).
// Target is (namespace, slug) — the target page may not exist (red link).
export const pageLinks = sqliteTable(
  "page_links",
  {
    fromPageId: integer("from_page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    fromLocale: text("from_locale").notNull(),
    toNamespace: text("to_namespace", { enum: NAMESPACES }).notNull(),
    toSlug: text("to_slug").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.fromPageId, t.fromLocale, t.toNamespace, t.toSlug],
    }),
    index("page_links_target_idx").on(t.toNamespace, t.toSlug),
  ],
);

// [[Category:X]] membership. Parsed from the current EN revision only —
// membership is a property of the page, not of a translation.
export const categoryLinks = sqliteTable(
  "category_links",
  {
    pageId: integer("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    categorySlug: text("category_slug").notNull(), // slug in Category ns
    sortKey: text("sort_key").notNull().default(""), // [[Category:X|sortkey]]
  },
  (t) => [
    primaryKey({ columns: [t.pageId, t.categorySlug] }),
    index("category_links_cat_idx").on(t.categorySlug, t.sortKey),
  ],
);

// {{Template}} transclusions from the current revision of (page, locale).
// Editing Template:X → look up dependents here → drop their parsed_cache.
export const templateLinks = sqliteTable(
  "template_links",
  {
    fromPageId: integer("from_page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    fromLocale: text("from_locale").notNull(),
    templateSlug: text("template_slug").notNull(), // slug in Template ns
  },
  (t) => [
    primaryKey({ columns: [t.fromPageId, t.fromLocale, t.templateSlug] }),
    index("template_links_target_idx").on(t.templateSlug),
  ],
);

/* ------------------------------------------------------------------ */
/* Parsed-output cache (current revision only, dependency-invalidated) */
/* ------------------------------------------------------------------ */

export const parsedCache = sqliteTable(
  "parsed_cache",
  {
    pageId: integer("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    locale: text("locale").notNull(),
    revId: integer("rev_id").notNull(), // revision the html was rendered from
    html: text("html").notNull(),
    renderedAt: integer("rendered_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(now),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.locale] })],
);

/* ------------------------------------------------------------------ */
/* Search mirror (FTS5 external-content source — see §B)               */
/* ------------------------------------------------------------------ */

// One row per (page, locale) holding the CURRENT revision's title/body.
// id is page_locales.id, so the FTS rowid is stable across edits.
// Written by app code inside the save transaction; triggers propagate
// changes into the search_fts virtual table.
export const searchDocs = sqliteTable(
  "search_docs",
  {
    id: integer("id").primaryKey(), // = page_locales.id (no autoincrement)
    pageId: integer("page_id").notNull(),
    locale: text("locale").notNull(),
    namespace: text("namespace", { enum: NAMESPACES }).notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(), // source text with markup stripped
  },
  (t) => [index("search_docs_locale_idx").on(t.locale)],
);

/* ------------------------------------------------------------------ */
/* Files ([[File:]] uploads; binary lives under wiki-data/uploads)     */
/* ------------------------------------------------------------------ */

export const files = sqliteTable(
  "files",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    filename: text("filename").notNull(), // logical name used in [[File:...]]
    storedPath: text("stored_path").notNull(), // relative to wiki-data/uploads
    mime: text("mime").notNull(),
    size: integer("size").notNull(), // bytes
    sha1: text("sha1").notNull(), // hex digest; dedupe + integrity
    width: integer("width"), // null for non-images
    height: integer("height"),
    uploaderUid: text("uploader_uid")
      .notNull()
      .references(() => users.uid),
    uploadedAt: integer("uploaded_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(now),
  },
  (t) => [
    uniqueIndex("files_filename_uq").on(t.filename),
    index("files_sha1_idx").on(t.sha1),
  ],
);

/* ------------------------------------------------------------------ */
/* Site settings + admin audit log                                     */
/* ------------------------------------------------------------------ */

export const siteSettings = sqliteTable("site_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(), // JSON-encoded
  updatedBy: text("updated_by"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(now),
});

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    action: text("action").notNull(), // "user.ban", "page.delete", "lang.approve", ...
    actorUid: text("actor_uid")
      .notNull()
      .references(() => users.uid),
    target: text("target").notNull(), // e.g. "user:abc123", "page:main/quota-guide"
    payload: text("payload", { mode: "json" }).notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(now),
  },
  (t) => [index("audit_log_created_idx").on(t.createdAt)],
);
```

---

## B. FTS5 setup

**Design: external-content FTS over `search_docs`, synced by triggers.**
`revisions` cannot be the content table — it holds *every* revision and FTS must
index only current ones. So the app maintains `search_docs` (one row per
page-locale, current revision only) inside the save transaction, and three
triggers keep `search_fts` mechanically in sync with `search_docs`. This is the
right split: "which revision is current" is app logic in TypeScript where it
already lives; "keep the index consistent with its source" is delta bookkeeping
that triggers do atomically and can never drift or be forgotten by a new code
path. Manual FTS sync (writing `search_fts` deltas from app code) breaks the
first time someone adds a delete/rename path and forgets it.

**Tokenizer: `unicode61 remove_diacritics 2`.** `porter` is an English stemmer
that mangles non-Latin text and buys little for a gaming wiki full of proper
nouns ("Jetpack", "Artifice"). `unicode61` segments on Unicode whitespace and
punctuation, which handles Korean acceptably because Korean is space-delimited
(eojeol); pair it with prefix queries (`term*`) in the search UI so particle
suffixes (조사: 은/는/이/가…) don't block matches. `remove_diacritics 2` folds
accents for latin-script locales. If substring matching inside CJK words is
ever needed, add a *second* FTS table with `tokenize='trigram'` and union
results — noted as a future option, not built now (trigram needs ≥3-char
queries and a much larger index).

This SQL goes into a custom Drizzle migration (see §E):

```sql
CREATE VIRTUAL TABLE search_fts USING fts5(
  title,
  body,
  content='search_docs',
  content_rowid='id',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER search_docs_ai AFTER INSERT ON search_docs BEGIN
  INSERT INTO search_fts(rowid, title, body)
  VALUES (new.id, new.title, new.body);
END;

CREATE TRIGGER search_docs_ad AFTER DELETE ON search_docs BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, body)
  VALUES ('delete', old.id, old.title, old.body);
END;

CREATE TRIGGER search_docs_au AFTER UPDATE ON search_docs BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, body)
  VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO search_fts(rowid, title, body)
  VALUES (new.id, new.title, new.body);
END;
```

Rebuild command if the index is ever suspect:
`INSERT INTO search_fts(search_fts) VALUES('rebuild');`

---

## C. Connection init — WAL + pragmas (`src/lib/db/index.ts`)

```ts
import "server-only";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

function createDb() {
  const dir = path.join(process.cwd(), "wiki-data");
  fs.mkdirSync(dir, { recursive: true });
  const sqlite = new Database(path.join(dir, "wiki.db"));

  sqlite.pragma("journal_mode = WAL");     // readers never block the writer
  sqlite.pragma("synchronous = NORMAL");   // safe with WAL; big fsync win
  sqlite.pragma("foreign_keys = ON");      // off by default in SQLite!
  sqlite.pragma("busy_timeout = 5000");    // wait instead of SQLITE_BUSY
  sqlite.pragma("cache_size = -64000");    // 64 MB page cache
  sqlite.pragma("temp_store = MEMORY");
  sqlite.pragma("mmap_size = 268435456");  // 256 MB mmap for reads

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return db;
}

// Next.js dev/HMR re-evaluates modules; keep one connection per process.
const globalForDb = globalThis as unknown as {
  __hqhqDb?: BetterSQLite3Database<typeof schema>;
};
export const db = (globalForDb.__hqhqDb ??= createDb());
```

Notes: better-sqlite3 is synchronous — no `await` on queries, and
`db.transaction()` callbacks must be synchronous. Write transactions that read
before writing must use `{ behavior: "immediate" }` so the write lock is taken
up front (prevents `SQLITE_BUSY` upgrades mid-transaction).

---

## D. The 15 core query patterns

Imports assumed: `and, desc, eq, inArray, isNull, lt, ne, or, sql` from
`drizzle-orm`, tables from `./schema`.

### 1. View page by (ns, slug, locale) with EN fallback + redirect follow

```ts
export function getPageView(ns: Namespace, slug: string, locale: string) {
  const page = db
    .select()
    .from(pages)
    .where(and(eq(pages.namespace, ns), eq(pages.slug, slug)))
    .get();
  if (!page) return { kind: "missing" as const }; // red link → offer create

  if (page.redirectSlug) {
    // O(1) denormalized follow; caller resolves the target ONCE (one hop
    // max, like MediaWiki) and shows "(redirected from X)".
    return {
      kind: "redirect" as const,
      to: { ns: page.redirectNs!, slug: page.redirectSlug },
    };
  }

  const pl =
    db.select().from(pageLocales)
      .where(and(eq(pageLocales.pageId, page.id), eq(pageLocales.locale, locale)))
      .get() ??
    db.select().from(pageLocales) // fallback to canonical English
      .where(and(eq(pageLocales.pageId, page.id), eq(pageLocales.locale, "en")))
      .get();
  if (!pl?.currentRevId) return { kind: "missing" as const };

  const cached = db
    .select()
    .from(parsedCache)
    .where(and(eq(parsedCache.pageId, page.id), eq(parsedCache.locale, pl.locale)))
    .get();

  // rev mismatch ⇒ stale (self-healing even if an invalidation was missed)
  const html =
    cached && cached.revId === pl.currentRevId
      ? cached.html
      : renderAndCache(page, pl); // render, then upsert parsed_cache

  return { kind: "page" as const, page, pl, html, servedLocale: pl.locale };
}
```

### 2. Save edit — transactional, optimistic conflict check on parent rev

```ts
export function saveEdit(input: {
  pageId: number;
  locale: string;
  title: string;
  content: string;
  comment: string;
  isMinor: boolean;
  parentRevId: number | null;         // rev the editor loaded
  translatedFromRevId: number | null; // EN basis rev; null for EN edits
  author: { uid: string; displayName: string };
}) {
  return db.transaction(
    (tx) => {
      const pl = tx.select().from(pageLocales)
        .where(and(
          eq(pageLocales.pageId, input.pageId),
          eq(pageLocales.locale, input.locale),
        ))
        .get();
      if (!pl) throw new Error("page_locale missing");

      // Optimistic lock: someone saved since this editor loaded the page.
      if (pl.currentRevId !== input.parentRevId) {
        throw new EditConflictError(pl.currentRevId);
      }

      const rev = tx.insert(revisions).values({
        pageId: input.pageId,
        locale: input.locale,
        title: input.title,
        content: input.content,
        comment: input.comment,
        isMinor: input.isMinor,
        parentRevId: input.parentRevId,
        translatedFromRevId:
          input.locale === "en" ? null : input.translatedFromRevId,
        authorUid: input.author.uid,
        authorName: input.author.displayName, // snapshot
      }).returning({ id: revisions.id }).get();

      tx.update(pageLocales)
        .set({ currentRevId: rev.id, title: input.title, updatedAt: new Date() })
        .where(eq(pageLocales.id, pl.id))
        .run();

      // EN is canonical: redirect + category membership follow EN content.
      if (input.locale === "en") {
        const redirect = parseRedirect(input.content); // "#REDIRECT [[...]]" or null
        tx.update(pages)
          .set({
            redirectNs: redirect?.ns ?? null,
            redirectSlug: redirect?.slug ?? null,
          })
          .where(eq(pages.id, input.pageId))
          .run();
        refreshCategoryLinks(tx, input.pageId, input.content);
      }

      refreshPageLinks(tx, input.pageId, input.locale, input.content);   // #13
      refreshTemplateLinks(tx, input.pageId, input.locale, input.content);
      upsertSearchDoc(tx, pl.id, input);                                 // §B
      tx.delete(parsedCache).where(and(
        eq(parsedCache.pageId, input.pageId),
        eq(parsedCache.locale, input.locale),
      )).run();
      invalidateTemplateDependentsIfTemplate(tx, input.pageId);          // #12

      return rev.id;
    },
    { behavior: "immediate" }, // take the write lock before the read
  );
}
```

Page creation is the same transaction preceded by
`insert(pages)` + `insert(pageLocales)` (currentRevId null) and skipping the
conflict check; the unique index `pages_ns_slug_uq` turns a create race into a
constraint error surfaced as "page already exists".

### 3. History pagination — keyset on rev id (never OFFSET)

```ts
export function getHistory(pageId: number, locale: string, cursor?: number, limit = 50) {
  const rows = db
    .select({
      id: revisions.id, title: revisions.title, comment: revisions.comment,
      authorUid: revisions.authorUid, authorName: revisions.authorName,
      isMinor: revisions.isMinor, parentRevId: revisions.parentRevId,
      createdAt: revisions.createdAt,
      bytes: sql<number>`length(${revisions.content})`,
    })
    .from(revisions)
    .where(and(
      eq(revisions.pageId, pageId),
      eq(revisions.locale, locale),
      cursor ? lt(revisions.id, cursor) : undefined,
    ))
    .orderBy(desc(revisions.id))
    .limit(limit + 1)
    .all();
  const hasMore = rows.length > limit;
  return { rows: rows.slice(0, limit), nextCursor: hasMore ? rows[limit - 1].id : null };
}
```

### 4. Diff pair fetch (a revision and its comparison base)

```ts
export function getDiffPair(revId: number, againstId?: number) {
  const rev = db.select().from(revisions).where(eq(revisions.id, revId)).get();
  if (!rev) return null;
  const baseId = againstId ?? rev.parentRevId; // default: diff vs parent
  const base = baseId
    ? db.select().from(revisions).where(eq(revisions.id, baseId)).get()
    : null; // page creation → diff against empty
  return { base, rev }; // run the text diff in app code
}
```

### 5. Recent changes across all locales (keyset, optional filters)

```ts
export function recentChanges(opts: {
  cursor?: number; locale?: string; hideMinor?: boolean; limit?: number;
}) {
  return db
    .select({
      revId: revisions.id, locale: revisions.locale, title: revisions.title,
      comment: revisions.comment, isMinor: revisions.isMinor,
      authorName: revisions.authorName, createdAt: revisions.createdAt,
      namespace: pages.namespace, slug: pages.slug, pageId: pages.id,
    })
    .from(revisions)
    .innerJoin(pages, eq(revisions.pageId, pages.id))
    .where(and(
      opts.cursor ? lt(revisions.id, opts.cursor) : undefined,
      opts.locale ? eq(revisions.locale, opts.locale) : undefined,
      opts.hideMinor ? eq(revisions.isMinor, false) : undefined,
    ))
    .orderBy(desc(revisions.id)) // rev id IS the global change order
    .limit(opts.limit ?? 50)
    .all();
}
```

### 6. Wanted pages (red-link targets, most-referenced first)

```sql
SELECT pl.to_namespace, pl.to_slug,
       COUNT(DISTINCT pl.from_page_id) AS refs
FROM page_links pl
LEFT JOIN pages p
  ON p.namespace = pl.to_namespace AND p.slug = pl.to_slug
WHERE p.id IS NULL
GROUP BY pl.to_namespace, pl.to_slug
ORDER BY refs DESC, pl.to_slug
LIMIT 50;
```

### 7. What links here

```ts
export function whatLinksHere(ns: Namespace, slug: string) {
  return db
    .selectDistinct({
      pageId: pages.id, namespace: pages.namespace, slug: pages.slug,
    })
    .from(pageLinks)
    .innerJoin(pages, eq(pageLinks.fromPageId, pages.id))
    .where(and(eq(pageLinks.toNamespace, ns), eq(pageLinks.toSlug, slug)))
    .orderBy(pages.namespace, pages.slug)
    .all();
  // Transclusions ("pages using this template"): same shape against
  // template_links.templateSlug. Redirects pointing here: query pages
  // on (redirect_ns, redirect_slug) via pages_redirect_idx.
}
```

### 8. Category listing (members + subcategories, sort-key ordered)

```ts
export function categoryMembers(categorySlug: string) {
  const rows = db
    .select({
      pageId: pages.id, namespace: pages.namespace, slug: pages.slug,
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
```

### 9. Full-text search (per locale, bm25-ranked, highlighted)

```ts
export function search(query: string, locale: string, limit = 20) {
  // Sanitize into FTS syntax: quote terms, add * for prefix matching
  // (important for Korean particle suffixes).
  const match = query.trim().split(/\s+/)
    .map((t) => `"${t.replaceAll('"', '""')}"*`).join(" ");
  return db.all(sql`
    SELECT d.page_id AS pageId, d.namespace, d.slug, d.locale, d.title,
           snippet(search_fts, 1, '<mark>', '</mark>', '…', 24) AS snippet,
           bm25(search_fts, 5.0, 1.0) AS rank   -- title weighted 5x body
    FROM search_fts
    JOIN search_docs d ON d.id = search_fts.rowid
    WHERE search_fts MATCH ${match} AND d.locale = ${locale}
    ORDER BY rank
    LIMIT ${limit}
  `);
}
```

### 10. Outdated-translations report (and per-page badge)

```sql
-- Rev ids are monotonic: EN head newer than the translation's basis ⇒ stale.
SELECT p.namespace, p.slug, t.locale,
       trev.translated_from_rev_id AS basedOnRev,
       en.current_rev_id           AS enCurrentRev
FROM page_locales t
JOIN revisions trev ON trev.id = t.current_rev_id
JOIN page_locales en ON en.page_id = t.page_id AND en.locale = 'en'
JOIN pages p ON p.id = t.page_id
WHERE t.locale <> 'en'
  AND (trev.translated_from_rev_id IS NULL
       OR trev.translated_from_rev_id < en.current_rev_id)
ORDER BY p.namespace, p.slug, t.locale;
-- Per-page badge: same query + "AND t.page_id = ?" (0 or 1 row per locale).
```

### 11. Rollback — a new revision copying old content (reuses saveEdit)

```ts
export function rollback(opts: {
  pageId: number; locale: string; targetRevId: number;
  actor: { uid: string; displayName: string };
}) {
  const target = db.select().from(revisions)
    .where(and(
      eq(revisions.id, opts.targetRevId),
      eq(revisions.pageId, opts.pageId),   // guard: rev must belong to page
      eq(revisions.locale, opts.locale),
    )).get();
  if (!target) throw new Error("target revision not found");

  const head = db.select().from(pageLocales)
    .where(and(eq(pageLocales.pageId, opts.pageId), eq(pageLocales.locale, opts.locale)))
    .get()!;

  // Going through saveEdit keeps links, search, cache, and conflict
  // detection correct for free. History stays append-only.
  return saveEdit({
    pageId: opts.pageId, locale: opts.locale,
    title: target.title, content: target.content,
    comment: `Rollback to r${target.id}`, isMinor: false,
    parentRevId: head.currentRevId,
    translatedFromRevId: target.translatedFromRevId,
    author: opts.actor,
  });
}
```

### 12. Template dependents → cache invalidation (called from saveEdit)

```ts
function invalidateTemplateDependentsIfTemplate(tx: Tx, pageId: number) {
  const page = tx.select().from(pages).where(eq(pages.id, pageId)).get()!;
  if (page.namespace !== "template") return;
  // SQLite row-value IN subquery: one statement, no round-trips.
  tx.run(sql`
    DELETE FROM parsed_cache
    WHERE (page_id, locale) IN (
      SELECT from_page_id, from_locale
      FROM template_links
      WHERE template_slug = ${page.slug}
    )
  `);
  // Dropped rows re-render lazily on next view (pattern #1). No TTL needed.
}
```

### 13. Refresh link graph after save (delete + bulk insert)

```ts
function refreshPageLinks(tx: Tx, pageId: number, locale: string, content: string) {
  const targets = extractWikiLinks(content); // [{ns, slug}], deduped by parser
  tx.delete(pageLinks).where(and(
    eq(pageLinks.fromPageId, pageId), eq(pageLinks.fromLocale, locale),
  )).run();
  if (targets.length) {
    tx.insert(pageLinks).values(targets.map((t) => ({
      fromPageId: pageId, fromLocale: locale,
      toNamespace: t.ns, toSlug: t.slug,
    }))).onConflictDoNothing().run();
  }
  // categoryLinks / templateLinks: identical delete+insert shape.
}
```

Batch red/blue-link resolution at render time:

```ts
const existing = new Set(
  db.select({ ns: pages.namespace, slug: pages.slug }).from(pages)
    .where(or(...targets.map((t) =>
      and(eq(pages.namespace, t.ns), eq(pages.slug, t.slug)))))
    .all()
    .map((r) => `${r.ns}:${r.slug}`),
); // links not in the set render red
```

### 14. User contributions

```ts
db.select({
    revId: revisions.id, locale: revisions.locale, title: revisions.title,
    comment: revisions.comment, createdAt: revisions.createdAt,
    namespace: pages.namespace, slug: pages.slug,
  })
  .from(revisions)
  .innerJoin(pages, eq(revisions.pageId, pages.id))
  .where(and(
    eq(revisions.authorUid, uid),                 // uses revisions_author_idx
    cursor ? lt(revisions.id, cursor) : undefined,
  ))
  .orderBy(desc(revisions.id))
  .limit(50)
  .all();
```

### 15. Login upsert + admin action with audit log

```ts
// On authenticated requests that will write (cheap; keeps name fresh):
db.insert(users)
  .values({ uid, displayName })
  .onConflictDoUpdate({ target: users.uid, set: { displayName } })
  .run();

// Admin mutations always pair the change with an audit row, transactionally:
db.transaction((tx) => {
  tx.update(users).set({ banned: true }).where(eq(users.uid, targetUid)).run();
  tx.insert(auditLog).values({
    action: "user.ban",
    actorUid: adminUid,
    target: `user:${targetUid}`,
    payload: { reason },
  }).run();
}, { behavior: "immediate" });
```

---

## E. Migrations & versioning

**Decision: generated SQL migrations (`drizzle-kit generate`) applied
automatically at boot via `migrate()`** — already wired in §C. Rationale for a
self-hosted local app: operators upgrade by pulling code and restarting;
boot-time `migrate()` makes the DB catch up with zero manual steps, is
idempotent, and each step runs in a transaction. `drizzle-kit push` is rejected
for anything but throwaway prototyping: it diffs live schema with no history,
can prompt interactively, and can drop data — unacceptable against someone's
only copy of their wiki.

`drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: "./wiki-data/wiki.db" },
});
```

Workflow:

1. Edit `src/lib/db/schema.ts`.
2. `yarn drizzle-kit generate` → writes `drizzle/0001_*.sql` + journal. Commit both.
3. FTS5 + triggers are not expressible in Drizzle schema: run
   `yarn drizzle-kit generate --custom --name=fts` once and paste §B's SQL into
   the produced empty migration. It versions and replays like any other.
4. App boot runs `migrate()` (§C) — applies anything new, no-ops otherwise.

Operational notes:

- `better-sqlite3` **must** be in `serverExternalPackages` in `next.config.ts`
  (alongside the existing `firebase-admin`) or the native `.node` binding fails
  to load under Turbopack/webpack bundling.
- Never edit an applied migration file; always generate a new one.
- Backups: with WAL, use `db.backup()` (better-sqlite3 API) or
  `VACUUM INTO 'backup.db'` — never raw-copy the db/-wal/-shm files while the
  app is running.
- Seed on first boot (idempotent): `languages` row `en/active`, and
  `site_settings` defaults via `INSERT ... ON CONFLICT DO NOTHING`.

---

## Addendum (critic)

Amendments from the pre-implementation completeness review (2026-08-31). Cross-references: `docs/engine/critique.md`.

### A1. `admin_grants` table (restores the reuse-audit auth contract); drop `users.role`

reuse-audit §2/§4 keeps `src/lib/auth/server.ts` verbatim with exactly one call swapped — `adminGrantStore.hasActiveGrant(uid)` → a SQLite lookup — and requires the old semantics: grants by uid, audit events, no self-revoke, banned users never admin. This schema instead put a `role` enum on `users`, which contradicts that contract and loses grant history. Add:

```ts
export const adminGrants = sqliteTable(
  "admin_grants",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    uid: text("uid").notNull().references(() => users.uid),
    grantedBy: text("granted_by").notNull().references(() => users.uid),
    grantedAt: integer("granted_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
    revokedBy: text("revoked_by").references(() => users.uid),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }), // null = active
  },
  (t) => [index("admin_grants_uid_idx").on(t.uid)],
);
```

`hasActiveGrant(uid)` = a row with that `uid` and `revokedAt IS NULL`. Service rules enforced in the grant service, each mutation paired with an `audit_log` row in one transaction: no self-revoke; a banned user's grants answer false. **`users.role` is removed** — `isAdmin` stays server-computed per request exactly as today (Firestore bootstrap roles via `WIKI_ADMIN_ROLES`, OR an active grant), never persisted as a column.

### A2. Redirect fragment column

`#REDIRECT [[Moons#Titan]]` is legal (spec §12.1) but `pages` has nowhere to keep the fragment. Add `redirectFragment: text("redirect_fragment")` (null unless `redirectSlug` is set). `parseRedirect` must reuse the engine's §12.1 recognizer (single implementation, BOM/comment handling included), not a second regex.

### A3. Render-cache invalidation on page create / delete / undelete / rename

Cached HTML embeds red/blue link state. Query #12 handles template edits only. Whenever a page's existence or address changes, run in the same transaction:

```sql
DELETE FROM parsed_cache WHERE (page_id, locale) IN (
  SELECT from_page_id, from_locale FROM page_links
  WHERE to_namespace = :ns AND to_slug = :slug
);
-- and, when :ns = 'template' (a red-linked template coming into existence or vanishing):
DELETE FROM parsed_cache WHERE (page_id, locale) IN (
  SELECT from_page_id, from_locale FROM template_links WHERE template_slug = :slug
);
```

### A4. Link tables are fed by the parser, not by regex

`refreshPageLinks` / `refreshTemplateLinks` / `refreshCategoryLinks` / `upsertSearchDoc` take `content` in §D, but rows MUST derive from the engine's `ParseResult.meta`: `linksTo` (incl. red links), `templatesUsed` (transitive and including nonexistent targets — spec Addendum A4), `categories`; `search_docs.body` = the rendered document flattened to plain text. Source-level regex would miss templates transcluded *by* templates and categories injected by `{{Stub}}` / `{{Verify}}` (seed plan §5 note 5). Consequence: a save runs a full parse inside the save path — reuse that parse's HTML to warm `parsed_cache` (when not volatile, A5) instead of discarding it.

### A5. Volatile output must not be cached

The engine sets `meta.volatile` when `CURRENT*` or `#ifexist` was used (spec §9.5). For volatile results, **skip the `parsed_cache` upsert** and re-render on every view; otherwise a page using `{{CURRENTDAY}}` is frozen until its next edit. No TTL machinery needed.

### A6. Page deletion and `search_docs` (and rollback, verified)

No delete path was specified. `search_docs` deliberately has no FK, so deleting a page cascades `revisions` / `page_locales` / links / cache but **orphans `search_docs` rows** (the FTS delete trigger then never fires and ghost results remain searchable). Page-delete transaction: capture the page's `page_locales.id` list → `DELETE FROM search_docs WHERE id IN (…)` → `DELETE FROM pages WHERE id = :id` (cascades the rest) → run A3's invalidation for the deleted `(ns, slug)` → insert the `audit_log` row (`page.delete`). Rollback needs no special handling — it goes through `saveEdit`, which upserts `search_docs` and the triggers sync FTS (verified correct as designed).

### A7. Namespace mapping (spec ↔ schema)

The engine's numeric namespaces (spec §5.8) map to this schema's strings: `0 ↔ main`, `4 ↔ project`, `6 ↔ file`, `10 ↔ template`, `14 ↔ category`. All other engine namespaces (Talk, User, Help, MediaWiki, and the talk variants) have **no storage**: pages there cannot be created, links to them always render red, and they are NOT recorded in `page_links` (the enum would reject them). Extending coverage (e.g. Help) means extending `NAMESPACES`, this mapping, and a migration together — see critique.md O2.

### A8. Template transclusion is locale-neutral (EN only)

Normative stance (matches seed-content-plan §4): the renderer's `PageStore.getSource` resolves a transclusion to the template page's **EN head revision, always** — the rendering locale is irrelevant, and non-EN `page_locales` rows on Template-ns pages are ignored by the renderer (they may exist for on-page documentation only). Saving any locale of a template still fires #12's invalidation (harmless over-invalidation for non-EN saves). Localization of infobox *values* flows through template parameters, as the KO Titan fixture demonstrates.
