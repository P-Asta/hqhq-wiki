import { describe, expect, it, vi } from "vitest";

import { createDb, type WikiDb } from "@/lib/db/client";
import { seedLanguages, seedVersions, setSetting, upsertNavCategory } from "@/lib/db/store";

import { titlePathSegment } from "@/lib/locale-path";

import { createTargetHref, loadEditorView } from "./edit-view";
import { loadArticleView, loadHomeView, orderHomeCategories } from "./read-view";
import { createPageWithParse } from "./service";

vi.mock("server-only", () => ({}));

const alice = { uid: "u-alice", displayName: "Alice" };

function setup(): WikiDb {
  const db = createDb(":memory:");
  seedLanguages(db);
  seedVersions(db);
  return db;
}

describe("loadArticleView — red-link category pages (routes.md member listing)", () => {
  it("lists members on a category page nobody has written", () => {
    const db = setup();
    createPageWithParse({
      db,
      namespace: "main",
      locale: "en",
      title: "Gold bar",
      content: "Valuable scrap.\n[[Category:Scrap]]",
      author: alice,
    });

    const view = loadArticleView({ db, locale: "en", segments: "category:scrap" });
    expect(view.kind).toBe("missing");
    if (view.kind !== "missing") throw new Error("unreachable");
    expect(view.categoryListing).not.toBeNull();
    expect(view.categoryListing?.members.map((ref) => ref.slug)).toEqual(["gold-bar"]);
    expect(view.categoryListing?.members[0]?.href).toBe("/wiki/gold-bar");
    expect(view.categoryListing?.subcategories).toEqual([]);
  });

  it("keeps the plain red-link landing for an empty category", () => {
    const db = setup();
    const view = loadArticleView({ db, locale: "en", segments: "category:empty-cat" });
    expect(view.kind).toBe("missing");
    if (view.kind !== "missing") throw new Error("unreachable");
    expect(view.categoryListing).toBeNull();
  });

  it("never builds a listing for missing pages off the category namespace", () => {
    const db = setup();
    const view = loadArticleView({ db, locale: "en", segments: "no-such-page" });
    expect(view.kind).toBe("missing");
    if (view.kind !== "missing") throw new Error("unreachable");
    expect(view.categoryListing).toBeNull();
  });

  it("still appends the listing when the category page exists", () => {
    const db = setup();
    createPageWithParse({
      db,
      namespace: "category",
      locale: "en",
      title: "Scrap",
      content: "Everything you can sell.",
      author: alice,
    });
    createPageWithParse({
      db,
      namespace: "main",
      locale: "en",
      title: "Gold bar",
      content: "Valuable scrap.\n[[Category:Scrap]]",
      author: alice,
    });

    const view = loadArticleView({ db, locale: "en", segments: "category:scrap" });
    expect(view.kind).toBe("article");
    if (view.kind !== "article") throw new Error("unreachable");
    expect(view.categoryListing?.members.map((ref) => ref.slug)).toEqual(["gold-bar"]);
  });
});

/* ------------------------------------------------------------------ */
/* Home categories (decisions-v2 O13.3)                                */
/* ------------------------------------------------------------------ */

/** `n` articles filed under `category`, so the counts below are real. */
function fileUnder(db: WikiDb, category: string, titles: string[]): void {
  for (const title of titles) {
    createPageWithParse({
      db,
      namespace: "main",
      locale: "en",
      title,
      content: `Body.
[[Category:${category}]]`,
      author: alice,
    });
  }
}

describe("loadHomeView — category cards from real membership (O13.3)", () => {
  function populated(): WikiDb {
    const db = setup();
    fileUnder(db, "Scrap", ["Gold bar", "Cash register", "Apparatus"]);
    fileUnder(db, "Moons", ["Titan", "Rend"]);
    fileUnder(db, "Mechanics", ["Quota"]);
    return db;
  }

  it("orders by live member count and reports it on every card", () => {
    const view = loadHomeView({ db: populated(), locale: "en" });
    expect(view.categories.map((c) => c.slug)).toEqual(["scrap", "moons", "mechanics"]);
    expect(view.categories.map((c) => c.count)).toEqual([3, 2, 1]);
    // Nobody wrote the Category: pages, which is normal — they are still cards.
    expect(view.categories.every((c) => !c.hasPage)).toBe(true);
    expect(view.categories[0]?.href).toBe("/wiki/category:scrap");
    expect(view.allCategoriesHref).toBe("/special/categories");
  });

  it("prefers the `categories` metadata label, else the humanized slug (O13.6)", () => {
    const db = populated();
    upsertNavCategory(db, {
      slug: "moons",
      sortOrder: 10,
      labels: { en: "Moons", ko: "위성" },
      description: { en: "Locations and routes.", ko: "지역과 경로." },
    });
    const en = loadHomeView({ db, locale: "en" }).categories;
    expect(en.find((c) => c.slug === "moons")).toMatchObject({
      label: "Moons",
      description: "Locations and routes.",
    });
    // No metadata row ⇒ the raw category name, not a blank card.
    expect(en.find((c) => c.slug === "scrap")).toMatchObject({ label: "Scrap", description: null });
    expect(loadHomeView({ db, locale: "ko" }).categories.find((c) => c.slug === "moons")?.label).toBe(
      "위성",
    );
  });

  it("lets the `home_categories` setting override the order", () => {
    const db = populated();
    setSetting(db, "home_categories", ["mechanics", "scrap"], "system");
    expect(loadHomeView({ db, locale: "en" }).categories.map((c) => c.slug)).toEqual([
      "mechanics",
      "scrap",
    ]);
  });

  it("ignores a setting that names nothing real, and caps the grid", () => {
    const db = populated();
    setSetting(db, "home_categories", ["nope"], "system");
    expect(loadHomeView({ db, locale: "en" }).categories.map((c) => c.slug)).toEqual([
      "scrap",
      "moons",
      "mechanics",
    ]);
    expect(loadHomeView({ db, locale: "en", categoryLimit: 2 }).categories).toHaveLength(2);
  });
});

describe("orderHomeCategories", () => {
  const rows = [{ slug: "a" }, { slug: "b" }, { slug: "c" }];

  it("keeps the natural (count-descending) order when nothing is pinned", () => {
    expect(orderHomeCategories(rows, null, 2)).toEqual([{ slug: "a" }, { slug: "b" }]);
    expect(orderHomeCategories(rows, [], 8)).toEqual(rows);
  });

  it("uses the pinned order and drops slugs that do not exist", () => {
    expect(orderHomeCategories(rows, ["c", "ghost", "a"], 8).map((r) => r.slug)).toEqual(["c", "a"]);
    expect(orderHomeCategories(rows, ["ghost"], 8)).toEqual(rows);
  });
});


/* ------------------------------------------------------------------ */
/* decisions-v2 O14 — creating a page is just visiting its URL         */
/* ------------------------------------------------------------------ */

describe("loadArticleView — the missing page IS the create flow (O14)", () => {
  it("may edit: the editor seed is derived from the URL (empty source, no parent)", () => {
    const db = setup();
    const view = loadArticleView({ db, locale: "en", segments: "gold-bar" });
    expect(view.kind).toBe("missing");
    if (view.kind !== "missing") throw new Error("unreachable");
    expect(view.title).toBe("Gold bar");

    // O14.1: the same loader the /edit route uses, seeded from the same URL.
    const seed = loadEditorView({ db, locale: "en", segments: "gold-bar" });
    expect(seed).not.toBeNull();
    expect(seed?.title.titlePath).toBe("gold-bar");
    expect(seed?.displayTitle).toBe(view.title);
    expect(seed?.previewTitle).toBe("Gold bar");
    expect(seed?.initialContent).toBe("");
    expect(seed?.parentRevId).toBeNull();
    expect(seed?.translatedFromRevId).toBeNull();
    expect(seed?.exists).toBe(false);
  });

  it("may not edit: the notice is never a dead end (sign-in + the edit URL)", () => {
    const db = setup();
    const view = loadArticleView({ db, locale: "en", segments: "gold-bar" });
    if (view.kind !== "missing") throw new Error("unreachable");
    expect(view.signInHref).toBe("/login");
    expect(view.paths.edit).toBe("/edit/gold-bar");
    expect(view.paths.article).toBe("/wiki/gold-bar");

    // O12: every one of those URLs prefixes outside the default locale.
    const ko = loadArticleView({ db, locale: "ko", segments: "gold-bar" });
    if (ko.kind !== "missing") throw new Error("unreachable");
    expect(ko.signInHref).toBe("/ko/login");
    expect(ko.paths.edit).toBe("/ko/edit/gold-bar");
    expect(ko.paths.article).toBe("/ko/wiki/gold-bar");
  });

  it("carries the namespace into the seed's {{PAGENAME}} title", () => {
    const db = setup();
    const view = loadArticleView({ db, locale: "en", segments: "template:infobox-moon" });
    if (view.kind !== "missing") throw new Error("unreachable");
    const seed = loadEditorView({ db, locale: "en", segments: "template:infobox-moon" });
    expect(seed?.title.namespace).toBe("template");
    expect(seed?.displayTitle).toBe("Infobox moon");
    expect(seed?.previewTitle).toBe("Template:Infobox moon");
    expect(seed?.title.titlePath).toBe("template:infobox-moon");
    expect(view.paths.edit).toBe("/edit/template:infobox-moon");
  });

  it("O14.6: /wiki/<missing> and /edit/<missing> seed the same editor state", () => {
    const db = setup();
    const view = loadArticleView({ db, locale: "en", segments: ["gold-bar"] });
    if (view.kind !== "missing") throw new Error("unreachable");
    // The article route seeds from the resolved (namespace, slug); the edit
    // route seeds from the raw catch-all. Both must agree.
    const fromArticle = loadEditorView({
      db,
      locale: "en",
      segments: titlePathSegment(view.namespace, view.slug),
    });
    const fromEdit = loadEditorView({ db, locale: "en", segments: ["Gold_bar"] });
    expect(fromArticle).toEqual(fromEdit);
  });

  it("carries `?v=` into the seed, ignoring ids outside the registry (§6)", () => {
    const db = setup();
    expect(loadEditorView({ db, locale: "en", segments: "gold-bar", version: "v50" })?.selectedVersion).toBe("v50");
    expect(loadEditorView({ db, locale: "en", segments: "gold-bar", version: "v99" })?.selectedVersion).toBeNull();
    expect(loadEditorView({ db, locale: "en", segments: "gold-bar" })?.selectedVersion).toBeNull();
    expect(loadEditorView({ db, locale: "en", segments: "gold-bar" })?.defaultVersion).toBe("v70");
  });

  it("keeps editing an existing page an edit, not a creation", () => {
    const db = setup();
    createPageWithParse({
      db,
      namespace: "main",
      locale: "en",
      title: "Gold bar",
      content: "Valuable scrap.",
      author: alice,
    });
    const seed = loadEditorView({ db, locale: "en", segments: "gold-bar" });
    expect(seed?.exists).toBe(true);
    expect(seed?.initialContent).toBe("Valuable scrap.");
    expect(seed?.parentRevId).not.toBeNull();
    expect(seed?.displayTitle).toBe("Gold bar");
  });

  it("rejects a catch-all that resolves to no title (both routes 404)", () => {
    const db = setup();
    expect(loadEditorView({ db, locale: "en", segments: "" })).toBeNull();
    expect(loadArticleView({ db, locale: "en", segments: "" }).kind).toBe("invalid");
    // An unstorable prefix is not a namespace (decisions O2 / §5.8): it stays
    // part of a main-namespace title, and both loaders must agree it does.
    expect(loadEditorView({ db, locale: "en", segments: "talk:gold-bar" })?.title.slug).toBe(
      "talkgold-bar",
    );
    expect(loadArticleView({ db, locale: "en", segments: "talk:gold-bar" }).kind).toBe("missing");
  });
});

/**
 * versioning.md §6 "Reader affordances": the selection rides on the *article's
 * own* links, not only on the chrome. The engine never appends `?v=` (its
 * hrefs come straight from `config.articlePath`), so the loader rewrites them
 * — and it does so on every page, because an article with no version markup is
 * a stop on the way, not the end of the reader's session.
 */
describe("loadArticleView — `?v=` propagation into the article's own links", () => {
  function twoPages(db: WikiDb): void {
    createPageWithParse({
      db,
      namespace: "main",
      locale: "en",
      title: "The Company",
      content: "Buys scrap.",
      author: alice,
    });
    createPageWithParse({
      db,
      namespace: "main",
      locale: "en",
      title: "Gold bar",
      content: "Valuable scrap. Sell it at [[The Company]].",
      author: alice,
    });
  }

  it("carries a non-default selection out of a page with no version markup", () => {
    const db = setup();
    twoPages(db);

    const view = loadArticleView({ db, locale: "en", segments: "gold-bar", version: "v50" });
    expect(view.kind).toBe("article");
    if (view.kind !== "article") throw new Error("unreachable");
    // The page itself says the same thing at every version …
    expect(view.versionScoped).toBe(false);
    expect(view.versionBoundaries).toEqual([]);
    // … and still hands the reader's v50 to the next page.
    expect(view.selectedVersion).toBe("v50");
    expect(view.html).toContain("/wiki/the-company?v=v50");
  });

  it("leaves links clean when the reader is on the site default", () => {
    const db = setup();
    twoPages(db);

    for (const version of [null, "v70"]) {
      const view = loadArticleView({ db, locale: "en", segments: "gold-bar", version });
      if (view.kind !== "article") throw new Error("unreachable");
      expect(view.selectedVersion).toBe("v70");
      expect(view.html).toContain("href=\"/wiki/the-company\"");
      expect(view.html).not.toContain("?v=");
    }
  });

  it("never propagates an id the registry does not have", () => {
    const db = setup();
    twoPages(db);

    const view = loadArticleView({ db, locale: "en", segments: "gold-bar", version: "v99" });
    if (view.kind !== "article") throw new Error("unreachable");
    // §6 routes: fall back to the default and warn — do not carry the ghost.
    expect(view.unknownVersionRequested).toBe("v99");
    expect(view.selectedVersion).toBe("v70");
    expect(view.html).not.toContain("?v=");
  });
});

describe("createTargetHref — create from search (O14.5)", () => {
  it("offers the article URL of a title nothing matches yet", () => {
    const db = setup();
    expect(createTargetHref(db, "en", "Gold bar")).toBe("/wiki/gold-bar");
    expect(createTargetHref(db, "ko", "Gold bar")).toBe("/ko/wiki/gold-bar");
    expect(createTargetHref(db, "en", "Template:Infobox moon")).toBe(
      "/wiki/template:infobox-moon",
    );
  });

  it("offers nothing once the exact title exists (identity is ns + slug)", () => {
    const db = setup();
    createPageWithParse({
      db,
      namespace: "main",
      locale: "en",
      title: "Gold bar",
      content: "Valuable scrap.",
      author: alice,
    });
    expect(createTargetHref(db, "en", "Gold bar")).toBeNull();
    expect(createTargetHref(db, "en", "gold_bar")).toBeNull();
    // A page written only in EN is still "already created" for every locale.
    expect(createTargetHref(db, "ko", "Gold bar")).toBeNull();
    expect(createTargetHref(db, "en", "Gold bars")).toBe("/wiki/gold-bars");
  });

  it("offers nothing for a blank or uncreatable title (decisions O2)", () => {
    const db = setup();
    expect(createTargetHref(db, "en", "   ")).toBeNull();
    expect(createTargetHref(db, "en", "Talk:Gold bar")).toBeNull();
  });
});
