/**
 * Stage 0 — normalize (spec §14.1).
 *
 * The only text-level rewriting the engine does before parsing:
 *
 * - CRLF / lone CR → LF, so every later stage may assume `\n`.
 * - A leading U+FEFF (BOM) is dropped.
 * - U+0000 and U+007F are removed everywhere. U+007F is the strip-marker
 *   sentinel (§0.5) and U+0000 the `#vswitch` sentinel; removing them here is
 *   what makes those markers unforgeable from author input.
 * - The text ends with exactly one `\n` (an empty page stays empty).
 *
 * Nothing else is decoded: entities are handled contextually by later stages.
 */

/** U+0000 and U+007F — the two sentinels §14.1 strips from author input. */
const FORBIDDEN = /[\u0000\u007f]/g;

/** Stage 0 (spec §14.1). */
export function normalize(source: string): string {
  let text = source.replace(/\r\n?/g, "\n");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(FORBIDDEN, "");
  if (text === "") return "";
  return text.endsWith("\n") ? text : `${text}\n`;
}
