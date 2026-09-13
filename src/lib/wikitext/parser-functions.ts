/**
 * Parser functions — spec §9.1–§9.4 — plus `{{DISPLAYTITLE:}}` (§13.1) and the
 * version functions `{{#ifversion:}}` / `{{#vswitch:}}` (versioning.md §2.3/2.4).
 *
 * Stage 2 dispatches here through `ExpandHooks` (types.ts); `parserFunctionHooks`
 * bundles this module's three entry points for that registration. Returning
 * `null` means "not a parser function" and stage 2 continues with template
 * resolution (§8.2 step 1) — except for an unknown `#…` name, which can never
 * be a template and so gets the D-11 error span.
 *
 * LAZINESS (§8.5, §9.2): each {@link ParserFunctionArg} carries a memoized
 * `value()` thunk and this module calls only the ones it needs, so
 * `{{#if:x|{{Expensive}}|y}}` never expands the else branch. `value()` returns
 * text that is already expanded and already trimmed (§9.1 trims every parser
 * function argument, positionals included).
 *
 * `=` IS STRUCTURAL ONLY FOR `#switch`/`#vswitch`, which read `arg.name` and
 * `arg.value()` separately. Every other function wants the whole argument
 * (`{{#if:x|a=b}}` yields `a=b`), which {@link argText} rebuilds from the two
 * halves. The split itself is computed by the preprocessor on the UNEXPANDED
 * node list, so a `{{=}}` never splits a case (§8.3).
 */

import {
  DEFAULT_NAMESPACES,
  NS_FILE,
  normalizeTitle,
  parseTitle,
} from "@/lib/title";
import { ExprError, evaluateExpr, exprErrorHtml, formatExprNumber } from "./expr";
import {
  DEFAULT_SORT_NAMES,
  evaluateDefaultSort,
  evaluateMagicWord,
  fullPageName,
  namespaceName,
  titleKey,
  wikiUrlencode,
} from "./magic-words";
import type {
  ExpandApi,
  ExpandHooks,
  PageMeta,
  ParserFunctionArg,
  TitleKey,
} from "./types";
import { type VSwitchPair, evaluateIfVersion, vswitchPick } from "./versions";

export {
  MAGIC_WORDS,
  evaluateMagicWord,
  isMagicWord,
  titleKey,
  titleKeyOf,
  wikiUrlencode,
} from "./magic-words";

/* ------------------------------------------------------------------ */
/* Argument access                                                     */
/* ------------------------------------------------------------------ */

/**
 * The whole argument, expanded and trimmed (§9.1): for a named argument the
 * `name=value` text is rebuilt, since `=` is structural only for `#switch`.
 * Absent → `""`.
 */
function argText(args: readonly ParserFunctionArg[], index: number): string {
  const arg = args[index];
  if (arg === undefined) return "";
  return arg.name === null ? arg.value() : `${arg.name}=${arg.value()}`;
}

/**
 * Build {@link ParserFunctionArg}s from already-final strings — for tests and
 * for callers holding plain text. Mirrors what stage 2 hands over: every
 * argument, argument 1 included, is split on its first `=` (§8.3).
 */
export function literalArgs(values: readonly string[]): ParserFunctionArg[] {
  return values.map((raw) => {
    const equals = raw.indexOf("=");
    if (equals < 0) {
      return {
        name: null,
        nodes: [{ kind: "text" as const, value: raw }],
        value: () => raw.trim(),
      };
    }
    const name = raw.slice(0, equals).trim();
    const value = raw.slice(equals + 1).trim();
    return {
      name,
      nodes: [{ kind: "text" as const, value: raw.slice(equals + 1) }],
      value: () => value,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

function recordLink(meta: PageMeta, key: TitleKey): void {
  if (!meta.linksTo.includes(key)) meta.linksTo.push(key);
}

/** §9.2: a finite decimal/scientific literal, or `null` when not numeric. */
function asNumber(value: string): number | null {
  const text = value.trim();
  if (text === "") return null;
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The `#ifeq` comparison rule, reused by `#switch` (§9.2). */
function looseEquals(a: string, b: string): boolean {
  const left = asNumber(a);
  const right = asNumber(b);
  if (left !== null && right !== null) return left === right;
  return a === b;
}

/** PHP `(int)` semantics: leading integer, else 0. */
function toInt(value: string): number {
  const match = /^[+-]?\d+/.exec(value.trim());
  return match === null ? 0 : Number(match[0]);
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, "");
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

const lcFirst = (value: string): string => value.replace(/^./u, (c) => c.toLowerCase());
const ucFirst = (value: string): string => value.replace(/^./u, (c) => c.toUpperCase());

const namespacesOf = (api: ExpandApi) => api.ctx.config.namespaces ?? DEFAULT_NAMESPACES;

/* ------------------------------------------------------------------ */
/* §9.4 string / namespace functions                                   */
/* ------------------------------------------------------------------ */

/** `rawurlencode` — leaves `-_.~` (encodeURIComponent also spares `!'()*`). */
function encodePath(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** `urlencode` (query style): `rawurlencode` + `~` escaped + space as `+`. */
function encodeQuery(value: string): string {
  return encodePath(value).replace(/~/g, "%7E").replace(/%20/g, "+");
}

function urlEncode(value: string, mode: string): string {
  switch (mode.toUpperCase()) {
    case "PATH":
      return encodePath(value);
    case "WIKI":
      return wikiUrlencode(value);
    default:
      return encodeQuery(value);
  }
}

/** §2.4 steps 1–3: tags stripped, entities decoded, whitespace runs → `_`. */
function anchorEncode(value: string): string {
  return decodeBasicEntities(stripTags(value)).trim().replace(/\s+/g, "_");
}

/** `{{ns:}}` — canonical name for a number or alias; unknown → `""` (D-12). */
function nsFunction(value: string, api: ExpandApi): string {
  const namespaces = namespacesOf(api);
  const text = normalizeTitle(value);
  if (text === "") return "";
  if (/^-?\d+$/.test(text)) return namespaces.canonical[Number(text)] ?? "";
  const id = namespaces.byAlias[text.toLowerCase()];
  return id === undefined ? "" : (namespaces.canonical[id] ?? "");
}

/** en grouping; `|R` strips it. Non-numeric input passes through unchanged. */
function formatNum(value: string, mode: string): string {
  if (mode.toUpperCase() === "R") return value.replace(/,/g, "");
  const match = /^([+-]?)(\d+)(\.\d+)?$/.exec(value);
  if (match === null) return value;
  const grouped = match[2].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${match[1]}${grouped}${match[3] ?? ""}`;
}

const MAX_PAD_LENGTH = 500;

function padValue(value: string, length: number, padding: string, left: boolean): string {
  const target = Math.min(Math.max(length, 0), MAX_PAD_LENGTH);
  if (padding === "" || value.length >= target) return value;
  const needed = target - value.length;
  let fill = "";
  while (fill.length < needed) fill += padding;
  fill = fill.slice(0, needed);
  return left ? fill + value : value + fill;
}

/* ------------------------------------------------------------------ */
/* §9.4 #titleparts                                                    */
/* ------------------------------------------------------------------ */

const MAX_TITLE_SEGMENTS = 25;

/** PHP `explode($sep, $s, $limit)`: the final element keeps the remainder. */
function explodeLimit(value: string, separator: string, limit: number): string[] {
  const parts = value.split(separator);
  if (parts.length <= limit) return parts;
  return [...parts.slice(0, limit - 1), parts.slice(limit - 1).join(separator)];
}

/** PHP `array_slice` offset/length semantics, negatives included. */
function phpSlice<T>(items: readonly T[], offset: number, length: number | null): T[] {
  const size = items.length;
  const start = offset < 0 ? Math.max(size + offset, 0) : Math.min(offset, size);
  let end: number;
  if (length === null) end = size;
  else if (length < 0) end = Math.max(size + length, start);
  else end = Math.min(start + length, size);
  return items.slice(start, end);
}

function titleParts(args: readonly ParserFunctionArg[], api: ExpandApi): string {
  const raw = argText(args, 0);
  if (raw === "") return "";
  const namespaces = namespacesOf(api);
  const parsed = parseTitle(raw, namespaces);
  // Invalid titles pass through untouched (MediaWiki returns the input).
  if (parsed === null) return raw;
  const ns = namespaceName(parsed.namespace, namespaces);
  const prefixed = ns === "" ? parsed.pageName : `${ns}:${parsed.pageName}`;

  const count = toInt(argText(args, 1));
  const first = toInt(argText(args, 2));
  const bits = explodeLimit(prefixed, "/", MAX_TITLE_SEGMENTS);
  // arg3 is 1-based when positive; negative counts from the end.
  const offset = first > 0 ? first - 1 : first;
  return phpSlice(bits, offset, count === 0 ? null : count).join("/");
}

/* ------------------------------------------------------------------ */
/* §9.2 control flow                                                   */
/* ------------------------------------------------------------------ */

function evaluateSwitch(args: readonly ParserFunctionArg[]): string {
  if (args.length === 0) return "";
  const primary = argText(args, 0);
  const cases = args.slice(1);

  /** A bare case matched; the next `=` case supplies the value (§9.2). */
  let found = false;
  /** Last `#default = …`; several ⇒ the last wins (§9.2). */
  let defaultCase: ParserFunctionArg | null = null;
  /** Trailing bare argument, used only when nothing matched (§9.2). */
  let trailingDefault: string | null = null;

  for (let index = 0; index < cases.length; index += 1) {
    const entry = cases[index];
    if (entry.name !== null) {
      if (found) return entry.value();
      if (looseEquals(entry.name, primary)) return entry.value();
      if (entry.name.toLowerCase() === "#default") defaultCase = entry;
      trailingDefault = null;
      continue;
    }
    const key = entry.value();
    if (looseEquals(key, primary)) {
      found = true;
      trailingDefault = null;
      continue;
    }
    trailingDefault = index === cases.length - 1 ? key : null;
  }

  // A bare case matched but no `=` case followed it → empty (§9.2).
  if (found) return "";
  if (defaultCase !== null) return defaultCase.value();
  if (trailingDefault !== null) return trailingDefault;
  return "";
}

function evaluateIfExpr(args: readonly ParserFunctionArg[]): string {
  const source = argText(args, 0);
  let value: number | null;
  try {
    value = evaluateExpr(source);
  } catch (error) {
    // §9.2: an error in the expression renders the error message itself.
    if (error instanceof ExprError) return exprErrorHtml(error.message);
    throw error;
  }
  return value !== null && value !== 0 ? argText(args, 1) : argText(args, 2);
}

/**
 * `#ifexist` — expensive (§9.2), volatile (§9.5 / db-schema A5), and its
 * target is recorded in `linksTo` so creating that page invalidates this
 * render (spec Addendum A4, matching MediaWiki's own `#ifexist` link
 * registration).
 */
function evaluateIfExist(args: readonly ParserFunctionArg[], api: ExpandApi): string {
  const raw = argText(args, 0);
  api.markVolatile();
  if (raw === "") return argText(args, 2);
  // Over `maxExpensiveCalls` the expander has already warned; take the else.
  if (!api.countExpensive()) return argText(args, 2);
  return titleExists(raw, api) ? argText(args, 1) : argText(args, 2);
}

/** `Media:X` consults the file store; everything else the page store (§9.2). */
function titleExists(raw: string, api: ExpandApi): boolean {
  const trimmed = raw.trim();
  const media = /^:?\s*media\s*:/i.exec(trimmed);
  if (media !== null) {
    const fileName = normalizeTitle(trimmed.slice(media[0].length));
    return fileName !== "" && api.ctx.store.getFile(fileName) !== null;
  }

  const parsed = parseTitle(trimmed, namespacesOf(api));
  if (parsed === null) return false;
  const key = titleKey(parsed.namespace, parsed.pageName);
  // Addendum A4 / decisions O2: only storable namespaces reach page_links.
  if (parsed.storable) recordLink(api.meta, key);
  if (!api.meta.ifexistTargets.includes(key)) api.meta.ifexistTargets.push(key);

  if (parsed.namespace === NS_FILE) {
    return api.ctx.store.exists(key) || api.ctx.store.getFile(parsed.pageName) !== null;
  }
  return api.ctx.store.exists(key);
}

/* ------------------------------------------------------------------ */
/* Version functions (versioning.md §2.3, §2.4)                        */
/* ------------------------------------------------------------------ */

/**
 * `{{#vswitch: v50=x | v62=y | default=z }}`. Keys must be read to pick a
 * branch, but values must not be expanded — so the pairs handed to
 * `vswitchPick` carry an index sentinel and only the winner is expanded.
 * U+0000 cannot occur in author input (stage 0 removes it, §14.1), so a
 * result that is not a sentinel means "nothing matched and no default".
 */
const VSWITCH_SENTINEL = "\u0000";

function evaluateVSwitch(args: readonly ParserFunctionArg[], api: ExpandApi): string {
  if (args.length === 0) return "";
  const pairs: VSwitchPair[] = args.map((entry, index) => ({
    key: entry.name ?? "",
    value: `${VSWITCH_SENTINEL}${index}`,
  }));
  const picked = vswitchPick(pairs, api.ctx, api.meta);
  if (!picked.startsWith(VSWITCH_SENTINEL)) return "";
  const winner = args[Number(picked.slice(VSWITCH_SENTINEL.length))];
  return winner === undefined ? "" : winner.value();
}

/* ------------------------------------------------------------------ */
/* §13.1 DISPLAYTITLE                                                  */
/* ------------------------------------------------------------------ */

/** §13.1: inline tags that cannot change the text content. */
const DISPLAY_TITLE_TAGS = new Set([
  "i",
  "b",
  "em",
  "strong",
  "s",
  "u",
  "sub",
  "sup",
  "span",
  "small",
]);

/**
 * Keep the allowlisted inline tags, drop every other tag (its text survives,
 * per §13.1 "stripped to text"). All attributes are dropped — the strictest
 * reading of §13.1's "with sanitized attributes", and the only one that
 * cannot leak anything into the `<h1>`.
 */
function sanitizeDisplayTitle(html: string): string {
  return html.replace(
    /<(\/?)([A-Za-z][\w-]*)\b[^>]*?(\/?)>/g,
    (_match, slash: string, tag: string, selfClose: string) => {
      const name = tag.toLowerCase();
      if (!DISPLAY_TITLE_TAGS.has(name)) return "";
      if (slash === "/") return `</${name}>`;
      return selfClose === "/" ? `<${name}></${name}>` : `<${name}>`;
    },
  );
}

function evaluateDisplayTitle(
  args: readonly ParserFunctionArg[],
  api: ExpandApi,
): string {
  const raw = argText(args, 0);
  if (raw === "") return "";
  const sanitized = sanitizeDisplayTitle(raw);
  const text = normalizeTitle(decodeBasicEntities(stripTags(sanitized)));
  const namespaces = namespacesOf(api);
  // §13.1: only the first letter's case may differ from the real title.
  const accepted = [fullPageName(api.ctx.page, namespaces), api.ctx.page.pageName].some(
    (candidate) => ucFirst(text) === ucFirst(normalizeTitle(candidate)),
  );
  if (!accepted) {
    api.warn(`displaytitle-restricted: ${text}`);
    return "";
  }
  api.meta.displayTitle = sanitized;
  return "";
}

/* ------------------------------------------------------------------ */
/* Registry + dispatcher                                               */
/* ------------------------------------------------------------------ */

/**
 * Every registered `{{name: …}}`. `#…` names and the colon functions are
 * matched case-insensitively (§9.1); `DISPLAYTITLE` is conventionally ALL-CAPS
 * but any casing is accepted, so an author's `{{displaytitle:}}` still reaches
 * §13.1 rather than becoming a red-linked template.
 */
export const PARSER_FUNCTIONS: ReadonlySet<string> = new Set([
  "#if",
  "#ifeq",
  "#ifexist",
  "#ifexpr",
  "#ifversion",
  "#switch",
  "#vswitch",
  "#expr",
  "#titleparts",
  "lc",
  "uc",
  "lcfirst",
  "ucfirst",
  "ns",
  "nse",
  "urlencode",
  "anchorencode",
  "formatnum",
  "padleft",
  "padright",
  "displaytitle",
  // Fandom parity: `{{DEFAULTSORT:key}}` and its MediaWiki aliases.
  ...DEFAULT_SORT_NAMES,
]);

/** Does `{{name: …}}` name a parser function (§9.1 recognition)? */
export function isParserFunction(name: string): boolean {
  return PARSER_FUNCTIONS.has(name.trim().toLowerCase());
}

/** D-11: unknown `{{#name:…}}` renders a standard error span (§9.1). */
function unknownFunctionHtml(name: string): string {
  const escaped = name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<span class="error">Unknown parser function: ${escaped}</span>`;
}

/**
 * Evaluate `{{name: args…}}`. Returns the expanded replacement text, or `null`
 * when `name` is not a parser function (stage 2 then tries template
 * resolution, §8.2). Unknown `#…` names return the D-11 error span instead of
 * `null`, since a `#` name can never be a template.
 */
export function evaluateParserFunction(
  name: string,
  args: readonly ParserFunctionArg[],
  api: ExpandApi,
): string | null {
  const key = name.trim().toLowerCase();
  if (!PARSER_FUNCTIONS.has(key)) {
    return key.startsWith("#") ? unknownFunctionHtml(name.trim()) : null;
  }

  switch (key) {
    case "#if":
      // §9.2: whitespace-only is false; the string "0" is TRUE.
      return argText(args, 0) !== "" ? argText(args, 1) : argText(args, 2);
    case "#ifeq":
      return looseEquals(argText(args, 0), argText(args, 1))
        ? argText(args, 2)
        : argText(args, 3);
    case "#ifexist":
      return evaluateIfExist(args, api);
    case "#ifexpr":
      return evaluateIfExpr(args);
    case "#ifversion":
      return evaluateIfVersion(argText(args, 0), api.ctx, api.meta)
        ? argText(args, 1)
        : argText(args, 2);
    case "#switch":
      return evaluateSwitch(args);
    case "#vswitch":
      return evaluateVSwitch(args, api);
    case "#expr": {
      try {
        const value = evaluateExpr(argText(args, 0));
        return value === null ? "" : formatExprNumber(value);
      } catch (error) {
        if (error instanceof ExprError) return exprErrorHtml(error.message);
        throw error;
      }
    }
    case "#titleparts":
      return titleParts(args, api);
    case "lc":
      return argText(args, 0).toLowerCase();
    case "uc":
      return argText(args, 0).toUpperCase();
    case "lcfirst":
      return lcFirst(argText(args, 0));
    case "ucfirst":
      return ucFirst(argText(args, 0));
    case "ns":
      return nsFunction(argText(args, 0), api);
    case "nse":
      return wikiUrlencode(nsFunction(argText(args, 0), api));
    case "urlencode":
      return urlEncode(argText(args, 0), argText(args, 1));
    case "anchorencode":
      return anchorEncode(argText(args, 0));
    case "formatnum":
      return formatNum(argText(args, 0), argText(args, 1));
    case "displaytitle":
      return evaluateDisplayTitle(args, api);
    case "defaultsort":
    case "defaultsortkey":
    case "defaultcategorysort":
      return evaluateDefaultSort(argText(args, 0), api);
    case "padleft":
      return padValue(
        argText(args, 0),
        toInt(argText(args, 1)),
        args.length > 2 ? argText(args, 2) : "0",
        true,
      );
    default:
      return padValue(
        argText(args, 0),
        toInt(argText(args, 1)),
        args.length > 2 ? argText(args, 2) : "0",
        false,
      );
  }
}

/**
 * The hook bundle stage 2 consumes (`ExpandHooks`, types.ts). expand.ts wires
 * these three by default; this bundle is the single import for anyone
 * registering them explicitly.
 */
export const parserFunctionHooks: ExpandHooks = {
  evaluateParserFunction,
  evaluateMagicWord,
  isParserFunction,
};
