import { describe, expect, it } from "vitest";

import { titleToPath } from "./locale-path";
import {
  canonicalFilename,
  normalizeTitle,
  parseTitle,
  pathToTitle,
  slugifyTitle,
} from "./title";

describe("normalizeTitle", () => {
  it("replaces underscores with spaces", () => {
    expect(normalizeTitle("Gold_bar")).toBe("Gold bar");
  });

  it("collapses whitespace runs and trims", () => {
    expect(normalizeTitle("  Quota \t  Guide \n")).toBe("Quota Guide");
  });

  it("applies Unicode NFC", () => {
    // "한" as decomposed jamo (U+1112 U+1161 U+11AB) → composed U+D55C
    expect(normalizeTitle("한국")).toBe("한국");
  });
});

describe("slugifyTitle (decisions O1)", () => {
  it("Gold bar → gold-bar (O1 example)", () => {
    expect(slugifyTitle("Gold bar")).toBe("gold-bar");
  });

  it("The Company (71-Gordion) → the-company-(71-gordion) (O1 example)", () => {
    expect(slugifyTitle("The Company (71-Gordion)")).toBe(
      "the-company-(71-gordion)",
    );
  });

  it("keeps Korean letters", () => {
    expect(slugifyTitle("금괴")).toBe("금괴");
  });

  it("lowercases Unicode-aware and folds case", () => {
    expect(slugifyTitle("QUOTA Guide")).toBe("quota-guide");
    expect(slugifyTitle("quota guide")).toBe(slugifyTitle("Quota_Guide"));
  });

  it("treats underscores as spaces", () => {
    expect(slugifyTitle("Eclair__Moon_Guide")).toBe("eclair-moon-guide");
  });

  it("drops punctuation outside the allowed set", () => {
    expect(slugifyTitle("What's new?")).toBe("whats-new");
  });

  it("keeps dots", () => {
    expect(slugifyTitle("Version 1.2")).toBe("version-1.2");
  });

  it("collapses hyphen runs and trims edge hyphens", () => {
    expect(slugifyTitle("- A -- B -")).toBe("a-b");
  });

  it("mixed Korean + parens", () => {
    expect(slugifyTitle("타이탄 (8-Titan)")).toBe("타이탄-(8-titan)");
  });
});

describe("parseTitle", () => {
  it("main namespace, first letter uppercased (§5.7 step 5)", () => {
    const t = parseTitle("quota");
    expect(t).toMatchObject({
      namespace: 0,
      nsName: "main",
      storable: true,
      pageName: "Quota",
      slug: "quota",
      fragment: null,
      forcedPlain: false,
    });
  });

  it("[[quota]] ≡ [[Quota]] but QUOTA keeps its case beyond the first letter", () => {
    expect(parseTitle("quota")?.pageName).toBe(parseTitle("Quota")?.pageName);
    expect(parseTitle("QUOTA")?.pageName).toBe("QUOTA");
  });

  it("Template prefix, case- and underscore-insensitive", () => {
    const t = parseTitle("template:infobox_moon");
    expect(t).toMatchObject({
      namespace: 10,
      nsName: "template",
      storable: true,
      pageName: "Infobox moon",
      slug: "infobox-moon",
    });
  });

  it("Category prefix", () => {
    expect(parseTitle("Category:Moons")).toMatchObject({
      namespace: 14,
      nsName: "category",
      slug: "moons",
    });
  });

  it("Image: is an alias of File: (§5.8)", () => {
    const t = parseTitle("Image:Map.png");
    expect(t).toMatchObject({ namespace: 6, nsName: "file", storable: true });
    expect(t?.slug).toBe("map.png");
  });

  it("Project: and the site name both resolve to ns 4", () => {
    expect(parseTitle("Project:About")).toMatchObject({
      namespace: 4,
      nsName: "project",
    });
    expect(parseTitle("HQHQ Wiki:About")).toMatchObject({
      namespace: 4,
      nsName: "project",
      slug: "about",
    });
  });

  it("known but unstorable namespaces parse with storable:false (A7/O2)", () => {
    expect(parseTitle("Help:Editing")).toMatchObject({
      namespace: 12,
      nsName: null,
      storable: false,
      pageName: "Editing",
    });
    expect(parseTitle("User talk:Foo")).toMatchObject({
      namespace: 3,
      storable: false,
    });
    expect(parseTitle("help_talk:X")).toMatchObject({
      namespace: 13,
      storable: false,
    });
  });

  it("unknown prefix is not a namespace — colon is just text (§5.8)", () => {
    const t = parseTitle("Lore:Company");
    expect(t).toMatchObject({
      namespace: 0,
      nsName: "main",
      storable: true,
      pageName: "Lore:Company",
    });
    expect(t?.slug).toBe("lorecompany"); // ':' is outside the slug charset
  });

  it("leading colon forces plain-link handling and is stripped", () => {
    const t = parseTitle(":Category:Moons");
    expect(t).toMatchObject({
      namespace: 14,
      nsName: "category",
      forcedPlain: true,
      slug: "moons",
    });
  });

  it("fragment is split off and kept verbatim", () => {
    const t = parseTitle("Moons#Titan");
    expect(t).toMatchObject({ pageName: "Moons", fragment: "Titan" });
  });

  it("Korean title with fragment", () => {
    const t = parseTitle("위성 목록#타이탄");
    expect(t).toMatchObject({
      namespace: 0,
      pageName: "위성 목록",
      slug: "위성-목록",
      fragment: "타이탄",
    });
  });

  it("decodes percent-encoding and entities (§5.7 step 1)", () => {
    expect(parseTitle("Gold%20bar")?.slug).toBe("gold-bar");
    expect(parseTitle("Tea &amp; Biscuits")?.pageName).toBe("Tea & Biscuits");
  });

  it("empty / fragment-only titles are invalid", () => {
    expect(parseTitle("")).toBeNull();
    expect(parseTitle("   _  ")).toBeNull();
    expect(parseTitle("#Frag")).toBeNull();
    expect(parseTitle("Template:")).toBeNull();
  });
});

describe("titleToPath / pathToTitle (O1 routing form, O12 prefixes)", () => {
  it("main-namespace path — English is prefix-free (O12)", () => {
    expect(titleToPath("Gold bar", "en")).toBe("/wiki/gold-bar");
  });

  it("template path keeps the ns colon literal", () => {
    expect(titleToPath("Template:Infobox moon", "ko")).toBe(
      "/ko/wiki/template:infobox-moon",
    );
  });

  it("Korean slugs are percent-encoded in hrefs", () => {
    expect(titleToPath("금괴", "ko")).toBe(
      `/ko/wiki/${encodeURIComponent("금괴")}`,
    );
  });

  it("non-storable namespaces have no path", () => {
    expect(titleToPath("Help:Editing", "en")).toBeNull();
    expect(titleToPath("", "en")).toBeNull();
  });

  it("pathToTitle parses ns-prefixed segments", () => {
    expect(pathToTitle("template:infobox-moon")).toEqual({
      namespace: 10,
      nsName: "template",
      slug: "infobox-moon",
    });
    expect(pathToTitle("gold-bar")).toEqual({
      namespace: 0,
      nsName: "main",
      slug: "gold-bar",
    });
  });

  it("pathToTitle decodes encoded segments and accepts arrays", () => {
    expect(pathToTitle(encodeURIComponent("금괴"))).toEqual({
      namespace: 0,
      nsName: "main",
      slug: "금괴",
    });
    expect(pathToTitle(["category:moons"])).toMatchObject({
      nsName: "category",
      slug: "moons",
    });
  });

  it("pathToTitle rejects empty input", () => {
    expect(pathToTitle("")).toBeNull();
    expect(pathToTitle("template:")).toBeNull();
  });

  it("round-trips title → path → (ns, slug)", () => {
    const path = titleToPath("The Company (71-Gordion)", "en");
    expect(path).toBe("/wiki/the-company-(71-gordion)");
    const back = pathToTitle(path!.replace("/wiki/", ""));
    expect(back).toEqual({
      namespace: 0,
      nsName: "main",
      slug: "the-company-(71-gordion)",
    });
  });
});

describe("canonicalFilename (decisions O6)", () => {
  it("lowercases, including the extension", () => {
    expect(canonicalFilename("Map.PNG")).toBe("map.png");
  });

  it("whitespace/underscore runs → single hyphen", () => {
    expect(canonicalFilename("My Map _ v2.png")).toBe("my-map-v2.png");
  });

  it("applies NFC to Unicode names", () => {
    expect(canonicalFilename("한국.PNG")).toBe("한국.png");
  });
});
