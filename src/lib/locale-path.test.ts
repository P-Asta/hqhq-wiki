/**
 * The URL scheme of decisions-v2 O12: English is prefix-free, every other
 * locale prefixes. These tests pin every helper in src/lib/locale-path.ts —
 * both locales, query preservation, degenerate paths, and already-prefixed
 * input — because the whole app builds its hrefs from them.
 */

import { describe, expect, it } from "vitest";

import {
  articleHref,
  diffHref,
  DEFAULT_URL_LOCALE,
  editHref,
  historyHref,
  homeHref,
  htmlLang,
  isDefaultUrlLocale,
  isKnownUrlLocale,
  KNOWN_URL_LOCALES,
  localePath,
  parseLocalePath,
  searchHref,
  specialHref,
  titlePathSegment,
  titleRouteHref,
  titleToPath,
  URL_LOCALE_PREFIXES,
  whatLinksHereHref,
  withQuery,
} from "./locale-path";

describe("the locale set (derived from src/lib/i18n, never from the db)", () => {
  it("English owns the prefix-free space", () => {
    expect(DEFAULT_URL_LOCALE).toBe("en");
    expect(URL_LOCALE_PREFIXES).not.toContain("en");
  });

  it("ships ko as the one prefixed UI locale today", () => {
    expect([...URL_LOCALE_PREFIXES]).toEqual(["ko"]);
    expect([...KNOWN_URL_LOCALES]).toEqual(["en", "ko"]);
  });

  it("isDefaultUrlLocale accepts the default, blanks and odd casing only", () => {
    expect(isDefaultUrlLocale("en")).toBe(true);
    expect(isDefaultUrlLocale("EN")).toBe(true);
    expect(isDefaultUrlLocale("")).toBe(true);
    expect(isDefaultUrlLocale(undefined)).toBe(true);
    expect(isDefaultUrlLocale("ko")).toBe(false);
  });
});

describe("localePath — the O12 rule", () => {
  it("leaves English paths prefix-free", () => {
    expect(localePath("en", "/wiki/titan")).toBe("/wiki/titan");
    expect(localePath("en", "/special/recent-changes")).toBe("/special/recent-changes");
  });

  it("prefixes every other locale", () => {
    expect(localePath("ko", "/wiki/titan")).toBe("/ko/wiki/titan");
    expect(localePath("ko", "/special/recent-changes")).toBe("/ko/special/recent-changes");
  });

  it("maps the empty path (and a bare slash) to the locale home", () => {
    expect(localePath("en", "")).toBe("/");
    expect(localePath("en", "/")).toBe("/");
    expect(localePath("en")).toBe("/");
    expect(localePath("ko", "")).toBe("/ko");
    expect(localePath("ko", "/")).toBe("/ko");
    expect(localePath("ko")).toBe("/ko");
  });

  it("adds the missing leading slash", () => {
    expect(localePath("en", "wiki/titan")).toBe("/wiki/titan");
    expect(localePath("ko", "wiki/titan")).toBe("/ko/wiki/titan");
  });

  it("is idempotent on already-prefixed input", () => {
    expect(localePath("ko", "/ko/wiki/titan")).toBe("/ko/wiki/titan");
    expect(localePath("ko", "/ko")).toBe("/ko");
    expect(localePath("en", "/wiki/titan")).toBe("/wiki/titan");
  });

  it("re-prefixes input that carries another locale (the switcher's job)", () => {
    expect(localePath("en", "/ko/wiki/titan")).toBe("/wiki/titan");
    expect(localePath("ko", "/en/wiki/titan")).toBe("/ko/wiki/titan");
    expect(localePath("en", "/ko")).toBe("/");
  });

  it("normalizes the locale code itself", () => {
    expect(localePath("KO", "/wiki/titan")).toBe("/ko/wiki/titan");
    expect(localePath("  ko  ", "/wiki/titan")).toBe("/ko/wiki/titan");
    expect(localePath("", "/wiki/titan")).toBe("/wiki/titan");
  });

  it("never mistakes a page slug for a locale prefix", () => {
    expect(localePath("en", "/wiki/ko")).toBe("/wiki/ko");
    expect(localePath("ko", "/wiki/en")).toBe("/ko/wiki/en");
  });

  it("carries a query string and fragment through untouched", () => {
    expect(localePath("ko", "/wiki/titan?v=v62")).toBe("/ko/wiki/titan?v=v62");
    expect(localePath("en", "/ko/wiki/titan?v=v62#life")).toBe("/wiki/titan?v=v62#life");
  });
});

describe("homeHref", () => {
  it("is the site root for English and the bare prefix elsewhere", () => {
    expect(homeHref("en")).toBe("/");
    expect(homeHref("ko")).toBe("/ko");
  });
});

describe("parseLocalePath — the inverse", () => {
  it("splits a prefixed path", () => {
    expect(parseLocalePath("/ko/wiki/titan")).toEqual({
      locale: "ko",
      path: "/wiki/titan",
      prefixed: true,
    });
  });

  it("reports English for a prefix-free path", () => {
    expect(parseLocalePath("/wiki/titan")).toEqual({
      locale: "en",
      path: "/wiki/titan",
      prefixed: false,
    });
  });

  it("recognizes the /en/ form so the middleware can redirect it away", () => {
    expect(parseLocalePath("/en/wiki/titan")).toEqual({
      locale: "en",
      path: "/wiki/titan",
      prefixed: true,
    });
  });

  it("reduces a bare prefix to the home path", () => {
    expect(parseLocalePath("/ko")).toEqual({ locale: "ko", path: "/", prefixed: true });
    expect(parseLocalePath("/ko/")).toEqual({ locale: "ko", path: "/", prefixed: true });
    expect(parseLocalePath("/")).toEqual({ locale: "en", path: "/", prefixed: false });
    expect(parseLocalePath("")).toEqual({ locale: "en", path: "/", prefixed: false });
  });

  it("leaves an unregistered prefix as an ordinary English path (O12 rule 2)", () => {
    expect(parseLocalePath("/xx/wiki/titan")).toEqual({
      locale: "en",
      path: "/xx/wiki/titan",
      prefixed: false,
    });
  });

  it("keeps the query and fragment on the stripped path", () => {
    expect(parseLocalePath("/ko/search?q=titan")).toEqual({
      locale: "ko",
      path: "/search?q=titan",
      prefixed: true,
    });
    expect(parseLocalePath("/ko/wiki/titan#life")).toEqual({
      locale: "ko",
      path: "/wiki/titan#life",
      prefixed: true,
    });
  });

  it("honors an explicit prefix list (a registry locale with no dictionary)", () => {
    expect(parseLocalePath("/fr/wiki/titan").prefixed).toBe(false);
    expect(parseLocalePath("/fr/wiki/titan", ["en", "ko", "fr"])).toEqual({
      locale: "fr",
      path: "/wiki/titan",
      prefixed: true,
    });
  });

  it("round-trips with localePath", () => {
    for (const pathname of ["/", "/wiki/titan", "/ko", "/ko/special/all-pages?ns=template"]) {
      const parsed = parseLocalePath(pathname);
      expect(localePath(parsed.locale, parsed.path)).toBe(pathname === "" ? "/" : pathname);
    }
  });
});

describe("withQuery", () => {
  it("appends params and drops the empty ones", () => {
    expect(withQuery("/wiki/titan", { v: "v62" })).toBe("/wiki/titan?v=v62");
    expect(withQuery("/wiki/titan", { v: undefined, rev: "" })).toBe("/wiki/titan");
    expect(withQuery("/wiki/titan", {})).toBe("/wiki/titan");
  });

  it("merges into a query the path already carries (versioning.md §6)", () => {
    expect(withQuery("/wiki/titan?rev=12", { v: "v62" })).toBe("/wiki/titan?rev=12&v=v62");
    expect(withQuery("/ko/wiki/titan?redirect=no", { v: "v50" })).toBe(
      "/ko/wiki/titan?redirect=no&v=v50",
    );
  });

  it("overwrites a param it is given and deletes an emptied one", () => {
    expect(withQuery("/wiki/titan?v=v50", { v: "v62" })).toBe("/wiki/titan?v=v62");
    expect(withQuery("/wiki/titan?v=v50", { v: undefined })).toBe("/wiki/titan");
  });

  it("keeps the fragment at the end", () => {
    expect(withQuery("/wiki/titan#life", { v: "v62" })).toBe("/wiki/titan?v=v62#life");
  });

  it("percent-encodes values", () => {
    expect(withQuery("/search", { q: "gold bar" })).toBe("/search?q=gold+bar");
  });
});

describe("title-addressed hrefs (decisions O1 `$1` = nsPrefix + slug)", () => {
  it("builds the `$1` segment with a literal ns colon and an encoded slug", () => {
    expect(titlePathSegment("main", "gold-bar")).toBe("gold-bar");
    expect(titlePathSegment("template", "infobox-moon")).toBe("template:infobox-moon");
    expect(titlePathSegment("main", "금괴")).toBe(encodeURIComponent("금괴"));
  });

  it("articleHref — both locales, every namespace", () => {
    expect(articleHref("en", "main", "titan")).toBe("/wiki/titan");
    expect(articleHref("ko", "main", "titan")).toBe("/ko/wiki/titan");
    expect(articleHref("en", "category", "moons")).toBe("/wiki/category:moons");
    expect(articleHref("ko", "template", "infobox-moon")).toBe("/ko/wiki/template:infobox-moon");
  });

  it("editHref / historyHref / diffHref — both locales", () => {
    expect(editHref("en", "main", "titan")).toBe("/edit/titan");
    expect(editHref("ko", "main", "titan")).toBe("/ko/edit/titan");
    expect(historyHref("en", "main", "titan")).toBe("/history/titan");
    expect(historyHref("ko", "category", "moons")).toBe("/ko/history/category:moons");
    expect(diffHref("en", "main", "titan")).toBe("/diff/titan");
    expect(diffHref("ko", "main", "titan")).toBe("/ko/diff/titan");
  });

  it("whatLinksHereHref lives under /special", () => {
    expect(whatLinksHereHref("en", "main", "titan")).toBe("/special/what-links-here/titan");
    expect(whatLinksHereHref("ko", "template", "infobox-moon")).toBe(
      "/ko/special/what-links-here/template:infobox-moon",
    );
  });

  it("titleRouteHref takes a pre-built `$1` segment", () => {
    expect(titleRouteHref("en", "wiki", "template:infobox-moon")).toBe(
      "/wiki/template:infobox-moon",
    );
    expect(titleRouteHref("ko", "diff", "titan")).toBe("/ko/diff/titan");
    expect(titleRouteHref("en", "history", "titan")).toBe("/history/titan");
    expect(titleRouteHref("ko", "edit", "titan")).toBe("/ko/edit/titan");
  });
});

describe("fixed pages", () => {
  it("searchHref — with and without a query", () => {
    expect(searchHref("en")).toBe("/search");
    expect(searchHref("ko")).toBe("/ko/search");
    expect(searchHref("en", "gold bar")).toBe("/search?q=gold+bar");
    expect(searchHref("ko", "  titan  ")).toBe("/ko/search?q=titan");
    expect(searchHref("en", "   ")).toBe("/search");
  });

  it("specialHref — plain pages and catch-all tails", () => {
    expect(specialHref("en", "recent-changes")).toBe("/special/recent-changes");
    expect(specialHref("ko", "recent-changes")).toBe("/ko/special/recent-changes");
    expect(specialHref("en", "what-links-here/titan")).toBe("/special/what-links-here/titan");
  });
});

describe("isKnownUrlLocale (which segments the URL scheme addresses)", () => {
  it("accepts the shipped UI locales only", () => {
    expect(isKnownUrlLocale("en")).toBe(true);
    expect(isKnownUrlLocale("ko")).toBe(true);
    expect(isKnownUrlLocale("KO")).toBe(true);
  });

  it("rejects everything a junk root segment could be", () => {
    // '/robots.txt' and '/favicon.ico' are skipped by the middleware and land
    // on [locale]; without this guard they rendered the home page with a 200.
    expect(isKnownUrlLocale("robots.txt")).toBe(false);
    expect(isKnownUrlLocale("favicon.ico")).toBe(false);
    expect(isKnownUrlLocale("ja")).toBe(false);
    expect(isKnownUrlLocale("")).toBe(false);
    expect(isKnownUrlLocale(null)).toBe(false);
  });
});

describe("htmlLang (the <html lang> the middleware header resolves to)", () => {
  it("accepts every URL-addressable locale, case-insensitively", () => {
    expect(htmlLang("en")).toBe("en");
    expect(htmlLang("ko")).toBe("ko");
    expect(htmlLang("KO")).toBe("ko");
    expect(htmlLang(" ko ")).toBe("ko");
  });

  it("falls back to the default for anything else", () => {
    // The header only reaches the layout on paths the middleware handled, but
    // a client may send it on a skipped one — never trust it unvalidated.
    expect(htmlLang(null)).toBe("en");
    expect(htmlLang(undefined)).toBe("en");
    expect(htmlLang("")).toBe("en");
    expect(htmlLang("robots.txt")).toBe("en");
    expect(htmlLang('" onload="alert(1)')).toBe("en");
  });
});

describe("titleToPath (title string → article URL)", () => {
  it("resolves a plain title in both locales", () => {
    expect(titleToPath("Gold bar", "en")).toBe("/wiki/gold-bar");
    expect(titleToPath("Gold bar", "ko")).toBe("/ko/wiki/gold-bar");
  });

  it("keeps the namespace colon literal and encodes unicode slugs", () => {
    expect(titleToPath("Template:Infobox moon", "ko")).toBe("/ko/wiki/template:infobox-moon");
    expect(titleToPath("금괴", "en")).toBe(`/wiki/${encodeURIComponent("금괴")}`);
  });

  it("returns null for titles with no address", () => {
    expect(titleToPath("Help:Editing", "en")).toBeNull();
    expect(titleToPath("", "en")).toBeNull();
  });
});
