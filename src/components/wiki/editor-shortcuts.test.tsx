/**
 * The keyboard-shortcuts dialog — docs/engine/visual-editor.md §6.
 *
 * This table is a promise, and the only way it goes wrong is by falling
 * behind: a binding lands in a surface and nobody adds the row, or a row
 * survives a binding that was removed. So what is asserted here is
 * *correspondence* — every binding §6 lists has a row, with the keycaps the
 * handlers actually test for — rather than the shape of a table.
 *
 * The two waves that prompted this file are the reason it exists at all:
 * `Alt+Arrow` (§3.1), `Ctrl/Cmd+F` (§9) and the five block-format keys (§10.2)
 * all arrived after the dialog was written.
 *
 * The keycap swap gets its own block. `Option` and `Alt` are the same physical
 * key and the same `event.altKey`; printing the one that is not on the reader's
 * keyboard is the single thing this table must never do.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { formatMessage, getDictionary } from "@/lib/i18n";

import {
  ShortcutsDialog,
  altModifierLabel,
  modifierLabel,
  type ShortcutsDialogLabels,
} from "./editor-shortcuts";

function labelsFor(locale: "en" | "ko"): ShortcutsDialogLabels {
  const dict = getDictionary(locale);
  const e = dict.editor;
  return {
    title: e.shortcutsTitle,
    action: e.shortcutsAction,
    keys: e.shortcutsKeys,
    close: dict.common.close,
    slashMenu: e.shortcutsSlashMenu,
    mention: e.shortcutsMention,
    duplicate: e.blockDuplicate,
    bold: e.toolbarBold,
    italic: e.toolbarItalic,
    underline: e.toolbarUnderline,
    formatParagraph: e.toolbarFormatParagraph,
    formatHeading: e.toolbarFormatHeading,
    formatSubHeading1: formatMessage(e.toolbarFormatSubHeading, { level: 1 }),
    formatSubHeading2: formatMessage(e.toolbarFormatSubHeading, { level: 2 }),
    formatSubHeading3: formatMessage(e.toolbarFormatSubHeading, { level: 3 }),
    link: e.toolbarLink,
    find: e.findTitle,
    undo: e.toolbarUndo,
    redo: e.toolbarRedo,
    publish: e.shortcutsPublishRow,
    moveUp: e.blockMoveUp,
    moveDown: e.blockMoveDown,
    tableNextCell: e.shortcutsTableNextCell,
    tablePreviousCell: e.shortcutsTablePreviousCell,
    tableLineBreak: e.shortcutsTableLineBreak,
  };
}

const EN = labelsFor("en");

function render(labels: ShortcutsDialogLabels = EN): string {
  return renderToStaticMarkup(
    <ShortcutsDialog open onClose={() => {}} labels={labels} />,
  );
}

/** The `<tr>` naming this action, keycaps and all. */
function row(html: string, action: string): string {
  const found = new RegExp(`<tr[^>]*>(?:(?!</tr>).)*>${action}</td>(?:(?!</tr>).)*</tr>`, "s").exec(
    html,
  );
  if (found === null) throw new Error(`no row for "${action}" in ${html}`);
  return found[0];
}

/** The keycaps of one row, in the order they are held. */
function keys(html: string, action: string): string[] {
  return Array.from(row(html, action).matchAll(/<kbd[^>]*>([^<]*)<\/kbd>/g)).map(
    (match) => match[1],
  );
}

describe("ShortcutsDialog — every binding §6 promises", () => {
  const html = render();

  it("lists the marks", () => {
    expect(keys(html, EN.bold)).toEqual(["Ctrl", "B"]);
    expect(keys(html, EN.italic)).toEqual(["Ctrl", "I"]);
    expect(keys(html, EN.underline)).toEqual(["Ctrl", "U"]);
  });

  it("lists the block formats the visual surface answers to (§10.2)", () => {
    // The numbers the wikitext spells: Ctrl+2 writes `== x ==`.
    expect(keys(html, EN.formatParagraph)).toEqual(["Ctrl", "0"]);
    expect(keys(html, EN.formatHeading)).toEqual(["Ctrl", "2"]);
    expect(keys(html, EN.formatSubHeading1)).toEqual(["Ctrl", "3"]);
    expect(keys(html, EN.formatSubHeading2)).toEqual(["Ctrl", "4"]);
    expect(keys(html, EN.formatSubHeading3)).toEqual(["Ctrl", "5"]);
  });

  it("advertises no key the format menu does not offer", () => {
    // `= x =` and `====== x ======` are not in the menu (§1), so `Ctrl+1` and
    // `Ctrl+6` do nothing — and a table naming a dead key is worse than a
    // shorter table.
    const caps = Array.from(html.matchAll(/<kbd[^>]*>([^<]*)<\/kbd>/g)).map((match) => match[1]);
    expect(caps).not.toContain("1");
    expect(caps).not.toContain("6");
  });

  it("lists the link dialog and the find strip (§9)", () => {
    expect(keys(html, EN.link)).toEqual(["Ctrl", "K"]);
    expect(keys(html, EN.find)).toEqual(["Ctrl", "F"]);
  });

  it("lists undo, redo and publish", () => {
    expect(keys(html, EN.undo)).toEqual(["Ctrl", "Z"]);
    expect(keys(html, EN.redo)).toEqual(["Ctrl", "Shift", "Z"]);
    expect(keys(html, EN.publish)).toEqual(["Ctrl", "Enter"]);
  });

  it("lists the block moves under Alt, not under the primary modifier (§3.1)", () => {
    expect(keys(html, EN.moveUp)).toEqual(["Alt", "↑"]);
    expect(keys(html, EN.moveDown)).toEqual(["Alt", "↓"]);
  });

  it("prints the table rows with a bare Tab (§3.2)", () => {
    // Outside a table Tab is not a shortcut at all — it is how a keyboard
    // leaves the surface — which is why every row names the table and none
    // carries a modifier.
    //
    // "Next cell" prints both of its keys in one row: Enter takes Tab's step
    // there (2026-09-06), and two rows with one name would read as two
    // different features. `Shift+Enter` is the line break Enter stopped
    // making, which is the one thing about that change an author has to be
    // told — the rest they will find by pressing Enter.
    expect(keys(html, EN.tableNextCell)).toEqual(["Tab", "Enter"]);
    expect(keys(html, EN.tablePreviousCell)).toEqual(["Shift", "Tab"]);
    expect(keys(html, EN.tableLineBreak)).toEqual(["Shift", "Enter"]);
  });

  it("draws nothing at all while it is closed", () => {
    expect(renderToStaticMarkup(<ShortcutsDialog open={false} onClose={() => {}} labels={EN} />)).toBe(
      "",
    );
  });
});

describe("ShortcutsDialog — the keycaps on the reader's keyboard", () => {
  it("prints Cmd and Option on Apple hardware, Ctrl and Alt everywhere else", () => {
    for (const apple of ["MacIntel", "iPhone", "iPad", "macarm"]) {
      expect(modifierLabel(apple)).toBe("Cmd");
      expect(altModifierLabel(apple)).toBe("Option");
    }
    for (const other of ["Win32", "Linux x86_64", "", "  ", "Android"]) {
      expect(modifierLabel(other)).toBe("Ctrl");
      expect(altModifierLabel(other)).toBe("Alt");
    }
  });

  it("is not fooled by stray whitespace or case", () => {
    expect(modifierLabel("  macIntel ")).toBe("Cmd");
    expect(altModifierLabel(" IPHONE")).toBe("Option");
  });
});

describe("ShortcutsDialog — the dictionary", () => {
  it("takes every string from it, in both locales", () => {
    for (const locale of ["en", "ko"] as const) {
      const labels = labelsFor(locale);
      const html = render(labels);
      expect(html).toContain(labels.title);
      expect(html).toContain(labels.action);
      expect(html).toContain(labels.keys);
      // Both the format menu's names and the find strip's, which is the point
      // of reusing them: one word per thing across the whole editor.
      expect(html).toContain(labels.formatSubHeading2);
      expect(html).toContain(labels.find);
      expect(html).toContain(labels.moveUp);
    }
    expect(labelsFor("ko").title).not.toBe(EN.title);
  });
});
