/**
 * Internal links, file/image links, and category links — spec §5.
 *
 * Stage 5 (inline) helper module. `scanInternalLinks` turns a region's raw
 * text into the flat `Piece` stream consumed by the rest of inline.ts; the
 * exported pure helpers (`titleKey`, `buildWikiLinkHref`, `wikiLinkTitleAttr`,
 * `fileStoreKey`) are the *shared* contract for the other stages:
 *
 *   - `titleKey(title)` is the `PageStore` key used by every stage
 *     (`"<nsId>:Page_name"`, types.ts §14.10) — the same spelling as
 *     magic-words.ts `titleKeyOf()` and db/store.ts `titleKey()`.
 *   - `buildWikiLinkHref` / `wikiLinkTitleAttr` build the `<a>` attributes for
 *     render.ts from a `WikiLink` node (the AST node carries the Title, not
 *     the href — spec §14.10).
 *   - `fileStoreKey(file)` is the `PageStore.getFile()` key (decisions O6
 *     canonical filename) for the `file` field of an `ImageLink`.
 *
 * Divergences: D-1 (well-nested output), D-6 (pipe trick at parse time),
 * D-7 (canonical file markup).
 */

import {
  canonicalFilename,
  NS_CATEGORY,
  NS_FILE,
  STORABLE_NS_BY_ID,
  normalizeTitle,
  nsPrefix,
  parseTitle,
  slugifyTitle,
  type ParsedTitle,
} from "@/lib/title";

import type { Piece } from "./inline";
import type {
  ImageLink,
  InlineNode,
  LanguageLink,
  PageMeta,
  ParseContext,
  Title,
  TitleKey,
  WikiLink,
} from "./types";

/* ------------------------------------------------------------------ */
/* Title keys, hrefs, title attributes                                 */
/* ------------------------------------------------------------------ */

/** Storable ns -> its db name; other known namespaces -> lowercased canonical. */
export function nsKeyName(namespace: number, ctx?: ParseContext): string {
  const storable = STORABLE_NS_BY_ID[namespace];
  if (storable) return storable;
  const canon = ctx?.config.namespaces.canonical[namespace];
  if (!canon) return `ns${namespace}`;
  return canon.toLowerCase().replace(/ /g, "_");
}

/**
 * The `"ns:Normalized_page_name"` cache key of types.ts §14.10 — numeric
 * namespace, colon, page name with spaces as underscores. Byte-identical to
 * `titleKeyOf()` in magic-words.ts and `titleKey()` in db/store.ts: every
 * consumer of `PageStore`, `meta.linksTo` and `meta.templatesUsed` must agree
 * on one spelling. (The `(namespace, slug)` identity of decisions O1 is
 * applied by the store, which slugifies the page name it parses back out.)
 */
export function titleKey(title: { namespace: number; pageName: string }): TitleKey {
  return `${title.namespace}:${normalizeTitle(title.pageName).replace(/ /g, "_")}`;
}

/** `PageStore.getFile()` key — the canonical stored filename (decisions O6). */
export function fileStoreKey(fileName: string): string {
  return canonicalFilename(fileName);
}

/** `$1` of `config.articlePath`: `nsPrefix + encodeURIComponent(slug)` (O1). */
export function linkPathSegment(
  title: { namespace: number; pageName: string },
  ctx?: ParseContext,
): string {
  const storable = STORABLE_NS_BY_ID[title.namespace];
  const prefix = storable ? nsPrefix(storable) : `${nsKeyName(title.namespace, ctx)}:`;
  return prefix + encodeURIComponent(slugifyTitle(title.pageName));
}

/**
 * Fragment for an href — spec §2.4 step 4 / §5.5: spaces -> `_`, then
 * `encodeURIComponent`, then `%3A` reverted for readability.
 */
export function encodeFragment(fragment: string): string {
  return encodeURIComponent(fragment.trim().replace(/\s+/g, "_")).replace(/%3A/g, ":");
}

/** Full display title including the canonical namespace prefix (no fragment). */
export function fullTitleText(title: Title, ctx: ParseContext): string {
  const canon = ctx.config.namespaces.canonical[title.namespace] ?? "";
  return canon === "" ? title.pageName : `${canon}:${title.pageName}`;
}

/** `href` for a `WikiLink` node (spec §5.2, §5.5; articlePath per Addendum A5). */
export function buildWikiLinkHref(link: WikiLink, ctx: ParseContext): string {
  const frag = link.target.fragment ? `#${encodeFragment(link.target.fragment)}` : "";
  if (link.selfAnchor) return frag === "" ? "#" : frag;
  const pattern = link.exists ? ctx.config.articlePath : ctx.config.redLinkPath;
  return pattern.replace("$1", linkPathSegment(link.target, ctx)) + frag;
}

/** `title` attribute for a `WikiLink` node; `null` = omit it (§5.2, §5.5). */
export function wikiLinkTitleAttr(link: WikiLink, ctx: ParseContext): string | null {
  if (link.selfAnchor) return null;
  const full = fullTitleText(link.target, ctx);
  return link.exists ? full : `${full} ${ctx.config.messages.redLinkTitleSuffix}`;
}

/* ------------------------------------------------------------------ */
/* Interlanguage links (Fandom extension — spec "Fandom extensions")   */
/* ------------------------------------------------------------------ */

/**
 * Language prefixes that make `[[<code>:Page]]` PAGE METADATA rather than a
 * link, exactly like `[[Category:…]]` (§5.10). MediaWiki drives this from the
 * interwiki table's `iw_local` language rows; hqhq-wiki has no interwiki table,
 * so the set is frozen here and documented in the spec's "Fandom extensions"
 * section: the ISO 639-1 two-letter set plus the handful of script/region
 * variants Fandom actually ships.
 *
 * Membership is checked ONLY for prefixes that are not already a namespace
 * alias (§5.8), so `[[File:X]]`, `[[Guide:X]]`, `[[Map:X]]` are untouched: a
 * prefix that is not in this set stays "just text before a colon" per §5.8.
 */
const LANGUAGE_CODES: ReadonlySet<string> = new Set([
  // ISO 639-1 (all 184 assigned two-letter codes).
  "aa", "ab", "ae", "af", "ak", "am", "an", "ar", "as", "av", "ay", "az",
  "ba", "be", "bg", "bh", "bi", "bm", "bn", "bo", "br", "bs",
  "ca", "ce", "ch", "co", "cr", "cs", "cu", "cv", "cy",
  "da", "de", "dv", "dz",
  "ee", "el", "en", "eo", "es", "et", "eu",
  "fa", "ff", "fi", "fj", "fo", "fr", "fy",
  "ga", "gd", "gl", "gn", "gu", "gv",
  "ha", "he", "hi", "ho", "hr", "ht", "hu", "hy", "hz",
  "ia", "id", "ie", "ig", "ii", "ik", "io", "is", "it", "iu",
  "ja", "jv",
  "ka", "kg", "ki", "kj", "kk", "kl", "km", "kn", "ko", "kr", "ks", "ku",
  "kv", "kw", "ky",
  "la", "lb", "lg", "li", "ln", "lo", "lt", "lu", "lv",
  "mg", "mh", "mi", "mk", "ml", "mn", "mr", "ms", "mt", "my",
  "na", "nb", "nd", "ne", "ng", "nl", "nn", "no", "nr", "nv", "ny",
  "oc", "oj", "om", "or", "os",
  "pa", "pi", "pl", "ps", "pt",
  "qu",
  "rm", "rn", "ro", "ru", "rw",
  "sa", "sc", "sd", "se", "sg", "si", "sk", "sl", "sm", "sn", "so", "sq",
  "sr", "ss", "st", "su", "sv", "sw",
  "ta", "te", "tg", "th", "ti", "tk", "tl", "tn", "to", "tr", "ts", "tt",
  "tw", "ty",
  "ug", "uk", "ur", "uz",
  "ve", "vi", "vo",
  "wa", "wo",
  "xh",
  "yi", "yo",
  "za", "zh", "zu",
  // Variants and non-639-1 wiki codes Fandom/Wikimedia use as link prefixes.
  "zh-hans", "zh-hant", "zh-cn", "zh-tw", "zh-hk", "zh-mo", "zh-sg", "zh-yue",
  "pt-br", "en-gb", "en-ca", "es-419", "fr-ca", "nl-be", "de-at", "de-ch",
  "sr-ec", "sr-el", "be-tarask", "roa-tara", "bat-smg", "fiu-vro", "map-bms",
  "nds", "nds-nl", "als", "ang", "arz", "ast", "azb", "bar", "bcl", "bpy",
  "bug", "cdo", "ceb", "ckb", "crh", "csb", "diq", "dsb", "eml", "ext",
  "frp", "frr", "fur", "gag", "gan", "glk", "hak", "haw", "hif", "hsb",
  "ilo", "jbo", "kaa", "kab", "kbd", "koi", "krc", "ksh", "lad", "lez",
  "lij", "lmo", "ltg", "mai", "mdf", "mhr", "min", "mrj", "mwl", "myv",
  "mzn", "nah", "nap", "new", "nov", "nrm", "pag", "pam", "pap", "pcd",
  "pdc", "pfl", "pms", "pnb", "rue", "sah", "scn", "sco", "sgs", "simple",
  "srn", "stq", "szl", "tet", "tpi", "udm", "vec", "vep", "vls", "vro",
  "war", "wuu", "xal", "xmf", "yue", "zea",
]);

/** A prefix is a language code only when it is spelled like one. */
const LANG_PREFIX_RE = /^([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)\s*:([\s\S]*)$/;

/**
 * `[[ru:Artifice]]` → `{ lang: "ru", title: "Artifice" }`; `null` when the
 * target is not an interlanguage link. The escaped form `[[:ru:Artifice]]`
 * returns `null` on purpose — a leading `:` forces plain-link handling for
 * language prefixes exactly as it does for `Category:`/`File:` (§5.8).
 */
export function parseLanguageLink(
  rawTarget: string,
  ctx: ParseContext,
): LanguageLink | null {
  const raw = rawTarget.trim();
  if (raw === "" || raw.startsWith(":") || raw.startsWith("#")) return null;
  const m = LANG_PREFIX_RE.exec(raw);
  if (!m) return null;
  const prefix = (m[1] as string).toLowerCase();
  // A real namespace always wins (§5.8) — `[[File:X]]` is never a lang link.
  if (ctx.config.namespaces.byAlias[prefix] !== undefined) return null;
  if (!LANGUAGE_CODES.has(prefix)) return null;
  const title = (m[2] as string).trim();
  if (title === "") return null;
  return { lang: prefix, title };
}

/* ------------------------------------------------------------------ */
/* Link scanning                                                       */
/* ------------------------------------------------------------------ */

export interface LinkScanDeps {
  ctx: ParseContext;
  meta: PageMeta;
  /** Recursive inline parse for file captions (§5.9). */
  parseCaption: (text: string) => InlineNode[];
}

/** Characters a link target may never contain (§5.1). */
const BAD_TARGET_CHARS = "<>[]{}|\n\r";

/** Sticky so the scan stays linear (§14.11): no per-character slicing. */
const TAG_TOKEN = /<\/?[A-Za-z][^<>]*>/y;

export interface LinkMatch {
  /** Index just past `]]` (the trail is reported separately). */
  end: number;
  trail: string;
  kind: "link" | "category" | "image" | "language";
  rawTarget: string;
  parsed: ParsedTitle | null;
  /** `kind === "language"` only: the swallowed interlanguage target. */
  language?: LanguageLink;
  selfAnchor: boolean;
  /** Raw text after the first top-level `|` (null when there is none). */
  rawLabel: string | null;
  /** File links only: every top-level `|`-separated parameter. */
  params: string[];
}

/**
 * Parse one `[[…]]` construct starting at `start` (`text[start] === "["`).
 * Pure: no metadata is recorded. `null` = not a link here (render literally;
 * the caller emits `[[` and resumes at `start + 2`, which reproduces the
 * "abandon the outer link" rule of §5.1 / corpus C-31).
 */
export function parseLinkAt(
  text: string,
  start: number,
  ctx: ParseContext,
): LinkMatch | null {
  if (text[start] !== "[" || text[start + 1] !== "[") return null;
  const from = start + 2;

  // ---- target: up to the first top-level "|" or "]]" -----------------
  let k = from;
  let sep: "|" | "]]" | null = null;
  while (k < text.length) {
    const ch = text[k];
    if (ch === "|") {
      sep = "|";
      break;
    }
    if (ch === "]" && text[k + 1] === "]") {
      sep = "]]";
      break;
    }
    if (BAD_TARGET_CHARS.includes(ch)) return null;
    k += 1;
  }
  if (sep === null) return null;
  const rawTarget = text.slice(from, k);

  const selfAnchor = rawTarget.trim().startsWith("#");
  // An interlanguage prefix is resolved BEFORE §5.7 title normalization: the
  // remainder names a page on another wiki, so this wiki's rules must not
  // touch it (Fandom extensions).
  const language = selfAnchor ? null : parseLanguageLink(rawTarget, ctx);
  const parsed = selfAnchor ? null : parseTitle(rawTarget, ctx.config.namespaces);
  if (!selfAnchor && parsed === null) return null;

  const isImage = parsed !== null && parsed.namespace === NS_FILE && !parsed.forcedPlain;

  // ---- body ----------------------------------------------------------
  let end: number;
  let body: string;
  if (isImage) {
    // File links balance nested "[[ ]]" so captions may contain links (§5.1).
    let depth = 0;
    let j = k;
    let close = -1;
    while (j < text.length) {
      if (text[j] === "[" && text[j + 1] === "[") {
        depth += 1;
        j += 2;
        continue;
      }
      if (text[j] === "]" && text[j + 1] === "]") {
        if (depth === 0) {
          close = j;
          break;
        }
        depth -= 1;
        j += 2;
        continue;
      }
      j += 1;
    }
    if (close < 0) return null;
    body = text.slice(k, close);
    end = close + 2;
  } else {
    // Non-file links do not nest: an inner "[[" abandons the outer one.
    let j = k;
    let close = -1;
    while (j < text.length) {
      if (text[j] === "[" && text[j + 1] === "[") return null;
      if (text[j] === "]" && text[j + 1] === "]") {
        close = j;
        break;
      }
      j += 1;
    }
    if (close < 0) return null;
    body = text.slice(k, close);
    end = close + 2;
  }

  // ---- trail (§5.4): ASCII lowercase letters only ---------------------
  let t = end;
  while (t < text.length && text[t] >= "a" && text[t] <= "z") t += 1;
  const trail = text.slice(end, t);

  const params = isImage ? splitTopLevel(body) : [];
  const rawLabel = sep === "|" ? body.slice(1) : null;
  const isCategory =
    parsed !== null && parsed.namespace === NS_CATEGORY && !parsed.forcedPlain;

  const match: LinkMatch = {
    end,
    trail,
    kind: isImage
      ? "image"
      : isCategory
        ? "category"
        : language !== null
          ? "language"
          : "link",
    rawTarget,
    parsed,
    selfAnchor,
    rawLabel,
    params,
  };
  if (language !== null && match.kind === "language") match.language = language;
  return match;
}

/** Split a file-link body (`"|a|b"`) on top-level pipes, `[[ ]]`-aware (§5.9). */
function splitTopLevel(body: string): string[] {
  if (body === "") return [];
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let i = body[0] === "|" ? 1 : 0;
  while (i < body.length) {
    if (body[i] === "[" && body[i + 1] === "[") {
      depth += 1;
      cur += "[[";
      i += 2;
      continue;
    }
    if (body[i] === "]" && body[i + 1] === "]") {
      depth = Math.max(0, depth - 1);
      cur += "]]";
      i += 2;
      continue;
    }
    if (body[i] === "|" && depth === 0) {
      out.push(cur);
      cur = "";
      i += 1;
      continue;
    }
    cur += body[i];
    i += 1;
  }
  out.push(cur);
  return out;
}

/* ------------------------------------------------------------------ */
/* Pipe trick & subpages                                               */
/* ------------------------------------------------------------------ */

/**
 * §5.3 pipe trick (computed at parse time — D-6). `rawTarget` is the target
 * exactly as written.
 */
export function pipeTrickLabel(rawTarget: string, ctx: ParseContext): string {
  const raw = rawTarget.trim();
  if (raw.includes("#")) return raw; // step 1: a fragment disables the trick
  let s = raw.replace(/^:/, "").trim();
  const colon = s.indexOf(":");
  if (colon >= 0) {
    const prefix = normalizeTitle(s.slice(0, colon)).toLowerCase();
    if (ctx.config.namespaces.byAlias[prefix] !== undefined) s = s.slice(colon + 1).trim();
  }
  const paren = /^(.*?)\s*\([^()]*\)$/.exec(s);
  if (paren && paren[1].trim() !== "") return paren[1].trim();
  const comma = s.indexOf(",");
  if (comma > 0) {
    const head = s.slice(0, comma).trim();
    if (head !== "") return head;
  }
  return s === "" ? raw : s;
}

/**
 * §5.6 subpage resolution against the page being rendered. Returns the
 * absolute page name plus the default label, or `null` when the link climbs
 * past the root (render literally).
 */
export function resolveSubpage(
  rawTarget: string,
  page: Title,
): { pageName: string; label: string } | null {
  const raw = rawTarget.trim();
  if (raw.startsWith("/")) {
    const trailingSlash = raw.endsWith("/") && raw.length > 1;
    const body = trailingSlash ? raw.slice(1, -1) : raw.slice(1);
    if (body === "") return null;
    const segs = body.split("/");
    return {
      pageName: `${page.pageName}/${body}`,
      label: trailingSlash ? segs[segs.length - 1] : raw,
    };
  }
  if (!raw.startsWith("../")) return null;
  let rest = raw;
  const segs = page.pageName.split("/");
  while (rest.startsWith("../")) {
    segs.pop();
    if (segs.length === 0) return null;
    rest = rest.slice(3);
  }
  const base = segs.join("/");
  if (rest === "") return { pageName: base, label: base };
  const trailingSlash = rest.endsWith("/");
  const body = trailingSlash ? rest.slice(0, -1) : rest;
  if (body === "") return { pageName: base, label: base };
  const parts = body.split("/");
  return {
    pageName: `${base}/${body}`,
    label: trailingSlash ? parts[parts.length - 1] : raw,
  };
}

/* ------------------------------------------------------------------ */
/* Metadata helpers                                                    */
/* ------------------------------------------------------------------ */

function recordLink(meta: PageMeta, key: TitleKey): void {
  if (!meta.linksTo.includes(key)) meta.linksTo.push(key);
}

function recordCategory(meta: PageMeta, name: string, sortKey: string | null): void {
  const existing = meta.categories.find((c) => c.name === name);
  if (existing) existing.sortKey = sortKey; // §5.10: last sort key wins
  else meta.categories.push({ name, sortKey });
}

/** Swallow one interlanguage link into `meta.languageLinks` (deduplicated). */
function recordLanguageLink(meta: PageMeta, link: LanguageLink): void {
  const list = (meta.languageLinks ??= []);
  if (list.some((l) => l.lang === link.lang && l.title === link.title)) return;
  list.push({ ...link });
}

/** Does this ns take part in `page_links`? (decisions O2 / db-schema A7.) */
function isStorable(namespace: number): boolean {
  return STORABLE_NS_BY_ID[namespace] !== undefined;
}

/* ------------------------------------------------------------------ */
/* Node construction                                                   */
/* ------------------------------------------------------------------ */

function makeTitle(parsed: ParsedTitle): Title {
  const t: Title = { namespace: parsed.namespace, pageName: parsed.pageName };
  if (parsed.fragment !== null) t.fragment = parsed.fragment;
  return t;
}

function pageExists(title: Title, deps: LinkScanDeps): boolean {
  // Non-storable namespaces are uncreatable ⇒ always red (decisions O2).
  if (!isStorable(title.namespace)) return false;
  return deps.ctx.store.exists(titleKey(title));
}

const SIZE_WH = /^(\d+)\s*x\s*(\d+)\s*px$/i;
const SIZE_W = /^(\d+)\s*px$/i;
const SIZE_H = /^x\s*(\d+)\s*px$/i;
const UPRIGHT = /^upright(?:[= ]\s*([0-9]*\.?[0-9]+))?$/i;

const FORMATS: Record<string, ImageLink["format"]> = {
  thumb: "thumb",
  thumbnail: "thumb",
  frame: "frame",
  framed: "frame",
  frameless: "frameless",
};
const HALIGN = new Set(["left", "right", "center", "none"]);
const VALIGN = new Set([
  "baseline",
  "sub",
  "super",
  "top",
  "text-top",
  "middle",
  "bottom",
  "text-bottom",
]);

const LINK_PROTOCOL =
  /^(?:https?|ftps?|sftp|ssh|git|svn|ircs?|xmpp|telnet|nntp|mailto|news|tel|sms|urn|geo|magnet|bitcoin):|^\/\//i;

/** Build an `ImageLink` from a parsed `[[File:…]]` construct (§5.9). */
export function buildImageLink(m: LinkMatch, deps: LinkScanDeps): ImageLink {
  const parsed = m.parsed as ParsedTitle;
  const node: ImageLink = {
    type: "image",
    file: parsed.pageName,
    exists: deps.ctx.store.getFile(fileStoreKey(parsed.pageName)) !== null,
    format: "inline",
    border: false,
    caption: [],
  };
  let caption: string | null = null;

  for (const rawParam of m.params) {
    const p = rawParam.trim();
    const lower = p.toLowerCase();
    if (FORMATS[lower]) {
      node.format = FORMATS[lower];
      continue;
    }
    if (HALIGN.has(lower)) {
      node.halign = lower as NonNullable<ImageLink["halign"]>;
      continue;
    }
    if (VALIGN.has(lower)) {
      node.valign = lower as NonNullable<ImageLink["valign"]>;
      continue;
    }
    if (lower === "border") {
      node.border = true;
      continue;
    }
    const up = UPRIGHT.exec(p);
    if (up) {
      node.upright = up[1] ? Number(up[1]) : deps.ctx.config.uprightDefaultFactor;
      continue;
    }
    const wh = SIZE_WH.exec(p);
    if (wh) {
      node.width = Number(wh[1]);
      node.height = Number(wh[2]);
      continue;
    }
    const w = SIZE_W.exec(p);
    if (w) {
      node.width = Number(w[1]);
      node.height = undefined;
      continue;
    }
    const h = SIZE_H.exec(p);
    if (h) {
      node.height = Number(h[1]);
      node.width = undefined;
      continue;
    }
    const eq = p.indexOf("=");
    if (eq > 0) {
      const key = p.slice(0, eq).trim().toLowerCase();
      const value = p.slice(eq + 1).trim();
      if (key === "alt") {
        node.alt = value;
        continue;
      }
      if (key === "link") {
        if (value === "") node.link = null;
        else if (LINK_PROTOCOL.test(value)) node.link = value;
        else {
          const lt = parseTitle(value, deps.ctx.config.namespaces);
          if (lt) node.link = makeTitle(lt);
        }
        continue;
      }
      // page=/class=/lang= are accepted and ignored here (§5.9 kv group).
      if (key === "page" || key === "class" || key === "lang") continue;
    }
    // Unmatched ⇒ caption candidate; the last one wins (§5.9).
    if (caption !== null) {
      deps.meta.warnings.push(
        `Ignored file parameter "${caption}" on [[File:${parsed.pageName}]]`,
      );
    }
    caption = rawParam;
  }

  if (caption !== null) node.caption = deps.parseCaption(caption);
  if (node.alt === undefined && caption === null) node.alt = parsed.pageName;
  return node;
}

/* ------------------------------------------------------------------ */
/* The scan                                                            */
/* ------------------------------------------------------------------ */

/**
 * §5.10: a line holding nothing but category links (+ whitespace) produces no
 * output line at all. Interlanguage links (Fandom extensions) are swallowed
 * the same way, so they join the rule. Returns that line's metadata links, or
 * `null`.
 */
function metadataOnlyLine(line: string, ctx: ParseContext): LinkMatch[] | null {
  const found: LinkMatch[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === " " || ch === "\t") {
      i += 1;
      continue;
    }
    if (ch !== "[" || line[i + 1] !== "[") return null;
    const m = parseLinkAt(line, i, ctx);
    if (!m || m.trail !== "") return null;
    if (m.kind !== "category" && m.kind !== "language") return null;
    found.push(m);
    i = m.end;
  }
  return found.length > 0 ? found : null;
}

function applyCategory(m: LinkMatch, meta: PageMeta): void {
  const parsed = m.parsed as ParsedTitle;
  const sort = m.rawLabel === null ? null : m.rawLabel.trim();
  // No explicit `|sortkey` ⇒ `{{DEFAULTSORT:}}` supplies one (Fandom
  // extensions); stage 2 is complete by now, so `meta.defaultSort` is final.
  const fallback = meta.defaultSort ?? null;
  recordCategory(meta, parsed.pageName, sort === null || sort === "" ? fallback : sort);
}

/** Apply one swallowed-from-output metadata link (§5.10 + interlanguage). */
function applyMetadataLink(m: LinkMatch, meta: PageMeta): void {
  if (m.kind === "language") {
    if (m.language) recordLanguageLink(meta, m.language);
    return;
  }
  applyCategory(m, meta);
}

/**
 * Stage 5 pass 2 (§14.6 step 2): region text -> piece stream with links,
 * images and categories resolved. Fills `meta.linksTo` (red links included,
 * Addendum A4) and `meta.categories`.
 */
export function scanInternalLinks(text: string, deps: LinkScanDeps): Piece[] {
  const { ctx, meta } = deps;

  // Category-only lines vanish completely, newline included (§5.10, C-32).
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const cats = metadataOnlyLine(line, ctx);
    if (cats === null) {
      kept.push(line);
      continue;
    }
    for (const c of cats) applyMetadataLink(c, meta);
  }
  const source = kept.join("\n");

  const out: Piece[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf !== "") {
      out.push({ k: "text", v: buf });
      buf = "";
    }
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "<") {
      // Skip whole tag tokens so "[[" inside an attribute is not link syntax.
      TAG_TOKEN.lastIndex = i;
      const tag = TAG_TOKEN.exec(source);
      if (tag) {
        buf += tag[0];
        i += tag[0].length;
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }
    if (ch !== "[" || source[i + 1] !== "[") {
      buf += ch;
      i += 1;
      continue;
    }
    const m = parseLinkAt(source, i, ctx);
    if (m === null) {
      buf += "[[";
      i += 2;
      continue;
    }

    if (m.kind === "category" || m.kind === "language") {
      applyMetadataLink(m, meta);
      buf += m.trail; // MW re-emits the trail of a swallowed metadata link
      i = m.end + m.trail.length;
      continue;
    }

    if (m.kind === "image") {
      flush();
      out.push({ k: "atom", n: buildImageLink(m, deps) });
      buf += m.trail;
      i = m.end + m.trail.length;
      continue;
    }

    flush();
    out.push(...buildWikiLinkPieces(m, deps));
    i = m.end + m.trail.length;
  }
  flush();
  return out;
}

function buildWikiLinkPieces(m: LinkMatch, deps: LinkScanDeps): Piece[] {
  const { ctx, meta } = deps;

  let target: Title;
  let defaultLabel: string;
  let selfAnchor = false;

  if (m.selfAnchor) {
    selfAnchor = true;
    target = {
      namespace: ctx.page.namespace,
      pageName: ctx.page.pageName,
      fragment: m.rawTarget.trim().slice(1),
    };
    defaultLabel = m.rawTarget.trim();
  } else {
    const raw = m.rawTarget.trim();
    if (raw.startsWith("/") || raw.startsWith("../")) {
      const sub = resolveSubpage(raw, ctx.page);
      if (sub === null) {
        // Climbs past the root ⇒ literal text (§5.6).
        const labelPart = m.rawLabel === null ? "" : `|${m.rawLabel}`;
        return [{ k: "text", v: `[[${m.rawTarget}${labelPart}]]${m.trail}` }];
      }
      target = { namespace: ctx.page.namespace, pageName: sub.pageName };
      defaultLabel = sub.label;
    } else {
      target = makeTitle(m.parsed as ParsedTitle);
      // The default label is the target as written, minus the leading ":"
      // of the plain-link form (§5.8, §5.10 example).
      defaultLabel = raw.startsWith(":") ? raw.slice(1).trim() : raw;
    }
  }

  let label: string;
  if (m.rawLabel === null) label = defaultLabel;
  else if (m.rawLabel.trim() === "") label = pipeTrickLabel(m.rawTarget, ctx);
  else label = m.rawLabel;

  const node: WikiLink = {
    type: "wikilink",
    target,
    exists: selfAnchor ? true : pageExists(target, deps),
    selfAnchor,
    children: [],
  };
  if (!selfAnchor && isStorable(target.namespace)) recordLink(meta, titleKey(target));

  return [
    { k: "open", n: node, anchor: true },
    { k: "text", v: label + m.trail },
    { k: "close" },
  ];
}
