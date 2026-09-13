import { describe, expect, it } from "vitest";

import { parseInline } from "./inline";
import { buildWikiLinkHref, titleKey, wikiLinkTitleAttr } from "./links";
import type {
  BlockNode,
  ImageLink,
  InlineNode,
  NamespaceTable,
  PageMeta,
  ParseContext,
  Title,
  VersionTable,
  WikiConfig,
  WikiLink,
} from "./types";
import { DEFAULT_NAMESPACES } from "@/lib/title";

/* ---------------------------------------------------------------- */
/* Fixtures (spec §15 corpus preamble)                               */
/* ---------------------------------------------------------------- */

/**
 * Pages that exist in the corpus store, keyed the way `titleKey()` keys them
 * (decisions O1: identity is `(namespace, slug)`).
 */
const EXISTING = new Set([
  "0:Bracken",
  "0:Moon",
  "0:Quota",
  "0:Bar",
  "0:Page",
  "0:Target",
  "0:A",
  "0:Rocket",
  "0:Sigurd",
  "0:Guides",
  "0:Guides/Routing/Speedrun",
  "14:Moons",
  "6:X.png",
]);

const FILES: Record<string, { src: string; width: number; height: number }> = {
  "x.png": { src: "/api/media/x.png", width: 100, height: 80 },
  "facility-map.png": { src: "/api/media/facility-map.png", width: 800, height: 600 },
};

const namespaces: NamespaceTable = DEFAULT_NAMESPACES;

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
  namespaces,
  messages: {
    tocTitle: "Contents",
    redLinkTitleSuffix: "(page does not exist)",
    redirectTo: "Redirect to:",
    citeErrorNoText: (name) => `Cite error: no text provided for ref "${name}"`,
    templateLoop: "Template loop detected",
    templateDepthExceeded: "Template depth limit exceeded",
    unknownVersion: (id) => `Unknown version: ${id}`,
  },
};

const versions: VersionTable = {
  byId: { v70: { id: "v70", label: "v70", ordinal: 70000, status: "current" } },
  ordered: [{ id: "v70", label: "v70", ordinal: 70000, status: "current" }],
  defaultId: "v70",
};

function makeCtx(page: Title = { namespace: 0, pageName: "Sandbox" }): ParseContext {
  return {
    config,
    page,
    version: null,
    versions,
    store: {
      getSource: () => null,
      exists: (key) => EXISTING.has(key),
      getFile: (name) => FILES[name] ?? null,
    },
  };
}

function makeMeta(): PageMeta {
  return {
    categories: [],
    behaviorSwitches: new Set<string>(),
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

const MARKER = "\x7f'\"UNIQ--nowiki-0000001a-QINU\"'\x7f";

/* ---------------------------------------------------------------- */
/* A minimal stage-6 renderer, just enough to assert §15 HTML shapes */
/* ---------------------------------------------------------------- */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function attr(s: string): string {
  return esc(s).replace(/"/g, "&quot;");
}

function renderNodes(nodes: readonly (InlineNode | BlockNode)[], ctx: ParseContext): string {
  // Stage 5 output is inline-only; the union comes from HtmlInline's widened
  // children, which only stage 4 ever fills with blocks.
  return nodes.map((n) => renderNode(n as InlineNode, ctx)).join("");
}

function renderNode(n: InlineNode, ctx: ParseContext): string {
  switch (n.type) {
    case "text":
      return esc(n.value);
    case "entity":
      return n.value;
    case "strip":
      return n.marker;
    case "br":
      return "<br />";
    case "b":
      return `<b>${renderNodes(n.children, ctx)}</b>`;
    case "i":
      return `<i>${renderNodes(n.children, ctx)}</i>`;
    case "wikilink": {
      const href = buildWikiLinkHref(n, ctx);
      const title = wikiLinkTitleAttr(n, ctx);
      const cls = n.exists ? "" : ' class="new"';
      const titleAttr = title === null ? "" : ` title="${attr(title)}"`;
      return `<a href="${attr(href)}"${cls}${titleAttr}>${renderNodes(n.children, ctx)}</a>`;
    }
    case "extlink": {
      const cls =
        n.style === "text" ? "external text" : n.style === "free" ? "external free" : "external autonumber";
      const body =
        n.style === "autonumber" ? `[${n.number}]` : renderNodes(n.children, ctx);
      return `<a class="${cls}" rel="${config.externalLinkRel}" href="${attr(n.href)}">${body}</a>`;
    }
    case "image":
      return `<img:${n.file}:${n.format}>`;
    case "html-inline": {
      const attrs = Object.entries(n.attrs)
        .map(([k, v]) => ` ${k}="${attr(v)}"`)
        .join("");
      return `<${n.tag}${attrs}>${renderNodes(n.children, ctx)}</${n.tag}>`;
    }
    case "ref":
      return `<ref:${n.group}>`;
  }
}

interface Parsed {
  nodes: InlineNode[];
  html: string;
  meta: PageMeta;
}

function run(source: string, page?: Title): Parsed {
  const ctx = makeCtx(page);
  const meta = makeMeta();
  const nodes = parseInline(source, ctx, meta);
  return { nodes, html: renderNodes(nodes, ctx), meta };
}

function html(source: string, page?: Title): string {
  return run(source, page).html;
}

/* ---------------------------------------------------------------- */
/* §1 apostrophes — the 12 hand-run examples and C-01…C-09           */
/* ---------------------------------------------------------------- */

describe("§1 apostrophes", () => {
  it("§1.5-1 basic pair", () => {
    expect(html("''italic'' and '''bold'''")).toBe("<i>italic</i> and <b>bold</b>");
  });

  it("§1.5-2 / C-01 five apostrophes both sides", () => {
    expect(html("'''''x'''''")).toBe("<i><b>x</b></i>");
  });

  it("§1.5-3 / C-02 run of four", () => {
    expect(html("''''four''''")).toBe("'<b>four'</b>");
    expect(html("''''x''''")).toBe("'<b>x'</b>");
  });

  it("§1.5-4 / C-03 run of six", () => {
    expect(html("''''''six''''''")).toBe("'<i><b>six'</b></i>");
    expect(html("''''''x''''''")).toBe("'<i><b>x'</b></i>");
  });

  it("§1.5-5 / C-04 re-balancing, multi-letter word", () => {
    expect(html("'''a'' b")).toBe("'<i>a</i> b");
  });

  it("§1.5-6 / C-05 re-balancing, single-letter word wins", () => {
    expect(html("It's a'''nice'' day")).toBe("It's a'<i>nice</i> day");
  });

  it("§1.5-7 no re-balancing when only bold is odd", () => {
    expect(html("'''''x''")).toBe("<b><i>x</i></b>");
  });

  it("§1.5-8 BI closed by B", () => {
    expect(html("'''''x'''")).toBe("<i><b>x</b></i>");
  });

  it("§1.5-9 / C-07 interleaved close via the ib path", () => {
    expect(html("''a'''b'''c''")).toBe("<i>a<b>b</b>c</i>");
  });

  it("§1.5-10 / C-08 overlapping regions forced well-formed", () => {
    expect(html("'''''a'' b'''")).toBe("<b><i>a</i> b</b>");
  });

  it("§1.5-11 / C-06 unclosed bold closes at EOL and does not leak", () => {
    expect(html("'''unclosed")).toBe("<b>unclosed</b>");
    expect(html("'''bold\nnext line")).toBe("<b>bold</b>\nnext line");
  });

  it("§1.5-12 italic across an internal link label stays well nested (D-1)", () => {
    // §5.4 governs the trail: "s" after "''" is not a trail, so it stays
    // outside the link (the rendered snippet in §1.5-12 shows it merged,
    // which contradicts §5.4 and corpus C-30).
    expect(html("''[[Rocket]]''s")).toBe(
      '<i><a href="/wiki/rocket" title="Rocket">Rocket</a></i>s',
    );
    expect(html("''[[Rocket]]s''")).toBe(
      '<i><a href="/wiki/rocket" title="Rocket">Rockets</a></i>',
    );
  });

  it("C-09 formatting never crosses lines", () => {
    expect(html("''one\ntwo''")).toBe("<i>one</i>\ntwo<i></i>");
  });

  it("a format opening outside a link and closing inside splits at the boundary (D-1)", () => {
    expect(html("''a[[Bar|b''c]] d")).toBe(
      '<i>a</i><a href="/wiki/bar" title="Bar"><i>b</i>c</a> d',
    );
  });

  it("single apostrophes are plain text", () => {
    expect(html("it's a dog's life")).toBe("it's a dog's life");
  });

  it("no re-balancing when both counts come from BI tokens only", () => {
    expect(html("'''''x")).toBe("<b><i>x</i></b>");
  });
});

/* ---------------------------------------------------------------- */
/* §5 internal links                                                 */
/* ---------------------------------------------------------------- */

describe("§5 internal links", () => {
  it("C-25 trail joins the label of a piped link", () => {
    expect(html("[[a|b]]c")).toBe('<a href="/wiki/a" title="A">bc</a>');
  });

  it("C-26 first-letter case folding", () => {
    expect(html("[[quota]]")).toBe('<a href="/wiki/quota" title="Quota">quota</a>');
  });

  it("§5.11-1 trail on a bare link", () => {
    expect(html("The [[bracken]]s hunt.")).toBe(
      'The <a href="/wiki/bracken" title="Bracken">brackens</a> hunt.',
    );
  });

  it("§5.11-2 piped + trail + red link", () => {
    expect(html("[[Nonexistent page|that page]]s")).toBe(
      '<a href="/wiki/nonexistent-page?redlink=1" class="new"' +
        ' title="Nonexistent page (page does not exist)">that pages</a>',
    );
  });

  it("§5.4 the trail stops at the first non-lowercase character", () => {
    expect(html("[[moon]]'s")).toBe('<a href="/wiki/moon" title="Moon">moon</a>\'s');
    expect(html("[[moon]]S")).toBe('<a href="/wiki/moon" title="Moon">moon</a>S');
  });

  it("C-30 a strip marker breaks the trail", () => {
    const { nodes } = run(`[[moon]]${MARKER}s`);
    expect(nodes).toHaveLength(3);
    expect((nodes[0] as WikiLink).children).toEqual([{ type: "text", value: "moon" }]);
    expect(nodes[1]).toEqual({ type: "strip", marker: MARKER });
    expect(nodes[2]).toEqual({ type: "text", value: "s" });
  });

  it("C-27 pipe trick strips a parenthetical (red link)", () => {
    expect(html("[[Pipe (computing)|]]")).toBe(
      '<a href="/wiki/pipe-(computing)?redlink=1" class="new"' +
        ' title="Pipe (computing) (page does not exist)">Pipe</a>',
    );
  });

  it("C-28 pipe trick keeps the text before the first comma", () => {
    expect(run("[[Boston, Massachusetts|]]").nodes[0]).toMatchObject({
      children: [{ type: "text", value: "Boston" }],
    });
  });

  it("C-29 a fragment disables the pipe trick", () => {
    expect(run("[[Foo#Bar|]]").nodes[0]).toMatchObject({
      children: [{ type: "text", value: "Foo#Bar" }],
    });
  });

  it("§5.3 pipe trick strips a namespace prefix", () => {
    expect(run("[[Help:Style|]]").nodes[0]).toMatchObject({
      children: [{ type: "text", value: "Style" }],
    });
    expect(run("[[Help:Style (guide)|]]").nodes[0]).toMatchObject({
      children: [{ type: "text", value: "Style" }],
    });
  });

  it("§5.2 the default label is the target as written", () => {
    expect(run("[[main_hall]]").nodes[0]).toMatchObject({
      children: [{ type: "text", value: "main_hall" }],
    });
    expect(run("[[Help:Style#Naming]]").nodes[0]).toMatchObject({
      children: [{ type: "text", value: "Help:Style#Naming" }],
    });
  });

  it("§5.11-3 fragment encoding in the href, plain title attribute", () => {
    expect(html("[[Sales & Deals#50% off]]")).toBe(
      '<a href="/wiki/sales-deals?redlink=1#50%25_off" class="new"' +
        ' title="Sales &amp; Deals (page does not exist)">Sales &amp; Deals#50% off</a>',
    );
  });

  it("§5.5 same-page anchors are never red and carry no title", () => {
    expect(html("[[#Section 2]]")).toBe('<a href="#Section_2">#Section 2</a>');
    expect(run("[[#Section 2]]").meta.linksTo).toEqual([]);
  });

  it("C-31 an inner [[ abandons the outer link", () => {
    expect(html("[[Foo|see [[Bar]] here]]")).toBe(
      '[[Foo|see <a href="/wiki/bar" title="Bar">Bar</a> here]]',
    );
  });

  it("§5.1 an invalid target renders literally", () => {
    expect(html("[[bad<title]]")).toBe("[[bad&lt;title]]");
  });

  it("§5.1 later pipes belong to the label verbatim", () => {
    expect(run("[[Bar|b|c]]").nodes[0]).toMatchObject({
      children: [{ type: "text", value: "b|c" }],
    });
  });

  it("Addendum A4: linksTo records red links, deduped, storable only", () => {
    const { meta } = run("[[Bracken]] [[Nonexistent page]] [[bracken]] [[Help:Style]]");
    expect(meta.linksTo).toEqual(["0:Bracken", "0:Nonexistent_page"]);
  });

  it("decisions O2: non-storable namespaces are always red", () => {
    expect(run("[[Help:Style]]").nodes[0]).toMatchObject({ exists: false });
  });

  it("Korean titles keep their letters in the slug (O1)", () => {
    expect(html("[[달의 이름]]")).toBe(
      '<a href="/wiki/%EB%8B%AC%EC%9D%98-%EC%9D%B4%EB%A6%84?redlink=1" class="new"' +
        ' title="달의 이름 (page does not exist)">달의 이름</a>',
    );
  });

  it("Korean fragment + label", () => {
    const link = run("[[문워크#개요|문워크]]").nodes[0] as WikiLink;
    expect(link.target.fragment).toBe("개요");
    expect(buildWikiLinkHref(link, makeCtx())).toBe(
      "/wiki/%EB%AC%B8%EC%9B%8C%ED%81%AC?redlink=1#%EA%B0%9C%EC%9A%94",
    );
  });

  it("§5.6 subpages resolve against the current page", () => {
    const page: Title = { namespace: 0, pageName: "Guides/Routing" };
    expect(run("[[/Speedrun]]", page).nodes[0]).toMatchObject({
      target: { namespace: 0, pageName: "Guides/Routing/Speedrun" },
      exists: true,
      children: [{ type: "text", value: "/Speedrun" }],
    });
    expect(run("[[/Speedrun/]]", page).nodes[0]).toMatchObject({
      target: { pageName: "Guides/Routing/Speedrun" },
      children: [{ type: "text", value: "Speedrun" }],
    });
    expect(run("[[../]]", page).nodes[0]).toMatchObject({
      target: { pageName: "Guides" },
      children: [{ type: "text", value: "Guides" }],
    });
    expect(run("[[../Looting]]", page).nodes[0]).toMatchObject({
      target: { pageName: "Guides/Looting" },
      children: [{ type: "text", value: "../Looting" }],
    });
    expect(html("[[../../Top]]", page)).toBe("[[../../Top]]");
  });
});

/* ---------------------------------------------------------------- */
/* §5.9 files / §5.10 categories                                     */
/* ---------------------------------------------------------------- */

describe("§5.9 file links", () => {
  it("C-34 a caption may contain links (bracket-balanced scan)", () => {
    const { nodes } = run("[[File:X.png|thumb|A [[Bracken]] pic]]");
    const img = nodes[0] as ImageLink;
    expect(img.type).toBe("image");
    expect(img.format).toBe("thumb");
    expect(img.exists).toBe(true);
    expect(renderNodes(img.caption, makeCtx())).toBe(
      'A <a href="/wiki/bracken" title="Bracken">Bracken</a> pic',
    );
  });

  it("§5.9 the full option table, last of a group wins", () => {
    const img = run(
      "[[File:Facility map.png|thumb|left|right|upright=1.2|border|alt=Facility layout|The ''main'' facility]]",
    ).nodes[0] as ImageLink;
    expect(img.format).toBe("thumb");
    expect(img.halign).toBe("right");
    expect(img.upright).toBeCloseTo(1.2);
    expect(img.border).toBe(true);
    expect(img.alt).toBe("Facility layout");
    expect(renderNodes(img.caption, makeCtx())).toBe("The <i>main</i> facility");
  });

  it("§5.9 sizes, valign and link=", () => {
    const a = run("[[File:X.png|200px]]").nodes[0] as ImageLink;
    expect(a).toMatchObject({ width: 200, format: "inline" });
    const b = run("[[File:X.png|x120px|middle]]").nodes[0] as ImageLink;
    expect(b).toMatchObject({ height: 120, valign: "middle" });
    const c = run("[[File:X.png|100x80px|link=]]").nodes[0] as ImageLink;
    expect(c).toMatchObject({ width: 100, height: 80, link: null });
    const d = run("[[File:X.png|link=Bracken]]").nodes[0] as ImageLink;
    expect(d.link).toMatchObject({ namespace: 0, pageName: "Bracken" });
    const e = run("[[File:X.png|link=https://x.example]]").nodes[0] as ImageLink;
    expect(e.link).toBe("https://x.example");
  });

  it("§5.9 a missing file is marked, upright defaults to config", () => {
    const img = run("[[File:Nope.png|frameless|upright]]").nodes[0] as ImageLink;
    expect(img.exists).toBe(false);
    expect(img.format).toBe("frameless");
    expect(img.upright).toBeCloseTo(0.75);
  });

  it("§5.9 earlier unmatched parameters warn and are discarded", () => {
    const { meta } = run("[[File:X.png|thumb|first|second]]");
    expect(meta.warnings).toHaveLength(1);
    expect(meta.warnings[0]).toContain("first");
  });

  it("§5.8 [[:File:…]] is an ordinary link, not an embed", () => {
    expect(html("[[:File:X.png]]")).toBe(
      '<a href="/wiki/file:x.png" title="File:X.png">File:X.png</a>',
    );
  });
});

describe("§5.10 categories", () => {
  it("C-32 a category-only line vanishes and records metadata", () => {
    const { html: out, meta } = run("[[Category:Moons|T]]");
    expect(out).toBe("");
    expect(meta.categories).toEqual([{ name: "Moons", sortKey: "T" }]);
    expect(meta.linksTo).toEqual([]);
  });

  it("§5.11-6 a category line disappears from a multi-line region", () => {
    const { html: out, meta } = run("[[Category:Moons|Titan]]\nSee [[:Category:Moons]].");
    expect(out).toBe(
      'See <a href="/wiki/category:moons" title="Category:Moons">Category:Moons</a>.',
    );
    expect(meta.categories).toEqual([{ name: "Moons", sortKey: "Titan" }]);
  });

  it("C-33 [[:Category:…]] is a plain link and is recorded in linksTo", () => {
    expect(run("[[:Category:Moons]]").meta.linksTo).toEqual(["14:Moons"]);
  });

  it("§5.10 duplicate category: the last sort key wins", () => {
    const { meta } = run("x [[Category:Moons|A]] y [[Category:Moons|B]] z");
    expect(meta.categories).toEqual([{ name: "Moons", sortKey: "B" }]);
  });

  it("§5.10 an inline category renders nothing but keeps its trail", () => {
    expect(html("a [[Category:Moons]]b")).toBe("a b");
  });
});

/* ---------------------------------------------------------------- */
/* §6 external links                                                 */
/* ---------------------------------------------------------------- */

describe("§6 external links", () => {
  it("§6.4-1 labeled", () => {
    expect(html("[https://lethal.wiki the other wiki]")).toBe(
      '<a class="external text" rel="nofollow noopener" href="https://lethal.wiki">the other wiki</a>',
    );
  });

  it("C-35 auto-numbering runs in document order", () => {
    expect(html("See [https://a.example] and [https://b.example].")).toBe(
      'See <a class="external autonumber" rel="nofollow noopener" href="https://a.example">[1]</a>' +
        ' and <a class="external autonumber" rel="nofollow noopener" href="https://b.example">[2]</a>.',
    );
  });

  it("§6.2 the counter is page-scoped, not region-scoped", () => {
    const ctx = makeCtx();
    const meta = makeMeta();
    const first = parseInline("[https://a.example]", ctx, meta);
    const second = parseInline("[https://b.example]", ctx, meta);
    expect(renderNodes(first, ctx)).toContain(">[1]<");
    expect(renderNodes(second, ctx)).toContain(">[2]<");
  });

  it("C-36 free URL keeps balanced parens, trailing comma is text", () => {
    expect(html("Go to https://x.example/a_(b), then stop.")).toBe(
      'Go to <a class="external free" rel="nofollow noopener" href="https://x.example/a_(b)">' +
        "https://x.example/a_(b)</a>, then stop.",
    );
  });

  it("§6.3 trailing sentence punctuation is trimmed off a free URL", () => {
    expect(html("See http://x.com.")).toBe(
      'See <a class="external free" rel="nofollow noopener" href="http://x.com">http://x.com</a>.',
    );
  });

  it("§6.3 an unmatched closing paren is trimmed", () => {
    expect(html("(https://x.example)")).toBe(
      '(<a class="external free" rel="nofollow noopener" href="https://x.example">https://x.example</a>)',
    );
  });

  it("§6.3 free URLs must start at a word boundary", () => {
    expect(html("xhttp://a.example")).toBe("xhttp://a.example");
  });

  it("C-37 a bad scheme stays literal", () => {
    expect(html("[javascript:alert(1) click]")).toBe("[javascript:alert(1) click]");
    expect(html("[data:text/html,x y]")).toBe("[data:text/html,x y]");
  });

  it("C-38 formatting inside a bracketed label", () => {
    expect(html("[https://x.example ''lbl'']")).toBe(
      '<a class="external text" rel="nofollow noopener" href="https://x.example"><i>lbl</i></a>',
    );
  });

  it("§6.4-5 the first ] closes the link, the rest is literal", () => {
    expect(html("[https://x.example ''styled'' [label]]")).toBe(
      '<a class="external text" rel="nofollow noopener" href="https://x.example">' +
        "<i>styled</i> [label</a>]",
    );
  });

  it("§6.3 URLs inside a bracketed label are not re-linkified", () => {
    expect(html("[https://x.example see https://y.example]")).toBe(
      '<a class="external text" rel="nofollow noopener" href="https://x.example">' +
        "see https://y.example</a>",
    );
  });

  it("§6.3 URLs inside an internal-link label are not linkified", () => {
    expect(html("[[Bar|https://y.example]]")).toBe(
      '<a href="/wiki/bar" title="Bar">https://y.example</a>',
    );
  });

  it("§6.1 protocol-relative and mailto forms", () => {
    expect(html("[//x.example lbl]")).toContain('href="//x.example"');
    expect(html("mailto:a@b.example")).toContain('href="mailto:a@b.example"');
  });

  it("§6.2 a bracketed link with only whitespace after the URL auto-numbers", () => {
    expect(html("[https://a.example ]")).toContain(">[1]<");
  });
});

/* ---------------------------------------------------------------- */
/* §11 raw HTML, §3.4 <br>, §11.5 entities, strip markers            */
/* ---------------------------------------------------------------- */

describe("§11 inline HTML, entities, markers", () => {
  it("C-68 an unclosed inline tag is balanced at the end of the region", () => {
    expect(html("<b>unclosed")).toBe("<b>unclosed</b>");
  });

  it("§11.6-4 overlap is repaired and stray close tags are dropped", () => {
    expect(html("<b>bold <i>both</b> italic?</i>")).toBe(
      "<b>bold <i>both</i></b> italic?",
    );
  });

  it("§11.1 attributes survive tokenization", () => {
    expect(html('<span style="color: #c00" class="x">danger</span>')).toBe(
      '<span style="color: #c00" class="x">danger</span>',
    );
  });

  it("§3.4 every spelling of <br> normalizes to one node", () => {
    expect(html("a<br>b<br />c<BR>d<br clear=left>e</br>f")).toBe(
      "a<br />b<br />c<br />d<br />e<br />f",
    );
  });

  it("§11.5 known references become entity nodes, unknown ones stay text", () => {
    const { nodes, html: out } = run("&copy; &#169; &#x2014; &notareal; &");
    expect(out).toBe("&copy; &#169; &#x2014; &amp;notareal; &amp;");
    expect(nodes.filter((n) => n.type === "entity")).toHaveLength(3);
  });

  it("§14.8 strip markers pass through untouched and are atomic", () => {
    const { nodes } = run(`a ${MARKER} '''b'''`);
    expect(nodes[1]).toEqual({ type: "strip", marker: MARKER });
    expect(nodes[3]).toEqual({ type: "b", children: [{ type: "text", value: "b" }] });
  });

  it("wikitext inside allowed HTML still parses (§11.6-5)", () => {
    expect(html("<sup>''x'' [[Bracken]]</sup>")).toBe(
      '<sup><i>x</i> <a href="/wiki/bracken" title="Bracken">Bracken</a></sup>',
    );
  });

  it("[[ inside an attribute value is not link syntax", () => {
    expect(html('<span title="[[x]]">y</span>')).toBe('<span title="[[x]]">y</span>');
  });

  it("text nodes escape < > &", () => {
    expect(html("a &lt; b > c & d")).toBe("a &lt; b &gt; c &amp; d");
  });
});

/* ---------------------------------------------------------------- */
/* Shared helpers used by the other stages                           */
/* ---------------------------------------------------------------- */

describe("shared helpers", () => {
  it("titleKey is the ns:Normalized_page_name key of types.ts §14.10", () => {
    expect(titleKey({ namespace: 0, pageName: "Gold bar" })).toBe("0:Gold_bar");
    expect(titleKey({ namespace: 10, pageName: "Infobox moon" })).toBe(
      "10:Infobox_moon",
    );
    expect(titleKey({ namespace: 12, pageName: "Style" })).toBe("12:Style");
  });

  it("determinism: the same source parses byte-identically", () => {
    const source = "''a'' [[Bracken]]s [https://a.example] [[File:X.png|thumb|c]]";
    expect(html(source)).toBe(html(source));
  });
});
