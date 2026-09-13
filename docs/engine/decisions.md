# Lead decisions (resolves critique.md O1–O9) — NORMATIVE

Date: 2026-08-31. These override anything contradictory in the other docs.

## O1 — Title↔slug resolution (DECIDED)
Deterministic function `slugifyTitle(title)` in `src/lib/title.ts`:
1. Normalize title (spec §5.7): `_`→space, collapse whitespace, trim, Unicode NFC.
2. Lowercase (Unicode-aware `toLowerCase`).
3. Whitespace runs → `-`.
4. Remove every char NOT in: Unicode letters (`\p{L}`), digits (`\p{N}`), combining marks (`\p{M}`), `-`, `(`, `)`, `.`.
5. Collapse `-{2,}` → `-`; trim leading/trailing `-`.

- Identity = `(namespace, slug)`. Korean/Unicode titles keep their letters in the slug (URL-encoded in hrefs).
- Display titles are freely decoupled: `page_locales.title` holds the shown title per locale.
- Red/blue link resolution: `pageExists(ns, slugifyTitle(target))`.
- `articlePath` per locale = `/wiki/$1` for English and `/{locale}/wiki/$1` otherwise
  (per **decisions-v2 O12**, which supersedes the original `/{locale}/wiki/$1`-everywhere
  form here; built by `localePath`), where `$1` = `nsPrefix + slug`; nsPrefix is `` (main), `template:`, `category:`, `file:`, `project:` (lowercase, colon).
- `category_links.category_slug = slugifyTitle(categoryName)`.
- Examples: `[[Gold bar]]` → `gold-bar`; `[[The Company (71-Gordion)]]` → `the-company-(71-gordion)`.

## O2 — Namespaces (DECIDED)
Accept db-schema Addendum A7 as-is: only main/project/file/template/category are storable;
Help:/User:/Talk: etc. parse (spec §5.8) but are uncreatable, always-red, excluded from page_links.

## O3 — Navigation categories (DECIDED)
New table `categories` (navigation metadata; NOT the same as wiki [[Category:]] membership):
`slug` TEXT PK, `sort_order` INTEGER NOT NULL, `labels` TEXT NOT NULL (JSON: {locale: label}),
`description` TEXT (JSON: {locale: text}), `created_at`. Seeded from old wiki-data/categories.json
plus a new `strategies` category (EN "Strategies", KO "전략"). Category: namespace pages may still
exist for long-form description; the nav menu reads this table only.

## O4 — Non-EN-first pages (DECIDED)
Allowed. Slug derives from the creation title via O1 (Unicode-preserving). No EN row required.
`translated_from_rev_id = NULL` on a non-EN head with no EN basis ⇒ badge "original" (not "outdated").
Once an EN head exists, subsequent translation saves record the EN basis and freshness resumes.

## O5 — banned (DECIDED)
Firestore `profile.banned` stays authoritative in the auth pipeline. SQLite `users.banned` is a
moderation-view mirror, written in the same admin action. Keep the column.

## O6 — Media (DECIDED)
Canonical filename: NFC, lowercase, whitespace/underscore runs → `-`, extension lowercase; unique
index on it. Serve via `GET /api/media/[...name]` streaming from `WIKI_UPLOAD_ROOT` (default
./wiki-data/uploads), `Cache-Control: public, max-age=31536000, immutable`, ETag = sha1.
`PageStore.getFile().src = /api/media/<canonical>`.

## O7 — Search locale fallback (DECIDED)
For locale ≠ en: query FTS for both the locale and `en`, dedupe by page_id preferring the locale
hit, flag EN-only hits `fallbackFromEn: true` in results (UI shows a small "EN" chip).

## O8 — Route map
See docs/engine/routes.md (written alongside this doc).

## O9 — Seed slugs (DECIDED)
All seed slugs are recomputed as `slugifyTitle(EN title)` — hand-assigned slugs in
seed-content-plan.md are superseded. Moons use bare canonical titles ("Titan", "Artifice");
number-prefixed forms are seeded as #REDIRECT pages ("8-Titan" → "Titan", "68-Artifice" →
"Artifice"). Vanity/alternate names likewise become redirect pages (e.g. "The Company" →
"Selling at the Company").

## O11 — Clean-slate app layer + Vercel theme (DECIDED 2026-08-31, supersedes earlier theme choices)
The project at C:/Users/pAsta/Desktop/hqhq-wiki is a clean-slate build. NOTHING is salvaged
from the legacy codebase: every app-layer file (globals.css, layouts, components, i18n system
and dictionaries, Firebase wiring, auth provider, login UI, api-response, utils) is authored
fresh against these docs. reuse-audit.md is retained as HISTORICAL REFERENCE for contracts the
docs mention (e.g. the stateless Bearer auth flow, the users/{uid} Firestore profile shape) —
implement those contracts fresh; do not copy legacy code. The engine
(src/lib/wikitext, src/lib/db, src/lib/wiki, src/lib/title.ts, src/lib/env.ts, scripts/seed.ts)
was authored new in this project and carries over as-is.

Theme: docs/engine/theme.md — the Vercel design language. Light default, dark complement,
next-themes attribute="class" defaultTheme="system". Tokens on :root with .dark overrides,
bridged to Tailwind 4 via @theme inline. Geist Sans + Geist Mono. No legacy brand assets
(fonts/logos); the wordmark is typographic.

## Engine i18n messages (confirms spec Addendum A3)
`WikiConfig.messages` is supplied per rendering locale from the UI dictionary system (lib/i18n),
keys namespaced `wikitext.*` (e.g. `wikitext.toc-title`, `wikitext.red-link-title`,
`wikitext.cite-error-*`).
