/**
 * Template introspection for the editor's template dialog — Fandom's
 * "Insert → Template" flow, where you pick a template by name and then fill in
 * its **parameters as a form** instead of typing braces
 * (docs/engine/visual-editor.md §5.1).
 *
 * Two halves, both pure so they can be tested without a DOM or a database:
 *
 * 1. **What parameters does this template take?** Read from the template's own
 *    wikitext. Every `{{{name|default}}}` in the body is a parameter, in first
 *    appearance order — which for the infobox templates in this wiki is also
 *    the order the rows come out in, so the form reads like the rendered box.
 *    A parameter written *without* a default (`{{{name}}}`) is required: the
 *    engine renders the raw braces when it is missing (spec §8.4).
 *    An optional `<templatedata>` JSON block (MediaWiki's convention, which
 *    Fandom also honours) enriches that list with labels, descriptions, types
 *    and an explicit order. It is read from the raw wikitext here rather than
 *    from the engine, because the engine is frozen and does not know the tag —
 *    which is also why a template page currently *shows* the block as literal
 *    text. Teaching stage 3 the tag is the follow-up that fixes that.
 *
 * 2. **What does this call pass?** `{{Name|a|b=c}}` is split into ordered
 *    arguments and rebuilt from the form. Rebuilding preserves the two things
 *    an author notices: the exact name spelling (`Infobox_moon`, underscore and
 *    all) and whether the call was written across lines.
 *
 * Splitting on `|` is depth-aware: a value may itself hold a template, a link
 * or a table, and none of their pipes are separators.
 */

/* ------------------------------------------------------------------ */
/* Specs                                                               */
/* ------------------------------------------------------------------ */

/** TemplateData's `type` vocabulary, narrowed to what the form reacts to. */
export type TemplateParamType =
  | "string"
  | "line"
  | "content"
  | "number"
  | "boolean"
  | "wiki-page-name"
  | "wiki-file-name"
  | "url"
  | "date"
  | "unknown";

const PARAM_TYPES: readonly TemplateParamType[] = [
  "string",
  "line",
  "content",
  "number",
  "boolean",
  "wiki-page-name",
  "wiki-file-name",
  "url",
  "date",
  "unknown",
];

export interface TemplateParamSpec {
  /** The name as the template writes it: "name", "image", "1". */
  name: string;
  /** A bare number ⇒ passed positionally, with no `name=` prefix. */
  positional: boolean;
  /** Display label — TemplateData's, else the name made readable. */
  label: string;
  description: string | null;
  /** True when no occurrence in the body supplies a default (spec §8.4). */
  required: boolean;
  /** TemplateData's `suggested`: offered in the form even when unused. */
  suggested: boolean;
  /** The default written in the body, when there is one. */
  defaultValue: string | null;
  type: TemplateParamType;
}

export interface TemplateSpec {
  /** One-line description for the dialog header. */
  description: string | null;
  params: TemplateParamSpec[];
  /** True when a `<templatedata>` block supplied the metadata. */
  documented: boolean;
}

/* ------------------------------------------------------------------ */
/* Brace walking                                                       */
/* ------------------------------------------------------------------ */

/**
 * Index just past the construct that starts at `start`, where `open` is a run
 * of identical opening characters (`"{{{"`, `"{{"`, `"[["`). Counts single
 * braces/brackets rather than pairs, so nested constructs of *different*
 * widths close correctly — `{{{image|{{#if:x|y}}}}}` ends where it should.
 * Returns -1 when the construct never closes before `limit`.
 */
function matchRun(
  source: string,
  start: number,
  open: string,
  close: string,
  limit = source.length,
): number {
  const openChar = open[0];
  const closeChar = close[0];
  let depth = open.length;
  let i = start + open.length;
  const stop = Math.min(source.length, limit);
  while (i < stop) {
    const ch = source[i];
    if (ch === openChar) depth += 1;
    else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return -1;
}

/**
 * How far one construct may be followed, and how much look-ahead a whole scan
 * may spend. An unclosed brace run has no end to find, and the scan restarts
 * at every index of the run (see below), so without both bounds a body that is
 * one long run of `{` costs O(n²) — and `templateSpec` runs on Node's single
 * thread inside the anonymous GET /api/templates/{slug}, where 400 000
 * characters of it blocked every other request for over a minute. Both sit far
 * above any real `{{{name|default}}}`, so a template no one wrote as an attack
 * is read exactly as before.
 */
const MAX_CONSTRUCT_SPAN = 8 * 1024;
const MIN_SCAN_BUDGET = 64 * 1024;

/** Every `{{{…}}}` in `source`, as `{ name, defaultValue }` in source order. */
function scanParamUses(source: string): { name: string; defaultValue: string | null }[] {
  const uses: { name: string; defaultValue: string | null }[] = [];
  let budget = Math.max(source.length * 4, MIN_SCAN_BUDGET);
  for (let i = 0; i < source.length && budget > 0; i += 1) {
    if (!source.startsWith("{{{", i)) continue;
    const span = Math.min(MAX_CONSTRUCT_SPAN, budget);
    const end = matchRun(source, i, "{{{", "}}}", i + span);
    budget -= end === -1 ? span : end - i;
    if (end === -1) continue;
    // The body sits between the braces; its top level is depth 3.
    const body = source.slice(i + 3, end - 3);
    let depth = 3;
    let pipe = -1;
    for (let j = 0; j < body.length; j += 1) {
      const ch = body[j];
      if (ch === "{" || ch === "[") depth += 1;
      else if (ch === "}" || ch === "]") depth -= 1;
      else if (ch === "|" && depth === 3) {
        pipe = j;
        break;
      }
    }
    const name = (pipe === -1 ? body : body.slice(0, pipe)).trim();
    // A name with braces in it is computed (`{{{ {{{a}}} }}}`), so it is not a
    // parameter of *this* template — but the one inside it is. The scan
    // therefore never jumps over a construct it has looked at, which is also
    // what finds a parameter used inside another's default.
    if (name !== "" && !/[{}[\]\n]/.test(name)) {
      uses.push({ name, defaultValue: pipe === -1 ? null : body.slice(pipe + 1) });
    }
  }
  return uses;
}

/** "map_multiplier" → "Map multiplier"; "1" stays "1". */
export function humanizeParamName(name: string): string {
  if (/^\d+$/.test(name)) return name;
  const spaced = name.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/* ------------------------------------------------------------------ */
/* TemplateData                                                        */
/* ------------------------------------------------------------------ */

/** The subset of TemplateData this editor understands. */
interface TemplateDataDoc {
  description?: unknown;
  params?: Record<string, unknown>;
  paramOrder?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pull the JSON out of a `<templatedata>` block. Both spellings are accepted:
 * the standard tag, and the same tag wrapped in an HTML comment — which is how
 * an author can carry TemplateData today without it showing up as literal text
 * on the template page (see the module comment).
 */
export function parseTemplateData(source: string): TemplateDataDoc | null {
  const match = /<templatedata>([\s\S]*?)<\/templatedata>/i.exec(source);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    return isRecord(parsed) ? parsed : null;
  } catch {
    // Malformed TemplateData is the author's problem, not a reason to lose the
    // auto-detected parameters.
    return null;
  }
}

function readType(value: unknown): TemplateParamType {
  if (typeof value !== "string") return "unknown";
  const found = PARAM_TYPES.find((type) => type === value);
  return found ?? "unknown";
}

/** TemplateData allows a plain string or a `{ "en": … }` map for prose. */
function readText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (isRecord(value)) {
    for (const candidate of Object.values(value)) {
      if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The public read                                                     */
/* ------------------------------------------------------------------ */

/** Strip `<includeonly>` bodies so a doc line inside them is not mistaken for prose. */
function documentationOf(source: string): string | null {
  const noinclude = /<noinclude>([\s\S]*?)<\/noinclude>/i.exec(source);
  const region = noinclude ? noinclude[1] : source;
  for (const rawLine of region.split("\n")) {
    const line = rawLine
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<templatedata>[\s\S]*?<\/templatedata>/gi, "")
      .replace(/<[^>]*>/g, "")
      .replace(/'''?/g, "")
      .trim();
    // Skip markup-only lines: headings, categories, table syntax, braces.
    if (line === "" || /^[=|{}[\-*#:;]/.test(line)) continue;
    return line.length > 240 ? `${line.slice(0, 239)}…` : line;
  }
  return null;
}

/**
 * What the template dialog needs to know about one template, derived from its
 * wikitext alone. Auto-detected parameters come first in body order;
 * TemplateData, when present, supplies labels/descriptions/types and may
 * reorder and extend the list through `paramOrder`.
 */
export function templateSpec(templateSource: string): TemplateSpec {
  const uses = scanParamUses(templateSource);

  const byName = new Map<string, TemplateParamSpec>();
  for (const use of uses) {
    const existing = byName.get(use.name);
    if (existing) {
      // One occurrence with a default is enough to make the parameter optional,
      // and the first default we see is the one the form should suggest.
      if (use.defaultValue !== null) {
        existing.required = false;
        if (existing.defaultValue === null) existing.defaultValue = use.defaultValue;
      }
      continue;
    }
    byName.set(use.name, {
      name: use.name,
      positional: /^\d+$/.test(use.name),
      label: humanizeParamName(use.name),
      description: null,
      required: use.defaultValue === null,
      suggested: false,
      defaultValue: use.defaultValue,
      type: "unknown",
    });
  }

  const data = parseTemplateData(templateSource);
  if (data === null) {
    return {
      description: documentationOf(templateSource),
      params: [...byName.values()],
      documented: false,
    };
  }

  const declared = isRecord(data.params) ? data.params : {};
  for (const [name, raw] of Object.entries(declared)) {
    const meta = isRecord(raw) ? raw : {};
    const existing = byName.get(name);
    const spec: TemplateParamSpec = existing ?? {
      name,
      positional: /^\d+$/.test(name),
      label: humanizeParamName(name),
      description: null,
      required: false,
      suggested: false,
      defaultValue: null,
      type: "unknown",
    };
    spec.label = readText(meta.label) ?? spec.label;
    spec.description = readText(meta.description) ?? spec.description;
    spec.type = meta.type === undefined ? spec.type : readType(meta.type);
    if (typeof meta.required === "boolean") spec.required = meta.required;
    if (typeof meta.suggested === "boolean") spec.suggested = meta.suggested;
    const documentedDefault = readText(meta.default);
    if (documentedDefault !== null) spec.defaultValue = documentedDefault;
    byName.set(name, spec);
  }

  const order = Array.isArray(data.paramOrder)
    ? data.paramOrder.filter((entry): entry is string => typeof entry === "string")
    : [];
  const ordered: TemplateParamSpec[] = [];
  for (const name of order) {
    const spec = byName.get(name);
    if (spec && !ordered.includes(spec)) ordered.push(spec);
  }
  for (const spec of byName.values()) if (!ordered.includes(spec)) ordered.push(spec);

  return {
    description: readText(data.description) ?? documentationOf(templateSource),
    params: ordered,
    documented: true,
  };
}

/* ------------------------------------------------------------------ */
/* Calls                                                               */
/* ------------------------------------------------------------------ */

export interface TemplateArg {
  /**
   * `null` for a positional argument. The form still shows it under its
   * implicit index, which `positionalIndex` carries.
   */
  name: string | null;
  /** 1-based index among the positional arguments; 0 for a named one. */
  positionalIndex: number;
  value: string;
}

export interface TemplateCall {
  /** Exactly as written, underscores and casing preserved. */
  name: string;
  args: TemplateArg[];
  /** The call was written across several lines, so a rebuild should be too. */
  multiline: boolean;
}

/**
 * Names that look like `{{Template}}` but are not: parser functions (spec §9)
 * and magic words (§7). The dialog has no form to offer for them, so the atomic
 * node falls back to raw wikitext editing.
 *
 * This is a deliberate copy of `PARSER_FUNCTIONS` / `MAGIC_WORDS` rather than
 * an import: those live in the engine, and pulling the engine into the client
 * bundle to answer a yes/no question is not worth the weight.
 * `template-params.test.ts` diffs this list against the engine's sets, so it
 * cannot drift silently.
 */
export const NON_TEMPLATE_HEADS: ReadonlySet<string> = new Set([
  "lc", "uc", "lcfirst", "ucfirst", "ns", "nse", "urlencode", "anchorencode",
  "formatnum", "padleft", "padright", "displaytitle", "defaultsort",
  "defaultsortkey", "defaultcategorysort",
]);

/** Split a call body on its top-level pipes (nested braces/brackets are inert). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
    else if (ch === "|" && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/**
 * `{{Name|a|b=c}}` → its parts, or null when `source` is not a single template
 * call. Parser functions and magic words are deliberately rejected here: the
 * dialog has nothing to offer for `{{#if:}}` or `{{PAGENAME}}`, and the atomic
 * node falls back to raw wikitext editing for them.
 */
export function parseTemplateCall(source: string): TemplateCall | null {
  const text = source.trim();
  if (!text.startsWith("{{") || !text.endsWith("}}")) return null;
  if (matchRun(text, 0, "{{", "}}") !== text.length) return null;

  const parts = splitTopLevel(text.slice(2, -2));
  const rawName = parts[0];
  const name = rawName.trim();
  if (name === "" || name.includes("=") || /[{}[\]]/.test(name)) return null;
  // `{{#if:…}}` and `{{ns:0}}` split with their first argument still attached to
  // the name, so the check runs on the part before the colon.
  const colon = name.indexOf(":");
  const head = colon === -1 ? name : name.slice(0, colon);
  if (head.startsWith("#") || NON_TEMPLATE_HEADS.has(head.trim().toLowerCase())) return null;
  // A magic word is a bare all-caps token taking no arguments; a template that
  // takes none is still a template, so only reject when there are no arguments.
  if (parts.length === 1 && /^[A-Z][A-Z0-9]*$/.test(name)) return null;

  const args: TemplateArg[] = [];
  let positional = 0;
  for (const part of parts.slice(1)) {
    const eq = topLevelEquals(part);
    if (eq === -1) {
      positional += 1;
      args.push({ name: null, positionalIndex: positional, value: part });
    } else {
      args.push({
        name: part.slice(0, eq).trim(),
        positionalIndex: 0,
        value: part.slice(eq + 1).trim(),
      });
    }
  }

  return { name, args, multiline: text.includes("\n") };
}

/** Index of the `=` that makes an argument named, or -1 when it is positional. */
function topLevelEquals(part: string): number {
  let depth = 0;
  for (let i = 0; i < part.length; i += 1) {
    const ch = part[i];
    if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
    else if (ch === "=" && depth === 0) return i;
  }
  return -1;
}

/**
 * Rebuild the wikitext for a call. Multi-line calls come back in the shape the
 * seed templates and every hand-written infobox use —
 * `{{Name\n| key = value\n}}` — because that is what an author reading the
 * source next expects to see.
 */
export function buildTemplateCall(call: TemplateCall): string {
  const args = call.args.map((arg) =>
    arg.name === null ? arg.value : `${arg.name} = ${arg.value}`,
  );
  if (args.length === 0) return `{{${call.name}}}`;
  if (!call.multiline) {
    // Single-line calls keep values tight: `{{Verify|scrap count}}`.
    const tight = call.args.map((arg) => (arg.name === null ? arg.value : `${arg.name}=${arg.value}`));
    return `{{${call.name}|${tight.join("|")}}}`;
  }
  return `{{${call.name}\n| ${args.join("\n| ")}\n}}`;
}

/**
 * A fresh call for `name`, seeded with the parameters the form should show
 * first: everything required, plus everything TemplateData marks suggested.
 * More than two rows is where the single-line form stops being readable, which
 * is the same threshold the seed content uses.
 */
export function newTemplateCall(name: string, spec: TemplateSpec): TemplateCall {
  const seeded = spec.params.filter((param) => param.required || param.suggested);
  return {
    name,
    args: seeded.map((param, index) => ({
      name: param.positional ? null : param.name,
      positionalIndex: param.positional ? index + 1 : 0,
      value: "",
    })),
    multiline: seeded.length > 2,
  };
}

/**
 * The spec parameters a call does not already pass — what Fandom offers under
 * "add more information".
 */
export function unusedParams(call: TemplateCall, spec: TemplateSpec): TemplateParamSpec[] {
  const used = new Set(
    call.args.map((arg) => (arg.name === null ? String(arg.positionalIndex) : arg.name)),
  );
  return spec.params.filter((param) => !used.has(param.name));
}
