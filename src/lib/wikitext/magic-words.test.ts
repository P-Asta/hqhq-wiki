import { describe, expect, it } from "vitest";

import { DEFAULT_NAMESPACES } from "@/lib/title";
import {
  MAGIC_WORDS,
  evaluateMagicWord,
  isMagicWord,
  isoWeekNumber,
  titleKey,
  wikiUrlencode,
} from "./magic-words";
import type {
  ExpandApi,
  PageMeta,
  PageStore,
  Title,
  VersionTable,
  WikiConfig,
  WikiMessages,
} from "./types";

/* ---------------------------------------------------------------- */
/* Fixtures                                                          */
/* ---------------------------------------------------------------- */

const messages: WikiMessages = {
  tocTitle: "Contents",
  redLinkTitleSuffix: "(page does not exist)",
  redirectTo: "Redirect to:",
  citeErrorNoText: (name) => `Cite error: no text provided for ref "${name}"`,
  templateLoop: "Template loop detected",
  templateDepthExceeded: "Template recursion depth limit exceeded",
  unknownVersion: (id) => `unknown-version: ${id}`,
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
  messages,
};

const store: PageStore = {
  getSource: () => null,
  exists: () => false,
  getFile: () => null,
};

const versions: VersionTable = {
  byId: {
    v50: { id: "v50", label: "v50", ordinal: 50_000, status: "legacy" },
    v70: { id: "v70", label: "v70 Big Patch", ordinal: 70_000, status: "current" },
  },
  ordered: [
    { id: "v50", label: "v50", ordinal: 50_000, status: "legacy" },
    { id: "v70", label: "v70 Big Patch", ordinal: 70_000, status: "current" },
  ],
  defaultId: "v70",
};

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

/** Spec §9.5's worked example page. */
const HELP_PAGE: Title = { namespace: 12, pageName: "Guides/Routing" };

/** 2026-08-30T14:05:09Z — the date §9.5's variable table is written against. */
const NOW = new Date(Date.UTC(2026, 7, 30, 14, 5, 9));

/** ParseContext + the page-scope sinks stage 2 hands to the §9 module. */
/** Minimal stand-in for the stage-2 services (types.ts `ExpandApi`). */
function makeCtx(page: Title = HELP_PAGE, version: string | null = null): ExpandApi {
  const meta = makeMeta();
  return {
    ctx: { config, store, page, now: NOW, version, versions },
    frame: { title: null, args: [], parent: null, depth: 0 },
    meta,
    expandText: (text) => text,
    expandNodes: () => "",
    addStrip: (_name, content) => content,
    countExpensive: () => true,
    markVolatile: () => {
      meta.volatile = true;
    },
    warn: (message) => {
      if (!meta.warnings.includes(message)) meta.warnings.push(message);
    },
  };
}

/* ---------------------------------------------------------------- */
/* Tests                                                             */
/* ---------------------------------------------------------------- */

describe("page variables (spec §9.5)", () => {
  it("C-60: PAGENAME / SUBPAGENAME on page Help:Guides/Routing", () => {
    const ctx = makeCtx();
    expect(evaluateMagicWord("PAGENAME", ctx)).toBe("Guides/Routing");
    expect(evaluateMagicWord("SUBPAGENAME", ctx)).toBe("Routing");
  });

  it("reproduces the whole §9.5 example table", () => {
    const ctx = makeCtx();
    expect(evaluateMagicWord("FULLPAGENAME", ctx)).toBe("Help:Guides/Routing");
    expect(evaluateMagicWord("NAMESPACE", ctx)).toBe("Help");
    expect(evaluateMagicWord("NAMESPACENUMBER", ctx)).toBe("12");
    expect(evaluateMagicWord("BASEPAGENAME", ctx)).toBe("Guides");
    expect(evaluateMagicWord("ROOTPAGENAME", ctx)).toBe("Guides");
    expect(evaluateMagicWord("TALKPAGENAME", ctx)).toBe("Help talk:Guides/Routing");
    expect(evaluateMagicWord("SUBJECTPAGENAME", ctx)).toBe("Help:Guides/Routing");
  });

  it("NAMESPACE is empty on a main-namespace page; talk pages fold back", () => {
    const ctx = makeCtx({ namespace: 0, pageName: "Titan" });
    expect(evaluateMagicWord("NAMESPACE", ctx)).toBe("");
    expect(evaluateMagicWord("FULLPAGENAME", ctx)).toBe("Titan");
    expect(evaluateMagicWord("TALKPAGENAME", ctx)).toBe("Talk:Titan");
    const talk = makeCtx({ namespace: 1, pageName: "Titan" });
    expect(evaluateMagicWord("TALKPAGENAME", talk)).toBe("Talk:Titan");
    expect(evaluateMagicWord("SUBJECTPAGENAME", talk)).toBe("Titan");
  });

  it("the …E variants are href-encoded per §5.7 (slashes and colons kept)", () => {
    const ctx = makeCtx();
    expect(evaluateMagicWord("PAGENAMEE", ctx)).toBe("Guides/Routing");
    expect(evaluateMagicWord("FULLPAGENAMEE", ctx)).toBe("Help:Guides/Routing");
    const spaced = makeCtx({ namespace: 0, pageName: "Gold bar" });
    expect(evaluateMagicWord("PAGENAMEE", spaced)).toBe("Gold_bar");
  });

  it("SITENAME comes from config", () => {
    expect(evaluateMagicWord("SITENAME", makeCtx())).toBe("HQHQ Wiki");
  });

  it("page variables never set the volatile flag", () => {
    const ctx = makeCtx();
    evaluateMagicWord("FULLPAGENAME", ctx);
    expect(ctx.meta.volatile).toBe(false);
  });
});

describe("CURRENT* variables (spec §9.5)", () => {
  it("formats every clock variable against the injected now", () => {
    const ctx = makeCtx();
    expect(evaluateMagicWord("CURRENTYEAR", ctx)).toBe("2026");
    expect(evaluateMagicWord("CURRENTMONTH", ctx)).toBe("08");
    expect(evaluateMagicWord("CURRENTMONTH1", ctx)).toBe("8");
    expect(evaluateMagicWord("CURRENTMONTHNAME", ctx)).toBe("August");
    expect(evaluateMagicWord("CURRENTMONTHABBREV", ctx)).toBe("Aug");
    expect(evaluateMagicWord("CURRENTDAY", ctx)).toBe("30");
    expect(evaluateMagicWord("CURRENTDAY2", ctx)).toBe("30");
    expect(evaluateMagicWord("CURRENTDOW", ctx)).toBe("0");
    expect(evaluateMagicWord("CURRENTDAYNAME", ctx)).toBe("Sunday");
    expect(evaluateMagicWord("CURRENTTIME", ctx)).toBe("14:05");
    expect(evaluateMagicWord("CURRENTHOUR", ctx)).toBe("14");
    expect(evaluateMagicWord("CURRENTWEEK", ctx)).toBe("35");
    expect(evaluateMagicWord("CURRENTTIMESTAMP", ctx)).toBe("20260830140509");
  });

  it("marks the page volatile (db-schema Addendum A5)", () => {
    const ctx = makeCtx();
    expect(ctx.meta.volatile).toBe(false);
    evaluateMagicWord("CURRENTYEAR", ctx);
    expect(ctx.meta.volatile).toBe(true);
  });

  it("LOCAL* are aliases for the same UTC clock", () => {
    const ctx = makeCtx();
    expect(evaluateMagicWord("LOCALYEAR", ctx)).toBe("2026");
    expect(evaluateMagicWord("LOCALTIMESTAMP", ctx)).toBe("20260830140509");
  });

  it("isoWeekNumber tracks ISO-8601 week boundaries", () => {
    expect(isoWeekNumber(new Date(Date.UTC(2026, 0, 1)))).toBe(1);
    expect(isoWeekNumber(new Date(Date.UTC(2026, 7, 30)))).toBe(35);
  });
});

describe("version magic words (versioning.md §2.5)", () => {
  it("resolves against the selected version and the site default", () => {
    const ctx = makeCtx(HELP_PAGE, "v50");
    expect(evaluateMagicWord("VERSION", ctx)).toBe("v50");
    expect(evaluateMagicWord("VERSIONLABEL", ctx)).toBe("v50");
    expect(evaluateMagicWord("VERSIONORDINAL", ctx)).toBe("50000");
    expect(evaluateMagicWord("LATESTVERSION", ctx)).toBe("v70");
    expect(evaluateMagicWord("ISLATESTVERSION", ctx)).toBe("");
  });

  it("a null selection falls back to the site default", () => {
    const ctx = makeCtx(HELP_PAGE, null);
    expect(evaluateMagicWord("VERSION", ctx)).toBe("v70");
    expect(evaluateMagicWord("VERSIONLABEL", ctx)).toBe("v70 Big Patch");
    expect(evaluateMagicWord("ISLATESTVERSION", ctx)).toBe("1");
  });

  it("are NOT volatile but DO mark the page version-scoped (§2.5/§4)", () => {
    const ctx = makeCtx(HELP_PAGE, "v50");
    evaluateMagicWord("VERSION", ctx);
    expect(ctx.meta.volatile).toBe(false);
    expect(ctx.meta.versionScoped).toBe(true);
    expect(ctx.meta.versionBoundaries).toEqual([]);
  });
});

describe("registry and escapes", () => {
  it("§7.10: {{!}} and {{=}} belong to stage 2, not this registry", () => {
    const ctx = makeCtx();
    expect(evaluateMagicWord("!", ctx)).toBeNull();
    expect(evaluateMagicWord("=", ctx)).toBeNull();
  });

  it("unregistered names return null so template resolution continues", () => {
    const ctx = makeCtx();
    expect(evaluateMagicWord("Infobox moon", ctx)).toBeNull();
    expect(evaluateMagicWord("NOTAVARIABLE", ctx)).toBeNull();
  });

  it("§9.1: ALL-CAPS variables are matched case-sensitively", () => {
    const ctx = makeCtx();
    expect(evaluateMagicWord("pagename", ctx)).toBeNull();
    expect(isMagicWord("PAGENAME")).toBe(true);
    expect(isMagicWord("pagename")).toBe(false);
    expect(MAGIC_WORDS.has("CURRENTTIMESTAMP")).toBe(true);
  });

  it("optional store-backed variables answer with an empty string (§9.5)", () => {
    const ctx = makeCtx();
    expect(evaluateMagicWord("REVISIONID", ctx)).toBe("");
    expect(evaluateMagicWord("SERVERNAME", ctx)).toBe("");
  });
});

describe("shared helpers", () => {
  it("titleKey is ns:Normalized_page_name (types.ts §14.10)", () => {
    expect(titleKey(10, "Infobox moon")).toBe("10:Infobox_moon");
    expect(titleKey(0, "Gold bar")).toBe("0:Gold_bar");
  });

  it("wikiUrlencode follows the §5.7 readability reversions", () => {
    expect(wikiUrlencode("Guides/Routing")).toBe("Guides/Routing");
    expect(wikiUrlencode("Help:A b")).toBe("Help:A_b");
    expect(wikiUrlencode("The Company (71-Gordion)")).toBe("The_Company_(71-Gordion)");
  });
});
