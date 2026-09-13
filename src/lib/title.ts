/**
 * Title normalization, slugs, namespace parsing, and routing paths.
 *
 * Normative sources:
 * - docs/engine/decisions.md O1 (slug algorithm, articlePath), O2, O6
 * - docs/engine/wikitext-spec.md §5.7 (normalization), §5.8 (namespaces)
 * - docs/engine/db-schema.md Addendum A7 (numeric ↔ storable-string mapping)
 */

import type { NamespaceTable } from "@/lib/wikitext/types";

/* ------------------------------------------------------------------ */
/* Namespace tables                                                    */
/* ------------------------------------------------------------------ */

/**
 * Storable namespaces (db-schema §A). Structurally identical to
 * `Namespace` in src/lib/db/schema.ts; duplicated as literals here so this
 * module stays importable without pulling in drizzle.
 */
export const STORABLE_NAMESPACES = [
  "main",
  "template",
  "category",
  "file",
  "project",
] as const;
export type StorableNamespace = (typeof STORABLE_NAMESPACES)[number];

export const NS_MAIN = 0;
export const NS_PROJECT = 4;
export const NS_FILE = 6;
export const NS_TEMPLATE = 10;
export const NS_CATEGORY = 14;

/** db-schema Addendum A7: numeric engine namespace → storable string name. */
export const STORABLE_NS_BY_ID: Readonly<Record<number, StorableNamespace>> = {
  [NS_MAIN]: "main",
  [NS_PROJECT]: "project",
  [NS_FILE]: "file",
  [NS_TEMPLATE]: "template",
  [NS_CATEGORY]: "category",
};

export const NS_ID_BY_STORABLE: Readonly<Record<StorableNamespace, number>> = {
  main: NS_MAIN,
  project: NS_PROJECT,
  file: NS_FILE,
  template: NS_TEMPLATE,
  category: NS_CATEGORY,
};

/** Full engine namespace set (spec §5.8), site name alias included. */
export const DEFAULT_NAMESPACES: NamespaceTable = {
  canonical: {
    0: "",
    1: "Talk",
    2: "User",
    3: "User talk",
    4: "Project",
    5: "Project talk",
    6: "File",
    7: "File talk",
    8: "MediaWiki",
    9: "MediaWiki talk",
    10: "Template",
    11: "Template talk",
    12: "Help",
    13: "Help talk",
    14: "Category",
    15: "Category talk",
  },
  byAlias: {
    "talk": 1,
    "user": 2,
    "user talk": 3,
    "project": 4,
    "project talk": 5,
    "hqhq wiki": 4, // site name resolves to Project (spec §5.8)
    "hqhq wiki talk": 5,
    "file": 6,
    "file talk": 7,
    "image": 6, // alias
    "image talk": 7, // alias
    "mediawiki": 8,
    "mediawiki talk": 9,
    "template": 10,
    "template talk": 11,
    "help": 12,
    "help talk": 13,
    "category": 14,
    "category talk": 15,
  },
};

/* ------------------------------------------------------------------ */
/* Normalization & slugs                                               */
/* ------------------------------------------------------------------ */

/**
 * O1 step 1 / spec §5.7 step 2: `_`→space, collapse whitespace runs, trim,
 * Unicode NFC. No case changes here.
 */
export function normalizeTitle(title: string): string {
  return title
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFC");
}

/**
 * Deterministic slug — decisions O1, exact 5-step algorithm:
 * 1. normalizeTitle; 2. Unicode-aware lowercase; 3. whitespace runs → `-`;
 * 4. drop chars not in \p{L}\p{N}\p{M} `-` `(` `)` `.`;
 * 5. collapse `-{2,}` → `-`, trim leading/trailing `-`.
 */
export function slugifyTitle(title: string): string {
  return normalizeTitle(title)
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}\p{M}\-().]/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/* ------------------------------------------------------------------ */
/* Title parsing                                                       */
/* ------------------------------------------------------------------ */

export interface ParsedTitle {
  /** Numeric namespace (spec §5.8). Unknown prefixes are NOT namespaces (main). */
  namespace: number;
  /** Storable string name (db-schema A7) or null when not storable. */
  nsName: StorableNamespace | null;
  /**
   * False for known-but-unstorable namespaces (Talk, User, Help, MediaWiki
   * and talk variants): parseable, uncreatable, always red, never recorded
   * in page_links (decisions O2 / db-schema A7).
   */
  storable: boolean;
  /** Normalized page name (no ns prefix), first letter uppercased (§5.7 step 5). */
  pageName: string;
  /** slugifyTitle(pageName) — identity is (namespace, slug) per O1. */
  slug: string;
  /** Fragment kept verbatim; null when absent. */
  fragment: string | null;
  /** Leading `:` was present ([[:Category:X]] plain-link form, §5.8). */
  forcedPlain: boolean;
}

/** Minimal HTML entity decoding for title text (spec §5.7 step 1). */
function decodeTitleText(input: string): string {
  let s = input;
  if (s.includes("%")) {
    try {
      s = decodeURIComponent(s);
    } catch {
      /* malformed percent sequence: keep literal */
    }
  }
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(parseInt(dec, 10)),
    )
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

/** Uppercase the first letter (first code point), Unicode-aware (§5.7 step 5). */
function upperFirst(s: string): string {
  return s.replace(/^./u, (c) => c.toUpperCase());
}

/**
 * Parse a raw title/link target per spec §5.7–§5.8. Returns null when the
 * page name is empty after normalization (invalid title).
 */
export function parseTitle(
  input: string,
  namespaces: NamespaceTable = DEFAULT_NAMESPACES,
): ParsedTitle | null {
  let rest = decodeTitleText(input);

  // Fragment first, kept verbatim (§5.7 step 6).
  let fragment: string | null = null;
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    fragment = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }

  rest = normalizeTitle(rest);

  // Strip one leading ':' (§5.7 step 3).
  let forcedPlain = false;
  if (rest.startsWith(":")) {
    forcedPlain = true;
    rest = normalizeTitle(rest.slice(1));
  }

  // Namespace prefix at the first ':' (§5.7 step 4, §5.8).
  let namespace = NS_MAIN;
  let name = rest;
  const colon = rest.indexOf(":");
  if (colon >= 0) {
    const prefix = normalizeTitle(rest.slice(0, colon)).toLowerCase();
    const nsId = namespaces.byAlias[prefix];
    if (nsId !== undefined) {
      namespace = nsId;
      name = normalizeTitle(rest.slice(colon + 1));
    }
    // Unknown prefix: not a namespace, the colon is just text (§5.8).
  }

  if (name === "") return null;

  const pageName = upperFirst(name);
  const nsName = STORABLE_NS_BY_ID[namespace] ?? null;
  return {
    namespace,
    nsName,
    storable: nsName !== null,
    pageName,
    slug: slugifyTitle(pageName),
    fragment,
    forcedPlain,
  };
}

/**
 * `gold-bar` → `Gold bar` — the last-resort display name for a title with no
 * stored one: a page nobody has written yet (the create flow, decisions-v2
 * O14), a history row for a locale that has no title, a category with no
 * `Category:` page. Dashes and underscores become spaces, whitespace
 * collapses, the first letter is upper-cased (Unicode-aware); a slug that
 * humanizes to nothing comes back unchanged.
 *
 * One definition — read-view, edit-view, the history route, the categories
 * report and the pages API used to carry three copies of it.
 */
export function humanizeSlug(slug: string): string {
  const text = normalizeTitle(slug.replace(/-/g, " "));
  return text === "" ? slug : text.replace(/^./u, (char) => char.toUpperCase());
}

/* ------------------------------------------------------------------ */
/* Routing paths — `$1` = nsPrefix + slug (O1/O8)                      */
/* ------------------------------------------------------------------ */

/** `""` for main, else lowercase storable name + `":"` (decisions O1). */
export function nsPrefix(nsName: StorableNamespace): string {
  return nsName === "main" ? "" : `${nsName}:`;
}

/*
 * The locale-scoped half of routing (`titleToPath`, `articleHref`, `editHref`,
 * …) lives in src/lib/locale-path.ts: decisions-v2 O12 makes that module the
 * single owner of the URL scheme, and it imports `nsPrefix` / `parseTitle`
 * from here. This module deliberately knows nothing about locales.
 */

export interface PathTitle {
  namespace: number;
  nsName: StorableNamespace;
  slug: string;
}

/**
 * Inverse of titleToPath's `$1`: the `[...title]` catch-all value (string or
 * decoded segments array) → storable (namespace, slug). Returns null when
 * empty.
 */
export function pathToTitle(segments: string | string[]): PathTitle | null {
  const joined = Array.isArray(segments) ? segments.join("/") : segments;
  let raw = joined;
  if (raw.includes("%")) {
    try {
      raw = decodeURIComponent(raw);
    } catch {
      /* keep literal */
    }
  }
  raw = raw.normalize("NFC").trim();
  if (raw === "") return null;

  let nsName: StorableNamespace = "main";
  let slug = raw;
  const colon = raw.indexOf(":");
  if (colon >= 0) {
    const prefix = raw.slice(0, colon).toLowerCase();
    const match = STORABLE_NAMESPACES.find((n) => n !== "main" && n === prefix);
    if (match) {
      nsName = match;
      slug = raw.slice(colon + 1);
    }
  }
  if (slug === "") return null;
  return { namespace: NS_ID_BY_STORABLE[nsName], nsName, slug };
}

/* ------------------------------------------------------------------ */
/* Media filenames (decisions O6)                                      */
/* ------------------------------------------------------------------ */

/**
 * Canonical stored filename: NFC, lowercase (extension included),
 * whitespace/underscore runs → `-`. Unique-indexed in `files.filename`.
 */
export function canonicalFilename(name: string): string {
  return name.normalize("NFC").trim().toLowerCase().replace(/[\s_]+/g, "-");
}
