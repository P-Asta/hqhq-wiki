/**
 * Converting the retired version grammar — src/lib/visual-editor/version-tags.ts.
 *
 * Two kinds of assertion, and the second is the point of the file. The unit
 * cases pin the mapping table of docs/engine/versioning.md §2.2 form by form.
 * The fixtures below them are the real corpus: the exact strings the seed and
 * the user's own database held on 2026-09-03, frozen here, each asserted
 * against the exact string that replaced it. A converter that is right about
 * `<version since="v70">` in the abstract and wrong about the page somebody
 * wrote is not much use.
 *
 * Registry-shaped assertions use the seeded registry, because "one version
 * below the next" is a lookup in it and the answer changes with its contents —
 * v56's window ends at v60, not v61, since v61 is not a version anyone can run.
 */

import { describe, expect, it } from "vitest";

import { ARTICLES, HELP_PAGES } from "@/lib/db/seed-data";
import { SEED_VERSION_IDS, versionOrdinal } from "@/lib/db/store";
import type { VersionRegistryEntry } from "@/lib/version-branches";

import { convertLegacyVersionMarkup, hasLegacyVersionMarkup } from "./version-tags";

/** The seeded registry: v45 … v70, with the gaps a real registry has. */
const REGISTRY: VersionRegistryEntry[] = SEED_VERSION_IDS.map((id) => ({
  id,
  label: id,
  ordinal: versionOrdinal(id),
}));

/** The live registry on the machine this ran against, which also has v71. */
const LIVE_REGISTRY: VersionRegistryEntry[] = [
  ...REGISTRY,
  { id: "v71", label: "v71", ordinal: versionOrdinal("v71") },
];

function convert(source: string, registry: VersionRegistryEntry[] = REGISTRY): string {
  return convertLegacyVersionMarkup(source, registry).text;
}

/* ------------------------------------------------------------------ */
/* The mapping table (§2.2)                                            */
/* ------------------------------------------------------------------ */

describe("the standalone <version> forms", () => {
  it("maps since= to an open-ended tag", () => {
    expect(convert(`<version since="v70">x</version>`)).toBe("<v70+>x</v70+>");
  });

  it("maps since= + until= to a window", () => {
    expect(convert(`<version since="v70" until="v80">x</version>`)).toBe("<v70+v80>x</v70+v80>");
  });

  it("maps only= with one id to the single-version tag", () => {
    expect(convert(`<version only="v70">x</version>`)).toBe("<v70>x</v70>");
  });

  it("maps only= with several ids to one tag each, body repeated", () => {
    expect(convert(`<version only="v70,v80">x</version>`)).toBe("<v70>x</v70><v80>x</v80>");
  });

  it("writes a window whose ends are one version as the single-version tag", () => {
    // `<v70+v70>` and `<v70>` are the same range; §2.2 spells it the short way.
    expect(convert(`<version since="v70" until="v70">x</version>`)).toBe("<v70>x</v70>");
  });

  it("takes the tags off a since=\"*\" passage, because untagged prose is every version", () => {
    expect(convert(`<version since="*">z</version>`)).toBe("z");
  });

  it("reads a stray <variant> as the standalone form §2.6 says it is", () => {
    expect(convert(`<variant since="v62">x</variant>`)).toBe("<v62+>x</v62+>");
  });

  it("drops a label, which the chips no longer take", () => {
    expect(convert(`<version since="v62" label="Patch 3">x</version>`)).toBe("<v62+>x</v62+>");
  });

  it("keeps the text around the construct byte for byte", () => {
    expect(convert(`The quota is <version since="v62">'''180'''</version> credits.\n`)).toBe(
      "The quota is <v62+>'''180'''</v62+> credits.\n",
    );
  });

  it("lowercases the id, the spelling the registry keeps", () => {
    expect(convert(`<version since="V62">x</version>`)).toBe("<v62+>x</v62+>");
  });

  it("converts a construct nested inside another one", () => {
    expect(convert(`<version since="v50">a<version only="v62">b</version></version>`)).toBe(
      "<v50+>a<v62>b</v62></v50+>",
    );
  });

  it("rewrites an unclosed opener, which swallows to the end either way", () => {
    expect(convert(`<version since="v62">the rest of the page`)).toBe("<v62+>the rest of the page");
  });

  it("converts an empty body to an empty tag rather than dropping the boundary", () => {
    // The page names v62; a chip for it is the author's, not this transform's
    // to take away.
    expect(convert(`<version since="v62"></version>`)).toBe("<v62+></v62+>");
  });
});

/* ------------------------------------------------------------------ */

describe("the <versions> group", () => {
  it("ends each branch one REGISTERED version below the next", () => {
    const group = [
      "<versions>",
      '<variant since="v45">a</variant>',
      '<variant since="v56">b</variant>',
      '<variant since="v62">c</variant>',
      "</versions>",
    ].join("\n");

    // v55 is the newest registered id below v56; v60 the newest below v62.
    expect(convert(group)).toBe("<v45+v55>a</v45+v55><v56+v60>b</v56+v60><v62+>c</v62+>");
  });

  it("collapses a branch that covers only its own version", () => {
    const group = [
      "<versions>",
      '<variant since="v70">a</variant>',
      '<variant since="v71">b</variant>',
      "</versions>",
    ].join("\n");

    // Nothing is registered between v70 and v71, so the first branch is
    // `<v70+v70>` — which §2.2 writes `<v70>`.
    expect(convert(group, LIVE_REGISTRY)).toBe("<v70>a</v70><v71+>b</v71+>");
  });

  it("ends a branch on its own id when the registry knows nothing below the next", () => {
    const group = [
      "<versions>",
      '<variant since="v72">a</variant>',
      '<variant since="v80">b</variant>',
      "</versions>",
    ].join("\n");

    // No registered version sits in [v72, v80), so the branch covers v72 alone.
    // Reaching down to v70 would hand v72's words to a reader on v70.
    expect(convert(group)).toBe("<v72>a</v72><v80+>b</v80+>");
  });

  it("with no registry at all, every branch ends on its own id", () => {
    const group = [
      "<versions>",
      '<variant since="v45">a</variant>',
      '<variant since="v56">b</variant>',
      "</versions>",
    ].join("\n");

    expect(convertLegacyVersionMarkup(group).text).toBe("<v45>a</v45><v56+>b</v56+>");
  });

  it("drops the whitespace between variants, which would otherwise render", () => {
    // Proven against the engine: `<v45+v55>A</v45+v55>\n<v56+v60>B</v56+v60>`
    // renders `<p><br /></p>` at v56, because the newline is untagged text now.
    expect(convert(`<versions>\n<variant since="v45">a</variant>\n</versions>`)).toBe(
      "<v45+>a</v45+>",
    );
  });

  it("puts the * fallback in front, as prose belonging to every version", () => {
    const group = [
      "<versions>",
      '<variant since="*">z</variant>',
      '<variant since="v50">a</variant>',
      "</versions>",
    ].join("\n");

    expect(convert(group)).toBe("z<v50+>a</v50+>");
  });

  it("orders branches by ordinal however they were written", () => {
    const group = [
      "<versions>",
      '<variant since="v62">c</variant>',
      '<variant since="v45">a</variant>',
      "</versions>",
    ].join("\n");

    // The old engine picked the greatest `since` at or below the selection, so
    // source order never meant anything; ordinal order is what makes the new
    // windows disjoint.
    expect(convert(group)).toBe("<v45+v60>a</v45+v60><v62+>c</v62+>");
  });

  it("lets a variant's own until= close its window early", () => {
    const group = [
      "<versions>",
      '<variant since="v45" until="v49">a</variant>',
      '<variant since="v62">c</variant>',
      "</versions>",
    ].join("\n");

    expect(convert(group)).toBe("<v45+v49>a</v45+v49><v62+>c</v62+>");
  });

  it("converts the branches' own bodies", () => {
    const group = [
      "<versions>",
      '<variant since="v50">a<version only="v62">b</version></variant>',
      "</versions>",
    ].join("\n");

    expect(convert(group)).toBe("<v50+>a<v62>b</v62></v50+>");
  });

  it("keeps a group of one, and the text around it", () => {
    expect(convert(`Intro.\n\n<versions><variant since="v62">c</variant></versions>\n\nOutro.\n`)).toBe(
      "Intro.\n\n<v62+>c</v62+>\n\nOutro.\n",
    );
  });
});

/* ------------------------------------------------------------------ */
/* What it refuses                                                     */
/* ------------------------------------------------------------------ */

describe("what it leaves alone, and says so", () => {
  function reasons(source: string): string[] {
    return convertLegacyVersionMarkup(source, REGISTRY).skipped.map((entry) => entry.reason);
  }

  function unchanged(source: string): void {
    const result = convertLegacyVersionMarkup(source, REGISTRY);
    expect(result.text).toBe(source);
    expect(result.changed).toBe(0);
    expect(result.skipped.length).toBeGreaterThan(0);
  }

  it("refuses prose parked between two variants", () => {
    const group = [
      "<versions>",
      '<variant since="v45">a</variant>',
      "stray words",
      '<variant since="v62">c</variant>',
      "</versions>",
    ].join("\n");

    // The group rendered one variant and nothing else, so those words showed
    // nowhere; keeping them would add text, dropping them would delete text.
    unchanged(group);
    expect(reasons(group)).toEqual(["stray-content"]);
  });

  it("refuses a group that never closes, and everything it swallowed", () => {
    // An unclosed group runs to the end of the input, so the variant below is
    // inside it. Lifting that variant out into a standalone tag would be a
    // conversion of markup this refused to read.
    const source = `<versions>\n<variant since="v45">a</variant>\n<version since="v62">b</version>\n`;

    unchanged(source);
    expect(reasons(source)).toEqual(["unclosed"]);
  });

  it("refuses a group holding no variants", () => {
    expect(reasons("<versions>\n</versions>")).toEqual(["no-branches"]);
  });

  it("refuses two branches naming one boundary", () => {
    const group = [
      "<versions>",
      '<variant since="v50">a</variant>',
      '<variant since="v50">b</variant>',
      "</versions>",
    ].join("\n");

    unchanged(group);
    expect(reasons(group)).toEqual(["duplicate-id"]);
  });

  it("refuses only= crossed with since=", () => {
    unchanged(`<version since="v50" only="v62">x</version>`);
    expect(reasons(`<version since="v50" only="v62">x</version>`)).toEqual(["attributes"]);
  });

  it("refuses a bare until=, a window open below that has no spelling", () => {
    unchanged(`<version until="v61">x</version>`);
    expect(reasons(`<version until="v61">x</version>`)).toEqual(["attributes"]);
  });

  it("refuses a construct with no range at all", () => {
    expect(reasons("<version>x</version>")).toEqual(["attributes"]);
  });

  it("refuses an id nothing can order", () => {
    expect(reasons(`<version since="latest">x</version>`)).toEqual(["malformed-id"]);
    expect(reasons(`<version only="v50,soon">x</version>`)).toEqual(["malformed-id"]);
  });

  it("refuses an unclosed only=, whose body it would have to copy", () => {
    expect(reasons(`<version only="v50,v62">x`)).toEqual(["unclosed"]);
  });

  it("does not rewrite the innards of a construct it refused", () => {
    // Turning the branches of a refused group into three standalone tags is a
    // different page, not a partial conversion.
    const group = [
      "<versions>",
      '<variant since="v45">a</variant>',
      "stray words",
      '<variant since="v62">c</variant>',
      "</versions>",
    ].join("\n");

    expect(convert(group)).toContain('<variant since="v45">');
  });

  it("carries on past a refused self-closing tag, which swallows nothing", () => {
    const source = `<version until="v61"/>\n<version since="v62">y</version>`;
    const result = convertLegacyVersionMarkup(source, REGISTRY);

    expect(result.text).toBe(`<version until="v61"/>\n<v62+>y</v62+>`);
    expect(result.changed).toBe(1);
  });

  it("converts what it can beside what it cannot", () => {
    const source = `<version until="v61">x</version>\n<version since="v62">y</version>`;
    const result = convertLegacyVersionMarkup(source, REGISTRY);

    expect(result.text).toBe(`<version until="v61">x</version>\n<v62+>y</v62+>`);
    expect(result.changed).toBe(1);
    expect(result.skipped.map((entry) => entry.reason)).toEqual(["attributes"]);
  });

  it("locates each refusal by offset and opening tag", () => {
    const source = `lead\n<version until="v61">x</version>`;
    const [skipped] = convertLegacyVersionMarkup(source, REGISTRY).skipped;

    expect(skipped.at).toBe(source.indexOf("<version"));
    expect(skipped.tag).toBe(`<version until="v61">`);
  });
});

/* ------------------------------------------------------------------ */
/* Quoted examples                                                     */
/* ------------------------------------------------------------------ */

describe("documentation survives verbatim", () => {
  it("leaves a <pre> example exactly as written and counts it", () => {
    const source = `<pre>\n<versions>\n<variant since="v50">The value is 130.</variant>\n</versions>\n</pre>\n`;
    const result = convertLegacyVersionMarkup(source, REGISTRY);

    expect(result.text).toBe(source);
    expect(result.changed).toBe(0);
    expect(result.skipped).toEqual([]);
    expect(result.quoted).toBe(4);
  });

  it("leaves <nowiki>, <syntaxhighlight> and comments alone", () => {
    for (const source of [
      `<nowiki><version since="v50">x</version></nowiki>`,
      `<syntaxhighlight lang="html"><version since="v50">x</version></syntaxhighlight>`,
      `<!-- <version since="v50">x</version> -->`,
    ]) {
      expect(convert(source)).toBe(source);
    }
  });

  it("converts the live construct on a page that also documents the old one", () => {
    const source = [
      `<version since="v55">Live.</version>`,
      "",
      "<pre>",
      `<version since="v55">Documented.</version>`,
      "</pre>",
      "",
    ].join("\n");
    const result = convertLegacyVersionMarkup(source, REGISTRY);

    expect(result.text).toBe(
      [
        "<v55+>Live.</v55+>",
        "",
        "<pre>",
        `<version since="v55">Documented.</version>`,
        "</pre>",
        "",
      ].join("\n"),
    );
    expect(result.changed).toBe(1);
    expect(result.quoted).toBe(2);
  });

  it("treats an unclosed <nowiki> as raw text to the end, exactly as the engine does", () => {
    const source = `<nowiki>\n<version since="v50">x</version>\n`;
    expect(convert(source)).toBe(source);
  });
});

/* ------------------------------------------------------------------ */
/* Safety                                                              */
/* ------------------------------------------------------------------ */

describe("it never throws, and never runs twice", () => {
  it("returns text with no version markup untouched", () => {
    const source = "Plain prose with a {{Template}} and a [[Link]].\n";
    expect(convertLegacyVersionMarkup(source, REGISTRY)).toEqual({
      text: source,
      changed: 0,
      skipped: [],
      quoted: 0,
    });
  });

  it("is a no-op on text already in the new grammar", () => {
    const source = "The base quota is <v50+v61>'''130'''</v50+v61><v62+>'''180'''</v62+> credits.\n";
    const result = convertLegacyVersionMarkup(source, REGISTRY);

    expect(result.text).toBe(source);
    expect(result.changed).toBe(0);
  });

  it("converges: converting the output again changes nothing", () => {
    const source = [
      "<versions>",
      '<variant since="*">z</variant>',
      '<variant since="v45">a</variant>',
      '<variant since="v62">c</variant>',
      "</versions>",
      `<version only="v56,v60">both</version>`,
    ].join("\n");

    const once = convertLegacyVersionMarkup(source, REGISTRY);
    const twice = convertLegacyVersionMarkup(once.text, REGISTRY);

    expect(twice.text).toBe(once.text);
    expect(twice.changed).toBe(0);
  });

  it("survives markup no author would write", () => {
    for (const source of [
      "",
      "<",
      "</version>",
      "<version",
      "<versions><versions></versions></versions>",
      `<version since="v50"><variant since="v62">`,
      "<version/>",
      `<version since="v50"/>`,
      "<versions>".repeat(200) + "x" + "</versions>".repeat(200),
    ]) {
      expect(() => convertLegacyVersionMarkup(source, REGISTRY)).not.toThrow();
    }
  });

  it("converts a self-closing construct to an empty tag", () => {
    expect(convert(`<version since="v50"/>`)).toBe("<v50+></v50+>");
  });
});

/* ------------------------------------------------------------------ */
/* The real corpus                                                     */
/* ------------------------------------------------------------------ */

describe("the fixtures this conversion was written for", () => {
  /** src/lib/db/seed-content/equipment-scrap.ts, Company Cruiser, before. */
  const CRUISER_WAS = `<version since="v55">''Added in v55, the vehicle update.''</version>`;
  const CRUISER_NOW = `<v55+>''Added in v55, the vehicle update.''</v55+>`;

  /** seed-data.ts, Project:Version scoping, the live demonstration, before. */
  const HELP_WAS = [
    "<versions>",
    `<variant since="v45">You are viewing a version between '''v45''' and v55. This sentence lives in the first window.</variant>`,
    `<variant since="v56">You are viewing '''v56''' to v61. The second window replaced the first at v56.</variant>`,
    `<variant since="v62">You are viewing '''v62''' or later. The third window replaced the second at v62.</variant>`,
    "</versions>",
  ].join("\n");

  /** …and the Korean translation of it. */
  const HELP_KO_WAS = [
    "<versions>",
    `<variant since="v45">지금 '''v45'''부터 v55 사이를 보고 있습니다. 이 문장은 첫 번째 구간에 속합니다.</variant>`,
    `<variant since="v56">지금 '''v56'''부터 v61 사이를 보고 있습니다. v56에서 두 번째 구간이 첫 번째를 대체했습니다.</variant>`,
    `<variant since="v62">지금 '''v62''' 이상을 보고 있습니다. v62에서 세 번째 구간이 두 번째를 대체했습니다.</variant>`,
    "</versions>",
  ].join("\n");

  /** main:aaaa in the user's own database, head revision on 2026-09-03. */
  const USER_PAGE =
    '{| class="wikitable"\n! Header 1 !! Header 3333\n|-\n| Cell1 || Cell2231\n|}\n\n' +
    '<versions>\n<variant since="v70"></variant>\n<variant since="v71">aaaaa</variant>\n</versions>\n\n\n';

  it("converts the Company Cruiser's note to what the seed now holds", () => {
    expect(convert(CRUISER_WAS)).toBe(CRUISER_NOW);

    const cruiser = ARTICLES.find((entry) => entry.title === "Company Cruiser");
    expect(cruiser?.wikitext).toContain(CRUISER_NOW);
    expect(cruiser?.wikitext).not.toContain("<version");
  });

  it("converts the help page's demonstration to what the seed now holds", () => {
    const converted = convert(HELP_WAS);

    // v55 and v60 come from the registry, not from arithmetic: v61 is not a
    // version anybody can select, so no window may claim to end there.
    expect(converted).toContain("<v45+v55>");
    expect(converted).toContain("<v56+v60>");
    expect(converted).toContain("<v62+>");

    const help = HELP_PAGES.find((entry) => entry.title === "Version scoping");
    expect(help?.wikitext).toContain("<v45+v55>You are viewing a version between");
    expect(help?.wikitext).toContain("</v56+v60><v62+>You are viewing '''v62''' or later.");
  });

  it("converts the Korean demonstration the same way", () => {
    const converted = convert(HELP_KO_WAS);

    expect(converted).toContain("<v45+v55>지금 '''v45'''부터 v55 사이를");
    expect(converted).toContain("<v56+v60>지금 '''v56'''부터 v61 사이를");
    expect(converted).toContain("<v62+>지금 '''v62''' 이상을");

    const help = HELP_PAGES.find((entry) => entry.title === "Version scoping");
    const ko = help?.translations.find((entry) => entry.locale === "ko");
    expect(ko?.wikitext).toContain("<v45+v55>지금 '''v45'''부터 v55 사이를");
    expect(ko?.wikitext).not.toContain("<variant");
  });

  it("converts the user's own page, empty branch and all", () => {
    const result = convertLegacyVersionMarkup(USER_PAGE, LIVE_REGISTRY);

    expect(result.text).toBe(
      '{| class="wikitable"\n! Header 1 !! Header 3333\n|-\n| Cell1 || Cell2231\n|}\n\n' +
        "<v70></v70><v71+>aaaaa</v71+>\n\n\n",
    );
    expect(result.changed).toBe(1);
    expect(result.skipped).toEqual([]);
    // The table above it is untouched, which is most of the page.
    expect(result.text.startsWith('{| class="wikitable"')).toBe(true);
  });

  it("leaves no retired construct anywhere in the seed content", () => {
    const pages: string[] = [];
    for (const article of ARTICLES) {
      pages.push(article.wikitext, ...article.translations.map((t) => t.wikitext));
    }
    for (const help of HELP_PAGES) {
      pages.push(help.wikitext, ...help.translations.map((t) => t.wikitext));
    }

    for (const wikitext of pages) expect(hasLegacyVersionMarkup(wikitext)).toBe(false);
  });
});
