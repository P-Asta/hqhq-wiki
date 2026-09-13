/**
 * Find and replace, as pure functions over the editor's **buffer**
 * (docs/engine/visual-editor.md §9).
 *
 * The buffer is the search space in both modes, and that is the whole design:
 *
 * - **One implementation serves both surfaces.** Source mode edits the
 *   wikitext directly and visual mode edits a rendering of it, so a search
 *   written against either DOM would be a second search to write, to test and
 *   to keep in step. The one string both modes agree on is the wikitext.
 * - **A replacement can be exact.** A range here is a pair of offsets into the
 *   buffer, so applying one is a splice — no markup is consulted, invented or
 *   re-parsed, and §4's rule decides what publishes exactly as it does for a
 *   keystroke. It is also the only way to reach text the visual surface never
 *   shows: a name inside `{{Infobox moon|…}}` is an atomic node's `source`, and
 *   renaming it is precisely what an author opens this panel for.
 *
 * Three rules the matcher keeps, each of which a naive version gets wrong:
 *
 * 1. **The query is literal.** No `RegExp` is ever built from it, so `[[`,
 *    `{{`, `.` and `*` are characters rather than syntax. Whole-word is the one
 *    place a regex appears, and it tests a single *character* of the buffer.
 * 2. **Case folding preserves length.** An index into the folded haystack has
 *    to be an index into the original, or a replacement would land at the wrong
 *    offset — so a character whose lowercase is not one unit long (`İ` folds to
 *    two) is left unfolded. It costs one exotic case-insensitive match and buys
 *    exact offsets everywhere.
 * 3. **Matches never overlap.** `"aa"` occurs once in `"aaa"`, not twice: the
 *    scan resumes at the end of the match it took. Overlapping ranges cannot
 *    all be replaced, so counting them would print a number the buttons refuse
 *    to honour.
 *
 * Nothing here touches the DOM, so all of it runs under vitest's node
 * environment.
 */

import { parseDocument } from "@/lib/visual-editor/parse";

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

/** The two toggles the panel offers, and the only ones matching answers to. */
export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
}

/** A half-open range of the buffer: `text.slice(start, end)` is the hit. */
export interface FindMatch {
  start: number;
  end: number;
}

/**
 * What counts as being *inside* a word for the whole-word toggle. The same
 * class `src/lib/wikitext/external-links.ts` uses, and Unicode-aware on
 * purpose: this wiki's other locale is Korean, and a rule written `[A-Za-z]`
 * would call every Hangul syllable a word boundary.
 */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWordChar(char: string): boolean {
  return char !== "" && WORD_CHAR.test(char);
}

/**
 * Lowercase, one UTF-16 unit at a time, keeping any unit whose lowercase is
 * not exactly one unit long.
 *
 * Length preservation is the requirement here, not fidelity of the fold: the
 * offsets found in the folded string slice the *original*, so a fold that grew
 * or shrank a character would silently move every match after it. Surrogate
 * halves have no case mapping and therefore fold to themselves, which leaves
 * astral characters compared verbatim.
 */
function foldCase(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charAt(i);
    const lower = unit.toLowerCase();
    out += lower.length === 1 ? lower : unit;
  }
  return out;
}

/**
 * Whether a candidate hit stands on word boundaries.
 *
 * The boundary is only required where the *query's* own edge is a word
 * character — a query of `"[["` asks nothing of what precedes it, because it
 * does not begin inside a word in the first place. Requiring it regardless
 * would make whole-word silently refuse every query made of punctuation, which
 * reads as a broken toggle rather than as a rule.
 */
function isWholeWord(text: string, match: FindMatch, query: string): boolean {
  if (isWordChar(query.charAt(0)) && match.start > 0 && isWordChar(text.charAt(match.start - 1))) {
    return false;
  }
  return !(
    isWordChar(query.charAt(query.length - 1)) &&
    match.end < text.length &&
    isWordChar(text.charAt(match.end))
  );
}

/**
 * Every place `query` occurs in `text`, left to right and non-overlapping.
 *
 * An empty query matches nothing at all rather than matching everywhere: the
 * panel opens with an empty field, and a count of "1 of 4,812" over the gaps
 * between characters is not an answer to a question anybody asked.
 */
export function findMatches(text: string, query: string, options: FindOptions): FindMatch[] {
  if (query === "") return [];
  // Folding both sides keeps the comparison a plain `indexOf`, which is what
  // makes the query literal (rule 1) — there is no pattern to escape.
  const haystack = options.caseSensitive ? text : foldCase(text);
  const needle = options.caseSensitive ? query : foldCase(query);

  const out: FindMatch[] = [];
  let from = 0;
  while (from <= haystack.length) {
    const start = haystack.indexOf(needle, from);
    if (start < 0) break;
    const match: FindMatch = { start, end: start + needle.length };
    if (!options.wholeWord || isWholeWord(text, match, query)) {
      out.push(match);
      // Rule 3: resume past the hit, so `"aa"` finds one match in `"aaa"`.
      from = match.end;
    } else {
      // A refused candidate is not a hit, so the next one may well overlap it:
      // `"ab"` in `"xabab"` is refused at 1 and taken at 3.
      from = start + 1;
    }
  }
  return out;
}

/**
 * Which match the panel should stand on, given the offset it wants to be at or
 * after. `-1` when there is nothing to stand on.
 *
 * Wrapping to the first match when nothing follows the offset is what makes
 * next/previous cyclic — and, with the offset set past a replacement's output,
 * what stops "Replace" from stepping back into the text it has just written.
 */
export function matchIndexFrom(matches: readonly FindMatch[], offset: number): number {
  if (matches.length === 0) return -1;
  for (let index = 0; index < matches.length; index += 1) {
    if (matches[index].start >= offset) return index;
  }
  return 0;
}

/**
 * The last match that starts *before* the offset, wrapping to the final one
 * when none does. `-1` when there is nothing to stand on.
 *
 * {@link matchIndexFrom} read backwards, and what the up arrow needs: from a
 * strip that has not stepped anywhere yet, "previous" is the end of the article
 * rather than its start.
 */
export function matchIndexBefore(matches: readonly FindMatch[], offset: number): number {
  if (matches.length === 0) return -1;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    if (matches[index].start < offset) return index;
  }
  return matches.length - 1;
}

/* ------------------------------------------------------------------ */
/* Replacing                                                           */
/* ------------------------------------------------------------------ */

/** What one press of the panel's replace buttons asks for. */
export interface FindApplyRequest {
  query: string;
  replacement: string;
  options: FindOptions;
  /** Which match to replace, or `null` for every one of them. */
  index: number | null;
}

export interface FindApplyOutcome {
  /** The buffer afterwards — the same string when nothing matched. */
  text: string;
  replaced: number;
  /**
   * Where the replacement landed **in the new text**, so the caller can put it
   * on screen. For a replace-all it is the first of them: the count dropping to
   * zero is how the author learns the rest happened, and the first is the one
   * worth scrolling to.
   */
  landed: FindMatch | null;
}

/**
 * Replace one match, or all of them.
 *
 * **Replace-all never reads its own output.** The result is assembled by
 * copying the spans *between* the matches out of the original string, so a
 * replacement that contains the query (`cat` → `cats`, or `x` → `xx`) is copied
 * through once and never rescanned. Running the single-match path in a loop
 * would instead keep finding the query inside what it had just written.
 *
 * The caller hands in the text it wants this applied to — which is the *live*
 * buffer, read back off the surface, never the copy React state is holding
 * (visual-editor.md §9). Offsets are recomputed here against that string for
 * exactly that reason: an index computed a render earlier could name a
 * different span of a buffer that has taken a keystroke since.
 */
export function applyFindReplace(text: string, request: FindApplyRequest): FindApplyOutcome {
  const matches = findMatches(text, request.query, request.options);

  if (request.index !== null) {
    const match = matches[request.index];
    if (match === undefined) return { text, replaced: 0, landed: null };
    return {
      text: text.slice(0, match.start) + request.replacement + text.slice(match.end),
      replaced: 1,
      landed: { start: match.start, end: match.start + request.replacement.length },
    };
  }

  if (matches.length === 0) return { text, replaced: 0, landed: null };
  let out = "";
  let cursor = 0;
  let landed: FindMatch | null = null;
  for (const match of matches) {
    out += text.slice(cursor, match.start);
    if (landed === null) {
      landed = { start: out.length, end: out.length + request.replacement.length };
    }
    out += request.replacement;
    cursor = match.end;
  }
  out += text.slice(cursor);
  return { text: out, replaced: matches.length, landed };
}

/* ------------------------------------------------------------------ */
/* Showing a match                                                     */
/* ------------------------------------------------------------------ */

/** How much of the buffer either side of a match the panel prints. */
export const CONTEXT_RADIUS = 40;

export interface MatchContext {
  before: string;
  match: string;
  after: string;
  /** True where text was cut off, so the panel can print an ellipsis. */
  clippedBefore: boolean;
  clippedAfter: boolean;
}

/**
 * The match with a little of the buffer either side of it — the panel's answer
 * to "which one is this?", and the one thing that reads identically in both
 * modes, because it is drawn from the buffer rather than from a surface.
 *
 * Whitespace is collapsed because the strip is one line high: a match at the
 * end of a paragraph would otherwise print the blank line that follows it and
 * push its own text out of view.
 */
export function matchContext(
  text: string,
  match: FindMatch,
  radius: number = CONTEXT_RADIUS,
): MatchContext {
  const from = Math.max(0, match.start - radius);
  const to = Math.min(text.length, match.end + radius);
  const oneLine = (part: string): string => part.replace(/\s+/g, " ");
  return {
    before: oneLine(text.slice(from, match.start)),
    match: oneLine(text.slice(match.start, match.end)),
    after: oneLine(text.slice(match.end, to)),
    clippedBefore: from > 0,
    clippedAfter: to < text.length,
  };
}

/** Longest selection the panel will open with; past this it opens empty. */
export const MAX_SEED_LENGTH = 120;

/**
 * The query Ctrl/Cmd+F opens with, taken from whatever was selected — what
 * every editor does, and what turns "select the name, press the shortcut" into
 * a rename.
 *
 * A selection spanning lines, or longer than a name could be, is not a query
 * anybody meant to type: the panel opens empty rather than folding a paragraph
 * into a one-line field.
 */
export function seedQuery(selection: string): string {
  const trimmed = selection.trim();
  if (trimmed === "" || trimmed.length > MAX_SEED_LENGTH) return "";
  return /[\n\r]/.test(trimmed) ? "" : trimmed;
}

/* ------------------------------------------------------------------ */
/* Buffer offset → block (the visual surface's half of "show me")      */
/* ------------------------------------------------------------------ */

/**
 * Where one parsed block sits in the buffer: `text.slice(start, end)` is its
 * `source`, and `id` is what the surface wrote into `data-ve-id` (§3).
 *
 * `index` is the block's position in the document, and it is carried because it
 * is the *sturdier* of the two keys. Ids are assigned positionally by the
 * parser (`b0`, `b1`, …) but minted afresh for a block the author creates
 * (`n1`), so the surface and a re-parse of its buffer disagree about the id of
 * anything typed since the last document load. Their order never disagrees.
 */
export interface VeBlockSpan {
  id: string;
  index: number;
  start: number;
  end: number;
}

/**
 * The buffer, cut into the blocks the visual surface drew from it.
 *
 * This is the only bridge between an offset — which is all the matcher deals in
 * — and the DOM, and it is deliberately a *coarse* one: a block, not a
 * character. §4 is why. Marking a character range inside the contenteditable
 * would mean writing markup that `domToDocument` has to be taught to ignore
 * again, and the reader's rule is that markup wearing none of our labels is the
 * author's. A wrapper we forgot to strip would publish itself; a scroll and a
 * selection cannot, because they write nothing at all.
 *
 * The arithmetic is `serializeDocument`'s, restricted to the case that makes it
 * exact: a document straight out of `parseDocument` emits every block from its
 * own `source` and separates them with its own `gapAfter`, so the spans tile the
 * buffer end to end. Anything else — a null field, or a total that misses the
 * buffer's length because it held CRLF, which the parser folds and the buffer
 * did not — yields no spans at all rather than spans that are off by a little.
 * A caller with no spans simply does not scroll; a caller with wrong ones would
 * scroll to the wrong paragraph and claim it was the match.
 */
export function blockSpans(text: string): VeBlockSpan[] {
  const doc = parseDocument(text);
  const spans: VeBlockSpan[] = [];
  let offset = doc.leading.length;
  for (const block of doc.blocks) {
    const { source, gapAfter } = block;
    if (source === null || gapAfter === null) return [];
    spans.push({ id: block.id, index: spans.length, start: offset, end: offset + source.length });
    offset += source.length + gapAfter.length;
  }
  return offset === text.length ? spans : [];
}

/**
 * The block an offset falls in, or the one it follows.
 *
 * An offset can land in the whitespace *between* two blocks — a query made of
 * spaces is a legal query — and the block before it is the honest answer there:
 * that gap was written as part of leaving the block behind.
 */
export function blockSpanAt(spans: readonly VeBlockSpan[], offset: number): VeBlockSpan | null {
  let found: VeBlockSpan | null = null;
  for (const span of spans) {
    if (span.start > offset) break;
    found = span;
  }
  return found;
}

/**
 * How many earlier matches share this one's block — which occurrence of the
 * query, counted from the block's own start, the surface should select.
 *
 * The surface can only search its rendered text, and that text is the block's
 * wikitext minus its markup, so an ordinal is the strongest thing that survives
 * the crossing: the *n*-th "Artifice" in a paragraph is the *n*-th "Artifice"
 * however that paragraph spells its bold.
 */
export function occurrenceInSpan(
  matches: readonly FindMatch[],
  span: VeBlockSpan,
  index: number,
): number {
  let seen = 0;
  for (let i = 0; i < index && i < matches.length; i += 1) {
    const start = matches[i].start;
    if (start >= span.start && start < span.end) seen += 1;
  }
  return seen;
}
