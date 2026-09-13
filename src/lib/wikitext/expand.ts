/**
 * Stage 2 — expander (spec §14.3).
 *
 * Walks the PPNode tree with a Frame: templates (§8.1–§8.8), parameters
 * (§8.4), `{{!}}`/`{{=}}` (§7.10), extension tags → strip markers (§10, §14.8)
 * and the version tags of docs/engine/versioning.md §2 — `<v70>`,
 * `<v70+v80>`, `<v70+>` — resolved here, so no later stage ever sees version
 * markup.
 *
 * Parser functions and magic words (§9) live in parser-functions.ts; stage 2
 * only builds their arguments (lazily, §8.5) and their `PFContext`, then
 * splices the result. A handler returning `null` means "not a parser
 * function", so the call falls through to template resolution (§8.2).
 */

import {
  DEFAULT_NAMESPACES,
  NS_MAIN,
  STORABLE_NS_BY_ID,
  nsPrefix,
  parseTitle,
  slugifyTitle,
} from "@/lib/title";

import type { ExpandResult, StripTable } from "./index";
import { evaluateMagicWord, titleKeyOf } from "./magic-words";
import { evaluateParserFunction, isParserFunction } from "./parser-functions";
import {
  encodeInfoboxModel,
  resolveInfobox,
  type InfoboxExpandHost,
} from "./portable-infobox";
import { preprocess, stringifyNodes } from "./preprocessor";
import type {
  ExpandApi,
  ExpandHooks,
  Frame,
  FrameArg,
  PPExtTag,
  PPNode,
  PPParameter,
  PPTemplate,
  PageMeta,
  ParseContext,
  ParserFunctionArg,
  Title,
  TitleKey,
} from "./types";
import { parseVersionTagName, recordBoundaries, resolveVersionTag } from "./versions";

/* ------------------------------------------------------------------ */
/* Parser-function dispatch (§9, implemented in parser-functions.ts)   */
/* ------------------------------------------------------------------ */

/**
 * The §9 module (parser-functions.ts) as stage 2 consumes it: the
 * `ExpandHooks` contract of types.ts. `expand()` uses the real
 * implementations by default; an override keeps this stage testable on its
 * own. `evaluateParserFunction` returning `null` means "not a parser
 * function" — stage 2 then tries template resolution (§8.2).
 */
export const DEFAULT_HOOKS: ExpandHooks = {
  evaluateParserFunction,
  evaluateMagicWord,
  isParserFunction,
};

/**
 * One §9 argument. `ParserFunctionArg` (types.ts) is the contract; the
 * `expand()`/`split` pair mirrors it for handlers written against the
 * parser-functions.ts shape, so stage 2 works with either while §9 settles.
 * `value()`/`split.value()` are trimmed per §9.1; `expand()` is not.
 */
interface CompatArg extends ParserFunctionArg {
  expand(): string;
  split?: { name(): string; value(): string };
}

/** Likewise for the context: `ExpandApi` widened with the `PFContext` fields. */
type CompatApi = ExpandApi &
  ParseContext & { state: { expensiveCalls: number; ifexistTargets: TitleKey[] } };

/* ------------------------------------------------------------------ */
/* Strip markers (§0.5, §14.8)                                         */
/* ------------------------------------------------------------------ */

/** U+007F (DEL): removed from author input at stage 0, so it cannot collide. */
const DEL = "\u007f";
const MARKER_PREFIX = DEL + "'\"UNIQ--";
const MARKER_SUFFIX = "-QINU\"'" + DEL;

/** `\x7f'"UNIQ--<name>-<8 hex>-QINU"'\x7f` — deterministic, counter-based. */
export function stripMarker(name: string, seq: number): string {
  return MARKER_PREFIX + name + "-" + seq.toString(16).padStart(8, "0") + MARKER_SUFFIX;
}

/** Matches any strip marker; group 1 is the marker's name segment. */
export const STRIP_MARKER_RE = /\u007f'"UNIQ--([a-z0-9-]+?)-[0-9a-f]{8}-QINU"'\u007f/g;

/** The tag name a marker was created for (`"ref"`, `"nowiki"`, …). */
export function stripMarkerName(marker: string): string | null {
  const re = new RegExp(STRIP_MARKER_RE.source);
  const m = re.exec(marker);
  return m ? m[1] : null;
}

/**
 * Strip-table payload for the extension tags whose rendering needs page state
 * (`ref`, `references`, `gallery`): the renderer decodes it, resolves it and
 * substitutes HTML. Markers for `nowiki`/`pre`/`syntaxhighlight` hold their
 * final HTML instead and are restored verbatim.
 */
export interface ExtPayload {
  tag: string;
  attrs: Record<string, string>;
  /** Expanded wikitext content (null for a self-closing tag). */
  inner: string | null;
}

const EXT_PAYLOAD_PREFIX = "wiki-ext";

export function encodeExtPayload(payload: ExtPayload): string {
  return EXT_PAYLOAD_PREFIX + JSON.stringify(payload);
}

export function isExtPayload(value: string): boolean {
  return value.startsWith(EXT_PAYLOAD_PREFIX);
}

export function decodeExtPayload(value: string): ExtPayload | null {
  if (!isExtPayload(value)) return null;
  return JSON.parse(value.slice(EXT_PAYLOAD_PREFIX.length)) as ExtPayload;
}

/* ------------------------------------------------------------------ */
/* Titles                                                              */
/* ------------------------------------------------------------------ */

/**
 * `TitleKey` (spec §14.10): `"<ns>:<Normalized_page_name>"`, e.g.
 * `10:Infobox_moon` — the single definition lives in magic-words.ts, so
 * PageStore lookups, loop detection and `meta.templatesUsed` all agree.
 */
const titleKey = titleKeyOf;

function fullTitleText(title: Title, ctx: ParseContext): string {
  const canonical = ctx.config.namespaces.canonical[title.namespace] ?? "";
  return canonical === "" ? title.pageName : canonical + ":" + title.pageName;
}

/** `$1` of `articlePath` / `redLinkPath` (decisions O1). */
function pathTarget(title: Title, ctx: ParseContext): string {
  const nsName = STORABLE_NS_BY_ID[title.namespace];
  if (nsName) return nsPrefix(nsName) + encodeURIComponent(slugifyTitle(title.pageName));
  return encodeURIComponent(fullTitleText(title, ctx).replace(/ /g, "_"));
}

function formatPath(pattern: string, target: string): string {
  return pattern.replace("$1", target);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Blue link to a (possibly missing) page, used by the §8.5 error messages. */
function linkHtml(title: Title, ctx: ParseContext): string {
  const text = fullTitleText(title, ctx);
  const href = formatPath(ctx.config.articlePath, pathTarget(title, ctx));
  return (
    '<a href="' + escapeHtml(href) + '" title="' + escapeHtml(text) + '">' + escapeHtml(text) + "</a>"
  );
}

/** §8.2 rule 6: nonexistent transclusion target → red link. */
function redLinkHtml(title: Title, ctx: ParseContext): string {
  const text = fullTitleText(title, ctx);
  const href = formatPath(ctx.config.redLinkPath, pathTarget(title, ctx));
  const hover = text + " " + ctx.config.messages.redLinkTitleSuffix;
  return (
    '<a href="' +
    escapeHtml(href) +
    '" class="new red-link" title="' +
    escapeHtml(hover) +
    '">' +
    escapeHtml(text) +
    "</a>"
  );
}

function errorSpan(html: string): string {
  return '<span class="error">' + html + "</span>";
}

/* ------------------------------------------------------------------ */
/* Expansion state                                                     */
/* ------------------------------------------------------------------ */

const MAX_EXPANSIONS = 100_000;

interface ArgEntry {
  arg: FrameArg;
  /** Named arguments are trimmed; positional ones are not (§8.3). */
  trim: boolean;
}

interface State {
  ctx: ParseContext;
  hooks: ExpandHooks;
  /** `#ifexist` budget and targets, owned by the §9 module. */
  pfState: { expensiveCalls: number; ifexistTargets: TitleKey[] };
  strips: StripTable;
  meta: PageMeta;
  markerSeq: number;
  includeSize: number;
  sizeExceeded: boolean;
  /** `#ifexist` and friends, against `config.maxExpensiveCalls` (§9.2). */
  expensive: number;
  expansions: number;
  trees: Map<TitleKey, PPNode[]>;
  args: WeakMap<Frame, Map<string, ArgEntry>>;
}

export function createPageMeta(): PageMeta {
  return {
    categories: [],
    behaviorSwitches: new Set<string>(),
    toc: [],
    templatesUsed: [],
    linksTo: [],
    ifexistTargets: [],
    volatile: false,
    versionBoundaries: [],
    versionScoped: false,
    languageLinks: [],
    warnings: [],
  };
}

/** The root frame of a page render (spec §14.3). */
export function rootFrame(page: Title | null = null): Frame {
  return { title: page, args: [], parent: null, depth: 0 };
}

function warn(state: State, message: string): void {
  if (!state.meta.warnings.includes(message)) state.meta.warnings.push(message);
}

/* ------------------------------------------------------------------ */
/* Output writer — carries the T2529 auto-newline rule (§8.7)          */
/* ------------------------------------------------------------------ */

const AUTO_NEWLINE_RE = /^(?:[*#;:]|\{\||----)/;

class Out {
  private parts: string[] = [];
  private last = "\n"; // a fresh fragment starts at line start

  write(text: string): void {
    if (text === "") return;
    this.parts.push(text);
    this.last = text[text.length - 1];
  }

  /** Splice an expansion, prepending `\n` when §8.7 requires it. */
  writeExpansion(text: string): void {
    if (text === "") return;
    if (this.last !== "\n" && AUTO_NEWLINE_RE.test(text)) this.write("\n");
    this.write(text);
  }

  toString(): string {
    return this.parts.join("");
  }
}

/* ------------------------------------------------------------------ */
/* Stage entry point                                                   */
/* ------------------------------------------------------------------ */

/**
 * Stage 2 (spec §14.3). `dispatch` overrides the §9 module (tests only); omit
 * it in the pipeline so the real parser functions are used.
 */
export function expand(
  root: PPNode[],
  ctx: ParseContext,
  frame: Frame,
  hooks: ExpandHooks = DEFAULT_HOOKS,
): ExpandResult {
  const meta = createPageMeta();
  const state: State = {
    ctx,
    hooks,
    // The legacy `PFContext` view of the same collector: one array, two names.
    pfState: { expensiveCalls: 0, ifexistTargets: meta.ifexistTargets },
    strips: new Map(),
    meta,
    markerSeq: 0,
    includeSize: 0,
    sizeExceeded: false,
    expensive: 0,
    expansions: 0,
    trees: new Map(),
    args: new WeakMap(),
  };
  const text = expandNodes(state, root, frame);
  return { text, strips: state.strips, meta: state.meta };
}

/* ------------------------------------------------------------------ */
/* Core walk                                                           */
/* ------------------------------------------------------------------ */

function expandNodes(state: State, nodes: readonly PPNode[], frame: Frame): string {
  const out = new Out();
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        out.write(node.value);
        break;
      case "comment":
        break; // removed at stage 1/2, never reaches output (§10.8)
      case "ext":
        expandExtTag(state, node, frame, out);
        break;
      case "template":
        out.writeExpansion(expandTemplate(state, node, frame));
        break;
      case "parameter":
        out.writeExpansion(expandParameter(state, node, frame));
        break;
    }
  }
  return out.toString();
}

function expandText(state: State, text: string, frame: Frame): string {
  return expandNodes(state, preprocess(text, state.ctx, false), frame);
}

function addStrip(state: State, name: string, content: string): string {
  const marker = stripMarker(name, state.markerSeq);
  state.markerSeq += 1;
  state.strips.set(marker, content);
  return marker;
}

/**
 * Park parser-GENERATED html (§8.2 rule 6 red links, §8.5 error spans) behind
 * a strip marker. It contains `<a>`, which the §11 allowlist forbids in author
 * input, so stage 3 would escape it into visible angle brackets if it
 * travelled as plain text. §14.8 is exactly the mechanism for this: stage 6
 * restores it verbatim, as it does `<nowiki>` output.
 */
function addHtmlStrip(state: State, html: string): string {
  return addStrip(state, "parserhtml", html);
}

/** The services a §9 handler receives (types.ts `ExpandApi`). */
function makeApi(state: State, frame: Frame): ExpandApi {
  const api: CompatApi = {
    ...state.ctx,
    ctx: state.ctx,
    frame,
    meta: state.meta,
    state: state.pfState,
    expandText: (text: string) => expandText(state, text, frame),
    expandNodes: (nodes: readonly PPNode[]) => expandNodes(state, nodes, frame),
    addStrip: (name: string, content: string) => addStrip(state, name, content),
    countExpensive: () => {
      state.expensive += 1;
      state.pfState.expensiveCalls = state.expensive;
      if (state.expensive > state.ctx.config.maxExpensiveCalls) {
        warn(state, "expensive-call-limit-exceeded");
        return false;
      }
      return true;
    },
    markVolatile: () => {
      state.meta.volatile = true;
    },
    warn: (message: string) => warn(state, message),
  };
  return api;
}

/* ------------------------------------------------------------------ */
/* Extension tags (§10, §14.3) and version tags (versioning §2)          */
/* ------------------------------------------------------------------ */

/** Any opening tag in raw wikitext; the name is tested, never trusted. */
const OPENING_TAG_RE = /<([A-Za-z][^\s/>]*)(?:\s[^>]*)?>/g;

/**
 * Record the boundaries of version tags written **inside a branch that is not
 * being rendered** (versioning.md §3).
 *
 * Until 2026-09-05 this was a documented limitation of §2.6 — "a tag inside a
 * branch the selection hides is never expanded, so its boundaries are not
 * discovered" — with the advice that authors should not nest. The report that
 * retired it was not nesting at all:
 *
 * ```wikitext
 * | Cell1 || <v69>aaa</69> || a       ← `</69>` closes nothing (§10.7)
 * …
 * <v60></v60>
 * ```
 *
 * A mistyped closer makes `<v69>` swallow the rest of the page, so the
 * author's `<v60>` block ends up inside it — and the article's version
 * selector lost v60 while the editor's strip, which reads openers out of the
 * buffer, still showed it. "The editor knows about it and the page does not"
 * is not something an author can act on, and no amount of nesting advice
 * covers a typo.
 *
 * A flat scan rather than a recursive one: it reads the whole body at once, so
 * it finds a tag at any depth without re-entering the expander — which it must
 * not do, because that body is deliberately **not** being expanded. Only
 * *opening* tags are read (a closer repeats its opener and names nothing new),
 * and every name is put through the same `parseVersionTagName` the expander
 * uses, so nothing here can call something a version that the engine would
 * not.
 *
 * `{{#ifversion:}}` and `{{#vswitch:}}` inside a hidden branch are still not
 * discovered: reading those out of unexpanded wikitext means matching template
 * calls with a budget, which is a scanner this stage has no business growing.
 * The constructs this covers — the tags — are what the editor's `+` writes and
 * what the report was about.
 */
function recordNestedVersionTags(state: State, inner: string): void {
  const ids: string[] = [];
  OPENING_TAG_RE.lastIndex = 0;
  for (let m = OPENING_TAG_RE.exec(inner); m !== null; m = OPENING_TAG_RE.exec(inner)) {
    const nested = parseVersionTagName(m[1]);
    if (nested !== null) ids.push(...nested.ids);
  }
  if (ids.length > 0) recordBoundaries(state.meta, ids);
}

/**
 * `meta.warnings` prefix for a version tag that no closer ever repeated
 * (versioning.md §2.6). Exported because two readers outside the engine match
 * on it: the editor's version strip, and its buffer-side twin's drift test.
 */
export const UNCLOSED_VERSION_TAG = "unclosed-version-tag";

/** versioning.md §2.6: unknown ids surface inline in preview mode only. */
function versionPreviewErrors(state: State, before: number): string {
  if (state.ctx.preview !== true) return "";
  const added = state.meta.warnings.slice(before).filter((w) => w.startsWith("unknown-version:"));
  return added
    .map((w) => '<span class="wiki-error">' + escapeHtml(w.slice("unknown-version:".length).trim()) + "</span>")
    .join("");
}

function expandExtTag(state: State, node: PPExtTag, frame: Frame, out: Out): void {
  const inner = node.inner ?? "";

  // --- version tags: resolved here, body re-expanded in the SAME frame, so a
  // branch may use the arguments of the template it was written in ---
  const range = parseVersionTagName(node.name);
  if (range !== null) {
    const before = state.meta.warnings.length;
    // §10.7 says an unclosed tag swallows to the end of the input, and that is
    // what happens — but for a version tag it is almost never what was meant,
    // and it is invisible: one mistyped closer (`</69>` for `</v69>`) takes the
    // rest of the page into this branch, so everything after it disappears at
    // every version outside the range, and any LATER version tag is inside a
    // hidden branch and never expanded, so its boundary is never discovered
    // (versioning.md §2.6). The render is unchanged; what is added is the
    // sentence that explains it, which the editor draws beside the chips.
    if (node.unclosed === true) {
      state.meta.warnings.push(`${UNCLOSED_VERSION_TAG}: ${node.name}`);
    }
    const picked = resolveVersionTag(range, inner, state.ctx, state.meta);
    // A branch this reader's selection HIDES is never expanded, so any version
    // tag written inside it would never be seen — and versioning.md §3 wants
    // the opposite: boundaries are recorded before branch selection precisely
    // so the selector can offer a branch the current view hides. Scanning the
    // unexpanded body closes that gap; it adds ids to `meta` and changes not
    // one byte of what renders.
    if (picked === "" && inner !== "") recordNestedVersionTags(state, inner);
    const errors = versionPreviewErrors(state, before);
    out.writeExpansion(expandText(state, picked, frame) + errors);
    return;
  }

  // --- raw-content tags: final HTML behind a strip marker ---
  if (node.name === "nowiki") {
    out.write(addStrip(state, "nowiki", escapeAngle(inner)));
    return;
  }
  if (node.name === "pre") {
    out.write(addStrip(state, "pre", preHtml(node.attrs, inner)));
    return;
  }
  if (node.name === "syntaxhighlight" || node.name === "source") {
    out.write(addStrip(state, "syntaxhighlight", syntaxHighlightHtml(node.attrs, inner)));
    return;
  }

  // --- Fandom portable infobox: RESOLVED HERE, not expanded wholesale ---
  // `source="cost"` binds to THIS frame's arguments (§14.3), so the model can
  // only be built while the frame is live; the renderer (stage 6) receives the
  // finished model behind the strip marker (§14.8).
  if (node.name === "infobox") {
    const host: InfoboxExpandHost = {
      getArg: (name: string) => {
        const entry = argMap(state, frame).get(name);
        return entry === undefined ? null : expandArg(state, frame, entry);
      },
      expand: (wikitext: string) => expandText(state, wikitext, frame),
    };
    const model = resolveInfobox(inner, node.attrs, host);
    out.write(
      addStrip(
        state,
        "infobox",
        encodeExtPayload({
          tag: "infobox",
          attrs: node.attrs,
          inner: encodeInfoboxModel(model),
        }),
      ),
    );
    return;
  }

  // --- wikitext-content tags: inner expanded, payload for the renderer ---
  const expandedInner = node.inner === null ? null : expandText(state, inner, frame);
  out.write(
    addStrip(
      state,
      node.name,
      encodeExtPayload({ tag: node.name, attrs: node.attrs, inner: expandedInner }),
    ),
  );
}

/** §10.1: `<` and `>` escaped, character references left live. */
function escapeAngle(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** §10.5: code blocks escape `&` as well as the angle brackets. */
function escapeCode(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function dropLeadingNewline(text: string): string {
  return text.startsWith("\n") ? text.slice(1) : text;
}

const PRE_ATTR_ALLOW = new Set(["class", "id", "dir", "lang", "title", "style"]);

function safeAttrs(attrs: Record<string, string>): string {
  let out = "";
  for (const [key, value] of Object.entries(attrs)) {
    if (!PRE_ATTR_ALLOW.has(key)) continue;
    if (key === "style" && /(?:url\s*\(|expression|\\|<)/i.test(value)) continue;
    out += " " + key + '="' + escapeHtml(value) + '"';
  }
  return out;
}

/** §10.2 */
function preHtml(attrs: Record<string, string>, inner: string): string {
  return "<pre" + safeAttrs(attrs) + ">" + escapeAngle(dropLeadingNewline(inner)) + "</pre>";
}

/** §10.5 */
function syntaxHighlightHtml(attrs: Record<string, string>, inner: string): string {
  const lang = /^[a-zA-Z0-9_-]+$/.test(attrs.lang ?? "") ? (attrs.lang as string) : "text";
  const body = escapeCode(dropLeadingNewline(inner));
  const code = '<code class="language-' + lang + '">' + body + "</code>";
  if (attrs.inline !== undefined) return code;
  const cls = "mw-highlight" + (attrs.line !== undefined ? " mw-highlight-lines" : "");
  return '<pre class="' + cls + '">' + code + "</pre>";
}

/* ------------------------------------------------------------------ */
/* Parameters (§8.4)                                                   */
/* ------------------------------------------------------------------ */

function argMap(state: State, frame: Frame): Map<string, ArgEntry> {
  const cached = state.args.get(frame);
  if (cached) return cached;
  const map = new Map<string, ArgEntry>();
  let positional = 0;
  for (const arg of frame.args) {
    // Last occurrence wins, by any mix of forms (§8.3).
    if (arg.name === null) {
      positional += 1;
      map.set(String(positional), { arg, trim: false });
    } else {
      map.set(arg.name, { arg, trim: true });
    }
  }
  state.args.set(frame, map);
  return map;
}

/** Lazy + cached argument expansion, evaluated in the *calling* frame (§8.5). */
function expandArg(state: State, frame: Frame, entry: ArgEntry): string {
  if (entry.arg.expanded !== undefined) return entry.arg.expanded;
  const parent = frame.parent ?? frame;
  const value = expandNodes(state, entry.arg.value, parent);
  entry.arg.expanded = entry.trim ? value.trim() : value;
  return entry.arg.expanded;
}

function expandParameter(state: State, node: PPParameter, frame: Frame): string {
  const name = expandNodes(state, node.name, frame).trim();
  const entry = argMap(state, frame).get(name);
  if (entry) return expandArg(state, frame, entry);
  if (node.default !== undefined) return expandNodes(state, node.default, frame);
  return "{{{" + name + "}}}";
}

/* ------------------------------------------------------------------ */
/* Templates, variables and parser functions (§8, §9)                  */
/* ------------------------------------------------------------------ */

const ILLEGAL_TITLE_CHARS = /[<>[\]{}|#]/;

function expandTemplate(state: State, node: PPTemplate, frame: Frame): string {
  state.expansions += 1;
  if (state.expansions > MAX_EXPANSIONS) {
    warn(state, "expansion-budget-exceeded");
    return stringifyNodes([node]);
  }

  const nameText = expandNodes(state, node.name, frame).trim();
  if (nameText === "") return stringifyNodes([node]);
  // §10.1: strip markers are illegal in a title, so a name containing one can
  // never resolve — §8.2 rule 7 applies and the call renders literally.
  if (nameText.includes(DEL)) return stringifyNodes([node]);

  // §7.10: structural escapes, built into the preprocessor (never templates)
  // so the pipes they emit are real table markup.
  if (nameText === "!") return "|";
  if (nameText === "=") return "=";

  const colon = nameText.indexOf(":");
  if (colon > 0) {
    // §9.1: a registered name followed by `:` is a parser function. Unknown
    // `#…` names are the §9 module's business too (D-11 error span).
    const name = nameText.slice(0, colon);
    if (name.startsWith("#") || state.hooks.isParserFunction?.(name) === true) {
      const args = makeArgs(state, node, frame, nameText.slice(colon + 1));
      const result = state.hooks.evaluateParserFunction?.(name, args, makeApi(state, frame));
      if (typeof result === "string") return result;
      // Nobody answered: a `#` name can never be a template, so keep it as
      // typed rather than inventing output.
      if (name.startsWith("#")) {
        warn(state, "unknown-parser-function: " + name);
        return stringifyNodes([node]);
      }
    }
  } else {
    // §9.1/§7.10: variables (and `{{!}}`/`{{=}}`) shadow same-named templates.
    const magic = state.hooks.evaluateMagicWord?.(nameText, makeApi(state, frame));
    if (typeof magic === "string") return magic;
  }

  return transclude(state, node, frame, nameText);
}

/* ---------------- parser-function arguments (§9.1) ---------------- */

function memoize(produce: () => string): () => string {
  let cached: string | null = null;
  return () => {
    if (cached === null) cached = produce();
    return cached;
  };
}

/**
 * Build the §9 argument list. Argument 1 is the remainder of the name segment
 * (expanded together with the name); the rest stay lazy, so only the branch a
 * function actually takes is ever expanded (§8.5).
 *
 * A name is attached exactly where the preprocessor found a top-level `=`, so
 * a `{{=}}` never splits a `#switch` case (§8.3). Argument 1 never passed the
 * splitter, so it is split on its own text — that is what lets
 * `{{#vswitch: v50=130 | … }}` see its first pair. Values are trimmed (§9.1);
 * `expand()` returns the whole argument untrimmed.
 */
function makeArgs(
  state: State,
  node: PPTemplate,
  frame: Frame,
  firstArgText: string,
): CompatArg[] {
  const equals = firstArgText.indexOf("=");
  const firstName = equals < 0 ? null : firstArgText.slice(0, equals);
  const firstValue = equals < 0 ? firstArgText : firstArgText.slice(equals + 1);
  const first: CompatArg = {
    name: firstName === null ? null : firstName.trim(),
    nodes: [{ kind: "text", value: firstValue }],
    value: () => firstValue.trim(),
    expand: () => firstArgText,
  };
  if (firstName !== null) {
    first.split = { name: () => firstName, value: () => firstValue };
  }

  const args: CompatArg[] = [first];
  for (const param of node.params) {
    const rawValue = memoize(() => expandNodes(state, param.value, frame));
    if (param.name === null) {
      args.push({
        name: null,
        nodes: param.value,
        value: () => rawValue().trim(),
        expand: rawValue,
      });
      continue;
    }
    const paramName = param.name;
    const rawName = memoize(() => expandNodes(state, paramName, frame));
    args.push({
      name: rawName().trim(),
      nodes: param.value,
      value: () => rawValue().trim(),
      expand: () => rawName() + "=" + rawValue(),
      split: { name: rawName, value: rawValue },
    });
  }
  return args;
}

/* ---------------- transclusion ---------------- */

/** §8.2: name → the page actually transcluded. */
function resolveTemplateTitle(nameText: string, ctx: ParseContext): Title | null {
  const raw = nameText.replace(/^\s*(?:safe)?subst\s*:\s*/i, "").trim(); // D-8
  if (raw === "" || ILLEGAL_TITLE_CHARS.test(raw)) return null;

  const namespaces = ctx.config.namespaces ?? DEFAULT_NAMESPACES;
  const parsed = parseTitle(raw, namespaces);
  if (!parsed) return null;

  // Leading `:` or an explicit namespace prefix → that page verbatim.
  if (parsed.forcedPlain || parsed.namespace !== NS_MAIN) {
    return { namespace: parsed.namespace, pageName: parsed.pageName };
  }

  const inTemplateNs = parseTitle("Template:" + raw, namespaces);
  if (!inTemplateNs) return null;
  return { namespace: inTemplateNs.namespace, pageName: inTemplateNs.pageName };
}

function recordTemplateUse(state: State, key: TitleKey): void {
  // Addendum A4: transitive and nonexistent targets are both required.
  if (!state.meta.templatesUsed.includes(key)) state.meta.templatesUsed.push(key);
}

function isAncestor(frame: Frame, key: TitleKey): boolean {
  for (let f: Frame | null = frame; f !== null; f = f.parent) {
    if (f.title && titleKey(f.title) === key) return true;
  }
  return false;
}

function buildFrameArgs(state: State, node: PPTemplate, frame: Frame): FrameArg[] {
  return node.params.map((param) => ({
    name: param.name === null ? null : expandNodes(state, param.name, frame).trim(),
    value: param.value,
  }));
}

function transclude(state: State, node: PPTemplate, frame: Frame, nameText: string): string {
  const ctx = state.ctx;
  const title = resolveTemplateTitle(nameText, ctx);
  if (!title) return stringifyNodes([node]); // §8.2 rule 7

  const key = titleKey(title);
  recordTemplateUse(state, key);

  if (isAncestor(frame, key)) {
    return addHtmlStrip(
      state,
      errorSpan(ctx.config.messages.templateLoop + ": " + linkHtml(title, ctx)),
    );
  }
  if (frame.depth + 1 > ctx.config.maxTemplateDepth) {
    return addHtmlStrip(
      state,
      errorSpan(escapeHtml(ctx.config.messages.templateDepthExceeded)),
    );
  }
  if (state.sizeExceeded) {
    // §8.5 size limit: further calls render like nonexistent targets.
    return addHtmlStrip(state, redLinkHtml(title, ctx));
  }
  if (!ctx.store.exists(key)) {
    return addHtmlStrip(state, redLinkHtml(title, ctx));
  }

  let tree = state.trees.get(key);
  if (!tree) {
    tree = preprocess(ctx.store.getSource(key) ?? "", ctx, true);
    state.trees.set(key, tree);
  }

  const child: Frame = {
    title,
    args: buildFrameArgs(state, node, frame),
    parent: frame,
    depth: frame.depth + 1,
  };
  const result = expandNodes(state, tree, child);

  state.includeSize += result.length;
  if (state.includeSize > ctx.config.maxIncludeSize && !state.sizeExceeded) {
    state.sizeExceeded = true;
    warn(state, "include-size-limit-exceeded");
  }
  return result;
}
