/**
 * What a version selector should actually offer — docs/engine/versioning.md §6.
 *
 * A page that branches at v56 and v73 renders *identically* for every version
 * between them: read at v60, v65 or v70 it shows the v56 branch. So the control
 * offers the **boundaries** — the versions where the page says something
 * different — and the registry stays behind a secondary dropdown. High-quota
 * players run several patches at once, and this is how one page serves all of
 * them without asking anyone to scroll a list of thirteen identical renders.
 *
 * The rule this module exists for is §6's first one: **the active branch is the
 * one that governs the selection, not one whose id equals it.** Boundaries
 * `[v56, v73]` read at the site default v70 show the v56 branch; an equality
 * test highlights nothing there, which is exactly the state a reader cannot
 * interpret.
 *
 * It also owns the **tag-name grammar** for every surface outside the engine
 * (§2.1): `<v70>`, `<v70+v80>` and `<v70+>` name their own range, so reading a
 * range and spelling one are the same two questions the editor asks everywhere
 * it meets version markup — the highlighter, the block classifier, the dialog,
 * the in-place field and the chip strip.
 *
 * Universal by design: the reading view renders it on the server and the editor
 * renders it from the live buffer, so it may not import the engine (which is
 * server-side and heavy) — hence the local ordinal rule and the local copy of
 * the tag-name shape, both pinned against the engine's own by drift tests in
 * version-branches.test.ts.
 */

/** One row of the registry, as either surface has it to hand. */
export interface VersionRegistryEntry {
  id: string;
  label: string;
  /** The registry's own sort key; derived from the id when absent. */
  ordinal?: number;
}

export interface VersionBranch {
  /** The boundary id, spelled as the page wrote it. */
  id: string;
  /** Registry label, or the raw id for a version nobody registered. */
  label: string;
  /**
   * The newest registered version this branch still covers, when the registry
   * knows one; null when it knows none in the window (a lone unregistered
   * boundary, say). Equal to `id` when the branch covers only its own version.
   */
  until: string | null;
  untilLabel: string | null;
  /** No later boundary: this branch runs to the newest version and beyond. */
  openEnded: boolean;
  /** This branch is what the current selection renders. */
  active: boolean;
  /** The page names a version the registry does not have (§1). */
  unregistered: boolean;
}

/**
 * `major*1000 + minor` for ids shaped `v<major>[.<minor>]`, matching the
 * engine's `deriveOrdinal`. A non-finite result is refused rather than returned
 * as a sort key that outranks everything (the `v` + 400 digits case).
 */
export function deriveVersionOrdinal(id: string): number | null {
  const match = /^v(\d+)(?:\.(\d+))?$/i.exec(id.trim());
  if (match === null) return null;
  const ordinal = Number(match[1]) * 1000 + (match[2] ? Number(match[2]) : 0);
  return Number.isSafeInteger(ordinal) ? ordinal : null;
}

/** Registry ordinal, falling back to the derived one. `null` = unorderable. */
export function versionOrdinal(
  id: string,
  registry: readonly VersionRegistryEntry[],
): number | null {
  const key = id.trim().toLowerCase();
  for (const entry of registry) {
    if (entry.id.trim().toLowerCase() !== key) continue;
    return entry.ordinal ?? deriveVersionOrdinal(entry.id);
  }
  return deriveVersionOrdinal(id);
}

function registryEntry(
  id: string,
  registry: readonly VersionRegistryEntry[],
): VersionRegistryEntry | null {
  const key = id.trim().toLowerCase();
  return registry.find((entry) => entry.id.trim().toLowerCase() === key) ?? null;
}

/**
 * The page's boundaries, deduped and ordinal-ascending. Ids the ordinal rule
 * cannot read keep their place at the end rather than being dropped — the page
 * names them, so the author has to be able to see them (§6).
 */
export function sortBoundaries(
  boundaries: readonly string[],
  registry: readonly VersionRegistryEntry[],
): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of boundaries) {
    const id = raw.trim();
    if (id === "" || id === "*") continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(id);
  }
  return unique.sort((a, b) => {
    const oa = versionOrdinal(a, registry);
    const ob = versionOrdinal(b, registry);
    if (oa === null && ob === null) return a.localeCompare(b);
    if (oa === null) return 1;
    if (ob === null) return -1;
    return oa - ob;
  });
}

/**
 * The boundary whose branch `selected` renders — the greatest boundary at or
 * below it. `null` when the selection sits below every boundary (a page whose
 * writing starts later than the reader's version, or that has none at all) or
 * when neither can be ordered.
 */
export function governingBoundary(
  boundaries: readonly string[],
  registry: readonly VersionRegistryEntry[],
  selected: string,
): string | null {
  const target = versionOrdinal(selected, registry);
  if (target === null) return null;
  let winner: string | null = null;
  let winnerOrdinal = Number.NEGATIVE_INFINITY;
  for (const id of sortBoundaries(boundaries, registry)) {
    const ordinal = versionOrdinal(id, registry);
    if (ordinal === null || ordinal > target) continue;
    if (ordinal >= winnerOrdinal) {
      winner = id;
      winnerOrdinal = ordinal;
    }
  }
  return winner;
}

/**
 * The selector's model: one entry per boundary, each knowing the span it covers
 * and whether it is the branch on screen.
 *
 * A branch's span ends at the newest registered version strictly below the next
 * boundary — computed from the registry rather than from arithmetic, because
 * "v56 → v72" would name a version that may not exist while "v56 → v70" names
 * one a reader can actually be running.
 */
export function pageVersionBranches(input: {
  boundaries: readonly string[];
  registry: readonly VersionRegistryEntry[];
  selected: string;
}): VersionBranch[] {
  const { registry, selected } = input;
  const ordered = sortBoundaries(input.boundaries, registry);
  const governing = governingBoundary(ordered, registry, selected);

  return ordered.map((id, index) => {
    const entry = registryEntry(id, registry);
    const start = versionOrdinal(id, registry);
    const nextId = ordered[index + 1];
    const nextOrdinal = nextId === undefined ? null : versionOrdinal(nextId, registry);

    // The window is [this boundary, one below the next); the last branch has no
    // upper bound at all.
    let until: VersionRegistryEntry | null = null;
    if (start !== null) {
      for (const candidate of registry) {
        const ordinal = candidate.ordinal ?? deriveVersionOrdinal(candidate.id);
        if (ordinal === null || ordinal < start) continue;
        if (nextOrdinal !== null && ordinal >= nextOrdinal) continue;
        const best = until === null ? null : (until.ordinal ?? deriveVersionOrdinal(until.id));
        if (best === null || ordinal > best) until = candidate;
      }
    }

    return {
      id,
      label: entry?.label ?? id,
      until: until?.id ?? null,
      untilLabel: until?.label ?? null,
      openEnded: nextId === undefined,
      active: governing !== null && governing.toLowerCase() === id.toLowerCase(),
      unregistered: entry === null,
    };
  });
}

/* ------------------------------------------------------------------ */
/* The tag-name grammar (versioning.md §2.1)                           */
/* ------------------------------------------------------------------ */

/**
 * `^v<major>[.<minor>]([+][v<major>[.<minor>]]?)?$`, anchored on the WHOLE
 * name — the engine's `VERSION_TAG_RE` (src/lib/wikitext/versions.ts), copied
 * for the reason the module header gives and pinned to it by a drift test.
 *
 * Anchoring is the whole safety of the grammar: `<var>`, `<video>` and
 * `<v70x>` are ordinary tags, and the `+` before the second id is what stops
 * `v70v80` from reading as a window.
 */
const VERSION_TAG_NAME_RE = /^(v\d+(?:\.\d+)?)(?:(\+)(v\d+(?:\.\d+)?)?)?$/i;

/** The range one version tag's name spells. Both ends are inclusive. */
export interface VersionTagRange {
  /** Lower bound, always present. */
  from: string;
  /** Upper bound; `null` when the tag is open-ended (`<v70+>`). */
  to: string | null;
}

/**
 * The range a tag NAME carries, or null for every name that is not one.
 *
 * `<v70>` comes back as a window on itself (`to === from`) rather than as a
 * third shape, because that is what it means and it saves every caller a case:
 * "does this tag cover the version I am looking at" is one comparison for all
 * three forms.
 */
export function readVersionTagName(name: string): VersionTagRange | null {
  const match = VERSION_TAG_NAME_RE.exec(name.trim());
  if (match === null) return null;
  const from = match[1];
  if (match[2] === undefined) return { from, to: from };
  return { from, to: match[3] ?? null };
}

/** True when `name` is a version tag — see {@link readVersionTagName}. */
export function isVersionTagName(name: string): boolean {
  return VERSION_TAG_NAME_RE.test(name.trim());
}

/**
 * The name that spells a range: `v70` · `v70+v80` · `v70+`.
 *
 * A window whose ends are the same version IS the single-version form, and is
 * written as one — `<v70+v70>` and `<v70>` mean the same thing, and only the
 * second one reads like what it means. Ids are emitted folded, the spelling
 * the registry keeps them in, so a page's boundaries line up with `versions.id`
 * however the author typed them.
 */
export function versionTagName(range: VersionTagRange): string {
  const from = range.from.trim().toLowerCase();
  if (range.to === null) return `${from}+`;
  const to = range.to.trim().toLowerCase();
  return to === from ? from : `${from}+${to}`;
}

/**
 * Whether a tag's range holds `id` — the one question every surface asks about
 * a version tag, so it is asked in one place.
 *
 * An end nothing can order is treated as no end at all rather than as an empty
 * window: a tag naming a version this registry has never heard of still writes
 * for the versions it names, and hiding it would be this module inventing a
 * fact the engine does not have (§2.6).
 */
export function versionTagCovers(
  range: VersionTagRange,
  id: string,
  registry: readonly VersionRegistryEntry[] = [],
): boolean {
  const target = versionOrdinal(id, registry);
  const from = versionOrdinal(range.from, registry);
  if (target === null || from === null || target < from) return false;
  if (range.to === null) return true;
  const to = versionOrdinal(range.to, registry);
  return to === null ? true : target <= to;
}

/**
 * Where a window ends when another one starts at `next`: the newest registered
 * id strictly below `next`, with `from` as the floor.
 *
 * **Registered ids, never arithmetic** (versioning.md §2.2). "One below v62" is
 * a number, and the number may name a version that was never released; the end
 * of a branch is a version somebody can actually be running. With v60 and v62
 * registered and nothing between, a branch starting at v56 ends at v60.
 *
 * The floor is what keeps the answer a window rather than an inversion: when
 * the registry knows nothing between the two, a branch ends on the version it
 * started on — `<v70+v70>`, which {@link versionTagName} writes `<v70>`.
 *
 * `null` means open-ended: nothing follows, so the tag is `<vX+>`.
 */
export function branchEnd(
  from: string,
  next: string | null,
  registry: readonly VersionRegistryEntry[],
): string | null {
  if (next === null) return null;
  const start = versionOrdinal(from, registry);
  const limit = versionOrdinal(next, registry);
  if (start === null || limit === null) return from;

  let best = from;
  let bestOrdinal = start;
  for (const entry of registry) {
    const ordinal = versionOrdinal(entry.id, registry);
    if (ordinal === null || ordinal < start || ordinal >= limit) continue;
    if (ordinal > bestOrdinal) {
      best = entry.id;
      bestOrdinal = ordinal;
    }
  }
  return best;
}
