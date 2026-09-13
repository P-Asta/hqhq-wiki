/**
 * Rewriting the retired version grammar into the tag-name one — the transform
 * behind docs/engine/versioning.md §2.2's mapping table.
 *
 * `<versions>`, `<variant>` and `<version>` stopped being recognised when the
 * version id became the tag name (§2.1). They do not fail loudly: §10.7 escapes
 * an unknown tag, so a page still written the old way shows its own markup to
 * readers as literal text. That is why this is a conversion and not a
 * deprecation notice — every occurrence has to move, in the seed content and in
 * the stored database alike (scripts/migrate-version-tags.ts).
 *
 * The whole transform is here, pure and exported, for the reason
 * `version-edit.ts` gives for its own: a rewrite that moves an author's
 * paragraphs is not something to do with a regex at three call sites. One
 * function, one test file, one behaviour for the seed and for the migration.
 *
 * What it will not do:
 *
 * - **Touch a quoted example.** Comments and raw-text elements (`<nowiki>`,
 *   `<pre>`, `<syntaxhighlight>`, `<source>`) are masked before anything is
 *   matched. The seeded Help page documents the old grammar inside `<pre>`
 *   blocks; after the change those blocks are prose *about* history and must
 *   survive verbatim, so they are counted ({@link LegacyConversion.quoted})
 *   rather than rewritten.
 * - **Guess.** A construct with no faithful spelling in the new grammar is left
 *   exactly as written and reported in {@link LegacyConversion.skipped}: prose
 *   parked between two variants (which the old engine dropped and the new
 *   grammar would show), an `only=` crossed with a `since=`, two branches
 *   naming one boundary, an id nothing can order. A page that comes back with
 *   skips is a page a person has to read, which is a better outcome than a
 *   page that comes back silently different.
 * - **Do arithmetic on version ids.** A group's branch ends "one version below
 *   the next", and *one below* is a registry lookup — the newest registered id
 *   strictly below the next branch — never `next - 1`. `v70` and `v80` with
 *   nothing between them give `<v70+v70>`, which is written `<v70>`. That is
 *   the same rule `pageVersionBranches` (src/lib/version-branches.ts) draws the
 *   selector's chips with; it differs only in the floor, because a *branch*
 *   that covers no registered version still covers its own id.
 * - **Throw.** Markup this cannot read comes back exactly as it arrived.
 *
 * The one place the mapping is not rendering-identical is the `*` fallback, and
 * that is the user's decision recorded in §2.2: `<variant since="*">` becomes
 * untagged prose, because untagged prose is what "belongs to every version"
 * means now and the new grammar has no window that is open *below*. Where the
 * old fallback was written as a replacement for the later branches rather than
 * as shared lead-in, converting it leaves both sentences on screen at once —
 * which is why such a page shows up as a diff a person approves, never as an
 * `UPDATE` behind the history's back.
 */

import {
  branchEnd,
  versionOrdinal,
  versionTagName,
  type VersionRegistryEntry,
} from "@/lib/version-branches";

/** Why one construct was left exactly as it was written. */
export type LegacySkipReason =
  /** The construct never closes; the engine ran it to the end of the input. */
  | "unclosed"
  /** A `<versions>` group holding something other than variants and whitespace. */
  | "stray-content"
  /** A `<versions>` group with no variants in it at all. */
  | "no-branches"
  /** An attribute combination the new grammar has no faithful spelling for. */
  | "attributes"
  /** An id that is not `v<major>[.<minor>]`, so nothing can order it. */
  | "malformed-id"
  /** Two branches naming one boundary — a boundary that shadows itself. */
  | "duplicate-id"
  /** Constructs nested past the depth guard; hostile input, not authored input. */
  | "too-deep"
  /** The scan itself failed. Nothing is rewritten and nothing is thrown. */
  | "unreadable";

/** One construct the conversion refused, located so a report can point at it. */
export interface LegacySkip {
  /** Offset of the opening tag in the source it was found in. */
  readonly at: number;
  /** The opening tag as written — what a report shows the person reading it. */
  readonly tag: string;
  readonly reason: LegacySkipReason;
}

export interface LegacyConversion {
  /** The source with every convertible construct rewritten. */
  readonly text: string;
  /** How many constructs were rewritten; `0` means nothing changed. */
  readonly changed: number;
  /** Constructs left as written, each with the reason (see {@link LegacySkip}). */
  readonly skipped: readonly LegacySkip[];
  /**
   * Old-grammar tags inside comments and raw-text elements, left alone on
   * purpose. Not a failure: it is how a page documents the grammar it used to
   * use. Counted so a migration report can say the page still mentions it.
   */
  readonly quoted: number;
}

/* ------------------------------------------------------------------ */
/* Lexical tables                                                      */
/* ------------------------------------------------------------------ */

/**
 * One HTML tag, tolerating quoted attribute values that contain `>`. Copied
 * from `version-edit.ts` — which copied it from `parse.ts` — rather than
 * imported, so this module leaves those files' exports as they are while the
 * editor phase is still moving. Three copies is two too many; folding them into
 * one lexer belongs with whichever phase owns them all.
 */
const TAG_RE = /<(\/?)([A-Za-z][A-Za-z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/y;

/** `key="value"`, `key='value'` and bare `key=value`, in any case. */
const ATTR_RE = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>/]+))/g;

/** Elements whose body is raw text (wikitext-spec §10.1, §10.2, §10.5). */
const RAW_TEXT_TAGS: ReadonlySet<string> = new Set(["nowiki", "pre", "syntaxhighlight", "source"]);

/** The three names that stopped being recognised (versioning.md §2.2). */
const LEGACY_TAGS: ReadonlySet<string> = new Set(["versions", "version", "variant"]);

const GROUP_TAG = "versions";
const VARIANT_TAG = "variant";

/** The `*` fallback: "every version below the lowest branch" (retired §2.2). */
const FALLBACK = "*";

/** A version id, exactly as the engine's tag-name grammar spells one (§2.1). */
const ID_RE = /^v\d+(?:\.\d+)?$/i;

/** Whitespace is the only thing allowed to sit between a group's variants. */
const BLANK_RE = /^\s*$/;

/** Nested constructs past this are hostile input; they are left alone. */
const MAX_DEPTH = 64;

/** Retired tag names as they appear inside a masked stretch (a `<pre>` example). */
const QUOTED_RE = /<\/?\s*(?:versions|version|variant)\b/gi;

/* ------------------------------------------------------------------ */
/* Masking: comments and raw-text elements                             */
/* ------------------------------------------------------------------ */

interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * The first `</name…>` after `from`, or -1. A raw-text element closes on a
 * literal search, never on depth counting (spec §10.1); the memo of where the
 * *last* closer sits keeps a buffer full of unclosed openers linear.
 */
function rawClose(text: string, from: number, name: string, memo: Map<string, number>): number {
  let last = memo.get(name);
  if (last === undefined) {
    const all = new RegExp(`</${name}\\s*>`, "gi");
    last = -1;
    for (let m = all.exec(text); m !== null; m = all.exec(text)) last = m.index;
    memo.set(name, last);
  }
  if (from > last) return -1;
  const re = new RegExp(`</${name}\\s*>`, "gi");
  re.lastIndex = from;
  const m = re.exec(text);
  return m === null ? -1 : m.index + m[0].length;
}

/**
 * The stretches of `text` that hold no markup: HTML comments and raw-text
 * elements, each taken whole, tags included. This is the rule that makes the
 * Help page's `<pre>` examples safe.
 *
 * Both degenerate shapes follow the engine and run to the end of the buffer: an
 * unterminated `<!--` swallows the rest of the input (§10.8) and so does an
 * unterminated `<nowiki>` (`findClosingTag`, preprocessor.ts).
 */
function protectedSpans(text: string): Span[] {
  const spans: Span[] = [];
  const lastClose = new Map<string, number>();
  const lastGt = text.lastIndexOf(">");
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt === -1) break;
    if (text.startsWith("<!--", lt)) {
      const close = text.indexOf("-->", lt + 4);
      const end = close === -1 ? text.length : close + 3;
      spans.push({ start: lt, end });
      i = end;
      continue;
    }
    // Past the last `>` no tag can close, so the lazy attribute run would read
    // to the end of the buffer once per `<`: linear vs quadratic on a buffer of
    // half-typed openers.
    if (lt > lastGt) break;
    TAG_RE.lastIndex = lt;
    const m = TAG_RE.exec(text);
    if (m === null) {
      i = lt + 1;
      continue;
    }
    const openEnd = lt + m[0].length;
    const name = m[2].toLowerCase();
    if (m[1] === "/" || !RAW_TEXT_TAGS.has(name)) {
      i = openEnd;
      continue;
    }
    if (m[4] === "/") {
      spans.push({ start: lt, end: openEnd });
      i = openEnd;
      continue;
    }
    const found = rawClose(text, openEnd, name, lastClose);
    spans.push({ start: lt, end: found === -1 ? text.length : found });
    i = found === -1 ? text.length : found;
  }
  return spans;
}

/* ------------------------------------------------------------------ */
/* Tags                                                                */
/* ------------------------------------------------------------------ */

interface TagMatch {
  readonly start: number;
  readonly end: number;
  readonly attrs: string;
  /** Lowercased element name. */
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
}

/** Every tag outside the masked stretches, in source order. */
function scanTags(text: string, spans: readonly Span[]): TagMatch[] {
  const out: TagMatch[] = [];
  const lastGt = text.lastIndexOf(">");
  let i = 0;
  let cursor = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt === -1 || lt > lastGt) break;
    while (cursor < spans.length && spans[cursor].end <= lt) cursor += 1;
    if (cursor < spans.length && spans[cursor].start <= lt) {
      i = spans[cursor].end;
      continue;
    }
    TAG_RE.lastIndex = lt;
    const m = TAG_RE.exec(text);
    if (m === null) {
      i = lt + 1;
      continue;
    }
    out.push({
      start: lt,
      end: lt + m[0].length,
      attrs: m[3],
      name: m[2].toLowerCase(),
      closing: m[1] === "/",
      selfClosing: m[4] === "/",
    });
    i = lt + m[0].length;
  }
  return out;
}

/**
 * For every opening tag, the index of the closing tag that matches it, or null
 * when it never closes. One stack per element name, resolved in a single pass.
 */
function pairTags(tags: readonly TagMatch[]): (number | null)[] {
  const close: (number | null)[] = tags.map(() => null);
  const stacks = new Map<string, number[]>();
  for (let i = 0; i < tags.length; i += 1) {
    const tag = tags[i];
    if (tag.selfClosing) continue;
    let stack = stacks.get(tag.name);
    if (stack === undefined) {
      stack = [];
      stacks.set(tag.name, stack);
    }
    if (!tag.closing) {
      stack.push(i);
      continue;
    }
    const open = stack.pop();
    if (open !== undefined) close[open] = i;
  }
  return close;
}

/** Old-grammar tags hiding inside the masked stretches — documentation, not markup. */
function countQuoted(text: string, spans: readonly Span[]): number {
  let n = 0;
  for (const span of spans) {
    QUOTED_RE.lastIndex = 0;
    const slice = text.slice(span.start, span.end);
    for (let m = QUOTED_RE.exec(slice); m !== null; m = QUOTED_RE.exec(slice)) n += 1;
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* Attributes                                                          */
/* ------------------------------------------------------------------ */

/**
 * Attribute values of one open tag, lowercased names. Anything the retired
 * grammar did not read — a `label`, a stray `class` — is carried here and then
 * ignored, which is exactly what the old engine did with it: a resolved version
 * construct emitted its inner text and no wrapper, so no attribute of it ever
 * reached the HTML.
 */
function parseAttrs(attrs: string): Map<string, string> {
  const out = new Map<string, string>();
  ATTR_RE.lastIndex = 0;
  for (let m = ATTR_RE.exec(attrs); m !== null; m = ATTR_RE.exec(attrs)) {
    const value: string = m[2] ?? m[3] ?? m[4] ?? "";
    if (!out.has(m[1].toLowerCase())) out.set(m[1].toLowerCase(), value);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Emitting the new grammar                                            */
/* ------------------------------------------------------------------ */

/**
 * Ids are emitted lowercase, the spelling the registry keeps them in, so
 * `version_boundaries` lines up with `versions.id` after the rewrite. Case
 * carries no meaning either side of the change: the engine folds a tag name
 * before matching it (§2.1) and `sortBoundaries` folds a boundary before
 * comparing it.
 */
function foldId(raw: string): string {
  return raw.trim().toLowerCase();
}

/** `<v70>` · `<v70+v80>` · `<v70+>` around one body (§2.1). */
function tagged(from: string, to: string | null, body: string): string {
  const name = versionTagName({ from, to });
  return `<${name}>${body}</${name}>`;
}

/* ------------------------------------------------------------------ */
/* Plans — what one old construct means                                */
/* ------------------------------------------------------------------ */

type Plan =
  /** `since="*"` and nothing else: prose that belongs to every version. */
  | { readonly kind: "always" }
  /** `since=` with an optional `until=`: one window, both ends inclusive. */
  | { readonly kind: "window"; readonly from: string; readonly to: string | null }
  /** `only="a,b"`: the same passage under each id, which is what §2.2 maps it to. */
  | { readonly kind: "each"; readonly ids: readonly string[] };

type PlanResult =
  | { readonly ok: true; readonly plan: Plan }
  | { readonly ok: false; readonly reason: LegacySkipReason };

function refuse(reason: LegacySkipReason): PlanResult {
  return { ok: false, reason };
}

/**
 * What a standalone `<version>` — or a `<variant>` outside any group, which
 * §2.6 defines as the same thing — asks for.
 *
 * `only` crossed with `since`/`until` is refused rather than intersected: the
 * two were a conjunction, and an intersection is exactly the kind of arithmetic
 * that puts one version's text under another version's id.
 */
function planSpan(attrs: Map<string, string>): PlanResult {
  const only = attrs.get("only");
  const since = attrs.get("since");
  const until = attrs.get("until");

  if (only !== undefined) {
    if (since !== undefined || until !== undefined) return refuse("attributes");
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const raw of only.split(",")) {
      const id = raw.trim();
      if (id === "") continue;
      if (!ID_RE.test(id)) return refuse("malformed-id");
      const key = foldId(id);
      // `only="v56,v56"` rendered once; emitting it twice would render it twice.
      if (seen.has(key)) continue;
      seen.add(key);
      ids.push(id);
    }
    if (ids.length === 0) return refuse("attributes");
    return { ok: true, plan: { kind: "each", ids } };
  }

  if (since === undefined) {
    // A bare `until=`, or no attributes at all, means "everything up to here" —
    // a window open *below*, which the new grammar cannot spell. Naming the
    // oldest registered id as its floor would be this module inventing a
    // boundary the author never wrote.
    return refuse("attributes");
  }

  const from = since.trim();
  if (from === FALLBACK) {
    // `since="*" until="v61"` is that same open-below window; only the bare
    // fallback maps cleanly, and it maps to prose with no tag around it.
    if (until !== undefined) return refuse("attributes");
    return { ok: true, plan: { kind: "always" } };
  }
  if (!ID_RE.test(from)) return refuse("malformed-id");
  if (until === undefined) return { ok: true, plan: { kind: "window", from, to: null } };
  const to = until.trim();
  if (!ID_RE.test(to)) return refuse("malformed-id");
  return { ok: true, plan: { kind: "window", from, to } };
}

/* ------------------------------------------------------------------ */
/* Branch ends — the registry, never arithmetic                        */
/* ------------------------------------------------------------------ */

/** The earlier of a branch's own `until=` and the end the next branch imposes. */
function cappedEnd(
  from: string,
  computed: string | null,
  until: string | null,
  registry: readonly VersionRegistryEntry[],
): string | null {
  if (until === null) return computed;
  if (computed === null) return until;
  const a = versionOrdinal(until, registry);
  const b = versionOrdinal(computed, registry);
  if (a === null || b === null) return until;
  return a < b ? until : computed;
}

/* ------------------------------------------------------------------ */
/* The walk                                                            */
/* ------------------------------------------------------------------ */

interface Ctx {
  readonly text: string;
  readonly tags: readonly TagMatch[];
  readonly close: readonly (number | null)[];
  readonly registry: readonly VersionRegistryEntry[];
  readonly skipped: LegacySkip[];
  changed: number;
}

/** A construct rewritten: its replacement, and where the walk carries on. */
interface Built {
  readonly text: string;
  /** Offset just past the construct in the source. */
  readonly end: number;
  /** Index just past the construct's last tag. */
  readonly nextTag: number;
}

function skip(ctx: Ctx, tag: TagMatch, reason: LegacySkipReason): null {
  ctx.skipped.push({ at: tag.start, tag: ctx.text.slice(tag.start, tag.end), reason });
  return null;
}

/**
 * Convert every construct between two tag indices, splicing the untouched text
 * around them back in.
 *
 * A construct this refuses is stepped over whole, innards included: rewriting
 * the `<variant>`s inside a group that was itself refused would turn branches
 * of one group into three standalone tags, which is a different page.
 */
function convertRange(
  ctx: Ctx,
  tagFrom: number,
  tagTo: number,
  textStart: number,
  textEnd: number,
  depth: number,
): string {
  let out = "";
  let cursor = textStart;
  let i = tagFrom;

  while (i < tagTo) {
    const tag = ctx.tags[i];
    if (tag.closing || !LEGACY_TAGS.has(tag.name)) {
      i += 1;
      continue;
    }
    // A closer outside this range belongs to something else; from in here the
    // construct never closes.
    const paired = tag.selfClosing ? null : ctx.close[i];
    const closeIdx = paired !== null && paired < tagTo ? paired : null;

    const built =
      depth > MAX_DEPTH
        ? skip(ctx, tag, "too-deep")
        : tag.name === GROUP_TAG
          ? convertGroup(ctx, i, closeIdx, depth)
          : convertSpan(ctx, i, closeIdx, depth);

    if (built === null) {
      // A refused construct that never closes swallowed the rest of the input
      // (§10, and the engine still does), so everything after it was *inside*
      // it. Converting on past it would lift branches out of a group that,
      // broken as it is, still contains them. A self-closing one swallows
      // nothing, so the scan carries straight on past it.
      if (closeIdx === null) {
        if (!tag.selfClosing) break;
        i += 1;
        continue;
      }
      i = closeIdx + 1;
      continue;
    }
    out += ctx.text.slice(cursor, tag.start) + built.text;
    cursor = built.end;
    i = built.nextTag;
    ctx.changed += 1;
  }

  return out + ctx.text.slice(cursor, textEnd);
}

/** The body of a construct, itself converted — version tags nest (§2.6). */
function innerText(ctx: Ctx, openIdx: number, closeIdx: number | null, depth: number): string {
  const open = ctx.tags[openIdx];
  if (closeIdx === null) return "";
  return convertRange(ctx, openIdx + 1, closeIdx, open.end, ctx.tags[closeIdx].start, depth + 1);
}

/** `<version …>` and a stray `<variant …>`: one passage with a range (§2.2). */
function convertSpan(
  ctx: Ctx,
  openIdx: number,
  closeIdx: number | null,
  depth: number,
): Built | null {
  const open = ctx.tags[openIdx];
  const planned = planSpan(parseAttrs(open.attrs));
  if (!planned.ok) return skip(ctx, open, planned.reason);
  const plan = planned.plan;

  // An unclosed construct ran to the end of the input, and so does its
  // replacement — the new grammar swallows the same way (§2.1), so rewriting
  // the opener alone is faithful. It is refused only for `only=`, whose
  // replacement needs the body once per id and there is no body to copy.
  const unclosed = closeIdx === null && !open.selfClosing;
  if (unclosed && plan.kind === "each") return skip(ctx, open, "unclosed");

  const body = innerText(ctx, openIdx, closeIdx, depth);
  const end = closeIdx === null ? open.end : ctx.tags[closeIdx].end;
  const nextTag = closeIdx === null ? openIdx + 1 : closeIdx + 1;

  if (plan.kind === "always") {
    // The tags simply go: prose with nothing around it belongs to every
    // version, which is what `since="*"` asked for.
    return { text: body, end, nextTag };
  }
  if (plan.kind === "window") {
    // Unclosed: there is no closing tag to rewrite, only the opener — and the
    // new opener swallows the rest of the input exactly as the old one did.
    const text = unclosed
      ? `<${versionTagName({ from: plan.from, to: plan.to })}>`
      : tagged(plan.from, plan.to, body);
    return { text, end, nextTag };
  }
  return { text: plan.ids.map((id) => tagged(id, id, body)).join(""), end, nextTag };
}

/** One branch of a `<versions>` group, as its `<variant>` spelled it. */
interface Branch {
  readonly id: string;
  readonly until: string | null;
  readonly body: string;
  readonly ordinal: number;
}

/**
 * `<versions>` → one tag per variant (§2.2).
 *
 * Whitespace between the variants is dropped rather than kept: the group used
 * to emit the winning variant's inner text and nothing else, so a newline that
 * rendered nothing then would render *for every version* now — the first thing
 * this conversion must not introduce. Anything else parked between them is not
 * whitespace and not this transform's to delete, so the group is refused.
 */
function convertGroup(
  ctx: Ctx,
  openIdx: number,
  closeIdx: number | null,
  depth: number,
): Built | null {
  const open = ctx.tags[openIdx];
  if (closeIdx === null) return skip(ctx, open, "unclosed");
  const close = ctx.tags[closeIdx];

  const branches: Branch[] = [];
  const seen = new Set<string>();
  let fallback: string | null = null;
  let cursor = open.end;
  let i = openIdx + 1;

  while (i < closeIdx) {
    const tag = ctx.tags[i];
    if (!LEGACY_TAGS.has(tag.name)) {
      i += 1;
      continue;
    }
    if (tag.name !== VARIANT_TAG || tag.closing) return skip(ctx, open, "stray-content");
    if (!BLANK_RE.test(ctx.text.slice(cursor, tag.start))) return skip(ctx, open, "stray-content");

    const paired = ctx.close[i];
    const variantClose = paired !== null && paired < closeIdx ? paired : null;
    if (variantClose === null && !tag.selfClosing) return skip(ctx, open, "unclosed");

    const attrs = parseAttrs(tag.attrs);
    if (attrs.has("only")) return skip(ctx, open, "attributes");
    const since = attrs.get("since");
    if (since === undefined) return skip(ctx, open, "attributes");

    const body = innerText(ctx, i, variantClose, depth);
    const id = since.trim();

    if (id === FALLBACK) {
      // Two fallbacks are two answers to one question; the old engine kept one
      // of them and which one is not something to reproduce by guessing.
      if (fallback !== null) return skip(ctx, open, "duplicate-id");
      if (attrs.has("until")) return skip(ctx, open, "attributes");
      fallback = body;
    } else {
      if (!ID_RE.test(id)) return skip(ctx, open, "malformed-id");
      const ordinal = versionOrdinal(id, ctx.registry);
      if (ordinal === null) return skip(ctx, open, "malformed-id");
      if (seen.has(foldId(id))) return skip(ctx, open, "duplicate-id");
      seen.add(foldId(id));
      const rawUntil = attrs.get("until");
      let until: string | null = null;
      if (rawUntil !== undefined) {
        until = rawUntil.trim();
        if (!ID_RE.test(until)) return skip(ctx, open, "malformed-id");
      }
      branches.push({ id, until, body, ordinal });
    }

    cursor = variantClose === null ? tag.end : ctx.tags[variantClose].end;
    i = variantClose === null ? i + 1 : variantClose + 1;
  }

  if (!BLANK_RE.test(ctx.text.slice(cursor, close.start))) return skip(ctx, open, "stray-content");
  if (branches.length === 0 && fallback === null) return skip(ctx, open, "no-branches");

  // Ordinal order, because that is the order the old engine resolved the group
  // in — the greatest `since` at or below the selection won, whatever order the
  // variants were written in. Emitting them in that order also makes every
  // window disjoint, so exactly one still renders.
  branches.sort((a, b) => a.ordinal - b.ordinal);

  const tags = branches
    .map((branch, index) => {
      const next = index + 1 < branches.length ? branches[index + 1].id : null;
      const computed = branchEnd(branch.id, next, ctx.registry);
      return tagged(branch.id, cappedEnd(branch.id, computed, branch.until, ctx.registry), branch.body);
    })
    .join("");

  return { text: (fallback ?? "") + tags, end: close.end, nextTag: closeIdx + 1 };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Rewrite every retired version construct in `source` into the tag-name
 * grammar, leaving everything it cannot spell faithfully exactly as it found it.
 *
 * `registry` is passed in rather than read from anywhere, because the rule for
 * a group's branch ends is a *registry* lookup and this has to be the same
 * answer in a unit test, in the seed and against the live database. With no
 * registry every branch ends on its own id — the conservative reading, since a
 * window may never claim a version nothing has confirmed exists.
 */
export function convertLegacyVersionMarkup(
  source: string,
  registry: readonly VersionRegistryEntry[] = [],
): LegacyConversion {
  try {
    const spans = protectedSpans(source);
    const tags = scanTags(source, spans);
    const quoted = countQuoted(source, spans);
    if (tags.length === 0) return { text: source, changed: 0, skipped: [], quoted };

    const ctx: Ctx = {
      text: source,
      tags,
      close: pairTags(tags),
      registry,
      skipped: [],
      changed: 0,
    };
    const text = convertRange(ctx, 0, tags.length, 0, source.length, 0);
    return { text, changed: ctx.changed, skipped: ctx.skipped, quoted };
  } catch {
    // Nothing here is allowed to fail a save or a migration: an input this
    // cannot read comes back byte-for-byte, and says so.
    return {
      text: source,
      changed: 0,
      skipped: [{ at: 0, tag: "", reason: "unreadable" }],
      quoted: 0,
    };
  }
}

/** True when `source` still holds a construct in the retired grammar. */
export function hasLegacyVersionMarkup(source: string): boolean {
  const result = convertLegacyVersionMarkup(source);
  return result.changed > 0 || result.skipped.length > 0;
}
