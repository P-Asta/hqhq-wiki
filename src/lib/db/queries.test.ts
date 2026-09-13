import { beforeEach, describe, expect, it } from "vitest";

import type { PageMeta, ParseResult } from "@/lib/wikitext/types";

import { createDb, type WikiDb } from "./client";
import {
  buildMatchQuery,
  categoryMembers,
  contributions,
  listCategoriesWithCounts,
  getDiffPair,
  getHistory,
  getPageSource,
  getPageView,
  listPages,
  outdatedTranslations,
  pageLanguages,
  recentChanges,
  search,
  searchSuggest,
  templateDependents,
  translationsOf,
  uncategorizedPages,
  versionCoverage,
  wantedPages,
  whatLinksHere,
} from "./queries";
import {
  DEFAULT_VERSION_KEY,
  cacheParsedHtml,
  createLanguage,
  createPage,
  saveEdit,
  seedLanguages,
  seedVersions,
  setSetting,
} from "./store";

const alice = { uid: "u-alice", displayName: "Alice" };
const bob = { uid: "u-bob", displayName: "Bob" };

function makeMeta(partial: Partial<PageMeta> = {}): PageMeta {
  return {
    categories: [],
    behaviorSwitches: new Set<string>(),
    toc: [],
    templatesUsed: [],
    linksTo: [],
    ifexistTargets: [],
    volatile: false,
    versionBoundaries: [],
    versionScoped: false,
    warnings: [],
    ...partial,
  };
}

function parsed(html: string, partial: Partial<PageMeta> = {}): ParseResult {
  const meta = makeMeta(partial);
  return { doc: { type: "document", children: [], meta }, html, meta, toc: meta.toc, refs: {} };
}

let db: WikiDb;
beforeEach(() => {
  db = createDb(":memory:");
  seedLanguages(db);
  createLanguage(db, { code: "ko", label: "Korean", nativeName: "한국어", status: "active" });
  seedVersions(db);
});

/* ------------------------------------------------------------------ */
/* 1. getPageView                                                      */
/* ------------------------------------------------------------------ */

describe("getPageView (db-schema §D pattern 1)", () => {
  it("serves cached HTML while the revision matches, and null once it is stale", () => {
    const created = createPage(db, {
      namespace: "main",
      locale: "en",
      title: "Gold bar",
      content: "gold",
      author: alice,
      parse: parsed("<p>gold</p>"),
    });

    const fresh = getPageView(db, { namespace: "main", slug: "gold-bar", locale: "en" });
    expect(fresh).toMatchObject({ kind: "page", html: "<p>gold</p>", cacheVersion: "*" });

    // Rev-id mismatch ⇒ treated as stale, so the cache self-heals.
    cacheParsedHtml(db, {
      pageId: created.pageId,
      locale: "en",
      version: "*",
      revId: created.revId + 99,
      html: "<p>stale</p>",
    });
    const stale = getPageView(db, { namespace: "main", slug: "gold-bar", locale: "en" });
    expect(stale).toMatchObject({ kind: "page", html: null });
  });

  it("falls back to the EN head and flags it", () => {
    createPage(db, {
      namespace: "main",
      locale: "en",
      title: "Gold bar",
      content: "gold",
      author: alice,
      parse: parsed("<p>gold</p>"),
    });
    const view = getPageView(db, { namespace: "main", slug: "gold-bar", locale: "ko" });
    expect(view).toMatchObject({ kind: "page", servedLocale: "en", fallbackFromEn: true });
  });

  it("prefers the requested locale when it has a head", () => {
    const created = createPage(db, {
      namespace: "main",
      locale: "en",
      title: "Gold bar",
      content: "gold",
      author: alice,
      parse: parsed("<p>gold</p>"),
    });
    saveEdit(db, {
      pageId: created.pageId,
      locale: "ko",
      title: "금괴",
      content: "금괴",
      parentRevId: null,
      author: alice,
      parse: parsed("<p>금괴</p>"),
    });
    const view = getPageView(db, { namespace: "main", slug: "gold-bar", locale: "ko" });
    expect(view).toMatchObject({ kind: "page", servedLocale: "ko", fallbackFromEn: false });
  });

  it("reports a missing page (red-link → create CTA)", () => {
    expect(getPageView(db, { namespace: "main", slug: "artifice", locale: "en" })).toEqual({
      kind: "missing",
      namespace: "main",
      slug: "artifice",
    });
  });

  it("follows a redirect one hop, carrying the fragment (A2), and stops on ?redirect=no", () => {
    createPage(db, {
      namespace: "main",
      locale: "en",
      title: "8-Titan",
      content: "#REDIRECT [[Titan#Moons]]",
      author: alice,
      parse: parsed("", {
        redirect: { target: { namespace: 0, pageName: "Titan", fragment: "Moons" } },
      }),
    });
    const hop = getPageView(db, { namespace: "main", slug: "8-titan", locale: "en" });
    expect(hop).toMatchObject({
      kind: "redirect",
      to: { namespace: "main", slug: "titan", fragment: "Moons" },
    });
    const noFollow = getPageView(db, {
      namespace: "main",
      slug: "8-titan",
      locale: "en",
      followRedirect: false,
    });
    expect(noFollow.kind).toBe("page");
  });

  it("keys the cache by selected version for scoped pages (versioning.md §4)", () => {
    const created = createPage(db, {
      namespace: "main",
      locale: "en",
      title: "Quota",
      content: "quota",
      author: alice,
      parse: parsed("<p>130</p>", { versionScoped: true, versionBoundaries: ["v50", "v62"] }),
    });
    // No "*" warm for scoped pages; the view renders per selection.
    const atDefault = getPageView(db, { namespace: "main", slug: "quota", locale: "en" });
    expect(atDefault).toMatchObject({
      kind: "page",
      versionScoped: true,
      versionBoundaries: ["v50", "v62"],
      cacheVersion: "v70", // site default_version
      html: null,
    });

    cacheParsedHtml(db, {
      pageId: created.pageId,
      locale: "en",
      version: "v50",
      revId: created.revId,
      html: "<p>130</p>",
    });
    const atV50 = getPageView(db, {
      namespace: "main",
      slug: "quota",
      locale: "en",
      version: "v50",
    });
    expect(atV50).toMatchObject({ cacheVersion: "v50", html: "<p>130</p>" });

    setSetting(db, DEFAULT_VERSION_KEY, "v62", alice.uid);
    const afterFlush = getPageView(db, { namespace: "main", slug: "quota", locale: "en" });
    expect(afterFlush).toMatchObject({ cacheVersion: "v62", html: null });
  });
});

describe("getPageSource / pageLanguages", () => {
  it("returns the head revision, and an explicit old revision on request", () => {
    const created = createPage(db, {
      namespace: "main",
      locale: "en",
      title: "Gold bar",
      content: "v1",
      author: alice,
      parse: parsed("<p>v1</p>"),
    });
    saveEdit(db, {
      pageId: created.pageId,
      locale: "en",
      title: "Gold bar",
      content: "v2",
      parentRevId: created.revId,
      author: alice,
      parse: parsed("<p>v2</p>"),
    });

    const head = getPageSource(db, { namespace: "main", slug: "gold-bar", locale: "en" });
    expect(head?.revision?.content).toBe("v2");
    expect(head?.isCurrent).toBe(true);

    const old = getPageSource(db, {
      namespace: "main",
      slug: "gold-bar",
      locale: "en",
      revId: created.revId,
    });
    expect(old?.revision?.content).toBe("v1");
    expect(old?.isCurrent).toBe(false);
  });

  it("lists the locales that have a head", () => {
    const created = createPage(db, {
      namespace: "main",
      locale: "en",
      title: "Gold bar",
      content: "v1",
      author: alice,
      parse: parsed("<p>v1</p>"),
    });
    saveEdit(db, {
      pageId: created.pageId,
      locale: "ko",
      title: "금괴",
      content: "금괴",
      parentRevId: null,
      author: alice,
      parse: parsed("<p>금괴</p>"),
    });
    expect(pageLanguages(db, created.pageId).map((r) => r.locale)).toEqual(["en", "ko"]);
    expect(translationsOf(db, created.pageId)).toEqual([{ locale: "ko", title: "금괴" }]);
  });
});

/* ------------------------------------------------------------------ */
/* 3–5. History, diff, recent changes                                  */
/* ------------------------------------------------------------------ */

describe("history, diff and recent changes", () => {
  function threeRevisions() {
    const created = createPage(db, {
      namespace: "main",
      locale: "en",
      title: "Gold bar",
      content: "v1",
      author: alice,
      parse: parsed("<p>v1</p>"),
    });
    const r2 = saveEdit(db, {
      pageId: created.pageId,
      locale: "en",
      title: "Gold bar",
      content: "v2 longer",
      parentRevId: created.revId,
      author: bob,
      isMinor: true,
      parse: parsed("<p>v2</p>"),
    });
    const r3 = saveEdit(db, {
      pageId: created.pageId,
      locale: "en",
      title: "Gold bar",
      content: "v3",
      parentRevId: r2.revId,
      author: alice,
      parse: parsed("<p>v3</p>"),
    });
    return { pageId: created.pageId, r1: created.revId, r2: r2.revId, r3: r3.revId };
  }

  it("paginates history newest-first with a keyset cursor and byte counts", () => {
    const { pageId, r1, r2, r3 } = threeRevisions();
    const first = getHistory(db, pageId, "en", { limit: 2 });
    expect(first.rows.map((r) => r.id)).toEqual([r3, r2]);
    expect(first.nextCursor).toBe(r2);
    expect(first.rows[1].bytes).toBe("v2 longer".length);

    const second = getHistory(db, pageId, "en", { limit: 2, cursor: first.nextCursor! });
    expect(second.rows.map((r) => r.id)).toEqual([r1]);
    expect(second.nextCursor).toBeNull();
  });

  it("diffs against the parent by default, and against an explicit base on request", () => {
    const { r1, r2, r3 } = threeRevisions();
    expect(getDiffPair(db, r3)?.base?.id).toBe(r2);
    expect(getDiffPair(db, r3, r1)?.base?.id).toBe(r1);
    expect(getDiffPair(db, r1)?.base).toBeNull(); // creation diffs against empty
    expect(getDiffPair(db, 9999)).toBeNull();
  });

  it("shows one row per page and locale — the newest edit only", () => {
    const { pageId, r1, r3 } = threeRevisions();
    const ko = saveEdit(db, {
      pageId,
      locale: "ko",
      title: "금괴",
      content: "금괴",
      parentRevId: null,
      author: alice,
      parse: parsed("<p>금괴</p>"),
    });
    const all = recentChanges(db);
    expect(all.rows[0]).toMatchObject({ revId: ko.revId, locale: "ko", slug: "gold-bar" });
    // gold-bar/en was saved three times (r1, the minor r2, r3); only r3 shows.
    expect(all.rows.map((r) => r.revId)).toEqual([ko.revId, r3]);

    // Locale is part of the identity: the KO head is its own row, not a
    // competitor for the EN one.
    expect(recentChanges(db, { locale: "ko" }).rows.map((r) => r.revId)).toEqual([ko.revId]);
    expect(recentChanges(db, { locale: "en" }).rows.map((r) => r.revId)).toEqual([r3]);

    // Hiding minor edits must not hide the page — it falls back to its newest
    // substantive revision.
    const minorHead = saveEdit(db, {
      pageId,
      locale: "en",
      title: "Gold bar",
      content: "v4",
      isMinor: true,
      parentRevId: r3,
      author: alice,
      parse: parsed("<p>v4</p>"),
    });
    expect(recentChanges(db).rows.map((r) => r.revId)).toEqual([minorHead.revId, ko.revId]);
    expect(recentChanges(db, { hideMinor: true }).rows.map((r) => r.revId)).toEqual([
      ko.revId,
      r3,
    ]);
    expect(r1).toBeLessThan(r3);
  });

  it("lists a user's contributions newest-first", () => {
    const { r1, r3 } = threeRevisions();
    const rows = contributions(db, alice.uid).rows;
    expect(rows.map((r) => r.revId)).toEqual([r3, r1]);
    expect(rows[0]).toMatchObject({ namespace: "main", slug: "gold-bar" });
  });
});

/* ------------------------------------------------------------------ */
/* 6–8. Wanted pages, backlinks, categories                            */
/* ------------------------------------------------------------------ */

describe("link-graph reports", () => {
  it("ranks wanted (red-link) targets by inbound page count", () => {
    createPage(db, {
      namespace: "main",
      locale: "en",
      title: "Titan",
      content: "t",
      author: alice,
      parse: parsed("<p>t</p>", { linksTo: ["0:Artifice", "0:Dine"] }),
    });
    createPage(db, {
      namespace: "main",
      locale: "en",
      title: "Rend",
      content: "r",
      author: alice,
      parse: parsed("<p>r</p>", { linksTo: ["0:Artifice", "0:Titan"] }),
    });
    const wanted = wantedPages(db);
    expect(wanted[0]).toEqual({ namespace: "main", slug: "artifice", refs: 2 });
    expect(wanted.map((w) => w.slug)).not.toContain("titan"); // exists ⇒ not wanted
  });

  it("reports backlinks, transclusions and redirects pointing at a title", () => {
    createPage(db, {
      namespace: "template",
      locale: "en",
      title: "Infobox moon",
      content: "tpl",
      author: alice,
      parse: parsed("<p>tpl</p>"),
    });
    createPage(db, {
      namespace: "main",
      locale: "en",
      title: "Titan",
      content: "t",
      author: alice,
      parse: parsed("<p>t</p>", {
        linksTo: ["10:Infobox_moon"],
        templatesUsed: ["10:Infobox_moon"],
      }),
    });
    createPage(db, {
      namespace: "main",
      locale: "en",
      title: "8-Titan",
      content: "#REDIRECT [[Titan]]",
      author: alice,
      parse: parsed("", { redirect: { target: { namespace: 0, pageName: "Titan" } } }),
    });

    const tpl = whatLinksHere(db, "template", "infobox-moon");
    expect(tpl.links.map((r) => r.slug)).toEqual(["titan"]);
    expect(tpl.transclusions.map((r) => r.slug)).toEqual(["titan"]);
    expect(templateDependents(db, "Infobox moon").map((r) => r.slug)).toEqual(["titan"]);

    const titan = whatLinksHere(db, "main", "titan");
    expect(titan.redirects.map((r) => r.slug)).toEqual(["8-titan"]);
    expect(titan.transclusions).toEqual([]);
  });

  it("splits category members from subcategories, ordered by sort key", () => {
    createPage(db, {
      namespace: "main",
      locale: "en",
      title: "Gold bar",
      content: "g",
      author: alice,
      parse: parsed("<p>g</p>", { categories: [{ name: "Scrap", sortKey: "B" }] }),
    });
    createPage(db, {
      namespace: "main",
      locale: "en",
      title: "Apparatus",
      content: "a",
      author: alice,
      parse: parsed("<p>a</p>", { categories: [{ name: "Scrap", sortKey: "A" }] }),
    });
    createPage(db, {
      namespace: "category",
      locale: "en",
      title: "Rare scrap",
      content: "c",
      author: alice,
      parse: parsed("<p>c</p>", { categories: [{ name: "Scrap", sortKey: null }] }),
    });

    const { members, subcategories } = categoryMembers(db, "scrap");
    expect(members.map((m) => m.slug)).toEqual(["apparatus", "gold-bar"]);
    expect(subcategories.map((m) => m.slug)).toEqual(["rare-scrap"]);
  });
});

/* ------------------------------------------------------------------ */
/* 8b. Category browsing (decisions-v2 O13)                            */
/* ------------------------------------------------------------------ */

describe("category browsing (decisions-v2 O13)", () => {
  /** Two categories with real membership; only `Scrap` gets a description page. */
  function seedCategoryCorpus() {
    createPage(db, {
      namespace: "category",
      locale: "en",
      title: "Scrap",
      content: "Everything you can sell.",
      author: alice,
      parse: parsed("<p>Everything you can sell.</p>"),
    });
    createPage(db, {
      namespace: "main",
      locale: "en",
      title: "Gold bar",
      content: "g",
      author: alice,
      parse: parsed("<p>g</p>", {
        categories: [
          { name: "Scrap", sortKey: null },
          { name: "High quota", sortKey: null },
        ],
      }),
    });
    createPage(db, {
      namespace: "main",
      locale: "en",
      title: "Apparatus",
      content: "a",
      author: alice,
      parse: parsed("<p>a</p>", { categories: [{ name: "Scrap", sortKey: null }] }),
    });
    createPage(db, {
      namespace: "category",
      locale: "en",
      title: "Rare scrap",
      content: "sub",
      author: alice,
      parse: parsed("<p>sub</p>", { categories: [{ name: "Scrap", sortKey: null }] }),
    });
  }

  it("counts members and subcategories per category, busiest first", () => {
    seedCategoryCorpus();
    const rows = listCategoriesWithCounts(db, "en");
    expect(rows.map((r) => r.slug)).toEqual(["scrap", "high-quota", "rare-scrap"]);

    const scrap = rows[0]!;
    expect(scrap).toMatchObject({
      slug: "scrap",
      members: 2,
      subcategories: 1,
      total: 3,
      hasPage: true,
      pageTitle: "Scrap",
    });
  });

  it("lists a category with no description page, and one with no members", () => {
    seedCategoryCorpus();
    const rows = listCategoriesWithCounts(db, "en");

    // Real membership, nobody wrote Category:High quota — still browsable.
    const highQuota = rows.find((r) => r.slug === "high-quota");
    expect(highQuota).toMatchObject({ total: 1, hasPage: false, pageTitle: null });

    // A written Category: page nobody has filed anything under still appears.
    const rare = rows.find((r) => r.slug === "rare-scrap");
    expect(rare).toMatchObject({ total: 0, hasPage: true, pageTitle: "Rare scrap" });
  });

  it("prefers the locale's category page title and falls back to EN", () => {
    seedCategoryCorpus();
    const scrap = getPageSource(db, { namespace: "category", slug: "scrap", locale: "en" })!;
    saveEdit(db, {
      pageId: scrap.page.id,
      locale: "ko",
      title: "스크랩",
      content: "팔 수 있는 모든 것.",
      parentRevId: null,
      author: alice,
      parse: parsed("<p>팔 수 있는 모든 것.</p>"),
    });

    expect(listCategoriesWithCounts(db, "ko")[0]?.pageTitle).toBe("스크랩");
    expect(listCategoriesWithCounts(db, "en")[0]?.pageTitle).toBe("Scrap");
  });

  it("reports article-namespace pages carrying no category at all", () => {
    seedCategoryCorpus();
    createPage(db, {
      namespace: "main",
      locale: "en",
      title: "Loose end",
      content: "l",
      author: alice,
      parse: parsed("<p>l</p>"),
    });

    const rows = uncategorizedPages(db, "en");
    expect(rows.map((r) => r.slug)).toEqual(["loose-end"]);
    expect(rows[0]?.title).toBe("Loose end");
    expect(uncategorizedPages(db, "en", 0)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 9. Search (FTS5 + decisions O7)                                     */
/* ------------------------------------------------------------------ */

describe("search (db-schema §D pattern 9, decisions O7)", () => {
  function seedSearchCorpus() {
    const gold = createPage(db, {
      namespace: "main",
      locale: "en",
      title: "Gold bar",
      content: "en",
      author: alice,
      parse: parsed("<p>A gold bar is valuable scrap.</p>"),
    });
    saveEdit(db, {
      pageId: gold.pageId,
      locale: "ko",
      title: "금괴",
      content: "ko",
      parentRevId: null,
      author: alice,
      parse: parsed("<p>금괴는 값진 scrap 입니다.</p>"),
    });
    const jetpack = createPage(db, {
      namespace: "main",
      locale: "en",
      title: "Jetpack",
      content: "en",
      author: alice,
      parse: parsed("<p>The jetpack is expensive scrap.</p>"),
    });
    return { gold: gold.pageId, jetpack: jetpack.pageId };
  }

  it("quotes every token so operators and punctuation stay literal", () => {
    expect(buildMatchQuery('gold bar')).toBe('"gold"* "bar"*');
    expect(buildMatchQuery('  OR  "quoted*  ')).toBe('"OR"* "quoted"*');
    expect(buildMatchQuery("   ")).toBe("");
  });

  it("returns no rows for an empty query", () => {
    seedSearchCorpus();
    expect(search(db, "   ", { locale: "en" })).toEqual([]);
  });

  it("ranks title matches above body matches and highlights the snippet", () => {
    seedSearchCorpus();
    const hits = search(db, "jetpack", { locale: "en" });
    expect(hits[0]).toMatchObject({ slug: "jetpack", locale: "en", fallbackFromEn: false });
    expect(hits[0].snippet).toContain("<mark>jetpack</mark>");
  });

  it("unions EN into a non-EN search, deduping by page and flagging EN-only hits (O7)", () => {
    const { gold, jetpack } = seedSearchCorpus();
    const hits = search(db, "scrap", { locale: "ko" });
    const byPage = new Map(hits.map((h) => [h.pageId, h]));

    expect(hits).toHaveLength(2); // one row per page, never one per locale
    expect(byPage.get(gold)).toMatchObject({ locale: "ko", fallbackFromEn: false });
    expect(byPage.get(jetpack)).toMatchObject({ locale: "en", fallbackFromEn: true });
  });

  it("can be restricted to the requested locale (no EN union)", () => {
    seedSearchCorpus();
    const hits = search(db, "scrap", { locale: "ko", enFallback: false });
    expect(hits.map((h) => h.locale)).toEqual(["ko"]);
  });

  it("survives hostile FTS input instead of throwing SQLITE_ERROR", () => {
    seedSearchCorpus();
    for (const q of ['-', '*', '"', 'NEAR(a b)', 'gold OR', 'a:b', '^gold', '(', 'scrap*']) {
      expect(() => search(db, q, { locale: "ko" })).not.toThrow();
      expect(() => searchSuggest(db, q, { locale: "en" })).not.toThrow();
    }
    expect(search(db, "scrap*", { locale: "en" }).map((h) => h.slug).sort()).toEqual([
      "gold-bar",
      "jetpack",
    ]);
  });

  it("suggests on titles only", () => {
    seedSearchCorpus();
    expect(searchSuggest(db, "jet", { locale: "en" }).map((r) => r.slug)).toEqual(["jetpack"]);
    // "valuable" appears in a body, never in a title.
    expect(searchSuggest(db, "valuable", { locale: "en" })).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 10. Outdated translations (decisions O4)                            */
/* ------------------------------------------------------------------ */

describe("outdatedTranslations (db-schema §D pattern 10)", () => {
  it("flags a translation once the EN head moves past its basis", () => {
    const created = createPage(db, {
      namespace: "main",
      locale: "en",
      title: "Gold bar",
      content: "v1",
      author: alice,
      parse: parsed("<p>v1</p>"),
    });
    const ko = saveEdit(db, {
      pageId: created.pageId,
      locale: "ko",
      title: "금괴",
      content: "번역",
      parentRevId: null,
      author: alice,
      parse: parsed("<p>번역</p>"),
    });
    expect(outdatedTranslations(db)).toEqual([]); // fresh

    const en2 = saveEdit(db, {
      pageId: created.pageId,
      locale: "en",
      title: "Gold bar",
      content: "v2",
      parentRevId: created.revId,
      author: alice,
      parse: parsed("<p>v2</p>"),
    });

    const rows = outdatedTranslations(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      slug: "gold-bar",
      locale: "ko",
      basedOnRev: created.revId,
      enCurrentRev: en2.revId,
    });
    expect(rows[0].basedOnRev).toBeLessThan(rows[0].enCurrentRev);
    expect(ko.revId).toBeGreaterThan(created.revId);

    // Per-page badge form.
    expect(outdatedTranslations(db, { pageId: created.pageId })).toHaveLength(1);
    expect(outdatedTranslations(db, { pageId: 999 })).toEqual([]);
  });

  it("reports a basis-less translation with basedOnRev null ('original' per O4)", () => {
    const created = createPage(db, {
      namespace: "main",
      locale: "ko",
      title: "회사",
      content: "원본",
      author: alice,
      translatedFromRevId: null,
      parse: parsed("<p>원본</p>"),
    });
    // No EN head yet ⇒ nothing to compare against, so nothing is reported.
    expect(outdatedTranslations(db)).toEqual([]);

    saveEdit(db, {
      pageId: created.pageId,
      locale: "en",
      title: "The Company",
      content: "en original",
      parentRevId: null,
      author: alice,
      parse: parsed("<p>en</p>"),
    });
    const rows = outdatedTranslations(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].basedOnRev).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Listings                                                            */
/* ------------------------------------------------------------------ */

describe("listings", () => {
  it("pages by namespace, keyset on slug", () => {
    for (const title of ["Artifice", "Dine", "Titan"]) {
      createPage(db, {
        namespace: "main",
        locale: "en",
        title,
        content: title,
        author: alice,
        parse: parsed(`<p>${title}</p>`),
      });
    }
    createPage(db, {
      namespace: "template",
      locale: "en",
      title: "Stub",
      content: "s",
      author: alice,
      parse: parsed("<p>s</p>"),
    });

    const first = listPages(db, { namespace: "main", limit: 2 });
    expect(first.rows.map((r) => r.slug)).toEqual(["artifice", "dine"]);
    expect(first.nextCursor).toBe("dine");
    expect(listPages(db, { namespace: "main", after: "dine" }).rows.map((r) => r.slug)).toEqual([
      "titan",
    ]);
    expect(listPages(db, { namespace: "template" }).rows.map((r) => r.slug)).toEqual(["stub"]);
  });

  it("reports version coverage per boundary (versioning.md §6)", () => {
    createPage(db, {
      namespace: "main",
      locale: "en",
      title: "Quota",
      content: "q",
      author: alice,
      parse: parsed("<p>q</p>", { versionScoped: true, versionBoundaries: ["v50", "v62"] }),
    });
    createPage(db, {
      namespace: "main",
      locale: "en",
      title: "Cruiser",
      content: "c",
      author: alice,
      parse: parsed("<p>c</p>", { versionScoped: true, versionBoundaries: ["v62"] }),
    });

    expect(versionCoverage(db).map((r) => `${r.version}:${r.slug}`)).toEqual([
      "v50:quota",
      "v62:cruiser",
      "v62:quota",
    ]);
    expect(versionCoverage(db, "v62").map((r) => r.slug)).toEqual(["cruiser", "quota"]);
  });
});
