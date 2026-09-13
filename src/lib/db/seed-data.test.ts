/**
 * Seed-data invariants. These are the things that silently break the seed if
 * they drift, so they are asserted rather than eyeballed:
 *
 * 1. every slug is exactly `slugifyTitle(title)` and idempotent under it
 *    (decisions O1 — identity is `(namespace, slug)`, so a hand-written slug
 *    that does not round-trip makes a page unreachable by its own title);
 * 2. every template an article transcludes is actually in `TEMPLATES` (a
 *    missing one renders as a red-linked `{{Foo}}` with no error);
 * 3. the wikitext still matches docs/engine/seed-content-plan.md byte for byte;
 * 4. the registries match wiki-data/*.json and versioning.md §1;
 * 5. every article carries at least one `[[Category:…]]` tag — since
 *    decisions-v2 O13 that tag is the page's ONLY filing, so an article
 *    without one would be invisible to every browse surface.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DEFAULT_NAMESPACES, normalizeTitle, slugifyTitle } from "@/lib/title";
import { parse } from "@/lib/wikitext/index";
import { titleKey } from "@/lib/wikitext/magic-words";
import type { PageStore, WikiConfig } from "@/lib/wikitext/types";

import {
  ARTICLES,
  HELP_PAGES,
  DEFAULT_VERSION,
  HOME_CATEGORIES,
  LANGUAGES,
  NAV_CATEGORIES,
  REDIRECTS,
  SEED_ACTOR,
  TEMPLATES,
  VERSIONS,
  seedPageRefs,
} from "./seed-data";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Every `{{Name…}}` transclusion in a document — parser functions excluded. */
function transclusions(wikitext: string): string[] {
  const re = /\{\{(?!\{)\s*([^{}|#][^{}|]*?)\s*(?=[|}])/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(wikitext)) !== null) out.add(normalizeTitle(m[1] as string));
  return [...out];
}

/** Every `[[Category:Name]]` / `[[Category:Name|sortkey]]` tag in a source. */
function categoryTags(wikitext: string): string[] {
  return [...wikitext.matchAll(/\[\[Category:([^\]|]+)(?:\|[^\]]*)?\]\]/gi)].map((m) =>
    (m[1] as string).trim(),
  );
}

const PLAN_PATH = fileURLToPath(
  new URL("../../../docs/engine/seed-content-plan.md", import.meta.url),
);

/** The plan's `<!-- fixture:id -->` blocks, extracted the same way the engine's
 *  seed-fixtures.test.ts extracts them. */
function planFixtures(): Map<string, string> {
  const md = readFileSync(PLAN_PATH, "utf8").replace(/\r\n?/g, "\n");
  const re = /<!--\s*fixture:([a-z0-9-]+)\s*-->\s*\n```wikitext\n([\s\S]*?)\n```/g;
  const out = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) out.set(m[1] as string, m[2] as string);
  return out;
}

/* ------------------------------------------------------------------ */

describe("seed slugs (decisions O1/O9)", () => {
  const all = [
    ...TEMPLATES.map((t) => ({ kind: "template", title: t.title, slug: t.slug })),
    ...ARTICLES.map((a) => ({ kind: "article", title: a.title, slug: a.slug })),
    ...REDIRECTS.map((r) => ({ kind: "redirect", title: r.title, slug: r.slug })),
  ];

  it("derives every slug from its title with slugifyTitle", () => {
    for (const entry of all) {
      expect(entry.slug, `${entry.kind} ${entry.title}`).toBe(slugifyTitle(entry.title));
    }
  });

  it("keeps every slug stable under a second slugifyTitle pass", () => {
    for (const entry of all) {
      expect(slugifyTitle(entry.slug), `${entry.kind} ${entry.slug}`).toBe(entry.slug);
      expect(entry.slug).not.toBe("");
    }
  });

  it("drops the plan's legacy `template-` slug prefix (Addendum)", () => {
    expect(TEMPLATES.map((t) => t.slug)).toEqual([
      "infobox-moon",
      "infobox-entity",
      "infobox-item",
      "infobox-mechanic",
      "stub",
      "version",
      "reflist",
      "verify",
      // Banner for the Project:Version scoping help page (versioning.md).
      "version-note",
    ]);
  });

  it("gives every article at least one [[Category:]] tag (decisions-v2 O13)", () => {
    for (const art of ARTICLES) {
      expect(categoryTags(art.wikitext), art.title).not.toEqual([]);
    }
  });

  it("files each article under the category its old nav bucket named (O13.7)", () => {
    // The navCategory field is gone; these tags are what replaced it, so the
    // seven decorated categories keep exactly the membership they had.
    const expected: Record<string, string> = {
      Titan: "Moons",
      Jester: "Entities",
      Quota: "Mechanics",
      Artifice: "Moons",
      Rend: "Moons",
      Dine: "Moons",
      Experimentation: "Moons",
      Embrion: "Moons",
      "The Company (71-Gordion)": "Moons",
      Bracken: "Entities",
      "Coil-Head": "Entities",
      Nutcracker: "Entities",
      "Old Bird": "Entities",
      Masked: "Entities",
      Jetpack: "Equipment",
      Teleporters: "Equipment",
      "Zap gun": "Equipment",
      "Company Cruiser": "Equipment",
      Apparatus: "Scrap",
      "Gold bar": "Scrap",
      "Cash register": "Scrap",
      "Overtime bonus": "Mechanics",
      "Scrap value multiplier": "Mechanics",
      Weather: "Mechanics",
      "Selling at the Company": "Mechanics",
      "High quota routing": "Strategies",
      "One-day quota": "Strategies",
      "Apparatus pulls": "Strategies",
    };
    expect(Object.keys(expected).sort()).toEqual(ARTICLES.map((a) => a.title).sort());
    for (const art of ARTICLES) {
      expect(categoryTags(art.wikitext), art.title).toContain(expected[art.title]);
    }
  });

  it("gives every page a unique (namespace, slug) identity", () => {
    const keys = seedPageRefs().map((r) => `${r.namespace}:${r.slug}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("uses bare canonical moon titles, with the numbered forms as redirects", () => {
    // The full seed inventory (seed-content-plan.md §1): the three §3 exemplar
    // articles first, then the wave-2 batches in seed-content/ load order.
    expect(ARTICLES.map((a) => a.title)).toEqual([
      // §3 exemplars
      "Titan",
      "Jester",
      "Quota",
      // moons
      "Artifice",
      "Rend",
      "Dine",
      "Experimentation",
      "Embrion",
      "The Company (71-Gordion)",
      // entities
      "Bracken",
      "Coil-Head",
      "Nutcracker",
      "Old Bird",
      "Masked",
      // equipment + scrap
      "Jetpack",
      "Teleporters",
      "Zap gun",
      "Company Cruiser",
      "Apparatus",
      "Gold bar",
      "Cash register",
      // mechanics + strategies
      "Overtime bonus",
      "Scrap value multiplier",
      "Weather",
      "Selling at the Company",
      "High quota routing",
      "One-day quota",
      "Apparatus pulls",
    ]);
    // No article title carries a number prefix — those are redirect-only forms.
    for (const article of ARTICLES) {
      expect(article.title, article.title).not.toMatch(/^\d+-/);
    }
    const titan = REDIRECTS.find((r) => r.title === "8-Titan");
    expect(titan).toBeDefined();
    expect(titan?.slug).toBe("8-titan");
    expect(titan?.target).toBe("Titan");
    expect(REDIRECTS.find((r) => r.title === "68-Artifice")?.target).toBe("Artifice");
  });

  it("writes every redirect as a #REDIRECT to a different page", () => {
    for (const red of REDIRECTS) {
      expect(red.wikitext).toBe(`#REDIRECT [[${red.target}]]`);
      expect(slugifyTitle(red.target)).not.toBe(red.slug);
    }
  });
});

/* ------------------------------------------------------------------ */

describe("template references", () => {
  const bySlug = new Map(TEMPLATES.map((t) => [t.slug, t]));

  const documents = [
    ...ARTICLES.map((a) => ({ label: `${a.slug} [en]`, wikitext: a.wikitext })),
    ...ARTICLES.flatMap((a) =>
      a.translations.map((t) => ({ label: `${a.slug} [${t.locale}]`, wikitext: t.wikitext })),
    ),
  ];

  it("resolves every template an article transcludes to a seeded TEMPLATES entry", () => {
    for (const doc of documents) {
      for (const name of transclusions(doc.wikitext)) {
        expect(bySlug.has(slugifyTitle(name)), `${doc.label} transcludes {{${name}}}`).toBe(true);
      }
    }
  });

  it("finds the transclusions it is supposed to find", () => {
    // Guards the scanner itself: a regex that matched nothing would make the
    // assertion above vacuously true.
    expect(transclusions(ARTICLES[0]?.wikitext ?? "").sort()).toEqual([
      "Infobox moon",
      "Reflist",
      "Verify",
      "Version",
    ]);
    const ko = ARTICLES[0]?.translations[0]?.wikitext ?? "";
    expect(transclusions(ko).sort()).toEqual(["Infobox moon", "Reflist", "Stub", "Verify"]);
  });

  it("ships every template the seed articles need, in transclusion order", () => {
    const needed = new Set(documents.flatMap((d) => transclusions(d.wikitext)).map(slugifyTitle));
    // Every infobox flavour is now exercised by the expanded corpus.
    expect([...needed].sort()).toEqual([
      "infobox-entity",
      "infobox-item",
      "infobox-mechanic",
      "infobox-moon",
      "reflist",
      "stub",
      "verify",
      "version",
    ]);
    expect(TEMPLATES.length).toBe(9);
    // `version-note` is the only template no ARTICLE transcludes: it belongs to
    // the Project-namespace help page (HELP_PAGES), not to the article corpus.
    expect(TEMPLATES.map((t) => t.slug).filter((s) => !needed.has(s))).toEqual(["version-note"]);
    // ...and every template an article asks for actually ships.
    for (const slug of needed) {
      expect(bySlug.has(slug), `missing template: ${slug}`).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */

describe("content is the plan's fixtures, verbatim", () => {
  const fixtures = planFixtures();

  it("matches every template block", () => {
    const ids = [
      "template-infobox-moon",
      "template-infobox-entity",
      "template-infobox-item",
      "template-infobox-mechanic",
      "template-stub",
      "template-version",
      "template-reflist",
      "template-verify",
    ];
    ids.forEach((id, i) => {
      expect(TEMPLATES[i]?.wikitext, id).toBe(fixtures.get(id));
    });
  });

  it("matches the three EN articles and the KO translation", () => {
    expect(ARTICLES[0]?.wikitext).toBe(fixtures.get("article-titan-en"));
    expect(ARTICLES[1]?.wikitext).toBe(fixtures.get("article-jester-en"));
    expect(ARTICLES[2]?.wikitext).toBe(fixtures.get("article-quota-en"));
    expect(ARTICLES[0]?.translations[0]?.wikitext).toBe(fixtures.get("article-titan-ko"));
    expect(ARTICLES[0]?.translations[0]?.locale).toBe("ko");
  });
});

/* ------------------------------------------------------------------ */

describe("registries", () => {
  it("migrates both languages from wiki-data/languages.json", () => {
    expect(LANGUAGES.map((l) => l.code)).toEqual(["en", "ko"]);
    for (const lang of LANGUAGES) {
      expect(lang.status).toBe("active");
      expect(lang.direction).toBe("ltr");
      expect(lang.nativeName).not.toBe("");
    }
  });

  it("keeps the seven category metadata rows, `strategies` included (O13.6)", () => {
    expect(NAV_CATEGORIES.map((c) => c.slug)).toEqual([
      "moons",
      "entities",
      "equipment",
      "scrap",
      "mechanics",
      "strategies",
      "tech",
    ]);
    const strategies = NAV_CATEGORIES.find((c) => c.slug === "strategies");
    expect(strategies?.sortOrder).toBe(55);
    expect(strategies?.labels).toEqual({ en: "Strategies", ko: "전략" });
  });

  it("keeps category metadata uniquely slugged, EN+KO labelled and ordered", () => {
    const orders = NAV_CATEGORIES.map((c) => c.sortOrder);
    expect(new Set(orders).size).toBe(orders.length);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    for (const cat of NAV_CATEGORIES) {
      expect(slugifyTitle(cat.slug)).toBe(cat.slug);
      expect(Object.keys(cat.labels).sort()).toEqual(["en", "ko"]);
      expect(Object.keys(cat.description).sort()).toEqual(["en", "ko"]);
    }
  });

  it("pins the home grid to the seven decorated categories (O13.3)", () => {
    // A hint, not a registry: every slug must be a real category name so the
    // read-time lookup finds it, but a page in none of them is still a page.
    expect(HOME_CATEGORIES).toEqual(NAV_CATEGORIES.map((c) => c.slug));
    const tagged = new Set(
      ARTICLES.flatMap((a) => categoryTags(a.wikitext)).map((name) => slugifyTitle(name)),
    );
    // `tech` is decorated but nothing is filed under it yet — it drops out of
    // the grid at read time rather than rendering an empty card.
    expect(HOME_CATEGORIES.filter((slug) => !tagged.has(slug))).toEqual(["tech"]);
  });

  it("has the 13-version registry from versioning.md §1, newest current", () => {
    expect(VERSIONS.map((v) => v.id)).toEqual([
      "v45",
      "v47",
      "v49",
      "v50",
      "v55",
      "v56",
      "v60",
      "v62",
      "v64",
      "v66",
      "v68",
      "v69",
      "v70",
    ]);
    expect(VERSIONS.length).toBe(13);
    expect(DEFAULT_VERSION).toBe("v70");
    const ordinals = VERSIONS.map((v) => v.ordinal);
    expect(ordinals[0]).toBe(45_000);
    expect(ordinals[ordinals.length - 1]).toBe(70_000);
    expect([...ordinals].sort((a, b) => a - b)).toEqual(ordinals);
    expect(VERSIONS.filter((v) => v.status === "current").map((v) => v.id)).toEqual(["v70"]);
  });

  it("attributes every seeded revision to the system user", () => {
    expect(SEED_ACTOR).toEqual({ uid: "system", displayName: "HQHQ Wiki" });
  });
});

/* ------------------------------------------------------------------ */

describe("seedPageRefs()", () => {
  it("lists templates, then articles and redirects, then help pages", () => {
    const refs = seedPageRefs();
    expect(refs.length).toBe(
      TEMPLATES.length + ARTICLES.length + REDIRECTS.length + HELP_PAGES.length,
    );
    expect(refs.slice(0, TEMPLATES.length).every((r) => r.namespace === "template")).toBe(true);
    const mainCount = ARTICLES.length + REDIRECTS.length;
    expect(
      refs
        .slice(TEMPLATES.length, TEMPLATES.length + mainCount)
        .every((r) => r.namespace === "main"),
    ).toBe(true);
    expect(refs.slice(TEMPLATES.length + mainCount).every((r) => r.namespace === "project")).toBe(
      true,
    );
    expect(refs.find((r) => r.slug === "titan")?.locales).toEqual(["en", "ko"]);
    expect(refs.find((r) => r.slug === "jester")?.locales).toEqual(["en"]);
    expect(refs.find((r) => r.slug === "version-scoping")?.locales).toEqual(["en", "ko"]);
  });
});

/* ------------------------------------------------------------------ */
/* 6. Every seeded page renders without a template damaging its HTML   */
/* ------------------------------------------------------------------ */

/**
 * The whole corpus through the real engine, looking for one specific kind of
 * wreckage: a template that splices a newline into an HTML **attribute value**.
 *
 * Spec §8.7 (T2529, and MediaWiki does the same) prepends a `\n` to any
 * expansion whose first character is one of `*#;:`, `{|` or `----` when the
 * splice point is not at line start. Land that inside `title="…"` and stage 4,
 * which is line-oriented, cuts the tag in half: the `<` escapes into visible
 * `&lt;sup …` text, and the rest of the attribute — now a line opening with
 * `:` — becomes a `<dl><dd>` that swallows everything after it. Inside a
 * wikitable it eats the row's `||` separators too, so one bad character in one
 * template collapsed a whole comparison table into a single cell.
 *
 * That is what `{{Verify|reason}}` did on every seeded page carrying one, and
 * what the infobox risk/danger swatch did with a `#rrggbb` `#switch` result.
 * The engine is right and the templates were wrong (`&#58;` for the colon, the
 * `#` of a colour hoisted out of the switch) — but nothing else in this suite
 * looks at rendered HTML, so the damage was invisible to all 3 100 of the other
 * assertions. This is the one that sees it, and it reads the corpus rather than
 * the four plan fixtures `wikitext/seed-fixtures.test.ts` drives, because the
 * page that surfaced the bug in the wild ("High quota routing") is not one of
 * them.
 */
describe("seed content renders without attribute damage (§8.7)", () => {
  const sources = new Map<string, string>();
  for (const t of TEMPLATES) sources.set(titleKey(10, t.title), t.wikitext);
  for (const a of ARTICLES) sources.set(titleKey(0, a.title), a.wikitext);

  const store: PageStore = {
    getSource: (t) => sources.get(t) ?? null,
    // Everything exists: a red link renders differently, and this test is
    // about tags the templates write, not about which pages are blue.
    exists: () => true,
    getFile: () => null,
  };

  const config: WikiConfig = {
    siteName: "HQHQ Wiki",
    articlePath: "/wiki/$1",
    redLinkPath: "/wiki/$1?redlink=1",
    externalLinkRel: "nofollow noopener",
    caseSensitive: false,
    maxTemplateDepth: 40,
    maxIncludeSize: 2_097_152,
    maxExpensiveCalls: 100,
    thumbDefaultWidth: 220,
    uprightDefaultFactor: 0.75,
    timezone: "UTC",
    fragmentMode: "html5",
    namespaces: DEFAULT_NAMESPACES,
    messages: {
      tocTitle: "Contents",
      redLinkTitleSuffix: "(page does not exist)",
      redirectTo: "Redirect to:",
      citeErrorNoText: (name) => `Cite error: ${name}`,
      templateLoop: "Template loop detected",
      templateDepthExceeded: "Template recursion depth limit exceeded",
      unknownVersion: (id) => `Unknown version: ${id}`,
    },
  };

  /** Every page the seed writes, in both locales, with its namespace. */
  function everyPage(): { name: string; namespace: number; wikitext: string }[] {
    const out: { name: string; namespace: number; wikitext: string }[] = [];
    for (const a of ARTICLES) {
      out.push({ name: a.title, namespace: 0, wikitext: a.wikitext });
      for (const tr of a.translations) {
        out.push({ name: `${a.title} [${tr.locale}]`, namespace: 0, wikitext: tr.wikitext });
      }
    }
    for (const h of HELP_PAGES) {
      out.push({ name: h.title, namespace: 4, wikitext: h.wikitext });
      for (const tr of h.translations) {
        out.push({ name: `${h.title} [${tr.locale}]`, namespace: 4, wikitext: tr.wikitext });
      }
    }
    return out;
  }

  function render(page: { name: string; namespace: number; wikitext: string }): string {
    return parse(page.wikitext, {
      config,
      store,
      page: { namespace: page.namespace, pageName: page.name },
      version: null,
      versions: { byId: {}, ordered: [], defaultId: DEFAULT_VERSION },
    }).html;
  }

  it("closes every title= and style= on the line it opened on", () => {
    for (const page of everyPage()) {
      const html = render(page);
      expect(html, `${page.name}: title= broken across lines`).not.toMatch(/title="[^"]*\n/);
      expect(html, `${page.name}: style= broken across lines`).not.toMatch(/style="[^"]*\n/);
    }
  });

  it("never escapes a template's own tag into visible text", () => {
    // `&lt;` is legitimate where a help page *documents* markup inside <code>
    // (Help:Version scoping writes `&lt;v62&gt;` by hand), so this names the
    // tags the seed templates actually emit rather than banning `&lt;` outright.
    const emitted = /&lt;\/?(?:sup|b|div|span|table|tr|td|th|references)\b/;
    for (const page of everyPage()) {
      expect(render(page), `${page.name}: a template's tag reached the reader as text`)
        .not.toMatch(emitted);
    }
  });

  it("renders {{Verify|reason}} as a <sup> whose reason reads as a sentence", () => {
    const withReason = ARTICLES.filter((a) => /\{\{Verify\|/.test(a.wikitext));
    expect(withReason.length).toBeGreaterThan(0);
    for (const a of withReason) {
      const html = render({ name: a.title, namespace: 0, wikitext: a.wikitext });
      expect(html, a.title).toMatch(
        /current game version: [^"\n]+\.">\[verify\]<\/sup>/,
      );
    }
  });
});
