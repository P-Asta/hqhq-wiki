/**
 * Game-version scoping (docs/engine/versioning.md — decision O10).
 *
 * Resolution happens during expansion (stage 2), so later stages never see
 * version markup. Both consumers live in stage 2:
 *   - expand.ts  → `<v70>` / `<v70+v80>` / `<v70+>` version tags, whose NAME
 *     is the range they apply to
 *   - parser-functions.ts → `{{#ifversion:}}` / `{{#vswitch:}}`
 *
 * Every version id named by a construct is recorded into
 * `meta.versionBoundaries` BEFORE branch selection, so the article's selector
 * offers boundaries whose content the current view hides (versioning.md §3).
 */

import type { PageMeta, ParseContext, VersionEntry, VersionTable } from "./types";

const NEG_INF = Number.NEGATIVE_INFINITY;
const POS_INF = Number.POSITIVE_INFINITY;

/* ------------------------------------------------------------------ */
/* Ordinals                                                            */
/* ------------------------------------------------------------------ */

/**
 * `major*1000 + minor` for ids shaped `v<major>[.<minor>]`. Used ONLY as a
 * fallback for ids absent from the registry (so a range naming a not-yet-
 * registered version still orders sanely); registered ids always win.
 */
export function deriveOrdinal(id: string): number | null {
  const m = /^v(\d+)(?:\.(\d+))?$/i.exec(id.trim());
  if (!m) return null;
  return Number(m[1]) * 1000 + (m[2] ? Number(m[2]) : 0);
}

/** Registry lookup with the derived fallback. `null` = unknown id. */
export function ordinalOf(id: string, table: VersionTable): number | null {
  const key = id.trim();
  const entry = table.byId[key] ?? table.byId[key.toLowerCase()];
  if (entry) return entry.ordinal;
  return deriveOrdinal(key);
}

/** Sort comparator for version ids (ascending). Unknown ids sort last. */
export function compareVersions(a: string, b: string, table: VersionTable): number {
  const oa = ordinalOf(a, table);
  const ob = ordinalOf(b, table);
  if (oa === null && ob === null) return a.localeCompare(b);
  if (oa === null) return 1;
  if (ob === null) return -1;
  return oa - ob;
}

/** The version the current render is for: `ctx.version` or the site default. */
export function selectedVersionId(ctx: ParseContext): string {
  return ctx.version ?? ctx.versions.defaultId;
}

export function selectedOrdinal(ctx: ParseContext): number {
  const ord = ordinalOf(selectedVersionId(ctx), ctx.versions);
  return ord ?? NEG_INF;
}

export function versionEntry(id: string, table: VersionTable): VersionEntry | null {
  return table.byId[id] ?? table.byId[id.toLowerCase()] ?? null;
}

/* ------------------------------------------------------------------ */
/* Boundary recording                                                  */
/* ------------------------------------------------------------------ */

/** Record ids into meta.versionBoundaries (deduped) and flag the page scoped. */
export function recordBoundaries(meta: PageMeta, ids: readonly string[]): void {
  meta.versionScoped = true;
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || id === "*") continue;
    if (!meta.versionBoundaries.includes(id)) meta.versionBoundaries.push(id);
  }
}

function warnUnknown(meta: PageMeta, ctx: ParseContext, id: string): void {
  const msg = `unknown-version: ${id}`;
  if (!meta.warnings.includes(msg)) meta.warnings.push(msg);
  void ctx;
}

/* ------------------------------------------------------------------ */
/* Range grammar (versioning.md §2.3)                                  */
/* ------------------------------------------------------------------ */

export type RangeClause =
  | { kind: "any" }
  | { kind: "exact"; id: string }
  | { kind: "between"; from: string; to: string }
  | { kind: "cmp"; op: ">=" | ">" | "<=" | "<"; id: string };

export interface VersionRange {
  clauses: RangeClause[];
  /** Every id named anywhere in the expression, in source order. */
  ids: string[];
}

/**
 * `v62` · `v50-v61` · `>=v62` · `<v62` · `v50,v55,>=v62` · `*`
 * Comma = OR. Whitespace-insensitive. Ids never contain `-`, so range split is
 * unambiguous.
 */
export function parseRange(expr: string): VersionRange {
  const clauses: RangeClause[] = [];
  const ids: string[] = [];
  for (const rawPart of expr.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;
    if (part === "*") {
      clauses.push({ kind: "any" });
      continue;
    }
    const cmp = /^(>=|<=|>|<)\s*(\S+)$/.exec(part);
    if (cmp) {
      const id = cmp[2];
      ids.push(id);
      clauses.push({ kind: "cmp", op: cmp[1] as ">=" | ">" | "<=" | "<", id });
      continue;
    }
    const between = /^([^\s-]+)\s*-\s*([^\s-]+)$/.exec(part);
    if (between) {
      ids.push(between[1], between[2]);
      clauses.push({ kind: "between", from: between[1], to: between[2] });
      continue;
    }
    ids.push(part);
    clauses.push({ kind: "exact", id: part });
  }
  return { clauses, ids };
}

/** Evaluate a parsed range against the selected version. */
export function matchesRange(
  range: VersionRange,
  ctx: ParseContext,
  meta: PageMeta,
): boolean {
  const table = ctx.versions;
  const selected = selectedOrdinal(ctx);
  let result = false;
  for (const clause of range.clauses) {
    if (clause.kind === "any") {
      result = true;
      continue;
    }
    if (clause.kind === "between") {
      const from = ordinalOf(clause.from, table);
      const to = ordinalOf(clause.to, table);
      if (from === null) warnUnknown(meta, ctx, clause.from);
      if (to === null) warnUnknown(meta, ctx, clause.to);
      if (from === null || to === null) continue;
      if (selected >= from && selected <= to) result = true;
      continue;
    }
    const ord = ordinalOf(clause.id, table);
    if (ord === null) {
      warnUnknown(meta, ctx, clause.id);
      continue;
    }
    if (clause.kind === "exact") {
      if (selected === ord) result = true;
      continue;
    }
    switch (clause.op) {
      case ">=":
        if (selected >= ord) result = true;
        break;
      case ">":
        if (selected > ord) result = true;
        break;
      case "<=":
        if (selected <= ord) result = true;
        break;
      case "<":
        if (selected < ord) result = true;
        break;
    }
  }
  return result;
}

/** `{{#ifversion: <range> | then | else}}` predicate. */
export function evaluateIfVersion(
  expr: string,
  ctx: ParseContext,
  meta: PageMeta,
): boolean {
  const range = parseRange(expr);
  recordBoundaries(meta, range.ids);
  return matchesRange(range, ctx, meta);
}

/* ------------------------------------------------------------------ */
/* #vswitch (versioning.md §2.4)                                       */
/* ------------------------------------------------------------------ */

export interface VSwitchPair {
  key: string; // version id, or "default"
  value: string;
}

/**
 * Value of the greatest boundary ≤ selected version; `default` when the
 * selection is below every boundary; `""` when there is no default.
 */
export function vswitchPick(
  pairs: readonly VSwitchPair[],
  ctx: ParseContext,
  meta: PageMeta,
): string {
  const table = ctx.versions;
  const selected = selectedOrdinal(ctx);
  let fallback = "";
  const candidates: { ord: number; value: string }[] = [];
  const ids: string[] = [];

  for (const pair of pairs) {
    const key = pair.key.trim();
    if (key.toLowerCase() === "default" || key === "#default" || key === "") {
      fallback = pair.value;
      continue;
    }
    ids.push(key);
    const ord = ordinalOf(key, table);
    if (ord === null) {
      warnUnknown(meta, ctx, key);
      continue;
    }
    candidates.push({ ord, value: pair.value });
  }
  recordBoundaries(meta, ids);

  let best: { ord: number; value: string } | null = null;
  for (const candidate of candidates) {
    if (candidate.ord <= selected && (best === null || candidate.ord > best.ord)) {
      best = candidate;
    }
  }
  return best ? best.value : fallback;
}

/* ------------------------------------------------------------------ */
/* Version tags — the NAME is the range (versioning.md §2.1)           */
/* ------------------------------------------------------------------ */

/**
 * `<v70>` · `<v70+v80>` · `<v70+>`, anchored on the WHOLE name so an ordinary
 * tag can never be mistaken for one: `<var>`, `<video>` and `<v70x>` all fail.
 * The second id must be introduced by `+`, which is what stops `v70v80` from
 * reading as a window.
 */
const VERSION_TAG_RE = /^(v\d+(?:\.\d+)?)(?:(\+)(v\d+(?:\.\d+)?)?)?$/i;

/** One version tag, as its name spells it. Both ends are inclusive. */
export interface VersionTagRange {
  /** Lower bound, always present. */
  from: string;
  /** Upper bound; `null` when the tag is open-ended (`<v70+>`). */
  to: string | null;
  /** Every id the name spells, in source order — what recordBoundaries gets. */
  ids: string[];
}

/**
 * The one question the engine asks about a tag name. A version tag has no
 * fixed name to look up in a set — the name IS the range — so recognition is
 * by shape, and this is the single place that shape is written down.
 * Returns null for every other name.
 */
export function parseVersionTagName(name: string): VersionTagRange | null {
  const m = VERSION_TAG_RE.exec(name.trim());
  if (m === null) return null;
  const from = m[1];
  // No `+`: the tag applies to exactly one version, so both ends are that id,
  // and the id is named once — a boundary list must not repeat it.
  if (m[2] === undefined) return { from, to: from, ids: [from] };
  const to = m[3];
  if (to === undefined) return { from, to: null, ids: [from] };
  return { from, to, ids: [from, to] };
}

/** True when `name` is a version tag — see {@link parseVersionTagName}. */
export function isVersionTag(name: string): boolean {
  return VERSION_TAG_RE.test(name.trim());
}

/**
 * `<v70>body</v70>` and friends → `body` when the selection is inside the
 * range, `""` otherwise. The body is wikitext; the caller re-expands it in the
 * frame the tag was written in.
 *
 * Boundaries are recorded BEFORE the range is tested (versioning.md §3): the
 * selector must offer a branch this reader's `?v=` hides, and that is the
 * whole reason the recording exists.
 */
export function resolveVersionTag(
  tag: VersionTagRange,
  inner: string,
  ctx: ParseContext,
  meta: PageMeta,
): string {
  recordBoundaries(meta, tag.ids);

  // A tag name is `v<major>[.<minor>]` by construction, so `ordinalOf` always
  // has a derived ordinal to fall back on and these guards do not fire from
  // markup. They stay because `ordinalOf` may return null and §2.6's rule for
  // an id nothing can order is to hide the content and warn — unchanged.
  const table = ctx.versions;
  const from = ordinalOf(tag.from, table);
  if (from === null) {
    warnUnknown(meta, ctx, tag.from);
    return "";
  }
  let to = POS_INF;
  if (tag.to !== null) {
    const ord = ordinalOf(tag.to, table);
    if (ord === null) {
      warnUnknown(meta, ctx, tag.to);
      return "";
    }
    to = ord;
  }

  // An inverted window (`<v80+v70>`) holds for nothing and renders nothing:
  // swapping the ends for the author would put one version's text under
  // another version's id, which is the failure this whole feature is about.
  const selected = selectedOrdinal(ctx);
  return selected >= from && selected <= to ? inner : "";
}

/* ------------------------------------------------------------------ */
/* Magic words (versioning.md §2.5)                                    */
/* ------------------------------------------------------------------ */

/** `{{VERSION}}` … `{{ISLATESTVERSION}}`; returns null for unrelated names. */
export function evaluateVersionMagicWord(
  name: string,
  ctx: ParseContext,
): string | null {
  const id = selectedVersionId(ctx);
  const table = ctx.versions;
  switch (name.toUpperCase()) {
    case "VERSION":
      return id;
    case "VERSIONLABEL":
      return versionEntry(id, table)?.label ?? id;
    case "VERSIONORDINAL": {
      const ord = ordinalOf(id, table);
      return ord === null ? "" : String(ord);
    }
    case "LATESTVERSION":
      return table.defaultId;
    case "ISLATESTVERSION":
      return id === table.defaultId ? "1" : "";
    default:
      return null;
  }
}

export const VERSION_MAGIC_WORDS = [
  "VERSION",
  "VERSIONLABEL",
  "VERSIONORDINAL",
  "LATESTVERSION",
  "ISLATESTVERSION",
] as const;
