/**
 * Fandom PORTABLE INFOBOX — `<infobox>` (spec "Fandom extensions" →
 * "Portable infobox (`<infobox>`)", extending §10 / §14.3 / §14.8).
 *
 * Two levels are covered:
 *
 *   - the PURE layer (`parseInfoboxMarkup`, `parseInfoboxImageValue`), tested
 *     directly because tolerance to malformed markup is a contract, not an
 *     accident;
 *   - the WIRED layer, tested through the real `parse()` so the assertions
 *     also pin the integration: preprocessor registration (§10 — never escaped
 *     as raw HTML), stage-2 frame binding (§14.3 — `source=` reads the template
 *     call's arguments), the block-level strip marker (§14.8 — no stray `<p>`)
 *     and stage-6 rendering (values are wikitext, sanitized like every other
 *     deferred fragment).
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DEFAULT_NAMESPACES } from "@/lib/title";

import { parse } from "./index";
import { parseInfoboxImageValue, parseInfoboxMarkup } from "./portable-infobox";
import { EXT_TAGS } from "./preprocessor";
import type { PageStore, ParseContext, Title, WikiConfig } from "./types";

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

/** A Fandom-shaped moon infobox exercising every element the spec table lists. */
const LOCATION_TEMPLATE = `<infobox theme="moon" layout="stacked">
  <title source="title"><default>{{PAGENAME}}</default></title>
  <image source="image">
    <caption source="caption"/>
  </image>
  <data source="risk_level"><label>Risk level</label></data>
  <data source="difficulty"><label>Difficulty</label><default>Unknown</default></data>
  <data source="cost"><label>Cost</label><format>{{{cost}}} credits</format></data>
  <group collapse="open">
    <header>Layout</header>
    <data source="map_layout"><label>Interiors</label></data>
    <data source="map_size_multiplier"><label>Map size</label></data>
  </group>
  <group>
    <header>Scrap</header>
    <data source="min_scrap"><label>Min scrap</label></data>
    <data source="max_scrap"><label>Max scrap</label></data>
  </group>
  <navigation>[[Moons|All moons]]</navigation>
</infobox>`;

const SOURCES: Record<string, string> = {
  "10:Location": LOCATION_TEMPLATE,
  "10:Credits": "{{{1}}} credits",
  "10:Moonlink": "[[Moons|moon]]",
  "10:Boxed":
    "<infobox><data source=\"n\"><label>N</label><default>none</default>" +
    "<format>{{Credits|{{{n}}}}}</format></data></infobox>",
  "10:Themed": "<infobox theme-source=\"skin\"><title source=\"t\"/></infobox>",
  "10:Formatted":
    "<infobox><title source=\"t\"><format>The {{{t}}} moon</format>" +
    "<default>none</default></title></infobox>",
};

/** Files are looked up by their SLUGIFIED name (decisions O6), not by title. */
const FILES: Record<string, { src: string; width: number; height: number }> = {
  "artifice-moon.png": { src: "/api/media/artifice-moon.png", width: 400, height: 300 },
};

const store: PageStore = {
  getSource: (title) => SOURCES[title] ?? null,
  exists: (title) => title in SOURCES || title === "0:Moons",
  getFile: (name) => FILES[name] ?? null,
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

function ctxFor(page: Title = { namespace: 0, pageName: "68-Artifice" }): ParseContext {
  return {
    config,
    store,
    page,
    version: null,
    versions: { byId: {}, ordered: [], defaultId: "v70" },
  };
}

/** Render article wikitext, return the HTML. */
function html(source: string, page?: Title): string {
  return parse(source, ctxFor(page)).html;
}

/** `<aside class="portable-infobox…">…</aside>`, or "" when none was rendered. */
function aside(out: string): string {
  const start = out.indexOf('<aside class="portable-infobox');
  if (start < 0) return "";
  return out.slice(start, out.indexOf("</aside>", start) + "</aside>".length);
}

/** The inner HTML of the `<data source="…">` row, or null when there is no row. */
function row(out: string, source: string): string | null {
  const re = new RegExp(
    `<div class="pi-item pi-data pi-item-spacing" data-source="${source}">([\\s\\S]*?)</div></div>`,
  );
  const m = re.exec(out);
  return m === null ? null : `${m[1]}</div>`;
}

/* ------------------------------------------------------------------ */
/* 1. Registration (§10) — parser-level markup, never raw HTML          */
/* ------------------------------------------------------------------ */

describe("<infobox> registration (§10)", () => {
  it("is a registered extension tag, so §10.7 never escapes it", () => {
    expect(EXT_TAGS).toContain("infobox");
  });

  it("does not leak its markup as literal text", () => {
    const out = html("<infobox><title>Hi</title></infobox>");
    expect(out).not.toContain("&lt;infobox");
    expect(out).not.toContain("&lt;title");
    expect(out).toContain('<aside class="portable-infobox');
  });

  it("is block-level: never wrapped in the paragraph of its line (§14.8)", () => {
    const out = html("<infobox><title>Hi</title></infobox>\n\nAfter.");
    expect(out.startsWith('<aside class="portable-infobox')).toBe(true);
    expect(out).toContain("<p>After.</p>");
  });

  it("parses with zero warnings", () => {
    const res = parse(LOCATION_TEMPLATE, ctxFor({ namespace: 10, pageName: "Location" }));
    expect(res.meta.warnings).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 2. The markup tree (pure)                                           */
/* ------------------------------------------------------------------ */

describe("parseInfoboxMarkup", () => {
  it("reads attributes and nests groups", () => {
    const tree = parseInfoboxMarkup(
      '<group collapse="closed"><header>H</header><data source="a"/></group>',
    );
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("group");
    expect(tree[0].attrs.collapse).toBe("closed");
    expect(tree[0].children.map((c) => c.name)).toEqual(["header", "data"]);
  });

  it("keeps leaf content VERBATIM, so wikitext and HTML inside survive", () => {
    const tree = parseInfoboxMarkup("<data><default>a <b>b</b> [[c]] {{d}}</default></data>");
    expect(tree[0].children[0].text).toBe("a <b>b</b> [[c]] {{d}}");
  });

  it("treats a tag that is not legal in this parent as ordinary text", () => {
    // `<span>` is not an infobox element, so it stays wikitext for §11 to judge.
    const tree = parseInfoboxMarkup("<data><label><span>x</span></label></data>");
    expect(tree[0].children[0].text).toBe("<span>x</span>");
  });

  it("accepts self-closing elements", () => {
    const tree = parseInfoboxMarkup('<image source="i"><caption source="c"/></image>');
    expect(tree[0].children[0].name).toBe("caption");
    expect(tree[0].children[0].attrs.source).toBe("c");
  });

  it("tolerates an unclosed element rather than throwing (§10)", () => {
    const tree = parseInfoboxMarkup("<data><label>L</label>");
    expect(tree[0].name).toBe("data");
    expect(tree[0].children[0].text).toBe("L");
  });

  it("tolerates a stray close tag", () => {
    expect(() => parseInfoboxMarkup("</group><data source='a'/>")).not.toThrow();
    expect(parseInfoboxMarkup("</group><data source='a'/>")).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Element coverage — every element type, bound to a template call   */
/* ------------------------------------------------------------------ */

describe("element coverage", () => {
  const call = html(
    "{{Location|title=68-Artifice|risk_level=S++|cost=1500|image=Artifice_Moon.png" +
      "|caption=The moon|map_layout=Mineshaft|map_size_multiplier=1.8" +
      "|min_scrap=26|max_scrap=30}}",
  );

  it("<title> renders .pi-title carrying its data-source", () => {
    expect(call).toContain(
      '<h2 class="pi-item pi-item-spacing pi-title" data-source="title">68-Artifice</h2>',
    );
  });

  it("<image> renders a .pi-image figure holding a .pi-image-thumbnail img", () => {
    expect(call).toContain('<figure class="pi-item pi-image">');
    expect(call).toContain('<img class="pi-image-thumbnail" src="/api/media/artifice-moon.png"');
  });

  it("<caption> renders .pi-caption inside the figure", () => {
    expect(call).toContain('<figcaption class="pi-item-spacing pi-caption">The moon</figcaption>');
  });

  it("<data> renders .pi-data with .pi-data-label and .pi-data-value", () => {
    expect(row(call, "risk_level")).toBe(
      '<h3 class="pi-data-label pi-secondary-font">Risk level</h3>' +
        '<div class="pi-data-value pi-font">S++</div>',
    );
  });

  it("<header> renders .pi-header", () => {
    expect(call).toContain('class="pi-item pi-header pi-secondary-font');
    expect(call).toContain(">Layout</h2>");
  });

  it("<group> renders a .pi-group section wrapping its rows", () => {
    expect(call).toContain('<section class="pi-item pi-group pi-border-color');
  });

  it("<navigation> renders .pi-navigation with its wikitext parsed", () => {
    expect(call).toContain('<nav class="pi-item pi-navigation');
    expect(call).toContain('<a href="/wiki/moons" title="Moons">All moons</a>');
  });

  it("<panel> and <section> are treated as groups", () => {
    const panel = html("<infobox><panel><data source='x'><default>1</default></data></panel></infobox>");
    expect(panel).toContain('<section class="pi-item pi-group');
    const section = html(
      "<infobox><section><data source='x'><default>2</default></data></section></infobox>",
    );
    expect(section).toContain('<section class="pi-item pi-group');
  });

  it("a <data> with no <label> renders the value alone", () => {
    const out = html("<infobox><data source='x'><default>bare</default></data></infobox>");
    expect(out).toContain('<div class="pi-data-value pi-font">bare</div>');
    expect(out).not.toContain("pi-data-label");
  });

  it("nests a group inside a group", () => {
    const out = html(
      "<infobox><group><header>Outer</header>" +
        "<group><data source='x'><default>deep</default></data></group>" +
        "</group></infobox>",
    );
    expect(out.match(/pi-group/g)).toHaveLength(2);
    expect(out).toContain(">deep</div>");
  });
});

/* ------------------------------------------------------------------ */
/* 4. THE EMPTY RULE                                                    */
/* ------------------------------------------------------------------ */

describe("the empty rule", () => {
  it("drops a <data> whose source was not supplied", () => {
    const out = html("{{Location|title=X|risk_level=S++}}");
    expect(row(out, "risk_level")).not.toBeNull();
    expect(row(out, "map_layout")).toBeNull();
  });

  it("drops a <data> whose source is present but whitespace-only", () => {
    const out = html("{{Location|title=X|risk_level=   }}");
    expect(row(out, "risk_level")).toBeNull();
  });

  it("drops a <group> whose data rows are all empty — its header included", () => {
    const out = html("{{Location|title=X|risk_level=S++}}");
    expect(out).not.toContain(">Scrap</h2>");
    expect(out).not.toContain(">Layout</h2>");
  });

  it("keeps a group as soon as ONE row survives", () => {
    const out = html("{{Location|title=X|min_scrap=26}}");
    expect(out).toContain(">Scrap</h2>");
    expect(row(out, "min_scrap")).not.toBeNull();
    expect(row(out, "max_scrap")).toBeNull();
  });

  it('show="incomplete" keeps the empty rows, and their labels', () => {
    const out = html(
      "<infobox><group show='incomplete'><header>H</header>" +
        "<data source='a'><label>A</label></data></group></infobox>",
    );
    expect(out).toContain(">H</h2>");
    expect(out).toContain('<h3 class="pi-data-label pi-secondary-font">A</h3>');
    expect(out).toContain('<div class="pi-data-value pi-font"></div>');
  });

  it('show="incomplete" is per-group and is NOT inherited by a nested group', () => {
    const out = html(
      "<infobox><group show='incomplete'><data source='a'><label>A</label></data>" +
        "<group><data source='b'><label>B</label></data></group></group></infobox>",
    );
    expect(out).toContain(">A</h3>");
    expect(out).not.toContain(">B</h3>");
  });

  it("renders NOTHING at all when every item resolved empty", () => {
    expect(html("<infobox><data source='a'/><data source='b'/></infobox>")).toBe("");
  });

  it("drops an <image> whose source is absent instead of emitting an empty figure", () => {
    const out = html("{{Location|title=X|risk_level=S++}}");
    expect(out).not.toContain("pi-image");
  });
});

/* ------------------------------------------------------------------ */
/* 5. <default> and <format>                                            */
/* ------------------------------------------------------------------ */

describe("<default> and <format>", () => {
  it("uses <default> when the source is absent", () => {
    const out = html("{{Location|title=X|risk_level=S++}}");
    expect(row(out, "difficulty")).toContain(">Unknown<");
  });

  it("prefers the supplied value over <default>", () => {
    const out = html("{{Location|title=X|difficulty=Hard}}");
    expect(row(out, "difficulty")).toContain(">Hard<");
  });

  it("<default> is wikitext, expanded in the frame", () => {
    // <title>'s default is {{PAGENAME}} — the ARTICLE's name, not the template's.
    expect(html("{{Location|risk_level=S++}}")).toContain(">68-Artifice</h2>");
  });

  it("applies <format> when the source has a value", () => {
    expect(row(html("{{Location|title=X|cost=1500}}"), "cost")).toContain(">1500 credits<");
  });

  it("does NOT apply <format> when the source is empty (no stray 'credits')", () => {
    const out = html("{{Location|title=X|cost=}}");
    expect(row(out, "cost")).toBeNull();
    expect(out).not.toContain("credits");
  });

  it("<format> may itself call a template, with {{{source}}} available", () => {
    expect(row(html("{{Boxed|n=42}}"), "n")).toContain(">42 credits<");
  });

  it("falls back to <default> — not <format> — when that source is missing", () => {
    expect(row(html("{{Boxed}}"), "n")).toContain(">none<");
  });

  it("<title> honors <format> too", () => {
    const out = html(
      "<infobox><title source='t'><format>The {{{t}}} moon</format><default>none</default></title></infobox>",
    );
    expect(out).toContain(">none</h2>"); // no arg on an article page ⇒ default
    expect(html("{{Formatted|t=Artifice}}")).toContain(">The Artifice moon</h2>");
  });
});

/* ------------------------------------------------------------------ */
/* 6. Values are WIKITEXT                                               */
/* ------------------------------------------------------------------ */

describe("values are wikitext", () => {
  it("renders [[links]] in a value", () => {
    const out = html("{{Location|title=X|risk_level=[[Moons|Moon]]}}");
    expect(row(out, "risk_level")).toContain('<a href="/wiki/moons" title="Moons">Moon</a>');
  });

  it("renders '''bold''' and ''italic'' in a value", () => {
    const out = html("{{Location|title=X|risk_level='''S''' and ''x''}}");
    expect(row(out, "risk_level")).toContain("<b>S</b> and <i>x</i>");
  });

  it("expands a template inside a value", () => {
    const out = html("{{Location|title=X|risk_level={{Moonlink}}}}");
    expect(row(out, "risk_level")).toContain('<a href="/wiki/moons" title="Moons">moon</a>');
  });

  it("keeps MULTI-LINE values as separate lines", () => {
    const out = html("{{Location|title=X|map_layout=One\nTwo\nThree}}");
    expect(row(out, "map_layout")).toContain("One<br />Two<br />Three");
  });

  it("parses wikitext on EVERY line of a multi-line value", () => {
    const out = html("{{Location|title=X|map_layout='''A'''\n[[Moons|B]]}}");
    expect(row(out, "map_layout")).toContain(
      '<b>A</b><br /><a href="/wiki/moons" title="Moons">B</a>',
    );
  });

  it("<label> is wikitext too", () => {
    const out = html(
      "<infobox><data source='a'><label>''L''</label><default>v</default></data></infobox>",
    );
    expect(out).toContain('<h3 class="pi-data-label pi-secondary-font"><i>L</i></h3>');
  });

  it("sanitizes a value: disallowed raw HTML is escaped, never executed (§11)", () => {
    const out = html("{{Location|title=X|risk_level=<script>alert(1)</script>}}");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;script&gt;");
  });

  it("registers a <ref> written inside a value, in the page-wide list (§10.3)", () => {
    const res = parse(
      [
        "{{Location|title=X|risk_level=S++<ref>rated by the crew</ref>}}",
        "",
        "<references />",
      ].join("\n"),
      ctxFor(),
    );
    expect(row(res.html, "risk_level")).toContain('class="reference"');
    expect(res.html).toContain("rated by the crew");
    expect(res.html.match(/<ol class="references">/g)).toHaveLength(1);
    expect(res.meta.warnings).toEqual([]);
  });

  it("keeps a red link red inside a value", () => {
    const out = html("{{Location|title=X|risk_level=[[Nowhere]]}}");
    expect(row(out, "risk_level")).toContain('class="new red-link"');
  });
});

/* ------------------------------------------------------------------ */
/* 7. Images: bare name and link form                                   */
/* ------------------------------------------------------------------ */

describe("<image> value forms", () => {
  it("parseInfoboxImageValue accepts a bare filename", () => {
    expect(parseInfoboxImageValue("Artifice_Moon.png")).toEqual({
      file: "Artifice_Moon.png",
      options: [],
    });
  });

  it("parseInfoboxImageValue accepts [[File:…]] with options", () => {
    expect(parseInfoboxImageValue("[[File:X.png|250px|alt=A]]")).toEqual({
      file: "X.png",
      options: ["250px", "alt=A"],
    });
  });

  it("parseInfoboxImageValue accepts the prefix-less link form", () => {
    expect(parseInfoboxImageValue("[[Artifice_Moon.png]]")?.file).toBe("Artifice_Moon.png");
  });

  it("parseInfoboxImageValue normalizes the Image:/:File: spellings", () => {
    expect(parseInfoboxImageValue("[[Image:X.png]]")?.file).toBe("X.png");
    expect(parseInfoboxImageValue("[[:File:X.png]]")?.file).toBe("X.png");
  });

  it("<alt> supplies the img's alt text", () => {
    const out = html(
      "<infobox><image source='i'><default>Artifice_Moon.png</default>" +
        "<alt>A barren moon</alt></image></infobox>",
    );
    expect(out).toContain('alt="A barren moon"');
  });

  it("drops options that are neither size, alt nor link", () => {
    expect(parseInfoboxImageValue("[[File:X.png|thumb|left|120px]]")?.options).toEqual(["120px"]);
  });

  it("returns null for an empty value", () => {
    expect(parseInfoboxImageValue("   ")).toBeNull();
  });

  it("renders the SAME image from a bare name and from [[File:…]]", () => {
    const bare = aside(html("{{Location|image=Artifice_Moon.png}}"));
    const link = aside(html("{{Location|image=[[File:Artifice_Moon.png]]}}"));
    expect(bare).toContain('src="/api/media/artifice-moon.png"');
    expect(bare).toBe(link);
  });

  it("honors a size option through the engine's file-link renderer (§5.9)", () => {
    expect(html("{{Location|image=[[File:Artifice_Moon.png|250px]]}}")).toContain('width="250"');
  });

  it("degrades a MISSING file to a red file link instead of crashing", () => {
    const out = html("{{Location|image=Ghost.png}}");
    expect(out).toContain('<figure class="pi-item pi-image">');
    expect(out).toContain('class="new red-link"');
    expect(out).toContain(">Ghost.png</a>");
  });

  it("takes the first image when the value holds several", () => {
    const out = html("{{Location|image=[[Artifice_Moon.png]]\n[[Ghost.png]]}}");
    expect(out).toContain('src="/api/media/artifice-moon.png"');
    expect(out).not.toContain("Ghost.png");
  });
});

/* ------------------------------------------------------------------ */
/* 8. Attributes                                                        */
/* ------------------------------------------------------------------ */

describe("attributes", () => {
  it("theme= and layout= become pi-theme-* / pi-layout-* classes", () => {
    const out = html("{{Location|title=X}}");
    expect(out).toContain("pi-theme-moon");
    expect(out).toContain("pi-layout-stacked");
  });

  it("defaults to pi-layout-default when no layout= is given", () => {
    expect(html("<infobox><title>T</title></infobox>")).toContain("pi-layout-default");
  });

  it("theme-source= reads the theme from a template argument", () => {
    expect(html("{{Themed|skin=dark|t=X}}")).toContain("pi-theme-dark");
  });

  it("theme-source= with no such argument leaves the theme unset", () => {
    expect(html("{{Themed|t=X}}")).not.toContain("pi-theme-");
  });

  it("collapse= adds pi-collapse / pi-collapse-open|closed", () => {
    expect(html("{{Location|map_layout=A}}")).toContain("pi-collapse pi-collapse-open");
    expect(
      html("<infobox><group collapse='closed'><data source='a'><default>1</default></data></group></infobox>"),
    ).toContain("pi-collapse pi-collapse-closed");
  });

  it("ignores a collapse= value that is neither open nor closed", () => {
    expect(
      html("<infobox><group collapse='sideways'><data source='a'><default>1</default></data></group></infobox>"),
    ).not.toContain("pi-collapse");
  });

  it("never emits inline colors or styles (theme.md: tokens only)", () => {
    const out = aside(html("{{Location|title=X|risk_level=S++|image=Artifice_Moon.png}}"));
    expect(out).not.toMatch(/ style="[^"]*(?:color|background)/);
    expect(out).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });

  it('group layout="horizontal" adds pi-horizontal-group', () => {
    expect(
      html("<infobox><group layout='horizontal'><data source='a'><default>1</default></data></group></infobox>"),
    ).toContain("pi-horizontal-group");
  });

  it("reduces a hostile theme= to a safe class token", () => {
    const out = html("<infobox theme='x\" onload=\"a'><title>T</title></infobox>");
    expect(out).toContain("pi-theme-x-onload-a");
    expect(out).not.toContain("onload=");
  });
});

/* ------------------------------------------------------------------ */
/* 9. Frame binding (§14.3)                                             */
/* ------------------------------------------------------------------ */

describe("frame binding", () => {
  it("binds source= to the TEMPLATE CALL's arguments", () => {
    expect(html("{{Location|title=Called|risk_level=S++}}")).toContain(">Called</h2>");
  });

  it("shows <default>s and skips sourced rows on the template page itself", () => {
    const out = parse(LOCATION_TEMPLATE, ctxFor({ namespace: 10, pageName: "Location" })).html;
    expect(out).toContain(">Location</h2>"); // {{PAGENAME}} default
    expect(out).toContain(">Unknown<"); // difficulty's default
    expect(row(out, "risk_level")).toBeNull(); // no arg, no default ⇒ no row
    expect(row(out, "cost")).toBeNull();
  });

  it("never leaks an unresolved {{{param}}} into the output", () => {
    const out = parse(LOCATION_TEMPLATE, ctxFor({ namespace: 10, pageName: "Location" })).html;
    expect(out).not.toContain("{{{");
  });

  it("keeps two calls of the same template independent", () => {
    const out = html("{{Location|title=A|risk_level=S}}\n\n{{Location|title=B|risk_level=A}}");
    expect(out).toContain(">A</h2>");
    expect(out).toContain(">B</h2>");
  });
});

/* ------------------------------------------------------------------ */
/* 10. End-to-end: the real Fandom article's {{Location}} call           */
/* ------------------------------------------------------------------ */

/** The fixture's `{{Location|…}}` call, taken verbatim (TEST FIXTURE ONLY). */
function fixtureLocationCall(): string {
  const fixture = readFileSync(
    new URL("../../../docs/engine/fixtures/fandom-artifice.wikitext", import.meta.url),
    "utf8",
  ).replace(/\r\n?/g, "\n");
  const start = fixture.indexOf("{{Location");
  let depth = 0;
  for (let i = start; i < fixture.length - 1; i += 1) {
    if (fixture.startsWith("{{", i)) {
      depth += 1;
      i += 1;
    } else if (fixture.startsWith("}}", i)) {
      depth -= 1;
      if (depth === 0) return fixture.slice(start, i + 2);
      i += 1;
    }
  }
  throw new Error("fixture: unterminated {{Location}} call");
}

describe("end-to-end — docs/engine/fixtures/fandom-artifice.wikitext", () => {
  const call = fixtureLocationCall();
  const result = parse(call, ctxFor());
  const out = result.html;

  it("takes the call verbatim from the fixture", () => {
    expect(call).toContain("|risk_level=S++");
    expect(call).toContain("|map_layout=Mineshaft (49.77%)\nMansion (35.28%)\nFactory (14.95%)");
    expect(call).toContain("|image=[[Artifice_Moon.png]]");
  });

  it("renders exactly one portable infobox, with no warnings", () => {
    expect(result.meta.warnings).toEqual([]);
    expect(out.match(/<aside class="portable-infobox/g)).toHaveLength(1);
  });

  it("renders the title 68-Artifice", () => {
    expect(out).toContain(
      '<h2 class="pi-item pi-item-spacing pi-title" data-source="title">68-Artifice</h2>',
    );
  });

  it("renders Risk level S++", () => {
    expect(row(out, "risk_level")).toBe(
      '<h3 class="pi-data-label pi-secondary-font">Risk level</h3>' +
        '<div class="pi-data-value pi-font">S++</div>',
    );
  });

  it("renders Cost 1500 through <format>", () => {
    expect(row(out, "cost")).toContain(">1500 credits<");
  });

  it("renders the three-line map layout as three lines", () => {
    expect(row(out, "map_layout")).toContain(
      "Mineshaft (49.77%)<br />Mansion (35.28%)<br />Factory (14.95%)",
    );
  });

  it("renders Min and Max scrap", () => {
    expect(row(out, "min_scrap")).toContain(">26<");
    expect(row(out, "max_scrap")).toContain(">30<");
  });

  it("renders the fixture's [[Artifice_Moon.png]] image", () => {
    expect(out).toContain('<img class="pi-image-thumbnail" src="/api/media/artifice-moon.png"');
  });

  it("keeps the rows the template declares and drops the ones it does not", () => {
    expect(out).toContain(">Layout</h2>");
    expect(out).toContain(">Scrap</h2>");
    expect(row(out, "difficulty")).toContain(">Hard<");
    expect(row(out, "turrets")).toBeNull(); // supplied, but no <data> declares it
  });
});
