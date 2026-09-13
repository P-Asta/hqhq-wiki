/**
 * Locale-optional URLs — the ONE owner of the app's URL scheme.
 *
 * Normative source: docs/engine/decisions-v2.md **O12**. English (the default
 * content and UI locale) is prefix-free; every other locale prefixes:
 *
 * | page    | English       | Korean           |
 * |---------|---------------|------------------|
 * | article | `/wiki/titan` | `/ko/wiki/titan` |
 * | edit    | `/edit/titan` | `/ko/edit/titan` |
 * | search  | `/search?q=`  | `/ko/search?q=`  |
 * | special | `/special/…`  | `/ko/special/…`  |
 * | home    | `/`           | `/ko`            |
 *
 * **Nothing outside this module may concatenate a locale into a URL.** Route
 * files, components, the engine wiring (`src/lib/wiki/context.ts`) and the
 * middleware all build their hrefs from the helpers here, so the scheme lives
 * in exactly one place.
 *
 * The module is universal (no `server-only`) and free of any database import:
 * client islands and `src/middleware.ts` both depend on it, and the middleware
 * runs on every request — it must never touch better-sqlite3. The set of
 * URL-addressable prefixes is therefore the *static* shipped-UI-locale list
 * from `src/lib/i18n/types`, not the runtime `languages` table (routes.md
 * "Locale prefixes").
 */

import { DEFAULT_LOCALE, UI_LOCALES } from "@/lib/i18n/types";
import { nsPrefix, parseTitle, type ParsedTitle, type StorableNamespace } from "@/lib/title";

/* ------------------------------------------------------------------ */
/* The locale set the URL scheme knows about                           */
/* ------------------------------------------------------------------ */

/** The locale that owns the prefix-free URL space (O12: English). */
export const DEFAULT_URL_LOCALE: string = DEFAULT_LOCALE;

/**
 * Prefixes a URL may legitimately carry — every shipped UI locale except the
 * default one. A content locale registered at runtime (`languages` table)
 * becomes URL-addressable only once it also ships a UI dictionary; until then
 * its links resolve into the English tree and 404 (O12 rule 2).
 */
export const URL_LOCALE_PREFIXES: readonly string[] = UI_LOCALES.filter(
  (code) => code !== DEFAULT_LOCALE,
);

/** Every locale a path may *name*, the default included (`/en/…` is legal input). */
export const KNOWN_URL_LOCALES: readonly string[] = [DEFAULT_URL_LOCALE, ...URL_LOCALE_PREFIXES];

function normalizeLocale(locale: string | null | undefined): string {
  return (locale ?? "").trim().toLowerCase();
}

/** Does `locale` render at prefix-free URLs? (Blank counts as the default.) */
export function isDefaultUrlLocale(locale: string | null | undefined): boolean {
  const code = normalizeLocale(locale);
  return code === "" || code === DEFAULT_URL_LOCALE;
}

/**
 * Request header the middleware stamps with the locale a URL addresses.
 *
 * `src/app/layout.tsx` renders `<html lang>` but sits ABOVE `[locale]`, so it
 * cannot read the route segment; this header is how the URL's locale reaches
 * it. Read it with `htmlLang()`, never raw — the value is only trustworthy
 * after validation (a client may send the header on a path the middleware
 * skips).
 */
export const LOCALE_HEADER = "x-wiki-locale";

/**
 * Is `locale` a segment the URL scheme actually addresses (O12 rule 2)?
 *
 * Only shipped-UI locales are: the middleware rewrites every other first
 * segment into the English tree, so `en` and `URL_LOCALE_PREFIXES` are the only
 * values that can legitimately arrive as `[locale]`. A content locale that is
 * registered in the `languages` table but ships no dictionary is NOT
 * URL-addressable (routes.md "Locale prefixes").
 */
export function isKnownUrlLocale(locale: string | null | undefined): boolean {
  return KNOWN_URL_LOCALES.includes(normalizeLocale(locale));
}

/** A header value → a locale safe to put in `<html lang>`; unknown ⇒ default. */
export function htmlLang(value: string | null | undefined): string {
  return isKnownUrlLocale(value) ? normalizeLocale(value) : DEFAULT_URL_LOCALE;
}

/* ------------------------------------------------------------------ */
/* Path normalization + parsing                                        */
/* ------------------------------------------------------------------ */

/** `""` → `"/"`, `"wiki/x"` → `"/wiki/x"`; anything else is left alone. */
function normalizePath(path: string | null | undefined): string {
  const raw = (path ?? "").trim();
  if (raw === "" || raw === "/") return "/";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function decodeSegment(segment: string): string {
  if (!segment.includes("%")) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export interface ParsedLocalePath {
  /** Locale the URL addresses — `DEFAULT_URL_LOCALE` when it carries no prefix. */
  locale: string;
  /** The path with its locale prefix removed; always starts with `/`. */
  path: string;
  /** Did the input actually carry a locale prefix? */
  prefixed: boolean;
}

/**
 * Split a pathname into `{ locale, path }` — the inverse of `localePath`.
 *
 * - `/ko/wiki/x` → `{ locale: "ko", path: "/wiki/x", prefixed: true }`
 * - `/wiki/x` → `{ locale: "en", path: "/wiki/x", prefixed: false }`
 * - `/ko` → `{ locale: "ko", path: "/", prefixed: true }`
 *
 * `locales` defaults to every known locale so `/en/…` parses too (the
 * middleware must recognize it in order to redirect it away); pass a narrower
 * list to control which prefixes count. A query string or fragment on the
 * input rides along on `path` untouched.
 */
export function parseLocalePath(
  pathname: string,
  locales: readonly string[] = KNOWN_URL_LOCALES,
): ParsedLocalePath {
  const path = normalizePath(pathname);
  const hashAt = path.indexOf("#");
  const queryAt = path.indexOf("?");
  const cut = Math.min(
    hashAt === -1 ? path.length : hashAt,
    queryAt === -1 ? path.length : queryAt,
  );
  const head = path.slice(0, cut);
  const tail = path.slice(cut);

  const segments = head.split("/").filter((segment) => segment !== "");
  const first = segments[0];
  if (first === undefined) return { locale: DEFAULT_URL_LOCALE, path, prefixed: false };

  const candidate = decodeSegment(first).toLowerCase();
  if (!locales.some((code) => code.toLowerCase() === candidate)) {
    return { locale: DEFAULT_URL_LOCALE, path, prefixed: false };
  }

  const rest = segments.slice(1).join("/");
  return {
    locale: candidate,
    path: `${rest === "" ? "/" : `/${rest}`}${tail}`,
    prefixed: true,
  };
}

/* ------------------------------------------------------------------ */
/* The scheme                                                          */
/* ------------------------------------------------------------------ */

/**
 * O12's rule in one function: `"/path"` for English, `"/{locale}/path"` for
 * every other locale.
 *
 * The input is normalized first — a leading slash is added when missing and an
 * existing locale prefix is stripped — so the helper is idempotent
 * (`localePath("ko", "/ko/wiki/x") === "/ko/wiki/x"`) and re-prefixing the
 * current pathname for another locale is one call (the whole locale switcher).
 */
export function localePath(locale: string, path: string = "/"): string {
  const { path: bare } = parseLocalePath(normalizePath(path));
  if (isDefaultUrlLocale(locale)) return bare;
  const code = normalizeLocale(locale);
  return bare === "/" ? `/${code}` : `/${code}${bare}`;
}

/** The wiki home: `/` for English, `/ko` for Korean. */
export function homeHref(locale: string): string {
  return localePath(locale, "/");
}

/* ------------------------------------------------------------------ */
/* Query strings (versioning.md §6 — `?v=`, `?rev=`, `?redirect=`)     */
/* ------------------------------------------------------------------ */

/**
 * Merge `params` into `path`'s query string, dropping the empty ones.
 * Params already on `path` survive (that is how a `?v=` selection rides along
 * an `?rev=` / `?redirect=no` view), and a `#fragment` stays at the end.
 */
export function withQuery(path: string, params: Record<string, string | undefined>): string {
  const hashAt = path.indexOf("#");
  const hash = hashAt === -1 ? "" : path.slice(hashAt);
  const base = hashAt === -1 ? path : path.slice(0, hashAt);
  const queryAt = base.indexOf("?");
  const pathname = queryAt === -1 ? base : base.slice(0, queryAt);
  const search = new URLSearchParams(queryAt === -1 ? "" : base.slice(queryAt + 1));

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") search.delete(key);
    else search.set(key, value);
  }

  const query = search.toString();
  return `${pathname}${query === "" ? "" : `?${query}`}${hash}`;
}

/* ------------------------------------------------------------------ */
/* Title-addressed pages (decisions O1: `$1` = nsPrefix + slug)        */
/* ------------------------------------------------------------------ */

/** `$1` of `articlePath`: `nsPrefix + encodeURIComponent(slug)` (O1). */
export function titlePathSegment(namespace: StorableNamespace, slug: string): string {
  return `${nsPrefix(namespace)}${encodeURIComponent(slug)}`;
}

export function articleHref(locale: string, namespace: StorableNamespace, slug: string): string {
  return localePath(locale, `/wiki/${titlePathSegment(namespace, slug)}`);
}

export function editHref(locale: string, namespace: StorableNamespace, slug: string): string {
  return localePath(locale, `/edit/${titlePathSegment(namespace, slug)}`);
}

export function historyHref(locale: string, namespace: StorableNamespace, slug: string): string {
  return localePath(locale, `/history/${titlePathSegment(namespace, slug)}`);
}

export function diffHref(locale: string, namespace: StorableNamespace, slug: string): string {
  return localePath(locale, `/diff/${titlePathSegment(namespace, slug)}`);
}

export function whatLinksHereHref(
  locale: string,
  namespace: StorableNamespace,
  slug: string,
): string {
  return specialHref(locale, `what-links-here/${titlePathSegment(namespace, slug)}`);
}

/**
 * A route that addresses a title through an already-built `$1` segment
 * (`nsPrefix + encoded slug`) rather than a (namespace, slug) pair — the
 * editor, the history list and the diff form all carry that segment around.
 */
export function titleRouteHref(
  locale: string,
  section: "wiki" | "edit" | "history" | "diff",
  titlePath: string,
): string {
  return localePath(locale, `/${section}/${titlePath}`);
}

/* ------------------------------------------------------------------ */
/* Fixed pages                                                         */
/* ------------------------------------------------------------------ */

/** `/search?q=…` — the GET target of every search form. */
export function searchHref(locale: string, query?: string): string {
  return withQuery(localePath(locale, "/search"), { q: query?.trim() });
}

/** `/special/<page>` — `page` may itself carry a catch-all tail. */
export function specialHref(locale: string, page: string): string {
  return localePath(locale, `/special/${page}`);
}

/* ------------------------------------------------------------------ */
/* Title string → path (decisions O1 round trip)                       */
/* ------------------------------------------------------------------ */

/**
 * Title (raw string or already-parsed) → its article URL under `locale`.
 * Unicode slug letters are percent-encoded; the namespace colon stays literal
 * (routes.md shows `template:infobox-moon`). Returns null for invalid titles
 * and for non-storable namespaces — they have no address.
 *
 * `pathToTitle` (src/lib/title.ts) is the inverse of the `$1` segment.
 */
export function titleToPath(title: string | ParsedTitle, locale: string): string | null {
  const parsed = typeof title === "string" ? parseTitle(title) : title;
  if (!parsed || !parsed.storable || parsed.nsName === null) return null;
  return articleHref(locale, parsed.nsName, parsed.slug);
}
