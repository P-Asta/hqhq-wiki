/**
 * Fandom extension tags — `<tabber>`, `<poem>` and the `<gallery>` option
 * vocabulary (spec "Fandom extensions" §F.2.1–§F.2.3).
 *
 * Two layers are covered on purpose:
 *   - the PURE helpers in fandom-tags.ts, where the syntax edge cases live;
 *   - the whole pipeline through `parse()`, because these tags are extension
 *     tags whose payload only becomes wikitext again in stage 6 — a unit test
 *     of the parser alone cannot prove that links, refs and block constructs
 *     inside a panel or caption actually resolve.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_NAMESPACES } from "@/lib/title";

import {
  galleryClassList,
  parseGalleryLine,
  parseGalleryOptions,
  parseGalleryPx,
  parseTabber,
  poemWikitext,
  renderPoemHtml,
  renderTabberHtml,
} from "./fandom-tags";
import { parse } from "./index";
import type { ParseContext, WikiConfig } from "./types";

/* ---------------------------------------------------------------- */
/* Fixtures                                                          */
/* ---------------------------------------------------------------- */

const PAGES = new Set(["0:Bracken", "0:Artifice"]);

/** Both fixture files are 800×600 so the scaling maths stays checkable. */
const FILES: Record<string, { src: string; width: number; height: number }> = {
  "a.png": { src: "/api/media/a.png", width: 800, height: 600 },
  "b.png": { src: "/api/media/b.png", width: 800, height: 600 },
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
/* §F.2.1 <tabber>                                                   */
/* ---------------------------------------------------------------- */

describe("parseTabber (§F.2.1)", () => {
  it("parses the compact legacy form `Title=|-|body|-|Title=|-|body`", () => {
    expect(parseTabber("Alpha=|-|one|-|Beta=|-|two")).toEqual([
      { title: "Alpha", source: "one" },
      { title: "Beta", source: "two" },
    ]);
  });

  it("parses the conventional multi-line legacy form", () => {
    // The newline after each `|-|` must not hide the next tab's title line.
    const tabs = parseTabber("\nAlpha=\n* a\n* b\n|-|\nBeta=\ntext\n");
    expect(tabs).toEqual([
      { title: "Alpha", source: "* a\n* b" },
      { title: "Beta", source: "text" },
    ]);
  });

  it("parses the `<tab name=…>` element form, quoted or bare", () => {
    expect(
      parseTabber(`<tab name="One">first</tab><tab name=Two>second</tab><tab name='Three'>x</tab>`),
    ).toEqual([
      { title: "One", source: "first" },
      { title: "Two", source: "second" },
      { title: "Three", source: "x" },
    ]);
  });

  it("names an unnamed `<tab>` positionally rather than dropping it", () => {
    expect(parseTabber("<tab>body</tab>")).toEqual([{ title: "Tab 1", source: "body" }]);
  });

  it("does not mistake wikitext on a panel's first line for a title", () => {
    // `{{tpl|a=b}}`, `[[File:X|a=b]]` and `==Heading==` all contain `=`.
    const tabs = parseTabber("Alpha=|-|[[File:A.png|thumb=x]]\nmore|-|Beta=|-|==H==");
    expect(tabs.map((t) => t.title)).toEqual(["Alpha", "Beta"]);
    expect(tabs[0]?.source).toBe("[[File:A.png|thumb=x]]\nmore");
    expect(tabs[1]?.source).toBe("==H==");
  });

  it("returns no tabs for an empty body, so the caller emits nothing", () => {
    expect(parseTabber("")).toEqual([]);
    expect(parseTabber("\n  \n")).toEqual([]);
  });
});

describe("renderTabberHtml (§F.2.1)", () => {
  it("emits radio + label + panel triples, with only the first checked", () => {
    const html = renderTabberHtml(
      [
        { title: "A", html: "<p>1</p>" },
        { title: "B", html: "<p>2</p>" },
      ],
      "7",
    );
    expect(countOf(html, /<input class="tabber-input"/g)).toBe(2);
    expect(countOf(html, / checked /g)).toBe(1);
    // One radio group per widget, so two tabbers on a page stay independent.
    expect(countOf(html, /name="tabber-7"/g)).toBe(2);
    expect(html).toContain('<label class="tabber-tabs tabber-tab" for="tabber-7-1">A</label>');
    expect(html).toContain('<section class="tabber-panel" aria-label="B"><p>2</p></section>');
  });

  it("escapes titles for both text and attribute positions", () => {
    const html = renderTabberHtml([{ title: `<b>&"x`, html: "" }], "1");
    // Attribute position also escapes the quote; text position must not, or
    // the label would read `&quot;` literally.
    expect(html).toContain('aria-label="&lt;b&gt;&amp;&quot;x"');
    expect(html).toContain('>&lt;b&gt;&amp;"x</label>');
  });

  it("emits nothing for no tabs", () => {
    expect(renderTabberHtml([], "1")).toBe("");
  });
});

describe("<tabber> through the pipeline (§F.2.1)", () => {
  it("renders block wikitext inside a panel — lists, tables and links", () => {
    const out = run(
      "<tabber>\nAlpha=\n* [[Bracken]]\n|-|\nBeta=\n{| class=\"wikitable\"\n! H\n|-\n| c\n|}\n</tabber>",
    );
    expect(out.html).toContain("<ul><li><a href=\"/wiki/bracken\"");
    expect(out.html).toContain('<table class="wikitable">');
    // The table must land in the SECOND panel, not leak into the first.
    expect(out.html.indexOf('aria-label="Beta"')).toBeLessThan(out.html.indexOf("<table"));
    expect(out.meta.warnings).toEqual([]);
  });

  it("keeps radio groups distinct when a page has two tabbers", () => {
    const out = run("<tabber>A=|-|1|-|B=|-|2</tabber>\n\n<tabber>C=|-|3|-|D=|-|4</tabber>");
    expect(countOf(out.html, /name="tabber-1"/g)).toBe(2);
    expect(countOf(out.html, /name="tabber-2"/g)).toBe(2);
    expect(countOf(out.html, /id="tabber-1-1"/g)).toBe(1);
  });

  it("registers a ref used inside a panel in the page-wide list", () => {
    const out = run("<tabber>A=|-|text<ref>note</ref>|-|B=|-|x</tabber>\n\n<references />");
    expect(out.html).toContain("note");
    expect(countOf(out.html, /<ol class="references">/g)).toBe(1);
    expect(out.meta.warnings).toEqual([]);
  });
});

/* ---------------------------------------------------------------- */
/* §F.2.2 <poem>                                                     */
/* ---------------------------------------------------------------- */

describe("poemWikitext (§F.2.2)", () => {
  it("turns every newline into a <br /> while keeping the text as wikitext", () => {
    expect(poemWikitext("\none\ntwo\n")).toBe("one<br />\ntwo");
  });

  it("protects leading indentation from the §3.2 space-pre rule", () => {
    expect(poemWikitext("\n  indented\n")).toBe("&nbsp;&nbsp;indented");
  });

  it("expands a leading tab to eight non-breaking spaces", () => {
    expect(poemWikitext("\n\tx\n")).toBe("&nbsp;".repeat(8) + "x");
  });

  it("keeps interior blank lines as empty verses", () => {
    expect(poemWikitext("a\n\nb")).toBe("a<br />\n<br />\nb");
  });
});

describe("renderPoemHtml (§F.2.2)", () => {
  it("wraps in .poem and appends an author class", () => {
    expect(renderPoemHtml("x")).toBe('<div class="poem">x</div>');
    expect(renderPoemHtml("x", "verse")).toBe('<div class="poem verse">x</div>');
    expect(renderPoemHtml("x", "  ")).toBe('<div class="poem">x</div>');
  });
});

describe("<poem> through the pipeline (§F.2.2)", () => {
  it("preserves line breaks and still parses links and apostrophes", () => {
    const out = run("<poem>\nRoses are ''red''\n[[Bracken]] is not\n</poem>");
    expect(out.html).toContain('<div class="poem">');
    expect(out.html).toContain("<i>red</i><br />");
    expect(out.html).toContain('<a href="/wiki/bracken"');
    expect(out.meta.warnings).toEqual([]);
  });

  it("does not turn an indented line into a <pre> block", () => {
    const out = run("<poem>\n  indented\n</poem>");
    expect(out.html).not.toContain("<pre>");
    expect(out.html).toContain("&nbsp;&nbsp;indented");
  });
});

/* ---------------------------------------------------------------- */
/* §F.2.3 <gallery> options                                          */
/* ---------------------------------------------------------------- */

describe("parseGalleryPx / parseGalleryOptions (§F.2.3)", () => {
  it("accepts `N` and `Npx`, and falls back on anything else", () => {
    expect(parseGalleryPx("200", 120)).toBe(200);
    expect(parseGalleryPx("200px", 120)).toBe(200);
    expect(parseGalleryPx(" 200 px ", 120)).toBe(200);
    expect(parseGalleryPx("wide", 120)).toBe(120);
    expect(parseGalleryPx(undefined, 120)).toBe(120);
  });

  it("defaults to traditional/120/120", () => {
    expect(parseGalleryOptions({})).toEqual({
      mode: "traditional",
      widths: 120,
      heights: 120,
    });
  });

  it("reads every supported attribute", () => {
    expect(
      parseGalleryOptions({
        mode: "PACKED",
        widths: "200px",
        heights: "150",
        spacing: "small",
        captionalign: "right",
        position: "center",
        caption: "Cap",
        class: "extra",
      }),
    ).toEqual({
      mode: "packed",
      widths: 200,
      heights: 150,
      spacing: "small",
      captionalign: "right",
      position: "center",
      caption: "Cap",
      extraClass: "extra",
    });
  });

  it("ignores unknown enum values and accepts-and-drops `hideaddbutton`", () => {
    const options = parseGalleryOptions({
      mode: "slideshow",
      spacing: "huge",
      hideaddbutton: "true",
    });
    expect(options.mode).toBe("traditional");
    expect(options.spacing).toBeUndefined();
    expect(options).not.toHaveProperty("hideaddbutton");
  });
});

describe("galleryClassList (§F.2.3)", () => {
  it("keeps the two-token default unchanged", () => {
    expect(galleryClassList({ mode: "traditional", widths: 120, heights: 120 })).toBe(
      "gallery mw-gallery-traditional",
    );
  });

  it("appends a class only for an attribute that was actually given", () => {
    expect(
      galleryClassList({
        mode: "nolines",
        widths: 120,
        heights: 120,
        spacing: "large",
        captionalign: "left",
        position: "right",
        extraClass: "custom",
      }),
    ).toBe(
      "gallery mw-gallery-nolines mw-gallery-spacing-large " +
        "mw-gallery-captionalign-left mw-gallery-position-right custom",
    );
  });
});

describe("parseGalleryLine (§F.2.3)", () => {
  it("strips an optional File:/Image: prefix", () => {
    expect(parseGalleryLine("File:A.png")).toEqual({ file: "A.png", caption: "" });
    expect(parseGalleryLine("Image:A.png")).toEqual({ file: "A.png", caption: "" });
    expect(parseGalleryLine("A.png")).toEqual({ file: "A.png", caption: "" });
  });

  it("reads alt= and link=, and keeps the rest as the caption", () => {
    expect(parseGalleryLine("A.png|alt=Alt text|link=Bracken|A ''caption''")).toEqual({
      file: "A.png",
      alt: "Alt text",
      link: "Bracken",
      caption: "A ''caption''",
    });
  });

  it("keeps `link=` empty to mean 'no link at all'", () => {
    expect(parseGalleryLine("A.png|link=")).toEqual({ file: "A.png", link: "", caption: "" });
  });

  it("rejoins a caption that itself contains pipes", () => {
    expect(parseGalleryLine("A.png|see [[Bracken|the bracken]]")?.caption).toBe(
      "see [[Bracken|the bracken]]",
    );
  });

  it("ignores blank and file-less lines", () => {
    expect(parseGalleryLine("")).toBeNull();
    expect(parseGalleryLine("   ")).toBeNull();
    expect(parseGalleryLine("File:|caption")).toBeNull();
  });
});

describe("<gallery> through the pipeline (§F.2.3)", () => {
  it("honors widths/heights when scaling each image", () => {
    const out = run('<gallery widths="200" heights="150">\nA.png\n</gallery>');
    // 800×600 fitted into 200×150 ⇒ scale 0.25 ⇒ 200×150.
    expect(out.html).toContain('width="200" height="150"');
    expect(out.html).toContain('style="width: 235px"');
  });

  it("uses heights as the binding constraint when it is the tighter bound", () => {
    const out = run('<gallery widths="400" heights="150">\nA.png\n</gallery>');
    // scale = min(400/800, 150/600) = 0.25 ⇒ 200×150.
    expect(out.html).toContain('width="200" height="150"');
  });

  it("puts mode/spacing/captionalign/position on the <ul> class list", () => {
    const out = run(
      '<gallery mode="packed" spacing="small" captionalign="left" position="center">\n' +
        "A.png\n</gallery>",
    );
    expect(out.html).toContain(
      '<ul class="gallery mw-gallery-packed mw-gallery-spacing-small ' +
        'mw-gallery-captionalign-left mw-gallery-position-center">',
    );
  });

  it("renders the gallery caption and per-item wikitext captions", () => {
    const out = run('<gallery caption="Cap">\nA.png|see [[Bracken]]\n</gallery>');
    expect(out.html).toContain('<li class="gallerycaption">Cap</li>');
    expect(out.html).toContain('<div class="gallerytext">see <a href="/wiki/bracken"');
  });

  it("applies alt= and suppresses the link for `link=`", () => {
    const out = run("<gallery>\nA.png|alt=Alt text|link=|cap\n</gallery>");
    expect(out.html).toContain('alt="Alt text"');
    // No anchor wrapping this image.
    expect(out.html).not.toContain('class="mw-file"');
  });

  it("points link= at an article when given a page title", () => {
    const out = run("<gallery>\nA.png|link=Bracken\n</gallery>");
    expect(out.html).toContain('<a href="/wiki/bracken" class="mw-file">');
  });

  it("red-links a missing file instead of emitting a broken <img>", () => {
    const out = run("<gallery>\nMissing.png|cap\n</gallery>");
    expect(out.html).toContain('class="new red-link"');
    expect(out.html).not.toContain("<img");
  });

  it("registers a ref used in a gallery caption in the explicit list (G3)", () => {
    const out = run(
      "<gallery>\nA.png|Concept <ref>src</ref>\n</gallery>\n\n==N==\n<references />",
    );
    expect(countOf(out.html, /<ol class="references">/g)).toBe(1);
    expect(out.meta.warnings).toEqual([]);
  });
});
