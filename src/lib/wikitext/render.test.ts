import { describe, expect, it } from "vitest";

import { DEFAULT_NAMESPACES } from "@/lib/title";

import { encodeExtPayload, stripMarker } from "./expand";
import type { StripTable } from "./index";
import { render } from "./render";
import type {
  BlockNode,
  Document,
  InlineNode,
  PageMeta,
  ParseContext,
  Title,
  WikiConfig,
} from "./types";

/* ---------------------------------------------------------------- */
/* Fixtures                                                          */
/* ---------------------------------------------------------------- */

const PAGES = new Set(["0:Bracken", "0:Moon", "0:Target", "14:Moons"]);
const FILES: Record<string, { src: string; width: number; height: number }> = {
  "x.png": { src: "/api/media/x.png", width: 100, height: 80 },
  // A row uploaded before the pipeline measured anything: PageStore.getFile
  // reports NULL dimensions as 0x0 (store.ts).
  "unmeasured.png": { src: "/api/media/unmeasured.png", width: 0, height: 0 },
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
    page: { namespace: 0, pageName: "Sandbox" },
    version: null,
    versions: { byId: {}, ordered: [], defaultId: "v1" },
  };
}

function makeMeta(switches: string[] = []): PageMeta {
  return {
    categories: [],
    behaviorSwitches: new Set(switches),
    toc: [],
    templatesUsed: [],
    linksTo: [],
    ifexistTargets: [],
    volatile: false,
    versionBoundaries: [],
    versionScoped: false,
    warnings: [],
  };
}

function doc(children: BlockNode[], meta: PageMeta = makeMeta()): Document {
  return { type: "document", children, meta };
}

function text(value: string): InlineNode {
  return { type: "text", value };
}

function para(...children: InlineNode[]): BlockNode {
  return { type: "p", children };
}

function heading(level: 1 | 2 | 3 | 4 | 5 | 6, label: string): BlockNode {
  return { type: "heading", level, id: "", children: [text(label)] };
}

function title(pageName: string, namespace = 0, fragment?: string): Title {
  return fragment === undefined
    ? { namespace, pageName }
    : { namespace, pageName, fragment };
}

const noStrips: StripTable = new Map();

/* ---------------------------------------------------------------- */
/* Text, paragraphs, headings                                        */
/* ---------------------------------------------------------------- */

describe("render — text and blocks (§14.7)", () => {
  it("escapes text nodes and keeps entity nodes verbatim (§11.5)", () => {
    const out = render(
      doc([para(text("a < b & "), { type: "entity", value: "&amp;" })]),
      makeCtx(),
      noStrips,
    );
    expect(out.html).toBe("<p>a &lt; b &amp; &amp;</p>");
  });

  it("C-14: heading ids are recomputed from rendered content and deduped", () => {
    const out = render(doc([heading(2, "X"), heading(2, "X")]), makeCtx(), noStrips);
    expect(out.html).toBe(`<h2 id="X">X</h2><h2 id="X_2">X</h2>`);
  });

  it("D-2: the id sits on the h* element, with no mw-headline wrapper", () => {
    const out = render(
      doc([
        {
          type: "heading",
          level: 3,
          id: "",
          children: [text("The "), { type: "i", children: [text("Bracken")] }, text(" room")],
        },
      ]),
      makeCtx(),
      noStrips,
    );
    expect(out.html).toBe(`<h3 id="The_Bracken_room">The <i>Bracken</i> room</h3>`);
  });

  it("renders lists, definition lists and hr", () => {
    const out = render(
      doc([
        {
          type: "list",
          ordered: false,
          items: [{ type: "li", children: [text("one")] }],
        },
        { type: "hr" },
        {
          type: "dl",
          items: [
            { type: "dt", children: [text("term")] },
            { type: "dd", children: [text("def")] },
          ],
        },
      ]),
      makeCtx(),
      noStrips,
    );
    expect(out.html).toBe(
      "<ul><li>one</li></ul><hr /><dl><dt>term</dt><dd>def</dd></dl>",
    );
  });

  it("renders a table with caption, attributes and fostered content (§7.6, §7.7)", () => {
    const out = render(
      doc([
        {
          type: "table",
          attrs: { class: "wikitable", onclick: "x()" },
          caption: { attrs: { class: "c" }, children: [text("Cap")] },
          rows: [
            {
              type: "tr",
              attrs: {},
              cells: [
                { type: "cell", header: true, attrs: { colspan: "2" }, children: [para(text("h"))] },
                { type: "cell", header: false, attrs: {}, children: [para(text("d"))] },
              ],
            },
          ],
          fostered: [para(text("stray"))],
        },
      ]),
      makeCtx(),
      noStrips,
    );
    expect(out.html).toBe(
      `<p>stray</p><table class="wikitable"><caption class="c">Cap</caption>` +
        `<tbody><tr><th colspan="2"><p>h</p></th><td><p>d</p></td></tr></tbody></table>`,
    );
  });

  it("renders a transparent html-block (blocks.ts `tag: \"\"`) without a wrapper", () => {
    const out = render(
      doc([{ type: "html-block", tag: "", attrs: {}, children: [text("bare")] }]),
      makeCtx(),
      noStrips,
    );
    expect(out.html).toBe("bare");
  });
});

/* ---------------------------------------------------------------- */
/* TOC                                                               */
/* ---------------------------------------------------------------- */

describe("render — TOC (§2.5)", () => {
  it("splices the TOC before the first heading once there are four", () => {
    const out = render(
      doc([para(text("lead")), heading(2, "A"), heading(2, "B"), heading(2, "C"), heading(2, "D")]),
      makeCtx(),
      noStrips,
    );
    expect(out.html.indexOf(`id="toc"`)).toBeGreaterThan(out.html.indexOf("<p>lead</p>"));
    expect(out.html.indexOf(`id="toc"`)).toBeLessThan(out.html.indexOf(`<h2 id="A">`));
    expect(out.toc.map((e) => e.number)).toEqual(["1", "2", "3", "4"]);
  });

  it("places the TOC at the __TOC__ placeholder", () => {
    const out = render(
      doc([heading(2, "A"), { type: "toc" }, heading(2, "B")], makeMeta(["TOC"])),
      makeCtx(),
      noStrips,
    );
    expect(out.html).toBe(
      `<h2 id="A">A</h2><div id="toc" class="toc wiki-toc" role="navigation">` +
        `<div class="toctitle"><h2>Contents</h2></div>` +
        `<ul><li class="toclevel-1"><a href="#A"><span class="tocnumber">1</span> ` +
        `<span class="toctext">A</span></a></li>` +
        `<li class="toclevel-1"><a href="#B"><span class="tocnumber">2</span> ` +
        `<span class="toctext">B</span></a></li></ul></div><h2 id="B">B</h2>`,
    );
  });

  it("__NOTOC__ suppresses the TOC but still fills meta.toc", () => {
    const meta = makeMeta(["NOTOC"]);
    const out = render(
      doc([heading(2, "A"), heading(2, "B"), heading(2, "C"), heading(2, "D")], meta),
      makeCtx(),
      noStrips,
    );
    expect(out.html).not.toContain(`id="toc"`);
    expect(meta.toc).toHaveLength(4);
  });
});

/* ---------------------------------------------------------------- */
/* Links                                                             */
/* ---------------------------------------------------------------- */

describe("render — links (§5, §6)", () => {
  it("renders an existing internal link with its title attribute", () => {
    const out = render(
      doc([
        para({
          type: "wikilink",
          target: title("Bracken"),
          exists: true,
          selfAnchor: false,
          children: [text("brackens")],
        }),
      ]),
      makeCtx(),
      noStrips,
    );
    expect(out.html).toBe(`<p><a href="/wiki/bracken" title="Bracken">brackens</a></p>`);
  });

  it("marks a missing target with class=\"new red-link\" and the localized suffix", () => {
    const out = render(
      doc([
        para({
          type: "wikilink",
          target: title("Nonexistent page"),
          exists: false,
          selfAnchor: false,
          children: [text("that page")],
        }),
      ]),
      makeCtx(),
      noStrips,
    );
    expect(out.html).toBe(
      `<p><a href="/wiki/nonexistent-page?redlink=1" class="new red-link" ` +
        `title="Nonexistent page (page does not exist)">that page</a></p>`,
    );
  });

  it("renders a same-page anchor without a title attribute (§5.5)", () => {
    const out = render(
      doc([
        para({
          type: "wikilink",
          target: title("", 0, "Section"),
          exists: true,
          selfAnchor: true,
          children: [text("#Section")],
        }),
      ]),
      makeCtx(),
      noStrips,
    );
    expect(out.html).toBe(`<p><a href="#Section">#Section</a></p>`);
  });

  it("renders the three external-link forms (§6.2)", () => {
    const out = render(
      doc([
        para(
          { type: "extlink", href: "https://a.example", style: "text", children: [text("lbl")] },
          { type: "extlink", href: "https://b.example", style: "autonumber", children: [] },
          { type: "extlink", href: "https://c.example", style: "free", children: [text("https://c.example")] },
        ),
      ]),
      makeCtx(),
      noStrips,
    );
    expect(out.html).toBe(
      `<p><a class="external text" rel="nofollow noopener" href="https://a.example">lbl</a>` +
        `<a class="external autonumber" rel="nofollow noopener" href="https://b.example">[1]</a>` +
        `<a class="external free" rel="nofollow noopener" href="https://c.example">https://c.example</a></p>`,
    );
  });
});

/* ---------------------------------------------------------------- */
/* Images and galleries                                              */
/* ---------------------------------------------------------------- */

describe("render — files (§5.9, §10.4)", () => {
  it("renders a thumb figure with upright sizing (§5.11-5, D-7)", () => {
    const out = render(
      doc([
        para({
          type: "image",
          file: "X.png",
          exists: true,
          format: "thumb",
          halign: "left",
          upright: 1.2,
          border: false,
          alt: "Facility layout",
          caption: [text("The facility")],
        }),
      ]),
      makeCtx(),
      noStrips,
    );
    expect(out.html).toContain(`<figure class="mw-thumb mw-halign-left" style="width:266px">`);
    expect(out.html).toContain(`width="264" height="211"`);
    expect(out.html).toContain(`alt="Facility layout"`);
    expect(out.html).toContain(`<figcaption>The facility</figcaption>`);
  });

  it("omits the size hints for a file whose row records no dimensions", () => {
    // `width="0"` is not a smaller picture, it is an invisible one: globals.css
    // relaxes the height (`height: auto`) but never the width, so the hint
    // stands. No attribute at all draws the image at its natural size.
    const inline = render(
      doc([
        para({
          type: "image",
          file: "Unmeasured.png",
          exists: true,
          format: "inline",
          border: false,
          caption: [],
        }),
      ]),
      makeCtx(),
      noStrips,
    );
    expect(inline.html).toContain(`<img src="/api/media/unmeasured.png"`);
    expect(inline.html).not.toContain(`width="0"`);
    expect(inline.html).not.toContain(`height="0"`);

    // A thumb substitutes the default width but still has no height to scale,
    // so half a box is all it could emit — emit neither.
    const thumb = render(
      doc([
        para({
          type: "image",
          file: "Unmeasured.png",
          exists: true,
          format: "thumb",
          border: false,
          caption: [text("Cap")],
        }),
      ]),
      makeCtx(),
      noStrips,
    );
    expect(thumb.html).not.toContain(`height="0"`);
    expect(thumb.html).toContain(`<figcaption>Cap</figcaption>`);
  });

  it("renders a missing file as a red link to the file page", () => {
    const out = render(
      doc([
        para({
          type: "image",
          file: "Missing.png",
          exists: false,
          format: "inline",
          border: false,
          caption: [],
        }),
      ]),
      makeCtx(),
      noStrips,
    );
    expect(out.html).toBe(
      `<p><a href="/wiki/file:missing.png?redlink=1" class="new red-link" ` +
        `title="File:Missing.png (page does not exist)">Missing.png</a></p>`,
    );
  });

  it("renders a gallery strip payload (§10.4)", () => {
    const marker = stripMarker("gallery", 0);
    const strips: StripTable = new Map([
      [
        marker,
        encodeExtPayload({
          tag: "gallery",
          attrs: { caption: "Shots", widths: "120px", heights: "120px" },
          inner: "File:X.png|A caption\nFile:Nope.png|missing",
        }),
      ],
    ]);
    const out = render(doc([para(text(marker))]), makeCtx(), strips);
    expect(out.html).toContain(`<ul class="gallery mw-gallery-traditional">`);
    expect(out.html).toContain(`<li class="gallerycaption">Shots</li>`);
    expect(out.html).toContain(`style="width: 155px"`);
    expect(out.html).toContain(`<img src="/api/media/x.png"`);
    expect(out.html).toContain(`class="new red-link"`);
  });
});

/* ---------------------------------------------------------------- */
/* Refs (§10.3)                                                      */
/* ---------------------------------------------------------------- */

function refMarker(seq: number, attrs: Record<string, string>, inner: string | null) {
  const marker = stripMarker("ref", seq);
  return [marker, encodeExtPayload({ tag: "ref", attrs, inner })] as const;
}

describe("render — refs (§10.3)", () => {
  it("C-64: a named ref reused twice shows [1] twice and gets lettered backlinks", () => {
    const [m1, v1] = refMarker(0, { name: "a" }, "First");
    const [m2, v2] = refMarker(1, { name: "a" }, null);
    const [m3, v3] = [stripMarker("references", 2), encodeExtPayload({ tag: "references", attrs: {}, inner: null })];
    const strips: StripTable = new Map([
      [m1, v1],
      [m2, v2],
      [m3, v3],
    ]);
    const out = render(doc([para(text(`A${m1} B${m2}`)), para(text(m3))]), makeCtx(), strips);
    expect(out.html).toContain(
      `<sup id="cite_ref-a-1-0" class="reference"><a href="#cite_note-a-1">&#91;1&#93;</a></sup>`,
    );
    expect(out.html).toContain(
      `<sup id="cite_ref-a-1-1" class="reference"><a href="#cite_note-a-1">&#91;1&#93;</a></sup>`,
    );
    expect(out.html).toContain(
      `<ol class="references"><li id="cite_note-a-1">↑ ` +
        `<sup><a href="#cite_ref-a-1-0">a</a></sup> <sup><a href="#cite_ref-a-1-1">b</a></sup> First</li></ol>`,
    );
    expect(out.refs).toEqual({ "": 2 });
  });

  it("C-65: a named ref that is never defined renders the localized cite error", () => {
    const [m1, v1] = refMarker(0, { name: "missing" }, null);
    const [m2, v2] = [stripMarker("references", 1), encodeExtPayload({ tag: "references", attrs: {}, inner: null })];
    const out = render(
      doc([para(text(`X${m1}`)), para(text(m2))]),
      makeCtx(),
      new Map([
        [m1, v1],
        [m2, v2],
      ]),
    );
    expect(out.html).toContain(
      `<span class="error">Cite error: no text provided for ref "missing"</span>`,
    );
  });

  it("C-51: refs with no <references /> get an auto-appended list", () => {
    const [m1, v1] = refMarker(0, {}, "R");
    const out = render(doc([para(text(`foo${m1}`))]), makeCtx(), new Map([[m1, v1]]));
    expect(out.html).toContain(
      `<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">&#91;1&#93;</a></sup>`,
    );
    expect(out.html).toContain(`<div class="mw-ref-warning">`);
    expect(out.html).toContain(`<ol class="references"><li id="cite_note-1">`);
    expect(out.html).toContain(`<a href="#cite_ref-1">↑</a> R</li></ol>`);
  });

  it("numbers groups separately and labels them `[g n]`", () => {
    const [m1, v1] = refMarker(0, { group: "note" }, "N1");
    const [m2, v2] = refMarker(1, {}, "D1");
    const out = render(
      doc([para(text(`${m1}${m2}`))]),
      makeCtx(),
      new Map([
        [m1, v1],
        [m2, v2],
      ]),
    );
    expect(out.html).toContain(`<a href="#cite_note-note-1">&#91;note 1&#93;</a>`);
    expect(out.html).toContain(`<a href="#cite_note-1">&#91;1&#93;</a>`);
    expect(out.refs).toEqual({ note: 1, "": 1 });
  });

  it("takes definitions from a <references> body (§10.3)", () => {
    const [inner, innerValue] = refMarker(0, { name: "x" }, "Defined later");
    const use = stripMarker("ref", 1);
    const useValue = encodeExtPayload({ tag: "ref", attrs: { name: "x" }, inner: null });
    const list = stripMarker("references", 2);
    const listValue = encodeExtPayload({ tag: "references", attrs: {}, inner });
    const out = render(
      doc([para(text(`Y${use}`)), para(text(list))]),
      makeCtx(),
      new Map([
        [inner, innerValue],
        [use, useValue],
        [list, listValue],
      ]),
    );
    expect(out.html).toContain("Defined later</li></ol>");
    expect(out.html).not.toContain("Cite error");
  });

  it("uses the injected wikitext renderer for ref bodies", () => {
    const [m1, v1] = refMarker(0, {}, "''body''");
    const out = render(doc([para(text(m1))]), makeCtx(), new Map([[m1, v1]]), {
      renderWikitext: (wikitext) => `<i>${wikitext.replace(/'/g, "")}</i>`,
    });
    expect(out.html).toContain("<i>body</i>");
  });

  it("keeps ref markers out of heading ids and TOC text", () => {
    const [m1, v1] = refMarker(0, {}, "R");
    const meta = makeMeta(["FORCETOC"]);
    const out = render(
      doc([{ type: "heading", level: 2, id: "", children: [text(`Loot${m1}`)] }], meta),
      makeCtx(),
      new Map([[m1, v1]]),
    );
    expect(out.html).toContain(`<h2 id="Loot">`);
    expect(out.toc[0]?.html).toBe("Loot");
  });
});

/* ---------------------------------------------------------------- */
/* Strip restoration (§14.8)                                         */
/* ---------------------------------------------------------------- */

describe("render — strip markers (§14.8)", () => {
  it("C-61: nowiki content is restored verbatim from the strip table", () => {
    const marker = stripMarker("nowiki", 0);
    const out = render(
      doc([para(text(`a${marker}b`))]),
      makeCtx(),
      new Map([[marker, "[[x]] {{1x|y}} ''z''"]]),
    );
    expect(out.html).toBe(`<p>a[[x]] {{1x|y}} ''z''b</p>`);
  });

  it("C-69: syntaxhighlight HTML from stage 2 passes through untouched", () => {
    const marker = stripMarker("syntaxhighlight", 0);
    const html = `<pre class="mw-highlight"><code class="language-ts">a &lt; b</code></pre>`;
    const out = render(doc([para(text(marker))]), makeCtx(), new Map([[marker, html]]));
    expect(out.html).toBe(`<p>${html}</p>`);
  });

  it("restores markers nested inside a restored ref body", () => {
    const nowiki = stripMarker("nowiki", 0);
    const [ref, refValue] = refMarker(1, {}, `see ${nowiki}`);
    const out = render(
      doc([para(text(ref))]),
      makeCtx(),
      new Map([
        [nowiki, "[[literal]]"],
        [ref, refValue],
      ]),
    );
    expect(out.html).toContain("see [[literal]]");
  });

  it("drops an unknown marker rather than leaking it", () => {
    const marker = stripMarker("ref", 7);
    const out = render(doc([para(text(`a${marker}b`))]), makeCtx(), new Map());
    expect(out.html).toBe("<p>ab</p>");
  });

  it("drops an unknown extension payload", () => {
    const marker = stripMarker("math", 0);
    const out = render(
      doc([para(text(marker))]),
      makeCtx(),
      new Map([[marker, encodeExtPayload({ tag: "math", attrs: {}, inner: "x" })]]),
    );
    expect(out.html).toBe("<p></p>");
  });
});

/* ---------------------------------------------------------------- */
/* Redirects + determinism                                           */
/* ---------------------------------------------------------------- */

describe("render — redirects (§12.3) and determinism (§14.11)", () => {
  it("renders the redirect box with the localized label", () => {
    const out = render(
      doc([{ type: "redirect", target: title("Target", 0, "Frag"), targetText: "Target#Frag" }]),
      makeCtx(),
      noStrips,
    );
    expect(out.html).toBe(
      `<div class="redirectMsg"><p>Redirect to:</p>` +
        `<ul class="redirectText"><li>` +
        `<a href="/wiki/target" title="Target">Target#Frag</a></li></ul></div>`,
    );
  });

  it("is byte-identical across renders of the same document", () => {
    const [m1, v1] = refMarker(0, { name: "a" }, "First");
    const build = () =>
      render(
        doc([heading(2, "A"), para(text(`x${m1}`)), heading(2, "A")]),
        makeCtx(),
        new Map([[m1, v1]]),
      ).html;
    expect(build()).toBe(build());
  });
});
