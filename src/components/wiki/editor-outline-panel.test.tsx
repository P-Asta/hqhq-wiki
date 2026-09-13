/**
 * The outline panel, tested where it is static — docs/engine/visual-editor.md
 * §10.1.
 *
 * `renderToStaticMarkup`, the way version-chips.test.tsx does it: vitest runs
 * in a node environment, so the first paint is the whole of the surface these
 * tests can see. What that paint has to get right is everything an author reads
 * before touching anything:
 *
 * 1. **The map is the document** — every heading, in order, at the depth the
 *    wikitext says, including the ones that are awkward: an empty title, a
 *    document that starts mid-level.
 * 2. **An arrow that cannot move is disabled**, and "cannot" includes the case
 *    that looks possible — a subsection whose same-level neighbour lives under
 *    another heading, which is a re-parenting rather than a reorder.
 * 3. **The caret's section is marked**, and the lead is marked as no section
 *    rather than as the first one.
 * 4. **A reader who cannot publish is offered no arrows**, rather than arrows
 *    that refuse.
 * 5. **Every string comes from the dictionary**, in both locales.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { formatMessage, getDictionary } from "@/lib/i18n";

import { documentOutline } from "./editor-outline";
import {
  EditorOutlinePanel,
  type EditorOutlineLabels,
  type EditorOutlinePanelProps,
} from "./editor-outline-panel";

/** The bag `editorLabels` builds; assembled here, since edit-view is server-only. */
function labelsFor(locale: "en" | "ko"): EditorOutlineLabels {
  const e = getDictionary(locale).editor;
  return {
    title: e.outlineTitle,
    empty: e.outlineEmpty,
    untitled: e.outlineUntitled,
    moveUp: e.outlineMoveUp,
    moveDown: e.outlineMoveDown,
  };
}

const EN = labelsFor("en");

const ARTICLE = [
  "Lead sentence.",
  "",
  "== Overview ==",
  "",
  "Body.",
  "",
  "=== Layout ===",
  "",
  "More.",
  "",
  "=== Hazards ===",
  "",
  "== Strategy ==",
  "",
  "Body.",
].join("\n");

function render(
  text: string,
  props: Partial<EditorOutlinePanelProps> = {},
  labels: EditorOutlineLabels = EN,
): string {
  const outline = documentOutline(text);
  return renderToStaticMarkup(
    <EditorOutlinePanel
      headings={props.headings ?? outline.headings}
      current={props.current ?? -1}
      readOnly={props.readOnly}
      onSelect={() => {}}
      onMove={() => {}}
      labels={labels}
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

/** The `<li>` whose row button prints this heading, attributes and all. */
function row(html: string, title: string): string {
  const found = new RegExp(`<li[^>]*>(?:(?!</li>).)*title="${title}"(?:(?!</li>).)*</li>`, "s").exec(
    html,
  );
  if (found === null) throw new Error(`no row for "${title}" in ${html}`);
  return found[0];
}

/** The row's own button — the one that navigates, not the two that move. */
function rowButton(html: string, title: string): string {
  const found = new RegExp(`<button[^>]*title="${title}"[^>]*>`).exec(html);
  if (found === null) throw new Error(`no row button for "${title}" in ${html}`);
  return found[0];
}

describe("EditorOutlinePanel — the map", () => {
  it("lists every heading in document order, with its level", () => {
    const html = render(ARTICLE);

    expect(html).toContain(EN.title);
    for (const title of ["Overview", "Layout", "Hazards", "Strategy"]) {
      expect(html).toContain(`>${title}</span>`);
    }
    expect(html.indexOf("Overview")).toBeLessThan(html.indexOf("Layout"));
    expect(html.indexOf("Hazards")).toBeLessThan(html.indexOf("Strategy"));
    // The level is in the row's own text, so it reaches a reader who cannot
    // see the indent.
    expect(row(html, "Overview")).toContain(">H2<");
    expect(row(html, "Layout")).toContain(">H3<");
  });

  it("indents by the level, from the shallowest the document uses", () => {
    expect(row(render(ARTICLE), "Overview")).toContain("pl-2");
    expect(row(render(ARTICLE), "Layout")).toContain("pl-5");

    // A document written entirely in `===` is flat, because it is.
    const flat = render("=== A ===\n\n=== B ===\n");
    expect(row(flat, "A")).toContain("pl-2");
    expect(row(flat, "B")).toContain("pl-2");
  });

  it("says so when there are no headings at all", () => {
    const html = render("Just a paragraph.\n");
    expect(html).toContain(EN.empty);
    expect(html).not.toContain("<li");
  });

  it("prints a stand-in for a heading with no text", () => {
    const html = render("== ==\n\nBody.\n");
    expect(html).toContain(EN.untitled);
  });
});

describe("EditorOutlinePanel — the arrows", () => {
  it("names each arrow after the section it moves", () => {
    const html = render(ARTICLE);
    expect(html).toContain(formatMessage(EN.moveUp, { title: "Strategy" }));
    expect(html).toContain(formatMessage(EN.moveDown, { title: "Overview" }));
  });

  it("disables the arrow that would land nowhere, at each end", () => {
    const html = render(ARTICLE);
    // Overview is the first `==`, Strategy the last.
    expect(isInert(byLabel(html, formatMessage(EN.moveUp, { title: "Overview" })))).toBe(true);
    expect(isInert(byLabel(html, formatMessage(EN.moveDown, { title: "Overview" })))).toBe(false);
    expect(isInert(byLabel(html, formatMessage(EN.moveUp, { title: "Strategy" })))).toBe(false);
    expect(isInert(byLabel(html, formatMessage(EN.moveDown, { title: "Strategy" })))).toBe(true);
  });

  it("lets a subsection trade places with its own siblings", () => {
    const html = render(ARTICLE);
    expect(isInert(byLabel(html, formatMessage(EN.moveDown, { title: "Layout" })))).toBe(false);
    expect(isInert(byLabel(html, formatMessage(EN.moveUp, { title: "Hazards" })))).toBe(false);
  });

  it("disables the move that would re-parent, though it looks possible", () => {
    // `=== A1 ===` and `=== B1 ===` are at the same level, but under different
    // parents. Moving one onto the other would take it out of its section.
    const html = render("== A ==\n\n=== A1 ===\n\n== B ==\n\n=== B1 ===\n");
    expect(isInert(byLabel(html, formatMessage(EN.moveDown, { title: "A1" })))).toBe(true);
    expect(isInert(byLabel(html, formatMessage(EN.moveUp, { title: "B1" })))).toBe(true);
    // Their parents are each other's siblings, and those still move.
    expect(isInert(byLabel(html, formatMessage(EN.moveDown, { title: "A" })))).toBe(false);
  });

  it("disables both arrows for a document that starts mid-level", () => {
    const html = render("=== Deep ===\n\n== Shallow ==\n");
    expect(isInert(byLabel(html, formatMessage(EN.moveDown, { title: "Deep" })))).toBe(true);
    expect(isInert(byLabel(html, formatMessage(EN.moveUp, { title: "Shallow" })))).toBe(true);
  });

  it("offers a reader who cannot publish no arrows at all, and every row", () => {
    const html = render(ARTICLE, { readOnly: true });
    expect(isInert(byLabel(html, formatMessage(EN.moveDown, { title: "Overview" })))).toBe(true);
    expect(isInert(byLabel(html, formatMessage(EN.moveUp, { title: "Strategy" })))).toBe(true);
    // Reading a long article's structure is not editing it, so every row is
    // still a live control that scrolls to its heading.
    expect(isInert(rowButton(html, "Overview"))).toBe(false);
    expect(isInert(rowButton(html, "Strategy"))).toBe(false);
  });
});

describe("EditorOutlinePanel — the caret", () => {
  it("marks the section the caret is in, and only that one", () => {
    const outline = documentOutline(ARTICLE);
    const layout = outline.headings.findIndex((heading) => heading.title === "Layout");
    const html = render(ARTICLE, { current: layout });

    expect(row(html, "Layout")).toContain('aria-current="true"');
    expect(row(html, "Overview")).not.toContain("aria-current");
    expect(row(html, "Strategy")).not.toContain("aria-current");
    expect(html.match(/aria-current/g)).toHaveLength(1);
  });

  it("marks nothing while the caret is in the lead", () => {
    expect(render(ARTICLE, { current: -1 })).not.toContain("aria-current");
  });
});

describe("EditorOutlinePanel — the dictionary", () => {
  it("takes every string from it, in both locales", () => {
    for (const locale of ["en", "ko"] as const) {
      const labels = labelsFor(locale);
      const html = render(ARTICLE, {}, labels);
      expect(html).toContain(labels.title);
      expect(html).toContain(formatMessage(labels.moveUp, { title: "Strategy" }));
      expect(html).toContain(formatMessage(labels.moveDown, { title: "Overview" }));
      expect(render("Nothing here.\n", {}, labels)).toContain(labels.empty);
      expect(render("== ==\n", {}, labels)).toContain(labels.untitled);
    }
    // The two locales really are different strings, so the loop above is not
    // asserting the same thing twice.
    expect(labelsFor("ko").title).not.toBe(EN.title);
  });
});
