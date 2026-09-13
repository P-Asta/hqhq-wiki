/**
 * Stage 5 — inline parse (spec §14.6).
 *
 * `parseInline(text, ctx, meta)` turns one inline region (a paragraph line
 * run, heading content, list item, table cell, caption…) into `InlineNode[]`.
 * Passes, in the order §14.6 mandates:
 *
 *   1. internal links / files / categories (§5)  — links.ts
 *   2. sanctioned HTML tag tokens (§11)          — this file
 *   3. the apostrophe algorithm (§1), per line   — this file
 *   4. external links, bracketed then free (§6)  — external-links.ts
 *   5. remaining text: entities (§11.5), strip markers, `<br>` (§3.4)
 *
 * Passes 1–4 rewrite a flat `Piece` stream; pass 5 folds it into a tree.
 * Because the stream is flat, apostrophes inside a link label take part in
 * the same line's token stream (§1.4) while the emitted tree stays
 * well-nested (D-1): a format that opens outside a link and closes inside it
 * is split at the boundary.
 *
 * Strip markers stay inside text pieces for every pass — the marker syntax
 * contains none of the characters the scanners look for — and become
 * `StripMarker` nodes in pass 5. No stage between 1 and 6 looks inside them
 * (§14.8).
 */

import { scanExternalLinks } from "./external-links";
import { scanInternalLinks } from "./links";
import type {
  Bold,
  ExternalLink,
  HtmlInline,
  InlineNode,
  Italic,
  PageMeta,
  ParseContext,
  WikiLink,
} from "./types";

/* ------------------------------------------------------------------ */
/* The piece stream                                                    */
/* ------------------------------------------------------------------ */

/** A node that collects the pieces between its `open` and `close`. */
export type ContainerNode = WikiLink | ExternalLink | HtmlInline;

/**
 * One item of the flat stream the inline passes rewrite. `open`/`close` pair
 * up; `fmt` pieces are produced by the apostrophe pass; everything else is
 * either literal text (strip markers and entities included) or an already
 * finished node.
 */
export type Piece =
  | { k: "text"; v: string }
  | { k: "atom"; n: InlineNode }
  | { k: "open"; n: ContainerNode; tag?: string; anchor?: boolean }
  | { k: "close"; tag?: string }
  | { k: "fmt"; f: "b" | "i"; op: "open" | "close" };

/* ------------------------------------------------------------------ */
/* Pass 2 — HTML tag tokens (§11.1)                                    */
/* ------------------------------------------------------------------ */

const HTML_TAGS = new Set([
  // inline (§11.1)
  "b", "i", "em", "strong", "s", "strike", "u", "del", "ins", "sub", "sup",
  "small", "big", "code", "tt", "kbd", "samp", "var", "abbr", "cite", "dfn",
  "q", "mark", "bdi", "bdo", "span", "time", "data", "wbr", "br", "font",
  "ruby", "rb", "rt", "rp",
  // block (§11.1) — normally consumed by stage 4, tolerated here
  "div", "p", "blockquote", "center", "hr", "h1", "h2", "h3", "h4", "h5",
  "h6", "ul", "ol", "li", "dl", "dt", "dd", "table", "caption", "thead",
  "tbody", "tfoot", "tr", "td", "th", "figure", "figcaption", "details",
  "summary",
]);

const VOID_TAGS = new Set(["br", "hr", "wbr"]);

const TAG_RE = /<(\/?)([A-Za-z][A-Za-z0-9]*)((?:[^<>"']|"[^"]*"|'[^']*')*)(\/?)>/y;
const ATTR_RE =
  /([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw)) !== null) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    if (!(name in attrs)) attrs[name] = decodeEntities(value);
  }
  return attrs;
}

/** Pass 2: replace well-formed tags of allowed elements with tag pieces. */
export function tokenizeHtml(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const p of pieces) {
    if (p.k !== "text") {
      out.push(p);
      continue;
    }
    let buf = "";
    let i = 0;
    const flush = (): void => {
      if (buf !== "") {
        out.push({ k: "text", v: buf });
        buf = "";
      }
    };
    while (i < p.v.length) {
      if (p.v[i] !== "<") {
        buf += p.v[i];
        i += 1;
        continue;
      }
      TAG_RE.lastIndex = i;
      const m = TAG_RE.exec(p.v);
      if (!m) {
        buf += "<";
        i += 1;
        continue;
      }
      const tag = m[2].toLowerCase();
      if (!HTML_TAGS.has(tag)) {
        buf += "<";
        i += 1;
        continue;
      }
      const closing = m[1] === "/";
      i += m[0].length;
      flush();
      if (tag === "br") {
        // §3.4: every spelling of <br> (and a stray </br>) is one <br />.
        out.push({ k: "atom", n: { type: "br" } });
        continue;
      }
      if (VOID_TAGS.has(tag)) {
        if (!closing) {
          out.push({
            k: "atom",
            n: { type: "html-inline", tag, attrs: parseAttrs(m[3]), children: [] },
          });
        }
        continue;
      }
      if (closing) {
        out.push({ k: "close", tag });
        continue;
      }
      const node: HtmlInline = {
        type: "html-inline",
        tag,
        attrs: parseAttrs(m[3]),
        children: [],
      };
      if (m[4] === "/") {
        out.push({ k: "atom", n: node });
        continue;
      }
      out.push({ k: "open", n: node, tag });
    }
    flush();
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Pass 3 — apostrophes (§1)                                           */
/* ------------------------------------------------------------------ */

type QTok =
  | { t: "text"; v: string }
  | { t: "piece"; p: Piece }
  | { t: "tok"; kind: "I" | "B" | "BI" };

function appendQText(line: QTok[], v: string): void {
  const last = line[line.length - 1];
  if (last && last.t === "text") last.v += v;
  else line.push({ t: "text", v });
}

/** §1.1 tokenization: runs of 2+ apostrophes, with the 4/6+ literal split. */
function tokenizeApostrophes(line: QTok[], s: string): void {
  const re = /'{2,}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) appendQText(line, s.slice(last, m.index));
    const n = m[0].length;
    let kind: "I" | "B" | "BI";
    let literal = 0;
    if (n === 2) kind = "I";
    else if (n === 3) kind = "B";
    else if (n === 4) {
      literal = 1;
      kind = "B";
    } else if (n === 5) kind = "BI";
    else {
      literal = n - 5;
      kind = "BI";
    }
    if (literal > 0) appendQText(line, "'".repeat(literal));
    line.push({ t: "tok", kind });
    last = m.index + n;
  }
  if (last < s.length) appendQText(line, s.slice(last));
}

/** §1.2: with both counts odd, one `B` becomes a literal `'` plus an `I`. */
function rebalance(line: QTok[]): void {
  let numItalics = 0;
  let numBold = 0;
  for (const q of line) {
    if (q.t !== "tok") continue;
    if (q.kind === "I") numItalics += 1;
    else if (q.kind === "B") numBold += 1;
    else {
      numItalics += 1;
      numBold += 1;
    }
  }
  if (numBold % 2 === 0 || numItalics % 2 === 0) return;

  let firstSpace = -1;
  let firstMulti = -1;
  let firstSingle = -1;
  for (let i = 0; i < line.length; i += 1) {
    const q = line[i];
    if (q.t !== "tok" || q.kind !== "B") continue;
    const prev = line[i - 1];
    const text = prev && prev.t === "text" ? prev.v : "";
    const lastCh = text.slice(-1);
    const secondCh = text.length >= 2 ? text[text.length - 2] : "";
    if (lastCh === " ") {
      if (firstSpace < 0) firstSpace = i;
    } else if (secondCh === " ") {
      firstSingle = i;
      break; // the scan stops at the first single-letter word (§1.2)
    } else if (firstMulti < 0) {
      firstMulti = i;
    }
  }
  const pick = firstSingle >= 0 ? firstSingle : firstMulti >= 0 ? firstMulti : firstSpace;
  if (pick < 0) return; // both counts odd purely from BI tokens: do nothing

  line[pick] = { t: "tok", kind: "I" };
  const prev = line[pick - 1];
  if (prev && prev.t === "text") prev.v += "'";
  else line.splice(pick, 0, { t: "text", v: "'" });
}

type QState = "" | "i" | "b" | "ib" | "bi" | "both";

/** §1.3 state machine over one line's tokens. */
function runQuoteMachine(line: QTok[], out: Piece[]): void {
  let state: QState = "";
  let buffer: Piece[] = [];
  const sink = (): Piece[] => (state === "both" ? buffer : out);
  const open = (f: "b" | "i"): void => {
    out.push({ k: "fmt", f, op: "open" });
  };
  const close = (f: "b" | "i"): void => {
    out.push({ k: "fmt", f, op: "close" });
  };
  const flushBuffer = (): void => {
    out.push(...buffer);
    buffer = [];
  };

  for (const q of line) {
    if (q.t === "text") {
      sink().push({ k: "text", v: q.v });
      continue;
    }
    if (q.t === "piece") {
      sink().push(q.p);
      continue;
    }
    if (q.kind === "I") {
      switch (state) {
        case "":
          open("i");
          state = "i";
          break;
        case "i":
          close("i");
          state = "";
          break;
        case "b":
          open("i");
          state = "bi";
          break;
        case "bi":
          close("i");
          state = "b";
          break;
        case "ib":
          close("b");
          close("i");
          open("b");
          state = "b";
          break;
        case "both":
          state = "b";
          open("b");
          open("i");
          flushBuffer();
          close("i");
          break;
      }
      continue;
    }
    if (q.kind === "B") {
      switch (state) {
        case "":
          open("b");
          state = "b";
          break;
        case "b":
          close("b");
          state = "";
          break;
        case "i":
          open("b");
          state = "ib";
          break;
        case "bi":
          close("i");
          close("b");
          open("i");
          state = "i";
          break;
        case "ib":
          close("b");
          state = "i";
          break;
        case "both":
          state = "i";
          open("i");
          open("b");
          flushBuffer();
          close("b");
          break;
      }
      continue;
    }
    // BI
    switch (state) {
      case "":
        state = "both";
        buffer = [];
        break;
      case "b":
        close("b");
        open("i");
        state = "i";
        break;
      case "i":
        close("i");
        open("b");
        state = "b";
        break;
      case "bi":
        close("i");
        close("b");
        state = "";
        break;
      case "ib":
        close("b");
        close("i");
        state = "";
        break;
      case "both":
        state = "";
        open("i");
        open("b");
        flushBuffer();
        close("b");
        close("i");
        break;
    }
  }

  // End of line — close in the exact order of §1.3.
  if (state === "b" || state === "ib") close("b");
  if (state === "i" || state === "bi" || state === "ib") close("i");
  if (state === "bi") close("b");
  if (state === "both" && buffer.length > 0) {
    open("b");
    open("i");
    flushBuffer();
    close("i");
    close("b");
  }
}

/**
 * Pass 3: the apostrophe algorithm. Strictly line-scoped — unclosed
 * formatting is closed at every newline and never continues (§1, C-09).
 */
export function applyQuotes(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  let line: QTok[] = [];
  const endLine = (): void => {
    rebalance(line);
    runQuoteMachine(line, out);
    line = [];
  };
  for (const p of pieces) {
    if (p.k !== "text") {
      line.push({ t: "piece", p });
      continue;
    }
    const parts = p.v.split("\n");
    for (let i = 0; i < parts.length; i += 1) {
      if (i > 0) {
        endLine();
        out.push({ k: "text", v: "\n" });
      }
      if (parts[i] !== "") tokenizeApostrophes(line, parts[i]);
    }
  }
  endLine();
  return out;
}

/* ------------------------------------------------------------------ */
/* Pass 5 — text, entities, strip markers, and the tree                */
/* ------------------------------------------------------------------ */

const STRIP_MARKER_RE = /\x7f'"UNIQ--[A-Za-z0-9_]+-[0-9a-f]{8}-QINU"'\x7f/y;
const NUMERIC_ENTITY_RE = /&#(?:[0-9]{1,7}|[xX][0-9a-fA-F]{1,6});/y;
const NAMED_ENTITY_RE = /&([A-Za-z][A-Za-z0-9]{1,31});/y;

/**
 * Named character references recognized in text and attribute values (§11.5).
 * The subset covers everything wikitext authors realistically type; unknown
 * `&word;` stays literal text and is escaped on output, exactly as §11.5
 * requires.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  copy: "©", reg: "®", trade: "™", deg: "°",
  plusmn: "±", times: "×", divide: "÷", frac12: "½",
  frac14: "¼", frac34: "¾", sup2: "²", sup3: "³",
  micro: "µ", para: "¶", sect: "§", middot: "·",
  bull: "•", hellip: "…", prime: "′", Prime: "″",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", laquo: "«", raquo: "»",
  dagger: "†", Dagger: "‡", permil: "‰", euro: "€",
  pound: "£", yen: "¥", cent: "¢", curren: "¤",
  larr: "←", uarr: "↑", rarr: "→", darr: "↓",
  harr: "↔", crarr: "↵", lArr: "⇐", rArr: "⇒",
  hArr: "⇔", forall: "∀", exist: "∃", empty: "∅",
  nabla: "∇", isin: "∈", notin: "∉", prod: "∏",
  sum: "∑", minus: "−", lowast: "∗", radic: "√",
  infin: "∞", ang: "∠", and: "∧", or: "∨",
  cap: "∩", cup: "∪", int: "∫", there4: "∴",
  sim: "∼", cong: "≅", asymp: "≈", ne: "≠",
  equiv: "≡", le: "≤", ge: "≥", sub: "⊂",
  sup: "⊃", nsub: "⊄", sube: "⊆", supe: "⊇",
  oplus: "⊕", otimes: "⊗", perp: "⊥", sdot: "⋅",
  loz: "◊", spades: "♠", clubs: "♣", hearts: "♥",
  diams: "♦", alpha: "α", beta: "β", gamma: "γ",
  delta: "δ", epsilon: "ε", zeta: "ζ", eta: "η",
  theta: "θ", iota: "ι", kappa: "κ", lambda: "λ",
  mu: "μ", nu: "ν", xi: "ξ", omicron: "ο",
  pi: "π", rho: "ρ", sigma: "σ", tau: "τ",
  upsilon: "υ", phi: "φ", chi: "χ", psi: "ψ",
  omega: "ω", Alpha: "Α", Beta: "Β", Gamma: "Γ",
  Delta: "Δ", Theta: "Θ", Lambda: "Λ", Pi: "Π",
  Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó",
  uacute: "ú", agrave: "à", egrave: "è", ccedil: "ç",
  ntilde: "ñ", ouml: "ö", auml: "ä", uuml: "ü",
  szlig: "ß", oslash: "ø", aring: "å", aelig: "æ",
  ensp: " ", emsp: " ", thinsp: " ", zwnj: "‌",
  zwj: "‍", lrm: "‎", rlm: "‏", shy: "­",
  iexcl: "¡", iquest: "¿", brvbar: "¦", uml: "¨",
  ordf: "ª", ordm: "º", not: "¬", macr: "¯",
  acute: "´", cedil: "¸", laquo2: "«",
};

/** True for a character reference this engine recognizes (§11.5). */
export function isKnownEntity(ref: string): boolean {
  NUMERIC_ENTITY_RE.lastIndex = 0;
  if (NUMERIC_ENTITY_RE.test(ref)) return true;
  NAMED_ENTITY_RE.lastIndex = 0;
  const named = NAMED_ENTITY_RE.exec(ref);
  return named !== null && named[1] in NAMED_ENTITIES;
}

/** Decode the character references of §11.5 (used for attribute values). */
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(
    /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g,
    (whole, body: string) => {
      if (body[0] === "#") {
        const code =
          body[1] === "x" || body[1] === "X"
            ? parseInt(body.slice(2), 16)
            : parseInt(body.slice(1), 10);
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return "�";
        if (code >= 0xd800 && code <= 0xdfff) return "�";
        if (code < 0x20 && code !== 0x09 && code !== 0x0a) return "�";
        return String.fromCodePoint(code);
      }
      const named = NAMED_ENTITIES[body];
      return named ?? whole;
    },
  );
}

/** Split literal text into Text / Entity / StripMarker nodes. */
export function splitText(v: string, out: InlineNode[]): void {
  let buf = "";
  let i = 0;
  const flush = (): void => {
    if (buf !== "") {
      out.push({ type: "text", value: buf });
      buf = "";
    }
  };
  while (i < v.length) {
    const ch = v[i];
    if (ch === "\x7f") {
      STRIP_MARKER_RE.lastIndex = i;
      const m = STRIP_MARKER_RE.exec(v);
      if (m) {
        flush();
        out.push({ type: "strip", marker: m[0] });
        i += m[0].length;
        continue;
      }
      i += 1; // stray U+007F is dropped (stage 0 removes them anyway)
      continue;
    }
    if (ch === "&") {
      NUMERIC_ENTITY_RE.lastIndex = i;
      const num = NUMERIC_ENTITY_RE.exec(v);
      if (num) {
        flush();
        out.push({ type: "entity", value: num[0] });
        i += num[0].length;
        continue;
      }
      NAMED_ENTITY_RE.lastIndex = i;
      const named = NAMED_ENTITY_RE.exec(v);
      if (named && named[1] in NAMED_ENTITIES) {
        flush();
        out.push({ type: "entity", value: named[0] });
        i += named[0].length;
        continue;
      }
    }
    buf += ch;
    i += 1;
  }
  flush();
}

interface Frame {
  kind: "fmt" | "html" | "anchor";
  f?: "b" | "i";
  tag?: string;
  node: { children: InlineNode[] };
}

function makeFmt(f: "b" | "i", children: InlineNode[]): Bold | Italic {
  return f === "b" ? { type: "b", children } : { type: "i", children };
}

/**
 * Pass 5: fold the flat stream into a well-nested tree (D-1, §11.2).
 * Formats that cross a container boundary are split at it; close tags with no
 * open are dropped; everything still open at the end of the region is closed.
 */
export function buildTree(pieces: Piece[]): InlineNode[] {
  const root: InlineNode[] = [];
  const stack: Frame[] = [];
  const kids = (): InlineNode[] =>
    stack.length > 0 ? stack[stack.length - 1].node.children : root;

  const pushFrame = (frame: Frame): void => {
    kids().push(frame.node as InlineNode);
    stack.push(frame);
  };

  const closeFmt = (f: "b" | "i"): void => {
    let idx = -1;
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (stack[i].kind === "fmt" && stack[i].f === f) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return;
    if (idx === stack.length - 1) {
      stack.pop();
      return;
    }
    // The format opened outside a container and closes inside it: end it at
    // the boundary and re-open it inside every container still open (D-1).
    const outer = stack[idx].node;
    const parentKids = idx === 0 ? root : stack[idx - 1].node.children;
    const first = stack[idx + 1].node as unknown as InlineNode;
    if (outer.children[outer.children.length - 1] === first) outer.children.pop();
    stack.splice(idx, 1);
    parentKids.push(first);
    for (let j = idx; j < stack.length; j += 1) {
      const container = stack[j].node;
      const next = j + 1 < stack.length ? (stack[j + 1].node as unknown as InlineNode) : null;
      const arr = container.children;
      let tail: InlineNode | undefined;
      if (next !== null && arr[arr.length - 1] === next) tail = arr.pop();
      if (arr.length > 0) {
        const inner = arr.splice(0, arr.length);
        arr.push(makeFmt(f, inner));
      }
      if (tail !== undefined) arr.push(tail);
    }
  };

  const closeContainer = (kind: "html" | "anchor", tag?: string): void => {
    let idx = -1;
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const e = stack[i];
      if (e.kind === "anchor") {
        if (kind === "anchor") idx = i;
        break; // never cross an <a> boundary
      }
      if (kind === "html" && e.kind === "html" && e.tag === tag) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return; // stray close tag: dropped (§11.2)
    const reopen: ("b" | "i")[] = [];
    for (let i = stack.length - 1; i > idx; i -= 1) {
      const e = stack[i];
      if (e.kind === "fmt" && e.f) reopen.unshift(e.f);
      stack.pop();
    }
    stack.pop();
    for (const f of reopen) pushFrame({ kind: "fmt", f, node: makeFmt(f, []) });
  };

  for (const p of pieces) {
    switch (p.k) {
      case "text":
        splitText(p.v, kids());
        break;
      case "atom":
        kids().push(p.n);
        break;
      case "fmt":
        if (p.op === "open") pushFrame({ kind: "fmt", f: p.f, node: makeFmt(p.f, []) });
        else closeFmt(p.f);
        break;
      case "open":
        pushFrame({
          kind: p.anchor ? "anchor" : "html",
          tag: p.tag,
          // `HtmlInline.children` is widened to accept BLOCK nodes so stage 4
          // can nest a wrapper `<div>`'s content inside it (§3.1 rule 4).
          // Stage 5 never puts one there — every piece it collects is inline —
          // so the frame keeps the narrow type its rebalancing passes need.
          node: p.n as { children: InlineNode[] },
        });
        break;
      case "close":
        closeContainer(p.tag === undefined ? "anchor" : "html", p.tag);
        break;
    }
  }
  return root;
}

/* ------------------------------------------------------------------ */
/* Stage entry point                                                   */
/* ------------------------------------------------------------------ */

/**
 * Stage 5 (§14.6) — parse one inline region. `meta` collects `linksTo`
 * (red links included, Addendum A4), `categories` and `warnings`.
 */
export function parseInline(
  text: string,
  ctx: ParseContext,
  meta: PageMeta,
): InlineNode[] {
  const linked = scanInternalLinks(text, {
    ctx,
    meta,
    parseCaption: (caption) => parseInline(caption, ctx, meta),
  });
  const tagged = tokenizeHtml(linked);
  const quoted = applyQuotes(tagged);
  const external = scanExternalLinks(quoted, ctx, meta);
  return buildTree(external);
}
