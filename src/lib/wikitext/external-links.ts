/**
 * External links — spec §6. Stage 5 pass 4 (§14.6 step 4): bracketed links
 * first, then free (bare) URLs, both skipping the inside of anchor-producing
 * containers (internal links and other external links).
 *
 * The auto-number counter (§6.2) is page-scoped, not region-scoped: it lives
 * in a WeakMap keyed by the page's `PageMeta`, so numbering runs in document
 * order across every region of one parse and resets for the next page.
 */

import type { Piece } from "./inline";
import type { ExternalLink, PageMeta, ParseContext } from "./types";

/* ------------------------------------------------------------------ */
/* Protocols (§6.1)                                                    */
/* ------------------------------------------------------------------ */

/** Default allowlist. `//` (protocol-relative) is bracketed-only, like MW. */
export const URL_PROTOCOLS: readonly string[] = [
  "http://",
  "https://",
  "ftp://",
  "ftps://",
  "sftp://",
  "ssh://",
  "git://",
  "svn://",
  "irc://",
  "ircs://",
  "xmpp:",
  "telnet://",
  "nntp://",
  "mailto:",
  "news:",
  "tel:",
  "sms:",
  "urn:",
  "geo:",
  "magnet:",
  "bitcoin:",
];

const PROTOCOL_RELATIVE = "//";

/**
 * Length of the protocol at `text[i]`, or 0. `allowRelative` enables the
 * bracketed-only `//host` form.
 */
export function matchProtocol(text: string, i: number, allowRelative: boolean): number {
  if (allowRelative && text.startsWith(PROTOCOL_RELATIVE, i)) return PROTOCOL_RELATIVE.length;
  const lower = text.slice(i, i + 12).toLowerCase();
  for (const proto of URL_PROTOCOLS) {
    if (lower.startsWith(proto)) return proto.length;
  }
  return 0;
}

/** §6.3: everything except whitespace, `<`, `>`, `[`, `]`, `"` and U+007F. */
function isUrlChar(ch: string): boolean {
  if (ch === undefined) return false;
  const code = ch.charCodeAt(0);
  if (code <= 0x20 || code === 0x7f) return false;
  return ch !== "<" && ch !== ">" && ch !== "[" && ch !== "]" && ch !== '"';
}

/** End index (exclusive) of the URL run starting at `i`. */
function urlRunEnd(text: string, i: number): number {
  let j = i;
  while (j < text.length && isUrlChar(text[j])) j += 1;
  return j;
}

/**
 * §6.3 trailing-punctuation trimming — free URLs only. Strips runs of
 * `,;.:!?` and a final `)` when the parentheses in the URL are unbalanced.
 */
export function trimTrailingPunctuation(url: string): { url: string; trailing: string } {
  let end = url.length;
  for (;;) {
    let moved = false;
    while (end > 0 && ",;.:!?".includes(url[end - 1])) {
      end -= 1;
      moved = true;
    }
    if (end > 0 && url[end - 1] === ")") {
      const head = url.slice(0, end);
      let opens = 0;
      let closes = 0;
      for (const ch of head) {
        if (ch === "(") opens += 1;
        else if (ch === ")") closes += 1;
      }
      if (closes > opens) {
        end -= 1;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return { url: url.slice(0, end), trailing: url.slice(end) };
}

/* ------------------------------------------------------------------ */
/* Auto-numbering (§6.2)                                               */
/* ------------------------------------------------------------------ */

const counters = new WeakMap<PageMeta, { n: number }>();

/** Next `[n]` for a bare bracketed link; 1-based, document order, per page. */
export function nextExtLinkNumber(meta: PageMeta): number {
  let c = counters.get(meta);
  if (!c) {
    c = { n: 0 };
    counters.set(meta, c);
  }
  c.n += 1;
  return c.n;
}

/** Test helper: forget the counter for a `PageMeta`. */
export function resetExtLinkNumbers(meta: PageMeta): void {
  counters.delete(meta);
}

/* ------------------------------------------------------------------ */
/* The scan                                                            */
/* ------------------------------------------------------------------ */

interface Loc {
  pi: number;
  off: number;
}

/** First `]` at or after `from`, looking only inside text pieces. */
function findCloseBracket(src: Piece[], from: Loc): Loc | null {
  for (let pi = from.pi; pi < src.length; pi += 1) {
    const p = src[pi];
    if (p.k !== "text") continue;
    const start = pi === from.pi ? from.off : 0;
    const idx = p.v.indexOf("]", start);
    if (idx >= 0) return { pi, off: idx };
  }
  return null;
}

/** The pieces between two locations, with partial text pieces sliced. */
function collectRegion(src: Piece[], from: Loc, to: Loc): Piece[] {
  const out: Piece[] = [];
  const pushText = (v: string): void => {
    if (v !== "") out.push({ k: "text", v });
  };
  if (from.pi === to.pi) {
    const p = src[from.pi];
    if (p.k === "text") pushText(p.v.slice(from.off, to.off));
    return out;
  }
  const first = src[from.pi];
  if (first.k === "text") pushText(first.v.slice(from.off));
  else out.push(first);
  for (let pi = from.pi + 1; pi < to.pi; pi += 1) out.push(src[pi]);
  const last = src[to.pi];
  if (last.k === "text") pushText(last.v.slice(0, to.off));
  return out;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Stage 5 pass 4: bracketed and free external links (§6). Consumes and
 * produces the flat piece stream.
 */
export function scanExternalLinks(
  pieces: Piece[],
  ctx: ParseContext,
  meta: PageMeta,
): Piece[] {
  void ctx;
  const src = pieces;
  const out: Piece[] = [];
  let pending = "";
  let anchorDepth = 0;
  let i = 0;
  let pos = 0;

  const flush = (): void => {
    if (pending !== "") {
      out.push({ k: "text", v: pending });
      pending = "";
    }
  };

  while (i < src.length) {
    const p = src[i];
    if (p.k !== "text") {
      flush();
      if (p.k === "open" && p.anchor) anchorDepth += 1;
      if (p.k === "close" && p.tag === undefined) anchorDepth = Math.max(0, anchorDepth - 1);
      out.push(p);
      i += 1;
      pos = 0;
      continue;
    }
    if (anchorDepth > 0) {
      // Inside an <a>: no re-linkification (§6.3, §14.6 step 4).
      flush();
      out.push(pos === 0 ? p : { k: "text", v: p.v.slice(pos) });
      i += 1;
      pos = 0;
      continue;
    }

    const text = p.v;
    if (pos >= text.length) {
      i += 1;
      pos = 0;
      continue;
    }

    const ch = text[pos];

    // ---- bracketed: [url] / [url label] ------------------------------
    if (ch === "[") {
      const proto = matchProtocol(text, pos + 1, true);
      if (proto > 0) {
        const urlEnd = urlRunEnd(text, pos + 1);
        if (urlEnd > pos + 1 + proto) {
          const href = text.slice(pos + 1, urlEnd);
          const afterUrl: Loc = { pi: i, off: urlEnd };
          const close = findCloseBracket(src, afterUrl);
          if (close !== null) {
            // Label starts after the whitespace run following the URL.
            let labelStart = urlEnd;
            if (i === close.pi) {
              while (labelStart < close.off && /\s/.test(text[labelStart])) labelStart += 1;
            } else {
              while (labelStart < text.length && /\s/.test(text[labelStart])) labelStart += 1;
            }
            const label = collectRegion(src, { pi: i, off: labelStart }, close);
            const isBare =
              label.length === 0 ||
              (label.length === 1 && label[0].k === "text" && label[0].v.trim() === "");
            const node: ExternalLink = {
              type: "extlink",
              href,
              style: isBare ? "autonumber" : "text",
              children: [],
            };
            if (isBare) node.number = nextExtLinkNumber(meta);
            flush();
            out.push({ k: "open", n: node, anchor: true });
            if (!isBare) out.push(...label);
            out.push({ k: "close" });
            i = close.pi;
            pos = close.off + 1;
            continue;
          }
        }
      }
      // Not a link (bad scheme, no closing "]") ⇒ literal text (§6.2, C-37).
      pending += ch;
      pos += 1;
      continue;
    }

    // ---- free URL ----------------------------------------------------
    const freeProto = matchProtocol(text, pos, false);
    if (freeProto > 0) {
      const prev = pos > 0 ? text[pos - 1] : pending.slice(-1);
      const atBoundary = prev === "" || !WORD_CHAR.test(prev);
      const runEnd = urlRunEnd(text, pos);
      if (atBoundary && runEnd > pos + freeProto) {
        const raw = text.slice(pos, runEnd);
        const { url, trailing } = trimTrailingPunctuation(raw);
        if (url.length > freeProto) {
          flush();
          const node: ExternalLink = {
            type: "extlink",
            href: url,
            style: "free",
            children: [{ type: "text", value: url }],
          };
          out.push({ k: "atom", n: node });
          pending += trailing;
          pos = runEnd;
          continue;
        }
      }
    }

    pending += ch;
    pos += 1;
  }
  flush();
  return out;
}
