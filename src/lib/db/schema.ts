/**
 * Drizzle sqlite-core schema — docs/engine/db-schema.md §A, amended by:
 * - Addendum A1: admin_grants table added; users.role removed
 * - Addendum A2: pages.redirect_fragment added
 * - decisions.md O3: categories navigation table added
 *
 * Any DDL change here must be mirrored in src/lib/db/ddl.ts.
 */

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

// Addendum A1: no role column — isAdmin is computed per request (Firestore
// bootstrap roles OR an active admin_grants row), never persisted.
export const users = sqliteTable("users", {
  uid: text("uid").primaryKey(), // Firebase uid
  displayName: text("display_name").notNull(),
  banned: integer("banned", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(now),
});

/* ------------------------------------------------------------------ */
/* Admin grants (Addendum A1)                                          */
/* ------------------------------------------------------------------ */

// hasActiveGrant(uid) = a row with that uid and revokedAt IS NULL. Service
// rules (no self-revoke; banned ⇒ never admin) live in the grant service,
// each mutation paired with an audit_log row in one transaction.
export const adminGrants = sqliteTable(
  "admin_grants",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    uid: text("uid")
      .notNull()
      .references(() => users.uid),
    grantedBy: text("granted_by")
      .notNull()
      .references(() => users.uid),
    grantedAt: integer("granted_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(now),
    revokedBy: text("revoked_by").references(() => users.uid),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }), // null = active
  },
  (t) => [index("admin_grants_uid_idx").on(t.uid)],
);

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
    // All null when the page is not a redirect. One-hop follow only.
    redirectNs: text("redirect_ns", { enum: NAMESPACES }),
    redirectSlug: text("redirect_slug"),
    // Addendum A2: fragment of "#REDIRECT [[Moons#Titan]]"; null unless
    // redirectSlug is set (and even then usually null).
    redirectFragment: text("redirect_fragment"),
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
    content: text("content").notNull(), // raw wikitext source
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
    // Version scoping snapshot from the last save (versioning.md §4) so the
    // view layer knows whether to render a selector without re-parsing.
    versionScoped: integer("version_scoped", { mode: "boolean" })
      .notNull()
      .default(false),
    versionBoundaries: text("version_boundaries").notNull().default("[]"), // JSON string[]
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
// Rows derive from ParseResult.meta.linksTo (Addendum A4), never from regex.
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
    // Selected game version this HTML was rendered for, or "*" for pages with
    // no version constructs (versioning.md §4).
    version: text("version").notNull().default("*"),
    revId: integer("rev_id").notNull(), // revision the html was rendered from
    html: text("html").notNull(),
    renderedAt: integer("rendered_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(now),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.locale, t.version] })],
);

/* ------------------------------------------------------------------ */
/* Search mirror (FTS5 external-content source — see ddl.ts)           */
/* ------------------------------------------------------------------ */

// One row per (page, locale) holding the CURRENT revision's title/body.
// id is page_locales.id, so the FTS rowid is stable across edits.
// Written by app code inside the save transaction; triggers propagate
// changes into the search_fts virtual table. Deliberately FK-free: page
// deletion must delete these rows explicitly BEFORE the page row so the
// FTS delete trigger fires (Addendum A6).
export const searchDocs = sqliteTable(
  "search_docs",
  {
    id: integer("id").primaryKey(), // = page_locales.id (no autoincrement)
    pageId: integer("page_id").notNull(),
    locale: text("locale").notNull(),
    namespace: text("namespace", { enum: NAMESPACES }).notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(), // rendered document flattened to plain text
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
    filename: text("filename").notNull(), // canonical name (decisions O6)
    storedPath: text("stored_path").notNull(), // relative to wiki-data/uploads
    mime: text("mime").notNull(),
    size: integer("size").notNull(), // bytes
    sha1: text("sha1").notNull(), // hex digest; dedupe + integrity + ETag
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
/* Navigation categories (decisions O3)                                */
/* ------------------------------------------------------------------ */

// Navigation metadata; NOT the same as wiki [[Category:]] membership.
// The nav menu reads this table only.
export const categories = sqliteTable("categories", {
  slug: text("slug").primaryKey(),
  sortOrder: integer("sort_order").notNull(),
  labels: text("labels").notNull(), // JSON: {locale: label}
  description: text("description"), // JSON: {locale: text}
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(now),
});

/* ------------------------------------------------------------------ */
/* Site settings + admin audit log                                     */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Game version registry (versioning.md §1 — decision O10)             */
/* ------------------------------------------------------------------ */

export const versions = sqliteTable(
  "versions",
  {
    id: text("id").primaryKey(), // "v62", "v64.1"
    label: text("label").notNull(),
    /** major*1000 + minor — the only ordering key. */
    ordinal: integer("ordinal").notNull(),
    releasedAt: integer("released_at", { mode: "timestamp_ms" }),
    notes: text("notes"),
    status: text("status", { enum: ["current", "supported", "legacy"] })
      .notNull()
      .default("legacy"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(now),
  },
  (t) => [uniqueIndex("versions_ordinal_uq").on(t.ordinal)],
);

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

/* ------------------------------------------------------------------ */
/* User reports — what ordinary editors can do about a bad actor       */
/* ------------------------------------------------------------------ */

/**
 * A report is a request for a manager to look at somebody. Anyone signed in
 * may file one; only a manager may act. Kept in its own table rather than in
 * `audit_log` because the two answer different questions — the audit log says
 * what HAPPENED, a report says what somebody THINKS should happen — and
 * because reports have a lifecycle (open → resolved) that audit rows never do.
 */
export const reports = sqliteTable(
  "reports",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Who is being reported. */
    targetUid: text("target_uid")
      .notNull()
      .references(() => users.uid),
    /** Who filed it. */
    reporterUid: text("reporter_uid")
      .notNull()
      .references(() => users.uid),
    reason: text("reason").notNull().default(""),
    /** What prompted it — e.g. "revision:1841" or "page:main/titan". */
    context: text("context").notNull().default(""),
    status: text("status", { enum: ["open", "resolved", "dismissed"] })
      .notNull()
      .default("open"),
    /** The manager who closed it; null while open. */
    resolvedBy: text("resolved_by").references(() => users.uid),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(now),
  },
  (t) => [
    index("reports_status_idx").on(t.status, t.id),
    index("reports_target_idx").on(t.targetUid),
  ],
);

/* ------------------------------------------------------------------ */
/* Wiki Q&A agent questions — content only, no asker identity          */
/* ------------------------------------------------------------------ */

// Deliberately carries no uid/session/IP/user-agent: signed-in and
// signed-out visitors ask the agent alike, and this log exists to see what
// people ask, never who asked it (src/lib/agent/log.ts).
export const agentQuestions = sqliteTable(
  "agent_questions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    askedAt: integer("asked_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(now),
    locale: text("locale").notNull(),
    question: text("question").notNull(),
    // The page open in the asker's browser when they asked, if any.
    pageNamespace: text("page_namespace", { enum: NAMESPACES }),
    pageSlug: text("page_slug"),
  },
  (t) => [index("agent_questions_asked_at_idx").on(t.askedAt)],
);
