"use client";

/**
 * The "Keyboard shortcuts" entry of Fandom's mode menu: a two-column table of
 * exactly the bindings docs/engine/visual-editor.md §6 promises, and nothing
 * else. A dialog that advertises a shortcut the surfaces do not implement is
 * worse than no dialog, so this list and the handlers in editor.tsx are meant
 * to be read side by side.
 *
 * Escape is deliberately absent from the table: it closes *this* dialog, which
 * the reader is about to discover unaided.
 */

import { useState } from "react";

import { Dialog } from "@/components/ui/dialog";

/** True for the platforms whose keyboards print Apple's keycaps. */
function isApple(platform: string): boolean {
  return /^(mac|iphone|ipad|ipod)/i.test(platform.trim());
}

/**
 * `Cmd` on Apple hardware, `Ctrl` everywhere else — the only distinction the
 * table needs, which is why a prefix test on `navigator.platform` is enough
 * despite that field's deprecation: `navigator.userAgentData` is neither in
 * `lib.dom` nor in Safari, and a wrong answer here costs a wrong keycap, not a
 * broken shortcut (the handlers accept either modifier regardless).
 */
export function modifierLabel(platform: string): "Cmd" | "Ctrl" {
  return isApple(platform) ? "Cmd" : "Ctrl";
}

/**
 * The other modifier this table prints: the block-move rows are `Alt+Arrow`
 * (visual-editor.md §3.1), and the key Windows and Linux keyboards call `Alt`
 * is the one Apple keyboards print `Option` on. Same physical key, same
 * `event.altKey`, two keycaps — and a keycap that is not on the reader's
 * keyboard is the one thing this table must not print.
 */
export function altModifierLabel(platform: string): "Option" | "Alt" {
  return isApple(platform) ? "Option" : "Alt";
}

/**
 * The modifier for the machine this is running on. Read once, when the state
 * below is initialised: SSR has no `navigator` — and Node ≥21 has one *without*
 * `platform`, which is why the guard produces a string rather than trusting the
 * DOM type — so the server renders `Ctrl`. Nothing is painted from it either
 * way, because the panel does not exist until the dialog opens.
 */
function detectPlatform(): string {
  const platform: string | undefined =
    typeof navigator === "undefined" ? undefined : navigator.platform;
  return platform ?? "";
}

/** Which dictionary line names the action a row describes. */
type ShortcutAction =
  | "slashMenu"
  | "mention"
  | "duplicate"
  | "bold"
  | "italic"
  | "underline"
  | "formatParagraph"
  | "formatHeading"
  | "formatSubHeading1"
  | "formatSubHeading2"
  | "formatSubHeading3"
  | "link"
  | "find"
  | "undo"
  | "redo"
  | "publish"
  | "moveUp"
  | "moveDown"
  | "tableNextCell"
  | "tablePreviousCell"
  | "tableLineBreak";

interface Shortcut {
  action: ShortcutAction;
  /**
   * Which modifier the row is held with, or none at all. Most bindings are
   * `Ctrl`/`Cmd`; the two block moves are `Alt` (§3.1), and the two table
   * bindings are a bare Tab (§3.2) — a table that printed one modifier for all
   * of them would be advertising shortcuts that do nothing.
   */
  modifier?: "primary" | "alt";
  /** Keycaps pressed with the modifier, in the order they are held. */
  keys: readonly string[];
  /**
   * A second binding for the same act, printed after a "/" — one row, because
   * two rows with one name is a table that reads as two different features.
   * `Enter` walks a table's cells exactly as Tab does (§3.2), and an author
   * who learned either has learned both.
   */
  also?: readonly string[];
}

const SHORTCUTS: readonly Shortcut[] = [
  // §1: the toolbar is gone, so "/" is how every construct is reached. It
  // leads the table because it is the one binding an author cannot guess from
  // another editor's habits.
  { action: "slashMenu", keys: ["/"] },
  // §13: two brackets are a page search and two braces a template one. They
  // are printed as the characters they are, because that is how they are
  // typed — there is no chord to hold.
  { action: "mention", keys: ["[", "["] },
  { action: "bold", modifier: "primary", keys: ["B"] },
  { action: "italic", modifier: "primary", keys: ["I"] },
  { action: "underline", modifier: "primary", keys: ["U"] },
  // §10.2: the block formats, numbered the way the wikitext is — `Ctrl+2`
  // writes `== x ==`. `1` and `6` are absent because the format menu does not
  // offer `h1` or `h6`, and a table advertising a key that does nothing is
  // worse than a table that is one row shorter.
  { action: "formatParagraph", modifier: "primary", keys: ["0"] },
  { action: "formatHeading", modifier: "primary", keys: ["2"] },
  { action: "formatSubHeading1", modifier: "primary", keys: ["3"] },
  { action: "formatSubHeading2", modifier: "primary", keys: ["4"] },
  { action: "formatSubHeading3", modifier: "primary", keys: ["5"] },
  { action: "link", modifier: "primary", keys: ["K"] },
  // §9: the one binding that opens a panel rather than changing the buffer.
  { action: "find", modifier: "primary", keys: ["F"] },
  { action: "undo", modifier: "primary", keys: ["Z"] },
  { action: "redo", modifier: "primary", keys: ["Shift", "Z"] },
  { action: "publish", modifier: "primary", keys: ["Enter"] },
  { action: "duplicate", modifier: "primary", keys: ["D"] },
  { action: "moveUp", modifier: "alt", keys: ["↑"] },
  { action: "moveDown", modifier: "alt", keys: ["↓"] },
  // Only inside a table, which is why the action names say so (§3.2). Enter
  // takes Tab's step there (2026-09-06), so a cell's line break has to be
  // advertised too: it is the one thing Enter stopped doing.
  { action: "tableNextCell", keys: ["Tab"], also: ["Enter"] },
  { action: "tablePreviousCell", keys: ["Shift", "Tab"] },
  { action: "tableLineBreak", keys: ["Shift", "Enter"] },
];

export interface ShortcutsDialogLabels {
  title: string;
  action: string;
  keys: string;
  close: string;
  /**
   * The slash menu (§1) — the row for "/", which is a bare key rather than a
   * chord, since it is typed into the article like any other character.
   */
  slashMenu: string;
  /** The `[[` panel (§13) — the page and template search at the caret. */
  mention: string;
  /** `Ctrl/Cmd+D` (§14), the same name the gutter menu's row carries. */
  duplicate: string;
  bold: string;
  italic: string;
  underline: string;
  /**
   * The five block-format rows (§10.2). They carry the *format menu's* own
   * names rather than names of their own, so an author who learns "Sub-heading
   * 1" from the toolbar finds that name here and nowhere else a second word for
   * the same thing.
   */
  formatParagraph: string;
  formatHeading: string;
  formatSubHeading1: string;
  formatSubHeading2: string;
  formatSubHeading3: string;
  link: string;
  /** The find-and-replace panel (§9) — the row that names Ctrl/Cmd+F. */
  find: string;
  undo: string;
  redo: string;
  publish: string;
  /** The two block-move rows; the same strings the gutter buttons carry. */
  moveUp: string;
  moveDown: string;
  /** The table rows; each names the table, since Tab does nothing elsewhere. */
  tableNextCell: string;
  tablePreviousCell: string;
  /** `Shift+Enter` — the line break inside a cell, now that Enter walks (§3.2). */
  tableLineBreak: string;
}

export interface ShortcutsDialogProps {
  open: boolean;
  onClose: () => void;
  labels: ShortcutsDialogLabels;
}

/** Key names are keycaps, not copy: they are printed on the reader's keyboard. */
function Keycap({ children }: { children: string }) {
  return (
    <kbd className="rounded-[var(--radius-sm)] border border-hairline bg-canvas-soft px-1.5 py-0.5 font-mono text-[11px] leading-4 text-body">
      {children}
    </kbd>
  );
}

export function ShortcutsDialog({ open, onClose, labels }: ShortcutsDialogProps) {
  const [platform] = useState(detectPlatform);
  const modifiers = { primary: modifierLabel(platform), alt: altModifierLabel(platform) };

  return (
    <Dialog open={open} onClose={onClose} title={labels.title} closeLabel={labels.close}>
      <div className="overflow-hidden rounded-[var(--radius-md)] border border-hairline">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-hairline bg-canvas-soft text-left">
              <th className="px-3 py-2 font-semibold text-ink">{labels.action}</th>
              <th className="px-3 py-2 text-right font-semibold text-ink">{labels.keys}</th>
            </tr>
          </thead>
          <tbody>
            {SHORTCUTS.map((shortcut) => (
              <tr key={shortcut.action} className="border-b border-hairline last:border-b-0">
                <td className="px-3 py-2 text-body">{labels[shortcut.action]}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <span className="inline-flex items-center gap-1">
                    {shortcut.modifier === undefined ? null : (
                      <Keycap>{modifiers[shortcut.modifier]}</Keycap>
                    )}
                    {shortcut.keys.map((key, index) => (
                      <span key={key} className="inline-flex items-center gap-1">
                        {/* No leading `+` where the row opens with a bare key. */}
                        {shortcut.modifier === undefined && index === 0 ? null : (
                          <span aria-hidden className="text-faint">
                            +
                          </span>
                        )}
                        <Keycap>{key}</Keycap>
                      </span>
                    ))}
                    {/* The second binding for the same act, after a "/" — a
                        separator rather than a word, so it needs no dictionary
                        entry and reads the same in every locale. */}
                    {(shortcut.also ?? []).map((key, index) => (
                      <span key={`also-${key}`} className="inline-flex items-center gap-1">
                        <span aria-hidden className="text-faint">
                          {index === 0 ? "/" : "+"}
                        </span>
                        <Keycap>{key}</Keycap>
                      </span>
                    ))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}
