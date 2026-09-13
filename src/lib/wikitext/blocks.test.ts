/**
 * Stage 4 (block parse) conformance tests — spec §2, §3, §4, §7, §12,
 * Addendum A1/D-14, and the §15 corpus cases that fall in this stage.
 *
 * The assertions run through a deliberately dumb AST→HTML serializer defined
 * below: it renders exactly what stage 4 decided (structure, attributes,
 * anchors) and leaves inline regions as their raw source, which is what
 * `parseBlocks` produces without an injected stage-5 parser. Whitespace
 * between block-level tags is not asserted (§15).
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_NAMESPACES } from "@/lib/title";

import { parseBlocks } from "./blocks";
import { findSplitColon } from "./lists";
import {
  filterStyleValue,
  parseHtmlAttributes,
  splitCellAttrs,
  splitCellPieces,
} from "./tables";
import type { EngineStages } from "./index";
import type {
  Attrs,
  BlockNode,
  InlineNode,
  PageMeta,
  ParseContext,
  VersionTable,
  WikiConfig,
} from "./types";

/* ---------------------------------------------------------------- */
/* Fixtures                                                          */
/* ---------------------------------------------------------------- */

const versions: VersionTable = {
  byId: { v70: { id: "v70", label: "v70", ordinal: 70000, status: "current" } },
  ordered: [{ id: "v70", label: "v70", ordinal: 70000, status: "current" }],
  defaultId: "v70",
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
    citeErrorNoText: (n) => `no text for ${n}`,
    templateLoop: "loop",
    templateDepthExceeded: "depth",
    unknownVersion: (id) => `unknown ${id}`,
  },
};

function makeCtx(): ParseContext {
  return {
    config,
    store: {
      getSource: () => null,
      exists: () => false,
      getFile: () => null,
    },
    page: { namespace: 0, pageName: "Page" },
    version: null,
    versions,
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

/** Stage 0 guarantees a trailing newline; mirror that here. */
function run(source: string): { blocks: BlockNode[]; meta: PageMeta } {
  const meta = makeMeta();
  const blocks = parseBlocks(source.endsWith("\n") ? source : `${source}\n`, makeCtx(), meta);
  return { blocks, meta };
}

function html(source: string): string {
  return blocksHtml(run(source).blocks);
}

/* ---------------------------------------------------------------- */
/* Minimal serializer                                                */
/* ---------------------------------------------------------------- */

const BLOCK_TYPES = new Set([
  "p",
  "heading",
  "hr",
  "pre",
  "list",
  "dl",
  "table",
  "html-block",
  "toc",
  "references",
  "gallery",
  "redirect",
]);

function attrsHtml(attrs: Attrs): string {
  return Object.keys(attrs)
    .map((k) => ` ${k}="${attrs[k]}"`)
    .join("");
}

function inlineHtml(nodes: InlineNode[]): string {
  return nodes
    .map((n) => {
      if (n.type === "text") return n.value;
      if (n.type === "br") return "<br />";
      return `<${n.type}/>`;
    })
    .join("");
}

function mixedHtml(nodes: (InlineNode | BlockNode)[]): string {
  const inlineRun: InlineNode[] = [];
  let out = "";
  for (const n of nodes) {
    if (BLOCK_TYPES.has(n.type)) {
      out += inlineHtml(inlineRun.splice(0));
      out += blockHtml(n as BlockNode);
    } else {
      inlineRun.push(n as InlineNode);
    }
  }
  return out + inlineHtml(inlineRun);
}

function blockHtml(b: BlockNode): string {
  switch (b.type) {
    case "p":
      return `<p>${inlineHtml(b.children)}</p>`;
    case "heading":
      return `<h${b.level} id="${b.id}">${inlineHtml(b.children)}</h${b.level}>`;
    case "hr":
      return "<hr />";
    case "pre":
      return `<pre>${inlineHtml(b.children)}</pre>`;
    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      return `<${tag}>${b.items.map((li) => `<li>${mixedHtml(li.children)}</li>`).join("")}</${tag}>`;
    }
    case "dl":
      return `<dl>${b.items
        .map((it) => `<${it.type}>${mixedHtml(it.children)}</${it.type}>`)
        .join("")}</dl>`;
    case "table": {
      const fostered = b.fostered.map(blockHtml).join("");
      const caption = b.caption
        ? `<caption${attrsHtml(b.caption.attrs)}>${inlineHtml(b.caption.children)}</caption>`
        : "";
      const rows = b.rows
        .map(
          (r) =>
            `<tr${attrsHtml(r.attrs)}>${r.cells
              .map((c) => {
                const tag = c.header ? "th" : "td";
                return `<${tag}${attrsHtml(c.attrs)}>${c.children.map(blockHtml).join("")}</${tag}>`;
              })
              .join("")}</tr>`,
        )
        .join("");
      return `${fostered}<table${attrsHtml(b.attrs)}>${caption}<tbody>${rows}</tbody></table>`;
    }
    case "html-block":
      // Non-wrapping container: children only (see blocks.ts contract note).
      return mixedHtml(b.children);
    case "toc":
      return "<toc />";
    case "redirect":
      return `<redirect to="${b.targetText}" ns="${b.target.namespace}" name="${b.target.pageName}" frag="${b.target.fragment ?? ""}" />`;
    default:
      return `<${b.type} />`;
  }
}

function blocksHtml(blocks: BlockNode[]): string {
  return blocks.map(blockHtml).join("");
}

/* ---------------------------------------------------------------- */

describe("stage contract", () => {
  it("parseBlocks is assignable to EngineStages['parseBlocks']", () => {
    const stage: EngineStages["parseBlocks"] = parseBlocks;
    expect(typeof stage).toBe("function");
  });
});

describe("headings (§2)", () => {
  it("C-10: `====` is <h1>==</h1>", () => {
    expect(html("====")).toBe('<h1 id="==">==</h1>');
  });

  it("C-11: trailing spaces after the closing run are allowed", () => {
    expect(html("== A ==  ")).toBe('<h2 id="A">A</h2>');
  });

  it("C-12: text after the closing run makes it a paragraph", () => {
    expect(html("== A == b")).toBe("<p>== A == b</p>");
  });

  it("C-14: duplicate ids get _2, _3", () => {
    expect(html("== X ==\n== X ==\n== X ==")).toBe(
      '<h2 id="X">X</h2><h2 id="X_2">X</h2><h2 id="X_3">X</h2>',
    );
  });

  it("§2.7-3: unbalanced markers fall through, surplus = becomes content", () => {
    expect(html("==Unbalanced=")).toBe('<h1 id="=Unbalanced">=Unbalanced</h1>');
    expect(html("=Foo==")).toBe('<h1 id="Foo=">Foo=</h1>');
  });

  it("recognizes level 6 (greedy level-6-down matching)", () => {
    expect(html("====== deep ======")).toBe('<h6 id="deep">deep</h6>');
  });

  it("§2.4: a literal `Foo 2` heading colliding with a generated Foo_2 bumps again", () => {
    expect(html("== Foo ==\n== Foo ==\n== Foo 2 ==")).toBe(
      '<h2 id="Foo">Foo</h2><h2 id="Foo_2">Foo</h2><h2 id="Foo_2_2">Foo 2</h2>',
    );
  });

  it("§2.7-2: anchor strips wiki markup and collapses whitespace", () => {
    const out = run("=== The ''[[Bracken]]'' room ===").blocks[0];
    expect(out?.type).toBe("heading");
    expect(out && out.type === "heading" ? out.id : "").toBe("The_Bracken_room");
  });

  it("§2.7-5: a leading space makes it preformatted, not a heading", () => {
    expect(html(" == Leading space ==")).toBe("<pre>== Leading space ==\n</pre>");
  });

  it("§2.4-5: heading content with no plain text yields the `_` anchor", () => {
    expect(html("== '' ==")).toBe("<h2 id=\"_\">''</h2>");
  });
});

describe("behavior switches (§2.6)", () => {
  it("records __NOTOC__ and removes the line it owned", () => {
    const { blocks, meta } = run("a\n__NOTOC__\nb");
    expect(meta.behaviorSwitches.has("NOTOC")).toBe(true);
    expect(blocksHtml(blocks)).toBe("<p>a\nb</p>");
  });

  it("places a TocPlaceholder at the first __TOC__ and records the switch", () => {
    const { blocks, meta } = run("a\n__TOC__\n== H ==");
    expect(meta.behaviorSwitches.has("TOC")).toBe(true);
    expect(blocksHtml(blocks)).toBe('<p>a</p><toc /><h2 id="H">H</h2>');
  });

  it("only the first __TOC__ places; later ones vanish with their line", () => {
    const { blocks } = run("__TOC__\nx\n__TOC__\ny");
    expect(blocks.filter((b) => b.type === "toc").length).toBe(1);
    expect(blocksHtml(blocks)).toBe('<toc /><p>x\ny</p>');
  });

  it("unknown __WORD__ stays literal text", () => {
    expect(html("__FOO__")).toBe("<p>__FOO__</p>");
  });

  it("removes a mid-line switch but keeps the rest of the line", () => {
    const { blocks, meta } = run("keep__NOINDEX__me");
    expect(meta.behaviorSwitches.has("NOINDEX")).toBe(true);
    expect(blocksHtml(blocks)).toBe("<p>keepme</p>");
  });
});

describe("paragraphs, pre and hr (§3)", () => {
  it("C-15: a single newline stays in the same paragraph", () => {
    expect(html("a\nb")).toBe("<p>a\nb</p>");
  });

  it("C-16: two blank lines make the next paragraph start with <br />", () => {
    expect(html("a\n\n\nb")).toBe("<p>a</p><p><br />\nb</p>");
  });

  it("§3.2: k=3 blank lines emit one empty paragraph then the <br /> prefix", () => {
    expect(html("a\n\n\n\nb")).toBe("<p>a</p><p><br /></p><p><br />\nb</p>");
  });

  it("§3.2: one blank line just splits the paragraphs", () => {
    expect(html("a\nb\n\nc")).toBe("<p>a\nb</p><p>c</p>");
  });

  it("§3.2: blank lines at the very start and end produce nothing", () => {
    expect(html("\n\n\na\n\n\n")).toBe("<p>a</p>");
  });

  it("C-18: `----text` is an hr followed by a paragraph", () => {
    expect(html("----text")).toBe("<hr /><p>text</p>");
  });

  it("§3.4: a long hyphen run is still one hr; `------rest` re-queues `rest`", () => {
    expect(html("before\n----\nafter\n------rest")).toBe(
      "<p>before</p><hr /><p>after</p><hr /><p>rest</p>",
    );
  });

  it("§3.4: three hyphens are plain text", () => {
    expect(html("---")).toBe("<p>---</p>");
  });

  it("C-17: space-pre keeps its inline region (markup still parses later)", () => {
    expect(html(" ''pre'' with markup")).toBe("<pre>''pre'' with markup\n</pre>");
  });

  it("§3.3: only the first space is the marker; lines join with newlines", () => {
    expect(html(" def parse():\n     return x")).toBe("<pre>def parse():\n    return x\n</pre>");
  });

  it("§3.3: a fully empty line closes the pre block", () => {
    expect(html(" one\n\n two")).toBe("<pre>one\n</pre><pre>two\n</pre>");
  });

  it("§3.3: a single-space line between pre lines stays inside as an empty line", () => {
    expect(html(" one\n \n two")).toBe("<pre>one\n\ntwo\n</pre>");
  });

  it("§3.1 rule 4: a block-level HTML line is not wrapped in <p>", () => {
    expect(html("<div>hi</div>\ntext")).toBe("<div>hi</div><p>text</p>");
  });
});

describe("blank lines inside p-rejecting raw HTML (Addendum A1 / D-14)", () => {
  it("emits nothing for blank runs while a raw <table> is open", () => {
    // §11.2: the open `<table>` keeps the whole run in ONE inline region, so it
    // is balanced across those lines rather than closed at the end of its own.
    // The blank run vanishes, and the stray text line stays bare — a `<p>`
    // inside `<table>` is precisely the invalid markup A1/D-14 rules out.
    expect(html("<table>\n<tr><td>a</td></tr>\n\n\ntext\n</table>")).toBe(
      "<table>\n<tr><td>a</td></tr>\ntext\n</table>",
    );
  });

  it("contrast: the same blank run outside any raw block emits the <br /> prefix", () => {
    expect(html("<div>a</div>\n\n\ntext")).toBe("<div>a</div><p><br />\ntext</p>");
  });

  it("re-enables the §3.2 rules once the element closes", () => {
    expect(html("<table>\n</table>\nx\n\n\ny")).toBe(
      "<table>\n</table><p>x</p><p><br />\ny</p>",
    );
  });
});

describe("lists (§4)", () => {
  it("C-19: `* a / *# b / *# c` nests the ol inside the still-open li", () => {
    expect(html("* a\n*# b\n*# c")).toBe("<ul><li>a<ol><li>b</li><li>c</li></ol></li></ul>");
  });

  it("§4.6-1: flat and nested bullets", () => {
    expect(html("* one\n* two\n** two.one\n* three")).toBe(
      "<ul><li>one</li><li>two<ul><li>two.one</li></ul></li><li>three</li></ul>",
    );
  });

  it("C-22 / §4.6-2: `#:` and `#*` continue the ordered item", () => {
    expect(html("# first\n#: aside\n# second\n#* sub\n# third")).toBe(
      "<ol><li>first<dl><dd>aside</dd></dl></li><li>second<ul><li>sub</li></ul></li>" +
        "<li>third</li></ol>",
    );
  });

  it("C-21: a blank line closes the list and restarts numbering", () => {
    expect(html("# a\n# b\n\n# c")).toBe("<ol><li>a</li><li>b</li></ol><ol><li>c</li></ol>");
  });

  it("§4.6-4: `; term : def` splits, and bare `;` / `:` lines share one dl", () => {
    expect(html("; Quota : the target\n; Bracken\n: a monster\n: another")).toBe(
      "<dl><dt>Quota</dt><dd>the target</dd><dt>Bracken</dt><dd>a monster</dd>" +
        "<dd>another</dd></dl>",
    );
  });

  it("C-20: a colon inside [[…]] does not split the definition", () => {
    expect(html("; [[Help:Contents]] : d")).toBe("<dl><dt>[[Help:Contents]]</dt><dd>d</dd></dl>");
  });

  it("§4.3: only the first eligible colon splits", () => {
    expect(html("; a : b : c")).toBe("<dl><dt>a</dt><dd>b : c</dd></dl>");
  });

  it("§4.6-6: mixed `*#;` markers", () => {
    expect(html("*# a\n*#; term : def\n*# b")).toBe(
      "<ul><li><ol><li>a<dl><dt>term</dt><dd>def</dd></dl></li><li>b</li></ol></li></ul>",
    );
  });

  it("§4.6-7: `;` and `:` share one dl even when the order reverses", () => {
    expect(html(": dd first\n; dt second")).toBe("<dl><dd>dd first</dd><dt>dt second</dt></dl>");
  });

  it("§4.6-8: `::` is two indentation levels", () => {
    expect(html(":: two levels in")).toBe("<dl><dd><dl><dd>two levels in</dd></dl></dd></dl>");
  });

  it("§4.6-9: a bare marker yields an empty item", () => {
    expect(html("*\n* x")).toBe("<ul><li></li><li>x</li></ul>");
  });

  it("a different root marker closes the list and opens a new one", () => {
    expect(html("* a\n# b")).toBe("<ul><li>a</li></ul><ol><li>b</li></ol>");
  });

  it("C-23: a table cannot start inside a list item", () => {
    expect(html("*{|\n| x\n|}")).toBe("<ul><li>{|</li></ul><p>| x\n|}</p>");
  });

  it("§4.4: a heading marker inside a list item is literal", () => {
    expect(html("*== x ==")).toBe("<ul><li>== x ==</li></ul>");
  });
});

describe("tables (§7)", () => {
  it("§7.11-1: attributes, caption, header row and a cell attribute", () => {
    const out = html(
      '{| class="wikitable" style="width:20em"\n' +
        "|+ Scrap values\n|-\n! Item !! Value\n|-\n| Gold bar || 210\n|-\n" +
        '| style="color:red" | Flask || 30\n|}',
    );
    expect(out).toBe(
      '<table class="wikitable" style="width:20em"><caption>Scrap values</caption><tbody>' +
        "<tr><th>Item</th><th>Value</th></tr>" +
        "<tr><td>Gold bar</td><td>210</td></tr>" +
        '<tr><td style="color:red">Flask</td><td>30</td></tr>' +
        "</tbody></table>",
    );
  });

  it("C-41 / §7.11-2: `[[` vetoes the attribute split; a bogus attr segment is dropped", () => {
    expect(html('{|\n| colspan="2" | wide || [[a|b]] || x | y | z\n|}')).toBe(
      '<table><tbody><tr><td colspan="2">wide</td><td>[[a|b]]</td><td>y | z</td></tr>' +
        "</tbody></table>",
    );
  });

  it("C-42: a header line splits on both `!!` and `||`", () => {
    expect(html("{|\n! a !! b || c\n|}")).toBe(
      "<table><tbody><tr><th>a</th><th>b</th><th>c</th></tr></tbody></table>",
    );
  });

  it("§7.3: `!!` does not split a data line", () => {
    expect(html("{|\n| a !! b\n|}")).toBe("<table><tbody><tr><td>a !! b</td></tr></tbody></table>");
  });

  it("C-40: a pipe arriving pre-expanded from {{!}} is real table markup", () => {
    expect(html("{|\n| a|b\n|}")).toBe("<table><tbody><tr><td>b</td></tr></tbody></table>");
  });

  it("§7.11-3: a multi-line cell gets normal block treatment (implicit first row)", () => {
    expect(html("{|\n| Monsters:\n* [[Bracken]]\n* [[Thumper]]\n| Safe\n|}")).toBe(
      "<table><tbody><tr><td><p>Monsters:</p><ul><li>[[Bracken]]</li><li>[[Thumper]]</li></ul>" +
        "</td><td>Safe</td></tr></tbody></table>",
    );
  });

  it("C-43 / §7.11-4: a `{|` inside a cell starts a nested table", () => {
    expect(html('{|\n| outer\n|\n{| class="inner"\n| nested\n|}\n|}')).toBe(
      "<table><tbody><tr><td>outer</td>" +
        '<td><table class="inner"><tbody><tr><td>nested</td></tr></tbody></table></td>' +
        "</tr></tbody></table>",
    );
  });

  it("C-44: `|+ attrs | caption`", () => {
    expect(html('{|\n|+ class="c" | Cap\n| x\n|}')).toBe(
      '<table><tbody><caption class="c">Cap</caption>'.replace(
        '<tbody><caption class="c">Cap</caption>',
        '<caption class="c">Cap</caption><tbody>',
      ) + "<tr><td>x</td></tr></tbody></table>",
    );
  });

  it("§7.4: a second caption is dropped with a warning", () => {
    const { blocks, meta } = run("{|\n|+ one\n|+ two\n| x\n|}");
    expect(blocksHtml(blocks)).toBe(
      "<table><caption>one</caption><tbody><tr><td>x</td></tr></tbody></table>",
    );
    expect(meta.warnings.length).toBe(1);
  });

  it("C-45 / §7.11-7: fostered content is emitted before the table; empty rows vanish", () => {
    expect(html("{|\nstray\n|-\n|-\n| only cell\n|-\n|}")).toBe(
      "<p>stray</p><table><tbody><tr><td>only cell</td></tr></tbody></table>",
    );
  });

  it("§7.11-5: rowspan and a row continuing after `|-`", () => {
    expect(html('{|\n! A !! B || C\n|-\n| rowspan="2" | tall || r1\n|-\n| r2\n|}')).toBe(
      "<table><tbody><tr><th>A</th><th>B</th><th>C</th></tr>" +
        '<tr><td rowspan="2">tall</td><td>r1</td></tr>' +
        "<tr><td>r2</td></tr></tbody></table>",
    );
  });

  it("C-24: `:{|` wraps the table in a dl/dd level", () => {
    expect(html(":{|\n| x\n|}")).toBe(
      "<dl><dd><table><tbody><tr><td>x</td></tr></tbody></table></dd></dl>",
    );
  });

  it("§7.11-6: text after `|}` is re-queued as a new line after the table", () => {
    expect(html(":{|\n| x\n|} tail")).toBe(
      "<dl><dd><table><tbody><tr><td>x</td></tr></tbody></table></dd></dl><p>tail</p>",
    );
  });

  it("§7.1: a space-indented `|` line is cell continuation, not a marker", () => {
    expect(html("{|\n| a\n | b\n|}")).toBe(
      "<table><tbody><tr><td><p>a</p><pre>| b\n</pre></td></tr></tbody></table>",
    );
  });

  it("§7.5: rows carry their own attributes", () => {
    expect(html('{|\n|- style="color:red"\n| x\n|}')).toBe(
      '<table><tbody><tr style="color:red"><td>x</td></tr></tbody></table>',
    );
  });

  it("§7.1: `|----` is tolerated as a row separator", () => {
    expect(html("{|\n| a\n|----\n| b\n|}")).toBe(
      "<table><tbody><tr><td>a</td></tr><tr><td>b</td></tr></tbody></table>",
    );
  });

  it("§11.3: disallowed attributes are dropped silently", () => {
    expect(html('{|\n| onclick="x()" id="c" | v\n|}')).toBe(
      '<table><tbody><tr><td id="c">v</td></tr></tbody></table>',
    );
  });

  it("§11.4: a hostile style value is replaced wholesale", () => {
    expect(html('{|\n| style="background:url(e)" | v\n|}')).toBe(
      '<table><tbody><tr><td style="/* insecure input */">v</td></tr></tbody></table>',
    );
  });
});

describe("redirects (§12)", () => {
  it("C-70: `#REDIRECT [[Target#Frag]]` sets meta.redirect with the fragment on the target", () => {
    const { blocks, meta } = run("#REDIRECT [[Target#Frag]]");
    expect(meta.redirect?.target.namespace).toBe(0);
    expect(meta.redirect?.target.pageName).toBe("Target");
    expect(meta.redirect?.target.fragment).toBe("Frag");
    expect(blocksHtml(blocks)).toBe(
      '<redirect to="Target#Frag" ns="0" name="Target" frag="Frag" />',
    );
    expect(meta.linksTo).toContain("0:Target");
  });

  it("§12.3: content after the redirect line still renders below the notice", () => {
    const { blocks, meta } = run("#redirect:[[Target]]\nbody text");
    expect(meta.redirect?.target.pageName).toBe("Target");
    expect(blocksHtml(blocks)).toBe(
      '<redirect to="Target" ns="0" name="Target" frag="" /><p>body text</p>',
    );
  });

  it("C-71: `#REDIRECT` not at the top of the page is ordinary list markup", () => {
    const { blocks, meta } = run("text\n#REDIRECT [[Target]]");
    expect(meta.redirect).toBeUndefined();
    expect(blocksHtml(blocks)).toBe("<p>text</p><ol><li>REDIRECT [[Target]]</li></ol>");
  });

  it("§12.1: an invalid target means the page is not a redirect", () => {
    const { meta } = run("#REDIRECT [[]]");
    expect(meta.redirect).toBeUndefined();
  });
});

describe("interplay", () => {
  it("C-72: four headings, unique ids, and a comment-emptied line already gone", () => {
    const { blocks } = run("== T ==\n== T ==\n== A ==\n== B ==");
    const ids = blocks.filter((b) => b.type === "heading").map((b) => (b as { id: string }).id);
    expect(ids).toEqual(["T", "T_2", "A", "B"]);
  });

  it("an inline parser can be injected and receives each region's source", () => {
    const meta = makeMeta();
    const seen: string[] = [];
    const blocks = parseBlocks("== H ==\ntext\n", makeCtx(), meta, (t) => {
      seen.push(t);
      return [{ type: "text", value: t.toUpperCase() }];
    });
    expect(seen).toEqual(["H", "text"]);
    expect(blocksHtml(blocks)).toBe('<h2 id="H">H</h2><p>TEXT</p>');
  });
});

describe("edge cases", () => {
  it("an empty document yields no blocks", () => {
    expect(html("")).toBe("");
    expect(html("\n\n\n")).toBe("");
  });

  it("§7.3: a cell body re-enters the block parser (heading ids stay page-unique)", () => {
    expect(html("== T ==\n{|\n| x\n== T ==\n|}")).toBe(
      '<h2 id="T">T</h2><table><tbody><tr><td><p>x</p><h2 id="T_2">T</h2></td></tr>' +
        "</tbody></table>",
    );
  });

  it("§7.7: fostered lines are parsed as normal block content", () => {
    expect(html("{|\n* a\n| x\n|}")).toBe(
      "<ul><li>a</li></ul><table><tbody><tr><td>x</td></tr></tbody></table>",
    );
  });

  it("a strip marker is atomic inline text and is never blank", () => {
    const del = String.fromCharCode(0x7f);
    const marker = `${del}'"UNIQ--nowiki-0000002a-QINU"'${del}`;
    expect(html(marker)).toBe(`<p>${marker}</p>`);
  });
});

describe("helpers", () => {
  it("parseHtmlAttributes handles quoted, unquoted and bare names", () => {
    expect(parseHtmlAttributes(`a="1" b='2' c=3 d`)).toEqual({ a: "1", b: "2", c: "3", d: "" });
  });

  it("splitCellPieces splits on `||` always and `!!` only for headers", () => {
    expect(splitCellPieces("a||b!!c", false)).toEqual(["a", "b!!c"]);
    expect(splitCellPieces("a||b!!c", true)).toEqual(["a", "b", "c"]);
  });

  it("splitCellAttrs vetoes the split when `[[` precedes the pipe", () => {
    expect(splitCellAttrs("[[a|b]]")).toEqual({ attrs: null, content: "[[a|b]]" });
    expect(splitCellAttrs("x | y | z")).toEqual({ attrs: "x ", content: " y | z" });
  });

  it("filterStyleValue rejects unclosed comments and blocklisted functions", () => {
    expect(filterStyleValue("color:red")).toBe("color:red");
    expect(filterStyleValue("/* x")).toBe("/* insecure input */");
    expect(filterStyleValue("width:expression(1)")).toBe("/* insecure input */");
  });

  it("findSplitColon skips links, brackets, tags and strip markers", () => {
    expect(findSplitColon("[[Help:Contents]] : d")).toBe(18);
    expect(findSplitColon("[http://x/a:b l] : d")).toBe(17);
    expect(findSplitColon("<span title=\"a:b\">x</span> : d")).toBe(27);
    expect(findSplitColon("no colon here")).toBe(-1);
  });
});
