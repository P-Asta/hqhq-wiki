import { describe, expect, it } from "vitest";

import {
  buildWikiLinkHref,
  encodeFragment,
  fileStoreKey,
  fullTitleText,
  linkPathSegment,
  nsKeyName,
  parseLinkAt,
  pipeTrickLabel,
  resolveSubpage,
  titleKey,
  wikiLinkTitleAttr,
} from "./links";
import type { ParseContext, Title, WikiConfig, WikiLink } from "./types";
import { DEFAULT_NAMESPACES } from "@/lib/title";

const config = {
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
    citeErrorNoText: (n: string) => n,
    templateLoop: "loop",
    templateDepthExceeded: "depth",
    unknownVersion: (id: string) => id,
  },
} as WikiConfig;

const ctx = {
  config,
  page: { namespace: 0, pageName: "Guides/Routing" },
  version: null,
  versions: { byId: {}, ordered: [], defaultId: "v70" },
  store: { getSource: () => null, exists: () => false, getFile: () => null },
} as ParseContext;

function link(target: Title, exists: boolean, selfAnchor = false): WikiLink {
  return { type: "wikilink", target, exists, selfAnchor, children: [] };
}

describe("title keys and paths (decisions O1/O2)", () => {
  it("titleKey is the shared ns:Normalized_page_name spelling (§14.10)", () => {
    expect(titleKey({ namespace: 0, pageName: "Gold bar" })).toBe("0:Gold_bar");
    expect(titleKey({ namespace: 10, pageName: "Infobox moon" })).toBe("10:Infobox_moon");
    expect(titleKey({ namespace: 14, pageName: "Moons" })).toBe("14:Moons");
  });

  it("titleKey normalizes underscores and whitespace runs", () => {
    expect(titleKey({ namespace: 0, pageName: "Gold  bar" })).toBe(
      titleKey({ namespace: 0, pageName: "Gold_bar" }),
    );
  });

  it("nsKeyName falls back to the canonical name for unstorable namespaces", () => {
    expect(nsKeyName(3, ctx)).toBe("user_talk");
    expect(nsKeyName(0)).toBe("main");
  });

  it("linkPathSegment prefixes storable namespaces and encodes the slug", () => {
    expect(linkPathSegment({ namespace: 0, pageName: "Gold bar" })).toBe("gold-bar");
    expect(linkPathSegment({ namespace: 10, pageName: "Infobox moon" })).toBe(
      "template:infobox-moon",
    );
    expect(linkPathSegment({ namespace: 0, pageName: "달" })).toBe("%EB%8B%AC");
  });

  it("encodeFragment follows §2.4 step 4", () => {
    expect(encodeFragment("50% off")).toBe("50%25_off");
    expect(encodeFragment("A: B")).toBe("A:_B");
    expect(encodeFragment("개요")).toBe("%EA%B0%9C%EC%9A%94");
  });

  it("fullTitleText adds the canonical namespace prefix", () => {
    expect(fullTitleText({ namespace: 0, pageName: "Moon" }, ctx)).toBe("Moon");
    expect(fullTitleText({ namespace: 14, pageName: "Moons" }, ctx)).toBe("Category:Moons");
  });

  it("buildWikiLinkHref uses articlePath / redLinkPath and appends the fragment", () => {
    expect(buildWikiLinkHref(link({ namespace: 0, pageName: "Moon" }, true), ctx)).toBe(
      "/wiki/moon",
    );
    expect(buildWikiLinkHref(link({ namespace: 0, pageName: "Moon" }, false), ctx)).toBe(
      "/wiki/moon?redlink=1",
    );
    expect(
      buildWikiLinkHref(link({ namespace: 0, pageName: "Moon", fragment: "Life" }, true), ctx),
    ).toBe("/wiki/moon#Life");
    expect(
      buildWikiLinkHref(link({ namespace: 0, pageName: "X", fragment: "F" }, true, true), ctx),
    ).toBe("#F");
  });

  it("wikiLinkTitleAttr appends the localizable red-link suffix (Addendum A3)", () => {
    expect(wikiLinkTitleAttr(link({ namespace: 0, pageName: "Moon" }, true), ctx)).toBe("Moon");
    expect(wikiLinkTitleAttr(link({ namespace: 0, pageName: "Moon" }, false), ctx)).toBe(
      "Moon (page does not exist)",
    );
    expect(wikiLinkTitleAttr(link({ namespace: 0, pageName: "X" }, true, true), ctx)).toBeNull();
  });

  it("fileStoreKey is the canonical filename (decisions O6)", () => {
    expect(fileStoreKey("Facility Map.PNG")).toBe("facility-map.png");
  });
});

describe("§5.3 pipe trick (D-6)", () => {
  it("strips a trailing parenthetical", () => {
    expect(pipeTrickLabel("Pipe (computing)", ctx)).toBe("Pipe");
  });
  it("strips a namespace prefix", () => {
    expect(pipeTrickLabel("Help:Style", ctx)).toBe("Style");
    expect(pipeTrickLabel("Help:Style (guide)", ctx)).toBe("Style");
    expect(pipeTrickLabel(":Category:Moons", ctx)).toBe("Moons");
  });
  it("keeps the text before the first comma", () => {
    expect(pipeTrickLabel("Boston, Massachusetts", ctx)).toBe("Boston");
  });
  it("does not apply when the target has a fragment", () => {
    expect(pipeTrickLabel("Foo#Bar", ctx)).toBe("Foo#Bar");
  });
  it("falls back to the full target when the result would be empty", () => {
    expect(pipeTrickLabel("(x)", ctx)).toBe("(x)");
  });
});

describe("§5.6 subpage resolution", () => {
  const page: Title = { namespace: 0, pageName: "Guides/Routing" };
  it("resolves the table in §5.6", () => {
    expect(resolveSubpage("/Speedrun", page)).toEqual({
      pageName: "Guides/Routing/Speedrun",
      label: "/Speedrun",
    });
    expect(resolveSubpage("/Speedrun/", page)).toEqual({
      pageName: "Guides/Routing/Speedrun",
      label: "Speedrun",
    });
    expect(resolveSubpage("../", page)).toEqual({ pageName: "Guides", label: "Guides" });
    expect(resolveSubpage("../Looting", page)).toEqual({
      pageName: "Guides/Looting",
      label: "../Looting",
    });
  });
  it("returns null when the link climbs past the root", () => {
    expect(resolveSubpage("../../Top", page)).toBeNull();
  });
  it("returns null for a target that is not a subpage link", () => {
    expect(resolveSubpage("Moon", page)).toBeNull();
  });
});

describe("parseLinkAt (§5.1)", () => {
  it("classifies links, categories and files", () => {
    expect(parseLinkAt("[[Moon]]", 0, ctx)).toMatchObject({ kind: "link", trail: "" });
    expect(parseLinkAt("[[Category:Moons|T]]", 0, ctx)).toMatchObject({
      kind: "category",
      rawLabel: "T",
    });
    expect(parseLinkAt("[[File:X.png|thumb|c]]", 0, ctx)).toMatchObject({
      kind: "image",
      params: ["thumb", "c"],
    });
    expect(parseLinkAt("[[:Category:Moons]]", 0, ctx)).toMatchObject({ kind: "link" });
    expect(parseLinkAt("[[:File:X.png]]", 0, ctx)).toMatchObject({ kind: "link" });
  });

  it("reads the trail and stops at the first non-lowercase character", () => {
    expect(parseLinkAt("[[Moon]]shot!", 0, ctx)?.trail).toBe("shot");
    expect(parseLinkAt("[[Moon]]Shot", 0, ctx)?.trail).toBe("");
  });

  it("rejects invalid targets and unterminated links", () => {
    expect(parseLinkAt("[[bad<title]]", 0, ctx)).toBeNull();
    expect(parseLinkAt("[[a{b]]", 0, ctx)).toBeNull();
    expect(parseLinkAt("[[unterminated", 0, ctx)).toBeNull();
    expect(parseLinkAt("[[Foo|see [[Bar]] here]]", 0, ctx)).toBeNull();
  });

  it("balances brackets inside file syntax so captions may hold links", () => {
    expect(parseLinkAt("[[File:X.png|thumb|A [[Bracken]] pic]]", 0, ctx)).toMatchObject({
      kind: "image",
      params: ["thumb", "A [[Bracken]] pic"],
    });
  });
});
