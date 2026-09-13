import { describe, expect, it } from "vitest";

import {
  URL_PROTOCOLS,
  matchProtocol,
  nextExtLinkNumber,
  resetExtLinkNumbers,
  trimTrailingPunctuation,
} from "./external-links";
import type { PageMeta } from "./types";

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

describe("§6.1 protocols", () => {
  it("matches the allowlist case-insensitively", () => {
    expect(matchProtocol("https://x", 0, false)).toBe(8);
    expect(matchProtocol("HTTPS://x", 0, false)).toBe(8);
    expect(matchProtocol("mailto:a@b", 0, false)).toBe(7);
    expect(matchProtocol("a mailto:x", 2, false)).toBe(7);
  });

  it("never matches a scheme outside the allowlist", () => {
    expect(matchProtocol("javascript:alert(1)", 0, true)).toBe(0);
    expect(matchProtocol("data:text/html,x", 0, true)).toBe(0);
    expect(matchProtocol("vbscript:x", 0, true)).toBe(0);
  });

  it("accepts protocol-relative URLs only in the bracketed form", () => {
    expect(matchProtocol("//x.example", 0, true)).toBe(2);
    expect(matchProtocol("//x.example", 0, false)).toBe(0);
  });

  it("keeps the documented default set", () => {
    expect(URL_PROTOCOLS).toContain("https://");
    expect(URL_PROTOCOLS).toContain("magnet:");
    expect(URL_PROTOCOLS).not.toContain("javascript:");
  });
});

describe("§6.3 trailing punctuation", () => {
  it("strips sentence punctuation", () => {
    expect(trimTrailingPunctuation("http://x.com.")).toEqual({
      url: "http://x.com",
      trailing: ".",
    });
    expect(trimTrailingPunctuation("http://x.com/a,;.")).toEqual({
      url: "http://x.com/a",
      trailing: ",;.",
    });
  });

  it("keeps a balanced closing paren", () => {
    expect(trimTrailingPunctuation("http://x.com/foo_(bar)")).toEqual({
      url: "http://x.com/foo_(bar)",
      trailing: "",
    });
    expect(trimTrailingPunctuation("https://x.example/a_(b),")).toEqual({
      url: "https://x.example/a_(b)",
      trailing: ",",
    });
  });

  it("drops an unmatched closing paren", () => {
    expect(trimTrailingPunctuation("https://x.example)")).toEqual({
      url: "https://x.example",
      trailing: ")",
    });
    expect(trimTrailingPunctuation("https://x.example/a).")).toEqual({
      url: "https://x.example/a",
      trailing: ").",
    });
  });

  it("leaves a clean URL alone", () => {
    expect(trimTrailingPunctuation("https://x.example/a")).toEqual({
      url: "https://x.example/a",
      trailing: "",
    });
  });
});

describe("§6.2 auto-numbering", () => {
  it("counts from 1 per page and is independent between pages", () => {
    const a = makeMeta();
    const b = makeMeta();
    expect(nextExtLinkNumber(a)).toBe(1);
    expect(nextExtLinkNumber(a)).toBe(2);
    expect(nextExtLinkNumber(b)).toBe(1);
    expect(nextExtLinkNumber(a)).toBe(3);
  });

  it("resets on demand", () => {
    const m = makeMeta();
    nextExtLinkNumber(m);
    resetExtLinkNumbers(m);
    expect(nextExtLinkNumber(m)).toBe(1);
  });
});
