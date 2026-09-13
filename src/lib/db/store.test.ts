import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { PageMeta, ParseResult } from "@/lib/wikitext/types";

import { createDb, type WikiDb } from "./client";
import {
  categoryLinks,
  pageLinks,
  pageLocales,
  pages,
  parsedCache,
  revisions,
  searchDocs,
  templateLinks,
  users,
} from "./schema";
import {
  DEFAULT_VERSION_KEY,
  EditConflictError,
  GrantMissingError,
  InvalidTitleError,
  LanguageMissingError,
  PageExistsError,
  SelfRevokeError,
  SEED_DEFAULT_VERSION,
  VersionInUseError,
  cacheParsedHtml,
  createLanguage,
  createPage,
  createPageStore,
  createVersion,
  deletePage,
  deleteVersion,
  findPage,
  getFileRecord,
  getSetting,
  grantAdmin,
  hasActiveGrant,
  htmlToPlainText,
  listGrants,
  listNavCategories,
  listVersions,
  loadVersionTable,
  parseTitleKey,
  revokeAdmin,
  rollback,
  saveEdit,
  seedLanguages,
  seedNavCategories,
  seedVersions,
  setLanguageStatus,
  setSetting,
  setUserBanned,
  titleKey,
  upsertFile,
  versionOrdinal,
  versionReferences,
} from "./store";

/* ------------------------------------------------------------------ */
/* Fixtures — the engine is stubbed: the store only consumes meta (A4) */
/* ------------------------------------------------------------------ */

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

function ftsCount(db: WikiDb, match: string): number {
  const row = db.$client
    .prepare("select count(*) as c from search_fts where search_fts match ?")
    .get(match) as { c: number };
  return row.c;
}

function newPage(db: WikiDb, over: Partial<Parameters<typeof createPage>[1]> = {}) {
  return createPage(db, {
    namespace: "main",
    locale: "en",
    title: "Gold bar",
    content: "A '''gold bar''' is valuable scrap.",
    author: alice,
    parse: parsed("<p>A <b>gold bar</b> is valuable scrap.</p>"),
    ...over,
  });
}

let db: WikiDb;
beforeEach(() => {
  db = setup();
});

/* ------------------------------------------------------------------ */

describe("title keys", () => {
  it("parses the numeric cache-key form (spec §14.10)", () => {
    const t = parseTitleKey("10:Infobox_moon");
    expect(t).toMatchObject({ namespace: 10, nsName: "template", slug: "infobox-moon" });
  });

  it("parses the prefixed-title form and is first-letter case-insensitive (O1)", () => {
    expect(parseTitleKey("Template:infobox moon")?.slug).toBe("infobox-moon");
    expect(parseTitleKey("Template:Infobox Moon")?.slug).toBe("infobox-moon");
  });

  it("marks non-storable namespaces (A7 / O2)", () => {
    expect(parseTitleKey("2:Alice")).toMatchObject({ storable: false, nsName: null });
  });

  it("round-trips titleKey()", () => {
    expect(titleKey({ namespace: 14, pageName: "Gold items" })).toBe("14:Gold_items");
    expect(parseTitleKey(titleKey({ namespace: 14, pageName: "Gold items" }))?.slug).toBe(
      "gold-items",
    );
  });
});

describe("saveEdit — transaction basics (db-schema §D2)", () => {
  it("creates a page, its head and its first revision", () => {
    const created = newPage(db);
    const page = db.select().from(pages).where(eq(pages.id, created.pageId)).get();
    expect(page?.slug).toBe("gold-bar");
    const pl = db
      .select()
      .from(pageLocales)
      .where(eq(pageLocales.pageId, created.pageId))
      .get();
    expect(pl?.currentRevId).toBe(created.revId);
    expect(pl?.title).toBe("Gold bar");
  });

  it("mirrors the author into users (§D pattern 15) and refreshes the display name", () => {
    newPage(db);
    saveEdit(db, {
      pageId: 1,
      locale: "en",
      title: "Gold bar",
      content: "v2",
      parentRevId: 1,
      author: { uid: alice.uid, displayName: "Alice Renamed" },
      parse: parsed("<p>v2</p>"),
    });
    const row = db.select().from(users).where(eq(users.uid, alice.uid)).get();
    expect(row?.displayName).toBe("Alice Renamed");
  });

  it("rejects a second page with the same (ns, slug)", () => {
    newPage(db);
    expect(() => newPage(db)).toThrow(PageExistsError);
  });

  it("rejects an unknown locale before touching anything", () => {
    const created = newPage(db);
    expect(() =>
      saveEdit(db, {
        pageId: created.pageId,
        locale: "xx",
        title: "Gold bar",
        content: "x",
        parentRevId: null,
        author: alice,
        parse: parsed("<p>x</p>"),
      }),
    ).toThrow(LanguageMissingError);
  });

  it("throws EditConflictError carrying the current head on a stale parentRevId", () => {
    const created = newPage(db);
    saveEdit(db, {
      pageId: created.pageId,
      locale: "en",
      title: "Gold bar",
      content: "v2",
      parentRevId: created.revId,
      author: bob,
      parse: parsed("<p>v2</p>"),
    });

    let caught: EditConflictError | null = null;
    try {
      saveEdit(db, {
        pageId: created.pageId,
        locale: "en",
        title: "Gold bar",
        content: "v3 from a stale editor",
        parentRevId: created.revId, // stale
        author: alice,
        parse: parsed("<p>v3</p>"),
      });
    } catch (err) {
      caught = err as EditConflictError;
    }
    expect(caught).toBeInstanceOf(EditConflictError);
    expect(caught?.currentRevId).toBe(created.revId + 1);
    expect(caught?.status).toBe(409);
    expect(caught?.code).toBe("edit-conflict");
    // The conflicting revision was rolled back with the transaction.
    expect(db.select().from(revisions).all()).toHaveLength(2);
  });
});

describe("saveEdit — link graph and search from meta (Addendum A4)", () => {
  it("fills page_links from meta.linksTo, deduped, skipping non-storable ns (A7)", () => {
    const created = newPage(db, {
      parse: parsed("<p>x</p>", {
        linksTo: ["0:Titan", "0:titan", "10:Stub", "2:Alice", "12:Help_me"],
      }),
    });
    const rows = db
      .select()
      .from(pageLinks)
      .where(eq(pageLinks.fromPageId, created.pageId))
      .all();
    expect(rows.map((r) => `${r.toNamespace}:${r.toSlug}`).sort()).toEqual([
      "main:titan",
      "template:stub",
    ]);
  });

  it("fills template_links from meta.templatesUsed (transitive per A4)", () => {
    const created = newPage(db, {
      parse: parsed("<p>x</p>", {
        // Infobox moon transcludes Stub: A4 says both appear, transitively.
        templatesUsed: ["10:Infobox_moon", "10:Stub", "0:Main_page"],
      }),
    });
    const rows = db
      .select()
      .from(templateLinks)
      .where(eq(templateLinks.fromPageId, created.pageId))
      .all();
    expect(rows.map((r) => r.templateSlug).sort()).toEqual(["infobox-moon", "stub"]);
  });

  it("replaces (not appends) links on re-save", () => {
    const created = newPage(db, {
      parse: parsed("<p>x</p>", { linksTo: ["0:Titan", "0:Artifice"] }),
    });
    saveEdit(db, {
      pageId: created.pageId,
      locale: "en",
      title: "Gold bar",
      content: "v2",
      parentRevId: created.revId,
      author: alice,
      parse: parsed("<p>v2</p>", { linksTo: ["0:Artifice"] }),
    });
    const rows = db.select().from(pageLinks).all();
    expect(rows.map((r) => r.toSlug)).toEqual(["artifice"]);
  });

  it("records categories from the EN save only, slugified per O1", () => {
    const created = newPage(db, {
      parse: parsed("<p>x</p>", {
        categories: [
          { name: "Gold items", sortKey: "Bar" },
          { name: "Scrap", sortKey: null },
        ],
      }),
    });
    // A KO translation carrying different categories must not change membership.
    saveEdit(db, {
      pageId: created.pageId,
      locale: "ko",
      title: "금괴",
      content: "금괴",
      parentRevId: null,
      author: alice,
      parse: parsed("<p>금괴</p>", { categories: [{ name: "Korean only", sortKey: null }] }),
    });
    const rows = db.select().from(categoryLinks).all();
    expect(rows.map((r) => `${r.categorySlug}|${r.sortKey}`).sort()).toEqual([
      "gold-items|Bar",
      "scrap|",
    ]);
  });

  it("denormalizes the redirect target with its fragment (A2) from the EN save", () => {
    const created = newPage(db, {
      title: "8-Titan",
      content: "#REDIRECT [[Titan#Moons]]",
      parse: parsed("", {
        redirect: { target: { namespace: 0, pageName: "Titan", fragment: "Moons" } },
      }),
    });
    const page = db.select().from(pages).where(eq(pages.id, created.pageId)).get();
    expect(page).toMatchObject({
      redirectNs: "main",
      redirectSlug: "titan",
      redirectFragment: "Moons",
    });
  });

  it("clears the redirect when the page stops being one", () => {
    const created = newPage(db, {
      title: "8-Titan",
      content: "#REDIRECT [[Titan]]",
      parse: parsed("", { redirect: { target: { namespace: 0, pageName: "Titan" } } }),
    });
    saveEdit(db, {
      pageId: created.pageId,
      locale: "en",
      title: "8-Titan",
      content: "Real article now.",
      parentRevId: created.revId,
      author: alice,
      parse: parsed("<p>Real article now.</p>"),
    });
    const page = db.select().from(pages).where(eq(pages.id, created.pageId)).get();
    expect(page?.redirectSlug).toBeNull();
    expect(page?.redirectFragment).toBeNull();
  });

  it("writes search_docs so the row is findable through FTS MATCH", () => {
    newPage(db, {
      parse: parsed("<p>A <b>gold bar</b> is valuable <i>scrap</i>.</p>"),
    });
    const doc = db.select().from(searchDocs).get();
    expect(doc?.body).toBe("A gold bar is valuable scrap .");
    expect(ftsCount(db, '"scrap"*')).toBe(1);
    expect(ftsCount(db, '"jetpack"*')).toBe(0);
  });

  it("keeps FTS in step when the body changes", () => {
    const created = newPage(db);
    saveEdit(db, {
      pageId: created.pageId,
      locale: "en",
      title: "Gold bar",
      content: "now about jetpacks",
      parentRevId: created.revId,
      author: alice,
      parse: parsed("<p>now about jetpacks</p>"),
    });
    expect(ftsCount(db, '"scrap"*')).toBe(0);
    expect(ftsCount(db, '"jetpack"*')).toBe(1);
  });

  it("flattens rendered HTML for the search body", () => {
    expect(htmlToPlainText('<p>a &amp; <b>b</b><script>x=1</script></p>')).toBe("a & b");
  });
});

describe("saveEdit — render cache (Addenda A3/A5, versioning.md §4)", () => {
  it("warms parsed_cache under '*' for a non-volatile, unscoped page", () => {
    const created = newPage(db);
    expect(created.cached).toBe(true);
    const row = db.select().from(parsedCache).get();
    expect(row).toMatchObject({ version: "*", revId: created.revId });
  });

  it("skips the cache for volatile output (A5)", () => {
    const created = newPage(db, {
      parse: parsed("<p>{{CURRENTDAY}}</p>", { volatile: true }),
    });
    expect(created.cached).toBe(false);
    expect(db.select().from(parsedCache).all()).toHaveLength(0);
  });

  it("persists versionScoped + boundaries and does not warm '*' for scoped pages", () => {
    const created = newPage(db, {
      parse: parsed("<p>130</p>", {
        versionScoped: true,
        versionBoundaries: ["v50", "v62"],
      }),
    });
    const pl = db.select().from(pageLocales).where(eq(pageLocales.id, created.pageLocaleId)).get();
    expect(pl?.versionScoped).toBe(true);
    expect(JSON.parse(pl?.versionBoundaries ?? "[]")).toEqual(["v50", "v62"]);
    expect(db.select().from(parsedCache).all()).toHaveLength(0);
  });

  it("drops ALL version rows of the edited page (versioning.md §4)", () => {
    const created = newPage(db, {
      parse: parsed("<p>130</p>", { versionScoped: true, versionBoundaries: ["v50", "v62"] }),
    });
    for (const version of ["v50", "v62", "v70"]) {
      cacheParsedHtml(db, {
        pageId: created.pageId,
        locale: "en",
        version,
        revId: created.revId,
        html: `<p>${version}</p>`,
      });
    }
    expect(db.select().from(parsedCache).all()).toHaveLength(3);

    saveEdit(db, {
      pageId: created.pageId,
      locale: "en",
      title: "Gold bar",
      content: "v2",
      parentRevId: created.revId,
      author: alice,
      parse: parsed("<p>v2</p>", { versionScoped: true, versionBoundaries: ["v50"] }),
    });
    expect(db.select().from(parsedCache).all()).toHaveLength(0);
  });

  it("invalidates transcluders — including transitive ones — on a template edit (#12 + A4)", () => {
    // Article transcludes Infobox moon, which itself transcludes Stub; A4
    // makes both appear in meta.templatesUsed, so template_links has both.
    const article = newPage(db, {
      title: "Titan",
      parse: parsed("<p>Titan</p>", { templatesUsed: ["10:Infobox_moon", "10:Stub"] }),
    });
    const stub = createPage(db, {
      namespace: "template",
      locale: "en",
      title: "Stub",
      content: "This article is a stub.",
      author: alice,
      parse: parsed("<p>stub</p>"),
    });
    // The article's cache survived the template *creation* only where it does
    // not link to it; re-warm it explicitly, then edit the template.
    cacheParsedHtml(db, {
      pageId: article.pageId,
      locale: "en",
      version: "*",
      revId: article.revId,
      html: "<p>cached</p>",
    });

    saveEdit(db, {
      pageId: stub.pageId,
      locale: "en",
      title: "Stub",
      content: "This page is a stub.",
      parentRevId: stub.revId,
      author: alice,
      parse: parsed("<p>stub v2</p>"),
    });

    const remaining = db
      .select()
      .from(parsedCache)
      .where(eq(parsedCache.pageId, article.pageId))
      .all();
    expect(remaining).toHaveLength(0);
  });

  it("invalidates red-linking pages when the target is created (A3)", () => {
    const article = newPage(db, {
      title: "Titan",
      parse: parsed("<p>Titan</p>", { linksTo: ["0:Artifice"] }),
    });
    expect(
      db.select().from(parsedCache).where(eq(parsedCache.pageId, article.pageId)).all(),
    ).toHaveLength(1);

    createPage(db, {
      namespace: "main",
      locale: "en",
      title: "Artifice",
      content: "Artifice is a moon.",
      author: alice,
      parse: parsed("<p>Artifice is a moon.</p>"),
    });

    expect(
      db.select().from(parsedCache).where(eq(parsedCache.pageId, article.pageId)).all(),
    ).toHaveLength(0);
  });
});

describe("translations (decisions O4)", () => {
  it("derives the EN basis for a translation when none is supplied", () => {
    const created = newPage(db);
    const ko = saveEdit(db, {
      pageId: created.pageId,
      locale: "ko",
      title: "금괴",
      content: "금괴는 값진 고철입니다.",
      parentRevId: null,
      author: alice,
      parse: parsed("<p>금괴</p>"),
    });
    const rev = db.select().from(revisions).where(eq(revisions.id, ko.revId)).get();
    expect(rev?.translatedFromRevId).toBe(created.revId);
  });

  it("keeps an explicit null basis (KO-first page ⇒ 'original', not outdated)", () => {
    const created = createPage(db, {
      namespace: "main",
      locale: "ko",
      title: "회사",
      content: "회사 이야기",
      author: alice,
      translatedFromRevId: null,
      parse: parsed("<p>회사</p>"),
    });
    const rev = db.select().from(revisions).where(eq(revisions.id, created.revId)).get();
    expect(rev?.translatedFromRevId).toBeNull();
    expect(created.slug).toBe("회사");
  });

  it("never stores a basis on EN revisions", () => {
    const created = newPage(db, { translatedFromRevId: 999 });
    const rev = db.select().from(revisions).where(eq(revisions.id, created.revId)).get();
    expect(rev?.translatedFromRevId).toBeNull();
  });
});

describe("rollback + delete", () => {
  it("rolls back through saveEdit, appending a revision with the old content (#11)", () => {
    const created = newPage(db);
    const second = saveEdit(db, {
      pageId: created.pageId,
      locale: "en",
      title: "Gold bar",
      content: "vandalism",
      parentRevId: created.revId,
      author: bob,
      parse: parsed("<p>vandalism</p>"),
    });
    const restored = rollback(db, {
      pageId: created.pageId,
      locale: "en",
      targetRevId: created.revId,
      actor: alice,
      parse: (content) => parsed(`<p>${content}</p>`),
    });
    const rev = db.select().from(revisions).where(eq(revisions.id, restored.revId)).get();
    expect(rev?.content).toBe("A '''gold bar''' is valuable scrap.");
    expect(rev?.parentRevId).toBe(second.revId);
    expect(rev?.comment).toBe(`Rollback to r${created.revId}`);
  });

  it("deletes search_docs before the cascade so FTS has no ghosts (A6)", () => {
    const created = newPage(db);
    expect(ftsCount(db, '"scrap"*')).toBe(1);

    deletePage(db, { pageId: created.pageId, actor: alice, reason: "spam" });

    expect(db.select().from(searchDocs).all()).toHaveLength(0);
    expect(ftsCount(db, '"scrap"*')).toBe(0);
    expect(db.select().from(pages).all()).toHaveLength(0);
    expect(db.select().from(revisions).all()).toHaveLength(0);
    const audit = db.$client.prepare("select * from audit_log").all() as { action: string }[];
    expect(audit.map((a) => a.action)).toContain("page.delete");
  });
});

describe("PageStore for the engine (spec §14.9, Addenda A7/A8)", () => {
  it("resolves a template to its EN head whatever the rendering locale (A8)", () => {
    const tpl = createPage(db, {
      namespace: "template",
      locale: "en",
      title: "Infobox moon",
      content: "EN template body",
      author: alice,
      parse: parsed("<p>EN</p>"),
    });
    saveEdit(db, {
      pageId: tpl.pageId,
      locale: "ko",
      title: "Infobox moon",
      content: "KO documentation only",
      parentRevId: null,
      author: alice,
      parse: parsed("<p>KO</p>"),
    });
    const store = createPageStore(db);
    expect(store.getSource("10:Infobox_moon")).toBe("EN template body");
    // Case-insensitive first letter (O1 slug identity).
    expect(store.getSource("Template:infobox Moon")).toBe("EN template body");
  });

  it("falls back to the earliest locale head for a non-EN-first page (O4)", () => {
    createPage(db, {
      namespace: "template",
      locale: "ko",
      title: "Stub",
      content: "KO only stub",
      author: alice,
      parse: parsed("<p>KO</p>"),
    });
    expect(createPageStore(db).getSource("10:Stub")).toBe("KO only stub");
  });

  it("reports existence, and never for non-storable namespaces (A7)", () => {
    newPage(db);
    const store = createPageStore(db);
    expect(store.exists("0:Gold_bar")).toBe(true);
    expect(store.exists("0:Artifice")).toBe(false);
    expect(store.exists("2:Alice")).toBe(false); // User ns: always red
  });

  it("serves files by canonical filename (O6)", () => {
    db.insert(users).values({ uid: alice.uid, displayName: alice.displayName }).run();
    upsertFile(db, {
      filename: "Titan Landing.PNG",
      storedPath: "2026/titan-landing.png",
      mime: "image/png",
      size: 1234,
      sha1: "abc",
      width: 800,
      height: 600,
      uploaderUid: alice.uid,
    });
    expect(getFileRecord(db, "titan_landing.png")?.storedPath).toBe("2026/titan-landing.png");
    expect(createPageStore(db).getFile("Titan_Landing.png")).toEqual({
      src: "/api/media/titan-landing.png",
      width: 800,
      height: 600,
    });
  });
});

describe("version registry (versioning.md §1/§4/§6)", () => {
  it("seeds the §1 list with ordinals and the v70 default", () => {
    const rows = listVersions(db);
    expect(rows).toHaveLength(13);
    expect(rows[0]).toMatchObject({ id: "v45", ordinal: 45000, status: "legacy" });
    expect(rows[rows.length - 1]).toMatchObject({ id: "v70", ordinal: 70000, status: "current" });
    expect(getSetting<string>(db, DEFAULT_VERSION_KEY)).toBe(SEED_DEFAULT_VERSION);
  });

  it("loadVersionTable snapshots byId/ordered/defaultId for ParseContext", () => {
    const table = loadVersionTable(db);
    expect(table.defaultId).toBe("v70");
    expect(table.byId["v62"]).toMatchObject({ ordinal: 62000 });
    expect(table.ordered.map((v) => v.ordinal)).toEqual(
      [...table.ordered.map((v) => v.ordinal)].sort((a, b) => a - b),
    );
  });

  it("computes patch ordinals and flushes the cache on registry writes", () => {
    newPage(db);
    expect(db.select().from(parsedCache).all()).toHaveLength(1);
    const created = createVersion(db, { id: "V64.1", label: "v64 Patch 1" });
    expect(created).toMatchObject({ id: "v64.1", ordinal: 64001 });
    expect(db.select().from(parsedCache).all()).toHaveLength(0);
  });

  it("refuses an id whose ordinal is not a sort key (§1)", () => {
    // Shaped like a version id, but `Number(major) * 1000` overflows: the row
    // would carry ordinal Infinity — better-sqlite3 stores it, every range
    // comparison in §1 then answers nonsense, and it sorts above every real
    // version in the selector each article renders.
    const absurd = `v${"9".repeat(400)}`;
    expect(() => versionOrdinal(absurd)).toThrow(InvalidTitleError);
    expect(() => createVersion(db, { id: absurd })).toThrow(InvalidTitleError);
    expect(listVersions(db).every((row) => Number.isSafeInteger(row.ordinal))).toBe(true);
    expect(listVersions(db)).toHaveLength(13);
  });

  it("flushes the whole cache when default_version changes (§4)", () => {
    newPage(db);
    expect(db.select().from(parsedCache).all()).toHaveLength(1);
    setSetting(db, DEFAULT_VERSION_KEY, "v62", alice.uid);
    expect(db.select().from(parsedCache).all()).toHaveLength(0);
    expect(loadVersionTable(db).defaultId).toBe("v62");
  });

  it("refuses to delete a version a page still names, listing the pages (§6)", () => {
    const created = newPage(db, {
      parse: parsed("<p>130</p>", { versionScoped: true, versionBoundaries: ["v50", "v62"] }),
    });
    expect(versionReferences(db, "v62")).toEqual([
      { pageId: created.pageId, namespace: "main", slug: "gold-bar", locale: "en" },
    ]);

    let caught: VersionInUseError | null = null;
    try {
      deleteVersion(db, "v62");
    } catch (err) {
      caught = err as VersionInUseError;
    }
    expect(caught).toBeInstanceOf(VersionInUseError);
    expect(caught?.status).toBe(409);
    expect(caught?.referencedBy).toHaveLength(1);
    expect(listVersions(db)).toHaveLength(13);

    // An unreferenced version deletes fine.
    deleteVersion(db, "v47");
    expect(listVersions(db).map((v) => v.id)).not.toContain("v47");
  });
});

describe("admin grants, bans and languages (Addendum A1, O5)", () => {
  it("grants, reports and revokes with audit rows", () => {
    grantAdmin(db, { uid: bob.uid, grantedBy: alice, displayName: bob.displayName });
    expect(hasActiveGrant(db, bob.uid)).toBe(true);
    expect(listGrants(db, { activeOnly: true })).toHaveLength(1);

    revokeAdmin(db, { uid: bob.uid, revokedBy: alice });
    expect(hasActiveGrant(db, bob.uid)).toBe(false);
    expect(listGrants(db, { activeOnly: true })).toHaveLength(0);

    const actions = (db.$client.prepare("select action from audit_log").all() as {
      action: string;
    }[]).map((r) => r.action);
    expect(actions).toEqual(["admin.grant", "admin.revoke"]);
  });

  it("is idempotent: granting twice keeps one active grant", () => {
    grantAdmin(db, { uid: bob.uid, grantedBy: alice });
    grantAdmin(db, { uid: bob.uid, grantedBy: alice });
    expect(listGrants(db, { uid: bob.uid, activeOnly: true })).toHaveLength(1);
  });

  it("refuses self-revoke (A1)", () => {
    grantAdmin(db, { uid: alice.uid, grantedBy: alice });
    expect(() => revokeAdmin(db, { uid: alice.uid, revokedBy: alice })).toThrow(SelfRevokeError);
    expect(hasActiveGrant(db, alice.uid)).toBe(true);
  });

  it("throws when there is nothing to revoke", () => {
    db.insert(users).values({ uid: bob.uid, displayName: bob.displayName }).run();
    expect(() => revokeAdmin(db, { uid: bob.uid, revokedBy: alice })).toThrow(GrantMissingError);
  });

  it("never treats a banned user as an admin (A1) and mirrors the ban (O5)", () => {
    grantAdmin(db, { uid: bob.uid, grantedBy: alice });
    setUserBanned(db, { uid: bob.uid, banned: true, actor: alice, reason: "spam" });
    expect(hasActiveGrant(db, bob.uid)).toBe(false);
    expect(db.select().from(users).where(eq(users.uid, bob.uid)).get()?.banned).toBe(true);

    setUserBanned(db, { uid: bob.uid, banned: false, actor: alice });
    expect(hasActiveGrant(db, bob.uid)).toBe(true);
  });

  it("activates a proposed language with an audit row", () => {
    createLanguage(db, {
      code: "ja",
      label: "Japanese",
      nativeName: "日本語",
      createdBy: null,
    });
    const updated = setLanguageStatus(db, "ja", "active", alice);
    expect(updated.status).toBe("active");
    const audit = db.$client
      .prepare("select action, target from audit_log")
      .all() as { action: string; target: string }[];
    expect(audit).toContainEqual({ action: "lang.approve", target: "lang:ja" });
  });

  it("rejects a status change for an unknown language", () => {
    expect(() => setLanguageStatus(db, "zz", "active", alice)).toThrow(LanguageMissingError);
  });
});

describe("navigation categories (decisions O3)", () => {
  it("seeds and reads back sort-ordered localized labels", () => {
    seedNavCategories(db, [
      { slug: "strategies", sortOrder: 20, labels: { en: "Strategies", ko: "전략" } },
      { slug: "moons", sortOrder: 10, labels: { en: "Moons", ko: "달" }, description: { en: "…" } },
    ]);
    const rows = listNavCategories(db);
    expect(rows.map((r) => r.slug)).toEqual(["moons", "strategies"]);
    expect(rows[1].labels.ko).toBe("전략");
    expect(rows[0].description?.en).toBe("…");
    // Idempotent re-seed updates in place.
    seedNavCategories(db, [{ slug: "moons", sortOrder: 30, labels: { en: "Moons" } }]);
    expect(listNavCategories(db).map((r) => r.slug)).toEqual(["strategies", "moons"]);
  });
});

describe("findPage", () => {
  it("looks a page up by slug or by raw title (slugified per O1)", () => {
    const created = newPage(db);
    expect(findPage(db, "main", "gold-bar")?.id).toBe(created.pageId);
    expect(findPage(db, "main", "Gold Bar")?.id).toBe(created.pageId);
    expect(findPage(db, "main", "artifice")).toBeNull();
    expect(findPage(db, "template", "gold-bar")).toBeNull();
  });
});

describe("page_locales bookkeeping", () => {
  it("keeps one head per (page, locale) and both locale heads independent", () => {
    const created = newPage(db);
    saveEdit(db, {
      pageId: created.pageId,
      locale: "ko",
      title: "금괴",
      content: "금괴",
      parentRevId: null,
      author: alice,
      parse: parsed("<p>금괴</p>"),
    });
    const rows = db
      .select()
      .from(pageLocales)
      .where(eq(pageLocales.pageId, created.pageId))
      .all();
    expect(rows).toHaveLength(2);
    expect(
      db
        .select()
        .from(pageLocales)
        .where(and(eq(pageLocales.pageId, created.pageId), eq(pageLocales.locale, "ko")))
        .get()?.title,
    ).toBe("금괴");
  });
});
