/**
 * Version scoping through the FULL pipeline — docs/engine/versioning.md §7
 * "Integration".
 *
 * One fixture page is rendered at v50 / v55 / v62 / v70 and must differ; the
 * boundaries of branches the selection HIDES are still recorded; the §2
 * constructs are exercised where they are actually hard — inside a table cell,
 * inside a template parameter, and as an infobox `{{#vswitch}}` value — and an
 * unscoped page stays unscoped so the cache can keep serving it under `'*'`.
 *
 * The grammar under test is the one whose TAG NAME is the range: `<v70>`,
 * `<v70+v80>`, `<v70+>`. `<versions>`/`<variant>`/`<version>` are no longer
 * extension tags and render escaped (§10.7) — asserted below, because that is
 * what makes the seed conversion necessary.
 *
 * versions.ts is final: everything asserted here is the behavior of its
 * CALLERS (expand.ts stage 2, parser-functions.ts, magic-words.ts) as `parse()`
 * drives them.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_NAMESPACES } from "@/lib/title";

import { parse } from "./index";
import type {
  PageStore,
  ParseContext,
  ParseResult,
  Title,
  VersionEntry,
  VersionTable,
  WikiConfig,
} from "./types";

/* ------------------------------------------------------------------ */
/* Registry (versioning.md §1: ordinal = major*1000 + minor)           */
/* ------------------------------------------------------------------ */

const ENTRIES: VersionEntry[] = [
  { id: "v45", label: "v45", ordinal: 45_000, status: "legacy" },
  { id: "v50", label: "v50", ordinal: 50_000, status: "legacy" },
  { id: "v55", label: "v55", ordinal: 55_000, status: "legacy" },
  { id: "v61", label: "v61", ordinal: 61_000, status: "legacy" },
  { id: "v62", label: "v62", ordinal: 62_000, status: "legacy" },
  { id: "v64", label: "v64", ordinal: 64_000, status: "legacy" },
  { id: "v64.1", label: "v64 Patch 1", ordinal: 64_001, status: "supported" },
  { id: "v70", label: "v70", ordinal: 70_000, status: "current" },
];

const VERSIONS: VersionTable = {
  byId: Object.fromEntries(ENTRIES.map((e) => [e.id, e])),
  ordered: [...ENTRIES].sort((a, b) => a.ordinal - b.ordinal),
  defaultId: "v70",
};

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

/** A cut-down seed infobox: raw HTML table, conditional `{{#if:}}` rows. */
const INFOBOX_MOON = [
  '<table class="infobox">',
  '<tr><th colspan="2">{{{name|Unnamed moon}}}</th></tr>',
  "{{#if:{{{cost|}}}|<tr><th>Route cost</th><td>{{{cost}}} credits</td></tr>}}",
  "{{#if:{{{note|}}}|<tr><th>Note</th><td>{{{note}}}</td></tr>}}",
  "{{#if:{{{weather|}}}|<tr><th>Weather</th><td>{{{weather}}}</td></tr>}}",
  "</table>",
].join("\n");

const TEMPLATES: Record<string, string> = {
  "10:Infobox_moon": INFOBOX_MOON,
  "10:Echo": "[{{{1}}}]",
};

const PAGES = new Set(["0:Bracken", "0:Artifice", ...Object.keys(TEMPLATES)]);

const store: PageStore = {
  getSource: (title) => TEMPLATES[title] ?? null,
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

const PAGE: Title = { namespace: 0, pageName: "Titan" };

function ctxAt(version: string | null, preview = false): ParseContext {
  return { config, store, page: PAGE, version, versions: VERSIONS, preview };
}

function render(source: string, version: string | null): ParseResult {
  return parse(source, ctxAt(version));
}

/* ------------------------------------------------------------------ */
/* The fixture page — every §2 construct, in the awkward places        */
/* ------------------------------------------------------------------ */

/**
 * The windows are spelled with REGISTERED ids: a branch ends at the newest
 * registered version strictly below the next branch's id, so the v50 branch
 * closes at v61 (not "v62 minus one") and the scrap branch at v62.
 */
const FIXTURE = [
  // §2.4 `#vswitch` as an infobox parameter, and a version tag INSIDE a
  // template parameter (the infobox `note` row).
  "{{Infobox_moon",
  "| name = Titan",
  "| cost = {{#vswitch: v50=1400 | v62=1500 }}",
  "| note = <v50+v61>pre-Artifice</v50+v61><v62+>post-Artifice</v62+>",
  "}}",
  // §2.1 in running prose.
  "The base quota is <v50+v61>'''130''' credits</v50+v61>" +
    "<v62+>'''180''' credits</v62+>.",
  "",
  // §2.1 INSIDE a table cell.
  '{| class="wikitable"',
  "! Patch !! Scrap",
  "|-",
  "| Titan || <v50+v62>26</v50+v62><v64+>30</v64+>",
  "|}",
  "",
  // §2.5 magic word, an open-ended tag (hidden below v70, but its boundary
  // still counts) and §2.3 the range function.
  "Viewing {{VERSION}}.",
  "<v70+>Cruiser sale added.</v70+>",
  "{{#ifversion: v50-v55 | Legacy routing. | Modern routing. }}",
].join("\n");

/** The infobox `<table>…</table>` alone, for markup-validity assertions. */
function infoboxHtml(html: string): string {
  const start = html.indexOf('<table class="infobox">');
  const end = html.indexOf("</table>", start);
  return html.slice(start, end + "</table>".length);
}

function at(version: string | null): ParseResult {
  return parse(FIXTURE, ctxAt(version));
}

/**
 * versioning.md §4: unscoped pages are cached once under `'*'`; scoped pages
 * are keyed by the selection.
 */
function cacheVersionKey(result: ParseResult, ctx: ParseContext): string {
  return result.meta.versionScoped ? (ctx.version ?? ctx.versions.defaultId) : "*";
}

/* ------------------------------------------------------------------ */

describe("versioning §7 — one page, four selections", () => {
  it("v50 shows the earliest branch of every construct", () => {
    const out = at("v50").html;
    expect(out).toContain("<td>1400 credits</td>");
    expect(out).toContain("<td>pre-Artifice</td>");
    expect(out).toContain("The base quota is <b>130</b> credits.");
    expect(out).toContain("<td>26</td>");
    expect(out).toContain("Viewing v50.");
    expect(out).toContain("Legacy routing.");
    expect(out).not.toContain("Cruiser sale added.");
  });

  it("v55 still sits in the v50–v61 window", () => {
    const out = at("v55").html;
    expect(out).toContain("<td>1400 credits</td>");
    expect(out).toContain("The base quota is <b>130</b> credits.");
    expect(out).toContain("<td>26</td>");
    expect(out).toContain("Viewing v55.");
    expect(out).toContain("Legacy routing.");
  });

  it("v62 crosses the quota/cost boundary but not the scrap one", () => {
    const out = at("v62").html;
    expect(out).toContain("<td>1500 credits</td>");
    expect(out).toContain("<td>post-Artifice</td>");
    expect(out).toContain("The base quota is <b>180</b> credits.");
    expect(out).toContain("<td>26</td>"); // v64 boundary not reached yet
    expect(out).toContain("Viewing v62.");
    expect(out).toContain("Modern routing.");
    expect(out).not.toContain("Cruiser sale added.");
  });

  it("v70 shows the newest branch everywhere", () => {
    const out = at("v70").html;
    expect(out).toContain("<td>1500 credits</td>");
    expect(out).toContain("The base quota is <b>180</b> credits.");
    expect(out).toContain("<td>30</td>");
    expect(out).toContain("Viewing v70.");
    expect(out).toContain("Cruiser sale added.");
    expect(out).toContain("Modern routing.");
  });

  it("the four renderings are pairwise different HTML", () => {
    const rendered = ["v50", "v55", "v62", "v70"].map((v) => at(v).html);
    expect(new Set(rendered).size).toBe(4);
  });

  it("is deterministic: the same selection renders byte-identically (§14.11)", () => {
    expect(at("v62").html).toBe(at("v62").html);
  });
});

describe("versioning §2.1 — the three forms, rendered", () => {
  const FORMS = "<v50>fifty</v50><v55+v62>window</v55+v62><v64+>onwards</v64+>";

  const text = (version: string) => render(FORMS, version).html;

  it("<v50> applies to that version and to nothing else", () => {
    expect(text("v50")).toContain("fifty");
    expect(text("v45")).not.toContain("fifty");
    expect(text("v55")).not.toContain("fifty");
  });

  it("<v55+v62> includes both ends and nothing outside them", () => {
    expect(text("v50")).not.toContain("window");
    expect(text("v55")).toContain("window");
    expect(text("v61")).toContain("window");
    expect(text("v62")).toContain("window");
    expect(text("v64")).not.toContain("window");
  });

  it("<v64+> runs to every later version", () => {
    expect(text("v62")).not.toContain("onwards");
    expect(text("v64")).toContain("onwards");
    expect(text("v64.1")).toContain("onwards");
    expect(text("v70")).toContain("onwards");
  });

  it("a version below every branch renders an empty page, not a placeholder", () => {
    expect(render(FORMS, "v45").html).toBe("");
  });

  it("untagged prose belongs to every version — what the `*` fallback was for", () => {
    const source = "Quota applies.<v62+> Cruiser too.</v62+>";
    expect(render(source, "v45").html).toBe("<p>Quota applies.</p>");
    expect(render(source, "v70").html).toBe("<p>Quota applies. Cruiser too.</p>");
  });
});

describe("versioning §2.1 — minor versions are first-class ids", () => {
  const SOURCE = "<v64.1>patch only</v64.1><v64.1+>patch onwards</v64.1+>";

  it("v64 is below v64.1, and v64.1 is below v70 (ordinal, not string)", () => {
    expect(render(SOURCE, "v64").html).toBe("");
    const patch = render(SOURCE, "v64.1").html;
    expect(patch).toContain("patch only");
    expect(patch).toContain("patch onwards");
    const later = render(SOURCE, "v70").html;
    expect(later).not.toContain("patch only");
    expect(later).toContain("patch onwards");
  });

  it("records the minor id as a boundary", () => {
    expect(render(SOURCE, "v50").meta.versionBoundaries).toEqual(["v64.1"]);
  });
});

describe("versioning §2.1 — a window whose ends are inverted", () => {
  const SOURCE = "before<v70+v50>never</v70+v50>after";

  it("renders nothing rather than guessing which end the author meant", () => {
    for (const v of ["v45", "v50", "v62", "v70"]) {
      expect(render(SOURCE, v).html).toBe("<p>beforeafter</p>");
    }
  });

  it("still records both ids — the page named them", () => {
    expect(render(SOURCE, "v62").meta.versionBoundaries).toEqual(["v70", "v50"]);
  });
});

describe("versioning §2.6 — an id the registry does not know", () => {
  it("orders by the derived ordinal, warns about nothing, and is still offered", () => {
    const hidden = render("<v99+>Future.</v99+>", "v70");
    expect(hidden.html).toBe("");
    expect(hidden.meta.warnings).toEqual([]);
    // §6: an unregistered boundary is SHOWN, so somebody can see that nobody
    // registered it.
    expect(hidden.meta.versionBoundaries).toEqual(["v99"]);

    const shown = render("<v99+>Future.</v99+>", "v99");
    expect(shown.html).toContain("Future.");
    expect(shown.meta.warnings).toEqual([]);
  });

  it("previews the same page the reader would get", () => {
    const preview = parse("<v99+>Future.</v99+>", ctxAt("v99", true));
    expect(preview.html).toContain("Future.");
    expect(preview.html).not.toContain("wiki-error");
  });
});

describe("versioning §3 — boundaries are recorded before branch selection", () => {
  it("records every boundary on the page at every selection", () => {
    for (const v of ["v50", "v55", "v62", "v70", null]) {
      const meta = at(v).meta;
      expect(meta.versionScoped).toBe(true);
      expect([...meta.versionBoundaries].sort()).toEqual([
        "v50",
        "v55",
        "v61",
        "v62",
        "v64",
        "v70",
      ]);
    }
  });

  it("records the boundary of a branch the selection HIDES", () => {
    const out = at("v50");
    // The `<v70+>` branch contributed nothing to the HTML …
    expect(out.html).not.toContain("Cruiser sale added.");
    // … but the selector must still offer v70, and the v62/v64 branches too.
    expect(out.meta.versionBoundaries).toContain("v70");
    expect(out.meta.versionBoundaries).toContain("v62");
    expect(out.meta.versionBoundaries).toContain("v64");
  });

  it("records one id for <v70>, both for <v62+v70>, the open end for <v70+>", () => {
    // Read at v45, so every branch is hidden and the recording is the only
    // thing that reaches the selector.
    expect(render("<v70>a</v70>", "v45").meta.versionBoundaries).toEqual(["v70"]);
    expect(render("<v62+v70>a</v62+v70>", "v45").meta.versionBoundaries).toEqual([
      "v62",
      "v70",
    ]);
    expect(render("<v70+>a</v70+>", "v45").meta.versionBoundaries).toEqual(["v70"]);
    for (const source of ["<v70>a</v70>", "<v62+v70>a</v62+v70>", "<v70+>a</v70+>"]) {
      expect(render(source, "v45").meta.versionScoped).toBe(true);
    }
  });

  it("a null selection resolves as the site default (versioning.md §5)", () => {
    expect(at(null).html).toBe(at("v70").html);
  });
});

describe("versioning §2 — version tags in awkward positions", () => {
  it("a version tag inside a TABLE CELL yields a plain cell", () => {
    const out = at("v70").html;
    expect(out).toContain("<td>Titan</td><td>30</td>");
    // The construct itself never reaches the block/inline stages.
    expect(out).not.toContain("<v50");
    expect(out).not.toContain("&lt;v50");
    expect(out).not.toContain("&lt;/v64+");
  });

  it("a version tag inside a TEMPLATE PARAMETER yields a plain infobox row", () => {
    expect(at("v50").html).toContain("<tr><th>Note</th><td>pre-Artifice</td></tr>");
    expect(at("v70").html).toContain("<tr><th>Note</th><td>post-Artifice</td></tr>");
  });

  it("a version tag is one whole template ARGUMENT, pipes and all", () => {
    const source = "{{Echo|<v62+>new|ish</v62+>}}";
    expect(render(source, "v50").html).toBe("<p>[]</p>");
    expect(render(source, "v70").html).toBe("<p>[new|ish]</p>");
  });

  it("a NESTED tag resolves inside the branch that shows it", () => {
    const source = "<v50+>quota<v62+> and cruiser</v62+></v50+>";
    expect(render(source, "v45").html).toBe("");
    expect(render(source, "v50").html).toBe("<p>quota</p>");
    expect(render(source, "v70").html).toBe("<p>quota and cruiser</p>");
  });

  it("a tag body may span lines and carry block markup", () => {
    const source = "<v62+>\n* one\n* two\n</v62+>";
    expect(render(source, "v62").html).toContain("<li>one</li>");
    expect(render(source, "v50").html).toBe("");
  });

  it("{{#vswitch}} as an infobox parameter picks the greatest boundary ≤ selection", () => {
    expect(at("v45").html).not.toContain("Route cost"); // below every boundary
    expect(at("v50").html).toContain("<td>1400 credits</td>");
    expect(at("v61").html).toContain("<td>1400 credits</td>");
    expect(at("v62").html).toContain("<td>1500 credits</td>");
    expect(at("v64.1").html).toContain("<td>1500 credits</td>");
  });

  it("{{VERSION}} reports the selection, not the site default", () => {
    expect(at("v50").html).toContain("Viewing v50.");
    expect(at("v70").html).toContain("Viewing v70.");
    // §2.5: version magic words are NOT volatile — output is cached per version.
    expect(at("v50").meta.volatile).toBe(false);
  });

  it("D-14: the conditional infobox rows leave no stray <p>/<br /> in the table", () => {
    // At v45 the `cost` and `note` values are below every boundary and the
    // `weather` param is absent, so THREE `{{#if:}}` rows collapse to blank
    // lines inside the raw <table> (Addendum A1).
    const table = infoboxHtml(at("v45").html);
    expect(table).toContain('<table class="infobox">');
    expect(table).toContain('<tr><th colspan="2">Titan</th></tr>');
    expect(table).not.toContain("<p>");
    expect(table).not.toContain("<br");
    expect(table.endsWith("</table>")).toBe(true);
  });
});

describe("versioning §2 — malformed version tags follow the §10 tag rules", () => {
  it("an unclosed tag swallows to the end of the input", () => {
    const source = "Quota.\n<v62+>Cruiser.";
    expect(render(source, "v70").html).toBe("<p>Quota.\nCruiser.</p>");
    expect(render(source, "v50").html).toBe("<p>Quota.</p>");
    // The boundary is recorded either way — the tag opened.
    expect(render(source, "v50").meta.versionBoundaries).toEqual(["v62"]);
  });

  it("a closing name that does not repeat the opening one does not close it", () => {
    // `</v62+>` is not `</v50+>`, so the tag runs to the end of the input and
    // the stray closer is left to §10.7 — escaped, not silently swallowed.
    const shown = render("<v50+>text</v62+>", "v50").html;
    expect(shown).toContain("text");
    expect(shown).toContain("&lt;/v62+&gt;");
    expect(render("<v50+>text</v62+>", "v45").html).toBe("");
  });

  it("a closing name matches its opening one case-insensitively (§10)", () => {
    expect(render("<V64.1+>Patch.</v64.1+> Rest.", "v70").html).toBe(
      "<p>Patch. Rest.</p>",
    );
  });

  it("warns that an unclosed tag swallowed the rest of the page", () => {
    // The RENDER is right and the page is almost always wrong: §10.7's swallow
    // takes everything after the opener into the branch, so it disappears at
    // every other version — and any version tag caught inside it is never
    // expanded, so its boundary is never discovered (§2.6). None of that is
    // visible in the output, which is why it is said in `meta.warnings`.
    const out = render("Quota.\n<v62+>Cruiser.\n<v70>Later.</v70>", "v50");
    expect(out.meta.warnings).toContain("unclosed-version-tag: v62+");
    // …but the swallowed tag's boundary survives it (amended 2026-09-05).
    // §3's whole point is that the selector offers branches the current view
    // hides, and a page that loses v70 from its selector because of a typo
    // three lines above is the failure that rule exists to prevent.
    expect(out.meta.versionBoundaries).toEqual(["v62", "v70"]);
  });

  it("finds a version tag inside a branch this reading hides", () => {
    // Until 2026-09-05 this was a documented limitation of §2.6 — a hidden
    // branch is never expanded, so tags inside it were never seen. The report
    // that retired it was not nesting on purpose: one mistyped closer swallows
    // the rest of the page, and every version block below it went with it.
    const nested = "<v62+>Cruiser <v70>and its terminal</v70>.</v62+>";
    // Hidden at v50, shown at v70: the boundaries are the same either way.
    expect(render(nested, "v50").meta.versionBoundaries).toEqual(["v62", "v70"]);
    expect(render(nested, "v70").meta.versionBoundaries).toEqual(["v62", "v70"]);
    // And it is metadata only — nothing about the rendering moved.
    expect(render(nested, "v50").html).toBe("");
  });

  it("reads only opening tags out of a hidden branch, and only real ones", () => {
    // A closer repeats its opener and names nothing new; `<var>` and `<v70x>`
    // are not version tags at any depth (§2.1 anchors on the whole name).
    const out = render("<v62+><var>x</var><v70x>y</v70x></v62+>", "v50");
    expect(out.meta.versionBoundaries).toEqual(["v62"]);
  });

  it("says nothing about a tag that closes", () => {
    const out = render("<v62+>Cruiser.</v62+>\n<v70>Later.</v70>", "v50");
    expect(out.meta.warnings).toEqual([]);
    expect(out.meta.versionBoundaries).toEqual(["v62", "v70"]);
  });

  it("an ordinary tag whose name merely starts with a v is untouched", () => {
    // The pattern anchors on the WHOLE name, so `<var>` stays allowed HTML and
    // `<v70x>` stays an unknown tag (§10.7).
    expect(render("<var>x</var>", "v70").html).toBe("<p><var>x</var></p>");
    expect(render("<v70x>x</v70x>", "v70").html).toContain("&lt;v70x&gt;");
  });
});

describe("versioning §2 — the retired grammar", () => {
  it("<versions>/<variant>/<version> render escaped, as unknown tags (§10.7)", () => {
    const group = [
      "<versions>",
      '<variant since="v50">130</variant>',
      '<variant since="v62">180</variant>',
      "</versions>",
    ].join("\n");
    const out = render(group, "v50");
    expect(out.html).toContain("&lt;versions&gt;");
    expect(out.html).toContain("&lt;variant");
    expect(out.html).toContain("130");
    expect(out.html).toContain("180");
    // Nothing was resolved, so the page is not version-scoped at all.
    expect(out.meta.versionScoped).toBe(false);
    expect(out.meta.versionBoundaries).toEqual([]);
  });

  it("<version since=…> renders escaped too", () => {
    const out = render('<version since="v62">Cruiser.</version>', "v62");
    expect(out.html).toContain("&lt;version");
    expect(out.html).toContain("&lt;/version&gt;");
    expect(out.meta.versionScoped).toBe(false);
  });
});

describe("versioning §4 — cache keying", () => {
  it("an unscoped page stays unscoped and caches under '*'", () => {
    const ctx = ctxAt("v50");
    const out = parse(
      "Plain '''prose''' with a [[Bracken]] link and no version markup.",
      ctx,
    );
    expect(out.meta.versionScoped).toBe(false);
    expect(out.meta.versionBoundaries).toEqual([]);
    expect(cacheVersionKey(out, ctx)).toBe("*");
    // …and it renders the same whatever the reader selects.
    expect(out.html).toBe(
      parse(
        "Plain '''prose''' with a [[Bracken]] link and no version markup.",
        ctxAt("v70"),
      ).html,
    );
  });

  it("a scoped page keys the cache by the selection", () => {
    const ctx = ctxAt("v62");
    expect(cacheVersionKey(at("v62"), ctx)).toBe("v62");
    expect(cacheVersionKey(at(null), ctxAt(null))).toBe("v70");
  });
});
