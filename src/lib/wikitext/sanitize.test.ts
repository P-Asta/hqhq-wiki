import { describe, expect, it } from "vitest";

import { DEFAULT_NAMESPACES } from "@/lib/title";

import {
  INSECURE_STYLE,
  decodeEntities,
  escapeAll,
  escapeAttr,
  escapeText,
  filterAttributes,
  filterStyle,
  matchTagToken,
  sanitizeDisplayTitle,
  sanitizeRawHtml,
  stripTags,
  updatePRejectingDepth,
} from "./sanitize";
import type { ParseContext, Title, WikiConfig } from "./types";

/* ---------------------------------------------------------------- */
/* Fixtures                                                          */
/* ---------------------------------------------------------------- */

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

const ctx: ParseContext = {
  config,
  store: {
    getSource: () => null,
    exists: () => false,
    getFile: () => null,
  },
  page: { namespace: 0, pageName: "Sandbox" },
  version: null,
  versions: { byId: {}, ordered: [], defaultId: "v1" },
};

/* ---------------------------------------------------------------- */
/* §11.1 / §10.7 — allowlist                                         */
/* ---------------------------------------------------------------- */

describe("sanitizeRawHtml — element allowlist (§11.1)", () => {
  it("C-66: disallowed tags are escaped literally", () => {
    // `>` is escaped later, by escapeText on the text node.
    expect(escapeText(sanitizeRawHtml("<script>alert(1)</script>", ctx))).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("§10.7: unknown tags are escaped with their attributes intact", () => {
    expect(escapeText(sanitizeRawHtml(`<foo bar="1">`, ctx))).toBe(`&lt;foo bar="1"&gt;`);
  });

  it("keeps allowlisted inline and block tags", () => {
    expect(sanitizeRawHtml("<b>x</b> <div>y</div>", ctx)).toBe("<b>x</b> <div>y</div>");
  });

  it("iframe/img/a are not allowed", () => {
    const out = escapeText(sanitizeRawHtml(`<a href="x">y</a><img src="x">`, ctx));
    expect(out).toBe(`&lt;a href="x"&gt;y&lt;/a&gt;&lt;img src="x"&gt;`);
  });

  it("normalizes </br> to <br /> and keeps void tags self-closed", () => {
    expect(sanitizeRawHtml("a<br>b</br>c<BR/>d", ctx)).toBe("a<br />b<br />c<br />d");
  });

  it("expands a self-closing non-void tag into an open/close pair", () => {
    expect(sanitizeRawHtml("<span/>", ctx)).toBe("<span></span>");
  });

  it("leaves a malformed `<` alone but escaped", () => {
    expect(sanitizeRawHtml("1 < 2", ctx)).toBe("1 &lt; 2");
  });

  it("does not touch strip markers", () => {
    const marker = `${String.fromCharCode(0x7f)}'"UNIQ--nowiki-0000000a-QINU"'${String.fromCharCode(0x7f)}`;
    expect(sanitizeRawHtml(`a${marker}b`, ctx)).toBe(`a${marker}b`);
  });
});

/* ---------------------------------------------------------------- */
/* §11.3 — attributes                                                */
/* ---------------------------------------------------------------- */

describe("attribute filtering (§11.3)", () => {
  it("C-67: drops event handlers and rejects url() styles", () => {
    expect(sanitizeRawHtml(`<div onclick="x()" style="background:url(e)">hi</div>`, ctx)).toBe(
      `<div style="/* insecure input */">hi</div>`,
    );
  });

  it("keeps a benign style declaration verbatim (§11.6-1)", () => {
    expect(
      sanitizeRawHtml(`<span style="color: #c00; font-weight:bold">danger</span>`, ctx),
    ).toBe(`<span style="color: #c00; font-weight:bold">danger</span>`);
  });

  it("drops href/src/background and keeps class (§11.6-2)", () => {
    expect(sanitizeRawHtml(`<div href="x" src="y" background="z" class=ok>hi</div>`, ctx)).toBe(
      `<div class="ok">hi</div>`,
    );
  });

  it("allows per-element attributes only on their element", () => {
    expect(filterAttributes("td", { colspan: "2", start: "3" })).toEqual({ colspan: "2" });
    expect(filterAttributes("ol", { start: "3", colspan: "2" })).toEqual({ start: "3" });
  });

  it("rejects data-mw/data-parsoid but keeps other data-*", () => {
    expect(filterAttributes("span", { "data-mw": "x", "data-foo": "1" })).toEqual({
      "data-foo": "1",
    });
  });

  it("restricts dir to ltr/rtl and scheme-checks cite", () => {
    expect(filterAttributes("bdo", { dir: "RTL" })).toEqual({ dir: "rtl" });
    expect(filterAttributes("bdo", { dir: "sideways" })).toEqual({});
    expect(filterAttributes("blockquote", { cite: "https://x.example" })).toEqual({
      cite: "https://x.example",
    });
    expect(filterAttributes("blockquote", { cite: "javascript:alert(1)" })).toEqual({});
  });

  it("normalizes id values like anchors (§2.4)", () => {
    expect(filterAttributes("div", { id: "  a  b " })).toEqual({ id: "a_b" });
  });
});

/* ---------------------------------------------------------------- */
/* §11.4 — style filter                                              */
/* ---------------------------------------------------------------- */

describe("style filtering (§11.4)", () => {
  it("rejects expression()", () => {
    expect(filterStyle("width: expression(alert(1))")).toBe(INSECURE_STYLE);
  });

  it("rejects javascript: even behind CSS backslash escapes", () => {
    expect(filterStyle("background: \\6A avascript:alert(1)")).toBe(INSECURE_STYLE);
  });

  it("rejects javascript: hidden in HTML entities", () => {
    expect(filterStyle("background:&#106;avascript:alert(1)")).toBe(INSECURE_STYLE);
  });

  it("rejects an unclosed comment", () => {
    expect(filterStyle("color:red;/* oops")).toBe(INSECURE_STYLE);
  });

  it("rejects a payload hidden inside a comment split", () => {
    expect(filterStyle("color:red;/* x */ -moz-binding:url(x)")).toBe(INSECURE_STYLE);
  });

  it("accepts a declaration whose only comment is well formed", () => {
    expect(filterStyle("color:red;/* fine */")).toBe("color:red;/* fine */");
  });
});

/* ---------------------------------------------------------------- */
/* §11.5 — character references                                      */
/* ---------------------------------------------------------------- */

describe("character references (§11.5)", () => {
  it("escapes < > and bare &, but keeps valid references", () => {
    expect(escapeText("a & b &amp; &#65; <x>")).toBe("a &amp; b &amp; &#65; &lt;x&gt;");
  });

  it("escapes unknown named references", () => {
    expect(escapeText("&foo;")).toBe("&amp;foo;");
  });

  it("replaces references to control characters with U+FFFD", () => {
    expect(escapeText("&#1;")).toBe("�");
  });

  it("decodes recognized references", () => {
    expect(decodeEntities("&amp;&lt;&gt;&#65;&#x42;")).toBe("&<>AB");
  });

  it("escapeAll escapes ampersands unconditionally (nowiki/pre payloads)", () => {
    expect(escapeAll("a &amp; <b>")).toBe("a &amp;amp; &lt;b&gt;");
  });

  it("escapeAttr also escapes quotes", () => {
    expect(escapeAttr('a"b')).toBe("a&quot;b");
  });
});

/* ---------------------------------------------------------------- */
/* Tag tokens / D-14 helper                                          */
/* ---------------------------------------------------------------- */

describe("tag tokens", () => {
  it("parses names, attributes and self-closing forms", () => {
    const tok = matchTagToken(`<td colspan="2" nowrap>`, 0);
    expect(tok?.name).toBe("td");
    expect(tok?.attrs).toEqual({ colspan: "2", nowrap: "" });
    expect(tok?.closing).toBe(false);
  });

  it("tracks p-rejecting depth for the D-14 blank-line rule", () => {
    let d = updatePRejectingDepth("<table><tr>", 0);
    expect(d).toBe(2);
    d = updatePRejectingDepth("</tr></table>", d);
    expect(d).toBe(0);
  });

  it("stripTags returns the text content", () => {
    expect(stripTags("The <i>Bracken</i> room")).toBe("The Bracken room");
  });
});

/* ---------------------------------------------------------------- */
/* §13.1 DISPLAYTITLE                                                */
/* ---------------------------------------------------------------- */

describe("sanitizeDisplayTitle (§13.1)", () => {
  const page: Title = { namespace: 0, pageName: "IPhone" };

  it("accepts a first-letter case change", () => {
    expect(sanitizeDisplayTitle("iPhone", page, ctx)).toEqual({ html: "iPhone" });
  });

  it("keeps text-preserving formatting", () => {
    const out = sanitizeDisplayTitle("<i>iPhone</i>", page, ctx);
    expect(out.html).toBe("<i>iPhone</i>");
  });

  it("strips tags that are not on the DISPLAYTITLE allowlist", () => {
    const out = sanitizeDisplayTitle("<div>iPhone</div>", page, ctx);
    expect(out.html).toBe("iPhone");
  });

  it("rejects a value that renames the page ($wgRestrictDisplayTitle)", () => {
    const out = sanitizeDisplayTitle("Something else", page, ctx);
    expect(out.html).toBeNull();
    expect(out.warning).toContain("Invalid DISPLAYTITLE");
  });

  it("rejects a namespace change", () => {
    const out = sanitizeDisplayTitle("Help:IPhone", page, ctx);
    expect(out.html).toBeNull();
  });
});
