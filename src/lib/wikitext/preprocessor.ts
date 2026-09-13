/**
 * Stage 1 — preprocessor: raw wikitext → PPNode tree (spec §14.2).
 *
 * Normative sources:
 * - docs/engine/wikitext-spec.md §8.1 (brace matching), §8.3 (top-level
 *   pipe/equals splitting), §8.6 (noinclude/includeonly/onlyinclude),
 *   §10 (extension tags), §10.8 (comments + line-eating), §12 (redirects),
 *   §14.2 (this stage).
 * - docs/engine/versioning.md §2 (version tags — `<v70>`, `<v70+v80>`,
 *   `<v70+>` — are captured here like any other extension tag, except that
 *   their NAME is the range, so recognition is by shape; expand.ts resolves
 *   them).
 *
 * The scan is a single left-to-right pass (linear, no backtracking regexes on
 * the document body). Extension-tag capture beats brace matching; comments are
 * consumed during the scan, so brace runs stay contiguous (§14.2).
 */

import { DEFAULT_NAMESPACES, parseTitle } from "@/lib/title";

import type {
  NamespaceTable,
  PPExtTag,
  PPNode,
  ParseContext,
  Title,
} from "./types";
import { isVersionTag } from "./versions";

/* ------------------------------------------------------------------ */
/* Registered tags                                                     */
/* ------------------------------------------------------------------ */

/** Content is raw text: never expanded, escaped into a strip marker (§10.1/.2/.5). */
export const RAW_EXT_TAGS = ["nowiki", "pre", "syntaxhighlight", "source"] as const;

/** Content is wikitext: expanded in place before becoming a strip marker (§14.3). */
export const CONTENT_EXT_TAGS = ["ref", "references", "gallery"] as const;

/**
 * Fandom extension tags (spec "Fandom extensions" §F.2). Additive: registering
 * them here is what lifts `<tabber>`/`<poem>` out of the §10.7 unknown-tag rule
 * (escaped literally) and into the §14.3 wikitext-content path, so their bodies
 * are expanded before becoming a strip marker the renderer resolves.
 */
export const FANDOM_CONTENT_EXT_TAGS = ["tabber", "poem"] as const;

/**
 * Fandom tags whose body is STRUCTURED MARKUP, not wikitext (spec "Fandom
 * extensions" § "Portable infobox"). Registering `<infobox>` here is what keeps
 * §11 from escaping it and §10.7 from showing it literally; unlike
 * {@link FANDOM_CONTENT_EXT_TAGS} its body is NOT expanded wholesale, because
 * `<data source="cost">` binds to the frame's arguments and `<format>` must
 * only expand when that source has a value. portable-infobox.ts parses the body
 * and expands each piece itself, in stage 2's frame (§14.3).
 */
export const FANDOM_STRUCTURED_EXT_TAGS = ["infobox"] as const;

/** Every FIXED-NAME tag the preprocessor captures as an opaque node (§10). */
export const EXT_TAGS: readonly string[] = [
  ...RAW_EXT_TAGS,
  ...CONTENT_EXT_TAGS,
  ...FANDOM_CONTENT_EXT_TAGS,
  ...FANDOM_STRUCTURED_EXT_TAGS,
];

const EXT_TAG_SET = new Set<string>(EXT_TAGS);

/**
 * The one question the scanner asks about a tag name (§10 + versioning §2).
 * A version tag has no fixed name to look up — `<v70+v80>` names its own
 * range — so membership in the set cannot be the whole test, and asking here
 * keeps the two answers from drifting apart. Case folding belongs to this
 * function because §10 tag names are case-insensitive.
 */
export function isExtTagName(name: string): boolean {
  const lower = name.toLowerCase();
  return EXT_TAG_SET.has(lower) || isVersionTag(lower);
}

/** §8.6 include-context tags, filtered off the raw text before the scan. */
export const INCLUDE_TAGS = ["noinclude", "includeonly", "onlyinclude"] as const;

/* ------------------------------------------------------------------ */
/* §8.6 include filtering                                              */
/* ------------------------------------------------------------------ */

function tagBlockRe(tag: string): RegExp {
  // Opening tag … closing tag, or to end of input when unclosed.
  return new RegExp("<" + tag + "(?:\\s[^>]*)?>[\\s\\S]*?(?:</" + tag + "\\s*>|$)", "gi");
}

function tagMarkerRe(tag: string): RegExp {
  return new RegExp("</?" + tag + "(?:\\s[^>]*)?/?>", "gi");
}

function interiorRe(tag: string): RegExp {
  return new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)(?:</" + tag + "\\s*>|$)", "gi");
}

/** Drop the tag *and* its content. */
function dropTagBlocks(text: string, tag: string): string {
  return text.replace(tagBlockRe(tag), "");
}

/** Drop the tag markers, keep the content. */
function unwrapTag(text: string, tag: string): string {
  return text.replace(tagMarkerRe(tag), "");
}

/**
 * §8.6. `forInclusion` = "this text is being transcluded into another page".
 * Unclosed tags run to the end of the text.
 */
export function applyIncludeFilter(source: string, forInclusion: boolean): string {
  if (!forInclusion) {
    // Rendering the page itself.
    let out = dropTagBlocks(source, "includeonly");
    out = unwrapTag(out, "noinclude");
    return unwrapTag(out, "onlyinclude");
  }

  // Transcluding the page.
  if (/<onlyinclude(?:\s[^>]*)?>/i.test(source)) {
    const re = interiorRe("onlyinclude");
    let collected = "";
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) collected += m[1];
    let out = dropTagBlocks(collected, "noinclude");
    out = unwrapTag(out, "includeonly");
    return unwrapTag(out, "onlyinclude");
  }

  let out = dropTagBlocks(source, "noinclude");
  out = unwrapTag(out, "includeonly");
  return unwrapTag(out, "onlyinclude");
}

/* ------------------------------------------------------------------ */
/* Scanner internals                                                   */
/* ------------------------------------------------------------------ */

interface Part {
  nodes: PPNode[];
  /** Node index where a top-level `=` split the part (§8.3); null = positional. */
  eqAt: number | null;
}

interface Piece {
  /** Number of `{` characters in the opening run. */
  open: number;
  parts: Part[];
  /** `[[ … ]]` nesting depth — pipes/equals inside links are not top-level. */
  bracketDepth: number;
}

function newPart(): Part {
  return { nodes: [], eqAt: null };
}

const ATTR_RE = /([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]*)))?/g;

/** `key="value"` pairs of a raw tag-attribute string; bare attributes get `""`. */
export function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!raw) return attrs;
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw)) !== null) {
    if (m[0].trim() === "") continue;
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

/**
 * A tag name may carry `.` and `+` beyond the HTML character set, because a
 * version tag is named for its range: `<v64.1+v70>` (versioning §2). No HTML
 * element name contains either character, so widening the class only ever
 * admits names {@link isExtTagName} rejects unless they really are versions,
 * and a rejected name falls through to the literal-`<` path exactly as before.
 */
const TAG_OPEN_RE = /^<([A-Za-z][A-Za-z0-9.+]*)((?:\s[^>]*?)?)\s*(\/?)>/;

/* ------------------------------------------------------------------ */
/* preprocess                                                          */
/* ------------------------------------------------------------------ */

/**
 * Stage 1 (spec §14.2). `forInclusion` applies the §8.6 filtering to the raw
 * text before the tree is built.
 */
export function preprocess(
  source: string,
  ctx: ParseContext,
  forInclusion: boolean,
): PPNode[] {
  void ctx; // the tree is context-free; ctx is part of the stage contract
  return buildTree(applyIncludeFilter(source, forInclusion));
}

/** The scan itself, exported for callers that need no include filtering. */
export function buildTree(text: string): PPNode[] {
  const root: Part = newPart();
  const stack: Piece[] = [];
  let pending = "";
  let i = 0;

  const currentPart = (): Part => {
    if (stack.length === 0) return root;
    const piece = stack[stack.length - 1];
    return piece.parts[piece.parts.length - 1];
  };

  const appendNode = (part: Part, node: PPNode): void => {
    const last = part.nodes[part.nodes.length - 1];
    // Never merge across the `=` split point: it is a node-index boundary.
    const mergeable = part.eqAt === null || part.eqAt < part.nodes.length;
    if (node.kind === "text" && last && last.kind === "text" && mergeable) {
      last.value += node.value;
      return;
    }
    part.nodes.push(node);
  };

  const flush = (): void => {
    if (pending === "") return;
    appendNode(currentPart(), { kind: "text", value: pending });
    pending = "";
  };

  const appendComment = (value: string): void => {
    flush();
    appendNode(currentPart(), { kind: "comment", value });
  };

  const runLength = (ch: string, from: number): number => {
    let n = 0;
    while (from + n < text.length && text[from + n] === ch) n += 1;
    return n;
  };

  /** Re-serialize a part, re-inserting the `=` that the splitter consumed. */
  const partNodes = (part: Part): PPNode[] => {
    if (part.eqAt === null) return part.nodes;
    const eq: PPNode = { kind: "text", value: "=" };
    return [...part.nodes.slice(0, part.eqAt), eq, ...part.nodes.slice(part.eqAt)];
  };

  /** An unmatched piece degrades to literal text (§8.1 "leftover braces"). */
  const breakPiece = (piece: Piece): void => {
    const target = currentPart();
    appendNode(target, { kind: "text", value: "{".repeat(piece.open) });
    piece.parts.forEach((part, index) => {
      if (index > 0) appendNode(target, { kind: "text", value: "|" });
      for (const node of partNodes(part)) appendNode(target, node);
    });
  };

  const buildTemplate = (piece: Piece): PPNode => ({
    kind: "template",
    name: piece.parts[0].nodes,
    params: piece.parts.slice(1).map((part) =>
      part.eqAt === null
        ? { name: null, value: part.nodes }
        : { name: part.nodes.slice(0, part.eqAt), value: part.nodes.slice(part.eqAt) },
    ),
  });

  const buildParameter = (piece: Piece): PPNode => {
    const node: PPNode = { kind: "parameter", name: piece.parts[0].nodes };
    if (piece.parts.length > 1) {
      // §8.4: further pipes are part of the default (`{{{a|b|c}}}` → `b|c`).
      const def: PPNode[] = [];
      piece.parts.slice(1).forEach((part, index) => {
        if (index > 0) def.push({ kind: "text", value: "|" });
        def.push(...partNodes(part));
      });
      node.default = def;
    }
    return node;
  };

  while (i < text.length) {
    const ch = text[i];

    /* ---------- `<`: comments and extension tags ---------- */
    if (ch === "<") {
      if (text.startsWith("<!--", i)) {
        const end = text.indexOf("-->", i + 4);
        if (end < 0) {
          // Unclosed comment swallows the rest of the input (§10.8).
          appendComment(text.slice(i + 4));
          i = text.length;
          continue;
        }
        const value = text.slice(i + 4, end);
        let after = end + 3;
        // Line-eating rule (§10.8): a whitespace-only line vanishes entirely.
        let wsStart = i;
        while (wsStart > 0 && (text[wsStart - 1] === " " || text[wsStart - 1] === "\t")) {
          wsStart -= 1;
        }
        let wsEnd = after;
        while (wsEnd < text.length && (text[wsEnd] === " " || text[wsEnd] === "\t")) {
          wsEnd += 1;
        }
        if (wsStart > 0 && text[wsStart - 1] === "\n" && text[wsEnd] === "\n") {
          const trimBack = i - wsStart;
          if (trimBack > 0) pending = pending.slice(0, pending.length - trimBack);
          after = wsEnd + 1; // eat the trailing newline too
        }
        appendComment(value);
        i = after;
        continue;
      }

      const m = TAG_OPEN_RE.exec(text.slice(i));
      if (m && isExtTagName(m[1])) {
        const name = m[1].toLowerCase();
        flush();
        const attrs = parseAttributes(m[2]);
        const afterOpen = i + m[0].length;
        if (m[3] === "/") {
          const node: PPExtTag = { kind: "ext", name, attrs, inner: null };
          appendNode(currentPart(), node);
          i = afterOpen;
          continue;
        }
        const close = findClosingTag(text, name, afterOpen);
        const node: PPExtTag = {
          kind: "ext",
          name,
          attrs,
          inner: text.slice(afterOpen, close.contentEnd),
          // §10.7's swallow, recorded rather than only performed: the body ran
          // to the end of the input because no closer repeating this name was
          // found. Stage 2 warns about it for version tags, where the rule is
          // at its most destructive.
          ...(close.closed ? {} : { unclosed: true as const }),
        };
        appendNode(currentPart(), node);
        i = close.next;
        continue;
      }

      pending += "<";
      i += 1;
      continue;
    }

    /* ---------- brace runs (§8.1) ---------- */
    if (ch === "{") {
      const n = runLength("{", i);
      if (n >= 2) {
        flush();
        stack.push({ open: n, parts: [newPart()], bracketDepth: 0 });
      } else {
        pending += "{".repeat(n);
      }
      i += n;
      continue;
    }

    if (ch === "}") {
      const n = runLength("}", i);
      let remaining = n;
      while (remaining > 0) {
        if (stack.length === 0) {
          pending += "}".repeat(remaining);
          break;
        }
        const piece = stack[stack.length - 1];
        const capped = Math.min(remaining, piece.open);
        if (capped < 2) {
          pending += "}".repeat(remaining);
          break;
        }
        // §8.1 preference: 3+3 parameter beats 2+2 template.
        const use = capped >= 3 ? 3 : 2;
        flush();
        const node = use === 3 ? buildParameter(piece) : buildTemplate(piece);
        remaining -= use;
        piece.open -= use;
        if (piece.open > 0) {
          // Leftover open braces stay literal in front of the finished node.
          piece.parts = [newPart()];
          piece.bracketDepth = 0;
          appendNode(piece.parts[0], node);
        } else {
          stack.pop();
          appendNode(currentPart(), node);
        }
      }
      i += n;
      continue;
    }

    /* ---------- argument separators (§8.3, top level only) ---------- */
    if (ch === "|" && stack.length > 0 && stack[stack.length - 1].bracketDepth === 0) {
      flush();
      stack[stack.length - 1].parts.push(newPart());
      i += 1;
      continue;
    }

    if (ch === "=" && stack.length > 0) {
      const piece = stack[stack.length - 1];
      const part = piece.parts[piece.parts.length - 1];
      if (piece.bracketDepth === 0 && piece.parts.length > 1 && part.eqAt === null) {
        flush();
        part.eqAt = part.nodes.length;
        i += 1;
        continue;
      }
    }

    /* ---------- `[[ … ]]` shielding (§8.3) ---------- */
    if (ch === "[" || ch === "]") {
      const n = runLength(ch, i);
      if (stack.length > 0 && n >= 2) {
        const piece = stack[stack.length - 1];
        if (ch === "[") piece.bracketDepth += 1;
        else if (piece.bracketDepth > 0) piece.bracketDepth -= 1;
      }
      pending += ch.repeat(n);
      i += n;
      continue;
    }

    /* ---------- plain text run ---------- */
    let j = i;
    while (j < text.length && !isSpecial(text[j])) j += 1;
    if (j === i) j += 1;
    pending += text.slice(i, j);
    i = j;
  }

  flush();
  while (stack.length > 0) {
    const piece = stack.pop() as Piece;
    breakPiece(piece);
  }
  return root.nodes;
}

function isSpecial(ch: string): boolean {
  return (
    ch === "{" ||
    ch === "}" ||
    ch === "|" ||
    ch === "=" ||
    ch === "<" ||
    ch === "[" ||
    ch === "]"
  );
}

interface CloseMatch {
  /** End offset of the tag's content. */
  contentEnd: number;
  /** Offset to continue scanning from. */
  next: number;
  /** A closer repeating the name was found; false means §10.7's swallow. */
  closed: boolean;
}

/** RegExp-literal form of a tag name — a version tag's carries `.` and `+`. */
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Non-greedy `</name>` search; unclosed tags swallow to end of input (§10).
 * The closing name repeats the opening one exactly (case-insensitively), which
 * is why the name is escaped rather than spliced in raw: unescaped, a
 * `</v70+v80>` pattern would also close on `</v700v80>`.
 */
function findClosingTag(text: string, name: string, from: number): CloseMatch {
  const re = new RegExp("</" + escapeForRegExp(name) + "\\s*>", "gi");
  re.lastIndex = from;
  const m = re.exec(text);
  if (!m) return { contentEnd: text.length, next: text.length, closed: false };
  return { contentEnd: m.index, next: m.index + m[0].length, closed: true };
}

/* ------------------------------------------------------------------ */
/* Source reconstruction (unresolvable calls render literally, §8.2/7) */
/* ------------------------------------------------------------------ */

/** PPNode tree → the wikitext it came from (comments and tags included). */
export function stringifyNodes(nodes: readonly PPNode[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        out += node.value;
        break;
      case "comment":
        out += "<!--" + node.value + "-->";
        break;
      case "ext": {
        const attrs = Object.entries(node.attrs)
          .map(([k, v]) => (v === "" ? " " + k : " " + k + '="' + v + '"'))
          .join("");
        out +=
          node.inner === null
            ? "<" + node.name + attrs + " />"
            : "<" + node.name + attrs + ">" + node.inner + "</" + node.name + ">";
        break;
      }
      case "template": {
        out += "{{" + stringifyNodes(node.name);
        for (const param of node.params) {
          out += "|";
          if (param.name !== null) out += stringifyNodes(param.name) + "=";
          out += stringifyNodes(param.value);
        }
        out += "}}";
        break;
      }
      case "parameter": {
        out += "{{{" + stringifyNodes(node.name);
        if (node.default !== undefined) out += "|" + stringifyNodes(node.default);
        out += "}}}";
        break;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* §12 Redirects                                                       */
/* ------------------------------------------------------------------ */

export interface ParsedRedirect {
  /** Redirect target; the fragment (if any) travels in `target.fragment` (A2). */
  target: Title;
  /** Target exactly as written, for the §12.3 notice label. */
  targetText: string;
  /** Offset in `source` just past the redirect link (body renders below, §12.3). */
  bodyOffset: number;
}

const REDIRECT_RE = /^#redirect\s*:?[ \t]*/i;

/**
 * §12.1. A page is a redirect iff — after a BOM, leading whitespace and
 * leading HTML comments — it begins with `#REDIRECT` followed by an internal
 * link. Invalid target ⇒ not a redirect (the text renders normally).
 *
 * Used by the page store at save time and by stage 4 (blocks.ts).
 */
export function parseRedirect(
  source: string,
  namespaces: NamespaceTable = DEFAULT_NAMESPACES,
): ParsedRedirect | null {
  let i = 0;
  if (source.charCodeAt(0) === 0xfeff) i = 1;
  // Only whitespace and comments may precede the keyword.
  for (;;) {
    while (i < source.length && /\s/.test(source[i])) i += 1;
    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      if (end < 0) return null;
      i = end + 3;
      continue;
    }
    break;
  }

  const rest = source.slice(i);
  const keyword = REDIRECT_RE.exec(rest);
  if (!keyword) return null;

  const afterKeyword = rest.slice(keyword[0].length);
  if (!afterKeyword.startsWith("[[")) return null;
  const close = afterKeyword.indexOf("]]");
  if (close < 0) return null;

  const linkBody = afterKeyword.slice(2, close);
  // Label and trail are ignored (§12.1).
  const targetText = (linkBody.split("|")[0] ?? "").trim();
  if (targetText === "") return null;

  const parsed = parseTitle(targetText, namespaces);
  if (!parsed) return null;

  const target: Title = { namespace: parsed.namespace, pageName: parsed.pageName };
  if (parsed.fragment !== null && parsed.fragment !== "") target.fragment = parsed.fragment;

  return {
    target,
    targetText,
    bodyOffset: i + keyword[0].length + close + 2,
  };
}
