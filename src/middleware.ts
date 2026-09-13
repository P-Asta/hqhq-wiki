/**
 * Locale-optional URL routing (decisions-v2 **O12**).
 *
 * The app tree stays `src/app/[locale]/**`; this middleware is the only thing
 * that knows English is prefix-free. Its whole decision is the pure function
 * `decideRoute` below (unit-tested in src/middleware.test.ts) — the handler
 * itself only turns a decision into a `NextResponse`, carrying the query
 * string and fragment through untouched so `?v=`, `?rev=` and `?redirect=no`
 * survive a rewrite or a redirect (versioning.md §6).
 *
 * | request | decision |
 * |---|---|
 * | `/`, `/wiki/x`, `/search` | rewrite to `/en/…` (internal, URL unchanged) |
 * | `/en`, `/en/wiki/x` | **308** to the prefix-free form — one canonical URL |
 * | `/ko`, `/ko/wiki/x` | pass through to `[locale]` |
 * | `/KO/wiki/x` | 308 to the lowercase `/ko/wiki/x` |
 * | `/xx/wiki/x` | rewrite to `/en/xx/wiki/x` — an ordinary path that 404s |
 * | `/api/*`, `/_next/*`, `/favicon.ico`, `/icon.svg` | skipped entirely |
 *
 * Cost: the registered-prefix list is `URL_LOCALE_PREFIXES`, a build-time
 * constant derived from `src/lib/i18n` (currently `en` + `ko`). The middleware
 * runs per request, so it must never open the SQLite `languages` table — a
 * content locale added at runtime becomes URL-addressable only once it also
 * ships a UI dictionary (routes.md "Locale prefixes").
 */

import { NextResponse, type NextRequest } from "next/server";

import {
  DEFAULT_URL_LOCALE,
  LOCALE_HEADER,
  parseLocalePath,
  URL_LOCALE_PREFIXES,
} from "@/lib/locale-path";

/** Paths that are not app routes at all: framework, API, and static assets. */
const SKIP_PREFIXES = ["/api/", "/_next/", "/.well-known/"] as const;
const SKIP_EXACT = new Set([
  "/api",
  "/_next",
  "/favicon.ico",
  "/robots.txt",
  "/sitemap.xml",
  "/manifest.json",
  "/manifest.webmanifest",
]);

const PREFIXED_LOCALES = new Set(URL_LOCALE_PREFIXES.map((code) => code.toLowerCase()));

export type RouteDecision =
  /** Not an app route (API, framework, static asset) — hands off untouched. */
  | { kind: "skip" }
  /** Already canonical for a prefixed locale — hands off to `[locale]`. */
  | { kind: "pass" }
  /** Prefix-free URL: served from the internal `/en` tree, address unchanged. */
  | { kind: "rewrite"; pathname: string }
  /** Non-canonical address (`/en/…`, wrong-case prefix) — one permanent hop. */
  | { kind: "redirect"; pathname: string; status: 308 };

/**
 * The whole routing rule of O12, as a pure function of the pathname.
 *
 * Query strings and fragments are not passed in: they never change the
 * decision, and the handler copies them onto whatever URL comes back.
 */
export function decideRoute(pathname: string): RouteDecision {
  const path = pathname === "" ? "/" : pathname;
  // Defensive: a pathname is always absolute; anything else is not ours.
  if (!path.startsWith("/")) return { kind: "skip" };

  if (SKIP_EXACT.has(path)) return { kind: "skip" };
  for (const prefix of SKIP_PREFIXES) {
    if (path.startsWith(prefix)) return { kind: "skip" };
  }

  const segments = path.split("/").filter((segment) => segment !== "");

  // A single root segment carrying a dot is a file out of the app directory
  // (`/icon.svg`, `/apple-icon.png`) — never a wiki route. Deeper paths keep
  // their dots: `/wiki/file:cruiser.png` and `/wiki/v1.2` are real titles.
  if (segments.length === 1 && segments[0].includes(".")) return { kind: "skip" };

  const first = segments[0];
  if (first !== undefined) {
    const code = decodeSegment(first).toLowerCase();

    // O12 rule 1: `/en/x` is never canonical — 308 to `/x`.
    if (code === DEFAULT_URL_LOCALE) {
      const rest = segments.slice(1).join("/");
      return { kind: "redirect", pathname: rest === "" ? "/" : `/${rest}`, status: 308 };
    }

    // O12 rule 2: a registered non-default prefix is honored as-is; a
    // differently-cased spelling of one gets a hop to the canonical casing.
    if (PREFIXED_LOCALES.has(code)) {
      if (first === code) return { kind: "pass" };
      return {
        kind: "redirect",
        pathname: `/${[code, ...segments.slice(1)].join("/")}`,
        status: 308,
      };
    }
  }

  // Everything else — including an unregistered `/xx/…` prefix — is an
  // ordinary English path. Unknown ones simply 404 in the app (O12 rule 2).
  return { kind: "rewrite", pathname: `/${DEFAULT_URL_LOCALE}${path === "/" ? "" : path}` };
}

function decodeSegment(segment: string): string {
  if (!segment.includes("%")) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const decision = decideRoute(pathname);

  if (decision.kind === "skip") return NextResponse.next();

  // The locale this URL addresses, stamped onto the forwarded request so the
  // ROOT layout can set `<html lang>` — it renders above `[locale]` and has no
  // access to the segment. `parseLocalePath` answers with the default locale
  // for a prefix-free path, which is exactly what the rewrite serves.
  const headers = new Headers(request.headers);
  headers.set(LOCALE_HEADER, parseLocalePath(pathname, URL_LOCALE_PREFIXES).locale);

  if (decision.kind === "pass") return NextResponse.next({ request: { headers } });

  // `clone()` keeps origin, search params and hash — the redirect/rewrite only
  // moves the pathname (versioning.md §6: `?v=` must survive navigation).
  const url = request.nextUrl.clone();
  url.pathname = decision.pathname;

  return decision.kind === "redirect"
    ? NextResponse.redirect(url, decision.status)
    : NextResponse.rewrite(url, { request: { headers } });
}

/**
 * `/api` and `/_next` never reach the handler; everything else does, and
 * `decideRoute` skips the remaining static assets. Two deliberate choices:
 * the exclusions are anchored (`api/` or exactly `api`, so a hypothetical
 * `/apiary` page still routes), and the matcher does NOT filter on "contains
 * a dot" — page titles may contain dots (`/wiki/file:cruiser.png`).
 */
export const config = {
  matcher: ["/((?!api(?:/|$)|_next(?:/|$)).*)"],
};
