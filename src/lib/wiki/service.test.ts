import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDb, type WikiDb } from "@/lib/db/client";
import { pageLocales, parsedCache } from "@/lib/db/schema";
import {
  createLanguage,
  invalidatePageCache,
  seedLanguages,
  seedVersions,
} from "@/lib/db/store";

import { buildWikiConfig, buildWikiMessages } from "./context";
import {
  createPageWithParse,
  extractPlainText,
  renderPage,
  renderPreview,
  resolveVersion,
  rollbackWithParse,
  saveEditWithParse,
} from "./service";

vi.mock("server-only", () => ({}));

const alice = { uid: "u-alice", displayName: "Alice" };

function setup(): WikiDb {
  const db = createDb(":memory:");
  seedLanguages(db);
  createLanguage(db, {
    code: "ko",
    label: "Korean",
    nativeName: "한국어",
    status: "active",
  });
  seedVersions(db);
  return db;
}

function makePage(
  db: WikiDb,
  over: Partial<Parameters<typeof createPageWithParse>[0]> = {},
) {
  return createPageWithParse({
    db,
    namespace: "main",
    locale: "en",
    title: "Gold bar",
    content: "A '''gold bar''' is valuable scrap.",
    author: alice,
    ...over,
  });
}

function cacheRows(db: WikiDb, pageId: number) {
  return db.select().from(parsedCache).where(eq(parsedCache.pageId, pageId)).all();
}

/**
 * versioning.md §2.1: the tag NAME is the range. The first branch ends at the
 * newest REGISTERED version below the next branch's id — v60 in the seed
 * registry — rather than at "v62 minus one".
 */
const VERSIONED_SOURCE =
  "<v50+v60>The base quota is 130 credits.</v50+v60>" +
  "<v62+>The base quota is 180 credits.</v62+>";

let db: WikiDb;
beforeEach(() => {
  db = setup();
});

/* ------------------------------------------------------------------ */

describe("context — config and messages", () => {
  it("builds the per-locale articlePath of decisions O1 + O12", () => {
    // O12: English is prefix-free; every other locale prefixes.
    expect(buildWikiConfig("en").articlePath).toBe("/wiki/$1");
    // O14.6: a red link addresses the article, not a `?redlink=1` detour.
    expect(buildWikiConfig("en").redLinkPath).toBe("/wiki/$1");
    expect(buildWikiConfig("ko").articlePath).toBe("/ko/wiki/$1");
    expect(buildWikiConfig("ko").redLinkPath).toBe("/ko/wiki/$1");
    expect(buildWikiConfig("en").siteName).toBe("HQHQ Wiki");
  });

  it("maps the dictionary wikitext.* section onto WikiMessages (Addendum A3)", () => {
    const en = buildWikiMessages("en");
    expect(en.tocTitle).toBe("Contents");
    expect(en.citeErrorNoText("note")).toContain("note");
    expect(en.unknownVersion("v99")).toContain("v99");

    const ko = buildWikiMessages("ko");
    expect(ko.tocTitle).toBe("목차");
    expect(ko.unknownVersion("v99")).toContain("v99");
    expect(ko.tocTitle).not.toBe(en.tocTitle);
  });
});

describe("renderPage — a saved page", () => {
  it("renders the head revision and reports the page identity", () => {
    const created = makePage(db);
    const view = renderPage({ db, namespace: "main", slug: "gold-bar", locale: "en" });

    expect(view).not.toBeNull();
    expect(view?.html).toContain("<b>gold bar</b>");
    expect(view?.page).toMatchObject({
      id: created.pageId,
      namespace: "main",
      slug: "gold-bar",
      title: "Gold bar",
    });
    expect(view?.locale).toBe("en");
    expect(view?.usedLocale).toBe("en");
    expect(view?.fallbackFromEn).toBe(false);
    expect(view?.revision).toMatchObject({ id: created.revId, isCurrent: true });
    expect(view?.selectedVersion).toBe("v70");
    expect(view?.availableVersions.at(-1)?.id).toBe("v70");
  });

  it("returns null for a page that does not exist (red-link CTA)", () => {
    expect(renderPage({ db, namespace: "main", slug: "nope", locale: "en" })).toBeNull();
  });

  it("renders an older revision on demand, never from the cache", () => {
    const created = makePage(db);
    const second = saveEditWithParse({
      db,
      pageId: created.pageId,
      namespace: "main",
      locale: "en",
      title: "Gold bar",
      content: "Rewritten.",
      parentRevId: created.revId,
      author: alice,
    });

    const old = renderPage({
      db,
      namespace: "main",
      slug: "gold-bar",
      locale: "en",
      revId: created.revId,
    });
    expect(old?.html).toContain("gold bar");
    expect(old?.revision).toMatchObject({ id: created.revId, isCurrent: false });
    expect(old?.cached).toBe(false);
    expect(old?.meta).not.toBeNull();

    const head = renderPage({ db, namespace: "main", slug: "gold-bar", locale: "en" });
    expect(head?.html).toContain("Rewritten.");
    expect(head?.revision.id).toBe(second.revId);
  });
});

describe("renderPage — locale head with EN fallback (decisions O4)", () => {
  it("serves the EN head when the requested locale has none", () => {
    makePage(db);
    const view = renderPage({ db, namespace: "main", slug: "gold-bar", locale: "ko" });

    expect(view?.locale).toBe("ko");
    expect(view?.usedLocale).toBe("en");
    expect(view?.fallbackFromEn).toBe(true);
  });

  it("serves the locale head once it exists", () => {
    const created = makePage(db);
    saveEditWithParse({
      db,
      pageId: created.pageId,
      namespace: "main",
      locale: "ko",
      title: "금괴",
      content: "'''금괴'''는 값비싼 고철입니다.",
      parentRevId: null,
      author: alice,
    });

    const view = renderPage({ db, namespace: "main", slug: "gold-bar", locale: "ko" });
    expect(view?.usedLocale).toBe("ko");
    expect(view?.fallbackFromEn).toBe(false);
    expect(view?.page.title).toBe("금괴");
    expect(view?.html).toContain("금괴");
  });

  it("keys the fallback render on the served locale, so it cannot poison EN", () => {
    const created = makePage(db, { content: "See [[Apparatus]]." });
    invalidatePageCache(db, created.pageId);

    const view = renderPage({
      db,
      namespace: "main",
      slug: "gold-bar",
      locale: "ko",
      forceParse: true,
    });
    // Rendered with the served (EN) locale's articlePath — the cache row it
    // writes is the EN row, so it must carry EN hrefs, which O12 makes
    // prefix-free. Crucially NOT the `/ko/` form of the requested locale.
    expect(view?.html).toContain('href="/wiki/apparatus');
    expect(view?.html).not.toContain("/ko/wiki/apparatus");
    expect(cacheRows(db, created.pageId).map((r) => r.locale)).toEqual(["en"]);
  });
});

describe("renderPage — redirects (one hop, routes.md)", () => {
  function seedRedirect() {
    const target = makePage(db, { title: "Titan", content: "'''Titan''' is a moon." });
    const source = makePage(db, {
      title: "8-Titan",
      content: "#REDIRECT [[Titan]]",
    });
    return { target, source };
  }

  it("follows one hop and reports where it came from", () => {
    const { target } = seedRedirect();
    const view = renderPage({ db, namespace: "main", slug: "8-titan", locale: "en" });

    expect(view?.page.id).toBe(target.pageId);
    expect(view?.page.slug).toBe("titan");
    expect(view?.html).toContain("is a moon");
    expect(view?.redirectedFrom).toMatchObject({
      namespace: "main",
      slug: "8-titan",
      title: "8-Titan",
    });
  });

  it("stops at the redirect page for ?redirect=no", () => {
    const { source } = seedRedirect();
    const view = renderPage({
      db,
      namespace: "main",
      slug: "8-titan",
      locale: "en",
      followRedirect: false,
    });

    expect(view?.page.id).toBe(source.pageId);
    expect(view?.page.slug).toBe("8-titan");
    expect(view?.redirectedFrom).toBeUndefined();
    expect(view?.html).toContain("redirectMsg");
  });
});

describe("renderPage — parsed_cache (db-schema A5, versioning §4)", () => {
  it("serves the row the save warmed, and re-parses after invalidation", () => {
    const created = makePage(db);

    const hit = renderPage({ db, namespace: "main", slug: "gold-bar", locale: "en" });
    expect(hit?.cached).toBe(true);
    expect(hit?.meta).toBeNull(); // the cache stores HTML only
    expect(hit?.toc).toEqual([]);

    invalidatePageCache(db, created.pageId);
    const miss = renderPage({ db, namespace: "main", slug: "gold-bar", locale: "en" });
    expect(miss?.cached).toBe(false);
    expect(miss?.meta).not.toBeNull();
    expect(miss?.html).toBe(hit?.html);

    const again = renderPage({ db, namespace: "main", slug: "gold-bar", locale: "en" });
    expect(again?.cached).toBe(true);
  });

  it("re-parses when the cached row points at a stale revision (self-heal)", () => {
    const created = makePage(db);
    db.update(parsedCache)
      .set({ html: "<p>stale</p>", revId: created.revId - 1 })
      .where(eq(parsedCache.pageId, created.pageId))
      .run();

    const view = renderPage({ db, namespace: "main", slug: "gold-bar", locale: "en" });
    expect(view?.cached).toBe(false);
    expect(view?.html).not.toContain("stale");
    expect(cacheRows(db, created.pageId)[0]?.revId).toBe(created.revId);
  });

  it("never caches volatile output (CURRENT* / #ifexist)", () => {
    const created = makePage(db, { content: "Rendered in {{CURRENTYEAR}}." });
    expect(cacheRows(db, created.pageId)).toHaveLength(0);

    const view = renderPage({ db, namespace: "main", slug: "gold-bar", locale: "en" });
    expect(view?.meta?.volatile).toBe(true);
    expect(view?.cached).toBe(false);
    expect(cacheRows(db, created.pageId)).toHaveLength(0);
  });

  it("caches an unscoped page under '*' and a scoped page per version", () => {
    const plain = makePage(db);
    expect(cacheRows(db, plain.pageId).map((r) => r.version)).toEqual(["*"]);

    const scoped = makePage(db, { title: "Quota", content: VERSIONED_SOURCE });
    expect(cacheRows(db, scoped.pageId)).toHaveLength(0); // scoped pages render lazily

    renderPage({ db, namespace: "main", slug: "quota", locale: "en", version: "v50" });
    renderPage({ db, namespace: "main", slug: "quota", locale: "en", version: "v62" });
    expect(cacheRows(db, scoped.pageId).map((r) => r.version).sort()).toEqual(["v50", "v62"]);
  });

  it("falls back to the site default for an unknown ?v=", () => {
    makePage(db, { title: "Quota", content: VERSIONED_SOURCE });
    const view = renderPage({
      db,
      namespace: "main",
      slug: "quota",
      locale: "en",
      version: "v999",
    });
    expect(view?.selectedVersion).toBe("v70");
  });
});

describe("renderPage — version scoping (versioning.md §3)", () => {
  it("renders the same source differently at two versions", () => {
    makePage(db, { title: "Quota", content: VERSIONED_SOURCE });

    const older = renderPage({
      db,
      namespace: "main",
      slug: "quota",
      locale: "en",
      version: "v50",
    });
    const newer = renderPage({
      db,
      namespace: "main",
      slug: "quota",
      locale: "en",
      version: "v62",
    });

    expect(older?.selectedVersion).toBe("v50");
    expect(older?.html).toContain("130");
    expect(older?.html).not.toContain("180");
    expect(newer?.html).toContain("180");
    expect(newer?.html).not.toContain("130");

    expect(older?.versionScoped).toBe(true);
    expect(older?.versionBoundaries).toEqual(expect.arrayContaining(["v50", "v62"]));
  });

  it("snapshots scoping onto page_locales at save time", () => {
    const created = makePage(db, { title: "Quota", content: VERSIONED_SOURCE });
    const row = db
      .select()
      .from(pageLocales)
      .where(and(eq(pageLocales.pageId, created.pageId), eq(pageLocales.locale, "en")))
      .get();

    expect(row?.versionScoped).toBe(true);
    expect(JSON.parse(row?.versionBoundaries ?? "[]")).toEqual(
      expect.arrayContaining(["v50", "v62"]),
    );
  });
});

describe("renderPreview", () => {
  it("renders unsaved wikitext and touches nothing", () => {
    const created = makePage(db);
    const before = cacheRows(db, created.pageId);

    const preview = renderPreview({
      db,
      wikitext: "A ''draft'' with [[Gold bar]] and [[No such page]].",
      locale: "en",
      title: "Gold bar",
    });

    expect(preview.html).toContain("<i>draft</i>");
    expect(preview.meta.linksTo).toEqual(
      expect.arrayContaining(["0:Gold_bar", "0:No_such_page"]),
    );
    expect(cacheRows(db, created.pageId)).toEqual(before);
  });

  it("does not alter the stored page", () => {
    const created = makePage(db);
    renderPreview({ db, wikitext: "Something else entirely.", locale: "en", title: "Gold bar" });

    const view = renderPage({ db, namespace: "main", slug: "gold-bar", locale: "en" });
    expect(view?.html).toContain("gold bar");
    expect(view?.revision.id).toBe(created.revId);
  });
});

describe("save paths", () => {
  it("round-trips save → render for a version-scoped page", () => {
    const created = makePage(db, { title: "Quota", content: "Placeholder." });
    saveEditWithParse({
      db,
      pageId: created.pageId,
      namespace: "main",
      locale: "en",
      title: "Quota",
      content: VERSIONED_SOURCE,
      parentRevId: created.revId,
      author: alice,
    });

    const older = renderPage({
      db,
      namespace: "main",
      slug: "quota",
      locale: "en",
      version: "v50",
    });
    const newer = renderPage({
      db,
      namespace: "main",
      slug: "quota",
      locale: "en",
      version: "v70",
    });
    expect(older?.html).toContain("130");
    expect(newer?.html).toContain("180");
  });

  it("extracts links and categories version-independently (versioning.md §5)", () => {
    const saved = makePage(db, {
      title: "Quota",
      content: "[[Apparatus]]\n[[Category:Mechanics]]",
    });
    expect(saved.meta.linksTo).toContain("0:Apparatus");
    expect(saved.meta.categories.map((c) => c.name)).toContain("Mechanics");
  });

  it("rolls back through one version-agnostic parse", () => {
    const created = makePage(db);
    const second = saveEditWithParse({
      db,
      pageId: created.pageId,
      namespace: "main",
      locale: "en",
      title: "Gold bar",
      content: "Vandalism.",
      parentRevId: created.revId,
      author: alice,
    });

    const restored = rollbackWithParse({
      db,
      pageId: created.pageId,
      namespace: "main",
      pageName: "Gold bar",
      locale: "en",
      targetRevId: created.revId,
      actor: alice,
    });
    expect(restored.revId).toBeGreaterThan(second.revId);

    const view = renderPage({ db, namespace: "main", slug: "gold-bar", locale: "en" });
    expect(view?.html).toContain("<b>gold bar</b>");
  });
});

describe("small helpers", () => {
  it("resolveVersion prefers a registered id and falls back to the default", () => {
    const versions = {
      byId: { v50: { id: "v50", label: "v50", ordinal: 50000, status: "legacy" as const } },
      ordered: [{ id: "v50", label: "v50", ordinal: 50000, status: "legacy" as const }],
      defaultId: "v70",
    };
    expect(resolveVersion(versions, "v50")).toBe("v50");
    expect(resolveVersion(versions, "v99")).toBe("v70");
    expect(resolveVersion(versions, null)).toBe("v70");
  });

  it("extractPlainText flattens rendered HTML for search_docs.body", () => {
    expect(extractPlainText("<p>A <b>gold&nbsp;bar</b></p>")).toBe("A gold bar");
  });
});
