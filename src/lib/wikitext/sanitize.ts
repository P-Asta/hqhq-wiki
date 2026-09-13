/**
 * Stage 3 — raw-HTML sanitization (spec §11, §14.4) plus the escaping,
 * character-reference and tag-token primitives every later stage needs.
 *
 * Contract (index.ts / EngineStages): `sanitizeRawHtml(expanded, ctx)`.
 * Input is the expanded wikitext of stage 2 (strip markers included); output
 * is the same text where
 *   - every well-formed tag whose name is on the §11.1 allowlist is rewritten
 *     into a canonical token (`<b>`, `<td colspan="2">`, `<br />`), with its
 *     attributes filtered per §11.3 and its `style` per §11.4, and
 *   - every other `<` is escaped in place (`&lt;`), so after this stage the
 *     only `<` characters in the text open a sanctioned tag (§14.4).
 *
 * Strip markers (U+007F + `'"UNIQ--<name>-<8 hex>-QINU"'` + U+007F) are opaque
 * here: they contain no `<`, `>` or `&`, so every routine in this file passes
 * them through byte-for-byte.
 *
 * `>` in running text is NOT escaped here — text nodes are escaped once, at
 * render (`escapeText`), which is also the only place `&` is touched. That
 * keeps the `&lt;` produced here from being double-escaped later: `escapeText`
 * leaves a valid character reference alone (MediaWiki's
 * `normalizeCharReferences` rule).
 *
 * This module is a leaf: it imports nothing from the engine except types.
 */

import { DEFAULT_NAMESPACES, normalizeTitle, parseTitle } from "@/lib/title";

import type { Attrs, ParseContext, Title } from "./types";

/* ------------------------------------------------------------------ */
/* §11.1 element allowlist                                             */
/* ------------------------------------------------------------------ */

export const HTML_INLINE_TAGS: ReadonlySet<string> = new Set([
  "b", "i", "em", "strong", "s", "strike", "u", "del", "ins", "sub", "sup",
  "small", "big", "code", "tt", "kbd", "samp", "var", "abbr", "cite", "dfn",
  "q", "mark", "bdi", "bdo", "span", "time", "data", "wbr", "br", "font",
  "ruby", "rb", "rt", "rp",
]);

export const HTML_BLOCK_TAGS: ReadonlySet<string> = new Set([
  "div", "p", "blockquote", "pre", "center", "hr", "h1", "h2", "h3", "h4",
  "h5", "h6", "ul", "ol", "li", "dl", "dt", "dd", "table", "caption", "thead",
  "tbody", "tfoot", "tr", "td", "th", "figure", "figcaption", "details",
  "summary",
]);

/** Void elements (§11.1): self-closing or bare; `</br>` normalizes to `<br />`. */
export const VOID_TAGS: ReadonlySet<string> = new Set(["br", "hr", "wbr"]);

/**
 * Raw block-level elements whose content model rejects `<p>` (Addendum A1 /
 * divergence D-14). While one of these is open, blank lines emit nothing.
 * Exported for blocks.ts, which folds `updatePRejectingDepth` over the
 * sanitized lines it consumes.
 */
export const P_REJECTING_TAGS: ReadonlySet<string> = new Set([
  "table", "thead", "tbody", "tfoot", "tr", "ul", "ol", "dl",
]);

/** §3.1 rule 4: a line whose first token is one of these is not `<p>`-wrapped. */
export const BLOCK_LINE_TAGS: ReadonlySet<string> = new Set([
  "table", "caption", "thead", "tbody", "tfoot", "tr", "td", "th", "div",
  "blockquote", "ol", "ul", "dl", "li", "dt", "dd", "pre", "p", "h1", "h2",
  "h3", "h4", "h5", "h6", "hr", "center", "figure", "figcaption",
]);

export function isAllowedTag(name: string): boolean {
  return HTML_INLINE_TAGS.has(name) || HTML_BLOCK_TAGS.has(name);
}

/* ------------------------------------------------------------------ */
/* §11.3 attribute allowlist                                           */
/* ------------------------------------------------------------------ */

const GLOBAL_ATTRS: ReadonlySet<string> = new Set([
  "id", "class", "style", "lang", "dir", "title", "role",
  "aria-describedby", "aria-flowto", "aria-hidden", "aria-label",
  "aria-labelledby", "aria-owns",
]);

const PER_ELEMENT_ATTRS: Readonly<Record<string, readonly string[]>> = {
  table: ["border", "cellpadding", "cellspacing", "align", "bgcolor", "frame", "rules", "summary", "width"],
  td: ["colspan", "rowspan", "headers", "scope", "abbr", "axis", "align", "valign", "bgcolor", "width", "height", "nowrap"],
  th: ["colspan", "rowspan", "headers", "scope", "abbr", "axis", "align", "valign", "bgcolor", "width", "height", "nowrap"],
  tr: ["align", "valign", "bgcolor"],
  ol: ["start", "reversed", "type"],
  li: ["value", "type"],
  blockquote: ["cite"],
  q: ["cite"],
  del: ["cite", "datetime"],
  ins: ["cite", "datetime"],
  time: ["datetime"],
  bdo: ["dir"],
  font: ["size", "color", "face"],
  br: ["clear"],
  h1: ["align"], h2: ["align"], h3: ["align"], h4: ["align"], h5: ["align"], h6: ["align"],
  p: ["align"],
  div: ["align"],
  hr: ["align", "width", "noshade"],
};

/** `cite` values are URLs — scheme-checked like §6.1. */
const URL_ATTRS: ReadonlySet<string> = new Set(["cite"]);

const ALLOWED_SCHEMES = [
  "http://", "https://", "ftp://", "ftps://", "sftp://", "ssh://", "git://",
  "svn://", "irc://", "ircs://", "xmpp:", "telnet://", "nntp://", "mailto:",
  "news:", "tel:", "sms:", "urn:", "geo:", "magnet:", "bitcoin:",
];

/** §6.1 — protocol-relative `//` included. `javascript:`/`data:` never pass. */
export function hasAllowedScheme(url: string): boolean {
  const u = url.trim().toLowerCase();
  if (u.startsWith("//")) return true;
  return ALLOWED_SCHEMES.some((s) => u.startsWith(s));
}

const BAD_DATA_ATTRS: ReadonlySet<string> = new Set(["data-mw", "data-parsoid", "data-ooui"]);

function isAllowedAttrName(tag: string, name: string): boolean {
  if (GLOBAL_ATTRS.has(name)) return true;
  if (name.startsWith("data-")) {
    if (BAD_DATA_ATTRS.has(name)) return false;
    return /^data-[a-z0-9_.:-]+$/.test(name);
  }
  const extra = PER_ELEMENT_ATTRS[tag];
  return extra !== undefined && extra.includes(name);
}

/* ------------------------------------------------------------------ */
/* §11.5 character references                                          */
/* ------------------------------------------------------------------ */

/**
 * Recognized named references. The spec asks for "all HTML5 named entities";
 * this is the pragmatic working set (the long tail is vanishingly rare in
 * wikitext, and an unrecognized `&word;` merely renders as `&amp;word;`).
 */
export const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
  iexcl: "¡", cent: "¢", pound: "£", curren: "¤",
  yen: "¥", brvbar: "¦", sect: "§", uml: "¨",
  copy: "©", ordf: "ª", laquo: "«", not: "¬",
  shy: "­", reg: "®", macr: "¯", deg: "°",
  plusmn: "±", sup2: "²", sup3: "³", acute: "´",
  micro: "µ", para: "¶", middot: "·", cedil: "¸",
  sup1: "¹", ordm: "º", raquo: "»", frac14: "¼",
  frac12: "½", frac34: "¾", iquest: "¿", Agrave: "À",
  Aacute: "Á", Acirc: "Â", Atilde: "Ã", Auml: "Ä",
  Aring: "Å", AElig: "Æ", Ccedil: "Ç", Egrave: "È",
  Eacute: "É", Ecirc: "Ê", Euml: "Ë", Igrave: "Ì",
  Iacute: "Í", Icirc: "Î", Iuml: "Ï", ETH: "Ð",
  Ntilde: "Ñ", Ograve: "Ò", Oacute: "Ó", Ocirc: "Ô",
  Otilde: "Õ", Ouml: "Ö", times: "×", Oslash: "Ø",
  Ugrave: "Ù", Uacute: "Ú", Ucirc: "Û", Uuml: "Ü",
  Yacute: "Ý", THORN: "Þ", szlig: "ß", agrave: "à",
  aacute: "á", acirc: "â", atilde: "ã", auml: "ä",
  aring: "å", aelig: "æ", ccedil: "ç", egrave: "è",
  eacute: "é", ecirc: "ê", euml: "ë", igrave: "ì",
  iacute: "í", icirc: "î", iuml: "ï", eth: "ð",
  ntilde: "ñ", ograve: "ò", oacute: "ó", ocirc: "ô",
  otilde: "õ", ouml: "ö", divide: "÷", oslash: "ø",
  ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü",
  yacute: "ý", thorn: "þ", yuml: "ÿ", OElig: "Œ",
  oelig: "œ", Scaron: "Š", scaron: "š", Yuml: "Ÿ",
  fnof: "ƒ", circ: "ˆ", tilde: "˜", ensp: " ",
  emsp: " ", thinsp: " ", zwnj: "‌", zwj: "‍",
  lrm: "‎", rlm: "‏", ndash: "–", mdash: "—",
  lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“",
  rdquo: "”", bdquo: "„", dagger: "†", Dagger: "‡",
  bull: "•", hellip: "…", permil: "‰", prime: "′",
  Prime: "″", lsaquo: "‹", rsaquo: "›", oline: "‾",
  frasl: "⁄", euro: "€", trade: "™", larr: "←",
  uarr: "↑", rarr: "→", darr: "↓", harr: "↔",
  crarr: "↵", lArr: "⇐", uArr: "⇑", rArr: "⇒",
  dArr: "⇓", hArr: "⇔", forall: "∀", part: "∂",
  exist: "∃", empty: "∅", nabla: "∇", isin: "∈",
  notin: "∉", ni: "∋", prod: "∏", sum: "∑",
  minus: "−", lowast: "∗", radic: "√", prop: "∝",
  infin: "∞", ang: "∠", and: "∧", or: "∨",
  cap: "∩", cup: "∪", int: "∫", there4: "∴",
  sim: "∼", cong: "≅", asymp: "≈", ne: "≠",
  equiv: "≡", le: "≤", ge: "≥", sub: "⊂",
  sup: "⊃", nsub: "⊄", sube: "⊆", supe: "⊇",
  oplus: "⊕", otimes: "⊗", perp: "⊥", sdot: "⋅",
  lceil: "⌈", rceil: "⌉", lfloor: "⌊", rfloor: "⌋",
  lang: "〈", rang: "〉", loz: "◊", spades: "♠",
  clubs: "♣", hearts: "♥", diams: "♦", Alpha: "Α",
  Beta: "Β", Gamma: "Γ", Delta: "Δ", Epsilon: "Ε",
  Zeta: "Ζ", Eta: "Η", Theta: "Θ", Iota: "Ι",
  Kappa: "Κ", Lambda: "Λ", Mu: "Μ", Nu: "Ν",
  Xi: "Ξ", Omicron: "Ο", Pi: "Π", Rho: "Ρ",
  Sigma: "Σ", Tau: "Τ", Upsilon: "Υ", Phi: "Φ",
  Chi: "Χ", Psi: "Ψ", Omega: "Ω", alpha: "α",
  beta: "β", gamma: "γ", delta: "δ", epsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", iota: "ι",
  kappa: "κ", lambda: "λ", mu: "μ", nu: "ν",
  xi: "ξ", omicron: "ο", pi: "π", rho: "ρ",
  sigmaf: "ς", sigma: "σ", tau: "τ", upsilon: "υ",
  phi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  thetasym: "ϑ", upsih: "ϒ", piv: "ϖ",
};

const CHARREF_RE = /^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/;

const REPLACEMENT = "�";

/** Codepoint sanitation per §11.5: controls, surrogates, > 0x10FFFF -> U+FFFD. */
function codePointToChar(cp: number): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return REPLACEMENT;
  if (cp >= 0xd800 && cp <= 0xdfff) return REPLACEMENT;
  if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) return REPLACEMENT;
  if (cp === 0x7f) return REPLACEMENT;
  return String.fromCodePoint(cp);
}

export interface CharRef {
  /** Full source text of the reference, e.g. `&amp;`. */
  raw: string;
  /** Decoded character. */
  value: string;
}

/** Match a character reference at `pos` (which must be `&`), or null. */
export function matchCharRef(text: string, pos: number): CharRef | null {
  if (text.charCodeAt(pos) !== 38 /* & */) return null;
  const m = CHARREF_RE.exec(text.slice(pos, pos + 40));
  if (!m) return null;
  if (m[1] !== undefined) return { raw: m[0], value: codePointToChar(Number(m[1])) };
  if (m[2] !== undefined) return { raw: m[0], value: codePointToChar(parseInt(m[2], 16)) };
  const named = NAMED_ENTITIES[m[3] as string];
  if (named === undefined) return null;
  return { raw: m[0], value: named };
}

/** Decode every recognized character reference (§11.5). Unknown ones stay. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  let out = "";
  for (let i = 0; i < text.length; ) {
    if (text.charCodeAt(i) === 38) {
      const ref = matchCharRef(text, i);
      if (ref) {
        out += ref.value;
        i += ref.raw.length;
        continue;
      }
    }
    out += text[i];
    i += 1;
  }
  return out;
}

/**
 * Escape a text node for output (§11.5): `<` and `>` always; `&` only when it
 * does not already start a valid character reference (which is then kept
 * verbatim — a reference to a control char/surrogate becomes U+FFFD).
 */
export function escapeText(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const c = text[i] as string;
    if (c === "<") { out += "&lt;"; i += 1; continue; }
    if (c === ">") { out += "&gt;"; i += 1; continue; }
    if (c === "&") {
      const ref = matchCharRef(text, i);
      if (ref) {
        out += ref.value === REPLACEMENT ? REPLACEMENT : ref.raw;
        i += ref.raw.length;
        continue;
      }
      out += "&amp;";
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Escape every `&`, `<`, `>` unconditionally (nowiki/pre/code payloads). */
export function escapeAll(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape a value for a double-quoted attribute. */
export function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------------ */
/* Tag tokenizer                                                       */
/* ------------------------------------------------------------------ */

export interface TagToken {
  /** Lowercased tag name. */
  name: string;
  closing: boolean;
  selfClosing: boolean;
  /** Raw (still entity-encoded) attribute values, source order. */
  attrs: Attrs;
  /** Offset of `<`. */
  start: number;
  /** Offset just past `>`. */
  end: number;
}

const TAG_NAME_RE = /^[A-Za-z][A-Za-z0-9]*/;
const WS_RE = /\s/;

/**
 * Match a well-formed HTML tag at `pos` (`text[pos]` must be `<`). Returns
 * null when the `<` does not open a syntactically valid tag; the caller then
 * escapes it (§11: "anything not matching a well-formed tag is escaped").
 * The name is NOT allowlist-checked here.
 */
export function matchTagToken(text: string, pos: number): TagToken | null {
  if (text[pos] !== "<") return null;
  let i = pos + 1;
  let closing = false;
  if (text[i] === "/") { closing = true; i += 1; }
  const nameMatch = TAG_NAME_RE.exec(text.slice(i, i + 32));
  if (!nameMatch) return null;
  const name = nameMatch[0].toLowerCase();
  i += nameMatch[0].length;

  const attrs: Attrs = {};
  let selfClosing = false;
  for (;;) {
    while (i < text.length && WS_RE.test(text[i] as string)) i += 1;
    if (i >= text.length) return null;
    if (text[i] === ">") { i += 1; break; }
    if (text[i] === "/" && text[i + 1] === ">") { selfClosing = true; i += 2; break; }
    const anStart = i;
    while (i < text.length && !/[\s/>=]/.test(text[i] as string)) i += 1;
    if (i === anStart) return null; // stray character: not a well-formed tag
    const attrName = text.slice(anStart, i).toLowerCase();
    while (i < text.length && WS_RE.test(text[i] as string)) i += 1;
    let value = "";
    if (text[i] === "=") {
      i += 1;
      while (i < text.length && WS_RE.test(text[i] as string)) i += 1;
      const quote = text[i];
      if (quote === "\"" || quote === "'") {
        const close = text.indexOf(quote, i + 1);
        if (close < 0) return null;
        value = text.slice(i + 1, close);
        i = close + 1;
      } else {
        const vStart = i;
        while (i < text.length && !/[\s>]/.test(text[i] as string)) i += 1;
        value = text.slice(vStart, i);
      }
    }
    attrs[attrName] = value; // last occurrence wins, first position kept
  }
  return { name, closing, selfClosing, attrs, start: pos, end: i };
}

/**
 * Every sanctioned tag token in already-sanitized text, in order.
 * Helper for blocks.ts / inline.ts (stages 4 and 5 both need to see the tokens
 * this stage produced).
 */
export function tokenizeTags(text: string): TagToken[] {
  const out: TagToken[] = [];
  for (let i = text.indexOf("<"); i >= 0; i = text.indexOf("<", i + 1)) {
    const tok = matchTagToken(text, i);
    if (tok && isAllowedTag(tok.name)) {
      out.push(tok);
      i = tok.end - 1;
    }
  }
  return out;
}

/**
 * Fold over sanitized text, tracking how many `<p>`-rejecting raw elements are
 * open (Addendum A1 / D-14). blocks.ts calls this per line and suppresses
 * blank-line output while the returned depth is > 0.
 */
export function updatePRejectingDepth(text: string, depth: number): number {
  let d = depth;
  for (const tok of tokenizeTags(text)) {
    if (!P_REJECTING_TAGS.has(tok.name) || tok.selfClosing) continue;
    if (tok.closing) d = Math.max(0, d - 1);
    else d += 1;
  }
  return d;
}

/* ------------------------------------------------------------------ */
/* §11.4 style filtering                                               */
/* ------------------------------------------------------------------ */

export const INSECURE_STYLE = "/* insecure input */";

const STYLE_BAD_PATTERNS: readonly RegExp[] = [
  /expression/,
  /javascript\s*:/,
  /vbscript\s*:/,
  /url\s*\(/,
  /image\s*\(/,
  /image-set\s*\(/,
  /attr\s*\(/,
  /var\s*\(/,
  /-moz-binding/,
  /behavior\s*:/,
  /accelerator\s*:/,
  /filter\s*:[^;]*progid/,
  /@import/,
  /<\//,
];

/**
 * §11.4 "contains no null/control characters" — CSS whitespace excepted,
 * exactly as MediaWiki's `Sanitizer::checkCss` does: tab, LF, FF and CR are
 * legal between CSS tokens; the rest of C0 plus VT and DEL are not.
 *
 * This matters in practice: §8.7's auto-newline fires on a `{{#switch:}}`
 * whose winning branch begins with `#` (a colour literal), so a seed
 * infobox's `style="color:{{#switch:…|S=#b3261e|…}};"` legitimately carries
 * an LF and must not be rejected as insecure.
 */
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/;

/** Decode CSS backslash escapes: `\6A ` -> `j`, `\x` -> `x` (§11.4 step 2). */
function decodeCssEscapes(value: string): string {
  return value.replace(
    /\\([0-9a-fA-F]{1,6})[ \t\r\n\f]?|\\([\s\S])/g,
    (_m, hex: string | undefined, lit: string | undefined) =>
      hex !== undefined ? codePointToChar(parseInt(hex, 16)) : (lit ?? ""),
  );
}

/**
 * §11.4. Returns the original declaration when it passes every check, or
 * `INSECURE_STYLE` when it does not.
 */
export function filterStyle(rawValue: string): string {
  const decoded = decodeCssEscapes(decodeEntities(rawValue));
  if (CONTROL_CHARS_RE.test(decoded)) return INSECURE_STYLE;
  const opens = (decoded.match(/\/\*/g) ?? []).length;
  const closes = (decoded.match(/\*\//g) ?? []).length;
  if (opens !== closes) return INSECURE_STYLE;
  const stripped = decoded.replace(/\/\*[\s\S]*?\*\//g, "").toLowerCase();
  for (const bad of STYLE_BAD_PATTERNS) {
    if (bad.test(stripped)) return INSECURE_STYLE;
  }
  return rawValue;
}

/* ------------------------------------------------------------------ */
/* Attribute filtering                                                 */
/* ------------------------------------------------------------------ */

/** §2.4-style id normalization for raw-HTML `id` values. */
export function normalizeIdValue(value: string): string {
  const text = decodeEntities(value).trim().replace(/\s+/g, "_");
  return text === "" ? "_" : text;
}

/**
 * §11.3: drop everything not allowed for this element, filter `style`,
 * scheme-check URL attributes, restrict `dir` to ltr/rtl.
 */
export function filterAttributes(tag: string, attrs: Attrs): Attrs {
  const out: Attrs = {};
  for (const [rawName, rawValue] of Object.entries(attrs)) {
    const name = rawName.toLowerCase();
    if (!/^[a-z][a-z0-9_.:-]*$/.test(name)) continue;
    if (name.startsWith("on")) continue; // belt and braces: all event handlers
    if (!isAllowedAttrName(tag, name)) continue;
    let value = rawValue;
    if (name === "style") {
      value = filterStyle(value);
    } else if (name === "dir") {
      const d = decodeEntities(value).trim().toLowerCase();
      if (d !== "ltr" && d !== "rtl") continue;
      value = d;
    } else if (URL_ATTRS.has(name)) {
      if (!hasAllowedScheme(decodeEntities(value))) continue;
    } else if (name === "id") {
      value = normalizeIdValue(value);
    }
    out[name] = value;
  }
  return out;
}

/** Serialize filtered attributes in insertion order (deterministic, §14.11). */
export function serializeAttrs(attrs: Attrs): string {
  let out = "";
  for (const [name, value] of Object.entries(attrs)) {
    out += ` ${name}="${escapeAttr(value)}"`;
  }
  return out;
}

/** Canonical serialization of one sanctioned tag token. */
export function serializeTag(tok: TagToken): string {
  if (VOID_TAGS.has(tok.name)) {
    const attrs = tok.closing ? "" : serializeAttrs(filterAttributes(tok.name, tok.attrs));
    return `<${tok.name}${attrs} />`;
  }
  if (tok.closing) return `</${tok.name}>`;
  const attrs = serializeAttrs(filterAttributes(tok.name, tok.attrs));
  if (tok.selfClosing) return `<${tok.name}${attrs}></${tok.name}>`;
  return `<${tok.name}${attrs}>`;
}

/* ------------------------------------------------------------------ */
/* Stage 3 entry point                                                 */
/* ------------------------------------------------------------------ */

/**
 * Stage 3 (§14.4). Allowlisted tags become canonical tokens; every other `<`
 * is escaped in place. Strip markers pass through untouched.
 */
export function sanitizeRawHtml(expanded: string, ctx: ParseContext): string {
  void ctx; // nothing in the config influences the allowlist today
  let out = "";
  let i = 0;
  let last = 0;
  while ((i = expanded.indexOf("<", last)) >= 0) {
    out += expanded.slice(last, i);
    const tok = matchTagToken(expanded, i);
    if (tok && isAllowedTag(tok.name)) {
      out += serializeTag(tok);
      last = tok.end;
    } else {
      out += "&lt;";
      last = i + 1;
    }
  }
  out += expanded.slice(last);
  return out;
}

/* ------------------------------------------------------------------ */
/* §13.1 DISPLAYTITLE                                                  */
/* ------------------------------------------------------------------ */

const DISPLAYTITLE_TAGS: ReadonlySet<string> = new Set([
  "i", "b", "em", "strong", "s", "u", "sub", "sup", "span", "small",
]);

export interface DisplayTitleResult {
  /** Sanitized HTML for `meta.displayTitle`, or null when the restriction rejects it. */
  html: string | null;
  /** Set on rejection — record it in `meta.warnings` (§13.1). */
  warning?: string;
}

/** Plain-text content of a fragment of sanitized HTML. */
export function stripTags(html: string): string {
  let out = "";
  let last = 0;
  let i = 0;
  while ((i = html.indexOf("<", last)) >= 0) {
    out += html.slice(last, i);
    const tok = matchTagToken(html, i);
    if (tok) {
      last = tok.end;
    } else {
      out += "<";
      last = i + 1;
    }
  }
  out += html.slice(last);
  return out;
}

/**
 * §13.1: keep only text-preserving inline formatting, then enforce
 * `$wgRestrictDisplayTitle` — the text content, normalized per §5.7, must name
 * the page being rendered.
 */
export function sanitizeDisplayTitle(
  argument: string,
  page: Title,
  ctx: ParseContext,
): DisplayTitleResult {
  const namespaces = ctx.config.namespaces ?? DEFAULT_NAMESPACES;
  let html = "";
  let last = 0;
  let i = 0;
  while ((i = argument.indexOf("<", last)) >= 0) {
    html += escapeText(argument.slice(last, i));
    const tok = matchTagToken(argument, i);
    if (tok && DISPLAYTITLE_TAGS.has(tok.name)) {
      html += serializeTag(tok);
      last = tok.end;
    } else if (tok) {
      last = tok.end; // disallowed tag: stripped, its text content kept
    } else {
      html += "&lt;";
      last = i + 1;
    }
  }
  html += escapeText(argument.slice(last));

  const text = decodeEntities(stripTags(html));
  const parsed = parseTitle(text, namespaces);
  const ok =
    parsed !== null &&
    parsed.namespace === page.namespace &&
    normalizeTitle(parsed.pageName) === normalizeTitle(page.pageName);
  if (!ok) return { html: null, warning: `Invalid DISPLAYTITLE: ${text}` };
  return { html };
}
