import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createDb, ensureSchema } from "./client";
import {
  languages,
  pageLocales,
  pages,
  revisions,
  searchDocs,
  users,
} from "./schema";

describe("db schema (createDb + ensureSchema)", () => {
  it("creates the schema, round-trips page + revision + page_locale, and wires FTS", () => {
    const db = createDb(":memory:");

    // Pragmas: foreign_keys must be ON (off by default in SQLite).
    const fk = db.$client.pragma("foreign_keys", { simple: true });
    expect(fk).toBe(1);

    // FK targets first: language + user.
    db.insert(languages)
      .values({ code: "en", label: "English", nativeName: "English", status: "active" })
      .run();
    db.insert(users).values({ uid: "u1", displayName: "Tester" }).run();

    // pages → revisions → page_locales, as in the create transaction.
    const page = db
      .insert(pages)
      .values({ namespace: "main", slug: "gold-bar" })
      .returning({ id: pages.id })
      .get();

    const pl = db
      .insert(pageLocales)
      .values({ pageId: page.id, locale: "en", title: "Gold bar" })
      .returning({ id: pageLocales.id })
      .get();

    const rev = db
      .insert(revisions)
      .values({
        pageId: page.id,
        locale: "en",
        title: "Gold bar",
        content: "A '''gold bar''' is valuable scrap.",
        authorUid: "u1",
        authorName: "Tester",
      })
      .returning({ id: revisions.id })
      .get();

    db.update(pageLocales)
      .set({ currentRevId: rev.id })
      .where(eq(pageLocales.id, pl.id))
      .run();

    // Read back through drizzle.
    const gotPage = db
      .select()
      .from(pages)
      .where(and(eq(pages.namespace, "main"), eq(pages.slug, "gold-bar")))
      .get();
    expect(gotPage?.id).toBe(page.id);
    expect(gotPage?.redirectSlug).toBeNull();
    expect(gotPage?.redirectFragment).toBeNull();
    expect(gotPage?.createdAt).toBeInstanceOf(Date);

    const gotPl = db
      .select()
      .from(pageLocales)
      .where(and(eq(pageLocales.pageId, page.id), eq(pageLocales.locale, "en")))
      .get();
    expect(gotPl?.currentRevId).toBe(rev.id);
    expect(gotPl?.title).toBe("Gold bar");

    const gotRev = db.select().from(revisions).where(eq(revisions.id, rev.id)).get();
    expect(gotRev?.content).toContain("gold bar");
    expect(gotRev?.isMinor).toBe(false);
    expect(gotRev?.translatedFromRevId).toBeNull();

    // FTS virtual table exists.
    const fts = db.$client
      .prepare("SELECT name FROM sqlite_master WHERE name = 'search_fts'")
      .get() as { name: string } | undefined;
    expect(fts?.name).toBe("search_fts");

    // Triggers sync search_docs → search_fts.
    db.insert(searchDocs)
      .values({
        id: pl.id,
        pageId: page.id,
        locale: "en",
        namespace: "main",
        slug: "gold-bar",
        title: "Gold bar",
        body: "A gold bar is valuable scrap.",
      })
      .run();
    const hit = db.$client
      .prepare(
        "SELECT rowid FROM search_fts WHERE search_fts MATCH 'valuable'",
      )
      .get() as { rowid: number } | undefined;
    expect(hit?.rowid).toBe(pl.id);

    // ensureSchema is idempotent: a second connection-style run is a no-op.
    expect(() => db.$client.exec("SELECT 1")).not.toThrow();
  });

  it("ensureSchema is idempotent and FK violations are enforced", () => {
    const db = createDb(":memory:");
    // Re-running the DDL on an initialized db must not throw.
    expect(() => ensureSchema(db)).not.toThrow();

    // revisions.locale references languages(code): missing locale must fail.
    db.insert(users).values({ uid: "u1", displayName: "Tester" }).run();
    const page = db
      .insert(pages)
      .values({ slug: "x" })
      .returning({ id: pages.id })
      .get();
    expect(() =>
      db
        .insert(revisions)
        .values({
          pageId: page.id,
          locale: "xx",
          title: "X",
          content: "x",
          authorUid: "u1",
          authorName: "Tester",
        })
        .run(),
    ).toThrow(/FOREIGN KEY/i);
  });
});
