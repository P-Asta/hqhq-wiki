/**
 * Wiki toolset (tools.ts) against a real :memory: database — fixture rows go
 * through the schema tables directly (FKs on), and search_docs inserts feed
 * the FTS index via the DDL triggers, so search() behaves exactly as in prod.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { createDb, type WikiDb } from "@/lib/db/client";
import { languages, pageLocales, pages, revisions, searchDocs, users } from "@/lib/db/schema";

import { MAX_PAGE_CHARS, createWikiToolset } from "./tools";

let db: WikiDb;

interface SeedPage {
  namespace?: "main" | "template" | "category" | "file" | "project";
  slug: string;
  locales: Array<{ locale: string; title: string; body: string }>;
  redirect?: { namespace: "main"; slug: string };
}

function seedPage(input: SeedPage): number {
  const namespace = input.namespace ?? "main";
  const page = db
    .insert(pages)
    .values({
      namespace,
      slug: input.slug,
      redirectNs: input.redirect?.namespace,
      redirectSlug: input.redirect?.slug,
    })
    .returning({ id: pages.id })
    .get();

  for (const loc of input.locales) {
    const rev = db
      .insert(revisions)
      .values({
        pageId: page.id,
        locale: loc.locale,
        title: loc.title,
        content: loc.body, // tests read search_docs, not wikitext
        authorUid: "u1",
        authorName: "Tester",
      })
      .returning({ id: revisions.id })
      .get();
    const pl = db
      .insert(pageLocales)
      .values({ pageId: page.id, locale: loc.locale, title: loc.title, currentRevId: rev.id })
      .returning({ id: pageLocales.id })
      .get();
    db.insert(searchDocs)
      .values({
        id: pl.id,
        pageId: page.id,
        locale: loc.locale,
        namespace,
        slug: input.slug,
        title: loc.title,
        body: loc.body,
      })
      .run();
  }
  return page.id;
}

beforeAll(() => {
  db = createDb(":memory:");
  db.insert(users).values({ uid: "u1", displayName: "Tester" }).run();
  db.insert(languages)
    .values([
      { code: "en", label: "English", nativeName: "English", status: "active" },
      { code: "ko", label: "Korean", nativeName: "한국어", status: "active" },
    ])
    .run();

  seedPage({
    slug: "titan",
    locales: [
      { locale: "en", title: "Titan", body: "The Titan is the largest moon boss in the game." },
      { locale: "ko", title: "타이탄", body: "타이탄은 게임에서 가장 큰 달 보스입니다." },
    ],
  });
  seedPage({
    slug: "moon-guide",
    locales: [
      { locale: "en", title: "Moon guide", body: "Guide to every moon, including the Titan fight." },
    ],
  });
  seedPage({ slug: "big-titan", redirect: { namespace: "main", slug: "titan" }, locales: [] });
  seedPage({
    slug: "long-page",
    locales: [{ locale: "en", title: "Long page", body: "word ".repeat(3000) }],
  });
});

describe("search_wiki", () => {
  it("finds pages and strips <mark> from snippets", () => {
    const toolset = createWikiToolset(db, "en");
    const execution = toolset.execute("search_wiki", JSON.stringify({ query: "titan" }));
    const rows = JSON.parse(execution.result) as Array<{ slug: string; snippet: string }>;
    expect(rows.map((r) => r.slug)).toContain("titan");
    expect(execution.count).toBeGreaterThanOrEqual(2);
    expect(execution.result).not.toContain("<mark>");
    expect(execution.sources).toEqual([]);
    expect(execution.label).toBe("titan");
  });

  it("unions the EN index for a non-EN locale (O7 fallback)", () => {
    const toolset = createWikiToolset(db, "ko");
    const execution = toolset.execute("search_wiki", JSON.stringify({ query: "moon" }));
    const rows = JSON.parse(execution.result) as Array<{ slug: string; locale: string }>;
    expect(rows.some((r) => r.slug === "moon-guide" && r.locale === "en")).toBe(true);
  });

  it("reports an empty result as a retry hint, not an error", () => {
    const toolset = createWikiToolset(db, "en");
    const execution = toolset.execute("search_wiki", JSON.stringify({ query: "zzzzzz" }));
    expect(execution.count).toBe(0);
    expect(execution.result).toMatch(/No pages matched/);
  });

  it("rejects malformed arguments recoverably", () => {
    const toolset = createWikiToolset(db, "en");
    expect(toolset.execute("search_wiki", "{oops").result).toMatch(/Invalid arguments/);
    expect(toolset.execute("search_wiki", JSON.stringify({ query: "" })).result).toMatch(
      /Invalid arguments/,
    );
  });
});

describe("read_page", () => {
  it("reads a page's plain text and cites it as a source", () => {
    const toolset = createWikiToolset(db, "en");
    const execution = toolset.execute("read_page", JSON.stringify({ slug: "titan" }));
    const doc = JSON.parse(execution.result) as { title: string; content: string };
    expect(doc.title).toBe("Titan");
    expect(doc.content).toContain("largest moon boss");
    expect(execution.sources).toEqual([
      { namespace: "main", slug: "titan", title: "Titan", locale: "en" },
    ]);
    expect(execution.label).toBe("Titan");
  });

  it("serves the asker's locale when a translation exists", () => {
    const toolset = createWikiToolset(db, "ko");
    const execution = toolset.execute("read_page", JSON.stringify({ slug: "titan" }));
    const doc = JSON.parse(execution.result) as { locale: string; content: string };
    expect(doc.locale).toBe("ko");
    expect(doc.content).toContain("타이탄");
  });

  it("falls back to EN when the locale has no translation", () => {
    const toolset = createWikiToolset(db, "ko");
    const execution = toolset.execute("read_page", JSON.stringify({ slug: "moon-guide" }));
    const doc = JSON.parse(execution.result) as { locale: string };
    expect(doc.locale).toBe("en");
  });

  it("follows a redirect one hop", () => {
    const toolset = createWikiToolset(db, "en");
    const execution = toolset.execute("read_page", JSON.stringify({ slug: "big-titan" }));
    const doc = JSON.parse(execution.result) as { slug: string };
    expect(doc.slug).toBe("titan");
    expect(execution.sources[0]?.slug).toBe("titan");
  });

  it("reports a missing page with a search hint", () => {
    const toolset = createWikiToolset(db, "en");
    const execution = toolset.execute("read_page", JSON.stringify({ slug: "nope" }));
    expect(execution.result).toMatch(/Page not found/);
    expect(execution.sources).toEqual([]);
  });

  it("truncates long pages at MAX_PAGE_CHARS", () => {
    const toolset = createWikiToolset(db, "en");
    const execution = toolset.execute("read_page", JSON.stringify({ slug: "long-page" }));
    const doc = JSON.parse(execution.result) as { truncated: boolean; content: string };
    expect(doc.truncated).toBe(true);
    expect(doc.content.length).toBeLessThanOrEqual(MAX_PAGE_CHARS + 20);
  });
});

describe("unknown tools", () => {
  it("answers with the available tool names", () => {
    const toolset = createWikiToolset(db, "en");
    expect(toolset.execute("write_page", "{}").result).toMatch(/Unknown tool/);
  });
});

describe("resolveInlineLinks", () => {
  it("resolves a plain existing title", () => {
    const toolset = createWikiToolset(db, "en");
    expect(toolset.resolveInlineLinks(["Titan"])).toEqual({
      Titan: { namespace: "main", slug: "titan", title: "Titan", locale: "en" },
    });
  });

  it("follows one redirect hop", () => {
    const toolset = createWikiToolset(db, "en");
    // "Big Titan" -> slug "big-titan", a redirect page seeded to "titan".
    expect(toolset.resolveInlineLinks(["Big Titan"])).toEqual({
      "Big Titan": { namespace: "main", slug: "titan", title: "Titan", locale: "en" },
    });
  });

  it("falls back to EN when the asker's locale has no translation (O7)", () => {
    const toolset = createWikiToolset(db, "ko");
    expect(toolset.resolveInlineLinks(["Moon guide"])).toEqual({
      "Moon guide": { namespace: "main", slug: "moon-guide", title: "Moon guide", locale: "en" },
    });
  });

  it("serves the asker's own locale when a translation exists", () => {
    const toolset = createWikiToolset(db, "ko");
    expect(toolset.resolveInlineLinks(["Titan"])).toEqual({
      Titan: { namespace: "main", slug: "titan", title: "타이탄", locale: "ko" },
    });
  });

  it("omits a hallucinated or nonexistent title instead of guessing", () => {
    const toolset = createWikiToolset(db, "en");
    expect(toolset.resolveInlineLinks(["Nonexistent Page"])).toEqual({});
  });

  it("returns only the titles that resolved, keyed by the exact raw text", () => {
    const toolset = createWikiToolset(db, "en");
    expect(toolset.resolveInlineLinks(["Titan", "Nonexistent Page", "titan"])).toEqual({
      Titan: { namespace: "main", slug: "titan", title: "Titan", locale: "en" },
      titan: { namespace: "main", slug: "titan", title: "Titan", locale: "en" },
    });
  });

  it("returns an empty map for an empty input", () => {
    const toolset = createWikiToolset(db, "en");
    expect(toolset.resolveInlineLinks([])).toEqual({});
  });
});
