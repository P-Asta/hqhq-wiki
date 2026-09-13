/**
 * Seed content as an end-to-end fixture — docs/engine/seed-content-plan.md §7
 * step 3: pull each `<!-- fixture:id -->` wikitext block out of the plan
 * VERBATIM, load the 8 seed templates into a fake `PageStore`, and drive the
 * three EN articles plus the KO Titan translation through the real `parse()`.
 *
 * These are the largest real documents the engine has: nested transclusion in
 * template arguments, `{{#if}}/{{#ifeq}}/{{#switch}}` infobox rows, wikitables,
 * refs via `{{Reflist}}`, categories injected from inside templates, entities,
 * CJK text — and the D-14 regression (Addendum A1) that the plan's own
 * addendum names: consecutive omitted infobox params must not leave `<p><br />`
 * fragments inside a raw `<table>`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DEFAULT_NAMESPACES, canonicalFilename, normalizeTitle } from "@/lib/title";

import { parse } from "./index";
import type {
  PageStore,
  ParseContext,
  ParseResult,
  Title,
  WikiConfig,
} from "./types";

/* ------------------------------------------------------------------ */
/* Fixture extraction                                                  */
/* ------------------------------------------------------------------ */

const PLAN_PATH = fileURLToPath(
  new URL("../../../docs/engine/seed-content-plan.md", import.meta.url),
);

/** `<!-- fixture:id -->` followed by a ```wikitext fence → id → block. */
function loadFixtures(): Map<string, string> {
  const md = readFileSync(PLAN_PATH, "utf8").replace(/\r\n?/g, "\n");
  const re = /<!--\s*fixture:([a-z0-9-]+)\s*-->\s*\n```wikitext\n([\s\S]*?)\n```/g;
  const out = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) out.set(m[1] as string, m[2] as string);
  return out;
}

const FIXTURES = loadFixtures();

function fixture(id: string): string {
  const text = FIXTURES.get(id);
  if (text === undefined) throw new Error(`missing fixture block: ${id}`);
  return text;
}

/* ------------------------------------------------------------------ */
/* Store: the 8 seed templates + the §1 page inventory                 */
/* ------------------------------------------------------------------ */

/** fixture id → the `Template:` page it is stored as (§2.1–§2.8). */
const TEMPLATE_FIXTURES: Record<string, string> = {
  "10:Infobox_moon": "template-infobox-moon",
  "10:Infobox_entity": "template-infobox-entity",
  "10:Infobox_item": "template-infobox-item",
  "10:Infobox_mechanic": "template-infobox-mechanic",
  "10:Stub": "template-stub",
  "10:Version": "template-version",
  "10:Reflist": "template-reflist",
  "10:Verify": "template-verify",
};

const TEMPLATES: Record<string, string> = Object.fromEntries(
  Object.entries(TEMPLATE_FIXTURES).map(([key, id]) => [key, fixture(id)]),
);

/**
 * The §1 seed inventory, under the canonical titles decisions O9 settles
 * (moons keep their bare names; the number-prefixed forms are redirects).
 * Everything NOT in this list is a red link — which is the point.
 */
const SEED_TITLES = [
  // moons
  "Titan",
  "Artifice",
  "Rend",
  "Dine",
  "Experimentation",
  "Embrion",
  "The Company (71-Gordion)",
  // entities
  "Jester",
  "Bracken",
  "Coil-Head",
  "Nutcracker",
  "Old Bird",
  "Masked",
  // equipment
  "Jetpack",
  "Teleporters",
  "Zap gun",
  "Company Cruiser",
  // scrap
  "Apparatus",
  "Gold bar",
  "Cash register",
  // mechanics
  "Quota",
  "Overtime bonus",
  "Scrap value multiplier",
  "Weather",
  "Selling at the Company",
  // strategies
  "High quota routing",
  "One-day quota",
  "Apparatus pulls",
];

const PAGES = new Set<string>([
  ...SEED_TITLES.map((t) => `0:${normalizeTitle(t).replace(/ /g, "_")}`),
  ...Object.keys(TEMPLATES),
]);

/** The two images the infoboxes reference. */
const FILES: Record<string, { src: string; width: number; height: number }> = {
  "moon-titan.png": { src: "/api/media/moon-titan.png", width: 640, height: 360 },
  "entity-jester.png": { src: "/api/media/entity-jester.png", width: 512, height: 512 },
};

const store: PageStore = {
  getSource: (title) => TEMPLATES[title] ?? null,
  exists: (title) => PAGES.has(title),
  getFile: (name) => FILES[canonicalFilename(name)] ?? null,
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

function render(id: string, pageName: string): ParseResult {
  const page: Title = { namespace: 0, pageName };
  const ctx: ParseContext = {
    config,
    store,
    page,
    version: null,
    versions: { byId: {}, ordered: [], defaultId: "v70" },
  };
  return parse(fixture(id), ctx);
}

/* ------------------------------------------------------------------ */
/* Assertion helpers                                                   */
/* ------------------------------------------------------------------ */

/** Every `<table …> … </table>` span, linear scan (inner close wins). */
function tableSpans(html: string): string[] {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const start = html.indexOf("<table", i);
    if (start < 0) return out;
    const end = html.indexOf("</table>", start);
    if (end < 0) {
      out.push(html.slice(start));
      return out;
    }
    out.push(html.slice(start, end + "</table>".length));
    i = end + "</table>".length;
  }
}

const RED_LINK_RE = /<a href="[^"]*" class="new red-link" title="([^"]*?) \(page does not exist\)">/g;

function redLinkTargets(html: string): string[] {
  return [...html.matchAll(RED_LINK_RE)].map((m) => m[1] as string);
}

function categoryNames(result: ParseResult): string[] {
  return result.meta.categories.map((c) => c.name);
}

/**
 * Checks every seed document must pass, whatever its content (plan §7 step 3).
 */
function assertHealthy(result: ParseResult): void {
  expect(result.html.length).toBeGreaterThan(500);
  // Nothing left unexpanded and no internal machinery leaking.
  expect(result.html).not.toContain("{{");
  expect(result.html).not.toContain("}}");
  expect(result.html).not.toContain("UNIQ--");
  expect(result.html).not.toContain("&lt;table");
  // D-14 / Addendum A1: no paragraph machinery inside a raw <table>.
  for (const span of tableSpans(result.html)) {
    expect(span).not.toContain("<p><br");
    expect(span).not.toContain("<p></p>");
  }
  // The infobox itself.
  expect(result.html).toContain('<table class="infobox"');
  expect(result.html).not.toContain("Unknown parser function");
  expect(result.html).not.toContain('class="error"');
}

/* ------------------------------------------------------------------ */

describe("seed fixture extraction", () => {
  it("finds all 12 fixture blocks the plan defines", () => {
    expect([...FIXTURES.keys()]).toEqual([
      "template-infobox-moon",
      "template-infobox-entity",
      "template-infobox-item",
      "template-infobox-mechanic",
      "template-stub",
      "template-version",
      "template-reflist",
      "template-verify",
      "article-titan-en",
      "article-jester-en",
      "article-quota-en",
      "article-titan-ko",
    ]);
  });

  it("loads all 8 seed templates into the store", () => {
    for (const key of Object.keys(TEMPLATE_FIXTURES)) {
      expect(store.exists(key)).toBe(true);
      expect((store.getSource(key) ?? "").length).toBeGreaterThan(50);
    }
  });
});

/* ------------------------------------------------------------------ */

describe("A1 — 8-Titan (EN)", () => {
  const out = render("article-titan-en", "Titan");

  it("parses cleanly through the whole pipeline", () => {
    assertHealthy(out);
    expect(out.meta.warnings).toEqual([]);
  });

  it("renders the Infobox_moon rows the parameters select", () => {
    const box = tableSpans(out.html)[0] as string;
    expect(box).toContain("8-Titan");
    expect(box).toContain(">700 credits</td>"); // {{#ifeq:cost|0}} → not free
    expect(box).toContain(">Tier 3 (endgame)</td>"); // {{#switch:tier}}
    // {{#switch:risk}} with the S++/S+/S bare-case fall-through, and §8.7's
    // auto-newline before the `#b3261e` colour, which §11.4 must tolerate.
    expect(box).toContain('<b style="color:');
    expect(box).toContain("#b3261e;\">S+</b>");
    expect(box).not.toContain("insecure input");
    expect(box).toContain(">28 &ndash; 31</td>"); // concatenated-param {{#if}}
    expect(box).toContain('<img src="/api/media/moon-titan.png"'); // [[File:…|260px|…]]
  });

  it("collects the article categories plus the one Template:Verify injects", () => {
    expect(categoryNames(out).sort()).toEqual([
      "Moons",
      "Pages with unverified data",
      "Tier 3 moons",
    ]);
  });

  it("marks exactly the documented red links (plan §3.1 + Addendum)", () => {
    const red = new Set(redLinkTargets(out.html));
    for (const target of [
      "Fancy lamp",
      "Snare Flea",
      "Eyeless Dog",
      "Extension ladder",
    ]) {
      expect(red).toContain(target);
    }
    // …and the seed pages it links stay blue.
    for (const target of ["Artifice", "Jester", "Gold bar", "Apparatus"]) {
      expect(red).not.toContain(target);
      expect(out.meta.linksTo).toContain(`0:${target.replace(/ /g, "_")}`);
    }
    // The plan's Addendum lists "Eclipsed" as a red link, but the fixture only
    // uses it as italic prose — there is no [[Eclipsed]] to colour.
    expect(out.html).not.toContain("Eclipsed (page does not exist)");
  });

  it("numbers the single named ref and renders the {{Reflist}} list", () => {
    expect(out.refs).toEqual({ "": 1 });
    expect(out.html).toContain('class="reference"');
    expect(out.html).toContain('<div class="reflist"');
    expect(out.html).toContain('<ol class="references">');
    expect(out.html).toContain('id="cite_note-lethalwiki-1"');
    // No auto-appended list: {{Reflist}} consumed the group.
    expect(out.html).not.toContain("mw-ref-warning");
  });

  it("builds the section outline and the two wikitables", () => {
    expect(out.toc.map((e) => e.id)).toEqual([
      "Overview",
      "Layout_and_routing",
      "Scrap",
      "Entities",
      "High_quota_play",
      "Version_notes",
      "External_links",
      "References",
    ]);
    expect(out.html.match(/<table class="wikitable">/g)).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */

describe("A2 — Jester (EN)", () => {
  const out = render("article-jester-en", "Jester");

  it("parses cleanly through the whole pipeline", () => {
    assertHealthy(out);
    expect(out.meta.warnings).toEqual([]);
  });

  it("renders the Infobox_entity yes/no rows via nested {{#ifeq}}", () => {
    const box = tableSpans(out.html)[0] as string;
    expect(box).toContain(">Indoor entity</td>");
    expect(box).toContain(">Invulnerable</td>");
    expect(box).toContain(">Yes</td>"); // stunnable = yes
    expect(box).toContain("><b>No</b></td>"); // killable = no, nested {{#ifeq}}
    expect(box).toContain(">Extreme</b>");
    // `locations` is a list of links written inside a template parameter.
    expect(box).toContain('title="Rend"');
  });

  it("collects its categories and the Verify maintenance category", () => {
    expect(categoryNames(out).sort()).toEqual([
      "Entities",
      "Indoor entities",
      "Pages with unverified data",
    ]);
  });

  it("marks the documented red links", () => {
    const red = new Set(redLinkTargets(out.html));
    expect(red).toContain("Stun grenade");
    expect(red).toContain("Apparatus room");
    expect(red).not.toContain("Zap gun");
  });

  it("numbers its ref and renders one wikitable", () => {
    expect(out.refs).toEqual({ "": 1 });
    expect(out.html).toContain('<ol class="references">');
    expect(out.html.match(/<table class="wikitable">/g)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */

describe("A3 — Quota (EN)", () => {
  const out = render("article-quota-en", "Quota");

  it("parses cleanly through the whole pipeline", () => {
    assertHealthy(out);
    expect(out.meta.warnings).toEqual([]);
  });

  it("keeps entities intact in the monospace formula cell", () => {
    const box = tableSpans(out.html)[0] as string;
    expect(box).toContain("Profit quota");
    expect(box).toContain("&times;");
    expect(box).toContain("&sup2;");
    expect(box).toContain("font-family:monospace");
  });

  it("renders the `:`-indented <code> lines as definition data", () => {
    expect(out.html).toContain("<dl><dd><code>newQuota = oldQuota");
  });

  it("collects its categories", () => {
    expect(categoryNames(out).sort()).toEqual([
      "High quota",
      "Mechanics",
      "Pages with unverified data",
    ]);
  });

  it("marks the documented red links", () => {
    const red = new Set(redLinkTargets(out.html));
    expect(red).toContain("Deadline");
    expect(red).toContain("Credits");
    expect(red).not.toContain("Overtime bonus");
    expect(red).not.toContain("The Company (71-Gordion)");
  });

  it("numbers its ref and renders both progression tables", () => {
    expect(out.refs).toEqual({ "": 1 });
    expect(out.html).toContain('id="cite_note-decomp-1"');
    expect(out.html.match(/<table class="wikitable">/g)).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */

describe("K — 8-타이탄 (KO translation)", () => {
  const out = render("article-titan-ko", "Titan");

  it("parses cleanly through the whole pipeline", () => {
    assertHealthy(out);
    expect(out.meta.warnings).toEqual([]);
  });

  it("D-14 regression: the omitted infobox params drop their rows cleanly", () => {
    const box = tableSpans(out.html)[0] as string;
    // weather / interior / outdoor_power / map-less rows are all absent…
    expect(box).not.toContain("Possible weather");
    expect(box).not.toContain("Interior types");
    expect(box).not.toContain("Max outdoor power");
    // …and the consecutive blank lines they left behind produced nothing.
    expect(box).not.toContain("<p>");
    expect(box).not.toContain("<br");
    // The rows that ARE given still render, in order.
    expect(box).toContain(">700 credits</td>");
    expect(box).toContain(">Tier 3 (endgame)</td>");
    expect(box).toContain(">18</td>");
  });

  it("carries CJK through titles, headings and link labels", () => {
    expect(out.html).toContain("8-타이탄");
    expect(out.toc.map((e) => e.id)).toEqual(["개요", "하이_쿼터_관점", "참고"]);
    expect(out.html).toContain('<h2 id="개요">개요</h2>');
    expect(out.html).toContain('title="Artifice">아티피스</a>');
  });

  it("collects the EN category ids plus the ones {{Stub}} and {{Verify}} inject", () => {
    expect(categoryNames(out).sort()).toEqual([
      "Moons",
      "Pages with unverified data",
      "Stubs",
    ]);
  });

  it("renders the {{Stub}} notice and numbers its ref", () => {
    expect(out.html).toContain('<div class="notice"');
    expect(out.refs).toEqual({ "": 1 });
    expect(out.html).toContain('<ol class="references">');
  });
});

/* ------------------------------------------------------------------ */

describe("all four seed documents", () => {
  const docs: [string, string][] = [
    ["article-titan-en", "Titan"],
    ["article-jester-en", "Jester"],
    ["article-quota-en", "Quota"],
    ["article-titan-ko", "Titan"],
  ];

  it("render without throwing and record their template dependencies (A4)", () => {
    for (const [id, page] of docs) {
      const out = render(id, page);
      expect(out.html).not.toBe("");
      // Every infobox/notice template the document reaches, transitively.
      expect(out.meta.templatesUsed).toContain("10:Reflist");
      expect(out.meta.templatesUsed.some((t) => t.startsWith("10:Infobox_"))).toBe(
        true,
      );
      expect(out.meta.volatile).toBe(false);
      expect(out.meta.versionScoped).toBe(false);
    }
  });

  it("are deterministic (§14.11)", () => {
    for (const [id, page] of docs) {
      expect(render(id, page).html).toBe(render(id, page).html);
    }
  });
});

/* ------------------------------------------------------------------ */
/* T2529 inside attribute values (§8.7, engine-status V-7)             */
/* ------------------------------------------------------------------ */

/**
 * The auto-newline rule fires on ANY expansion whose first character is one of
 * `*#;:`, `{|` or `----` and whose splice point is not at line start — parser
 * functions included, exactly as MediaWiki does it. Splice such an expansion
 * into an HTML **attribute value** and the LF lands inside the quotes, where it
 * is not harmless: stage 4 is line-oriented, so the tag is cut in half, its
 * `<` is escaped into visible `&lt;sup …` text, and the remainder of the
 * attribute — now a line opening with `:` — becomes a definition list.
 *
 * That is what `{{Verify|reason}}` did on all 29 seeded pages carrying one, and
 * what the infobox risk/danger swatch did with a `#rrggbb` switch result. The
 * fix is in the templates, not the engine (§8.7 is normative): `&#58;` for the
 * colon, and the `#` of a colour hoisted out of the `#switch`. This asserts the
 * damage cannot come back — it is cheap, and the failure mode is invisible in
 * a diff of the template but glaring on every article.
 */
describe("no template splices an LF into an attribute value", () => {
  const docs: [string, string][] = [
    ["article-titan-en", "Titan"],
    ["article-jester-en", "Jester"],
    ["article-quota-en", "Quota"],
    ["article-titan-ko", "Titan"],
  ];

  it("leaves every title= and style= on one line", () => {
    for (const [id, page] of docs) {
      const { html } = render(id, page);
      expect(html, `${id}: title= broken across lines`).not.toMatch(/title="[^"]*\n/);
      expect(html, `${id}: style= broken across lines`).not.toMatch(/style="[^"]*\n/);
    }
  });

  it("renders {{Verify}} as a real <sup>, never as escaped text", () => {
    for (const [id, page] of docs) {
      const { html } = render(id, page);
      expect(html, `${id}: <sup> escaped into text`).not.toMatch(/&lt;sup/);
      expect(html).toContain('<sup class="notice"');
      // The reason reads as a sentence, which is the whole point of the arg.
      expect(html).toMatch(/current game version: [^"\n]+\.">\[verify\]<\/sup>/);
    }
  });
});
