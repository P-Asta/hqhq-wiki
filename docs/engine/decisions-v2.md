# Lead decisions v2 (O12–O17) — NORMATIVE, 2026-09-01 (O17 added 2026-09-08)

Supersedes anything contradictory in `decisions.md`, `routes.md`, `app-status.md`.
Driven by four user requests: the preview error, URL-driven page creation, dropping the
category-first structure, and locale-optional URLs.

---

## O12 — Locale-optional URLs (English is prefix-free)

**English (the default content and UI locale) has NO URL prefix. Every other locale prefixes.**

| Page | English | Korean |
|---|---|---|
| Article | `/wiki/titan` | `/ko/wiki/titan` |
| Edit | `/edit/titan` | `/ko/edit/titan` |
| History / diff | `/history/titan`, `/diff/titan` | `/ko/history/titan`, … |
| Search | `/search?q=` | `/ko/search?q=` |
| Special | `/special/recent-changes` | `/ko/special/recent-changes` |
| Languages / admin / profile / login | `/languages`, `/admin`, … | `/ko/languages`, … |
| Home | `/` | `/ko` |

Rules:
1. `/en/<anything>` **308-redirects** to the prefix-free form — one canonical URL per page.
2. A prefix is honored only when it is a **registered, active** locale in the `languages`
   table (other than `en`). `/xx/wiki/titan` is not a locale route: it falls through to the
   English tree and 404s like any unknown path.
3. **No implicit locale negotiation.** `Accept-Language` and cookies never change which
   content a URL serves — a prefix-free URL is always English. The language switcher may
   *remember* a preference (cookie `wiki-locale`) purely to decide where its own links point
   and to show a one-line "read this in 한국어" hint; it never redirects automatically.
4. Implementation: keep the existing `src/app/[locale]/**` tree; add `src/middleware.ts` that
   - rewrites a prefix-free path `/x` → `/en/x` internally,
   - passes `/ko/x` through,
   - redirects `/en/x` → `/x` (308),
   - skips `/api`, `/_next`, and static files entirely.
5. **Every href in the app and in rendered wikitext must use this scheme.** One helper module
   owns it (`src/lib/locale-path.ts`: `localePath(locale, path)`, `articleHref`, `editHref`,
   …), the engine's per-locale `WikiConfig.articlePath` becomes `/wiki/$1` for `en` and
   `/{locale}/wiki/$1` otherwise, and nothing builds a locale URL by string concatenation.
6. Version selection keeps working across this: `?v=` propagation is unchanged.

## O13 — Categories replace the fixed nav taxonomy

The `navCategory` field (one hard-coded bucket per page, chosen at creation, backed by the
`categories` registry table) is **removed from the creation flow and from page identity**.
Organization is wikitext-native and many-to-many:

1. A page belongs to a category by carrying `[[Category:X]]` in its source. Nothing else.
   Pages may have zero, one, or many categories, editable at any time by editing the page.
2. `category_links` (already populated by the engine from `meta.categories`) is the single
   source of truth for browsing.
3. **Home page**: shows real categories from `category_links` with live member counts, ordered
   by the `home_categories` site setting (a JSON array of category slugs) when present,
   otherwise by member count descending, capped at 8, plus a "browse all categories" link.
   No page is required to appear there.
4. **`/special/categories`**: every category with its member count and whether a
   `Category:` description page exists (an "uncategorized pages" report belongs here too).
5. `Category:` pages keep their auto member listing; their own wikitext, if any, renders above
   it as the category description. Categories need no registry row to exist.
6. The `categories` table survives **only** as optional display metadata (per-locale label and
   description, sort order) for categories that want a nicer name; a missing row is normal and
   the raw category name is used. `SeedNavCategory` seeding continues for the seven existing
   ones so nothing regresses visually.
7. `SeedArticle.navCategory` is dropped from the type. Seed articles already carry
   `[[Category:…]]` tags; any that do not get one, matching what their `navCategory` said.

## O14 — Creating a page is just visiting its URL

1. Visiting a page that does not exist renders **the editor for that title, inline**, in the
   normal article chrome — not a "create this page" landing. The title comes from the URL, the
   source starts empty, Save creates the page. (MediaWiki/Fandom behavior, minus the extra
   click.)
2. When the visitor may not edit (editing disabled and not signed in), the missing page shows
   the classic "no text in this page" notice plus a sign-in CTA — never a dead end.
3. `/edit/<title>` keeps working identically and remains the canonical edit URL; the missing
   article route simply renders the same editor component.
4. **No category picker, no template picker, no wizard.** A new page is a title and a text
   area. Categories are added by typing `[[Category:X]]` (the editor's right rail offers a
   chip input that does exactly that).
5. Search gains a "Create *<query>*" action when a query has no exact title match.
6. Red links point at the article URL (not `?redlink=1&action=edit`), because visiting the
   article URL is now the create flow. Keep `class="new red-link"` styling.

## O15 — Preview needs no account (local mode: SUPERSEDED by O17)

1. **`POST /api/preview` is public.** It renders submitted wikitext and returns HTML; it writes
   nothing, touches no cache, and is already size-capped (400 KB). Requiring auth made the
   editor's live preview fail with "The preview could not be rendered" on every fresh install,
   which is the bug this decision fixes. Keep the cap, keep `preview: true` semantics.
   **This half still stands.**
2. ~~**Local mode.**~~ **SUPERSEDED by O17.** O15 let a server without Firebase Admin
   credentials accept anonymous edits and admin actions as a synthetic `local` principal. That
   is gone: the code, the `WIKI_LOCAL_MODE` / `WIKI_LOCAL_USER` variables and the header badge
   were all removed. Editing has one rule now, and it is O17's.

## O17 — Editing always requires an account; the console is the Manager's (2026-09-08, by user)

1. **No anonymous write path.** Reading is public; every edit, upload and admin action requires
   a signed-in Firebase account, enforced by `requirePrincipal` (401 `auth-required`). This
   replaces O15's local mode, whose convenience ("a fresh clone is immediately editable") was
   not worth an unauthenticated write path that also had to be explained away in the UI.
   **Service-account credentials are OPTIONAL** (added 2026-09-08, by user): Firebase ID tokens
   are RS256 JWTs signed by Google, whose verification keys are published, and the project id is
   public — so the server authenticates callers with nothing secret
   (`src/lib/firebase/verify-token.ts`) and reaches Firestore over REST with the caller's own
   token (`src/lib/firebase/firestore-rest.ts`). Credentials, when present, add exactly two
   things and the code picks the stronger path per call
   (`src/lib/firebase/backend.ts` `usingAdminSdk()`):
   the session-revocation check — without it a signed-out, password-reset or Firebase-disabled
   account stays accepted until its token expires, at most an hour, though the wiki's own
   `banned` flag is re-read every request and is unaffected — and Firestore access that bypasses
   Security Rules, which the console's cross-user reads and its ban write would otherwise be
   subject to.
   **Verifying a token offline is not `jwtVerify` alone.** jose checks `exp`, `iss` and `aud`
   only when they are present or configured, so a token with no `exp`, a future `iat` or
   `auth_time`, an empty `sub`, or an ARRAY `aud` containing the project id all pass it. Each is
   an authentication bypass; each is closed explicitly and pinned by a test.
2. **Roles are the reference site's roles.** They live in Firestore `users/{uid}.roles` and are
   shared verbatim with High Quota HQ (github.com/lengeddev/highquotahq), which reads the same
   project. The stored identifiers are `admin`, `site-developer`, `moderator`, `verifier`,
   `modded-verifier`; `admin` **displays** as "Manager". Writing the display label into the
   store would lock out every existing manager over there, so the label lives only in
   `src/lib/roles.ts`, which is the single definition of ids, labels, order and colors.
3. **The admin console has its own gate**, stricter than `isAdmin`: `canAccessAdminPanel` — the
   `admin` role, or a username in `MANAGER_USERNAMES`. An `admin_grants` row makes someone an
   admin for the wiki's own moderation; it does not make them a manager. The rule is enforced in
   `authenticateManagerRequest` on all four `/api/admin/*` routes **and** in the client gate,
   because gating only the UI leaves the routes open.
4. **Bans identify by username, not uid.** The console autocompletes real accounts
   (`GET /api/admin/users`, a prefix search over `usernameLower`) and the ban route resolves the
   name server-side, refusing a name that matches no account — or more than one — rather than
   banning whichever came back first (the same "exactly one or refuse" rule sign-in uses).

## O16 — The editor owns tags, versions and pictures (2026-09-02, by user)

1. **Tags are categories, and they are picked the way GitHub picks labels.** There is still no
   separate tag table — membership is the `[[Category:X]]` tags in the body and nothing else
   (O13). What changes is the input: the editor's rail searches what already exists
   (`GET /api/categories`, with live member counts) and offers **“Create *X*”** as the last row
   when nothing matches. Reusing a tag and inventing one are the same gesture, one keystroke apart,
   which is what stops a wiki from growing `Moons`, `moon` and `Moon pages`.

2. **Any editor may register a game version — not just an admin.** High-quota players run every
   patch, and a page routinely needs a boundary at a version the registry has not caught up to.
   `POST /api/versions` therefore accepts any principal that may edit: the id is validated
   (`v62`, `v64.1`), the ordinal is derived from it, the row lands as `legacy`, and the call is
   idempotent. It is purely additive — nothing existing changes meaning. **Renaming, re-ordering,
   changing `default_version` and deleting stay admin-only** in `/api/admin/versions`, because
   those *do* change what existing pages mean.

3. **Writing for another version is an affordance, not a syntax lesson.** A page created against
   one version must stay writable for every other one — that is the whole point of version scoping
   (versioning.md O10), but until now it required hand-written `<versions>` markup. The editor now
   has a version-scope dialog: pick a version (adding one inline if it is missing), choose how far
   the text applies, and it writes the markup. The rail lists the versions a page already branches
   on, so an author can see the coverage and fill the gaps.

   *Amended 2026-09-03 (by user): the grammar this dialog writes became the tag-name form of
   versioning.md §2.1 — `<v70>`, `<v70+v80>`, `<v70+>` — so the dialog's three modes are those
   three shapes, and the `*` fallback it used to offer no longer exists to be written.*

4. **Recent changes shows one row per page and locale.** The feed answers "what changed", and ten
   saves to one article in an afternoon is one thing that changed. Only the newest revision of each
   (page, locale) appears; the page's own history is where every revision lives. "Hide minor edits"
   filters *inside* that choice, so a page whose newest edit was minor falls back to its newest
   substantive revision rather than vanishing from the feed.

5. **Pictures are uploaded from inside the editor.** `POST /api/media` already existed (decisions
   O6); what was missing was the way in. The editor's media dialog uploads a file or picks one
   already on the wiki, sets caption/layout/alignment/width, and writes the `[[File:…]]` call.
   `GET /api/media` lists uploads for that picker and is anonymous, because every file it names is
   already served anonymously.
