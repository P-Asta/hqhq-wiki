/**
 * The selector model — docs/engine/versioning.md §6.
 *
 * The case that matters most is §6's first rule: a page branching at v56 and
 * v73, read at the site default v70, is showing the **v56** branch. Every
 * assertion about `active` below is really about that: a reader must be able to
 * tell which branch is on screen, and an equality test cannot tell them.
 */

import { describe, expect, it } from "vitest";

import { deriveOrdinal, isVersionTag, parseVersionTagName } from "@/lib/wikitext/versions";
import {
  branchEnd,
  deriveVersionOrdinal,
  governingBoundary,
  isVersionTagName,
  pageVersionBranches,
  readVersionTagName,
  sortBoundaries,
  versionOrdinal,
  versionTagCovers,
  versionTagName,
  type VersionRegistryEntry,
} from "./version-branches";

/** The seeded registry (versioning.md §1), shaped as either surface has it. */
const REGISTRY: VersionRegistryEntry[] = [
  "v45", "v47", "v49", "v50", "v55", "v56", "v60",
  "v62", "v64", "v66", "v68", "v69", "v70",
].map((id) => ({ id, label: id, ordinal: deriveVersionOrdinal(id) ?? 0 }));

const WITH_73: VersionRegistryEntry[] = [...REGISTRY, { id: "v73", label: "v73", ordinal: 73000 }];

describe("deriveVersionOrdinal", () => {
  it("agrees with the engine's rule", () => {
    // Copied rather than imported (the engine is server-side); this is the
    // guard that keeps the copy honest.
    for (const id of ["v45", "v62", "v64.1", "v70", "v100.25", "nope", "62", "v"]) {
      expect(deriveVersionOrdinal(id)).toBe(deriveOrdinal(id));
    }
  });

  it("refuses an ordinal that is not a usable sort key", () => {
    // `v` + 400 digits is still /^v\d+$/, and its ordinal is Infinity — a key
    // that outranks every real version.
    expect(deriveVersionOrdinal(`v${"9".repeat(400)}`)).toBeNull();
  });
});

describe("versionOrdinal", () => {
  it("prefers the registry's own sort key over the derived one", () => {
    // versioning.md §1: all range math runs on `ordinal`, and an admin may set
    // one that the id does not imply. The registry has to win, or a re-ordered
    // registry would silently disagree with the selector.
    const registry: VersionRegistryEntry[] = [{ id: "v64", label: "v64 Patch 1", ordinal: 99 }];
    expect(versionOrdinal("v64", registry)).toBe(99);
    expect(versionOrdinal("V64", registry)).toBe(99);
  });

  it("falls back to the derived ordinal for an id the registry lacks", () => {
    expect(versionOrdinal("v73", REGISTRY)).toBe(73000);
    expect(versionOrdinal("beta", REGISTRY)).toBeNull();
  });
});

describe("sortBoundaries", () => {
  it("dedupes case-insensitively, drops the fallback marker, and sorts by ordinal", () => {
    expect(sortBoundaries(["v73", "v56", "V56", "*", "  ", "v62"], WITH_73)).toEqual([
      "v56",
      "v62",
      "v73",
    ]);
  });

  it("keeps an unorderable id rather than dropping it — the page names it", () => {
    expect(sortBoundaries(["v62", "beta"], REGISTRY)).toEqual(["v62", "beta"]);
  });

  it("orders a version the registry does not know by its derived ordinal", () => {
    expect(sortBoundaries(["v73", "v56"], REGISTRY)).toEqual(["v56", "v73"]);
  });
});

describe("governingBoundary", () => {
  const boundaries = ["v56", "v73"];

  it("is the greatest boundary at or below the selection", () => {
    expect(governingBoundary(boundaries, WITH_73, "v70")).toBe("v56");
    expect(governingBoundary(boundaries, WITH_73, "v56")).toBe("v56");
    expect(governingBoundary(boundaries, WITH_73, "v73")).toBe("v73");
  });

  it("is null below every boundary — the page's `*` fallback territory", () => {
    expect(governingBoundary(boundaries, WITH_73, "v50")).toBeNull();
  });

  it("is null when the selection cannot be ordered", () => {
    expect(governingBoundary(boundaries, WITH_73, "nonsense")).toBeNull();
  });
});

describe("pageVersionBranches", () => {
  it("marks the branch that governs the selection, not one equal to it", () => {
    // The whole point: reading a [v56, v73] page at the default v70.
    const branches = pageVersionBranches({
      boundaries: ["v56", "v73"],
      registry: WITH_73,
      selected: "v70",
    });
    expect(branches.map((b) => [b.id, b.active])).toEqual([
      ["v56", true],
      ["v73", false],
    ]);
  });

  it("ends a branch at the newest registered version below the next boundary", () => {
    const branches = pageVersionBranches({
      boundaries: ["v56", "v73"],
      registry: WITH_73,
      selected: "v73",
    });
    // v70 is the newest registered version below v73 — never "v72", which
    // nobody can be running.
    expect(branches[0]).toMatchObject({ id: "v56", until: "v70", openEnded: false });
    expect(branches[1]).toMatchObject({ id: "v73", until: "v73", openEnded: true, active: true });
  });

  it("covers only its own version when the registry has nothing in between", () => {
    const branches = pageVersionBranches({
      boundaries: ["v68", "v69"],
      registry: REGISTRY,
      selected: "v70",
    });
    expect(branches[0]).toMatchObject({ id: "v68", until: "v68" });
    expect(branches[1]).toMatchObject({ id: "v69", until: "v70", active: true });
  });

  it("shows an unregistered boundary and says so", () => {
    const branches = pageVersionBranches({
      boundaries: ["v62", "v73"],
      registry: REGISTRY,
      selected: "v70",
    });
    expect(branches.map((b) => [b.id, b.unregistered])).toEqual([
      ["v62", false],
      ["v73", true],
    ]);
    // v73 is not in the registry, so its span has no registered end to name.
    expect(branches[1]).toMatchObject({ until: null, untilLabel: null, openEnded: true });
  });

  it("activates nothing when the selection sits below every boundary", () => {
    const branches = pageVersionBranches({
      boundaries: ["v62", "v70"],
      registry: REGISTRY,
      selected: "v50",
    });
    expect(branches.every((b) => !b.active)).toBe(true);
  });

  it("prefers the registry's label over the raw id", () => {
    const branches = pageVersionBranches({
      boundaries: ["v64"],
      registry: [{ id: "v64", label: "v64 Patch 1", ordinal: 64000 }],
      selected: "v64",
    });
    expect(branches[0]).toMatchObject({ label: "v64 Patch 1", active: true, openEnded: true });
  });

  it("is empty for a page that branches on nothing", () => {
    expect(pageVersionBranches({ boundaries: [], registry: REGISTRY, selected: "v70" })).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* The tag-name grammar (versioning.md §2.1)                           */
/* ------------------------------------------------------------------ */

describe("readVersionTagName", () => {
  it("reads the three shapes a name can have", () => {
    expect(readVersionTagName("v70")).toEqual({ from: "v70", to: "v70" });
    expect(readVersionTagName("v70+v80")).toEqual({ from: "v70", to: "v80" });
    expect(readVersionTagName("v70+")).toEqual({ from: "v70", to: null });
  });

  it("reads a minor version at either end", () => {
    expect(readVersionTagName("v64.1")).toEqual({ from: "v64.1", to: "v64.1" });
    expect(readVersionTagName("v64.1+v70.2")).toEqual({ from: "v64.1", to: "v70.2" });
    expect(readVersionTagName("v64.1+")).toEqual({ from: "v64.1", to: null });
  });

  it("reads a name however it is cased or padded, as tag names compare", () => {
    expect(readVersionTagName(" V70+V80 ")).toEqual({ from: "V70", to: "V80" });
  });

  it("is anchored on the WHOLE name, which is the safety of the grammar", () => {
    // Ordinary elements whose names begin with `v`, and near-misses that would
    // silently become version markup if the pattern were unanchored.
    for (const name of [
      "var",
      "video",
      "v",
      "v70x",
      "xv70",
      "v70v80",
      "v70+v80+",
      "v70++",
      "v70.",
      "v.1",
      "version",
      "versions",
      "variant",
      "",
    ]) {
      expect(readVersionTagName(name)).toBeNull();
      expect(isVersionTagName(name)).toBe(false);
    }
  });
});

describe("versionTagName", () => {
  it("spells each shape the way the grammar writes it", () => {
    expect(versionTagName({ from: "v70", to: "v70" })).toBe("v70");
    expect(versionTagName({ from: "v70", to: "v80" })).toBe("v70+v80");
    expect(versionTagName({ from: "v70", to: null })).toBe("v70+");
  });

  it("folds the ids, which is the spelling the registry keeps", () => {
    // `version_boundaries` has to line up with `versions.id` however the author
    // typed it, and the engine compares tag names case-insensitively anyway.
    expect(versionTagName({ from: " V70 ", to: " V80 " })).toBe("v70+v80");
  });

  it("writes a window on itself as the single-version form, which is what it is", () => {
    expect(versionTagName({ from: "v70", to: "v70" })).toBe("v70");
    expect(versionTagName({ from: "V70", to: "v70" })).toBe("v70");
  });

  it("does not reorder an inverted window", () => {
    // §2.1: it holds for nothing and renders nothing rather than being swapped.
    // Swapping it here would put one version's text under another version's id.
    expect(versionTagName({ from: "v80", to: "v70" })).toBe("v80+v70");
  });

  it("round-trips every name it writes", () => {
    // What every surface depends on: a range spelled into a name and read back
    // out of it is the same range, so the dialog, the field and the strip all
    // agree about which versions a tag they each touched covers.
    const ranges: { from: string; to: string | null }[] = [
      { from: "v70", to: "v70" },
      { from: "v50", to: "v61" },
      { from: "v62", to: null },
      { from: "v64.1", to: null },
    ];
    for (const range of ranges) {
      expect(readVersionTagName(versionTagName(range))).toEqual(range);
    }
  });
});

describe("the editor's copy of the grammar does not drift from the engine's", () => {
  it("agrees with parseVersionTagName on every name, accepted or refused", () => {
    // The editor may not import the engine (this module's header says why), so
    // the pattern is written twice. This is the test that keeps the second copy
    // honest: one disagreement means an editor surface reading a range the
    // renderer does not, which is how a version's text ends up under another
    // version's id.
    const names = [
      "v70",
      "v70+",
      "v70+v80",
      "v64.1",
      "v64.1+v70",
      "V70+V80",
      "v9",
      "v70+v70",
      "v80+v70",
      "var",
      "video",
      "v70x",
      "v70v80",
      "v70+v80+",
      "version",
      "versions",
      "variant",
      "ref",
      "",
    ];
    for (const name of names) {
      const engine = parseVersionTagName(name);
      const editor = readVersionTagName(name);
      expect(isVersionTagName(name)).toBe(isVersionTag(name));
      if (engine === null) {
        expect(editor).toBeNull();
        continue;
      }
      expect(editor).toEqual({ from: engine.from, to: engine.to });
    }
  });
});

describe("versionTagCovers", () => {
  it("holds inside a window and at both of its ends", () => {
    const range = { from: "v56", to: "v70" };
    for (const id of ["v56", "v62", "v70"]) {
      expect(versionTagCovers(range, id, REGISTRY)).toBe(true);
    }
    for (const id of ["v55", "v73"]) {
      expect(versionTagCovers(range, id, WITH_73)).toBe(false);
    }
  });

  it("holds for one version alone in the single-version form", () => {
    expect(versionTagCovers({ from: "v62", to: "v62" }, "v62", REGISTRY)).toBe(true);
    expect(versionTagCovers({ from: "v62", to: "v62" }, "v64", REGISTRY)).toBe(false);
  });

  it("runs forever with no far end", () => {
    expect(versionTagCovers({ from: "v62", to: null }, "v99", REGISTRY)).toBe(true);
    expect(versionTagCovers({ from: "v62", to: null }, "v60", REGISTRY)).toBe(false);
  });

  it("holds for nothing when the ends are inverted", () => {
    // The same rule the engine applies: `selected >= from && selected <= to` is
    // unsatisfiable, and nobody swaps the ends on the author's behalf.
    for (const id of ["v56", "v62", "v70"]) {
      expect(versionTagCovers({ from: "v70", to: "v56" }, id, REGISTRY)).toBe(false);
    }
  });

  it("works with no registry at all, on derived ordinals", () => {
    // Which is how the editor asks it: this is arithmetic about one tag, and
    // an id nobody registered still orders where registering it would put it.
    expect(versionTagCovers({ from: "v56", to: "v70" }, "v62")).toBe(true);
    expect(versionTagCovers({ from: "v56", to: "v70" }, "v99")).toBe(false);
  });

  it("treats an end nothing can order as no end at all", () => {
    // Hiding the passage would be inventing a fact the engine does not have:
    // the tag still writes for the version it names (§2.6).
    expect(versionTagCovers({ from: "v56", to: "beta" }, "v99", REGISTRY)).toBe(true);
    // A lower bound nothing can order is a different matter: there is no
    // version it can be said to start at.
    expect(versionTagCovers({ from: "beta", to: null }, "v62", REGISTRY)).toBe(false);
    expect(versionTagCovers({ from: "v56", to: null }, "beta", REGISTRY)).toBe(false);
  });
});

describe("branchEnd", () => {
  it("ends a branch on the newest REGISTERED id below the next one", () => {
    // Never arithmetic: "one below v62" is a number, and the number may name a
    // version that was never released. With v60 and v62 registered and nothing
    // between, a branch starting at v56 ends at v60.
    expect(branchEnd("v56", "v62", REGISTRY)).toBe("v60");
    expect(branchEnd("v45", "v56", REGISTRY)).toBe("v55");
  });

  it("ends a branch on its own version when the registry knows nothing between", () => {
    // The floor is what keeps the answer a window rather than an inversion —
    // `<v70+v70>`, which `versionTagName` writes `<v70>`.
    expect(branchEnd("v69", "v70", REGISTRY)).toBe("v69");
    expect(versionTagName({ from: "v69", to: branchEnd("v69", "v70", REGISTRY) })).toBe("v69");
  });

  it("is open-ended when nothing follows", () => {
    expect(branchEnd("v70", null, REGISTRY)).toBeNull();
    expect(versionTagName({ from: "v70", to: branchEnd("v70", null, REGISTRY) })).toBe("v70+");
  });

  it("falls back to the starting version when either id cannot be ordered", () => {
    expect(branchEnd("v56", "beta", REGISTRY)).toBe("v56");
    expect(branchEnd("beta", "v62", REGISTRY)).toBe("beta");
  });
});
