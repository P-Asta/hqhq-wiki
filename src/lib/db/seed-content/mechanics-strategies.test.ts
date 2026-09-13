/**
 * Validation for the mechanics/strategies seed batch: drive every article in
 * MECHANICS_STRATEGY_ARTICLES through the real `parse()` against a map-backed
 * fake PageStore holding the 9 seed TEMPLATES (the pattern of
 * src/lib/wikitext/seed-fixtures.test.ts), and assert the invariants
 * seed-data.test.ts checks statically: clean parse (zero warnings), rendered
 * infobox where the article carries one, expected [[Category:]] membership,
 * and slug === slugifyTitle(title).
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_NAMESPACES, normalizeTitle, slugifyTitle } from "@/lib/title";
import { parse } from "@/lib/wikitext";
import type {
  PageStore,
  ParseContext,
  ParseResult,
  Title,
  WikiConfig,
} from "@/lib/wikitext/types";

import { TEMPLATES } from "../seed-data";

import { MECHANICS_STRATEGY_ARTICLES } from "./mechanics-strategies";

/* ------------------------------------------------------------------ */
/* Fake store: the 9 seed templates + this batch's own pages           */
/* ------------------------------------------------------------------ */

function titleKey(namespace: number, title: string): string {
  return `${namespace}:${normalizeTitle(title).replace(/ /g, "_")}`;
}

const templateSource = new Map<string, string>(
  TEMPLATES.map((t) => [titleKey(10, t.title), t.wikitext]),
);

const pages = new Set<string>([
  ...templateSource.keys(),
  // This batch's own pages, so cross-links inside the batch resolve blue.
  ...MECHANICS_STRATEGY_ARTICLES.map((a) => titleKey(0, a.title)),
  // The three core articles the batch links back to.
  ...["Titan", "Jester", "Quota"].map((t) => titleKey(0, t)),
]);

const store: PageStore = {
  getSource: (title) => templateSource.get(title) ?? null,
  exists: (title) => pages.has(title),
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
/* Per-article expectations                                            */
/* ------------------------------------------------------------------ */

interface Expectation {
  title: string;
  /** Mechanics pages carry {{Infobox_mechanic}}; strategy pages are infobox-less. */
  infobox: boolean;
  /**
   * The section-matching [[Category:]] tag the article must collect. Since
   * decisions-v2 O13 this tag IS the article's filing: the old one-bucket
   * field it used to be cross-checked against no longer exists.
   */
  category: string;
}

const EXPECTED: readonly Expectation[] = [
  { title: "Overtime bonus", infobox: true, category: "Mechanics" },
  { title: "Scrap value multiplier", infobox: true, category: "Mechanics" },
  { title: "Weather", infobox: true, category: "Mechanics" },
  { title: "Selling at the Company", infobox: true, category: "Mechanics" },
  { title: "High quota routing", infobox: false, category: "Strategies" },
  { title: "One-day quota", infobox: false, category: "Strategies" },
  { title: "Apparatus pulls", infobox: false, category: "Strategies" },
];

/* ------------------------------------------------------------------ */

describe("mechanics/strategies seed batch", () => {
  it("contains exactly the 7 inventory articles, in plan order", () => {
    expect(MECHANICS_STRATEGY_ARTICLES.map((a) => a.title)).toEqual(
      EXPECTED.map((e) => e.title),
    );
  });

  it("derives every slug with slugifyTitle (decisions O1/O9)", () => {
    for (const a of MECHANICS_STRATEGY_ARTICLES) {
      expect(a.slug).toBe(slugifyTitle(a.title));
    }
    expect(MECHANICS_STRATEGY_ARTICLES.map((a) => a.slug)).toEqual([
      "overtime-bonus",
      "scrap-value-multiplier",
      "weather",
      "selling-at-the-company",
      "high-quota-routing",
      "one-day-quota",
      "apparatus-pulls",
    ]);
  });

  it("declares no translations (EN-only batch)", () => {
    for (const a of MECHANICS_STRATEGY_ARTICLES) {
      expect(a.translations).toEqual([]);
    }
  });

  for (const [i, exp] of EXPECTED.entries()) {
    describe(exp.title, () => {
      const seed = MECHANICS_STRATEGY_ARTICLES[i]!;
      const out = render(seed);

      it("carries its filing [[Category:]] tag in the source (O13)", () => {
        expect(seed.wikitext).toContain(`[[Category:${exp.category}]]`);
      });

      it("parses with zero warnings", () => {
        expect(out.meta.warnings).toEqual([]);
      });

      it("renders substantial, fully expanded HTML", () => {
        expect(out.html.length).toBeGreaterThan(500);
        expect(out.html).not.toContain("{{");
        expect(out.html).not.toContain("}}");
        expect(out.html).not.toContain("UNIQ--");
        expect(out.html).not.toContain("Unknown parser function");
        expect(out.html).not.toContain('class="error"');
      });

      it(exp.infobox ? "renders the Infobox_mechanic table" : "is infobox-less by design", () => {
        if (exp.infobox) {
          expect(out.html).toContain('<table class="infobox"');
        } else {
          expect(out.html).not.toContain('<table class="infobox"');
        }
      });

      it("contains at least one wikitable", () => {
        expect(out.html).toContain('<table class="wikitable"');
      });

      it(`collects [[Category:${exp.category}]] plus the {{Verify}} maintenance category`, () => {
        const names = out.meta.categories.map((c) => c.name);
        expect(names).toContain(exp.category);
        expect(names).toContain("Pages with unverified data");
      });

      it("renders its reference through {{Reflist}}", () => {
        expect(out.html).toContain('<div class="reflist"');
        expect(out.html).toContain('<ol class="references">');
      });
    });
  }
});
