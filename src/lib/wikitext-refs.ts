/**
 * The named references a page already cites — the reading of the buffer behind
 * the CITE menu's re-use rows (docs/engine/visual-editor.md §1).
 *
 * After the first citation of a source, almost every later one is a *repeat*,
 * and wikitext spells a repeat as a second `<ref>` carrying the same `name=`
 * and no body at all (wikitext-spec §10.3). Typing that by hand means
 * remembering a name written twenty paragraphs earlier and spelling it
 * identically — Cite keys a footnote by its name byte for byte, so `Hutchins`
 * and `hutchins` are two sources and the second one prints "no text provided
 * for ref". So the menu offers the names the page already carries, and this
 * module is what finds them.
 *
 * **It walks the highlighter's tokens, not the raw source.** A
 * `<ref name="x" />` inside `<nowiki>`, `<pre>` or an HTML comment is writing
 * *about* a citation rather than a citation, and `highlight()` has already
 * drawn that line: those bodies arrive as single opaque `nowiki`/`comment`
 * tokens, so a scan that reads only `tag` tokens can never mistake a quoted
 * example for a real ref. `versionsUsed` and `templatesUsed` read the same
 * buffer the same way (src/lib/wikitext-highlight.ts), and sharing the reading
 * is what keeps the three of them agreeing about what is quoted.
 *
 * **What it will not offer**, because offering it would put a second broken
 * citation on the page beside the first:
 *
 * - *A name the engine refuses.* §10.3 admits letters, digits and `-_. :` and
 *   rejects an all-digit name; anything else already renders `Cite error:
 *   invalid ref name` where it was defined. The rule is a local copy of the
 *   engine's `isValidRefName` — this module runs in the browser and the engine
 *   is server-side, the same trade `version-branches.ts` makes for the version
 *   grammar — and the copy is pinned against the original by a drift test.
 * - *A group that cannot be quoted.* Cite keys a footnote by group **and**
 *   name, so `<ref name="x" />` written outside `x`'s group names a different,
 *   undefined ref; the reuse form therefore has to repeat `group=`, and a group
 *   holding a quote or an angle bracket has no faithful spelling inside one.
 *
 * Nothing here parses, expands or renders: it reports what the buffer says, and
 * an empty answer means the menu offers no re-use rows at all. Pure and
 * DOM-free, so all of it is unit-tested in vitest's node environment.
 */

import { highlight, type HighlightToken } from "@/lib/wikitext-highlight";

/** One named footnote the buffer already carries. */
export interface NamedRef {
  /**
   * `name=` exactly as the page spelled it. Never folded: Cite's registry is
   * keyed on the literal string, so the reuse form has to repeat these bytes.
   */
  readonly name: string;
  /** `group=` as written; `""` is Cite's default group (spec §10.3). */
  readonly group: string;
  /**
   * The defining body, verbatim — what a menu row shows so an author can tell
   * one source from another. `""` when the page only ever *reuses* this name:
   * the definition lives in a template, inside `<references>` on another
   * branch, or nowhere yet.
   */
  readonly body: string;
}

/**
 * One HTML tag, tolerating a quoted attribute value that contains `>`. Lazy in
 * the attribute run so a self-closing `/` lands in its own group instead of
 * being eaten as an attribute character — `<ref name=x/>` closes itself.
 *
 * A third copy of a shape `version-tags.ts` and `version-edit.ts` also keep;
 * folding them into one lexer belongs with whichever phase owns them all.
 */
const REF_TAG_RE = /^<(\/?)([A-Za-z][A-Za-z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>$/;

/**
 * `key="value"`, `key='value'` and bare `key=value`, in any case — a copy of
 * the preprocessor's own `ATTR_RE`, so "any attribute spelling" here means
 * exactly what it means to the engine.
 */
const ATTR_RE = /([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]*)))?/g;

/** Letters/digits/`-_. :`; a purely numeric name is an error (spec §10.3). */
const REF_NAME_RE = /^[\p{L}\p{N}\-_. :]+$/u;

/** What cannot ride inside `="…"` unescaped, and §4 forbids us escaping it. */
const UNQUOTABLE_RE = /["<>\n\r]/;

/**
 * Attributes of one tag, lower-cased keys, bare attributes mapping to `""` —
 * the engine's `parseAttributes` (preprocessor.ts), copied for the browser.
 */
function tagAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (raw === "") return attrs;
  ATTR_RE.lastIndex = 0;
  for (let m = ATTR_RE.exec(raw); m !== null; m = ATTR_RE.exec(raw)) {
    if (m[0].trim() === "") continue;
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

/** A ref name the engine will register rather than reject (spec §10.3). */
export function isUsableRefName(name: string): boolean {
  if (name === "" || !REF_NAME_RE.test(name)) return false;
  return !/^\d+$/.test(name.trim());
}

interface RefTag {
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly attrs: Record<string, string>;
}

/** The token read as a `<ref>` tag, or null when it is anything else. */
function readRefTag(token: HighlightToken): RefTag | null {
  if (token.type !== "tag") return null;
  const m = REF_TAG_RE.exec(token.text);
  if (m === null || m[2].toLowerCase() !== "ref") return null;
  return { closing: m[1] === "/", selfClosing: m[4] === "/", attrs: tagAttributes(m[3]) };
}

/**
 * Every named reference in `source`, in the order a reader meets them — which
 * is also the order Cite numbers them, so the rows read like the footnote list
 * the page will print.
 *
 * A name is listed once per group. Where the same name appears twice the
 * **defining** body wins and the first definition beats a later one, because
 * that is the one Cite renders: a second body that differs only raises a
 * warning (§10.3). Reuse before definition is legal, so a name is often met
 * without a body before the paragraph that defines it.
 *
 * An unclosed `<ref>` swallows the rest of the buffer, exactly as the engine
 * has it (§10) — so whatever follows is that ref's body rather than a citation
 * of its own, and the scan stops there for the same reason the page does.
 */
export function namedRefsUsed(source: string): NamedRef[] {
  const tokens = highlight(source);
  const found = new Map<string, NamedRef>();
  const order: string[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const tag = readRefTag(tokens[i]);
    // A stray `</ref>` names nothing: the engine shows it as literal text
    // (§10.7), and a row for it would offer to reuse a footnote that is not on
    // the page.
    if (tag === null || tag.closing) continue;

    // The body is walked even for a ref this will not offer, so that its
    // `</ref>` is stepped over and its contents cannot be read as markup.
    let body = "";
    if (!tag.selfClosing) {
      const parts: string[] = [];
      let j = i + 1;
      for (; j < tokens.length; j += 1) {
        const inner = readRefTag(tokens[j]);
        // Cite does not nest (§10.3) — an inner `<ref>` renders as literal
        // text — so the first closer is this ref's, whoever wrote it.
        if (inner !== null && inner.closing) break;
        parts.push(tokens[j].text);
      }
      body = parts.join("");
      i = j;
    }

    const name = tag.attrs.name ?? "";
    const group = tag.attrs.group ?? "";
    if (!isUsableRefName(name) || UNQUOTABLE_RE.test(group)) continue;

    // A newline is in neither half — the name's character class has no room
    // for one, and a group carrying one was refused just above — so this key
    // can never confuse `group="a" name="b c"` with `group="a b" name="c"`.
    const key = [group, name].join("\n");
    const seen = found.get(key);
    if (seen === undefined) {
      found.set(key, { name, group, body });
      order.push(key);
    } else if (seen.body === "" && body !== "") {
      found.set(key, { name, group, body });
    }
  }

  return order.flatMap((key) => {
    const ref = found.get(key);
    return ref === undefined ? [] : [ref];
  });
}

/**
 * The wikitext that cites `ref` again: `<ref name="x" />`, plus the group when
 * it has one (spec §10.3, confirmed against `POST /api/preview` — a reuse that
 * drops the group prints `Cite error: no text provided for ref`, because it
 * names a different footnote over in the default group).
 *
 * Neither value is escaped and neither needs to be: `namedRefsUsed` offers only
 * names the engine's own character class admits and groups with no quote in
 * them, so this is the whole of the spelling.
 */
export function refReuseWikitext(ref: Pick<NamedRef, "name" | "group">): string {
  const group = ref.group === "" ? "" : ` group="${ref.group}"`;
  return `<ref name="${ref.name}"${group} />`;
}

/** How much of a footnote a menu row shows before it starts eliding. */
export const REF_EXCERPT_MAX = 72;

/**
 * A footnote's body as one line, for a row that has to fit inside a menu.
 *
 * The wikitext is shown as written rather than rendered: a menu cannot afford a
 * preview request per row, and the source is what the author typed — the same
 * choice the link dialog makes when it shows the markup it will write instead
 * of a sentence describing it.
 *
 * Truncation counts code points rather than UTF-16 units, so an emoji or a
 * Hangul syllable sitting on the boundary is never cut in half.
 */
export function refExcerpt(body: string, max: number = REF_EXCERPT_MAX): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const points = Array.from(flat);
  if (points.length <= max) return flat;
  return `${points.slice(0, max).join("").trimEnd()}…`;
}
