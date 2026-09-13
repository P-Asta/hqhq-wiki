/**
 * Validation for the entities seed batch (seed-content-plan.md §1 "Entities"):
 * every article parses through the real wikitext pipeline against a map-backed
 * fake PageStore holding the 9 seed TEMPLATES (the same harness shape as
 * src/lib/wikitext/seed-fixtures.test.ts), with:
 *
 * - meta.warnings exactly empty (zero warnings, nothing excluded);
 * - non-empty html containing the {{Infobox_entity}} <table;
 * - the expected [[Category:]] tags collected (incl. the one {{Verify}} injects);
 * - slug === slugifyTitle(title) and a `[[Category:Entities]]` tag in the
 *   source, which since decisions-v2 O13 is the page's only filing (O1/O13).
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_NAMESPACES, normalizeTitle, slugifyTitle } from "@/lib/title";

import { parse } from "@/lib/wikitext";
import type { PageStore, ParseContext, ParseResult, Title, WikiConfig } from "@/lib/wikitext/types";

import { TEMPLATES } from "../seed-data";

import { ENTITY_ARTICLES } from "./entities";

/* ------------------------------------------------------------------ */
/* Store: the 9 seed templates + the §1 page inventory                 */
/* ------------------------------------------------------------------ */

const TEMPLATE_SOURCES: Record<string, string> = Object.fromEntries(
  TEMPLATES.map((t) => [`10:${normalizeTitle(t.title).replace(/ /g, "_")}`, t.wikitext]),
);

/**
 * The §1 seed inventory under its canonical O9 titles — same list the engine's
 * seed-fixtures.test.ts uses. Links to anything else are red links by design.
 */
const SEED_TITLES = [
  "Titan",
  "Artifice",
  "Rend",
  "Dine",
  "Experimentation",
  "Embrion",
  "The Company (71-Gordion)",
  "Jester",
  "Bracken",
  "Coil-Head",
  "Nutcracker",
  "Old Bird",
  "Masked",
  "Jetpack",
  "Teleporters",
  "Zap gun",
  "Company Cruiser",
  "Apparatus",
  "Gold bar",
  "Cash register",
  "Quota",
  "Overtime bonus",
  "Scrap value multiplier",
  "Weather",
  "Selling at the Company",
  "High quota routing",
  "One-day quota",
  "Apparatus pulls",
];

const PAGES = new Set<string>([
  ...SEED_TITLES.map((t) => `0:${normalizeTitle(t).replace(/ /g, "_")}`),
  ...Object.keys(TEMPLATE_SOURCES),
]);

const store: PageStore = {
  getSource: (title) => TEMPLATE_SOURCES[title] ?? null,
  exists: (title) => PAGES.has(title),
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
    citeErrorNoText: (name) => `Cite error: no text provided for ref "${name}"`,
    templateLoop: "Template loop detected",
    templateDepthExceeded: "Template recursion depth limit exceeded",
    unknownVersion: (id) => `Unknown version: ${id}`,
  },
};

function render(article: { title: string; wikitext: string }): ParseResult {
  const page: Title = { namespace: 0, pageName: article.title };
  const ctx: ParseContext = {
    config,
    store,
    page,
    version: null,
    versions: { byId: {}, ordered: [], defaultId: "v70" },
  };
  return parse(article.wikitext, ctx);
}

/* ------------------------------------------------------------------ */

const EXPECTED = [
  { title: "Bracken", habitat: "Indoor entities" },
  { title: "Coil-Head", habitat: "Indoor entities" },
  { title: "Nutcracker", habitat: "Indoor entities" },
  { title: "Old Bird", habitat: "Outdoor entities" },
  { title: "Masked", habitat: "Indoor entities" },
] as const;

describe("entities seed batch", () => {
  it("contains exactly the five §1 entity articles, in inventory order", () => {
    expect(ENTITY_ARTICLES.map((a) => a.title)).toEqual(EXPECTED.map((e) => e.title));
  });

  it("derives every slug from its title and files under [[Category:Entities]]", () => {
    for (const a of ENTITY_ARTICLES) {
      expect(a.slug, a.title).toBe(slugifyTitle(a.title));
      expect(slugifyTitle(a.slug), a.title).toBe(a.slug);
      expect(a.wikitext, a.title).toContain("[[Category:Entities]]");
      expect(a.translations, a.title).toEqual([]);
    }
  });
});

describe.each(EXPECTED)("entities seed batch — $title", ({ title, habitat }) => {
  const article = ENTITY_ARTICLES.find((a) => a.title === title);
  if (article === undefined) throw new Error(`missing article: ${title}`);
  const out = render(article);

  it("parses with zero warnings and substantial html", () => {
    expect(out.meta.warnings).toEqual([]);
    expect(out.html.length).toBeGreaterThan(500);
    // Nothing left unexpanded and no machinery leaking.
    expect(out.html).not.toContain("{{");
    expect(out.html).not.toContain("}}");
    expect(out.html).not.toContain("UNIQ--");
    expect(out.html).not.toContain("Unknown parser function");
    expect(out.html).not.toContain('class="error"');
  });

  it("renders the Infobox_entity table with the article name", () => {
    expect(out.html).toContain('<table class="infobox"');
    expect(out.html).toContain(title);
  });

  it("collects the article categories plus the one Template:Verify injects", () => {
    const names = out.meta.categories.map((c) => c.name);
    expect(names).toContain("Entities");
    expect(names).toContain(habitat);
    expect(names).toContain("Pages with unverified data");
  });

  it("links into the seed inventory (blue links resolve)", () => {
    expect(out.meta.linksTo).toContain("0:Artifice");
    expect(out.meta.linksTo).toContain("0:High_quota_routing");
    expect(out.html).not.toContain("Artifice (page does not exist)");
  });

  it("numbers the named ref and renders the {{Reflist}} block", () => {
    expect(out.html).toContain('class="reference"');
    expect(out.html).toContain('<div class="reflist"');
    expect(out.html).toContain('<ol class="references">');
  });
});
