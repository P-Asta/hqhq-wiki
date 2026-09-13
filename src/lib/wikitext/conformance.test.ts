/**
 * The complete conformance corpus of wikitext-spec §15 (C-01 … C-74), driven
 * through the real `parse()` pipeline against the §15 fixture PageStore.
 *
 * Every case is named by its id. Where §15's expected output is written
 * against MediaWiki's `/wiki/Page_Title` href shape, the assertion uses the
 * shape decisions.md O1 mandates instead (`$1` = `nsPrefix + slugifyTitle`);
 * spec Addendum A5 explicitly defers `$1` to that decision, so this is the
 * spec's own escape hatch, not a divergence. Appendix A divergences D-1…D-14
 * are encoded as the expectation, never worked around.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_NAMESPACES } from "@/lib/title";

import { parse } from "./index";
import type { ParseContext, PageStore, Title, WikiConfig } from "./types";

/* ------------------------------------------------------------------ */
/* §15 fixtures                                                        */
/* ------------------------------------------------------------------ */

/** The six fixture templates of §15, keyed by `TitleKey`. */
const TEMPLATES: Record<string, string> = {
  "10:1x": "{{{1}}}",
  "10:N": "[{{{k}}}]",
  "10:Bullet": "* {{{1}}}",
  "10:Boxtop": '{| class="box"',
  "10:Boxend": "|}",
  "10:Loop": "{{Loop}}",
};

/** "Pages `Bracken`, `Moon`, `Quota`, `Bar`, `Page`, `Target` … exist". */
const PAGES = new Set([
  "0:Bracken",
  "0:Moon",
  "0:Quota",
  "0:Bar",
  "0:Page",
  "0:Target",
  "14:Moons",
  ...Object.keys(TEMPLATES),
]);

/** `File:X.png` is 100×80. */
const FILES: Record<string, { src: string; width: number; height: number }> = {
  "x.png": { src: "/api/media/x.png", width: 100, height: 80 },
};

const store: PageStore = {
  getSource: (title) => TEMPLATES[title] ?? null,
  exists: (title) => PAGES.has(title),
  getFile: (name) => FILES[name.toLowerCase()] ?? null,
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

function ctxFor(page: Title = { namespace: 0, pageName: "Sandbox" }): ParseContext {
  return {
    config,
    store,
    page,
    version: null,
    versions: { byId: {}, ordered: [], defaultId: "v1" },
  };
}

/** Parse one source with the §15 fixture store; returns the full result. */
function run(source: string, page?: Title) {
  return parse(source, ctxFor(page));
}

/** Just the HTML. */
function html(source: string, page?: Title): string {
  return run(source, page).html;
}

/**
 * §10.3 renders footnote brackets as `&#91;`/`&#93;` (as MediaWiki does); §15
 * writes them as the characters they display. Decode for readability.
 */
function refText(source: string): string {
  return html(source).replace(/&#91;/g, "[").replace(/&#93;/g, "]");
}

/* ------------------------------------------------------------------ */
/* Apostrophes (§1)                                                    */
/* ------------------------------------------------------------------ */

describe("§15 apostrophes", () => {
  it("C-01: five quotes open bold inside italic", () => {
    expect(html("'''''x'''''")).toBe("<p><i><b>x</b></i></p>");
  });

  it("C-02: four quotes leave a literal apostrophe before bold", () => {
    expect(html("''''x''''")).toBe("<p>'<b>x'</b></p>");
  });

  it("C-03: six quotes leave a literal apostrophe before bold-italic", () => {
    expect(html("''''''x''''''")).toBe("<p>'<i><b>x'</b></i></p>");
  });

  it("C-04: both-odd re-balance on a multi-letter word", () => {
    expect(html("'''a'' b")).toBe("<p>'<i>a</i> b</p>");
  });

  it("C-05: the single-letter word wins the re-balance", () => {
    expect(html("It's a'''nice'' day")).toBe("<p>It's a'<i>nice</i> day</p>");
  });

  it("C-06: an unclosed run closes at end of line", () => {
    expect(html("'''unclosed")).toBe("<p><b>unclosed</b></p>");
  });

  it("C-07: bold nests inside italic", () => {
    expect(html("''a'''b'''c''")).toBe("<p><i>a<b>b</b>c</i></p>");
  });

  it("C-08: bold-italic open, italic closed early", () => {
    expect(html("'''''a'' b'''")).toBe("<p><b><i>a</i> b</b></p>");
  });

  it("C-09: formatting never crosses a line boundary", () => {
    expect(html("''one\ntwo''")).toBe("<p><i>one</i>\ntwo<i></i></p>");
  });
});

/* ------------------------------------------------------------------ */
/* Headings (§2)                                                       */
/* ------------------------------------------------------------------ */

describe("§15 headings", () => {
  it("C-10: `====` is an h1 whose text is `==`", () => {
    expect(html("====")).toBe('<h1 id="==">==</h1>');
  });

  it("C-11: trailing spaces after the closing run are ignored", () => {
    expect(html("== A ==  ")).toBe('<h2 id="A">A</h2>');
  });

  it("C-12: trailing text after the closing run makes it a paragraph", () => {
    expect(html("== A == b")).toBe("<p>== A == b</p>");
  });

  it("C-13: expansion happens before heading recognition", () => {
    expect(html("=={{1x|B}}==")).toBe('<h2 id="B">B</h2>');
  });

  it("C-14: duplicate heading ids are deduped with a numeric suffix", () => {
    const out = html("== X ==\n== X ==");
    expect(out).toContain('id="X"');
    expect(out).toContain('id="X_2"');
  });
});

/* ------------------------------------------------------------------ */
/* Paragraphs, pre, hr (§3)                                            */
/* ------------------------------------------------------------------ */

describe("§15 paragraphs / pre / hr", () => {
  it("C-15: consecutive text lines join into one paragraph", () => {
    expect(html("a\nb")).toBe("<p>a\nb</p>");
  });

  it("C-16: two blank lines add a leading <br /> to the next paragraph", () => {
    expect(html("a\n\n\nb")).toBe("<p>a</p><p><br />\nb</p>");
  });

  it("C-17: space-indented pre still parses inline markup", () => {
    expect(html(" ''pre'' with markup")).toBe("<pre><i>pre</i> with markup\n</pre>");
  });

  it("C-18: `----` splits the line, the remainder becomes a paragraph", () => {
    expect(html("----text")).toBe("<hr /><p>text</p>");
  });
});

/* ------------------------------------------------------------------ */
/* Lists (§4)                                                          */
/* ------------------------------------------------------------------ */

describe("§15 lists", () => {
  it("C-19: a `*#` run nests an ol inside the li", () => {
    expect(html("* a\n*# b\n*# c")).toBe(
      "<ul><li>a<ol><li>b</li><li>c</li></ol></li></ul>",
    );
  });

  it("C-20: a colon inside `[[…]]` does not split the definition (D-5)", () => {
    const out = html("; [[Help:Contents]] : d");
    expect(out).toContain("<dt>");
    expect(out).toContain("Help:Contents</a></dt>");
    expect(out).toContain("<dd>d</dd>");
  });

  it("C-21: a blank line between items restarts the ol", () => {
    expect(html("# a\n\n# b")).toBe("<ol><li>a</li></ol><ol><li>b</li></ol>");
  });

  it("C-22: `#:` nests a dl inside the li", () => {
    expect(html("# a\n#: note\n# b")).toBe(
      "<ol><li>a<dl><dd>note</dd></dl></li><li>b</li></ol>",
    );
  });

  it("C-23: a table cannot start inside a list item", () => {
    expect(html("*{|\n| x\n|}")).toBe("<ul><li>{|</li></ul><p>| x\n|}</p>");
  });

  it("C-24: `:{|` does start a table, inside the dd", () => {
    expect(html(":{|\n| x\n|}")).toBe(
      "<dl><dd><table><tbody><tr><td>x</td></tr></tbody></table></dd></dl>",
    );
  });
});

/* ------------------------------------------------------------------ */
/* Internal links (§5)                                                 */
/* ------------------------------------------------------------------ */

describe("§15 internal links", () => {
  it("C-25: the link trail joins the label", () => {
    expect(html("[[a|b]]c")).toBe(
      '<p><a href="/wiki/a?redlink=1" class="new red-link" ' +
        'title="A (page does not exist)">bc</a></p>',
    );
  });

  it("C-26: the first letter is case-folded when resolving the target", () => {
    expect(html("[[quota]]")).toBe(
      '<p><a href="/wiki/quota" title="Quota">quota</a></p>',
    );
  });

  it("C-27: the pipe trick drops a parenthetical qualifier", () => {
    const out = run("[[Pipe (computing)|]]");
    expect(out.html).toContain(">Pipe</a>");
    expect(out.html).toContain('class="new red-link"');
    expect(out.meta.linksTo).toContain("0:Pipe_(computing)");
  });

  it("C-28: the pipe trick drops a comma-separated qualifier", () => {
    expect(html("[[Boston, Massachusetts|]]")).toContain(">Boston</a>");
  });

  it("C-29: a fragment disables the pipe trick", () => {
    expect(html("[[Foo#Bar|]]")).toContain(">Foo#Bar</a>");
  });

  it("C-30: an empty nowiki marker breaks the link trail", () => {
    const out = html("[[moon]]<nowiki/>s");
    expect(out).toBe('<p><a href="/wiki/moon" title="Moon">moon</a>s</p>');
  });

  it("C-31: a nested `[[…]]` in a label voids the outer link", () => {
    expect(html("[[Foo|see [[Bar]] here]]")).toBe(
      '<p>[[Foo|see <a href="/wiki/bar" title="Bar">Bar</a> here]]</p>',
    );
  });

  it("C-32: a category tag on its own line emits nothing and records the sort key", () => {
    const out = run("[[Category:Moons|T]]");
    expect(out.html).toBe("");
    expect(out.meta.categories).toEqual([{ name: "Moons", sortKey: "T" }]);
  });

  it("C-33: a leading colon makes it a plain link to the category page", () => {
    const out = run("[[:Category:Moons]]");
    expect(out.meta.categories).toEqual([]);
    expect(out.html).toBe(
      '<p><a href="/wiki/category:moons" title="Category:Moons">Category:Moons</a></p>',
    );
  });

  it("C-34: file syntax balances brackets so a link survives in the caption", () => {
    const out = html("[[File:X.png|thumb|A [[Bracken]] pic]]");
    expect(out).toContain("<figure");
    expect(out).toContain("<figcaption>");
    expect(out).toContain('<a href="/wiki/bracken" title="Bracken">Bracken</a>');
  });
});

/* ------------------------------------------------------------------ */
/* External links (§6)                                                 */
/* ------------------------------------------------------------------ */

describe("§15 external links", () => {
  it("C-35: bare bracketed links autonumber in document order", () => {
    const out = html("[https://a.example] [https://b.example]");
    expect(out).toContain(">[1]</a>");
    expect(out).toContain(">[2]</a>");
    expect(out.indexOf(">[1]</a>")).toBeLessThan(out.indexOf(">[2]</a>"));
  });

  it("C-36: a balanced paren stays in the URL, a trailing comma does not", () => {
    const out = html("https://x.example/a_(b),");
    expect(out).toContain('href="https://x.example/a_(b)"');
    expect(out).toContain("</a>,</p>");
  });

  it("C-37: a javascript: URL is not linked", () => {
    expect(html("[javascript:alert(1) x]")).toBe("<p>[javascript:alert(1) x]</p>");
  });

  it("C-38: a bracketed link label is inline-parsed", () => {
    expect(html("[https://x.example ''lbl'']")).toBe(
      '<p><a class="external text" rel="nofollow noopener" ' +
        'href="https://x.example"><i>lbl</i></a></p>',
    );
  });
});

/* ------------------------------------------------------------------ */
/* Tables (§7)                                                         */
/* ------------------------------------------------------------------ */

describe("§15 tables", () => {
  it("C-39: `{|` and `|}` may come from templates", () => {
    const out = html("{{Boxtop}}\n| cell\n{{Boxend}}");
    expect(out).toContain('<table class="box">');
    expect(out).toContain("<td>cell</td>");
    expect(out).toContain("</table>");
  });

  it("C-40: `{{!}}` becomes a real pipe, so `a` is read as dropped attributes", () => {
    expect(html("{|\n| {{#if:x|a{{!}}b|c}}\n|}")).toContain("<td>b</td>");
  });

  it("C-41: `[[` vetoes the attribute split; a later `|` still splits cells", () => {
    const out = html("{|\n| [[a|b]] || x | y\n|}");
    expect(out).toContain(">b</a></td>");
    expect(out).toContain("<td>y</td>");
    expect(out).not.toContain(">x<");
  });

  it("C-42: `!` with `!!` and `||` yields three headers", () => {
    const out = html("{|\n! a !! b || c\n|}");
    expect(out.match(/<th>/g)).toHaveLength(3);
    expect(out).toContain("<th>a</th>");
    expect(out).toContain("<th>b</th>");
    expect(out).toContain("<th>c</th>");
  });

  it("C-43: a `{|` on its own line inside a cell nests a table", () => {
    const out = html("{|\n| \n{|\n| inner\n|}\n|}");
    expect(out.match(/<table>/g)).toHaveLength(2);
    expect(out).toContain("<td>inner</td>");
  });

  it("C-44: `|+` takes attributes before the caption text", () => {
    expect(html('{|\n|+ class="c" | Cap\n| x\n|}')).toContain(
      '<caption class="c">Cap</caption>',
    );
  });

  it("C-45: stray text inside a table is fostered out before it", () => {
    const out = html("{|\nstray\n| x\n|}");
    expect(out).toContain("<p>stray</p>");
    expect(out.indexOf("<p>stray</p>")).toBeLessThan(out.indexOf("<table>"));
  });
});

/* ------------------------------------------------------------------ */
/* Templates and parameters (§8)                                       */
/* ------------------------------------------------------------------ */

describe("§15 templates & parameters", () => {
  it("C-46: a positional parameter is NOT trimmed", () => {
    // Inline, where the surviving spaces are directly visible.
    expect(html("x{{1x| a }}y")).toBe("<p>x a y</p>");
    // §15 writes the case bare. The retained LEADING space then lands at line
    // start, so §3.3 makes it a space-pre — the same MediaWiki gotcha, and
    // itself proof the space survived (the pre marker eats exactly one).
    expect(html("{{1x| a }}")).toBe("<pre>a \n</pre>");
  });

  it("C-47: a named parameter IS trimmed", () => {
    expect(html("{{N|k= v }}")).toBe("<p>[v]</p>");
  });

  it("C-48: a later duplicate argument wins", () => {
    expect(html("{{1x|1=a|b}}")).toBe("<p>b</p>");
  });

  it("C-49: self-transclusion renders the localized loop error", () => {
    const out = html("{{Loop}}");
    expect(out).toContain('<span class="error">Template loop detected: ');
    expect(out).toContain("Template:Loop</a>");
  });

  it("C-50: a top-level `{{{{a}}}}` stays literal", () => {
    expect(html("{{{{a}}}}")).toBe("<p>{{{{a}}}}</p>");
  });

  it("C-51: a ref produced inside a template is numbered and auto-listed", () => {
    const out = refText("{{1x|<ref>R</ref>}}");
    expect(out).toContain(
      '<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup>',
    );
    expect(out).toContain('<ol class="references"><li id="cite_note-1">');
    expect(out).toContain("R</li></ol>");
  });

  it("C-52: T2529 auto-newline before a spliced `*`", () => {
    expect(html("foo {{Bullet|x}}")).toBe("<p>foo </p><ul><li>x</li></ul>");
  });

  it("C-53: `subst:` is stripped and the call transcluded normally (D-8)", () => {
    expect(html("{{subst:1x|y}}")).toBe("<p>y</p>");
  });

  it("C-54: a nowiki-protected pipe is not an argument separator", () => {
    expect(html("{{1x|a<nowiki>|</nowiki>b}}")).toBe("<p>a|b</p>");
  });
});

/* ------------------------------------------------------------------ */
/* Parser functions (§9)                                               */
/* ------------------------------------------------------------------ */

describe("§15 parser functions", () => {
  it("C-55: whitespace-only is false, the string `0` is true", () => {
    expect(html("{{#if: |y|n}}{{#if: 0 |y|n}}")).toBe("<p>ny</p>");
  });

  it("C-56: #ifeq compares numerically when both sides are numeric", () => {
    expect(html("{{#ifeq: 1e3 | 1000 | eq | ne }}")).toBe("<p>eq</p>");
    expect(html("{{#ifeq: abc | ABC | eq | ne }}")).toBe("<p>ne</p>");
  });

  it("C-57: #switch falls through bare cases to the next valued case", () => {
    expect(html("{{#switch: b | a | b | c = ABC | other }}")).toBe("<p>ABC</p>");
  });

  it("C-58: #expr exponentiation is right-associative; division by zero errors", () => {
    expect(html("{{#expr: 2^3^2 }}")).toBe("<p>64</p>");
    expect(html("{{#expr: 1/0 }}")).toContain(
      '<strong class="error">Expression error: Division by zero.</strong>',
    );
  });

  it("C-59: string functions nest", () => {
    expect(html("{{ucfirst:{{lc:LOOT}}}}")).toBe("<p>Loot</p>");
  });

  it("C-60: PAGENAME/SUBPAGENAME on a subpage", () => {
    const page: Title = { namespace: 12, pageName: "Guides/Routing" };
    expect(html("{{PAGENAME}}", page)).toBe("<p>Guides/Routing</p>");
    expect(html("{{SUBPAGENAME}}", page)).toBe("<p>Routing</p>");
  });
});

/* ------------------------------------------------------------------ */
/* Extension tags & sanitization (§10, §11)                            */
/* ------------------------------------------------------------------ */

describe("§15 extension tags & sanitization", () => {
  it("C-61: nowiki content is inert", () => {
    expect(html("<nowiki>[[x]] {{1x|y}} ''z''</nowiki>")).toBe(
      "<p>[[x]] {{1x|y}} ''z''</p>",
    );
  });

  it("C-62: tag-form pre is literal; space-pre is parsed", () => {
    expect(html("<pre>''x''</pre>")).toBe("<pre>''x''</pre>");
    expect(html(" ''x''")).toBe("<pre><i>x</i>\n</pre>");
  });

  it("C-63: <code> content IS parsed", () => {
    expect(html("<code>''x''</code>")).toBe("<p><code><i>x</i></code></p>");
  });

  it("C-64: a named ref reused shows one number and lettered backlinks", () => {
    const out = refText("A<ref name=a>First</ref> B<ref name=a/>\n<references/>");
    expect(out.match(/\[1\]/g)).toHaveLength(2);
    expect(out).toContain('<sup><a href="#cite_ref-a-1-0">a</a></sup>');
    expect(out).toContain('<sup><a href="#cite_ref-a-1-1">b</a></sup>');
    expect(out).toContain("First</li></ol>");
  });

  it("C-65: a ref used but never defined renders the cite error in the list", () => {
    const out = html('X<ref name=missing/>\n<references/>');
    expect(out).toContain(
      '<span class="error">Cite error: no text provided for ref "missing"</span>',
    );
  });

  it("C-66: <script> is escaped, not executed (§10.7)", () => {
    expect(html("<script>alert(1)</script>")).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
  });

  it("C-67: event handlers are dropped and url() styles neutralized", () => {
    expect(html('<div onclick="x()" style="background:url(e)">hi</div>')).toBe(
      '<div style="/* insecure input */">hi</div>',
    );
  });

  it("C-68: an unclosed inline tag is balanced at paragraph end", () => {
    expect(html("<b>unclosed")).toBe("<p><b>unclosed</b></p>");
  });

  it("C-69: syntaxhighlight escapes its content", () => {
    expect(html('<syntaxhighlight lang="ts">a < b</syntaxhighlight>')).toBe(
      '<pre class="mw-highlight"><code class="language-ts">a &lt; b</code></pre>',
    );
  });
});

/* ------------------------------------------------------------------ */
/* Redirects & interplay (§12, §2.5)                                   */
/* ------------------------------------------------------------------ */

describe("§15 redirects & interplay", () => {
  it("C-70: a leading #REDIRECT records the target and renders the notice (A2)", () => {
    const out = run("#REDIRECT [[Target#Frag]]");
    expect(out.meta.redirect?.target.namespace).toBe(0);
    expect(out.meta.redirect?.target.pageName).toBe("Target");
    expect(out.meta.redirect?.target.fragment).toBe("Frag");
    expect(out.html).toContain('<div class="redirectMsg">');
    expect(out.html).toContain("Redirect to:");
  });

  it("C-71: #REDIRECT below the first line is an ordinary list item", () => {
    const out = run("text\n#REDIRECT [[Target]]");
    expect(out.meta.redirect).toBeUndefined();
    expect(out.html).toContain("<ol><li>REDIRECT ");
    expect(out.html).toContain('<a href="/wiki/target" title="Target">Target</a>');
  });

  it("C-72: four headings render a TOC; a comment line makes no paragraph break", () => {
    const out = run("== T ==\n<!-- c -->\n== T ==\n== A ==\n== B ==");
    expect(out.toc.map((e) => e.id)).toEqual(["T", "T_2", "A", "B"]);
    expect(out.html).toContain('id="toc"');
    expect(out.html).not.toContain("<p></p>");
  });

  it("C-73: a heading produced by a template is recognized", () => {
    // §8.3 (and MediaWiki) split an argument at its FIRST top-level `=` even
    // when that leaves an empty name, so the bare form of §15's input sets no
    // positional 1 at all and `{{{1}}}` renders literally. §8.3 is the
    // normative rule; §15's expected output for this case is unreachable.
    expect(html("{{1x|== H ==}}")).toBe("<p>{{{1}}}</p>");
    // The case's actual subject — headings recognized AFTER expansion — with
    // the argument index made explicit.
    expect(html("{{1x|1=== H ==}}")).toBe('<h2 id="H">H</h2>');
  });

  it("C-74: heading syntax inside nowiki is not a heading", () => {
    expect(html("<nowiki>== H ==</nowiki>")).toBe("<p>== H ==</p>");
  });
});
