import { describe, expect, it } from "vitest";

import { DEFAULT_NAMESPACES } from "@/lib/title";
import {
  evaluateParserFunction,
  isParserFunction,
  literalArgs,
  parserFunctionHooks,
} from "./parser-functions";
import type {
  ExpandApi,
  PageMeta,
  PageStore,
  ParserFunctionArg,
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

function makeConfig(overrides: Partial<WikiConfig> = {}): WikiConfig {
  return {
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
    ...overrides,
  };
}

/** Spec §15 fixture pages, keyed as `ns:Normalized_page_name`. */
const EXISTING_PAGES = new Set(["0:Bracken", "0:Moon", "0:Quota", "0:Target", "10:1x"]);

const FILES: Record<string, { src: string; width: number; height: number }> = {
  "X.png": { src: "/api/media/x.png", width: 100, height: 80 },
};

const store: PageStore = {
  getSource: () => null,
  exists: (title) => EXISTING_PAGES.has(title),
  getFile: (name) => FILES[name] ?? null,
};

const VERSION_IDS: [string, number][] = [
  ["v45", 45_000],
  ["v50", 50_000],
  ["v55", 55_000],
  ["v62", 62_000],
  ["v70", 70_000],
];

const versions: VersionTable = {
  byId: Object.fromEntries(
    VERSION_IDS.map(([id, ordinal]) => [
      id,
      { id, label: id, ordinal, status: id === "v70" ? "current" : "legacy" },
    ]),
  ),
  ordered: VERSION_IDS.map(([id, ordinal]) => ({
    id,
    label: id,
    ordinal,
    status: (id === "v70" ? "current" : "legacy") as "current" | "legacy",
  })),
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

const TITAN: Title = { namespace: 0, pageName: "Titan" };

/**
 * Stand-in for the stage-2 services (`ExpandApi`, types.ts), including the
 * `maxExpensiveCalls` budget `countExpensive()` charges against (§9.2).
 */
function makeCtx(
  options: { page?: Title; version?: string | null; config?: Partial<WikiConfig> } = {},
): ExpandApi & { expensive: number } {
  const config = makeConfig(options.config);
  const meta = makeMeta();
  const api: ExpandApi & { expensive: number } = {
    expensive: 0,
    ctx: {
      config,
      store,
      page: options.page ?? TITAN,
      now: new Date(Date.UTC(2026, 7, 30, 14, 5, 9)),
      version: options.version ?? null,
      versions,
    },
    frame: { title: null, args: [], parent: null, depth: 0 },
    meta,
    expandText: (text: string) => text,
    expandNodes: () => "",
    addStrip: (_name: string, content: string) => content,
    countExpensive: () => {
      api.expensive += 1;
      if (api.expensive > config.maxExpensiveCalls) {
        api.warn("expensive-call-limit-exceeded");
        return false;
      }
      return true;
    },
    markVolatile: () => {
      meta.volatile = true;
    },
    warn: (message: string) => {
      if (!meta.warnings.includes(message)) meta.warnings.push(message);
    },
  };
  return api;
}

/**
 * Arguments that record which VALUES were actually expanded, so the §8.5/§9.2
 * "only the taken branch expands" rule is assertable. Names are plain data (a
 * `#switch` must read them all to choose); values stay behind a thunk.
 */
function lazyArgs(values: readonly string[]): {
  args: ParserFunctionArg[];
  expandedValues: string[];
} {
  const expandedValues: string[] = [];
  const args: ParserFunctionArg[] = values.map((raw) => {
    const equals = raw.indexOf("=");
    const name = equals < 0 ? null : raw.slice(0, equals).trim();
    const body = equals < 0 ? raw : raw.slice(equals + 1);
    return {
      name,
      nodes: [{ kind: "text" as const, value: body }],
      value: () => {
        expandedValues.push(raw);
        return body.trim();
      },
    };
  });
  return { args, expandedValues };
}

function call(name: string, values: readonly string[], ctx = makeCtx()): string | null {
  return evaluateParserFunction(name, literalArgs(values), ctx);
}

/* ---------------------------------------------------------------- */
/* §9.2 control flow                                                 */
/* ---------------------------------------------------------------- */

describe("#if (spec §9.2)", () => {
  it("C-55: whitespace-only is false, the string 0 is true", () => {
    expect(call("#if", ["   ", "y", "n"])).toBe("n");
    expect(call("#if", [" 0 ", "y", "n"])).toBe("y");
  });

  it("§9.6-1: a missing branch yields the empty string", () => {
    expect(call("#if", ["", "yes"])).toBe("");
    expect(call("#if", ["x", "yes"])).toBe("yes");
  });

  it("branches are trimmed", () => {
    expect(call("#if", ["x", "  then  ", "  else  "])).toBe("then");
  });

  it("§8.5: only the taken branch is expanded", () => {
    const { args, expandedValues } = lazyArgs(["x", "THEN", "ELSE"]);
    expect(evaluateParserFunction("#if", args, makeCtx())).toBe("THEN");
    expect(expandedValues).toEqual(["x", "THEN"]);
  });

  it("§9.2: `=` is not structural outside #switch", () => {
    expect(call("#if", ["x", "a=b"])).toBe("a=b");
  });
});

describe("#ifeq (spec §9.2)", () => {
  it("C-56: numeric comparison when both sides are numeric", () => {
    expect(call("#ifeq", ["01", "1", "eq", "ne"])).toBe("eq");
    expect(call("#ifeq", ["1e3", "1000", "eq", "ne"])).toBe("eq");
    expect(call("#ifeq", ["1.0", "1", "eq", "ne"])).toBe("eq");
  });

  it("C-56: otherwise case-sensitive string comparison", () => {
    expect(call("#ifeq", ["abc", "ABC", "eq", "ne"])).toBe("ne");
    expect(call("#ifeq", ["abc", "abc", "eq", "ne"])).toBe("eq");
    expect(call("#ifeq", ["1a", "1", "eq", "ne"])).toBe("ne");
  });

  it("only the taken branch is expanded", () => {
    const { args, expandedValues } = lazyArgs(["1", "1", "SAME", "DIFF"]);
    expect(evaluateParserFunction("#ifeq", args, makeCtx())).toBe("SAME");
    expect(expandedValues).toEqual(["1", "1", "SAME"]);
  });
});

describe("#switch (spec §9.2)", () => {
  it("C-57: bare cases fall through to the next `=` value", () => {
    expect(call("#switch", ["b", "a", "b", "c = ABC", "other"])).toBe("ABC");
  });

  it("§9.6-3: #default supplies the value when nothing matches", () => {
    expect(call("#switch", ["z", "a = A", "#default = D", "b = B"])).toBe("D");
  });

  it("§9.6-3: comparison is numeric when both sides are numeric", () => {
    expect(call("#switch", ["07", "7 = seven", "no"])).toBe("seven");
  });

  it("seed §2.2 infobox: the S++|S+|S= fallthrough chain", () => {
    const cases = [
      "S++",
      "S+",
      "S=#b3261e",
      "A=#c4690c",
      "B=#8a7a00",
      "C=#2e7d32",
      "D=#1565c0",
      "Safe=#5b6570",
      "#default=#333333",
    ];
    expect(call("#switch", ["S+", ...cases])).toBe("#b3261e");
    expect(call("#switch", ["S++", ...cases])).toBe("#b3261e");
    expect(call("#switch", ["S", ...cases])).toBe("#b3261e");
    expect(call("#switch", ["D", ...cases])).toBe("#1565c0");
    expect(call("#switch", ["Unrated", ...cases])).toBe("#333333");
  });

  it("a trailing bare value acts as a default", () => {
    expect(call("#switch", ["z", "a = A", "fallback"])).toBe("fallback");
  });

  it("#default wins over a trailing bare value", () => {
    expect(call("#switch", ["z", "#default = D", "fallback"])).toBe("D");
  });

  it("the last #default wins", () => {
    expect(call("#switch", ["z", "#default = one", "#default = two"])).toBe("two");
  });

  it("the first match wins and later cases are ignored", () => {
    expect(call("#switch", ["a", "a = first", "a = second"])).toBe("first");
  });

  it("a switch with no cases, and a matched bare case with no value, are empty", () => {
    expect(call("#switch", ["x"])).toBe("");
    expect(call("#switch", [])).toBe("");
    expect(call("#switch", ["b", "a", "b"])).toBe("");
  });

  it("§8.5: only the winning case's value is expanded", () => {
    const { args, expandedValues } = lazyArgs(["b", "a=ONE", "b=TWO", "c=THREE"]);
    expect(evaluateParserFunction("#switch", args, makeCtx())).toBe("TWO");
    expect(expandedValues).toEqual(["b", "b=TWO"]);
  });

  it("values keep their own `=` characters", () => {
    expect(call("#switch", ["a", "a = x=y"])).toBe("x=y");
  });
});

describe("#ifexpr (spec §9.2)", () => {
  it("nonzero takes the then branch", () => {
    expect(call("#ifexpr", ["1 + 1", "yes", "no"])).toBe("yes");
    expect(call("#ifexpr", ["1 - 1", "yes", "no"])).toBe("no");
    expect(call("#ifexpr", ["", "yes", "no"])).toBe("no");
  });

  it("an expression error renders the error message itself", () => {
    expect(call("#ifexpr", ["1/0", "yes", "no"])).toBe(
      '<strong class="error">Expression error: Division by zero.</strong>',
    );
  });
});

describe("#ifexist (spec §9.2, Addendum A4, db-schema A5)", () => {
  it("branches on PageStore existence", () => {
    expect(call("#ifexist", ["Bracken", "yes", "no"])).toBe("yes");
    expect(call("#ifexist", ["Nonexistent page", "yes", "no"])).toBe("no");
    expect(call("#ifexist", ["", "yes", "no"])).toBe("no");
  });

  it("normalizes the title before the lookup (§5.7)", () => {
    expect(call("#ifexist", ["bracken", "yes", "no"])).toBe("yes");
    expect(call("#ifexist", ["Template:1x", "yes", "no"])).toBe("yes");
  });

  it("marks the render volatile", () => {
    const ctx = makeCtx();
    evaluateParserFunction("#ifexist", literalArgs(["Bracken", "y", "n"]), ctx);
    expect(ctx.meta.volatile).toBe(true);
  });

  it("records the target in linksTo (Addendum A4)", () => {
    const ctx = makeCtx();
    evaluateParserFunction("#ifexist", literalArgs(["Missing thing", "y", "n"]), ctx);
    expect(ctx.meta.linksTo).toEqual(["0:Missing_thing"]);
  });

  it("decisions O2: unstorable namespaces never reach linksTo", () => {
    const ctx = makeCtx();
    evaluateParserFunction("#ifexist", literalArgs(["Help:Contents", "y", "n"]), ctx);
    expect(ctx.meta.linksTo).toEqual([]);
  });

  it("Media: consults the file store", () => {
    expect(call("#ifexist", ["Media:X.png", "yes", "no"])).toBe("yes");
    expect(call("#ifexist", ["Media:Nope.png", "yes", "no"])).toBe("no");
  });

  it("counts against maxExpensiveCalls; over the limit takes the else branch", () => {
    const ctx = makeCtx({ config: { maxExpensiveCalls: 2 } });
    const args = literalArgs(["Bracken", "yes", "no"]);
    expect(evaluateParserFunction("#ifexist", args, ctx)).toBe("yes");
    expect(evaluateParserFunction("#ifexist", args, ctx)).toBe("yes");
    expect(evaluateParserFunction("#ifexist", args, ctx)).toBe("no");
    expect(ctx.meta.warnings).toEqual(["expensive-call-limit-exceeded"]);
  });

  it("an empty title costs nothing against the budget", () => {
    const ctx = makeCtx();
    evaluateParserFunction("#ifexist", literalArgs(["", "y", "n"]), ctx);
    expect(ctx.expensive).toBe(0);
  });
});

/* ---------------------------------------------------------------- */
/* §9.3 #expr dispatch                                               */
/* ---------------------------------------------------------------- */

describe("#expr dispatch (spec §9.3)", () => {
  it("C-58: 2^3^2 → 64 and 1/0 → the error strong", () => {
    expect(call("#expr", ["2^3^2"])).toBe("64");
    expect(call("#expr", ["1/0"])).toBe(
      '<strong class="error">Expression error: Division by zero.</strong>',
    );
  });

  it("§9.6-4 renders the whole example line", () => {
    expect(call("#expr", ["2 + 3 * 4"])).toBe("14");
    expect(call("#expr", ["(2+3)*4"])).toBe("20");
    expect(call("#expr", ["7 mod -3"])).toBe("1");
    expect(call("#expr", ["3.14159 round 2"])).toBe("3.14");
  });

  it("an empty expression renders nothing", () => {
    expect(call("#expr", ["  "])).toBe("");
  });
});

/* ---------------------------------------------------------------- */
/* §9.4 string / namespace functions                                 */
/* ---------------------------------------------------------------- */

describe("case functions (spec §9.4)", () => {
  it("lc/uc lowercase and uppercase the trimmed argument", () => {
    expect(call("lc", [" TExT "])).toBe("text");
    expect(call("uc", ["text"])).toBe("TEXT");
  });

  it("C-59: lcfirst/ucfirst touch only the first code point", () => {
    expect(call("ucfirst", ["loot"])).toBe("Loot");
    expect(call("ucfirst", ["foo bar"])).toBe("Foo bar");
    expect(call("lcfirst", ["Foo"])).toBe("foo");
    expect(call("lcfirst", ["FOO"])).toBe("fOO");
  });
});

describe("{{ns:}} (spec §9.4, D-12)", () => {
  it("C-59: numbers and names both resolve to the canonical name", () => {
    expect(call("ns", ["14"])).toBe("Category");
    expect(call("ns", ["10"])).toBe("Template");
    expect(call("ns", ["template"])).toBe("Template");
    expect(call("ns", ["help_talk"])).toBe("Help talk");
    expect(call("ns", ["image"])).toBe("File");
  });

  it("ns:0 and unknown values are the empty string", () => {
    expect(call("ns", ["0"])).toBe("");
    expect(call("ns", ["99"])).toBe("");
    expect(call("ns", ["bogus"])).toBe("");
    expect(call("ns", [""])).toBe("");
  });

  it("nse href-encodes what ns returns", () => {
    expect(call("nse", ["13"])).toBe("Help_talk");
  });
});

describe("urlencode / anchorencode (spec §9.4)", () => {
  it("defaults to query style", () => {
    expect(call("urlencode", ["a b&c"])).toBe("a+b%26c");
  });

  it("PATH uses %20 and WIKI uses underscores", () => {
    expect(call("urlencode", ["a b&c", "PATH"])).toBe("a%20b%26c");
    expect(call("urlencode", ["a b&c", "WIKI"])).toBe("a_b%26c");
  });

  it("anchorencode follows §2.4 (Unicode kept, spaces to underscores)", () => {
    expect(call("anchorencode", ["My § Heading"])).toBe("My_§_Heading");
    expect(call("anchorencode", ["  spaced   out  "])).toBe("spaced_out");
    expect(call("anchorencode", ["개요"])).toBe("개요");
    expect(call("anchorencode", ["<b>Bold</b> title"])).toBe("Bold_title");
  });
});

describe("formatnum / padleft / padright (spec §9.4)", () => {
  it("formatnum groups with commas and |R strips them", () => {
    expect(call("formatnum", ["1234567.8"])).toBe("1,234,567.8");
    expect(call("formatnum", ["-1000"])).toBe("-1,000");
    expect(call("formatnum", ["999"])).toBe("999");
    expect(call("formatnum", ["1,234,567.8", "R"])).toBe("1234567.8");
    expect(call("formatnum", ["not a number"])).toBe("not a number");
  });

  it("padleft/padright pad to length with a repeating pad string", () => {
    expect(call("padleft", ["7", "3", "0"])).toBe("007");
    expect(call("padleft", ["7", "3"])).toBe("007");
    expect(call("padright", ["7", "3", "x"])).toBe("7xx");
    expect(call("padleft", ["xyz", "5", "_"])).toBe("__xyz");
    expect(call("padleft", ["7", "3", "ab"])).toBe("ab7");
  });

  it("values already at or over the length are returned unchanged", () => {
    expect(call("padleft", ["12345", "3", "0"])).toBe("12345");
    expect(call("padleft", ["7", "3", ""])).toBe("7");
  });
});

describe("#titleparts (spec §9.4)", () => {
  it("reproduces the §9.4 table", () => {
    expect(call("#titleparts", ["A/B/C", "2", "2"])).toBe("B/C");
    expect(call("#titleparts", ["A/B/C", "1"])).toBe("A");
    expect(call("#titleparts", ["A/B/C", "", "2"])).toBe("B/C");
  });

  it("a negative first-segment counts from the end", () => {
    expect(call("#titleparts", ["A/B/C", "1", "-1"])).toBe("C");
    expect(call("#titleparts", ["A/B/C", "", "-2"])).toBe("B/C");
  });

  it("no count returns every segment and normalizes the title (§5.7)", () => {
    expect(call("#titleparts", ["A/B/C"])).toBe("A/B/C");
    expect(call("#titleparts", ["a/b"])).toBe("A/b");
    expect(call("#titleparts", ["template:a/b"])).toBe("Template:A/b");
    expect(call("#titleparts", ["template:a/b", "1"])).toBe("Template:A");
  });

  it("caps the split at 25 segments", () => {
    const long = Array.from({ length: 30 }, (_, i) => `s${i}`).join("/");
    expect(call("#titleparts", [long, "1", "25"])).toBe(
      Array.from({ length: 6 }, (_, i) => `s${i + 24}`).join("/"),
    );
  });
});

/* ---------------------------------------------------------------- */
/* Version functions (versioning.md §2.3, §2.4)                      */
/* ---------------------------------------------------------------- */

describe("#ifversion (versioning.md §2.3)", () => {
  it("evaluates every range form against the selection", () => {
    expect(call("#ifversion", ["v62", "y", "n"], makeCtx({ version: "v62" }))).toBe("y");
    expect(call("#ifversion", ["v62", "y", "n"], makeCtx({ version: "v50" }))).toBe("n");
    expect(call("#ifversion", [">=v62", "y", "n"], makeCtx({ version: "v70" }))).toBe("y");
    expect(call("#ifversion", ["v50-v55", "y", "n"], makeCtx({ version: "v55" }))).toBe("y");
    expect(call("#ifversion", ["v45,>=v62", "y", "n"], makeCtx({ version: "v45" }))).toBe(
      "y",
    );
    expect(call("#ifversion", ["*", "y", "n"], makeCtx({ version: "v45" }))).toBe("y");
  });

  it("records boundaries before selecting and marks the page version-scoped", () => {
    const ctx = makeCtx({ version: "v50" });
    expect(
      evaluateParserFunction("#ifversion", literalArgs([">=v62", "new", "old"]), ctx),
    ).toBe("old");
    expect(ctx.meta.versionBoundaries).toEqual(["v62"]);
    expect(ctx.meta.versionScoped).toBe(true);
  });

  it("keeps #if-style laziness", () => {
    const { args, expandedValues } = lazyArgs([">=v62", "NEW", "OLD"]);
    expect(evaluateParserFunction("#ifversion", args, makeCtx({ version: "v50" }))).toBe(
      "OLD",
    );
    expect(expandedValues).toEqual([">=v62", "OLD"]);
  });
});

describe("#vswitch (versioning.md §2.4)", () => {
  it("picks the greatest boundary at or below the selection", () => {
    const pairs = ["v50=1400", "v62=1500"];
    expect(call("#vswitch", pairs, makeCtx({ version: "v50" }))).toBe("1400");
    expect(call("#vswitch", pairs, makeCtx({ version: "v55" }))).toBe("1400");
    expect(call("#vswitch", pairs, makeCtx({ version: "v62" }))).toBe("1500");
    expect(call("#vswitch", pairs, makeCtx({ version: "v70" }))).toBe("1500");
  });

  it("falls back to `default` below every boundary, else to nothing", () => {
    expect(call("#vswitch", ["v50=1400", "default=?"], makeCtx({ version: "v45" }))).toBe(
      "?",
    );
    expect(call("#vswitch", ["v50=1400", "v62=1500"], makeCtx({ version: "v45" }))).toBe("");
    expect(call("#vswitch", [], makeCtx({ version: "v50" }))).toBe("");
  });

  it("records every boundary even when the selection hides it", () => {
    const ctx = makeCtx({ version: "v50" });
    evaluateParserFunction("#vswitch", literalArgs(["v50=1400", "v62=1500"]), ctx);
    expect(ctx.meta.versionBoundaries).toEqual(["v50", "v62"]);
    expect(ctx.meta.versionScoped).toBe(true);
  });

  it("expands only the winning value", () => {
    const { args, expandedValues } = lazyArgs(["v50=OLD", "v62=NEW"]);
    expect(evaluateParserFunction("#vswitch", args, makeCtx({ version: "v70" }))).toBe(
      "NEW",
    );
    expect(expandedValues).toEqual(["v62=NEW"]);
  });
});

/* ---------------------------------------------------------------- */
/* §13.1 DISPLAYTITLE + dispatcher surface                           */
/* ---------------------------------------------------------------- */

describe("DISPLAYTITLE (spec §13.1)", () => {
  it("applies formatting that leaves the text content intact", () => {
    const ctx = makeCtx();
    expect(evaluateParserFunction("DISPLAYTITLE", literalArgs(["<i>Titan</i>"]), ctx)).toBe(
      "",
    );
    expect(ctx.meta.displayTitle).toBe("<i>Titan</i>");
    expect(ctx.meta.warnings).toEqual([]);
  });

  it("permits a first-letter case change (the iPhone rule)", () => {
    const ctx = makeCtx({ page: { namespace: 0, pageName: "IPhone" } });
    evaluateParserFunction("DISPLAYTITLE", literalArgs(["iPhone"]), ctx);
    expect(ctx.meta.displayTitle).toBe("iPhone");
  });

  it("rejects a rename and records a warning instead", () => {
    const ctx = makeCtx();
    expect(
      evaluateParserFunction("DISPLAYTITLE", literalArgs(["Something else"]), ctx),
    ).toBe("");
    expect(ctx.meta.displayTitle).toBeUndefined();
    expect(ctx.meta.warnings).toEqual(["displaytitle-restricted: Something else"]);
  });

  it("strips tags outside the inline allowlist to their text", () => {
    const ctx = makeCtx();
    evaluateParserFunction("DISPLAYTITLE", literalArgs(["<div>Titan</div>"]), ctx);
    expect(ctx.meta.displayTitle).toBe("Titan");
  });

  it("drops attributes from the tags it keeps", () => {
    const ctx = makeCtx();
    evaluateParserFunction(
      "DISPLAYTITLE",
      literalArgs(['<b class="x" onclick="y()">Titan</b>']),
      ctx,
    );
    expect(ctx.meta.displayTitle).toBe("<b>Titan</b>");
  });

  it("rejects markup that changes the text content", () => {
    const ctx = makeCtx();
    evaluateParserFunction("DISPLAYTITLE", literalArgs(["<script>x()</script>Titan"]), ctx);
    expect(ctx.meta.displayTitle).toBeUndefined();
    expect(ctx.meta.warnings).toEqual(["displaytitle-restricted: x()Titan"]);
  });

  it("accepts the namespace-prefixed form of the title", () => {
    const ctx = makeCtx({ page: { namespace: 10, pageName: "Infobox moon" } });
    evaluateParserFunction("DISPLAYTITLE", literalArgs(["Template:Infobox moon"]), ctx);
    expect(ctx.meta.displayTitle).toBe("Template:Infobox moon");
  });

  it("is reachable under either casing of the name", () => {
    const ctx = makeCtx();
    evaluateParserFunction("displaytitle", literalArgs(["<i>Titan</i>"]), ctx);
    expect(ctx.meta.displayTitle).toBe("<i>Titan</i>");
  });
});

describe("dispatcher surface (spec §9.1)", () => {
  it("D-11: an unknown #function renders the standard error span", () => {
    expect(call("#nope", ["x"])).toBe(
      '<span class="error">Unknown parser function: #nope</span>',
    );
  });

  it("a non-#, non-registered name returns null so templates resolve", () => {
    expect(call("Infobox moon", ["x"])).toBeNull();
    expect(call("Bracken", [])).toBeNull();
  });

  it("#… and colon-function names are matched case-insensitively", () => {
    expect(call("#IF", ["x", "y", "n"])).toBe("y");
    expect(call("LC", ["ABC"])).toBe("abc");
    expect(isParserFunction("#Switch")).toBe(true);
    expect(isParserFunction("urlencode")).toBe(true);
    expect(isParserFunction("Infobox")).toBe(false);
  });

  it("literalArgs mirrors stage 2: every argument splits on its first `=`", () => {
    const [bare, named] = literalArgs(["plain", "a=b=c"]);
    expect(bare.name).toBeNull();
    expect(bare.value()).toBe("plain");
    expect(named.name).toBe("a");
    expect(named.value()).toBe("b=c");
  });

  it("exposes an ExpandHooks bundle for stage-2 registration", () => {
    expect(parserFunctionHooks.evaluateParserFunction).toBe(evaluateParserFunction);
    expect(parserFunctionHooks.isParserFunction).toBe(isParserFunction);
    expect(typeof parserFunctionHooks.evaluateMagicWord).toBe("function");
  });
});
