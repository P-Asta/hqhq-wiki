/**
 * decisions-v2 O14.5 — the suggest dropdown's "Create <query>" entry.
 *
 * `buildOptions` is the whole rule: page suggestions in order, then the create
 * action as the LAST option, pointing at the ARTICLE url of the typed title
 * (slugified per decisions O1) and suppressed when a suggestion already IS
 * that title.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { buildOptions } from "./suggest-box";

const CREATE = "Create “{query}”";

const goldBar = {
  pageId: 1,
  namespace: "main" as const,
  slug: "gold-bar",
  locale: "en",
  title: "Gold bar",
};

describe("buildOptions", () => {
  it("appends the create action after the page suggestions", () => {
    const options = buildOptions([goldBar], "gold", "en", CREATE);
    expect(options.map((option) => option.kind)).toEqual(["page", "create"]);
    expect(options[0].href).toBe("/wiki/gold-bar");
    expect(options[1].href).toBe("/wiki/gold");
    expect(options[1].label).toBe("Create “gold”");
  });

  it("drops the create action when a suggestion is already that title", () => {
    // Same page identity (namespace, slug) — casing and underscores included.
    expect(buildOptions([goldBar], "Gold bar", "en", CREATE)).toHaveLength(1);
    expect(buildOptions([goldBar], "gold_bar", "en", CREATE)).toHaveLength(1);
  });

  it("keeps the namespace and prefixes non-default locales (O1 / O12)", () => {
    const options = buildOptions([], "Template:Infobox moon", "ko", CREATE);
    expect(options).toHaveLength(1);
    expect(options[0].href).toBe("/ko/wiki/template:infobox-moon");
  });

  it("offers nothing for a blank or uncreatable title (decisions O2)", () => {
    expect(buildOptions([], "   ", "en", CREATE)).toEqual([]);
    // Talk/User/Help are parseable but not storable — they have no address.
    expect(buildOptions([], "Talk:Gold bar", "en", CREATE)).toEqual([]);
  });

  it("is the only option when nothing matched at all", () => {
    const options = buildOptions([], "brand new page", "en", CREATE);
    expect(options).toEqual([
      {
        kind: "create",
        key: "create",
        href: "/wiki/brand-new-page",
        label: "Create “brand new page”",
        hint: null,
      },
    ]);
  });
});
