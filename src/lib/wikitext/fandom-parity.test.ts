/**
 * Fandom parity — engine gaps G1–G4 + G6.
 *
 * Normative reference: docs/engine/wikitext-spec.md §5.9 (file options),
 * §5.10 (category links), §10.3 (ref / references), §2.6 (behavior switches)
 * and the "Fandom extensions" section this suite was written alongside.
 *
 * Everything here drives the whole pipeline through `parse()`, because each
 * gap is an INTERACTION between stages (option parsing in stage 5 vs. sizing
 * in stage 6; ref registration order vs. strip-marker restoration) that a
 * single-stage test cannot observe.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_NAMESPACES } from "@/lib/title";

import { parse } from "./index";
import { parseLanguageLink } from "./links";
import type { ParseContext, WikiConfig } from "./types";

/* ---------------------------------------------------------------- */
/* Fixtures                                                          */
/* ---------------------------------------------------------------- */

const PAGES = new Set(["0:Bracken", "0:Artifice", "14:Moons"]);

/** Every fixture file is 800×600 so the scaling maths stays checkable by eye. */
const FILES: Record<string, { src: string; width: number; height: number }> = {
  "a.png": { src: "/api/media/a.png", width: 800, height: 600 },
  "a.gif": { src: "/api/media/a.gif", width: 800, height: 600 },
};

function makeCtx(): ParseContext {
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
  return {
    config,
    store: {
      getSource: () => null,
      exists: (key) => PAGES.has(key),
      getFile: (name) => FILES[name] ?? null,
    },
    page: { namespace: 0, pageName: "Artifice" },
    version: null,
    versions: { byId: {}, ordered: [], defaultId: "v1" },
  };
}

function run(source: string) {
  return parse(source, makeCtx());
}

function countOf(html: string, needle: RegExp): number {
  return (html.match(needle) ?? []).length;
}

/* ---------------------------------------------------------------- */
/* G1 — image size options (§5.9 resize group)                       */
/* ---------------------------------------------------------------- */

describe("G1 image sizes (§5.9)", () => {
  it("`{N}px` sets the width and scales the height, staying inline", () => {
    const out = run("[[File:A.png|1100px]]");
    expect(out.html).toContain('<img src="/api/media/a.png"');
    expect(out.html).toContain('width="1100" height="825"');
    // Non-thumb ⇒ no figure chrome, and it stays inside the paragraph.
    expect(out.html).not.toContain("<figure");
    expect(out.html).toContain('<p><a href="/wiki/file:a.png" class="mw-file">');
  });

  it("`{W}x{H}px` is a bounding box: the aspect ratio is preserved", () => {
    const out = run("[[File:A.gif|none|thumb|480x480px|Time-lapse.]]");
    // 800×600 fitted into 480×480 ⇒ scale 0.6 ⇒ 480×360.
    expect(out.html).toContain('width="480" height="360"');
    expect(out.html).toContain('<figure class="mw-thumb mw-halign-none" style="width:482px">');
    expect(out.html).toContain("<figcaption>Time-lapse.</figcaption>");
  });

  it("`x{N}px` sets the height and scales the width", () => {
    const out = run("[[File:A.png|x120px]]");
    expect(out.html).toContain('width="160" height="120"');
  });

  it("`upright={factor}` multiplies thumbDefaultWidth", () => {
    const out = run("[[File:A.png|upright=1.5|thumb|c]]");
    // 220 × 1.5 = 330; 330 × 600/800 = 248 (rounded).
    expect(out.html).toContain('width="330" height="248"');
    expect(out.html).toContain('style="width:332px"');
  });

  it("bare `upright` uses config.uprightDefaultFactor", () => {
    const out = run("[[File:A.png|upright|thumb|c]]");
    // 220 × 0.75 = 165; 165 × 0.75 = 124 (rounded).
    expect(out.html).toContain('width="165" height="124"');
  });

  it("a bogus size falls back to being the caption (§5.9 last-unmatched rule)", () => {
    const out = run("[[File:A.png|12ab px]]");
    // Not a size ⇒ natural dimensions, and the text became the caption, which
    // for a non-thumb image is the `title` attribute.
    expect(out.html).toContain('width="800" height="600"');
    expect(out.html).toContain('title="12ab px"');
    expect(out.meta.warnings).toEqual([]);
  });

  it("`frame` ignores the resize group (§5.9 format row)", () => {
    const out = run("[[File:A.png|frame|300px|c]]");
    expect(out.html).toContain('width="800" height="600"');
  });
});

/* ---------------------------------------------------------------- */
/* G2 — interlanguage links                                          */
/* ---------------------------------------------------------------- */

describe("G2 interlanguage links", () => {
  it("swallows `[[ru:Artifice]]` into meta.languageLinks", () => {
    const out = run("Body text.\n\n[[ru:Artifice]]\n");
    expect(out.html).not.toContain("ru:");
    expect(out.html).not.toContain("redlink");
    expect(out.meta.languageLinks).toEqual([{ lang: "ru", title: "Artifice" }]);
    // Never a link: it must not pollute page_links either (Addendum A4).
    expect(out.meta.linksTo).toEqual([]);
  });

  it("accepts the common codes and script/region variants", () => {
    const out = run("[[de:Artifice]]\n[[ko:아티피스]]\n[[zh-hans:人造]]\n[[pt-br:Artifice]]\n");
    expect(out.meta.languageLinks).toEqual([
      { lang: "de", title: "Artifice" },
      { lang: "ko", title: "아티피스" },
      { lang: "zh-hans", title: "人造" },
      { lang: "pt-br", title: "Artifice" },
    ]);
    expect(out.html).toBe("");
  });

  it("deduplicates repeats of the same lang+title", () => {
    const out = run("[[ru:Artifice]]\n[[ru:Artifice]]\n[[ru:Other]]\n");
    expect(out.meta.languageLinks).toEqual([
      { lang: "ru", title: "Artifice" },
      { lang: "ru", title: "Other" },
    ]);
  });

  it("leaves non-language prefixes exactly as they were", () => {
    const guide = run("[[Guide:Routing]]");
    expect(guide.meta.languageLinks).toEqual([]);
    expect(guide.html).toContain(">Guide:Routing</a>");

    const map = run("[[Map:Artifice]]");
    expect(map.meta.languageLinks).toEqual([]);
    expect(map.html).toContain(">Map:Artifice</a>");

    const file = run("[[File:A.png]]");
    expect(file.meta.languageLinks).toEqual([]);
    expect(file.html).toContain("<img src=");
  });

  it("the escaped form `[[:ru:X]]` renders AS a link (MW rule)", () => {
    const out = run("[[:ru:Artifice]]");
    expect(out.meta.languageLinks).toEqual([]);
    expect(out.html).toContain(">ru:Artifice</a>");
  });

  it("a line of nothing but interlanguage links produces no output line", () => {
    const out = run("Body.\n\n[[ru:A]] [[de:A]]\n\nMore.\n");
    expect(out.html).toBe("<p>Body.</p><p>More.</p>");
  });

  it("parseLanguageLink is prefix-exact", () => {
    const ctx = makeCtx();
    expect(parseLanguageLink("ru:Artifice", ctx)).toEqual({ lang: "ru", title: "Artifice" });
    expect(parseLanguageLink("RU:Artifice", ctx)).toEqual({ lang: "ru", title: "Artifice" });
    expect(parseLanguageLink("zh-hant:X", ctx)).toEqual({ lang: "zh-hant", title: "X" });
    expect(parseLanguageLink("File:A.png", ctx)).toBeNull(); // namespace wins
    expect(parseLanguageLink("Category:Moons", ctx)).toBeNull();
    expect(parseLanguageLink("Guide:X", ctx)).toBeNull();
    expect(parseLanguageLink("rus:X", ctx)).toBeNull(); // not a known code
    expect(parseLanguageLink(":ru:X", ctx)).toBeNull(); // escaped ⇒ real link
    expect(parseLanguageLink("ru:", ctx)).toBeNull(); // empty remainder
    expect(parseLanguageLink("Artifice", ctx)).toBeNull();
  });
});

/* ---------------------------------------------------------------- */
/* G3 — ref ordering vs. deferred content (§10.3)                    */
/* ---------------------------------------------------------------- */

describe("G3 ref ordering", () => {
  it("a ref inside a gallery caption lands in the explicit list", () => {
    const out = run(
      "Body.<ref>First</ref>\n\n" +
        "<gallery>\nFile:A.png|Concept <ref>From the gallery</ref>\n</gallery>\n\n" +
        "== Notes ==\n<references />\n",
    );
    expect(countOf(out.html, /<ol class="references">/g)).toBe(1);
    expect(out.html).toContain("From the gallery");
    expect(out.html).not.toContain("mw-ref-warning");
    expect(out.meta.warnings).toEqual([]);
    expect(out.refs).toEqual({ "": 2 });
  });

  it("a ref inside a thumb caption lands in the explicit list too", () => {
    const out = run(
      "[[File:A.png|thumb|Cap<ref>Caption note</ref>]]\nBody.<ref>Body note</ref>\n\n<references />\n",
    );
    expect(countOf(out.html, /<ol class="references">/g)).toBe(1);
    expect(out.html).toContain("Caption note");
    expect(out.html).toContain("Body note");
    expect(out.html).not.toContain("mw-ref-warning");
  });

  it("still auto-appends a list when no <references /> is present (§10.3)", () => {
    const out = run("Body.<ref>Only</ref>\n");
    expect(countOf(out.html, /<ol class="references">/g)).toBe(1);
    expect(out.html).toContain("mw-ref-warning");
  });

  it("the deferred list is emitted where the tag stood, not at the end", () => {
    const out = run("A<ref>n</ref>\n\n<references />\n\nTail.\n");
    const list = out.html.indexOf('<ol class="references">');
    const tail = out.html.indexOf("Tail.");
    expect(list).toBeGreaterThan(-1);
    expect(list).toBeLessThan(tail);
  });
});

/* ---------------------------------------------------------------- */
/* G4 — one red-link class                                           */
/* ---------------------------------------------------------------- */

describe("G4 red-link class", () => {
  it("inline, template and file red links all use `new red-link`", () => {
    const out = run("[[Nonexistent page]]\n\n{{Missing template}}\n\n[[File:Nope.png]]\n");
    expect(countOf(out.html, /class="new red-link"/g)).toBe(3);
    expect(out.html).not.toMatch(/class="new"/);
    expect(out.html).toContain('title="Nonexistent page (page does not exist)"');
    expect(out.html).toContain('title="Template:Missing template (page does not exist)"');
    expect(out.html).toContain("redlink=1");
  });
});

/* ---------------------------------------------------------------- */
/* G6 — Fandom magic words (§2.6 + DEFAULTSORT)                      */
/* ---------------------------------------------------------------- */

describe("G6 Fandom behavior switches", () => {
  it("recognized switches vanish from the output and are recorded", () => {
    const out = run(
      "__NOWYSIWYG__\n__NOGALLERY__\n__EXPECTUNUSEDCATEGORY__\n__STATICREDIRECT__\n__HIDDENCAT__\nBody.\n",
    );
    expect(out.html).toBe("<p>Body.</p>");
    expect([...out.meta.behaviorSwitches].sort()).toEqual([
      "EXPECTUNUSEDCATEGORY",
      "HIDDENCAT",
      "NOGALLERY",
      "NOWYSIWYG",
      "STATICREDIRECT",
    ]);
  });

  it("an unknown __WORD__ stays literal text (§2.6)", () => {
    const out = run("__NOTASWITCH__ and __nowysiwyg__ stay.\n");
    expect(out.html).toContain("__NOTASWITCH__");
    expect(out.html).toContain("__nowysiwyg__"); // switches are case-sensitive
    expect(out.meta.behaviorSwitches.size).toBe(0);
  });

  it("a switch inline in a sentence is removed without eating the line", () => {
    const out = run("Before __NOGALLERY__ after.\n");
    expect(out.html).toBe("<p>Before  after.</p>");
    expect(out.meta.behaviorSwitches.has("NOGALLERY")).toBe(true);
  });
});

describe("G6 {{DEFAULTSORT:}}", () => {
  it("supplies the sort key for categories that have none", () => {
    const out = run("{{DEFAULTSORT:Artifice, 68}}\n[[Category:Moons]]\n[[Category:Maps]]\n");
    expect(out.meta.defaultSort).toBe("Artifice, 68");
    expect(out.meta.categories).toEqual([
      { name: "Moons", sortKey: "Artifice, 68" },
      { name: "Maps", sortKey: "Artifice, 68" },
    ]);
    expect(out.html).toBe("");
  });

  it("an explicit sort key still wins (§5.10)", () => {
    const out = run("{{DEFAULTSORT:Zed}}\n[[Category:Moons|Alpha]]\n[[Category:Maps]]\n");
    expect(out.meta.categories).toEqual([
      { name: "Moons", sortKey: "Alpha" },
      { name: "Maps", sortKey: "Zed" },
    ]);
  });

  it("works when written after the category links", () => {
    const out = run("[[Category:Moons]]\n{{DEFAULTSORT:Late}}\n");
    expect(out.meta.categories).toEqual([{ name: "Moons", sortKey: "Late" }]);
  });

  it("the last one wins and warns on a conflicting redefinition", () => {
    const out = run("{{DEFAULTSORT:One}}{{DEFAULTSORT:Two}}\n[[Category:Moons]]\n");
    expect(out.meta.defaultSort).toBe("Two");
    expect(out.meta.categories).toEqual([{ name: "Moons", sortKey: "Two" }]);
    expect(out.meta.warnings.join(" ")).toContain("Default sort key redefined");
  });

  it("accepts the MediaWiki aliases and expands to nothing", () => {
    const out = run("{{DEFAULTSORTKEY:K}}\n[[Category:Moons]]\n");
    expect(out.meta.categories).toEqual([{ name: "Moons", sortKey: "K" }]);
    expect(out.html).toBe("");
  });
});
