/**
 * Magic variables (`{{PAGENAME}}`, `{{CURRENTYEAR}}`, …) — spec §9.5 — plus
 * the version magic words (docs/engine/versioning.md §2.5).
 *
 * Stage 2 dispatches here through `ExpandHooks.evaluateMagicWord` (types.ts):
 * a `{{Name}}` with no colon asks this module first, because a variable
 * shadows a same-named template (§9.1). `null` means "not a variable" and
 * stage 2 continues with template resolution.
 *
 * Volatility (§9.5 CAUTION + db-schema Addendum A5): every `CURRENT*`/`LOCAL*`
 * variable calls `api.markVolatile()`, which suppresses the `parsed_cache`
 * upsert. The version magic words are deliberately NOT volatile — their output
 * is cached per version (versioning.md §2.5/§4) — but they do mark the page
 * version-scoped so the cache key carries the version.
 *
 * `{{!}}` / `{{=}}` (§7.10) are built-ins that stage 2 resolves itself, before
 * argument splitting can see them, so they are not part of this registry.
 */

import { DEFAULT_NAMESPACES, normalizeTitle } from "@/lib/title";
import type { ExpandApi, NamespaceTable, Title, TitleKey } from "./types";
import {
  VERSION_MAGIC_WORDS,
  evaluateVersionMagicWord,
  recordBoundaries,
} from "./versions";

/* ------------------------------------------------------------------ */
/* Title helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * The `"ns:Normalized_page_name"` cache key of types.ts §14.10: numeric
 * namespace, colon, page name with spaces as underscores. Shared so every
 * consumer of `PageStore` / `meta.linksTo` / `meta.templatesUsed` agrees.
 */
export function titleKey(namespace: number, pageName: string): TitleKey {
  return `${namespace}:${normalizeTitle(pageName).replace(/ /g, "_")}`;
}

/** `titleKey` for a {@link Title} (the fragment is not part of identity). */
export function titleKeyOf(title: Title): TitleKey {
  return titleKey(title.namespace, title.pageName);
}

/** Canonical namespace name, `""` for main (spec §5.8). */
export function namespaceName(namespace: number, namespaces: NamespaceTable): string {
  return namespaces.canonical[namespace] ?? "";
}

/** `Help:Guides/Routing` — namespace prefix + page name (§9.5 FULLPAGENAME). */
export function fullPageName(title: Title, namespaces: NamespaceTable): string {
  const ns = namespaceName(title.namespace, namespaces);
  return ns === "" ? title.pageName : `${ns}:${title.pageName}`;
}

/**
 * §5.7 "Href encoding": spaces → `_`, percent-encode, then revert the byte set
 * MediaWiki's `wfUrlencode` leaves readable. Also the `WIKI` mode of
 * `{{urlencode:}}` (§9.4) and the `…E` variants of §9.5.
 */
export function wikiUrlencode(value: string): string {
  return encodeURIComponent(value.replace(/ /g, "_"))
    .replace(/%2F/g, "/")
    .replace(/%3A/g, ":")
    .replace(/%21/g, "!")
    .replace(/%2A/g, "*")
    .replace(/%27/g, "'")
    .replace(/%28/g, "(")
    .replace(/%29/g, ")")
    .replace(/%2C/g, ",")
    .replace(/%3B/g, ";")
    .replace(/%40/g, "@")
    .replace(/%24/g, "$")
    .replace(/%7E/g, "~");
}

/* ------------------------------------------------------------------ */
/* Clock (§9.5 — config.timezone is UTC)                               */
/* ------------------------------------------------------------------ */

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** ISO-8601 week number (Monday-based, week containing the year's first Thursday). */
export function isoWeekNumber(date: Date): number {
  const target = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const dayIndex = (target.getUTCDay() + 6) % 7; // Monday = 0
  target.setUTCDate(target.getUTCDate() - dayIndex + 3); // Thursday of this week
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstIndex = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstIndex + 3);
  return 1 + Math.round((target.getTime() - firstThursday.getTime()) / 604_800_000);
}

function currentValue(name: string, now: Date): string | null {
  switch (name) {
    case "CURRENTYEAR":
      return String(now.getUTCFullYear());
    case "CURRENTMONTH":
    case "CURRENTMONTH2":
      return pad2(now.getUTCMonth() + 1);
    case "CURRENTMONTH1":
      return String(now.getUTCMonth() + 1);
    case "CURRENTMONTHNAME":
      return MONTH_NAMES[now.getUTCMonth()];
    case "CURRENTMONTHABBREV":
      return MONTH_NAMES[now.getUTCMonth()].slice(0, 3);
    case "CURRENTDAY":
      return String(now.getUTCDate());
    case "CURRENTDAY2":
      return pad2(now.getUTCDate());
    case "CURRENTDOW":
      return String(now.getUTCDay());
    case "CURRENTDAYNAME":
      return DAY_NAMES[now.getUTCDay()];
    case "CURRENTTIME":
      return `${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())}`;
    case "CURRENTHOUR":
      return pad2(now.getUTCHours());
    case "CURRENTWEEK":
      return String(isoWeekNumber(now));
    case "CURRENTTIMESTAMP":
      return (
        String(now.getUTCFullYear()) +
        pad2(now.getUTCMonth() + 1) +
        pad2(now.getUTCDate()) +
        pad2(now.getUTCHours()) +
        pad2(now.getUTCMinutes()) +
        pad2(now.getUTCSeconds())
      );
    default:
      return null;
  }
}

const CURRENT_WORDS = [
  "CURRENTYEAR",
  "CURRENTMONTH",
  "CURRENTMONTH1",
  "CURRENTMONTH2",
  "CURRENTMONTHNAME",
  "CURRENTMONTHABBREV",
  "CURRENTDAY",
  "CURRENTDAY2",
  "CURRENTDOW",
  "CURRENTDAYNAME",
  "CURRENTTIME",
  "CURRENTHOUR",
  "CURRENTWEEK",
  "CURRENTTIMESTAMP",
] as const;

/* ------------------------------------------------------------------ */
/* Page variables (§9.5)                                               */
/* ------------------------------------------------------------------ */

const PAGE_WORDS = [
  "PAGENAME",
  "FULLPAGENAME",
  "NAMESPACE",
  "NAMESPACENUMBER",
  "SUBPAGENAME",
  "BASEPAGENAME",
  "ROOTPAGENAME",
  "TALKPAGENAME",
  "SUBJECTPAGENAME",
] as const;

/** Subpage split on `/` (§9.5). Pages without a `/` are their own base/root. */
function pageVariable(
  name: string,
  page: Title,
  namespaces: NamespaceTable,
): string | null {
  const pageName = page.pageName;
  const lastSlash = pageName.lastIndexOf("/");
  switch (name) {
    case "PAGENAME":
      return pageName;
    case "FULLPAGENAME":
      return fullPageName(page, namespaces);
    case "NAMESPACE":
      return namespaceName(page.namespace, namespaces);
    case "NAMESPACENUMBER":
      return String(page.namespace);
    case "SUBPAGENAME":
      return lastSlash >= 0 ? pageName.slice(lastSlash + 1) : pageName;
    case "BASEPAGENAME":
      return lastSlash >= 0 ? pageName.slice(0, lastSlash) : pageName;
    case "ROOTPAGENAME": {
      const firstSlash = pageName.indexOf("/");
      return firstSlash >= 0 ? pageName.slice(0, firstSlash) : pageName;
    }
    case "TALKPAGENAME": {
      const talkNs = page.namespace % 2 === 0 ? page.namespace + 1 : page.namespace;
      return fullPageName({ ...page, namespace: talkNs }, namespaces);
    }
    case "SUBJECTPAGENAME": {
      const subjectNs = page.namespace % 2 === 1 ? page.namespace - 1 : page.namespace;
      return fullPageName({ ...page, namespace: subjectNs }, namespaces);
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

/**
 * Every recognized `{{WORD}}` (no colon). ALL-CAPS names are matched
 * case-**sensitively** per §9.1.
 */
export const MAGIC_WORDS: ReadonlySet<string> = new Set<string>([
  ...PAGE_WORDS,
  ...PAGE_WORDS.map((word) => `${word}E`),
  "SITENAME",
  "SERVER",
  "SERVERNAME",
  ...CURRENT_WORDS,
  ...CURRENT_WORDS.map((word) => word.replace(/^CURRENT/, "LOCAL")),
  "REVISIONID",
  "NUMBEROFARTICLES",
  ...VERSION_MAGIC_WORDS,
]);

export function isMagicWord(name: string): boolean {
  return MAGIC_WORDS.has(name);
}

/**
 * Resolve a no-argument `{{WORD}}`. Returns `null` when `name` is not a
 * registered variable, so stage 2 falls through to template resolution.
 */
export function evaluateMagicWord(name: string, api: ExpandApi): string | null {
  if (!MAGIC_WORDS.has(name)) return null;

  const ctx = api.ctx;
  const namespaces = ctx.config.namespaces ?? DEFAULT_NAMESPACES;

  // Version magic words: not volatile, but they key the cache by version
  // (versioning.md §2.5/§4), which is what `versionScoped` drives.
  if ((VERSION_MAGIC_WORDS as readonly string[]).includes(name)) {
    const value = evaluateVersionMagicWord(name, ctx);
    if (value !== null) {
      recordBoundaries(api.meta, []);
      return value;
    }
  }

  // `LOCAL*` are aliases for the same clock (§9.5).
  const clockName = name.startsWith("LOCAL") ? name.replace(/^LOCAL/, "CURRENT") : name;
  const current = currentValue(clockName, ctx.now ?? new Date());
  if (current !== null) {
    api.markVolatile();
    return current;
  }

  const plain = pageVariable(name, ctx.page, namespaces);
  if (plain !== null) return plain;

  // `…E` variants: href-encoded per §5.7.
  if (name.endsWith("E")) {
    const encoded = pageVariable(name.slice(0, -1), ctx.page, namespaces);
    if (encoded !== null) return wikiUrlencode(encoded);
  }

  switch (name) {
    case "SITENAME":
      return ctx.config.siteName;
    case "SERVER":
    case "SERVERNAME":
    case "REVISIONID":
    case "NUMBEROFARTICLES":
      // §9.5: optional; empty string when the store cannot answer. WikiConfig
      // carries no origin, so these stay empty until one is threaded through.
      return "";
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* {{DEFAULTSORT:key}} — Fandom parity (wikitext-spec "Fandom          */
/* extensions"; MediaWiki's DEFAULTSORTKEY / DEFAULTCATEGORYSORT)      */
/* ------------------------------------------------------------------ */

/** The colon-function spellings MediaWiki accepts for the default sort key. */
export const DEFAULT_SORT_NAMES: ReadonlySet<string> = new Set([
  "defaultsort",
  "defaultsortkey",
  "defaultcategorysort",
]);

/**
 * `{{DEFAULTSORT:key}}` records the page-wide category sort key and expands to
 * nothing. The key is trimmed; an empty key clears it. Last one on the page
 * wins (MediaWiki warns on a conflicting redefinition — so do we).
 *
 * Stage 5 (links.ts `applyCategory`) reads `meta.defaultSort` for every
 * `[[Category:X]]` that carries no explicit `|sortkey`, which is safe because
 * stage 2 has fully completed before any category link is scanned (§14.3 runs
 * before §14.6), so the switch works ahead of AND behind the category links.
 */
export function evaluateDefaultSort(key: string, api: ExpandApi): string {
  const value = key.trim();
  const previous = api.meta.defaultSort;
  if (value === "") {
    delete api.meta.defaultSort;
    return "";
  }
  if (previous !== undefined && previous !== value) {
    api.warn(`Default sort key redefined: "${previous}" replaced by "${value}"`);
  }
  api.meta.defaultSort = value;
  return "";
}
