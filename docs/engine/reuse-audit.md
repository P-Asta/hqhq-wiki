> **HISTORICAL (decision O11, 2026-08-31):** this audit described salvaging files from the
> legacy repository. The clean-slate rebuild salvages NOTHING — every app-layer file is
> authored fresh. Keep this document only as a reference for externally-imposed contracts it
> records (Firebase project config keys, the stateless Bearer-token auth flow, the
> users/{uid} Firestore profile shape, Next 16 Windows gotchas). Its salvage/discard lists
> and its design-token section are void.

# Reuse Audit — HQHQ Wiki Engine Rewrite

Audit of the existing codebase (`C:/Users/pAsta/hqhq-wiki`) ahead of the ground-up engine
rewrite. The rewrite **keeps**: Next.js 16 + React 19 + Tailwind 4 + Firebase Auth + the
design language. It **replaces**: file-based storage (`src/lib/wiki`, `src/lib/admin-grants`
→ SQLite via better-sqlite3 + Drizzle), react-markdown (→ custom MediaWiki wikitext engine),
and most of `src/`.

Sources read in full: `design.md`, `.env.example`, `src/app/globals.css`,
`src/lib/firebase/*`, `src/lib/auth/*`, `src/lib/i18n/*`, `src/components/site-shell.tsx`,
`providers.tsx`, `auth-provider.tsx`, `next.config.ts`, both layouts; the rest of
`src/components` and `src/lib` skimmed.

---

## 1. Design tokens

Two sources exist and they are not identical:

- **`design.md`** — the aspirational Vercel-inspired spec (light-only palette, full
  typography/spacing/radius/elevation scales, brand mesh gradient, do's/don'ts).
- **`src/app/globals.css`** — the *shipped* token set: a semantic-name palette with a
  complete dark theme, bridged into Tailwind 4 utilities via `@theme inline`.

The shipped semantic names (`--surface`, `--line`, `--accent`, …) are what every salvageable
component consumes (`bg-surface`, `text-foreground`, `border-line`, `text-muted`,
`text-faint`, `bg-primary`, `text-accent`, `bg-accent-soft`, `text-danger`, …). **Keep these
exact names** or every salvaged component breaks. Dark mode is class-based (`.dark` on
`<html>`, set by next-themes) with `@custom-variant dark (&:where(.dark, .dark *));`.

### Distilled token set — ready to paste into the new `globals.css`

```css
@import "tailwindcss";

@custom-variant dark (&:where(.dark, .dark *));

/* Brand wordmark face (used only via .brand-type) — file: public/fonts/9systema.woff2 */
@font-face {
  font-family: "Systema";
  src: url("/fonts/9systema.woff2") format("woff2");
  font-style: normal;
  font-weight: 400;
  font-display: swap;
}

:root {
  /* ── Color: light (from globals.css, aligned with design.md palette) ── */
  --background: #fafafa;        /* design.md canvas-soft */
  --surface: #ffffff;           /* canvas */
  --surface-subtle: #f5f5f5;    /* canvas-soft-2 */
  --surface-strong: #ebebeb;
  --text: #171717;              /* ink */
  --text-muted: #4d4d4d;        /* body */
  --text-faint: #888888;        /* mute */
  --line: #ebebeb;              /* hairline */
  --line-strong: #a1a1a1;       /* hairline-strong */
  --primary: #171717;           /* ink CTA */
  --primary-hover: #333333;
  --primary-contrast: #ffffff;
  --accent: #0070f3;            /* link */
  --accent-hover: #0761d1;      /* link-deep */
  --accent-soft: #d3e5ff;       /* link-bg-soft */
  --accent-contrast: #ffffff;
  --danger: #ee0000;
  --danger-soft: #f7d4d6;
  --success: #0070f3;
  --warning: #ab570a;           /* warning-deep (used as text-safe warning) */
  --warning-soft: #ffefcf;
  --code: #f5f5f5;

  /* ── Elevation: stacked shadows + inset hairline (design.md L2 / L4) ── */
  --shadow:
    0 0 0 1px rgb(0 0 0 / 0.06),
    0 1px 1px rgb(0 0 0 / 0.02),
    0 2px 2px rgb(0 0 0 / 0.04);
  --shadow-large:
    0 0 0 1px rgb(0 0 0 / 0.07),
    0 2px 2px rgb(0 0 0 / 0.04),
    0 8px 16px -4px rgb(0 0 0 / 0.06);

  /* ── Radius scale (design.md `rounded`) ── */
  --radius-xs: 4px;
  --radius-sm: 6px;      /* base UI radius: inputs, nav buttons, menus */
  --radius-md: 8px;      /* cards (.surface) */
  --radius-lg: 12px;     /* elevated cards (.surface-elevated) */
  --radius-xl: 16px;
  --radius-pill: 100px;  /* marketing CTAs only */
  --radius-full: 9999px;

  /* ── Spacing scale (design.md, base unit 4px) ── */
  --space-xxs: 4px;  --space-xs: 8px;   --space-sm: 12px;  --space-md: 16px;
  --space-lg: 24px;  --space-xl: 32px;  --space-2xl: 40px; --space-3xl: 48px;
  --space-4xl: 64px; --space-5xl: 96px; --space-6xl: 128px; --space-section: 192px;

  /* ── Typography scale (design.md; weight ceiling 600, negative tracking) ── */
  --type-display-xl: 600 48px/48px var(--font-sans);   /* tracking -2.4px  */
  --type-display-lg: 600 32px/40px var(--font-sans);   /* tracking -1.28px */
  --type-display-md: 600 24px/32px var(--font-sans);   /* tracking -0.96px */
  --type-display-sm: 600 20px/28px var(--font-sans);   /* tracking -0.6px  */
  --type-body-lg: 400 18px/28px var(--font-sans);
  --type-body-md: 400 16px/24px var(--font-sans);
  --type-body-sm: 400 14px/20px var(--font-sans);      /* tracking -0.28px */
  --type-caption: 400 12px/16px var(--font-sans);
  --type-code: 400 13px/20px var(--font-mono);
}

.dark {
  --background: #0a0a0a;
  --surface: #111111;
  --surface-subtle: #171717;
  --surface-strong: #262626;
  --text: #ededed;
  --text-muted: #b5b5b5;
  --text-faint: #888888;
  --line: #2e2e2e;
  --line-strong: #666666;
  --primary: #ededed;           /* polarity flip: light CTA on dark */
  --primary-hover: #ffffff;
  --primary-contrast: #171717;
  --accent: #52a8ff;
  --accent-hover: #80bfff;
  --accent-soft: #102c4d;
  --accent-contrast: #08101b;
  --danger: #ff6166;
  --danger-soft: #421a1d;
  --success: #52a8ff;
  --warning: #f5a623;
  --warning-soft: #3d2b0b;
  --code: #090909;
  --shadow:
    0 0 0 1px rgb(255 255 255 / 0.09),
    0 1px 1px rgb(0 0 0 / 0.25),
    0 2px 2px rgb(0 0 0 / 0.35);
  --shadow-large:
    0 0 0 1px rgb(255 255 255 / 0.1),
    0 2px 2px rgb(0 0 0 / 0.3),
    0 8px 16px -4px rgb(0 0 0 / 0.45);
}

/* Bridge into Tailwind 4 utilities — names are load-bearing for salvaged components. */
@theme inline {
  --font-sans: var(--font-geist-sans);
  --font-mono: "SFMono-Regular", "Cascadia Code", "Liberation Mono", monospace;
  --color-background: var(--background);
  --color-surface: var(--surface);
  --color-surface-subtle: var(--surface-subtle);
  --color-surface-strong: var(--surface-strong);
  --color-foreground: var(--text);
  --color-muted: var(--text-muted);
  --color-faint: var(--text-faint);
  --color-line: var(--line);
  --color-line-strong: var(--line-strong);
  --color-primary: var(--primary);
  --color-primary-hover: var(--primary-hover);
  --color-primary-contrast: var(--primary-contrast);
  --color-accent: var(--accent);
  --color-accent-hover: var(--accent-hover);
  --color-accent-soft: var(--accent-soft);
  --color-accent-contrast: var(--accent-contrast);
  --color-danger: var(--danger);
  --color-danger-soft: var(--danger-soft);
  --color-success: var(--success);
  --color-warning: var(--warning);
  --color-code: var(--code);
}
```

### Base styles / utility classes to carry over verbatim from `src/app/globals.css`

- `* { border-color: var(--line); }`, `html` (min-width 320px, `scroll-padding-top: 6rem`,
  `color-scheme` light/dark toggling), `body` (Geist + `font-feature-settings: "ss01","ss02"`).
- `::selection` (accent bg), tap-highlight/touch-action resets, the global
  `button:active { transform: translateY(1px) }` press effect.
- `.brand-type` (Systema wordmark), `.container-shell` (`min(100% - 2rem, 1440px)` centered;
  `100% - 1.25rem` under 768px).
- `.focus-ring` (double box-shadow focus-visible ring — used by literally every interactive
  element), `.surface` / `.surface-flat` / `.surface-elevated` (card chrome),
  `.skeleton` + shimmer keyframes, `.soft-grid`.
- `.hero-mesh::before` — the six-stop radial mesh gradient (`#007cf0 #00dfd8 #7928ca
  #ff0080 #ff4d4d #f9cb28`, blur 56px, opacity .25 light / .32 dark). This is the only
  decorative color in the system; keep exactly.
- `.wiki-prose` — the entire article typography block (h2 hairline top-border, 76ch measure,
  square list markers, table/pre/img chrome). The new wikitext engine should emit HTML that
  this stylesheet already styles; adapt selectors only where the new engine's output differs
  (e.g. the `.wiki-version-tabs` overrides are tied to the old component).
- `prefers-reduced-motion` global kill-switch block.

Design-language rules worth restating for the rewrite (from `design.md`): weight 600 is the
display ceiling; sentence-case, often period-terminated headlines with aggressive negative
tracking; mono only for the technical layer (eyebrows, code, version labels); stacked
shadows + inset hairline, never a single heavy drop; the mesh gradient at hero scale only;
no sixth accent color.

---

## 2. Firebase wiring

### Env vars

| Var | Where used | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_FIREBASE_API_KEY` / `AUTH_DOMAIN` / `PROJECT_ID` / `STORAGE_BUCKET` / `MESSAGING_SENDER_ID` / `APP_ID` | `src/lib/firebase/client.ts` | **Optional overrides.** Hardcoded defaults for the production `highquotahq214` project are checked into `client.ts`; env values override for previews. |
| `FIREBASE_PROJECT_ID` | `src/lib/firebase/admin.ts` | Optional; must equal the client project id or admin init throws. Falls back to `NEXT_PUBLIC_FIREBASE_PROJECT_ID` then the hardcoded default. |
| `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY` | `admin.ts` | Set **both or neither** (enforced). Private key gets `\\n` → newline normalization. If both unset, falls back to Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`). |
| `WIKI_ADMIN_ROLES` | `src/lib/auth/server.ts` | Comma list of Firestore profile roles that grant bootstrap admin (`admin,site-developer,wiki-admin`). Missing/empty → fails closed (no bootstrap admins) without blocking normal users. |

### Client SDK init — `src/lib/firebase/client.ts` (copy verbatim)

`"use client"` module. Idempotent init guarded by `getApps()`, with a safety check that an
existing `[DEFAULT]` app targets the same project:

```ts
export function getFirebaseClientApp(): FirebaseApp {
  const defaultApp = getApps().find((app) => app.name === "[DEFAULT]");
  if (defaultApp) {
    if (defaultApp.options.projectId !== firebaseClientConfig.projectId) {
      throw new Error("The existing Firebase client app targets a different project than HQHQ Wiki.");
    }
    return defaultApp;
  }
  return initializeApp(firebaseClientConfig);
}
```

Exports `getFirebaseAuth()`, `getFirebaseFirestore()`, plus eager `auth` / `db` constants
consumed by `login-form.tsx`. Client Firestore is used only for account forms (username
lookup / profile creation); authorization always comes from the server response.

### Admin SDK + session verification — **Bearer ID token, no session cookie**

There is **no session cookie anywhere**. The model is stateless per-request verification:

1. `auth-provider.tsx` (client) obtains the Firebase ID token and calls
   `GET /api/auth/me` with `Authorization: Bearer <idToken>` (`src/lib/auth/client.ts`
   `fetchAuthPrincipal`).
2. `src/app/api/auth/me/route.ts` (`runtime = "nodejs"`, `dynamic = "force-dynamic"`,
   `Cache-Control: private, no-store`, `Vary: Authorization`) calls
   `getPrincipalForRequest(request)`.
3. `src/lib/auth/server.ts` verifies with revocation check:

```ts
decodedToken = await getFirebaseAdminAuth().verifyIdToken(token, true);
```

   then loads the Firestore profile `users/{uid}` via the Admin SDK and normalizes it into
   an `AuthPrincipal`.
4. **Fallback path (unusual, keep it):** if Admin credentials are missing/misconfigured
   (`FirebaseAdminConfigurationError` or credential-shaped errors), it falls back to
   `src/lib/firebase/user-auth.ts`, which verifies the JWT **manually in pure Node**
   (RS256 against Google's cached x509 certs from
   `googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com`, full
   `aud`/`iss`/`sub`/`exp`/`iat`/`auth_time` validation) and reads the user's own profile
   through the **Firestore REST API authorized by the user's own ID token** — so the app
   works with zero server credentials as long as Security Rules allow self-reads.

Admin app init — `src/lib/firebase/admin.ts` (copy verbatim): `"server-only"` module, named
secondary app `"hqhq-wiki-admin"`, `cert({projectId, clientEmail, privateKey})` or
`applicationDefault()`, typed `FirebaseAdminConfigurationError` (code
`FIREBASE_ADMIN_NOT_CONFIGURED`), and a client/server project-id consistency guard.

### Principal shape and authorization — `src/lib/auth/types.ts` (copy verbatim)

```ts
export interface AuthPrincipal {
  user: AuthUserSummary;      // uid, email, emailVerified, displayName, photoURL
  profile: AuthProfile;       // uid, username, usernameLower, profilePicture, banned
  roles: string[];            // from Firestore users/{uid}.roles
  isAdmin: boolean;           // server-computed, never client-supplied
}
```

`isAdmin = !banned && (hasBootstrapWikiAdminRole(roles) || adminGrantStore.hasActiveGrant(uid))`.
The grant store is the file-based `src/lib/admin-grants` service — in the rewrite this
becomes a SQLite table; `server.ts` needs only that one call site
(`getDefaultAdminGrantService().hasActiveGrant(...)` inside `createPrincipal`) swapped.
Route guard helpers to keep as-is: `authenticateRequest` (rejects banned/revoked/missing),
`authenticateAdminRequest`, `requireActivePrincipal`, `requireAdminPrincipal`, plus the
granular error taxonomy (`AuthRequestError` with status+code, `AuthBackendUnavailableError`
503, Firebase error-code → 401/403 mapping in `throwTokenVerificationError`).

### Auth provider component contract — `src/components/auth-provider.tsx` (copy verbatim)

- Subscribes to `onIdTokenChanged`; per-change it aborts any in-flight request
  (AbortController + generation counter), sets `loading`, fetches `/api/auth/me`.
- Retries only the `ACCOUNT_PROFILE_NOT_FOUND` race (Auth user exists before the
  registration form writes `users/{uid}`) with delays `[150, 300, 600]` ms.
- Verifies `principal.user.uid === nextUser.uid`.
- Context value: `{ loading, user, profile, roles, isAdmin, error, getIdToken(forceRefresh?),
  signOut }` via `useAuth()` (throws outside provider).
- Wrapped by `src/components/providers.tsx`:
  `<ThemeProvider attribute="class" defaultTheme="system" enableSystem
  disableTransitionOnChange><AuthProvider>…` (copy verbatim).

### Login flow — `src/components/login-form.tsx` (copy nearly verbatim)

Client-side only, no server round-trip for login itself:

- **Login:** identifier may be email or username; usernames resolve to email via a client
  Firestore query `where("usernameLower", "==", identifier.toLowerCase())` on `users`;
  then `signInWithEmailAndPassword`.
- **Register:** username validated against `/^[a-zA-Z0-9_.-]{3,24}$/`, uniqueness checked by
  the same query, `createUserWithEmailAndPassword`, then `setDoc(users/{uid}, { email,
  username, usernameLower, createdAt: "YYYY-MM-DD", roles: [] })`.
- **Reset:** `sendPasswordResetEmail`. On success `router.replace(safeReturnTo(returnTo))`
  (open-redirect-guarded `?returnTo=` param) + `router.refresh()`. Firebase error messages
  are masked behind a generic label.

### Copy-verbatim summary for this section

`src/lib/firebase/client.ts`, `src/lib/firebase/admin.ts`, `src/lib/firebase/user-auth.ts`
(+ its test), `src/lib/auth/types.ts`, `src/lib/auth/client.ts`, `src/lib/auth/server.ts`
(one call site swapped) (+ its test), `src/app/api/auth/me/route.ts`,
`src/components/auth-provider.tsx`, `src/components/providers.tsx`,
`src/components/login-form.tsx`, and the Firebase/env sections of `.env.example`.

---

## 3. i18n UI system

Two-layer design: a **closed set of UI dictionaries** (`en`, `ko`) and an **open set of
content locales** registered at runtime in `wiki-data/languages.json`. UI for any
non-dictionary locale falls back to English while page content renders in that locale.

### Files (`src/lib/i18n/` — copy all verbatim)

- **`config.ts`** — `SUPPORTED_LOCALES = ["en", "ko"]`; `type Locale = string` (deliberately
  open); `DEFAULT_LOCALE = "en"`; `LOCALE_LABELS`; `isSupportedLocale()` validates any
  BCP-47-ish tag via `Intl.getCanonicalLocales` + regex
  `^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$` (note: *supported* here means
  "syntactically valid locale", not "has a dictionary"); `normalizeLocale()`;
  `getAlternateLocale()` (ko↔en).
- **`dictionary.ts`** — the `Dictionary` interface: flat string leaves under 15 sections —
  `meta, common, navigation, home, version, wiki, search, login, editor, history, admin,
  moderation, status, errors, footer`. `DictionaryKey` is a template-literal union
  (`"section.item"`, fully type-checked). `formatMessage()` interpolates `{name}`
  placeholders; `createTranslator(dictionary)` returns `t(key, values?)` and **throws** on
  missing keys.
- **`dictionaries/en.ts` / `ko.ts`** — ~265 lines each, complete parallel coverage of the
  `Dictionary` interface. Both worth carrying over wholesale; keys cover exactly the
  surfaces the rewrite rebuilds (editor, history/rollback, admin, moderation/bans, errors).
- **`index.ts`** — `getDictionary(locale)`: exact match → base language
  (`locale.split("-")[0]`) → `en`. `getTranslator(locale)` convenience.

### Locale routing + fallback

- No middleware. `src/app/page.tsx` redirects `/` →
  `/${process.env.WIKI_DEFAULT_LOCALE || "en"}`.
- `src/app/[locale]/layout.tsx` (`dynamic = "force-dynamic"`):
  1. `isSupportedLocale(locale)` → `notFound()` for junk segments (any *valid* locale tag
     passes, not just en/ko).
  2. Looks the locale up in the language registry (currently
     `store.listLanguages()` from the file store; rewrite: SQLite `languages` table) —
     `notFound()` if unregistered.
  3. Renders `<div lang={locale} dir={activeLanguage.direction}>` wrapping `SiteShell`;
     UI strings come from `getDictionary(locale)` which silently falls back to `en` for
     community locales.
  4. `generateStaticParams()` returns en/ko (moot under force-dynamic).
- `generateMetadata` per-locale from `dictionary.meta`.

### `languages.json` registry — `wiki-data/languages.json`

Schema (rewrite this into a SQLite `languages` table with the same fields):

```json
{
  "schemaVersion": 1,
  "defaultLocale": "en",
  "languages": [
    {
      "locale": "en",              // canonical tag, primary key
      "label": "English",          // English name
      "nativeName": "English",     // autonym shown in the switcher
      "direction": "ltr",          // "ltr" | "rtl" — feeds the dir attribute
      "status": "active",
      "createdAt": "ISO-8601",
      "createdBy": { "uid": "...", "displayName": "..." },
      "updatedAt": "ISO-8601",     // optional
      "updatedBy": { "uid": "...", "displayName": "..." }  // optional
    }
  ],
  "updatedAt": "ISO-8601"
}
```

### Wart to fix in the rewrite

`src/lib/view-labels.ts` adapts `Dictionary` → per-view label prop objects but also
hardcodes ad-hoc ko/en strings via a local `pick(locale, ko, en)` helper (e.g. "번역 언어
관리" / "Manage translation languages"); `site-shell.tsx` similarly hardcodes
"만들기"/"Create". Carry the *pattern* (server resolves labels, client components take a
`labels` prop — keeps dictionaries out of the client bundle) but fold every `pick()` string
into the dictionaries proper.

---

## 4. Salvage list

### Copy nearly-verbatim (path → reason)

| File | Reason |
| --- | --- |
| `design.md` | The design-language contract; the rewrite keeps it. |
| `src/app/globals.css` | Complete shipped token set incl. dark theme; only `.wiki-prose`/`.wiki-version-tabs` selectors may need adapting to the new engine's HTML. |
| `src/lib/firebase/client.ts` | Idempotent client init + prod defaults; storage-agnostic. |
| `src/lib/firebase/admin.ts` | Admin init, cert/ADC fallback, config error taxonomy. |
| `src/lib/firebase/user-auth.ts` (+ `.test.ts`) | Credential-less JWT verification fallback; pure Node, no deps on storage. |
| `src/lib/auth/types.ts` | `AuthPrincipal` contract shared client/server. |
| `src/lib/auth/client.ts` | `/api/auth/me` fetcher + response validation. |
| `src/lib/auth/server.ts` (+ `.test.ts`) | Whole verification/guard pipeline; swap the single `admin-grants` call for a SQLite lookup. |
| `src/app/api/auth/me/route.ts` | Auth endpoint; storage-free. |
| `src/components/auth-provider.tsx` | Token-change subscription, abort/generation logic, retry-on-registration-race. |
| `src/components/providers.tsx` | next-themes + auth wrapper. |
| `src/components/login-form.tsx` | Full login/register/reset flow against Firebase; UI already on-token. |
| `src/components/site-shell.tsx` | Header/nav/search/theme/locale/account/footer shell; only its `categories`/`languages` props change source. |
| `src/components/ui/button.tsx` | Variant/size button + `ButtonLink`; token-native. |
| `src/components/ui/field.tsx` | `Label`/`Input`/`Textarea`/`Select`/`FieldMessage` primitives. |
| `src/components/ui/status-banner.tsx` | Tonal alert/status surface with a11y roles. |
| `src/components/empty-state.tsx` | Generic, token-native. |
| `src/lib/utils.ts` | `cn()` (clsx + tailwind-merge). |
| `src/lib/i18n/*` (all 5+ files) | Whole UI i18n system incl. both dictionaries. |
| `src/lib/view-labels.ts` | Keep the server-resolves-labels pattern; fold hardcoded `pick()` strings into dictionaries. |
| `src/app/layout.tsx` | Geist font wiring, metadata template, Providers mount. |
| `src/app/[locale]/layout.tsx` | Locale validation/fallback/skip-link/shell wiring; swap two store calls for SQLite queries. |
| `src/app/page.tsx`, `src/app/not-found.tsx`, `src/app/loading.tsx` | Trivial, token-native. |
| `src/lib/api-response.ts` | JSON-body cap + error→response mapping; re-point the `WikiError`/`AdminGrantError` branches at the new engine's error types. |
| `next.config.ts` | Next 16 config: security headers, `serverExternalPackages: ["firebase-admin"]`, turbopack root. |
| `postcss.config.mjs`, `eslint.config.mjs`, `tsconfig.json`, `vitest.config.ts` | Toolchain works as-is (add `better-sqlite3` to `serverExternalPackages` when introduced). |
| `.env.example` | Drop `WIKI_DATA_ROOT`, add SQLite path; keep the rest. |
| `public/fonts/9systema.woff2`, `public/high-quota-logo.png`, `public/lethal-company-logo.png` | Brand assets referenced by shell/layout/CSS. |

Borderline (reuse the skeleton, rewire the data): `src/components/table-of-contents.tsx`,
`profile-card.tsx`, `language-manager.tsx`, `rollback-button.tsx`, `history-view.tsx` —
presentation is on-token and worth keeping as scaffolding, but their prop shapes mirror the
file store's types.

### Discard (path → reason)

| File(s) | Reason |
| --- | --- |
| `src/lib/wiki/*` (store, io, paths, content, schemas, mutex, errors, types + tests) | The entire file-based storage engine — replaced by SQLite/Drizzle. `KeyedMutex` is unnecessary with synchronous better-sqlite3 transactions. |
| `src/lib/admin-grants/*` | File-based admin grant store → SQLite table. **Keep the semantics**: grants by uid, audit events, no self-revoke, banned users never admin. |
| `src/components/markdown-renderer.tsx` (+ test), `markdown.tsx`, `src/lib/markdown-headings.ts` | react-markdown/remark/rehype pipeline → custom wikitext engine. |
| `src/lib/wiki-document-frontmatter.ts`, `src/lib/wiki-version-tabs.ts`, `src/lib/presentation.ts` (+ tests) | Parsers for the old markdown-frontmatter document format. The *features* (infobox, per-version content tabs) become wikitext constructs (`{{infobox}}`-style templates / version tags). |
| `src/components/wiki-document/*` (info-box, version-tabs, outline, syntax-help, …) | Renderers for the old document format; concepts carry over, code is coupled to frontmatter syntax. |
| `src/components/wiki-article.tsx`, `wiki-editor.tsx`, `wiki-create.tsx`, `wiki-navigation.tsx`, `search-view.tsx`, `home-view.tsx`, `topic-*.tsx`, `version-index.tsx`, `admin-panel.tsx` | View layer bound to file-store API/data shapes and markdown editing; rebuild against the new schema (steal layout/classNames freely). |
| `src/app/api/{pages,search,categories,languages,admin}/**` (except `auth/me`) | Route handlers over the file store; rewrite on Drizzle. Keep their **error-body and auth-guard conventions**. |
| `src/app/[locale]/**` pages (except layout) | Thin wrappers over discarded views/store. |
| `wiki-data/**` content | Becomes a one-off migration input into SQLite (`categories.json`, `languages.json`, `versions/*/pages`, `audit/`), not runtime storage. |

---

## 5. Gotchas

- **Next 16 / Windows**: `next.config.ts` pins both `outputFileTracingRoot` and
  `turbopack.root` to `process.cwd()` — guards against Next's multi-lockfile root
  mis-inference on this machine. Keep both in the rewrite.
- **`serverExternalPackages: ["firebase-admin"]`** is required (admin SDK breaks when
  bundled). The rewrite must append `"better-sqlite3"` (native addon).
- **Security headers** (nosniff, DENY, referrer-policy, permissions-policy) are applied to
  `/(.*)` in `next.config.ts`, not middleware. `poweredByHeader: false`.
- **Yarn Classic 1.22** (`packageManager: "yarn@1.22.22"`), Node ≥ 20 (README). Every npm
  script invokes binaries as `node ./node_modules/<pkg>/...` instead of relying on `.bin`
  shims — a Windows/Yarn-classic PATH workaround. Keep the pattern.
- **`server-only`** guards every credential-touching module (`firebase/admin.ts`,
  `firebase/user-auth.ts`, `auth/server.ts`, `admin-grants/server.ts`, `api/auth/me`); a
  client import becomes a build error. Continue this for the SQLite layer.
- **No session cookie / no middleware**: auth is Bearer-token-per-request; SSR pages render
  *logged-out* HTML and the client hydrates account state via `/api/auth/me`. If the
  rewrite wants SSR-authenticated pages it must add Firebase session cookies — that is a
  deliberate architecture change, not a port.
- **Checked-in Firebase defaults**: `client.ts` hardcodes the production `highquotahq214`
  web config (public by design); env vars only override. Account compatibility with the
  existing High Quota HQ user base depends on keeping this project + the `users/{uid}`
  Firestore profile schema (`username`, `usernameLower`, `roles`, `banned`,
  `profilePicture`).
- **Two error-body shapes exist**: `/api/auth/me` returns `{ error: { code, message } }`
  (and `auth/client.ts` parses that), while `api-response.ts` returns
  `{ error: message, code }`. Unify in the rewrite — but if you keep `auth/client.ts`
  verbatim, `/api/auth/me`'s shape must not change.
- **Fonts**: sans is the `geist` npm package (`GeistSans.variable` on `<html>`; CSS var
  `--font-geist-sans`). **Geist Mono is not loaded** — `--font-mono` is a system stack,
  despite design.md naming Geist Mono. `Systema` (public/fonts) is wordmark-only via
  `.brand-type`. `font-feature-settings: "ss01","ss02"` on body is part of the look.
- **Theme**: next-themes class strategy + `suppressHydrationWarning` on `<html>`; Tailwind 4
  dark variant is redefined via `@custom-variant`; `html`/`html.dark` set `color-scheme`.
  Theme-dependent icons render both variants and toggle via `dark:` CSS (no JS flash).
- **Vitest**: `environment: "node"` (not jsdom) — existing tests are logic-level; component
  tests like `markdown-renderer.test.tsx` are written to work in node. Alias `@` → `./src`
  duplicated in `vitest.config.ts` (vitest does not read tsconfig paths). Coverage
  reporters configured but no coverage provider in devDependencies.
- **Locale segment accepts any valid BCP-47-ish tag** — the registry lookup in the locale
  layout is the real gate. `force-dynamic` on the locale layout means nothing is statically
  generated despite `generateStaticParams`.
- **`.env.example` quirk**: `WIKI_ADMIN_ROLES` empty → fails closed (no bootstrap admins,
  regular users fine); set-but-only-commas → throws. Roles compared case-insensitively.
- **Zod v4** and **ESLint 9 flat config** (`eslint.config.mjs` with
  `eslint-config-next/core-web-vitals` + `/typescript` spreads) are already in place.

---

## Addendum (critic)

From the pre-implementation completeness review (2026-08-31). Cross-references: `docs/engine/critique.md`.

- **Admin authority conflict → resolved in db-schema Addendum A1.** db-schema.md originally modeled admin as a `users.role` enum, contradicting this audit's "keep `auth/server.ts`, swap the one `hasActiveGrant` call" contract. Resolution: an `admin_grants` SQLite table (grant/revoke history, no self-revoke, banned-never-admin, audit rows), `users.role` dropped; `isAdmin` stays request-computed exactly as documented here.
- **`banned` has two homes.** Firestore `users/{uid}.banned` is read by the auth pipeline (authoritative for request authorization), while db-schema's SQLite `users.banned` duplicates it. Recommended stance: Firestore stays authoritative; the SQLite column is a moderation-view mirror, and any ban/unban admin action writes **both** (Firestore write + SQLite update + `audit_log` row). OPEN for lead confirmation — alternative is dropping the SQLite column (critique.md O5).
- **Edit-API auth path — verified fit.** The new mutation routes (pages / revisions / uploads / admin) reuse `authenticateRequest` / `authenticateAdminRequest` per-request Bearer verification exactly as `/api/auth/me` does: stateless, no cookie, compatible with `force-dynamic` SSR that renders logged-out HTML. The only new requirement is the users-mirror upsert (db-schema §D pattern 15) on each authenticated write so `revisions.author_uid` / `audit_log.actor_uid` FKs resolve.
