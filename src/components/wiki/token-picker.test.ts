/**
 * The picker's one promise that is not markup: an author is never invited to
 * create a token that already exists (visual-editor.md §5.2/§5.3). It is a
 * comparison, so it is tested here rather than through the DOM — the suite
 * runs in vitest's `node` environment.
 */

import { describe, expect, it } from "vitest";

import { slugifyTitle } from "@/lib/title";

import { tokenTaken, type TokenOption } from "./token-picker";

/** What GET /api/categories answers for `q=tier-3-moons` on the seeded wiki. */
const TIER_3: TokenOption[] = [{ id: "tier-3-moons", label: "Tier 3 moons", hint: "5" }];

describe("tokenTaken", () => {
  it("recognises the label the search reported, case-folded", () => {
    expect(tokenTaken("Tier 3 moons", TIER_3)).toBe(true);
    expect(tokenTaken("  tier 3 MOONS ", TIER_3)).toBe(true);
  });

  it("offers nothing to create for a query nothing answered", () => {
    expect(tokenTaken("Tier 4 moons", TIER_3, slugifyTitle)).toBe(false);
    expect(tokenTaken("v72", [{ id: "v70", label: "v70" }])).toBe(false);
  });

  it("recognises another spelling of the same category by its slug", () => {
    // The rail's tag picker: humanizeSlug turns "tier-3-moons" into "Tier 3
    // moons", so the label never equals the query the author typed and the
    // create row used to appear directly under the row it duplicates —
    // filing the page under one category twice, under two names.
    expect(tokenTaken("tier-3-moons", TIER_3, slugifyTitle)).toBe(true);
    expect(tokenTaken("Tier_3_Moons", TIER_3, slugifyTitle)).toBe(true);
  });

  it("compares on the label too, for a picker whose ids are not slugs", () => {
    const rows: TokenOption[] = [{ id: "42", label: "Tier 3 moons" }];
    expect(tokenTaken("tier-3-moons", rows, slugifyTitle)).toBe(true);
  });

  it("never matches on an identity that folds away to nothing", () => {
    const rows: TokenOption[] = [{ id: "", label: "…" }];
    expect(tokenTaken("!!!", rows, slugifyTitle)).toBe(false);
  });
});
