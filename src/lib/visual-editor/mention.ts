/**
 * Reaching a page or a template without leaving the sentence — the sixth of
 * the Notion-shaped controls (docs/engine/visual-editor.md §1, §13).
 *
 * A wiki is written in links, and the hard part of writing one has never been
 * the brackets: it is remembering how the page is spelled. The link dialog
 * (§5.4) answers that with a combobox, but it costs the author the sentence —
 * a dialog opens, the selection goes, and the words come back afterwards. The
 * two things an author types *inside* the sentence are `[[` and `{{`, and this
 * module is what notices them.
 *
 *   `[[art…`      → the page index, and the row writes `[[Artifice]]`
 *   `@art…`       → the same list, for an author arriving from Notion
 *   `{{inf…`      → the `Template:` namespace, and the row opens §5.1's
 *                   parameter form on that template
 *
 * **It reads text and nothing else.** What is in front of the caret is a
 * string the surface hands over (`hostText`, visual-editor.tsx) — the same
 * string `slashContext` is asked about, and for the same reason: a rule that
 * looked at the DOM could not be tested under vitest's node environment, and
 * the DOM has nothing to say about this anyway.
 *
 * ## Why the triggers are the wikitext, and not a symbol of ours
 *
 * `[[` and `{{` are what an author who knows this wiki *already types*, and
 * the panel that appears is then a help rather than a mode: ignore it, finish
 * the brackets by hand, and exactly the same wikitext ends up in the buffer.
 * That is also why nothing here writes anything on its own — a trigger with no
 * row taken leaves the characters where they are, and dismissing the panel is
 * not an edit.
 *
 * `@` is the one borrowed symbol, because it is muscle memory for everybody
 * who has used a modern editor, and it is admitted only at a **word boundary**
 * so that an email address never opens a page search: in `crew@company` the
 * `@` follows a letter and means what it has always meant.
 *
 * ## What a trigger stops at
 *
 * A query never crosses a line, never contains the closing bracket it is
 * waiting for, and never contains a `|`: that character opens a link's *label*
 * (`[[target|label]]`, spec §5.3), and from then on the author is no longer
 * typing a page name. It is also capped — a "page name" the length of a
 * paragraph is a paragraph, and searching for it would be one request per
 * keystroke answering nothing.
 */

/** The two indexes a trigger can search. */
export type VeMentionKind = "page" | "template";

export interface VeMentionContext {
  kind: VeMentionKind;
  /** What has been typed after the trigger — the search's query. */
  query: string;
  /**
   * How many characters immediately before the caret the trigger and its query
   * occupy together. Taking a row deletes exactly this many and writes the row
   * in their place, which is the same contract `slashContext` has.
   */
  consumed: number;
}

/**
 * A query no longer than this is a page name; anything longer is prose that
 * happens to follow two brackets, and the panel gets out of the way.
 */
const MAX_QUERY = 80;

/** Characters that end a query wherever they appear in it. */
const STOPS: Record<VeMentionKind, RegExp> = {
  // `|` opens the label of a link, `]` closes it, `[`/`{` starts something
  // else, and a newline is another block.
  page: /[[\]{}|\n\r]/,
  template: /[{}[\]|\n\r]/,
};

/**
 * The trigger the caret is standing in, or null.
 *
 * The **nearest** trigger wins where there are several, because that is the
 * one being typed: in `[[Ship {{` the author has moved on to a template, and a
 * panel still searching pages would be answering a question they finished
 * asking.
 */
export function mentionContext(before: string): VeMentionContext | null {
  const candidates: VeMentionContext[] = [];

  const brackets = before.lastIndexOf("[[");
  if (brackets >= 0) candidates.push(...at(before, brackets, 2, "page"));

  const braces = before.lastIndexOf("{{");
  if (braces >= 0) candidates.push(...at(before, braces, 2, "template"));

  // `@`, at a word boundary only: in `crew@company` it is an address.
  const sign = before.lastIndexOf("@");
  if (sign >= 0 && !isWordCharacter(before[sign - 1])) {
    candidates.push(...at(before, sign, 1, "page"));
  }

  if (candidates.length === 0) return null;
  // The nearest to the caret is the one with the *shortest* run behind it.
  return candidates.reduce((best, one) => (one.consumed < best.consumed ? one : best));
}

/** The trigger at `index`, if what follows it is still a query. */
function at(
  before: string,
  index: number,
  width: number,
  kind: VeMentionKind,
): [VeMentionContext] | [] {
  const query = before.slice(index + width);
  if (query.length > MAX_QUERY) return [];
  if (STOPS[kind].test(query)) return [];
  // `@` alone in running text is not a search: it opens one only where it
  // begins a word, and the two-character triggers open one immediately.
  return [{ kind, query, consumed: query.length + width }];
}

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}_.\-+@]/u.test(character);
}

/**
 * What taking a row writes.
 *
 * A page becomes the link itself, because that is what the author was already
 * spelling. A template becomes the **call with no parameters**, which is not
 * what gets inserted: it is the `initialSource` §5.1's dialog opens on, so the
 * author lands on that template's parameter form rather than on a bare pair of
 * braces. The distinction matters for an infobox, where the braces alone are a
 * call that renders nothing.
 */
export function mentionWikitext(kind: VeMentionKind, name: string): string {
  return kind === "page" ? `[[${name}]]` : `{{${name}}}`;
}
