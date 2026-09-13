/**
 * Validation for the equipment + scrap seed batch: every article is driven
 * through the real `parse()` against a map-backed fake PageStore holding the
 * 9 seed TEMPLATES (the pattern of src/lib/wikitext/seed-fixtures.test.ts),
 * asserting a clean parse (zero warnings), a rendered infobox, the expected
 * `[[Category:]]` membership, and O1 slug derivation
 * (src/lib/db/seed-data.test.ts).
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_NAMESPACES, normalizeTitle, slugifyTitle } from "@/lib/title";
import { parse } from "@/lib/wikitext";
import type {
  PageStore,
  ParseContext,
  ParseResult,
  Title,
  VersionEntry,
  VersionTable,
  WikiConfig,
} from "@/lib/wikitext/types";

import { ARTICLES, TEMPLATES } from "../seed-data";
import { SEED_DEFAULT_VERSION, SEED_VERSION_IDS, versionOrdinal } from "../store";

import { EQUIPMENT_SCRAP_ARTICLES } from "./equipment-scrap";

/* ------------------------------------------------------------------ */
/* Store: the seed templates + every seeded article title              */
/* ------------------------------------------------------------------ */

const storeKey = (namespace: number, title: string): string =>
  `${namespace}:${normalizeTitle(title).replace(/ /g, "_")}`;

const TEMPLATE_SOURCES: Record<string, string> = Object.fromEntries(
  TEMPLATES.map((t) => [storeKey(10, t.title), t.wikitext]),
);

const PAGES = new Set<string>([
  ...ARTICLES.map((a) => storeKey(0, a.title)),
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

/** The real version registry, so `<v55+>` resolves cleanly. */
const versionEntries: VersionEntry[] = SEED_VERSION_IDS.map((id) => ({
  id,
  label: id,
  ordinal: versionOrdinal(id),
  status: id === SEED_DEFAULT_VERSION ? ("current" as const) : ("legacy" as const),
}));

const versions: VersionTable = {
  byId: Object.fromEntries(versionEntries.map((e) => [e.id, e])),
  ordered: versionEntries,
  defaultId: SEED_DEFAULT_VERSION,
};

function render(wikitext: string, pageName: string): ParseResult {
  const page: Title = { namespace: 0, pageName };
  const ctx: ParseContext = { config, store, page, version: null, versions };
  return parse(wikitext, ctx);
}

/**
 * The `[[Category:]]` tag each article must carry. Since decisions-v2 O13 this
 * IS the article's filing — there is no `navCategory` field to cross-check
 * against, so the tag is asserted directly.
 */
const CATEGORY_BY_TITLE: Record<string, string> = {
  Jetpack: "Equipment",
  Teleporters: "Equipment",
  "Zap gun": "Equipment",
  "Company Cruiser": "Equipment",
  Apparatus: "Scrap",
  "Gold bar": "Scrap",
  "Cash register": "Scrap",
};

/* ------------------------------------------------------------------ */

describe("equipment-scrap batch shape", () => {
  it("contains the 7 §1 Equipment/Scrap inventory articles in order", () => {
    expect(EQUIPMENT_SCRAP_ARTICLES.map((a) => a.title)).toEqual([
      "Jetpack",
      "Teleporters",
      "Zap gun",
      "Company Cruiser",
      "Apparatus",
      "Gold bar",
      "Cash register",
    ]);
  });

  it("derives every slug from its title with slugifyTitle (O1)", () => {
    for (const a of EQUIPMENT_SCRAP_ARTICLES) {
      expect(a.slug, a.title).toBe(slugifyTitle(a.title));
      expect(slugifyTitle(a.slug), a.title).toBe(a.slug);
    }
    expect(EQUIPMENT_SCRAP_ARTICLES.map((a) => a.slug)).toEqual([
      "jetpack",
      "teleporters",
      "zap-gun",
      "company-cruiser",
      "apparatus",
      "gold-bar",
      "cash-register",
    ]);
  });

  it("files every article with a [[Category:]] tag and no translations (O13)", () => {
    for (const a of EQUIPMENT_SCRAP_ARTICLES) {
      expect(a.wikitext, a.title).toContain(`[[Category:${CATEGORY_BY_TITLE[a.title]}]]`);
      expect(a.translations).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------ */

describe.each(EQUIPMENT_SCRAP_ARTICLES.map((a) => [a.title, a] as const))(
  "%s",
  (_title, art) => {
    const out = render(art.wikitext, art.title);

    it("parses with zero warnings and non-empty html", () => {
      expect(out.meta.warnings).toEqual([]);
      expect(out.html.length).toBeGreaterThan(500);
      // Nothing left unexpanded, no machinery leaking.
      expect(out.html).not.toContain("{{");
      expect(out.html).not.toContain("}}");
      expect(out.html).not.toContain("UNIQ--");
      expect(out.html).not.toContain("Unknown parser function");
      expect(out.html).not.toContain('class="error"');
    });

    it("renders the Infobox_item table", () => {
      expect(out.html).toContain('<table class="infobox"');
      expect(out.meta.templatesUsed).toContain("10:Infobox_item");
    });

    it("collects the section category plus the Verify maintenance category", () => {
      const names = out.meta.categories.map((c) => c.name);
      expect(names).toContain(CATEGORY_BY_TITLE[art.title]);
      expect(names).toContain("Pages with unverified data");
    });

    it("numbers its lethal.wiki ref and renders the {{Reflist}} list", () => {
      expect(out.refs).toEqual({ "": 1 });
      expect(out.html).toContain('<ol class="references">');
      expect(out.html).toContain('id="cite_note-lethalwiki-1"');
    });

    it("renders at least one wikitable", () => {
      expect(out.html).toContain('<table class="wikitable">');
    });
  },
);

/* ------------------------------------------------------------------ */

describe("Company Cruiser version gating", () => {
  const cruiser = EQUIPMENT_SCRAP_ARTICLES.find((a) => a.title === "Company Cruiser");

  it("is version-scoped with the v55 boundary registered", () => {
    expect(cruiser).toBeDefined();
    const out = render(cruiser?.wikitext ?? "", "Company Cruiser");
    expect(out.meta.versionScoped).toBe(true);
    expect(out.meta.versionBoundaries).toContain("v55");
    // Default view (v70) is past v55, so the note is visible.
    expect(out.html).toContain("Added in v55");
  });

  it("is the only version-scoped article in the batch", () => {
    for (const a of EQUIPMENT_SCRAP_ARTICLES) {
      const out = render(a.wikitext, a.title);
      expect(out.meta.versionScoped, a.title).toBe(a.title === "Company Cruiser");
    }
  });
});
