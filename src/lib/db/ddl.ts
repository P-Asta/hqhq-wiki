/**
 * Boot-time DDL for the wiki database.
 *
 * DEVIATION NOTE (from db-schema.md §E): the doc prescribes drizzle-kit
 * generated migrations applied via migrate(). We instead ship idempotent
 * programmatic DDL (CREATE ... IF NOT EXISTS) executed at connection time by
 * ensureSchema() — chosen for zero-toolchain boot: no drizzle.config.ts, no
 * generated migration folder, and the FTS5 virtual table + triggers (§B,
 * inexpressible in Drizzle schema) live in the same reviewable constant.
 * Once real schema *changes* are needed post-launch, revisit §E's generated
 * migrations; IF NOT EXISTS only ever creates, it never alters.
 *
 * This DDL MUST stay column-for-column in sync with src/lib/db/schema.ts
 * (docs/engine/db-schema.md §A + Addenda A1/A2, decisions O3). Timestamp
 * columns are INTEGER (epoch ms, drizzle mode "timestamp_ms"); booleans are
 * INTEGER 0/1.
 */

export const WIKI_DDL = `
/* ---- users (A1: no role column) ---------------------------------- */
CREATE TABLE IF NOT EXISTS users (
  uid          TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  banned       INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

/* ---- admin_grants (Addendum A1) ---------------------------------- */
CREATE TABLE IF NOT EXISTS admin_grants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  uid        TEXT NOT NULL REFERENCES users(uid),
  granted_by TEXT NOT NULL REFERENCES users(uid),
  granted_at INTEGER NOT NULL,
  revoked_by TEXT REFERENCES users(uid),
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS admin_grants_uid_idx ON admin_grants (uid);

/* ---- languages ---------------------------------------------------- */
CREATE TABLE IF NOT EXISTS languages (
  code        TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  native_name TEXT NOT NULL,
  direction   TEXT NOT NULL DEFAULT 'ltr',
  status      TEXT NOT NULL DEFAULT 'proposed',
  created_by  TEXT REFERENCES users(uid),
  created_at  INTEGER NOT NULL
);

/* ---- pages (A2: redirect_fragment) -------------------------------- */
CREATE TABLE IF NOT EXISTS pages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace         TEXT NOT NULL DEFAULT 'main',
  slug              TEXT NOT NULL,
  redirect_ns       TEXT,
  redirect_slug     TEXT,
  redirect_fragment TEXT,
  created_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pages_ns_slug_uq ON pages (namespace, slug);
CREATE INDEX IF NOT EXISTS pages_redirect_idx ON pages (redirect_ns, redirect_slug);

/* ---- revisions ----------------------------------------------------- */
CREATE TABLE IF NOT EXISTS revisions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id                INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  locale                 TEXT NOT NULL REFERENCES languages(code),
  title                  TEXT NOT NULL,
  content                TEXT NOT NULL,
  comment                TEXT NOT NULL DEFAULT '',
  author_uid             TEXT NOT NULL REFERENCES users(uid),
  author_name            TEXT NOT NULL,
  is_minor               INTEGER NOT NULL DEFAULT 0,
  parent_rev_id          INTEGER,
  translated_from_rev_id INTEGER,
  created_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS revisions_page_locale_idx ON revisions (page_id, locale, id);
CREATE INDEX IF NOT EXISTS revisions_author_idx ON revisions (author_uid, id);

/* ---- page_locales -------------------------------------------------- */
CREATE TABLE IF NOT EXISTS page_locales (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id        INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  locale         TEXT NOT NULL REFERENCES languages(code),
  title          TEXT NOT NULL,
  current_rev_id INTEGER REFERENCES revisions(id) ON DELETE SET NULL,
  version_scoped INTEGER NOT NULL DEFAULT 0,
  version_boundaries TEXT NOT NULL DEFAULT '[]',
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS page_locales_page_locale_uq ON page_locales (page_id, locale);
CREATE INDEX IF NOT EXISTS page_locales_locale_idx ON page_locales (locale);

/* ---- link graph ---------------------------------------------------- */
CREATE TABLE IF NOT EXISTS page_links (
  from_page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  from_locale  TEXT NOT NULL,
  to_namespace TEXT NOT NULL,
  to_slug      TEXT NOT NULL,
  PRIMARY KEY (from_page_id, from_locale, to_namespace, to_slug)
);
CREATE INDEX IF NOT EXISTS page_links_target_idx ON page_links (to_namespace, to_slug);

CREATE TABLE IF NOT EXISTS category_links (
  page_id       INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  category_slug TEXT NOT NULL,
  sort_key      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (page_id, category_slug)
);
CREATE INDEX IF NOT EXISTS category_links_cat_idx ON category_links (category_slug, sort_key);

CREATE TABLE IF NOT EXISTS template_links (
  from_page_id  INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  from_locale   TEXT NOT NULL,
  template_slug TEXT NOT NULL,
  PRIMARY KEY (from_page_id, from_locale, template_slug)
);
CREATE INDEX IF NOT EXISTS template_links_target_idx ON template_links (template_slug);

/* ---- parsed_cache -------------------------------------------------- */
CREATE TABLE IF NOT EXISTS parsed_cache (
  page_id     INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  locale      TEXT NOT NULL,
  version     TEXT NOT NULL DEFAULT '*',
  rev_id      INTEGER NOT NULL,
  html        TEXT NOT NULL,
  rendered_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, locale, version)
);

/* ---- versions registry (versioning.md §1) -------------------------- */
CREATE TABLE IF NOT EXISTS versions (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  ordinal     INTEGER NOT NULL,
  released_at INTEGER,
  notes       TEXT,
  status      TEXT NOT NULL DEFAULT 'legacy',
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS versions_ordinal_uq ON versions (ordinal);

/* ---- search_docs (FK-free on purpose — Addendum A6) ---------------- */
CREATE TABLE IF NOT EXISTS search_docs (
  id        INTEGER PRIMARY KEY,
  page_id   INTEGER NOT NULL,
  locale    TEXT NOT NULL,
  namespace TEXT NOT NULL,
  slug      TEXT NOT NULL,
  title     TEXT NOT NULL,
  body      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS search_docs_locale_idx ON search_docs (locale);

/* ---- files --------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS files (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  filename     TEXT NOT NULL,
  stored_path  TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  sha1         TEXT NOT NULL,
  width        INTEGER,
  height       INTEGER,
  uploader_uid TEXT NOT NULL REFERENCES users(uid),
  uploaded_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS files_filename_uq ON files (filename);
CREATE INDEX IF NOT EXISTS files_sha1_idx ON files (sha1);

/* ---- categories (navigation; decisions O3) ------------------------- */
CREATE TABLE IF NOT EXISTS categories (
  slug        TEXT PRIMARY KEY,
  sort_order  INTEGER NOT NULL,
  labels      TEXT NOT NULL,
  description TEXT,
  created_at  INTEGER NOT NULL
);

/* ---- site_settings + audit_log ------------------------------------- */
CREATE TABLE IF NOT EXISTS site_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT NOT NULL,
  actor_uid  TEXT NOT NULL REFERENCES users(uid),
  target     TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at);

/* ---- reports (an editor asks a manager to look at somebody) -------- */
CREATE TABLE IF NOT EXISTS reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  target_uid   TEXT NOT NULL REFERENCES users(uid),
  reporter_uid TEXT NOT NULL REFERENCES users(uid),
  reason       TEXT NOT NULL DEFAULT '',
  context      TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open',
  resolved_by  TEXT REFERENCES users(uid),
  resolved_at  INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_status_idx ON reports (status, id);
CREATE INDEX IF NOT EXISTS reports_target_idx ON reports (target_uid);

/* ---- agent_questions (Q&A agent log — content only, no identity) -- */
CREATE TABLE IF NOT EXISTS agent_questions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  asked_at       INTEGER NOT NULL,
  locale         TEXT NOT NULL,
  question       TEXT NOT NULL,
  page_namespace TEXT,
  page_slug      TEXT
);
CREATE INDEX IF NOT EXISTS agent_questions_asked_at_idx ON agent_questions (asked_at);

/* ---- FTS5 external-content index + sync triggers (db-schema §B) ---- */
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  title,
  body,
  content='search_docs',
  content_rowid='id',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS search_docs_ai AFTER INSERT ON search_docs BEGIN
  INSERT INTO search_fts(rowid, title, body)
  VALUES (new.id, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS search_docs_ad AFTER DELETE ON search_docs BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, body)
  VALUES ('delete', old.id, old.title, old.body);
END;

CREATE TRIGGER IF NOT EXISTS search_docs_au AFTER UPDATE ON search_docs BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, body)
  VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO search_fts(rowid, title, body)
  VALUES (new.id, new.title, new.body);
END;
`;
