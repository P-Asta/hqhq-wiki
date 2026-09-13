/** Pathname → page context (current-page.ts). */

import { describe, expect, it } from "vitest";

import { currentPageFromPathname } from "./current-page";

describe("currentPageFromPathname", () => {
  it("parses a main-namespace article in the default locale", () => {
    expect(currentPageFromPathname("/wiki/titan")).toEqual({ namespace: "main", slug: "titan" });
  });

  it("strips a non-default locale prefix", () => {
    expect(currentPageFromPathname("/ko/wiki/titan")).toEqual({
      namespace: "main",
      slug: "titan",
    });
  });

  it("parses a namespaced article", () => {
    expect(currentPageFromPathname("/wiki/template:infobox-moon")).toEqual({
      namespace: "template",
      slug: "infobox-moon",
    });
    expect(currentPageFromPathname("/wiki/category:moons")).toEqual({
      namespace: "category",
      slug: "moons",
    });
  });

  it("decodes a percent-encoded slug segment", () => {
    expect(currentPageFromPathname("/wiki/gold%2Dbar")).toEqual({
      namespace: "main",
      slug: "gold-bar",
    });
  });

  it("returns null off the article read view", () => {
    expect(currentPageFromPathname("/edit/titan")).toBeNull();
    expect(currentPageFromPathname("/history/titan")).toBeNull();
    expect(currentPageFromPathname("/diff/titan")).toBeNull();
    expect(currentPageFromPathname("/search")).toBeNull();
    expect(currentPageFromPathname("/special/all-pages")).toBeNull();
    expect(currentPageFromPathname("/profile")).toBeNull();
    expect(currentPageFromPathname("/")).toBeNull();
    expect(currentPageFromPathname("/ko")).toBeNull();
  });

  it("returns null for an empty title segment", () => {
    expect(currentPageFromPathname("/wiki/")).toBeNull();
    expect(currentPageFromPathname("/wiki")).toBeNull();
  });

  it("tolerates an empty or missing pathname", () => {
    expect(currentPageFromPathname("")).toBeNull();
  });
});
