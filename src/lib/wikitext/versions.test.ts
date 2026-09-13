import { describe, expect, it } from "vitest";

import {
  compareVersions,
  deriveOrdinal,
  evaluateIfVersion,
  evaluateVersionMagicWord,
  isVersionTag,
  ordinalOf,
  parseRange,
  parseVersionTagName,
  resolveVersionTag,
  selectedVersionId,
  vswitchPick,
} from "./versions";
import type { PageMeta, ParseContext, VersionTable } from "./types";

/* ---------------------------------------------------------------- */
/* Fixtures                                                          */
/* ---------------------------------------------------------------- */

const IDS: [string, number][] = [
  ["v45", 45000],
  ["v50", 50000],
  ["v55", 55000],
  ["v56", 56000],
  ["v60", 60000],
  ["v62", 62000],
  ["v64", 64000],
  ["v64.1", 64001],
  ["v70", 70000],
];

function makeTable(defaultId = "v70"): VersionTable {
  const ordered = IDS.map(([id, ordinal]) => ({
    id,
    label: id,
    ordinal,
    status: (id === defaultId ? "current" : "legacy") as "current" | "legacy",
  }));
  return {
    byId: Object.fromEntries(ordered.map((e) => [e.id, e])),
    ordered,
    defaultId,
  };
}

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
  } as PageMeta;
}

function ctxAt(version: string | null, defaultId = "v70"): ParseContext {
  return {
    version,
    versions: makeTable(defaultId),
  } as unknown as ParseContext;
}

/* ---------------------------------------------------------------- */

describe("ordinals", () => {
  it("derives major*1000+minor", () => {
    expect(deriveOrdinal("v62")).toBe(62000);
    expect(deriveOrdinal("v64.1")).toBe(64001);
    expect(deriveOrdinal("nope")).toBeNull();
  });

  it("prefers the registry over the derived value", () => {
    const table = makeTable();
    expect(ordinalOf("v62", table)).toBe(62000);
    expect(ordinalOf("V62", table)).toBe(62000);
    expect(ordinalOf("v999", table)).toBe(999000); // derived fallback
    expect(ordinalOf("garbage", table)).toBeNull();
  });

  it("sorts ascending with unknown ids last", () => {
    const table = makeTable();
    expect(compareVersions("v50", "v62", table)).toBeLessThan(0);
    expect(compareVersions("v64.1", "v64", table)).toBeGreaterThan(0);
    expect(compareVersions("garbage", "v50", table)).toBeGreaterThan(0);
  });

  it("falls back to the site default when no version is selected", () => {
    expect(selectedVersionId(ctxAt(null))).toBe("v70");
    expect(selectedVersionId(ctxAt("v50"))).toBe("v50");
  });
});

describe("parseRange", () => {
  it("parses every documented form", () => {
    expect(parseRange("*").clauses).toEqual([{ kind: "any" }]);
    expect(parseRange("v62").clauses).toEqual([{ kind: "exact", id: "v62" }]);
    expect(parseRange("v50-v61").clauses).toEqual([
      { kind: "between", from: "v50", to: "v61" },
    ]);
    expect(parseRange(">=v62").clauses).toEqual([{ kind: "cmp", op: ">=", id: "v62" }]);
    expect(parseRange("< v62").clauses).toEqual([{ kind: "cmp", op: "<", id: "v62" }]);
    expect(parseRange("v50,v55,>=v62").clauses).toHaveLength(3);
  });

  it("collects every named id", () => {
    expect(parseRange("v50-v61, >=v64").ids).toEqual(["v50", "v61", "v64"]);
  });
});

describe("#ifversion", () => {
  const at = (version: string, expr: string) => {
    const meta = makeMeta();
    const result = evaluateIfVersion(expr, ctxAt(version), meta);
    return { result, meta };
  };

  it("matches exact ids", () => {
    expect(at("v62", "v62").result).toBe(true);
    expect(at("v60", "v62").result).toBe(false);
  });

  it("matches inclusive ranges", () => {
    expect(at("v50", "v50-v60").result).toBe(true);
    expect(at("v60", "v50-v60").result).toBe(true);
    expect(at("v62", "v50-v60").result).toBe(false);
  });

  it("matches comparisons", () => {
    expect(at("v62", ">=v62").result).toBe(true);
    expect(at("v62", ">v62").result).toBe(false);
    expect(at("v55", "<v62").result).toBe(true);
    expect(at("v62", "<=v62").result).toBe(true);
  });

  it("ORs comma-separated parts", () => {
    expect(at("v55", "v50,v55,>=v64").result).toBe(true);
    expect(at("v62", "v50,v55,>=v64").result).toBe(false);
    expect(at("v70", "v50,v55,>=v64").result).toBe(true);
  });

  it("* always matches", () => {
    expect(at("v45", "*").result).toBe(true);
  });

  it("records boundaries and warns on unknown ids", () => {
    const { result, meta } = at("v62", "garbage");
    expect(result).toBe(false);
    expect(meta.warnings).toContain("unknown-version: garbage");
    expect(meta.versionScoped).toBe(true);
    expect(meta.versionBoundaries).toEqual(["garbage"]);
  });
});

describe("version tag names (versioning.md §2.1)", () => {
  it("reads the three forms", () => {
    expect(parseVersionTagName("v70")).toEqual({ from: "v70", to: "v70", ids: ["v70"] });
    expect(parseVersionTagName("v70+v80")).toEqual({
      from: "v70",
      to: "v80",
      ids: ["v70", "v80"],
    });
    expect(parseVersionTagName("v70+")).toEqual({ from: "v70", to: null, ids: ["v70"] });
  });

  it("reads minor-version ids at either end", () => {
    expect(parseVersionTagName("v64.1")).toEqual({
      from: "v64.1",
      to: "v64.1",
      ids: ["v64.1"],
    });
    expect(parseVersionTagName("v64.1+v70")?.ids).toEqual(["v64.1", "v70"]);
    expect(parseVersionTagName("v64.1+")).toEqual({
      from: "v64.1",
      to: null,
      ids: ["v64.1"],
    });
  });

  it("is case-insensitive, like every other tag name (§10)", () => {
    expect(parseVersionTagName("V70+V80")).toEqual({
      from: "V70",
      to: "V80",
      ids: ["V70", "V80"],
    });
  });

  it("anchors on the WHOLE name, so ordinary tags are never swallowed", () => {
    for (const name of [
      "var",
      "video",
      "v",
      "v70x",
      "xv70",
      "v70v80", // a window needs the `+`
      "v70+v80+",
      "+v70",
      "v70.",
      "v.1",
      "version",
      "versions",
      "variant",
    ]) {
      expect(parseVersionTagName(name)).toBeNull();
      expect(isVersionTag(name)).toBe(false);
    }
  });

  it("isVersionTag agrees with the parser", () => {
    expect(isVersionTag("v70")).toBe(true);
    expect(isVersionTag("v70+v80")).toBe(true);
    expect(isVersionTag("v64.1+")).toBe(true);
  });
});

describe("version tag resolution (versioning.md §2.1)", () => {
  const resolve = (version: string, name: string, inner = "X") => {
    const tag = parseVersionTagName(name);
    if (tag === null) throw new Error(`not a version tag: ${name}`);
    const meta = makeMeta();
    const out = resolveVersionTag(tag, inner, ctxAt(version), meta);
    return { out, meta };
  };

  it("<v70> applies to that version and nothing else", () => {
    expect(resolve("v62", "v62").out).toBe("X");
    expect(resolve("v60", "v62").out).toBe("");
    expect(resolve("v64", "v62").out).toBe("");
  });

  it("<v50+v60> includes both ends", () => {
    expect(resolve("v50", "v50+v60").out).toBe("X");
    expect(resolve("v55", "v50+v60").out).toBe("X");
    expect(resolve("v60", "v50+v60").out).toBe("X");
    expect(resolve("v45", "v50+v60").out).toBe("");
    expect(resolve("v62", "v50+v60").out).toBe("");
  });

  it("<v62+> runs to every later version", () => {
    expect(resolve("v62", "v62+").out).toBe("X");
    expect(resolve("v70", "v62+").out).toBe("X");
    expect(resolve("v60", "v62+").out).toBe("");
  });

  it("orders minor versions by ordinal, not by string", () => {
    expect(resolve("v64.1", "v64+v70").out).toBe("X");
    expect(resolve("v64", "v64.1+").out).toBe("");
    expect(resolve("v64.1", "v64.1").out).toBe("X");
    expect(resolve("v64", "v64.1").out).toBe("");
  });

  it("renders nothing for an inverted window rather than guessing", () => {
    expect(resolve("v70", "v80+v70").out).toBe("");
    expect(resolve("v80", "v80+v70").out).toBe("");
    expect(resolve("v75", "v80+v70").out).toBe("");
  });

  it("keeps the body verbatim — it is wikitext for the caller to expand", () => {
    expect(resolve("v55", "v50+", "\n* one\n* two\n").out).toBe("\n* one\n* two\n");
  });

  it("resolves a null selection as the site default (versioning.md §5)", () => {
    const tag = parseVersionTagName("v70");
    if (tag === null) throw new Error("unreachable");
    expect(resolveVersionTag(tag, "X", ctxAt(null), makeMeta())).toBe("X");
  });

  it("orders an unregistered id by its derived ordinal, with no warning", () => {
    // versions.ts derives `v<major>[.<minor>]` ordinals, so a tag naming a
    // release nobody has registered yet still windows sanely (§2.6).
    const { out, meta } = resolve("v62", "v99+");
    expect(out).toBe("");
    expect(resolve("v99", "v99+").out).toBe("X");
    expect(meta.warnings).toEqual([]);
    // …and the id is still offered to the selector, so somebody can see that
    // nobody registered it (versioning.md §6).
    expect(meta.versionBoundaries).toEqual(["v99"]);
  });

  describe("boundary recording happens BEFORE the branch is chosen (§3)", () => {
    it("records the one id of <v70>", () => {
      const { meta } = resolve("v45", "v70");
      expect(meta.versionBoundaries).toEqual(["v70"]);
      expect(meta.versionScoped).toBe(true);
    });

    it("records both ends of <v70+v80>", () => {
      const { meta } = resolve("v45", "v70+v80");
      expect(meta.versionBoundaries).toEqual(["v70", "v80"]);
      expect(meta.versionScoped).toBe(true);
    });

    it("records the open end of <v70+>", () => {
      const { meta } = resolve("v45", "v70+");
      expect(meta.versionBoundaries).toEqual(["v70"]);
      expect(meta.versionScoped).toBe(true);
    });

    it("records an inverted window too — the ids were still written", () => {
      const { meta } = resolve("v70", "v80+v70");
      expect(meta.versionBoundaries).toEqual(["v80", "v70"]);
    });
  });
});

describe("#vswitch", () => {
  const pick = (version: string, pairs: { key: string; value: string }[]) => {
    const meta = makeMeta();
    const out = vswitchPick(pairs, ctxAt(version), meta);
    return { out, meta };
  };

  const PAIRS = [
    { key: "v50", value: "1400" },
    { key: "v62", value: "1500" },
  ];

  it("picks the greatest boundary at or below the selection", () => {
    expect(pick("v50", PAIRS).out).toBe("1400");
    expect(pick("v60", PAIRS).out).toBe("1400");
    expect(pick("v62", PAIRS).out).toBe("1500");
    expect(pick("v70", PAIRS).out).toBe("1500");
  });

  it("uses default below every boundary", () => {
    expect(pick("v45", [...PAIRS, { key: "default", value: "?" }]).out).toBe("?");
    expect(pick("v45", PAIRS).out).toBe("");
  });

  it("ignores unknown keys but records the warning", () => {
    const { out, meta } = pick("v70", [...PAIRS, { key: "garbage", value: "x" }]);
    expect(out).toBe("1500");
    expect(meta.warnings).toContain("unknown-version: garbage");
  });

  it("records boundaries", () => {
    expect(pick("v70", PAIRS).meta.versionBoundaries).toEqual(["v50", "v62"]);
  });

  it("orders by ordinal, not source order", () => {
    const reversed = [...PAIRS].reverse();
    expect(pick("v55", reversed).out).toBe("1400");
  });
});

describe("version magic words", () => {
  it("resolves the documented set", () => {
    const ctx = ctxAt("v62");
    expect(evaluateVersionMagicWord("VERSION", ctx)).toBe("v62");
    expect(evaluateVersionMagicWord("VERSIONLABEL", ctx)).toBe("v62");
    expect(evaluateVersionMagicWord("VERSIONORDINAL", ctx)).toBe("62000");
    expect(evaluateVersionMagicWord("LATESTVERSION", ctx)).toBe("v70");
    expect(evaluateVersionMagicWord("ISLATESTVERSION", ctx)).toBe("");
    expect(evaluateVersionMagicWord("ISLATESTVERSION", ctxAt("v70"))).toBe("1");
  });

  it("returns null for unrelated names", () => {
    expect(evaluateVersionMagicWord("PAGENAME", ctxAt("v62"))).toBeNull();
  });
});
