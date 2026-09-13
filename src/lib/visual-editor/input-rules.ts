/**
 * Typing that turns into structure — the fourth of the Notion-shaped controls
 * (docs/engine/visual-editor.md §1). A fixed toolbar asks the author to stop
 * writing, find a control and come back; an input rule lets the structure fall
 * out of the typing itself, which is the whole reason the interaction model
 * changed.
 *
 * **Both syntaxes are recognised.** Markdown, because that is the muscle
 * memory Notion built and the one an author arrives with; wikitext, because it
 * is what this wiki stores and what its own editors already type. Recognising
 * only one would tax half the audience for nothing — the two prefixes are
 * almost entirely disjoint, and where they are not the wiki wins (below).
 *
 *   markdown           wikitext         becomes
 *   "## " … "##### "   "== " … "===== " heading 2 … heading 5
 *   "- " / "* "        "* "             bullet list
 *   "1. "              "# "             numbered list
 *   "> "               ": "             indent
 *   "--- " or more     "---- " or more  horizontal rule
 *
 * **The one collision, decided rather than guessed: "# " is a numbered list,
 * not a heading.** Markdown reads it as an h1; wikitext reads it as an ordered
 * list item. Wiki articles do not use h1 at all — the page title is the h1 —
 * and "== " already covers wiki headings while "## " covers markdown ones, so
 * nothing is lost by the wikitext meaning winning on its own ground.
 *
 * Everything here is pure: it sees a string, never a DOM. The surface owns the
 * caret and hands over only the text before it, which is also what makes these
 * rules testable under vitest's node environment.
 *
 * ## The contract with whoever applies a match
 *
 * A match says how many characters immediately before the caret it swallows
 * and what to do once they are gone. For a block rule that is the marker and
 * its completing space, and `action` re-formats the block the caret is in —
 * whatever text follows the caret stays and becomes the heading's or the
 * item's content. For an inline rule the swallowed run is the whole pair with
 * its delimiters, and `text` is what must be re-inserted in its place for
 * `action` to mark: a mark applied to the delimiters themselves would publish
 * the asterisks inside the emphasis.
 *
 * ## What the rules assume about undo
 *
 * They assume the applier groups the deletion, the re-insertion and the action
 * into the **same** undo step as the keystroke that triggered them — the space
 * or the closing delimiter, which it therefore has to swallow itself rather
 * than let the browser insert. One `Ctrl+Z` then puts back exactly the literal
 * characters the author typed ("## " stays "## "), which is also the only
 * escape hatch for an author who meant them literally. Reversing the action
 * alone would leave the swallowed characters deleted, and rebuilding the block
 * instead of undoing it would canonicalize bytes the author never touched
 * (§4).
 *
 * The rules are stateless: they do not know whether they have fired before, so
 * re-typing "## " inside a heading matches again. Every action is idempotent
 * for exactly that reason — an h2 asked to become an h2 is a no-op.
 */

import type { VeBlockFormat, VisualAction } from "./actions";
import type { VeMark } from "./model";

/** What a rule does, and how much typed text it consumes. */
export interface InputRuleMatch {
  /** Characters immediately before the caret that the rule swallows. */
  consumed: number;
  /**
   * Inline rules only: the literal text that takes the swallowed run's place,
   * and which `action` then marks. Block rules leave it undefined — they
   * swallow a marker and format what is already there.
   */
  text?: string;
  action: VisualAction;
}

/**
 * The rule block, spelled as the toolbar's Insert → Horizontal rule spells it
 * (`RULE_SNIPPET`, editor-toolbar-visual.tsx). Two ways of asking for the same
 * construct must insert the same bytes, or a page's history shows an edit
 * where there was none.
 */
const RULE_WIKITEXT = "----";

/**
 * Marker → heading level, both spellings in one table because they never
 * disagree. A lone "#" is absent on purpose (it is the numbered list) and so
 * are the six-deep markers: `VeBlockFormat` offers h2…h5, since h1 is the page
 * title and h6 is not a level this wiki writes.
 */
const HEADING_MARKERS: ReadonlyMap<string, VeBlockFormat> = new Map<string, VeBlockFormat>([
  ["##", "h2"],
  ["###", "h3"],
  ["####", "h4"],
  ["#####", "h5"],
  ["==", "h2"],
  ["===", "h3"],
  ["====", "h4"],
  ["=====", "h5"],
]);

/** A marker made only of dashes, long enough for either syntax's rule. */
function isRuleMarker(marker: string): boolean {
  if (marker.length < 3) return false;
  for (const char of marker) {
    if (char !== "-") return false;
  }
  return true;
}

/**
 * @param before  the block's text from its start up to the caret
 * @param empty   true when the block holds nothing but 'before'
 */
export function matchBlockRule(before: string, empty: boolean): InputRuleMatch | null {
  // The space is what completes a rule, so a bare "#" is still a "#" and an
  // author who wanted the character keeps it by not typing a space. And
  // because `before` starts at the block's start, demanding that the *whole*
  // of it be the marker is what confines these rules to a block's beginning:
  // "see ## below " is a sentence, not a heading.
  if (!before.endsWith(" ")) return null;
  const marker = before.slice(0, before.length - 1);
  if (marker === "") return null;
  const consumed = before.length;

  const heading = HEADING_MARKERS.get(marker);
  if (heading !== undefined) {
    return { consumed, action: { kind: "format", format: heading } };
  }

  switch (marker) {
    case "-":
    case "*":
      return { consumed, action: { kind: "list", list: "bullet" } };
    // The decided collision: wikitext's ordered list beats markdown's h1.
    case "#":
    case "1.":
      return { consumed, action: { kind: "list", list: "number" } };
    case ">":
    case ":":
      return { consumed, action: { kind: "indent", delta: 1 } };
    default:
      break;
  }

  // A rule *replaces* the block rather than re-formatting it, so unlike every
  // other rule here it may only fire where there is nothing to lose. An author
  // who puts the caret in front of a written paragraph and types "--- " keeps
  // their dashes and their paragraph.
  if (empty && isRuleMarker(marker)) {
    return { consumed, action: { kind: "insert", source: RULE_WIKITEXT, block: true } };
  }
  return null;
}

/**
 * The two inline rules, and deliberately only two. Single-asterisk italics are
 * not here: they collide with the bullet rule at a block's start and with
 * wikitext's own apostrophe emphasis everywhere else, and a rule that fires
 * when the author meant a literal asterisk is worse than no rule at all.
 * `forbidden` is what the content may not contain, which keeps a triple
 * asterisk and a nested backtick literal rather than guessing which delimiter
 * closed what.
 */
const INLINE_RULES: readonly { delimiter: string; forbidden: string; mark: VeMark }[] = [
  { delimiter: "**", forbidden: "*", mark: "bold" },
  { delimiter: "`", forbidden: "`", mark: "code" },
];

/**
 * Content that may be marked: something, and not padded with whitespace.
 * "a ** b" is arithmetic or a footnote star, not an opening delimiter.
 */
const INLINE_CONTENT = /^\S(?:[^\n]*\S)?$/;

/** Inline rules that fire on the closing character: bold and code. */
export function matchInlineRule(before: string): InputRuleMatch | null {
  for (const rule of INLINE_RULES) {
    if (!before.endsWith(rule.delimiter)) continue;
    const head = before.slice(0, before.length - rule.delimiter.length);
    // The *last* opening delimiter, so a second pair on a line marks its own
    // words rather than everything since the first pair.
    const open = head.lastIndexOf(rule.delimiter);
    if (open < 0) continue;
    const text = head.slice(open + rule.delimiter.length);
    if (!INLINE_CONTENT.test(text) || text.includes(rule.forbidden)) continue;
    return {
      consumed: text.length + rule.delimiter.length * 2,
      text,
      action: { kind: "mark", mark: rule.mark },
    };
  }
  return null;
}
