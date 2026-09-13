/**
 * What the page-tools rail does now that versioning.md §6 has taken its
 * Versions section away.
 *
 * The removal itself is the first thing asserted, because it is a claim about
 * the product and not only about this file: §6 gives the author the *reader's*
 * control — `EditorVersionBar`, above the editing surface in both modes — and a
 * second version list in a collapsible rail was the two-controls-for-one-job
 * confusion the section was rewritten to remove. The rail still *states* which
 * version the preview is rendering under Page settings; that is a fact, not a
 * control, and it has to survive.
 *
 * The rest is the coverage that section used to hold, moved onto what the rail
 * actually still owns: the buffer-derived Templates and Categories lists, and
 * decisions-v2 O14.4 — tagging is the rail's *only* home, so it stays live in
 * visual mode even though the snippet buttons (which drive a textarea the
 * visual surface does not have) go inert.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createDb } from "@/lib/db/client";
import { seedLanguages, seedVersions } from "@/lib/db/store";
import { formatMessage, getDictionary } from "@/lib/i18n";
import { editorLabels, loadEditorView } from "@/lib/wiki/edit-view";

import { EditorRail } from "./editor-rail";

const dict = getDictionary("en");

/**
 * A template, a category, and a `{{#vswitch:}}` naming a patch the registry has
 * never heard of (decisions-v2 O16.2) — so the buffer still has a version
 * boundary in it for the rail to conspicuously not render.
 */
const BUFFER = [
  "{{Infobox moon|cost=1400}}",
  "The base quota is {{#vswitch: v50 = 130 | v72 = 180 }} credits.",
  "[[Category:Moons]]",
].join("\n");

function labels() {
  const db = createDb(":memory:");
  seedLanguages(db);
  seedVersions(db);
  const view = loadEditorView({ db, locale: "en", segments: "gold-bar", version: null });
  if (!view) throw new Error("unresolvable title");
  return editorLabels(dict, view);
}

function renderRail(options: { commandsDisabled?: boolean } = {}): string {
  const all = labels();
  return renderToStaticMarkup(
    <EditorRail
      locale="en"
      content={BUFFER}
      onContentChange={() => {}}
      onCommand={() => {}}
      commandsDisabled={options.commandsDisabled}
      version="v70"
      parentRevId={41}
      labels={all.rail}
      quickActionLabels={all.railQuickActions}
    />,
  );
}

/** The element carrying this accessible name, with its attributes. */
function byLabel(html: string, ariaLabel: string): string {
  const found = new RegExp(`<[a-z]+[^>]*aria-label="${ariaLabel}"[^>]*>`).exec(html);
  if (found === null) throw new Error(`no element labelled "${ariaLabel}" in ${html}`);
  return found[0];
}

/** The attribute, not the `disabled:` Tailwind variants in the class list. */
function isInert(element: string): boolean {
  return / disabled=""/.test(element);
}

describe("EditorRail — versions moved out (§6)", () => {
  it("offers no version control, and still states the version being previewed", () => {
    const html = renderRail();

    // The buffer branches at v50 and v72. Neither may appear: choosing a branch
    // is the version bar's job, and a rail that hides when collapsed is the
    // wrong place to put the only copy of it.
    expect(html).not.toContain(">v50<");
    expect(html).not.toContain(">v72<");
    expect(html).not.toContain(dict.version.boundaries);
    expect(html).not.toContain(dict.version.unregistered);

    // Page settings keeps the read-only statement of what the preview renders.
    expect(html).toContain(dict.editor.railSettingsVersion);
    expect(html).toContain(">v70<");
  });
});

describe("EditorRail — what the buffer puts in it", () => {
  it("lists the templates and categories the source names, and links both", () => {
    const html = renderRail();

    expect(html).toContain(dict.editor.railTemplates);
    expect(html).toContain("{{Infobox moon}}");
    expect(html).toContain("/wiki/template:infobox-moon");
    // `#vswitch` is a parser function, not a transclusion, so it is not a
    // template this page "uses".
    expect(html).not.toContain("#vswitch");

    expect(html).toContain(dict.editor.railCategories);
    expect(html).toContain("/wiki/category:moons");
    expect(html).toContain(
      formatMessage(dict.editor.railCategoryRemove, { name: "Moons" }),
    );
    // Both lists are derived, so neither empty line is on screen.
    expect(html).not.toContain(dict.editor.railTemplatesEmpty);
    expect(html).not.toContain(dict.editor.railCategoriesEmpty);
  });

  it("keeps tagging live in visual mode while the snippet buttons go inert (O14.4)", () => {
    const all = labels();
    const html = renderRail({ commandsDisabled: true });

    expect(isInert(byLabel(html, all.railQuickActions.table))).toBe(true);
    expect(
      isInert(byLabel(html, formatMessage(dict.editor.railCategoryRemove, { name: "Moons" }))),
    ).toBe(false);
  });
});
