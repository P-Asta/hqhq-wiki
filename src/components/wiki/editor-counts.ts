/**
 * The publish bar's word and character count (docs/engine/visual-editor.md
 * §10.2).
 *
 * Two rules shaped every line of this file, and they pull against each other.
 *
 * **It must not cost a keystroke** (§8's rule, which the whole editor keeps).
 * So the scan is one pass over the buffer with no allocation at all: no
 * `split`, no `match`, no regex — `"a b c".split(/\s+/)` builds one string per
 * word, and on a long article that is a few thousand short-lived objects per
 * keystroke for a number nobody is reading that closely. The caller memoises it
 * on the buffer, so it runs once per change rather than once per render.
 *
 * **It has to be true for Korean**, which is a first-class locale here. Two
 * consequences: the whitespace set is JavaScript's own `\s` — spelled out here
 * rather than tested with a regex — which *includes* U+3000, the ideographic
 * space CJK text is really written with, and a word is a run of non-whitespace,
 * which is the eojeol Korean actually separates. A rule written against
 * `[A-Za-z]` would count a whole Korean sentence as nothing.
 *
 * **What is counted is the buffer**, i.e. the wikitext, braces and all — not
 * the prose the engine renders from it. That is a deliberate limitation and
 * the honest one: the buffer is the one string both editing modes share (the
 * same argument §9.1 makes for find and replace), and counting rendered prose
 * would mean running the engine on every keystroke to answer a number in the
 * corner of the screen.
 */

/**
 * JavaScript's `\s`, as code points, so a single pass can ask without building
 * a regex match per character. The ranges are `\t\n\v\f\r`, the space,
 * NBSP, the Unicode space separators (Zs) and the two line/paragraph
 * separators, plus U+FEFF — which is exactly what the spec lists.
 */
function isSpace(code: number): boolean {
  if (code === 0x20) return true;
  if (code >= 0x09 && code <= 0x0d) return true;
  if (code < 0x80) return false;
  if (code === 0xa0 || code === 0x1680 || code === 0xfeff) return true;
  if (code >= 0x2000 && code <= 0x200a) return true;
  return code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000;
}

/** A UTF-16 unit that only ever appears as the second half of a pair. */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export interface TextCounts {
  /** Runs of non-whitespace — the eojeol in Korean, the word in English. */
  words: number;
  /**
   * Characters as a reader counts them: **code points**, not UTF-16 units, so
   * one emoji is one character rather than the two units `String.length`
   * reports. Whitespace counts; it is text the author typed.
   */
  characters: number;
}

/** One pass, no allocation. See the module comment for why that matters. */
export function countText(text: string): TextCounts {
  let words = 0;
  let characters = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    // A surrogate pair is one character and never whitespace, so the trailing
    // half is skipped for the count and treated as ordinary word material.
    if (!isLowSurrogate(code)) characters += 1;
    if (isSpace(code)) {
      inWord = false;
      continue;
    }
    if (!inWord) {
      inWord = true;
      words += 1;
    }
  }
  return { words, characters };
}
