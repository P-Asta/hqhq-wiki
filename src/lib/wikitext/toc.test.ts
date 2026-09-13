import { describe, expect, it } from "vitest";

import { DEFAULT_NAMESPACES } from "@/lib/title";

import {
  IdAllocator,
  anchorIdFromHtml,
  buildToc,
  encodeFragment,
  flattenTocText,
  renderToc,
  shouldShowToc,
  type HeadingRecord,
} from "./toc";
import type { ParseContext, WikiConfig } from "./types";

/* ---------------------------------------------------------------- */
/* Fixtures                                                          */
/* ---------------------------------------------------------------- */

function makeCtx(tocTitle = "Contents"): ParseContext {
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
      tocTitle,
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
    store: { getSource: () => null, exists: () => false, getFile: () => null },
    page: { namespace: 0, pageName: "Sandbox" },
    version: null,
    versions: { byId: {}, ordered: [], defaultId: "v1" },
  };
}

function h(level: number, html: string, id = anchorIdFromHtml(html)): HeadingRecord {
  return { level, id, html };
}

/* ---------------------------------------------------------------- */
/* §2.4 anchors                                                      */
/* ---------------------------------------------------------------- */

describe("anchor ids (§2.4)", () => {
  it("strips tags, decodes entities, collapses whitespace, spaces to _", () => {
    expect(anchorIdFromHtml("The <i>Bracken</i>   room")).toBe("The_Bracken_room");
    expect(anchorIdFromHtml("Sales &amp; Deals")).toBe("Sales_&_Deals");
  });

  it("C-10: keeps surplus equals signs from an unbalanced heading", () => {
    expect(anchorIdFromHtml("==")).toBe("==");
  });

  it("keeps Hangul verbatim in html5 fragment mode (Addendum A3)", () => {
    expect(anchorIdFromHtml("개요")).toBe("개요");
  });

  it("empty content yields `_`", () => {
    expect(anchorIdFromHtml("<i></i>  ")).toBe("_");
  });

  it("percent-encodes only inside href fragments, keeping `:`", () => {
    expect(encodeFragment("개요")).toBe(encodeURIComponent("개요"));
    expect(encodeFragment("A:B")).toBe("A:B");
    expect(encodeFragment("50%_off")).toBe("50%25_off");
  });
});

describe("id deduplication (§2.4)", () => {
  it("C-14: Foo, Foo_2, Foo_3", () => {
    const ids = new IdAllocator();
    expect(ids.allocate("X")).toBe("X");
    expect(ids.allocate("X")).toBe("X_2");
    expect(ids.allocate("X")).toBe("X_3");
  });

  it("a literal `Foo_2` colliding with a generated one is bumped again", () => {
    const ids = new IdAllocator();
    ids.allocate("Foo");
    expect(ids.allocate("Foo")).toBe("Foo_2");
    expect(ids.allocate("Foo_2")).toBe("Foo_2_2");
  });

  it("skips ids already reserved by raw HTML (§11.3)", () => {
    const ids = new IdAllocator();
    ids.reserve("Foo");
    expect(ids.allocate("Foo")).toBe("Foo_2");
  });
});

/* ---------------------------------------------------------------- */
/* §2.5 TOC                                                          */
/* ---------------------------------------------------------------- */

describe("buildToc (§2.5)", () => {
  it("uses relative levels: h2,h4,h4,h2 -> 1, 1.1, 1.2, 2", () => {
    const toc = buildToc([h(2, "A"), h(4, "Deep"), h(4, "Deep2"), h(2, "B")]);
    expect(toc.map((e) => e.number)).toEqual(["1", "1.1", "1.2", "2"]);
    expect(toc.map((e) => e.tocLevel)).toEqual([1, 2, 2, 1]);
  });

  it("§2.7-6: __FORCETOC__ page with h2/h4/h2 numbers 1, 1.1, 2", () => {
    const toc = buildToc([h(2, "A"), h(4, "Deep"), h(2, "B")]);
    expect(toc.map((e) => `${e.number} ${e.html}`)).toEqual(["1 A", "1.1 Deep", "2 B"]);
  });

  it("unwinds to the matching open level", () => {
    const toc = buildToc([h(2, "A"), h(3, "B"), h(4, "C"), h(3, "D")]);
    expect(toc.map((e) => e.number)).toEqual(["1", "1.1", "1.1.1", "1.2"]);
  });

  it("flattens links but keeps formatting in the TOC text", () => {
    expect(flattenTocText(`The <i><a href="/wiki/Bracken">Bracken</a></i> room`)).toBe(
      "The <i>Bracken</i> room",
    );
  });
});

describe("shouldShowToc (§2.5, §2.6)", () => {
  it("shows from four headings", () => {
    expect(shouldShowToc(3, new Set())).toBe(false);
    expect(shouldShowToc(4, new Set())).toBe(true);
  });

  it("__NOTOC__ suppresses, __TOC__ and __FORCETOC__ win over it", () => {
    expect(shouldShowToc(9, new Set(["NOTOC"]))).toBe(false);
    expect(shouldShowToc(1, new Set(["NOTOC", "TOC"]))).toBe(true);
    expect(shouldShowToc(1, new Set(["NOTOC", "FORCETOC"]))).toBe(true);
    expect(shouldShowToc(1, new Set(["FORCETOC"]))).toBe(true);
  });
});

describe("renderToc (§2.5)", () => {
  it("emits the spec shape with nested lists and both class tokens", () => {
    const html = renderToc(buildToc([h(2, "First"), h(3, "Sub")]), makeCtx());
    expect(html).toBe(
      `<div id="toc" class="toc wiki-toc" role="navigation">` +
        `<div class="toctitle"><h2>Contents</h2></div>` +
        `<ul><li class="toclevel-1"><a href="#First">` +
        `<span class="tocnumber">1</span> <span class="toctext">First</span></a>` +
        `<ul><li class="toclevel-2"><a href="#Sub">` +
        `<span class="tocnumber">1.1</span> <span class="toctext">Sub</span></a></li></ul>` +
        `</li></ul></div>`,
    );
  });

  it("localizes the title from config.messages (Addendum A3)", () => {
    const html = renderToc(buildToc([h(2, "개요")]), makeCtx("목차"));
    expect(html).toContain("<h2>목차</h2>");
    expect(html).toContain(`href="#${encodeURIComponent("개요")}"`);
  });

  it("renders nothing without headings", () => {
    expect(renderToc([], makeCtx())).toBe("");
  });
});
