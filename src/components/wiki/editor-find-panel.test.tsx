/**
 * The find strip, tested where it is static — docs/engine/visual-editor.md §9.
 *
 * Rendered with `renderToStaticMarkup` the way version-chips.test.tsx does
 * (vitest runs in a node environment, so the first paint is the whole surface
 * these tests can see). What that paint has to get right is everything an
 * author reads before they touch a control:
 *
 * 1. **The count is the truth about the buffer**, including the honest "none",
 *    and including nothing at all before a query has been typed.
 * 2. **The match is shown in context** — the panel's answer to "which one is
 *    this?", and the only one that works in both modes, since it is cut from
 *    the buffer rather than from a surface.
 * 3. **A reader who cannot publish is offered no replacement**, rather than
 *    buttons that refuse.
 * 4. **Every string comes from the dictionary**, in both locales.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { formatMessage, getDictionary } from "@/lib/i18n";

import {
  EditorFindPanel,
  type EditorFindLabels,
  type EditorFindPanelProps,
} from "./editor-find-panel";
import type { FindApplyOutcome } from "./editor-find";

/** The bag `editorLabels` builds; assembled here, since edit-view is server-only. */
function labelsFor(locale: "en" | "ko"): EditorFindLabels {
  const dict = getDictionary(locale);
  const e = dict.editor;
  return {
    title: e.findTitle,
    find: e.findLabel,
    replace: e.findReplaceLabel,
    previous: e.findPrevious,
    next: e.findNext,
    matchCase: e.findMatchCase,
    wholeWord: e.findWholeWord,
    count: e.findCount,
    noResults: e.findNoResults,
    replaceOne: e.findReplaceOne,
    replaceAll: e.findReplaceAll,
    context: e.findContext,
    close: dict.common.close,
  };
}

const EN = labelsFor("en");

const NOOP_OUTCOME: FindApplyOutcome = { text: "", replaced: 0, landed: null };

function render(props: Partial<EditorFindPanelProps> = {}): string {
  return renderToStaticMarkup(
    <EditorFindPanel
      text={props.text ?? ""}
      initialQuery={props.initialQuery ?? ""}
      inputId={props.inputId ?? "editor-find-query"}
      readOnly={props.readOnly}
      onClose={() => {}}
      onReveal={() => {}}
      onApply={() => NOOP_OUTCOME}
      labels={props.labels ?? EN}
    />,
  );
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const ARTICLE =
  "Artifice is a moon.\n\n== Layout ==\nThe Artifice interior is a maze, and Artifice is expensive.\n";

describe("EditorFindPanel — the count", () => {
  it("prints which match is current out of how many", () => {
    const html = render({ text: ARTICLE, initialQuery: "Artifice" });
    expect(html).toContain(formatMessage(EN.count, { index: 1, total: 3 }));
  });

  it("says so plainly when the query is not in the buffer", () => {
    const html = render({ text: ARTICLE, initialQuery: "Embrion" });
    expect(html).toContain(EN.noResults);
    expect(html).not.toContain(formatMessage(EN.count, { index: 1, total: 1 }));
  });

  it("prints no count at all before a query has been typed", () => {
    const html = render({ text: ARTICLE });
    expect(html).not.toContain(EN.noResults);
    expect(html).toContain('aria-live="polite"');
  });

  it("is a live region, so a screen reader hears the search narrow", () => {
    expect(render({ text: ARTICLE, initialQuery: "Artifice" })).toContain('aria-live="polite"');
  });
});

describe("EditorFindPanel — the match in context", () => {
  it("prints the match, marked, with the buffer either side of it", () => {
    const html = render({ text: ARTICLE, initialQuery: "maze" });
    expect(html).toContain("<mark");
    expect(html).toContain("maze</mark>");
    // Cut from the wikitext, which is what makes it identical in both modes.
    expect(html).toContain("interior is a ");
  });

  it("draws no context line when nothing matches", () => {
    expect(render({ text: ARTICLE, initialQuery: "Embrion" })).not.toContain("<mark");
    expect(render({ text: ARTICLE })).not.toContain("<mark");
  });

  it("marks a clipped side with an ellipsis rather than pretending it ended", () => {
    const text = `${"x".repeat(200)}Artifice${"y".repeat(200)}`;
    const html = render({ text, initialQuery: "Artifice" });
    expect(occurrences(html, "…")).toBe(2);
  });

  it("names the line for a screen reader", () => {
    expect(render({ text: ARTICLE, initialQuery: "maze" })).toContain(
      `aria-label="${EN.context}"`,
    );
  });

  it("shows a match the visual surface never renders — inside a template call", () => {
    const html = render({
      text: "{{Infobox moon\n| name = Artifice\n}}\n",
      initialQuery: "Artifice",
    });
    expect(html).toContain("Artifice</mark>");
    expect(html).toContain(formatMessage(EN.count, { index: 1, total: 1 }));
  });
});

describe("EditorFindPanel — the controls", () => {
  it("is one named group, so the strip is reachable as a unit", () => {
    const html = render();
    expect(html).toContain('role="group"');
    expect(html).toContain(`aria-label="${EN.title}"`);
  });

  it("gives the query field the id the shortcut reaches it by", () => {
    const html = render({ inputId: "editor-find-query" });
    expect(html).toContain('id="editor-find-query"');
    expect(html).toContain('for="editor-find-query"');
    expect(html).toContain('id="editor-find-query-replace"');
  });

  it("opens with the selection already in the field", () => {
    expect(render({ text: ARTICLE, initialQuery: "Artifice" })).toContain('value="Artifice"');
  });

  it("both toggles start off and say so", () => {
    const html = render();
    expect(html).toContain(`aria-label="${EN.matchCase}"`);
    expect(html).toContain(`aria-label="${EN.wholeWord}"`);
    expect(occurrences(html, 'aria-pressed="false"')).toBe(2);
  });

  it("disables the arrows while there is nothing to step to", () => {
    const empty = render({ text: ARTICLE });
    expect(empty).toContain(`aria-label="${EN.previous}"`);
    // The two arrows and the two replacements; the toggles and the close
    // stay live, because there is nothing wrong with setting them first.
    expect(occurrences(empty, "disabled=")).toBe(4);
    const found = render({ text: ARTICLE, initialQuery: "Artifice" });
    expect(occurrences(found, "disabled=")).toBe(0);
  });

  it("disables every replacement while nothing matches, and offers it when one does", () => {
    const none = render({ text: ARTICLE, initialQuery: "Embrion" });
    expect(none).toContain(EN.replaceAll);
    expect(occurrences(none, "disabled=")).toBe(4);
    expect(occurrences(render({ text: ARTICLE, initialQuery: "Artifice" }), "disabled=")).toBe(0);
  });

  it("offers no replacement to a reader who cannot publish", () => {
    const html = render({ text: ARTICLE, initialQuery: "Artifice", readOnly: true });
    expect(html).not.toContain(EN.replaceOne);
    expect(html).not.toContain(EN.replaceAll);
    // Finding still works: the count and the context are both there.
    expect(html).toContain(formatMessage(EN.count, { index: 1, total: 3 }));
    expect(html).toContain("<mark");
  });

  it("carries an accessible name on every icon button", () => {
    const html = render();
    for (const label of [EN.previous, EN.next, EN.matchCase, EN.wholeWord, EN.close]) {
      expect(html, label).toContain(`aria-label="${label}"`);
    }
  });
});

describe("EditorFindPanel — the dictionary", () => {
  it("draws no English when the locale is Korean", () => {
    const ko = labelsFor("ko");
    const html = renderToStaticMarkup(
      <EditorFindPanel
        text={ARTICLE}
        initialQuery="Artifice"
        inputId="editor-find-query"
        onClose={() => {}}
        onReveal={() => {}}
        onApply={() => NOOP_OUTCOME}
        labels={ko}
      />,
    );
    expect(html).toContain(ko.replaceAll);
    expect(html).toContain(formatMessage(ko.count, { index: 1, total: 3 }));
    expect(html).not.toContain(EN.replaceAll);
    expect(html).not.toContain(EN.noResults);
  });

  it("spends no hex literal and no stock palette colour on itself", () => {
    const html = render({ text: ARTICLE, initialQuery: "Artifice" });
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toMatch(/\b(?:bg|text|border)-(?:gray|slate|zinc|blue|red|yellow)-\d{2,3}\b/);
  });
});
