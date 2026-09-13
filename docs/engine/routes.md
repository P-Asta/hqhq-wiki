# Route map (O8) — NORMATIVE

Auth levels: **anon** (no token) · **editor** (valid Firebase ID token, not banned) ·
**admin** (`authenticateAdminRequest`: Firestore bootstrap roles OR active SQLite admin grant) ·
**manager** (`authenticateManagerRequest`: the `admin` role — displayed "Manager" — or a
username in `MANAGER_USERNAMES`, src/lib/roles.ts). All mutation APIs take
`Authorization: Bearer <idToken>` per request (stateless — reuse-audit §2).
Every authenticated write first upserts the SQLite `users` mirror (db-schema §D pattern 15).
Error bodies: `src/lib/api-response.ts` unified shape everywhere EXCEPT `/api/auth/me`, whose
existing body shape is frozen (auth/client.ts is salvaged verbatim).

**There is no anonymous write path.** Reading is public; every edit, upload and admin action
requires a signed-in account, enforced by `requirePrincipal` (401 `auth-required` when
anonymous). Local mode — the old decisions-v2 O15 fallback that let an uncredentialed server
accept anonymous edits as a synthetic `local` principal — is **removed**. Service-account
credentials are OPTIONAL (O17.1): tokens verify against Google's published keys and Firestore is
read as the caller, so sign-in and editing work without them; credentials add the
session-revocation check and rule-bypassing Firestore access.

`[...title]` catch-all segments carry `nsPrefix+slug` per decisions O1 (e.g.
`template:infobox-moon`). The locale is UI locale AND content locale for the page being viewed.

**URLs are locale-optional (decisions-v2 O12): English carries no prefix.** The app tree is
still `src/app/[locale]/**`; `src/middleware.ts` maps public URLs onto it (see
"Locale prefixes" below). The `Route` column names the internal route; `URL (en)` and
`URL (ko)` are what the address bar actually shows.

## Locale prefixes (decisions-v2 O12)

`src/middleware.ts` owns the mapping; `decideRoute(pathname)` is its pure core (unit-tested in
`src/middleware.test.ts`). Query string and fragment ride along untouched on every row, so
`?v=`, `?rev=` and `?redirect=no` survive both a rewrite and a redirect (versioning.md §6).

| Request | Decision | Result |
|---|---|---|
| `/`, `/wiki/x`, `/search`, `/special/…` | rewrite → `/en/…` | English served at its prefix-free address |
| `/en`, `/en/wiki/x` | **308 redirect** → `/`, `/wiki/x` | one canonical URL per page (O12 rule 1) |
| `/EN/wiki/x` | 308 redirect → `/wiki/x` | casing canonicalized |
| `/ko`, `/ko/wiki/x` | pass through | registered non-default prefix |
| `/KO/wiki/x` | 308 redirect → `/ko/wiki/x` | casing canonicalized |
| `/xx/wiki/x` | rewrite → `/en/xx/wiki/x` | unknown prefix is an ordinary English path; 404s (O12 rule 2) |
| `/api/*`, `/_next/*`, `/.well-known/*` | skip | not app routes |
| `/favicon.ico`, `/robots.txt`, `/sitemap.xml`, `/icon.svg` | skip | root-level files (a single root segment containing a dot) |

A **skip** hands the path to Next untouched, which is the only correct answer for a `public/`
asset — but Next's `[locale]` segment matches any single segment, so a skipped root file that
does *not* exist would otherwise render the home page. `[locale]/layout.tsx` and
`[locale]/page.tsx` therefore both call `isKnownUrlLocale()` and `notFound()` on anything else
(both, because a layout's `notFound()` cannot stop a page that has already begun streaming).
Consequence worth knowing: the segment is validated against the **shipped UI locales**, so a
locale registered only in the `languages` table is not addressable — the same rule the
middleware enforces.

Deeper paths keep their dots — `/wiki/file:cruiser.png` and `/wiki/v1.2` are page titles, not
files — so the matcher deliberately does **not** filter on "contains a dot".

Next 16.3 prints `⚠ The "middleware" file convention is deprecated. Please use "proxy" instead.`
on every build. The file name here is what O12.4 prescribes and it works; renaming it to
`src/proxy.ts` is a migration to make when this document is updated with it.

**Which prefixes are honored.** The middleware runs on every request and must stay cheap, so
the prefix list is a *build-time* constant derived from `src/lib/i18n` (`UI_LOCALES` minus the
default — today `en` + `ko`), never a read of the SQLite `languages` table. Consequence: a
content locale registered at runtime becomes **URL-addressable only once it also ships a UI
dictionary** in `src/lib/i18n/dictionaries/`. Until then its pages are reachable through the EN
tree and its `/xx/…` links 404, exactly as O12 rule 2 prescribes. Adding a locale to the URL
space is therefore a code change (add the dictionary + the `UI_LOCALES` entry), not a data change.

**No implicit negotiation** (O12 rule 3): `Accept-Language` and cookies never change what a URL
serves. A prefix-free URL is always English.

**One owner for every href.** `src/lib/locale-path.ts` is the only module that may put a locale
into a URL — `localePath`, `homeHref`, `articleHref`, `editHref`, `historyHref`, `diffHref`,
`whatLinksHereHref`, `titleRouteHref`, `searchHref`, `specialHref`, `titleToPath`, `withQuery`,
`titlePathSegment`, the guards `isDefaultUrlLocale` / `isKnownUrlLocale` / `htmlLang`, and the
inverse `parseLocalePath`. The engine's per-locale `WikiConfig` (`src/lib/wiki/config.ts`, a
**universal** module so `scripts/seed.ts` shares it — the seed caches the HTML it renders, and
cached HTML wins at read time) is built from `localePath` too, so rendered wikitext links are
`/wiki/$1` in English and `/{locale}/wiki/$1` elsewhere. `src/lib/wiki/context.ts` re-exports it
and keeps `server-only` for `buildParseContext`, which opens SQLite.

**`<html lang>`.** The root layout renders `<html>` but sits above `[locale]`, so it cannot read
the segment. The middleware stamps the URL's locale onto the forwarded request as
`x-wiki-locale` (the header name is `LOCALE_HEADER`, also owned by `locale-path.ts`) on both the
rewrite and the pass-through, and `src/app/layout.tsx` resolves it with `htmlLang()`, which
validates the value and falls back to English. A redirect carries no header — the browser's next
request gets one.

## Pages

| Route | URL (en) | URL (ko) | Auth | Notes |
|---|---|---|---|---|
| `/[locale]` | `/` | `/ko` | anon | Hero, category grid (real `category_links` membership with live counts — decisions-v2 O13.3), recent-changes teaser, search box |
| `/[locale]/wiki/[...title]` | `/wiki/titan` | `/ko/wiki/titan` | anon | Article view. `?rev=<id>` old-revision banner. `?redirect=no` stops redirect-follow; otherwise one-hop follow + "Redirected from" note. Category: pages append member listing. **Missing page ⇒ the editor for that title, inline** (decisions-v2 O14.1 — same `<Editor>` and same `loadEditorView` seed as `/edit`, title from the URL, empty source, `?v=` carried); a visitor who may not edit gets the "there is currently no text in this page" notice with a sign-in CTA and the edit URL (O14.2). Locale fallback: if no locale head, render EN head with a banner + translate CTA |
| `/[locale]/edit/[...title]` | `/edit/titan` | `/ko/edit/titan` | anon: read-only source + login CTA; editor: edit | Create-or-edit, and still the canonical edit URL (O14.3). Textarea + toolbar + live preview (POST /api/preview) + comment + minor + hidden parentRevId; 409 conflict UI shows diff. `?v=` seeds the preview dropdown and rides back to the article. Data comes from `loadEditorView` (`src/lib/wiki/edit-view.ts`), shared with the missing-article route |
| `/[locale]/history/[...title]` | `/history/titan` | `/ko/history/titan` | anon | Keyset-paginated revision list; per-locale tabs (`?l=`, `?cursor=`); diff/rollback/restore actions inline |
| `/[locale]/diff/[...title]` | `/diff/titan` | `/ko/diff/titan` | anon | `?from=<revId>&to=<revId>` side-by-side + inline word diff |
| `/[locale]/search` | `/search?q=` | `/ko/search?q=` | anon | `?q=` FTS results w/ snippets, EN-fallback chips (O7). No exact title match ⇒ a prominent "Create “*q*”" action pointing at that title's **article** URL (O14.5); the suggest dropdown carries the same action as its last option |
| `/[locale]/special/recent-changes` | `/special/recent-changes` | `/ko/special/recent-changes` | anon | All locales, filterable; each row links into its own content locale |
| `/[locale]/special/wanted-pages` | `/special/wanted-pages` | `/ko/special/wanted-pages` | anon | Red-link targets ranked by inbound count; each links at the article URL (O14.6) |
| `/[locale]/special/all-pages` | `/special/all-pages` | `/ko/special/all-pages` | anon | Per-namespace listing |
| `/[locale]/special/categories` | `/special/categories` | `/ko/special/categories` | anon | decisions-v2 O13.4: every category with its member/subcategory counts (count desc, then slug), a mark on the ones with no `Category:` description page, plus the uncategorized-pages report |
| `/[locale]/special/what-links-here/[...title]` | `/special/what-links-here/titan` | `/ko/special/what-links-here/titan` | anon | Backlinks + transclusions |
| `/[locale]/special/outdated-translations` | `/special/outdated-translations` | `/ko/special/outdated-translations` | anon | Freshness report (db-schema query #10) |
| `/[locale]/special/version-coverage` | `/special/version-coverage` | `/ko/special/version-coverage` | anon | versioning.md §6 report; `?v=` filters by boundary |
| `/[locale]/languages` | `/languages` | `/ko/languages` | anon view; editor propose; admin activate | Registry from `languages` table |
| `/[locale]/login`, `/[locale]/profile` | `/login`, `/profile` | `/ko/login`, `/ko/profile` | anon / self | Salvaged components |
| `/[locale]/admin` | `/admin` | `/ko/admin` | admin | Grants, bans, deleted pages, audit log |

There is no `src/app/page.tsx`: `/` is the middleware rewrite of the English home, so the root
has exactly one implementation (`src/app/[locale]/page.tsx`).

## Creating a page is visiting its URL (decisions-v2 O14)

There is no create landing, no wizard, no category picker. The flow is one hop:

1. **URL** — `/wiki/gold-bar` (or `/ko/wiki/gold-bar`, or `/edit/gold-bar`) for a title with no
   head in any locale. `loadArticleView` returns `kind: "missing"`.
2. **State** — the route seeds `<Editor>` from `loadEditorView` (`src/lib/wiki/edit-view.ts`):
   `titlePath` = `$1`, `displayTitle` humanized from the slug, empty source, `parentRevId: null`,
   plus the version registry and any registered `?v=`. `/edit/<title>` calls the same loader, so
   both URLs render identical editor state (O14.6).
3. **Gate** — `<CreatePageView>` shows that editor to anyone who may edit: a signed-in visitor,
   and also one whose auth is still resolving (the editor is inert until it does). A *resolved*
   anonymous visitor gets the O14.2 notice instead — the classic
   "there is currently no text in this page" plus a sign-in CTA and a link to `/edit/<title>`.
4. **Save** — `PUT /api/pages/<$1>` with `parentRevId: null` creates the page, then the editor
   navigates to the article URL (carrying `?v=` when the reader had a non-default selection).

**Red links** (`WikiConfig.redLinkPath`) are therefore the plain article path — `/wiki/$1`,
`/ko/wiki/$1` — with no `?redlink=1`. The engine still marks them `class="new red-link"` with the
`(page does not exist)` title suffix, and `/special/wanted-pages` links the same way.

## Organization is category-driven (decisions-v2 O13)

There is no nav taxonomy any more. A page belongs to a category because its wikitext carries
`[[Category:X]]`, the engine writes that into `category_links`, and every browse surface reads
that table — `listCategoriesWithCounts` / `uncategorizedPages` / `categoryMembers`
(`src/lib/db/queries.ts`). Pages may have zero, one, or many categories, and a page in none is
still a page: it is reachable by URL, by search, by `/special/all-pages`, and it is listed on
`/special/categories` under "Uncategorized pages".

**Home ordering.** The grid takes the `home_categories` site setting — a JSON array of category
slugs — as its order when set, dropping any slug no page has tagged; otherwise member count
descending. Either way it is capped at 8 (`HOME_CATEGORY_LIMIT`), with `/special/categories` one
link away. `scripts/seed.ts` seeds the setting with the seven decorated slugs and never clobbers
an admin's later value.

**The `categories` table is decoration.** It supplies an optional localized label, description
and sort order (`upsertNavCategory` / `listNavCategories`); a category with no row renders under
its `Category:` page title, or its humanized slug. Nothing requires a row to exist, and the
seed's seven rows exist only so the home page keeps reading the way it did (O13.6).

## API

| Route | Method | Auth | Notes |
|---|---|---|---|
| `/api/auth/me` | GET | token optional | SALVAGED body shape; anonymous → `{authenticated:false}` |
| `/api/preview` | POST | **anon** | `{wikitext, title, locale}` → `{html, meta}`; public: reads only, no cache writes, volatile OK, 400 KB wikitext cap |
| `/api/pages/[...title]` | GET | anon | `?locale=&rev=` → source + meta + head info |
| `/api/pages/[...title]` | PUT | editor | `{locale, content, comment, minor, parentRevId, displayTitle?}`; 409 `{code:"edit-conflict", currentRevId}`; runs full save txn (links/categories/search/cache per db-schema §D2 + addenda) |
| `/api/pages/[...title]` | DELETE | admin | db-schema Addendum A6 ordering + audit row |
| `/api/pages/[...title]/rollback` | POST | editor | `{toRevId, locale}` → new head via saveEdit |
| `/api/search` | GET | anon | `?q=&locale=&limit=&cursor=` (O7 union) |
| `/api/search/suggest` | GET | anon | prefix FTS over titles, ≤8 items |
| `/api/media/[...name]` | GET | anon | O6 streaming |
| `/api/media` | POST | editor | multipart upload; writes `files` row (may land wave-2) |
| `/api/languages` | GET/POST/PATCH | anon / editor / admin | list / propose / activate-deactivate |
| `/api/admin/users` | GET | **manager** | `?q=` username prefix search for the console picker |
| `/api/admin/grants` | GET/POST/DELETE | **manager** | list/add/revoke (no self-revoke) |
| `/api/admin/ban` | POST | **manager** | ban by username (resolved server-side); O5 dual-write; no self-ban |
| `/api/admin/audit` | GET | **manager** | audit_log keyset page; body carries a uid → `{displayName, banned}` map so the console can render an actionable author chip |
| `/api/reports` | POST | editor | `{targetUid, reason?, context?}` → an `open` row; 400 `self-report`, 404 `user-not-found` when the uid is not an account this wiki has seen. The moderation action an ORDINARY editor has |
| `/api/admin/reports` | GET/PATCH | **manager** | `?status=open\|resolved\|dismissed\|all&cursor=` keyset page / `{id, status}` to close one; 409 `report-closed` if another manager got there first |

### Audit and reports

Two different things, deliberately two tables and two tabs.

`audit_log` is the record of what HAPPENED — every mutation writes one row in the same
transaction as the change itself (`writeAudit` in store.ts), so a change and its audit entry
cannot disagree. It is append-only and has no state.

`reports` is what somebody THINKS should happen. A report has a lifecycle
(`open → resolved | dismissed`) a manager has to move, and the queue exists so those few rows
are not buried under every edit the wiki ever recorded.

Who may do what to an account is decided per-viewer, and re-checked server-side:
signed out → nothing; a signed-in editor → `POST /api/reports`; a manager →
`POST /api/admin/ban` directly. `src/components/moderation-chip.tsx` picks which to offer;
`requirePrincipal` and `authenticateManagerRequest` decide what is permitted.

**A uid in a request body is not a name and not a licence to create one.** `POST /api/reports`
resolves `targetUid` against the `users` mirror and answers 404 if it is not there, and takes
the display name from that row rather than from the body. Without both, any signed-in editor
could POST an invented uid with a name of their choosing and have the report conjure a `users`
row to hang itself on — unbounded rows naming an account no manager could ban, because no such
account exists in Firestore to ban. `upsertUser` therefore only ever writes a name that came
from its owner's own verified principal.
