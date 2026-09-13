/**
 * Fandom end-to-end conformance — the real-article fixture.
 *
 * FIXTURE LICENSING. `docs/engine/fixtures/fandom-artifice.wikitext` is the
 * wikitext of the "68-Artifice" article from the Lethal Company Fandom wiki,
 * saved verbatim. It is CC BY-SA content and lives here as a TEST FIXTURE ONLY:
 * it is never seeded as site content, never served, and nothing in `src/lib/db`
 * reads it. It exists so the engine can be measured against wikitext a real
 * editor actually wrote, rather than against markup we invented to pass.
 *
 * Where the per-gap suites (`fandom-parity.test.ts`, `portable-infobox.test.ts`,
 * `fandom-tags.test.ts`) each isolate one construct, this suite asserts the
 * whole article through the single public entry point `parse()` (§14.9) — one
 * page, one `PageStore`, one render. That is the only way to observe the
 * cross-stage interactions the Fandom work was actually about: a `<ref>` born
 * inside a `<gallery>` caption (restored at §14.8 marker time) landing in a
 * `<references />` that stage 6 already walked past; `source=`-bound infobox
 * values that only exist while the template frame is live (§14.3); and image
 * sizes parsed in stage 5 but resolved against `getFile()` in stage 6.
 *
 * Normative references: docs/engine/wikitext-spec.md §5.9 (file options),
 * §5.10 (category links), §10.3 (ref/references), §10.4 (gallery), §14 (the
 * pipeline), and the "Fandom extensions" chapter.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_NAMESPACES } from "@/lib/title";

import { parse } from "./index";
import type { ParseContext, ParseResult, WikiConfig } from "./types";

/* ---------------------------------------------------------------- */
/* The article under test                                            */
/* ---------------------------------------------------------------- */

const FIXTURE_PATH = join(
  process.cwd(),
  "docs",
  "engine",
  "fixtures",
  "fandom-artifice.wikitext",
);

const ARTICLE = readFileSync(FIXTURE_PATH, "utf8");

/* ---------------------------------------------------------------- */
/* Templates the article calls                                       */
/* ---------------------------------------------------------------- */

/**
 * `Template:Location` written the way a Fandom infobox template really is —
 * as a portable-infobox `<infobox>` block whose `source=` attributes bind to
 * the *call's* arguments. Every one of the 22 parameters the article passes is
 * bound here, plus `image_caption`, which the article does NOT pass, so the
 * `<default>` path is exercised in the same render.
 */
const TEMPLATE_LOCATION = `<infobox theme="location" layout="default">
  <title source="title"><default>{{PAGENAME}}</default></title>
  <image source="image">
    <caption source="image_caption"><default>''{{{title|}}}'' as seen from orbit.</default></caption>
    <alt source="title" />
  </image>
  <data source="type"><label>Type</label></data>
  <data source="risk_level"><label>Risk level</label></data>
  <data source="difficulty"><label>Difficulty</label></data>
  <data source="cost"><label>Route cost</label><format>{{{cost}}} credits</format></data>
  <group>
    <header>Interior</header>
    <data source="map_layout"><label>Map layout</label></data>
    <data source="map_size_multiplier"><label>Map size</label><format>{{{map_size_multiplier}}}x</format></data>
  </group>
  <group>
    <header>Conditions</header>
    <data source="weather"><label>Weather</label></data>
    <data source="min_scrap"><label>Min scrap</label></data>
    <data source="max_scrap"><label>Max scrap</label></data>
  </group>
  <group>
    <header>Hazards</header>
    <data source="turrets"><label>Turrets</label></data>
    <data source="landmines"><label>Landmines</label></data>
    <data source="spike_traps"><label>Spike traps</label></data>
  </group>
  <group>
    <header>Power</header>
    <data source="power_count"><label>Indoor power</label></data>
    <data source="outside_power_count"><label>Outdoor power</label></data>
    <data source="daytime_power_count"><label>Daytime power</label></data>
  </group>
  <group>
    <header>Spawn deviation</header>
    <data source="indoor_spawn_deviation"><label>Indoor</label></data>
    <data source="outdoor_spawn_deviation"><label>Outdoor</label></data>
    <data source="daytime_spawn_deviation"><label>Daytime</label></data>
  </group>
  <group>
    <header>Diversity</header>
    <data source="diversity_level"><label>Interior diversity</label></data>
    <data source="outside_diversity_level"><label>Exterior diversity</label></data>
  </group>
</infobox>`;

/** Every parameter the article passes to `{{Location}}` (fixture lines 1–22). */
const LOCATION_PARAMS = [
  "title",
  "type",
  "risk_level",
  "difficulty",
  "cost",
  "map_layout",
  "map_size_multiplier",
  "weather",
  "min_scrap",
  "max_scrap",
  "turrets",
  "landmines",
  "power_count",
  "outside_power_count",
  "image",
  "daytime_power_count",
  "indoor_spawn_deviation",
  "outdoor_spawn_deviation",
  "daytime_spawn_deviation",
  "spike_traps",
  "diversity_level",
  "outside_diversity_level",
] as const;

/** Simple stubs — the article only needs them to exist and expand. */
const TEMPLATE_MAP_ARTIFICE = `[[File:ArtificeMapBirdView.png|thumb|center|Artifice, main entrance and fire exit.]]`;
const TEMPLATE_MOONS = `''Moons:'' [[Adamance]] · [[Artifice]] · [[Experimentation]]`;

const TEMPLATES: Record<string, string> = {
  "10:Location": TEMPLATE_LOCATION,
  "10:Map:Artifice": TEMPLATE_MAP_ARTIFICE,
  "10:Moons": TEMPLATE_MOONS,
};

/**
 * Pages that exist. Deliberately small: most of the article's ~39 wikilinks
 * point at pages this store does NOT have, which is what makes the red-link
 * class assertion meaningful.
 */
const EXISTING_PAGES = new Set<string>([
  ...Object.keys(TEMPLATES),
  "0:Artifice",
  "0:Adamance",
  "0:Moons",
  "0:Terminal",
  "14:Destinations",
]);

/** Natural dimensions for every file the article references (decisions O6 keys). */
const FILES: Record<string, { src: string; width: number; height: number }> = {
  "artifice-moon.png": { src: "/api/media/artifice-moon.png", width: 400, height: 300 },
  "artifice.png": { src: "/api/media/artifice.png", width: 800, height: 600 },
  "artifice-flooded-timelapse.gif": {
    src: "/api/media/artifice-flooded-timelapse.gif",
    width: 960,
    height: 540,
  },
  "artifice-entity-spawn-curve.png": {
    src: "/api/media/artifice-entity-spawn-curve.png",
    width: 800,
    height: 600,
  },
  "artificemapbirdview.png": {
    src: "/api/media/artificemapbirdview.png",
    width: 1200,
    height: 800,
  },
  "artificebuilding1.png": {
    src: "/api/media/artificebuilding1.png",
    width: 640,
    height: 480,
  },
  "artificeconcept.png": { src: "/api/media/artificeconcept.png", width: 640, height: 480 },
};

/* ---------------------------------------------------------------- */
/* Context                                                           */
/* ---------------------------------------------------------------- */

function makeConfig(): WikiConfig {
  return {
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
}

function makeCtx(): ParseContext {
  return {
    config: makeConfig(),
    store: {
      getSource: (key) => TEMPLATES[key] ?? null,
      exists: (key) => EXISTING_PAGES.has(key),
      getFile: (name) => FILES[name] ?? null,
    },
    page: { namespace: 0, pageName: "Artifice" },
    version: null,
    versions: { byId: {}, ordered: [], defaultId: "v1" },
  };
}

/** Parsed once — every assertion reads the same render (§14.11 determinism). */
const result: ParseResult = parse(ARTICLE, makeCtx());
const html = result.html;

function matchAll(re: RegExp): string[] {
  return [...html.matchAll(re)].map((m) => m[0]);
}

/* ---------------------------------------------------------------- */
/* The article parses cleanly                                        */
/* ---------------------------------------------------------------- */

describe("fixture: 68-Artifice (Fandom)", () => {
  it("parses a real Fandom article with zero warnings", () => {
    expect(result.meta.warnings).toEqual([]);
  });

  it("is deterministic: a second parse is byte-identical (§14.11)", () => {
    expect(parse(ARTICLE, makeCtx()).html).toBe(html);
  });
});

/* ---------------------------------------------------------------- */
/* G5 — portable infobox                                             */
/* ---------------------------------------------------------------- */

describe("G5 portable infobox", () => {
  const aside = html.match(/<aside class="portable-infobox[\s\S]*?<\/aside>/)?.[0] ?? "";

  it("renders exactly one <aside class=\"portable-infobox\"> with theme + layout", () => {
    expect(matchAll(/<aside class="portable-infobox/g)).toHaveLength(1);
    expect(aside).toContain(
      '<aside class="portable-infobox pi-background pi-border-color pi-theme-location pi-layout-default">',
    );
  });

  it('shows the title "68-Artifice" from source="title"', () => {
    expect(aside).toContain(
      '<h2 class="pi-item pi-item-spacing pi-title" data-source="title">68-Artifice</h2>',
    );
  });

  it('shows the risk level "S++"', () => {
    expect(aside).toContain(
      '<div class="pi-item pi-data pi-item-spacing" data-source="risk_level">' +
        '<h3 class="pi-data-label pi-secondary-font">Risk level</h3>' +
        '<div class="pi-data-value pi-font">S++</div></div>',
    );
  });

  it("shows cost 1500, run through the <format> template", () => {
    expect(aside).toContain(
      '<div class="pi-item pi-data pi-item-spacing" data-source="cost">' +
        '<h3 class="pi-data-label pi-secondary-font">Route cost</h3>' +
        '<div class="pi-data-value pi-font">1500 credits</div></div>',
    );
  });

  it("keeps the THREE-LINE map layout as three <br />-joined lines", () => {
    expect(aside).toContain(
      '<div class="pi-data-value pi-font">' +
        "Mineshaft (49.77%)<br />Mansion (35.28%)<br />Factory (14.95%)" +
        "</div>",
    );
  });

  it("binds every one of the 22 parameters the article passes", () => {
    // `image` and `title` are not `<data>` rows; the rest each own one.
    for (const param of LOCATION_PARAMS) {
      if (param === "image") continue;
      expect(aside).toContain(`data-source="${param}"`);
    }
    expect(aside).toContain('<figure class="pi-item pi-image">');
  });

  it("draws the infobox image through the ordinary file-link renderer", () => {
    expect(aside).toContain(
      '<img class="pi-image-thumbnail" src="/api/media/artifice-moon.png" ' +
        'alt="68-Artifice" width="400" height="300" />',
    );
  });

  it("falls back to <default> for the caption the article never passes", () => {
    expect(aside).toContain(
      '<figcaption class="pi-item-spacing pi-caption"><i>68-Artifice</i> as seen from orbit.</figcaption>',
    );
  });

  it("emits no inline styles or colors (theme.md owns every token)", () => {
    expect(aside).not.toMatch(/style="/);
    expect(aside).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });
});

/* ---------------------------------------------------------------- */
/* G1 — image sizes (§5.9 resize group)                              */
/* ---------------------------------------------------------------- */

describe("G1 image sizes", () => {
  it("[[File:Artifice_entity_spawn_curve.png|1100px]] produces width=\"1100\"", () => {
    expect(html).toContain(
      '<img src="/api/media/artifice-entity-spawn-curve.png" ' +
        'alt="Artifice entity spawn curve.png" width="1100" height="825" />',
    );
  });

  it("the 480x480px timelapse gets BOTH dimensions, as a bounding box", () => {
    // 960×540 fitted into 480×480 ⇒ scale = min(0.5, 0.888…) = 0.5.
    expect(html).toContain(
      '<img src="/api/media/artifice-flooded-timelapse.gif" ' +
        'alt="Time-lapse of flooding on Artifice." width="480" height="270" />',
    );
  });

  it("every <img> on the page carries explicit width and height", () => {
    const imgs = matchAll(/<img\b[^>]*>/g);
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of imgs) {
      expect(img).toMatch(/\bwidth="\d+"/);
      expect(img).toMatch(/\bheight="\d+"/);
    }
  });
});

/* ---------------------------------------------------------------- */
/* G2 — interlanguage links                                          */
/* ---------------------------------------------------------------- */

describe("G2 interlanguage links", () => {
  it("[[ru:Artifice]] does NOT appear in the HTML", () => {
    expect(html).not.toContain("ru:Artifice");
    expect(html).not.toMatch(/href="[^"]*\bru\b[^"]*"/);
  });

  it("[[ru:Artifice]] IS recorded in meta.languageLinks", () => {
    expect(result.meta.languageLinks).toEqual([{ lang: "ru", title: "Artifice" }]);
  });

  it("swallowing it leaves no stray empty paragraph at the end", () => {
    expect(html).not.toMatch(/<p>\s*<\/p>\s*$/);
  });
});

/* ---------------------------------------------------------------- */
/* G3 — ref ordering with a deferred (gallery-caption) ref            */
/* ---------------------------------------------------------------- */

describe("G3 reference ordering", () => {
  const lists = matchAll(/<ol class="references">[\s\S]*?<\/ol>/g);

  it("renders exactly ONE <ol class=\"references\">", () => {
    expect(lists).toHaveLength(1);
  });

  it("that list contains the ref written inside the <gallery> caption", () => {
    expect(lists[0]).toContain("https://www.patreon.com/posts/version-50-post-101884472");
  });

  it("holds every distinct note on the page, in usage order", () => {
    const items = [...lists[0].matchAll(/<li id="cite_note-[^"]*">/g)];
    expect(items).toHaveLength(4);
    // The named ref used twice (article body + image caption) is one note
    // carrying two backlinks.
    expect(lists[0]).toContain('id="cite_note-:02-1"');
    expect(lists[0]).toContain('href="#cite_ref-:02-1-0"');
    expect(lists[0]).toContain('href="#cite_ref-:02-1-1"');
  });

  it("emits no \"missing <references />\" maintenance note", () => {
    expect(html).not.toContain("mw-ref-warning");
  });
});

/* ---------------------------------------------------------------- */
/* G4 — red-link class consistency                                   */
/* ---------------------------------------------------------------- */

describe("G4 red links", () => {
  it("every red link on the page uses the SAME class", () => {
    const classes = [...html.matchAll(/<a\b[^>]*\bclass="([^"]*\bnew\b[^"]*)"/g)].map(
      (m) => m[1],
    );
    expect(classes.length).toBeGreaterThan(10);
    expect([...new Set(classes)]).toEqual(["new red-link"]);
  });

  it("[[Guide:Camera duty|camera duty]] is a red link keeping its label", () => {
    expect(html).toContain(
      '<a href="/wiki/guidecamera-duty?redlink=1" class="new red-link" ' +
        'title="Guide:Camera duty (page does not exist)">camera duty</a>',
    );
  });

  it("existing pages are NOT red", () => {
    expect(html).toMatch(/<a href="\/wiki\/adamance"[^>]*>/);
    expect(html).not.toMatch(/<a href="\/wiki\/adamance\?redlink=1"/);
  });
});

/* ---------------------------------------------------------------- */
/* Tables, gallery, categories                                       */
/* ---------------------------------------------------------------- */

describe("tables", () => {
  it("keeps class=\"sortable\" on every sortable table the article declares", () => {
    const declared = [...ARTICLE.matchAll(/^\{\|\s*class="([^"]*\bsortable\b[^"]*)"/gm)];
    expect(declared).toHaveLength(3);

    const rendered = [...html.matchAll(/<table class="([^"]*)"/g)].map((m) => m[1]);
    expect(rendered.filter((c) => /\bsortable\b/.test(c))).toHaveLength(3);
    // The classes survive verbatim, Fandom's `fandom-table` included.
    expect(rendered).toContain("sortable fandom-table");
    expect(rendered.filter((c) => c === "wikitable sortable")).toHaveLength(2);
  });
});

describe("gallery (§10.4)", () => {
  it("renders all THREE items", () => {
    expect(matchAll(/<li class="gallerybox"/g)).toHaveLength(3);
    expect(html).toContain('<div class="gallerytext">Artifice from a bird eye view</div>');
    expect(html).toContain("<div class=\"gallerytext\">Artifice's first building</div>");
  });
});

describe("categories (§5.10)", () => {
  it("collects [[Category:Destinations]] into meta, not into the HTML", () => {
    expect(result.meta.categories).toEqual([{ name: "Destinations", sortKey: null }]);
    expect(html).not.toContain("Category:Destinations");
  });
});

/* ---------------------------------------------------------------- */
/* Templates                                                         */
/* ---------------------------------------------------------------- */

describe("templates", () => {
  it("records all three templates the article transcludes", () => {
    const used = result.meta.templatesUsed.map((t) =>
      typeof t === "string" ? t : (t as { title: string }).title,
    );
    expect(used.join("|")).toContain("Location");
    expect(used.join("|")).toContain("Map:Artifice");
    expect(used.join("|")).toContain("Moons");
  });

  it("expands the {{Map:Artifice}} and {{moons}} stubs into the page", () => {
    expect(html).toContain("Artifice, main entrance and fire exit.");
    expect(html).toContain("Experimentation");
  });
});

/* ---------------------------------------------------------------- */
/* Raw block HTML the article wraps content in (§3.1 rule 4)         */
/* ---------------------------------------------------------------- */

describe("wrapper divs", () => {
  it("keeps the terminal-text block's content INSIDE the styled div", () => {
    const div = html.match(/<div class="terminal-text">[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(div).toContain("<p>68-Artifice</p>");
    expect(div).toContain("CONDITIONS:");
    expect(div).toContain("FAUNA:");
    // The wrapper must never render empty with its content spilled after it.
    expect(html).not.toContain('<div class="terminal-text"></div>');
  });
});
