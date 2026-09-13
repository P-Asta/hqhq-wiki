/**
 * Batch validation for the moon seed articles (seed-content-plan.md §1
 * "Moons"). Follows the seed-fixtures.test.ts pattern: a map-backed fake
 * `PageStore` holding the 9 seed TEMPLATES, the real `parse()` on every
 * article, and the seed-data invariants (slug = slugifyTitle(title), zero
 * parser warnings, infobox table present, categories collected).
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_NAMESPACES, normalizeTitle, slugifyTitle } from "@/lib/title";
import { TEMPLATES } from "@/lib/db/seed-data";
import { parse } from "@/lib/wikitext";
import type {
  PageStore,
  ParseContext,
  ParseResult,
  Title,
  WikiConfig,
} from "@/lib/wikitext/types";

import { MOON_ARTICLES } from "./moons";

/* ------------------------------------------------------------------ */
/* Store: the 9 seed templates + the §1 page inventory                 */
/* ------------------------------------------------------------------ */

/** Template page key (`10:Name_with_underscores`) → wikitext, from seed-data. */
const TEMPLATE_SOURCES: Record<string, string> = Object.fromEntries(
  TEMPLATES.map((t) => [`10:${normalizeTitle(t.title).replace(/ /g, "_")}`, t.wikitext]),
);

/** The §1 seed inventory under its canonical O9 titles — these link blue. */
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
  getFile: () => null, // the moon batch references no images
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

function render(wikitext: string, pageName: string): ParseResult {
  const page: Title = { namespace: 0, pageName };
  const ctx: ParseContext = {
    config,
    store,
    page,
    version: null,
    versions: { byId: {}, ordered: [], defaultId: "v70" },
  };
  return parse(wikitext, ctx);
}

/* ------------------------------------------------------------------ */

describe("moon seed batch (seed-content-plan.md §1 Moons)", () => {
  it("contains exactly the six inventory articles under their O9 titles", () => {
    expect(MOON_ARTICLES.map((a) => a.title)).toEqual([
      "Artifice",
      "Rend",
      "Dine",
      "Experimentation",
      "Embrion",
      "The Company (71-Gordion)",
    ]);
  });

  it("derives every slug from its title and files every page under [[Category:Moons]]", () => {
    for (const art of MOON_ARTICLES) {
      expect(art.slug, art.title).toBe(slugifyTitle(art.title));
      expect(slugifyTitle(art.slug), art.title).toBe(art.slug);
      expect(art.wikitext).toContain("[[Category:Moons]]");
      expect(art.translations).toEqual([]);
    }
  });

  for (const art of MOON_ARTICLES) {
    describe(art.title, () => {
      const out = render(art.wikitext, art.title);

      it("parses with zero warnings and non-empty html", () => {
        expect(out.meta.warnings).toEqual([]);
        expect(out.html.length).toBeGreaterThan(500);
        // Nothing left unexpanded and no machinery leaking.
        expect(out.html).not.toContain("{{");
        expect(out.html).not.toContain("}}");
        expect(out.html).not.toContain("UNIQ--");
        expect(out.html).not.toContain("Unknown parser function");
        expect(out.html).not.toContain('class="error"');
      });

      it("renders the Infobox_moon table and at least one wikitable", () => {
        expect(out.html).toContain('<table class="infobox"');
        expect(out.html).toContain('<table class="wikitable"');
      });

      it("collects [[Category:Moons]] plus the Verify maintenance category", () => {
        const names = out.meta.categories.map((c) => c.name);
        expect(names).toContain("Moons");
        // Every article in this batch carries at least one {{Verify}}.
        expect(names).toContain("Pages with unverified data");
      });

      it("numbers its ref and renders the {{Reflist}} list", () => {
        expect(out.refs).toEqual({ "": 1 });
        expect(out.html).toContain('<div class="reflist"');
        expect(out.html).toContain('<ol class="references">');
      });
    });
  }
});
