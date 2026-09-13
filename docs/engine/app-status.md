# App layer status — final verification report

Date: 2026-08-31. Author: final verifier (clean-slate rebuild, decisions O11 — nothing copied
from any legacy code). Companion to `engine-status.md`, which documents the frozen engine
(`src/lib/wikitext/**`, `src/lib/db/**`, `src/lib/wiki/service.ts`, `src/lib/title.ts`,
`src/lib/env.ts`, `scripts/seed.ts`). This document records what the eight app-layer agents
delivered, the verification gates, how the built application behaves against a real seeded
SQLite database over HTTP, and what is still missing.

> **Superseded in part by §9.** Sections 1–7 describe the app as it stood on 2026-08-31,
> before decisions-v2 O12–O15. Where they disagree with §9 — the `/en` prefix in every URL, the
> 401 on `POST /api/preview`, the "Create this page" CTA, the nav-category grid — **§9 is
> current** and `decisions-v2.md` is normative.

## 1. Gate status

All commands run from the project root.

| # | Gate | Command | Result |
|---|---|---|---|
| 1 | Typecheck | `node ./node_modules/typescript/bin/tsc --noEmit` | clean, 0 errors |
| 2 | Tests | `node ./node_modules/vitest/vitest.mjs run` | **30 files / 882 tests passed** (engine baseline 758 + app additions + 4 verifier tests) — superseded by §6c: **41 files / 1314 tests** after the Fandom parity pass |
| 3 | Lint | `node ./node_modules/eslint/bin/eslint.js . --max-warnings 0` | clean, 0 warnings |
| 4 | Build | `node ./node_modules/next/dist/bin/next build` | succeeds (Next 16.3.3, Turbopack, Node 24) |
| 5 | Seed | `WIKI_DB_PATH=./wiki-data/smoke.db node ./node_modules/tsx/dist/cli.mjs scripts/seed.ts` | **48 rows** (9 template / 36 main / 1 project, incl. ko translations), 13 versions, default `v70`, **0 parse warnings** |
| 6 | Smoke | `next start -p 3123` against the seeded db | 24/24 assertions passed (§2), server log free of errors and hydration warnings |
| 7 | Theme | built CSS + rendered HTML vs `theme.md` | tokens only — no hex in app chrome, complete `.dark` block, gradient at hero scale only (§5) |

## 2. Smoke results (real HTTP, production build)

Each row asserts HTTP status **and** a response substring where listed.

| Method | URL | Status | Asserted content | Result |
|---|---|---|---|---|
| GET | `/en` | 200 | `grad-text-b` hero word + `/en/wiki/category:moons` card | PASS |
| GET | `/en/wiki/titan` | 200 | `infobox` + `id="toc"` | PASS |
| GET | `/ko/wiki/titan` | 200 | `타이탄` | PASS |
| GET | `/en/wiki/project:version-scoping?v=v45` | 200 | `first window` (neither other window present) | PASS |
| GET | `/en/wiki/project:version-scoping?v=v56` | 200 | `second window` | PASS |
| GET | `/en/wiki/project:version-scoping?v=v62` | 200 | `third window` | PASS |
| GET | `/en/wiki/8-titan` | 200 | one-hop follow + `Redirected from` note; `?redirect=no` shows the redirect page itself | PASS |
| GET | `/en/wiki/category:moons` | 200 | member listing (`/en/wiki/titan`) under the red-link landing | PASS (after verifier fix, §4) |
| GET | `/en/wiki/nonexistent` | 200 | `Create this page` CTA | PASS |
| GET | `/en/history/titan` | 200 | revision list with diff radio pairs | PASS |
| GET | `/en/diff/titan?from=&to=10` | 200 | creation diff (`from` defaults to parent-of-`to`) | PASS |
| GET | `/en/search?q=quota` | 200 | FTS results containing `quota` | PASS |
| GET | `/en/special/recent-changes` | 200 | all-locale feed | PASS |
| GET | `/en/special/wanted-pages` | 200 | red-link targets by inbound count | PASS |
| GET | `/en/special/version-coverage` | 200 | | PASS |
| GET | `/en/languages` | 200 | | PASS |
| GET | `/en/login` | 200 | | PASS |
| GET | `/en/admin` | 200 | sign-in gate; tab labels only, **no admin data in the HTML** | PASS |
| GET | `/api/search?q=titan` | 200 | JSON hits for `titan` | PASS |
| GET | `/api/pages/titan` | 200 | `{page, locale, pageLocale, …}` JSON | PASS |
| POST | `/api/preview` | **401** | unified error body | PASS |
| PUT | `/api/pages/titan` | **401** | unified error body | PASS |

Additional probes, all as intended: `/` → redirect to `/en`; `/en/special/all-pages`,
`/en/special/outdated-translations`, `/en/special/what-links-here/titan`, `/en/profile`,
`/ko`, `/en/edit/titan`, `/en/edit/nonexistent`, `/ko/edit/quota` (O4 EN-prefill) all 200;
`GET /api/auth/me` anon → `{"authenticated":false}`; `GET /api/languages` → registry JSON;
`POST /api/pages/titan {action:"rollback"}` anon → 401; `?v=v999` on a scoped page →
"Unknown game version" warning + default-version fallback (versioning.md §6);
`GET /api/media/moon-titan.png` → graceful `404 {"error":{"code":"file-not-found"}}`.

The smoke database is disposable: it was deleted after the run (`wiki-data/smoke.db*`), and
`wiki-data/` is gitignored.

## 3. Route inventory

Pages are server components (`"use client"` only in real-interactivity islands); data-bearing
pages declare `dynamic = "force-dynamic"` and read SQLite per request — there is no build-time
content snapshot. `[...title]` catch-alls carry `nsPrefix:slug` (decisions O1). Rollback is a
`POST /api/pages/[...title]` body action `{action:"rollback", …}` because Next forbids
segments after a catch-all (routes.md) — the only route-shape deviation.

### Page routes

| Route | Purpose |
|---|---|
| `/` | redirect to `/en` |
| `/[locale]` | home: hero (one gradient word), no-JS GET search form, stats row, O3 category card grid, recent-changes teaser, version-registry chip strip |
| `/[locale]/wiki/[...title]` | article: `?v=` version scoping, `?rev=` old revision, `?redirect=no`, EN fallback banner (O4), category member listing, TOC, infobox |
| `/[locale]/edit/[...title]` | create-or-edit with preview; non-EN prefills from the EN head with a translating notice (O4) |
| `/[locale]/history/[...title]` | keyset pagination (`?cursor=`, 50/page), per-locale tabs (`?l=`), no-JS diff radio form |
| `/[locale]/diff/[...title]` | `?from=&to=`; `from` defaults to parent of `to` (creation diff vs empty) |
| `/[locale]/search` | server-rendered FTS results, snippets, O7 EN-fallback chips |
| `/[locale]/languages` | language registry + admin language manager |
| `/[locale]/login`, `/[locale]/profile` | Firebase sign-in, own contributions |
| `/[locale]/admin` | sign-in-gated tabs: grants, ban, audit log, version registry editor |
| `/[locale]/special/recent-changes` | all-locale feed, locale/minor filters, keyset `?cursor=` |
| `/[locale]/special/wanted-pages` | red-link targets ranked by inbound count |
| `/[locale]/special/all-pages` | per-namespace listing |
| `/[locale]/special/categories` | O13.4: every category + counts, unwritten-description marks, uncategorized report |
| `/[locale]/special/version-coverage` | pages by version boundary |
| `/[locale]/special/outdated-translations` | translation freshness report |
| `/[locale]/special/what-links-here/[...title]` | backlinks + transclusions |

### API routes

All JSON errors share one body shape `{error: {code, message, …extra}}`
(`src/lib/api-response.ts`); auth is stateless Firebase Bearer per request (the reuse-audit
contract, with the `users/{uid}` Firestore profile shape `{username, usernameLower, roles,
banned, profilePicture}`). Writes require auth — smoke-verified 401s. `api/pages` pins
`runtime = "nodejs"` (better-sqlite3).

| Route | Methods | Anon |
|---|---|---|
| `/api/pages/[...title]` | GET / PUT / POST (incl. `{action:"rollback"}`) | GET 200; writes 401 |
| `/api/preview` | POST | 401 |
| `/api/search`, `/api/search/suggest` | GET | 200 |
| `/api/languages` | GET (+ writes) | GET 200 |
| `/api/auth/me` | GET | `{"authenticated":false}` |
| `/api/media` | POST upload (10MB cap, magic-byte sniffed, SVG rejected) | 401 |
| `/api/media/[...name]` | GET stream | 200 / graceful 404 |
| `/api/admin/{grants,ban,audit,versions}` | per routes.md | 401 |
| `/api/profile/contributions` | GET | 401 |

## 4. Verifier repairs (this pass)

1. **Red-link category pages lost their member listing** — `loadArticleView`
   (`src/lib/wiki/read-view.ts`) built `categoryListing` only when the category page existed,
   so all seven home nav cards (no `category:` page is seeded) landed on a bare
   "does not exist" even though `[[Category:…]]` memberships existed. Fixed: the missing-page
   branch now appends the member listing (null when the category is truly empty) via a shared
   `buildCategoryListing` helper, and `src/app/[locale]/wiki/[...title]/page.tsx` renders it
   under the create CTA. Locked by the new `src/lib/wiki/read-view.test.ts` (4 tests).
2. **Site name split** — root metadata (`src/app/layout.tsx`) said "High Quota Wiki" while the
   header wordmark (`dict.common.siteName`), the seeded registry and the `{{SITENAME}}` spec
   all say "HQHQ Wiki". Unified the `<title>` default/template to "HQHQ Wiki".

No engine files were touched.

## 5. Theme conformance (`theme.md`)

- Built CSS defines the full token set on `:root` (light default) and redefines every pair in
  one `.dark` block matching the spec exactly; Tailwind 4 `@theme inline` bridging works
  (`bg-canvas`, `text-ink`, `border-hairline` utilities present in the built stylesheet).
- No hex colors in app-chrome components or inline styles. (Seeded *wikitext content* — the
  frozen engine's infobox/notice fixtures — carries its own inline styles by design; that is
  content, not chrome.)
- Gradient (`--grad-b-*`) renders only at hero scale: the home hero word and the not-found
  empty state. The single `grad-text` string in other pages' HTML is the inlined not-found
  RSC payload, not visible UI.
- Header: 64px, `--canvas` bg, bottom hairline, HQ square wordmark, centered search, locale
  switcher, theme toggle, account-menu island. Footer: top hairline, mute 13px. Geist
  Sans/Mono load in the root layout; `next-themes` class strategy, light default.

Known deliberate deviation: the wordmark text is the localized site name
(`HQHQ Wiki` / `HQHQ 위키`) rather than theme.md's literal "High Quota Wiki", keeping one name
across `{{SITENAME}}`, metadata, header and footer.

## 6. Per-area deliverables (8 agents)

| Area | Delivered |
|---|---|
| Shell / theme / i18n | root + locale layouts, `site-shell` (header/search/locale/theme/account), `globals.css` (theme.md tokens, `.wiki-prose`, infobox/TOC/wikitable directives), `src/lib/i18n/**` (typed en/ko dictionaries + parity test, `formatMessage`), UI kit `src/components/ui/*` |
| Auth | `src/lib/firebase/{client,admin}.ts`, `src/lib/auth/**` (Bearer verification, Firestore `users/{uid}` profile contract, role/ban checks; 26 tests), `login-form`, `account-menu`, `auth-provider` |
| Home | `/[locale]/page.tsx` (hero, no-JS search, stats, O13 category grid with live counts + browse-all link, teaser, version chips), `category-grid`, `recent-changes-teaser` |
| Read views | `/[locale]/wiki/[...title]` + `src/lib/wiki/read-view.ts` loader (O1 catch-all, `?v=`/`?rev=`/`?redirect=no`, version selector §6 carry, banners, category listing, translations) and the read-side components (`article-header`, `page-banners`, `wiki-html`, `category-listing`, `article-footer`, `version-selector`, `toc-toggle`) |
| Edit / history / diff | edit page (O4 EN prefill), history (keyset, locale tabs), diff pages; `src/lib/diff.ts` (23 tests); `editor`, `editor-toolbar`, `preview-pane`, `conflict-notice`, `history-list`, `diff-view`, `syntax-help` |
| Search / special / languages | `/search` + `/api/search{,/suggest}` (O7 EN union, FTS5 snippets), five `special/*` pages, `/languages` + `language-manager`, `search-results`, `special-table`, `suggest-box` |
| Admin / media | `src/lib/media.ts` (magic-byte sniffing, 10MB cap, SVG rejected; 15 tests), media upload/stream routes, four admin API routes + tabbed admin UI (`admin-tabs`, `grant-manager`, `ban-panel`, `audit-log`, `version-registry-editor`) |
| API pages | `/api/pages/[...title]` (GET/PUT/POST rollback), `/api/preview`, `api-response.ts` unified errors, zod request schemas, `/api/profile/contributions` |

## 6b. Seed content inventory (expanded 2026-08-31)

The full `seed-content-plan.md` §1 inventory is now authored: **26 main-namespace articles**
(3 §3 exemplars + 22 wave-2 articles + 1 KO translation of Titan), 9 templates, 8 redirects and
the `Project:Version scoping` help page (EN + KO).

| Batch (file) | Articles |
|---|---|
| `seed-content/moons.ts` | Artifice, Rend, Dine, Experimentation, Embrion, The Company (71-Gordion) |
| `seed-content/entities.ts` | Bracken, Coil-Head, Nutcracker, Old Bird, Masked |
| `seed-content/equipment-scrap.ts` | Jetpack, Teleporters, Zap gun, Company Cruiser, Apparatus, Gold bar, Cash register |
| `seed-content/mechanics-strategies.ts` | Overtime bonus, Scrap value multiplier, Weather, Selling at the Company, High quota routing, One-day quota, Apparatus pulls |

Each batch ships a test that parses every one of its articles through the engine with the 9
templates loaded and asserts **zero `meta.warnings`**, a rendered infobox, and the expected
categories. Data-honesty rule held: every number the author could not state with confidence
carries `{{Verify|…}}`, and version constructs were used only where the patch boundary is
known — the game-fact corpus therefore stays mostly version-agnostic by design.

**Remaining red links (13, all intentional — future inventory):** adamance, apparatus-room,
baboon-hawk, credits, deadline, extension-ladder, eyeless-dog, fancy-lamp, ghost-girl,
hoarding-bug, snare-flea, stun-grenade, thumper.

Smoke-verified after the expansion (`next start -p 3141`): artifice, bracken, teleporters,
weather, high-quota-routing, overtime-bonus, gold-bar, masked, the-company-(71-gordion),
category:entities, special/wanted-pages — all 200; `titan?v=v50` shows the new info banner;
`project:version-scoping?v=v45|v62` still switches windows.

## 6c. Fandom parity (integration pass, 2026-08-31)

Four agents landed Fandom (wikia) parity on top of the MediaWiki-compatible engine;
this section records what that pass delivered, what it deliberately does not, and how
it was verified. The normative text is `wikitext-spec.md` **"Fandom extensions"**
(F.0 support matrix, F.1–F.4) plus **Addendum A6**; nothing below changes any
behavior the §15 MediaWiki corpus covers.

### Gates (this pass)

| # | Gate | Result |
|---|---|---|
| 1 | `tsc --noEmit` | clean, 0 errors |
| 2 | `vitest run` | **41 files / 1314 tests passed** (engine baseline 1029 → 1277 from the four agents → 1314 after this pass) |
| 3 | `eslint . --max-warnings 0` | clean, 0 warnings |
| 4 | `next build` | succeeds (Next 16.3.3, 32 routes) |
| 5 | Seed | `--db=./wiki-data/smoke.db` ⇒ **48 rows**, 13 versions, **0 parse warnings** |
| 6 | Smoke | `next start -p 3151`; 20/20 routes HTTP 200, server log free of errors and hydration warnings |

### What is supported

| Area | Delivered |
|---|---|
| **Portable infobox** (`<infobox>`, spec F.1) | The `<infobox>` block a Fandom infobox *template* is written in, resolved in stage 2 against the template call's frame so `source="cost"` reads that call's argument. Full element set (`title`, `image`/`caption`/`alt`, `data`/`label`, `header`, `group`, `navigation`, `default`, `format`), the empty rule, `theme`/`theme-source`/`layout`, Fandom's `pi-*` class contract, no inline styles or colors. |
| **Fandom tags** (F.2) | `<tabber>` (both the legacy `Title=` / `\|-\|` and `<tab name>` syntaxes; panels are full block wikitext; **works with JavaScript disabled** via `:checked` sibling selectors), `<poem>`, and `<gallery>` extended to the full attribute vocabulary (`mode`, `widths`, `heights`, `spacing`, `captionalign`, `position`, `caption`, `class`). |
| **Sortable tables** (F.2.4) | Client-side progressive enhancement in `src/components/wiki/sortable-table.tsx`, mounted once from `wiki-html.tsx`. Adds `role="columnheader button"`, `tabindex`, `aria-sort` and `.sortable-ready` on hydration; bails out on merged cells or fewer than two data rows, so a reader without JS is never shown a dead control. |
| **Image sizes** (F.3.1) | The full MW resize grammar (`{N}px`, `x{N}px`, `{W}x{H}px`, `upright[={f}]`) resolved against `PageStore.getFile()` natural dimensions. Every `<img>` now carries explicit `width` and `height`, which is what removes layout shift on image-heavy articles. |
| **Interlanguage links** (F.3.2) | `[[ru:Artifice]]` is swallowed into `meta.languageLinks` like `[[Category:]]`, not rendered as a red link. The prefix set is a frozen list in `links.ts` (this wiki has no interwiki table); a namespace always wins. |
| **Reference ordering** (F.3.3) | Stage 6 restoration is two passes, so a `<ref>` born inside a `<gallery>` or thumb caption joins the `<references />` that was written earlier in the page. One list, correct numbering, no spurious "missing `<references />`" note. |
| **Red-link class** (F.3.4) | One spelling from every code path: `class="new red-link"`. |
| **Behavior switches** (F.3.5) | `__NOWYSIWYG__`, `__NOGALLERY__`, `__EXPECTUNUSEDCATEGORY__`, `__STATICREDIRECT__` recorded into `meta.behaviorSwitches`; `{{DEFAULTSORT:}}` sets the page-wide category sort key. |
| **Source editor** (F.4) | Rewritten Fandom-style editing surface: header strip with Source/Split/Preview, grouped toolbar, line-numbered highlight mirror under a transparent textarea, summary/minor footer, right rail with template and category chips, syntax drawer. `highlight()` is a lossless, total display tokenizer — it adds **no grammar**; `src/lib/wikitext/**` remains the only authority. |

### What is deliberately NOT supported

Each degrades safely — the page still renders, and nothing throws.

| Not supported | What the reader sees | Why |
|---|---|---|
| **Lua / Scribunto** (`{{#invoke:}}`) | `<span class="error">Unknown parser function: #invoke</span>` (§9.1) | A whole sandboxed language runtime, and no dependency may be added. Templates plus `#if`/`#switch`/`#expr` cover this wiki's needs. |
| **DynamicPageList** (`<dpl>`) | Escaped, shown literally (§10.7) | Query-generated lists would make one page's render depend on the whole corpus, breaking the parse cache's invalidation contract. |
| **`<tabview>`** (cross-*article* tabs) | Escaped, shown literally | Unlike `<tabber>` it transcludes other pages; same cache-invalidation objection. |
| **`<choose>` / `<option>`** (random content) | Escaped, shown literally | Randomness breaks the §14.11 determinism guarantee the render cache depends on. |
| **Fandom message walls / forums / Discussions** | n/a | Social features, not wikitext. |
| **`<panel>` / `<section>` tab strips inside an infobox** | Rendered as plain groups — every row reachable, no tab strip (divergence **F-1**) | Partial by choice; the data is never hidden. |

### Conformance fixture and its licensing

`docs/engine/fixtures/fandom-artifice.wikitext` is the verbatim wikitext of the
**"68-Artifice"** article from the Lethal Company Fandom wiki. It is **CC BY-SA**
content and is present as a **TEST FIXTURE ONLY** — it is never seeded as site
content, never served, and no module under `src/lib/db/**` reads it.

`src/lib/wikitext/fandom-conformance.test.ts` (30 tests) renders the whole article
end to end through the public `parse()` entry point against a map-backed
`PageStore` that supplies a realistic `Template:Location` portable infobox (all 22
parameters the article passes) plus `Template:Map:Artifice` and `Template:Moons`
stubs. It asserts zero warnings, the infobox's title/risk/cost and the three-line
map layout, `width="1100"` and the 480×480 bounding box, `[[ru:Artifice]]` absent
from the HTML and present in `meta.languageLinks`, exactly one `<ol class="references">`
containing the gallery-caption ref, one red-link class everywhere, three sortable
tables, three gallery items, the collected category, and the `Guide:` red link.

### Fix made during integration

**Block-level HTML wrappers rendered empty.** A `<div class="…">` an author opened
on its own line closed at the end of *that line* (§11.2 balancing scoped to the
line's inline region) and its later `</div>` was dropped as a stray close, so the
wrapper rendered as `<div class="x"></div>` with its content spilled out after it
as siblings — visible on the fixture, whose `<div class="terminal-text">` box lost
its styling. Now a p-allowing container (`div`, `blockquote`, `center`, `figure`)
holds the blocks that follow it, which is what §3.1 rule 4's "the HTML flows as-is"
means. Specified in **Addendum A6**; the p-REJECTING case (Addendum A1 / D-14) is
unchanged. Covered by `pipeline.test.ts` and the conformance fixture.

## 7. Known gaps

- **No media binaries seeded** — seeded `[[File:…]]` images (e.g. `moon-titan.png`) render
  `<img>` tags whose `/api/media/...` src 404s gracefully; uploads via `POST /api/media` work
  but no upload round-trip ran over HTTP (needs credentials).
- **No `public/` assets** — no favicon/logo files; the wordmark is CSS-only. Browsers get a
  404 for the default favicon.
- Missing articles return HTTP 200 with the create CTA (routes.md-conformant; a 404 status
  for red links is an open SEO nicety).
- ~~`?v=` on a non-version-scoped page is a silent no-op~~ **CLOSED:** the selection is carried
  out of an unscoped page by both its own links (`propagateVersion`) and the chrome
  (`carriedVersion`), so browsing at v56 survives a plain article. The selector itself shows the
  versions the page is *written* for (versioning.md §6, amended 2026-09-03), so a page that
  branches shows its chips and a page that does not shows nothing at all — carrying a selection
  and offering a choice are separate jobs, and only the first one belongs on every page. The
  "version ignored" info banner is gone; an *unknown* id keeps its warning banner. Unit-tested in
  `src/components/wiki/wiki-components.test.tsx` + `src/lib/wiki/read-view.test.ts`, confirmed
  over HTTP.
- The `?rev=` old-revision banner is unit-tested but not smoke-visible: every seeded page has
  exactly one revision, which is also why the smoke diff is a creation diff.
- Dictionaries exist for `en`/`ko` only; other registered locales fall back to the EN
  dictionary for chrome (content locales are unrestricted).
- Authed flows (edit save, admin) need real Firebase credentials (`FIREBASE_*` in
  `.env.local`); smoke covered the anonymous surface plus 401 gating. No rate limiting;
  stateless Bearer means no CSRF surface, but abuse control is deferred.

## 8. Dev workflow

The app runs fully — sign-in and editing included — with **no** `.env.local`: tokens verify
against Google's published keys (decisions-v2 O17.1). Adding `FIREBASE_CLIENT_EMAIL` /
`FIREBASE_PRIVATE_KEY` buys the session-revocation check and rule-bypassing Firestore access. `WIKI_DB_PATH` (default
`./wiki-data/wiki.db`), `WIKI_UPLOAD_ROOT`, `WIKI_DEFAULT_LOCALE`, `WIKI_ADMIN_ROLES` are read
lazily via `src/lib/env.ts`; `NEXT_PUBLIC_FIREBASE_*` identify the browser app.

```bash
yarn install
yarn seed                          # 48 rows into ./wiki-data/wiki.db (idempotent)
yarn dev                           # http://localhost:3000  (English is prefix-free — §9b)
cp .env.example .env.local         # optional: adds revocation checks + admin Firestore

yarn typecheck                     # tsc --noEmit
yarn test                          # vitest (1441)
yarn lint                          # eslint --max-warnings 0
yarn build && yarn start           # production
```

`yarn seed` accepts `--reset` (delete the db file first), `--dry-run` and `--db=PATH`. There
is no migration step: `ensureSchema` runs the idempotent DDL (`src/lib/db/ddl.ts`) on every
connection open, so opening a fresh path creates a complete database. The smoke recipe is
exactly gates 5–6 with `WIKI_DB_PATH=./wiki-data/smoke.db` and `next start -p 3123`. Seeding also
flushes the render cache (§9f), so a seed run is the way to make an engine or config change
visible on pages whose wikitext did not change.

If `tsc` reports missing modules under `.next/types/**`, the generated route types are stale
from a previous route layout: delete `.next` and `tsconfig.tsbuildinfo` and re-run.

---

## 9. v2 UX changes (decisions-v2 O12–O15)

Date: 2026-09-01. Author: integrator. Four agents implemented O12 (locale-optional URLs),
O13 (categories replace the nav taxonomy), O14 (creating a page is visiting its URL) and
O15 (public preview + local mode); this section records the merged result, the seam repairs,
and the verification. `decisions-v2.md` is normative and supersedes the older parts of §2/§3
above — most visibly, `/api/preview` is now **public** and `/en/…` is no longer an address.

### 9a. Gates (this pass)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `node ./node_modules/typescript/bin/tsc --noEmit` | clean, 0 errors |
| Tests | `node ./node_modules/vitest/vitest.mjs run` | **46 files / 1441 tests passed** (1314 baseline + 120 from the four agents + 7 added here) |
| Lint | `node ./node_modules/eslint/bin/eslint.js . --max-warnings 0` | clean |
| Build | `node ./node_modules/next/dist/bin/next build` | succeeds (Next 16.3.3, Turbopack) |
| Seed | `WIKI_DB_PATH=./wiki-data/smoke.db … scripts/seed.ts --reset` | 48 rows, 13 versions, **0 parse warnings** |
| Smoke | `next start -p 3181`, **no `.env.local`** (local mode engaged — HISTORICAL, §9e: local mode has since been removed by decisions-v2 O17) | every row below passed; the server log carried the local-mode warning and nothing else |

### 9b. O12 — locale-optional URLs

English owns the prefix-free space; every other locale prefixes. `src/middleware.ts` maps the
public URL onto the unchanged `src/app/[locale]/**` tree (rewrite prefix-free → `/en/…`, pass
`/ko/…`, **308** `/en/…` and mis-cased prefixes to the canonical form) and
`src/lib/locale-path.ts` is the single owner of every href, including the engine's
`WikiConfig.articlePath` and the seed's.

Verified over HTTP: `/wiki/titan` carries **zero** `/en/` hrefs; `/ko/wiki/titan` carries
**zero** internal hrefs without the `/ko` prefix; `/en/wiki/titan` → `308 /wiki/titan`;
`?v=` survives both hops.

Two integration repairs belong to this decision:

- **`<html lang>` followed the tree, not the URL.** The root layout sits above `[locale]` and
  hard-coded `lang="en"`, so every Korean page announced English. The middleware now stamps the
  URL's locale onto the forwarded request (`x-wiki-locale`, owned by `locale-path.ts`) and
  `src/app/layout.tsx` reads it through `htmlLang()`, which validates the value before it
  reaches the attribute. Cost: the root layout is dynamic, so `/_not-found` is no longer
  prerendered — every other route was already `force-dynamic`.
- **Junk root segments rendered the home page.** The middleware deliberately skips root-level
  files (`/robots.txt`, `/favicon.ico`, `/icon.svg`) so a `public/` asset is never rewritten —
  but Next's `[locale]` dynamic segment then swallowed the ones that do not exist: `/robots.txt`
  rendered **the home page with HTTP 200**, and the render crashed with `RangeError: Incorrect
  locale information provided` when `new Intl.DateTimeFormat("robots.txt")` ran on the
  recent-changes list. Fixed in three places: `isKnownUrlLocale()` guards the segment in
  `[locale]/layout.tsx` **and** in `[locale]/page.tsx` (a layout's `notFound()` cannot stop a
  page that is already streaming), and every date goes through `dateTimeFormat()`
  (`src/lib/i18n/format.ts`), which falls back to English instead of throwing and memoizes the
  formatter per locale + options.

**Middleware constraint.** The honored prefix list is the build-time `UI_LOCALES` constant,
never a read of the `languages` table — the middleware runs on every request and must not open
SQLite. A content locale becomes URL-addressable only once it also ships a dictionary.

### 9c. O13 — organization is category-driven

`navCategory` is gone from page identity and from `SeedArticle`. A page belongs to a category
because its wikitext carries `[[Category:X]]`; `category_links` is the only source of truth for
browsing. The home grid reads real membership with live counts (`listCategoriesWithCounts`),
ordered by the `home_categories` site setting when present and by count otherwise, capped at 8.
`/special/categories` lists every category plus the uncategorized report. The `categories`
table survives as optional display metadata only (label, description, sort order); a category
with no row renders under its own name.

Verified: the home cards show `moons 7 · entities 6 · mechanics 5 · equipment 4 · scrap 3 ·
strategies 3` — real membership, not a registry; `/wiki/category:moons` lists its 7 members;
`/special/categories` lists 15 categories plus the "Uncategorized pages" section.

### 9d. O14 — creating a page is visiting its URL

`GET /wiki/some-new-page` returns **200 and the editor**, inline in the article chrome:
"Creating Some new page", toolbar, source mirror, right rail, live preview — the same
`<Editor>` and the same `loadEditorView` state as `/edit/some-new-page`
(`src/lib/wiki/edit-view.ts` is shared by both routes, so they cannot drift). A *resolved*
anonymous visitor on a credentialed server gets the classic "there is currently no text in this
page" notice with a sign-in CTA instead (`CreatePageView`), never a dead end. Search offers
`Create “<query>”` pointing at the article URL when nothing matches the title exactly.

**Red links are the plain article path.** `WikiConfig.redLinkPath` equals `articlePath`, so
`/wiki/titan` links its unwritten targets as `/wiki/fancy-lamp` with `class="new red-link"` and
no `?redlink=1`.

### 9e. O15 — public preview and local mode

> **Superseded in part (2026-09-08, decisions-v2 O17).** The public-preview half still holds.
> **Local mode is gone** — editing and admin now always require a signed-in account, and the
> `WIKI_LOCAL_MODE` / `WIKI_LOCAL_USER` variables no longer exist. Everything below about local
> mode, and the smoke runs that relied on it, records what was true then, not now.

**The preview bug.** `POST /api/preview` required a verified Firebase ID token. On any install
without Firebase Admin credentials — including a fresh clone — the token could never verify, so
the editor's live preview failed with "The preview could not be rendered" on every keystroke.
Root cause: an auth guard on a route that only *reads*. The guard is gone (O15.1); the route
renders and returns HTML, writes nothing, touches no cache, and keeps its 400 KB wikitext cap
as the only abuse bound. Verified: `POST /api/preview` with **no Authorization header** → 200
with rendered HTML, in both locales.

**Local mode.** With no `FIREBASE_CLIENT_EMAIL`/`FIREBASE_PRIVATE_KEY` and no
`GOOGLE_APPLICATION_CREDENTIALS`, `isLocalMode()` is true and every guard resolves one fixed
principal (`uid: "local"`, display name from `WIKI_LOCAL_USER`, admin-capable, never banned),
so a fresh clone is usable: reads stay public as always, and writes plus admin surfaces are
allowed and attributed to that account. `WIKI_LOCAL_MODE=true` forces it on even with
credentials; `WIKI_LOCAL_MODE=false` forces it off (nobody can edit until credentials exist).
The server logs one loud warning at first use and the header shows a persistent "Local mode"
badge.

> **Security note.** Local mode means *anyone who can reach the server can edit it and use the
> admin surfaces*. It is a single-machine development affordance. Any deployment reachable by
> other people must either configure Firebase Admin credentials or set `WIKI_LOCAL_MODE=false`
> — and a host whose ADC comes from a metadata server rather than an env var must set it
> explicitly, because `hasFirebaseAdminCredentials` cannot see those credentials and would
> otherwise leave the wiki world-writable.

Verified with no `.env.local`: `GET /api/auth/me` → `localMode: true` with the local principal;
the header HTML carries the badge and its tooltip; `PUT /api/pages/sandbox` with no
Authorization → **201**, and `/wiki/sandbox` then rendered it attributed to "Local editor";
`DELETE /api/pages/sandbox` → 200 (an admin surface, anonymous, in local mode).

### 9f. Seam repairs (integration)

| Repair | Why |
|---|---|
| `humanizeSlug` had **three** definitions (read-view, the pages API, the history route). Now one, in `src/lib/title.ts`. | Two of them normalized differently. |
| The history and diff routes hand-built the `$1` catch-all (`nsName + ":" + encodeURIComponent(slug)`). They call `titlePathSegment()` now. | decisions O1/O12: one owner for the title segment. |
| **`scripts/seed.ts` rendered with its own `WikiConfig`**, whose `redLinkPath` was `/wiki/$1?redlink=1`, plus its own copy of the engine messages. The engine config moved to the universal `src/lib/wiki/config.ts`, which both `src/lib/wiki/context.ts` and the seed import. | The seed **caches** the HTML it renders, and cached HTML wins at read time — so every seeded page served red links pointing at the removed `?redlink=1` flow, contradicting O14.6. The pre-existing `wiki-data/wiki.db` did carry such rows. `context.ts` keeps `import "server-only"` (it opens SQLite); the config half had to become universal for the seed to share it. |
| `scripts/seed.ts` now calls `flushParsedCache()` after seeding. | The render cache holds HTML produced by whatever engine + config was current when a page was last saved, and the seed leaves unchanged pages alone — a code change (an `articlePath`, a red-link target, a message) would otherwise stay invisible on every page whose wikitext did not also change. Each page re-renders once on its next view (versioning.md §4). |
| Six hand-rolled `new Intl.DateTimeFormat(locale, …)` call sites → `dateTimeFormat()`. | See §9b: a locale that is not a valid BCP-47 tag crashed the render. It also stops rebuilding a formatter for every row. |

### 9g. Known issues (unchanged by this pass)

- **`notFound()` answers with HTTP 200 and the 404 body.** Every page route is `force-dynamic`,
  so Next flushes the shell before a render-time `notFound()` resolves; the reader sees the
  correct "Page not found" page, but the status line says 200 (`/diff/titan` with no `?to=`,
  `/history/no-such-page`, `/robots.txt`). A path that fails to *match* a route (`/zzz`) still
  returns a real 404. Pre-existing and independent of O12–O15 (reproduced with the change
  reverted); fixing it means giving up `force-dynamic` on those routes or moving the decision
  into the middleware.
- **`⚠ The "middleware" file convention is deprecated. Please use "proxy" instead.`** Next 16.3
  prints this on every build. `src/middleware.ts` is what decisions-v2 O12.4 and `routes.md`
  prescribe, and it works; renaming it to `proxy.ts` is a migration to make when those docs are
  updated with it.
- `<html dir>` is still fixed at the default. Both shipped locales are LTR; an RTL locale would
  need the `languages.direction` column plumbed through the same header as `lang`.
