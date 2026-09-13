/**
 * Stage 4 — the list prefix machine (spec §4).
 *
 * Every line's prefix is its longest leading run of `*#;:`. Consecutive lines
 * share structure to the extent their prefixes share a common prefix, with
 * `;` and `:` treated as equal at the same position because they share one
 * `<dl>` (§4.1/§4.2).
 *
 * Item content is an INLINE region: block constructs cannot start inside a
 * list line (§4.4), so `*{|` keeps its literal `{|`.
 *
 * Owned by the block-parser agent together with blocks.ts / tables.ts.
 */

import type {
  BlockNode,
  DefData,
  DefTerm,
  DefinitionList,
  ListBlock,
  ListItem,
} from "./types";
import type { BlockEnv } from "./blocks";

export type ListChar = "*" | "#" | ";" | ":";

/** Strip-marker delimiter U+007F — markers are opaque atoms (spec §0.5). */
const STRIP_DELIM = String.fromCharCode(0x7f);

const LIST_LINE_RE = /^([*#;:]+)([\s\S]*)$/;

export function isListLine(line: string): boolean {
  return line.length > 0 && "*#;:".includes(line.charAt(0));
}

type AnyItem = ListItem | DefTerm | DefData;

interface Level {
  char: ListChar;
  container: ListBlock | DefinitionList;
  item: AnyItem;
}

/** `;` and `:` are the same position-wise: they share one `<dl>` (§4.2 step 1). */
function charEq(a: string, b: string): boolean {
  if (a === b) return true;
  const isDl = (c: string): boolean => c === ";" || c === ":";
  return isDl(a) && isDl(b);
}

function makeItem(char: ListChar): AnyItem {
  if (char === ";") return { type: "dt", children: [] };
  if (char === ":") return { type: "dd", children: [] };
  return { type: "li", children: [] };
}

function makeContainer(char: ListChar): ListBlock | DefinitionList {
  if (char === "*" || char === "#") {
    return { type: "list", ordered: char === "#", items: [] };
  }
  return { type: "dl", items: [] };
}

/**
 * Append an item to a level's container. The prefix machine guarantees the
 * char family matches the container kind (`*`/`#` → list, `;`/`:` → dl), so
 * the narrowing casts below are sound.
 */
function appendItem(level: Level, item: AnyItem): void {
  if (level.container.type === "list") {
    level.container.items.push(item as ListItem);
  } else {
    level.container.items.push(item as DefTerm | DefData);
  }
}

/* ------------------------------------------------------------------ */
/* §4.3 — same-line `; term : definition` split                        */
/* ------------------------------------------------------------------ */

/**
 * Index of the first top-level `:` — outside `[[…]]`, `[…]`, `<…>` and strip
 * markers (D-5: a colon inside any link construct never splits). Linear scan.
 * Returns -1 when there is none.
 */
export function findSplitColon(s: string): number {
  let i = 0;
  while (i < s.length) {
    const c = s.charAt(i);
    if (c === STRIP_DELIM) {
      // Strip marker: opaque atom, skip to its closing \x7f.
      const end = s.indexOf(STRIP_DELIM, i + 1);
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (c === "[" && s.charAt(i + 1) === "[") {
      const end = s.indexOf("]]", i + 2);
      i = end < 0 ? s.length : end + 2;
      continue;
    }
    if (c === "[") {
      const end = s.indexOf("]", i + 1);
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (c === "<") {
      const end = s.indexOf(">", i + 1);
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (c === ":") return i;
    i++;
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* The prefix machine                                                  */
/* ------------------------------------------------------------------ */

export interface ListRunResult {
  blocks: BlockNode[];
  /** Index of the first line after the consumed run. */
  next: number;
}

/**
 * Consume the maximal run of list lines starting at `lines[start]`. A run may
 * yield several roots (`* a` followed by `# b` shares no common prefix, so the
 * `<ul>` closes and an `<ol>` opens).
 */
export function parseListRun(lines: string[], start: number, env: BlockEnv): ListRunResult {
  const roots: BlockNode[] = [];
  const stack: Level[] = [];
  let i = start;

  while (i < lines.length) {
    const m = LIST_LINE_RE.exec(lines[i] ?? "");
    if (!m) break;
    const prefix = m[1]!;
    const content = m[2]!.trim();

    // 1. longest common prefix (`;`/`:` equal).
    let common = 0;
    while (
      common < prefix.length &&
      common < stack.length &&
      charEq(prefix.charAt(common), stack[common]!.char)
    ) {
      common++;
    }

    // 2. close everything deeper than the shared part.
    while (stack.length > common) stack.pop();

    // 3. same depth → close the current item, open a sibling (§4.2 step 3).
    //    Deeper → the new list nests inside the still-open item (exception).
    if (prefix.length === common && common > 0) {
      const level = stack[stack.length - 1]!;
      const char = prefix.charAt(common - 1) as ListChar;
      const item = makeItem(char);
      appendItem(level, item);
      level.item = item;
      level.char = char;
    }

    // 4. open the levels beyond the shared part.
    while (stack.length < prefix.length) {
      const char = prefix.charAt(stack.length) as ListChar;
      const container = makeContainer(char);
      const item = makeItem(char);
      if (container.type === "list") container.items.push(item as ListItem);
      else container.items.push(item as DefTerm | DefData);
      const parent = stack[stack.length - 1];
      if (parent) parent.item.children.push(container);
      else roots.push(container);
      stack.push({ char, container, item });
    }

    // 5. item content (§4.3 / §4.4).
    const level = stack[stack.length - 1]!;
    if (level.char === ";") {
      const colon = findSplitColon(content);
      if (colon >= 0) {
        const term = content.slice(0, colon).replace(/\s+$/, "");
        const def = content.slice(colon + 1).replace(/^\s+/, "");
        level.item.children.push(...env.inline(term));
        const dd: DefData = { type: "dd", children: env.inline(def) };
        appendItem(level, dd);
        level.item = dd;
        level.char = ":";
        i++;
        continue;
      }
    }
    if (content !== "") level.item.children.push(...env.inline(content));
    i++;
  }

  return { blocks: roots, next: i };
}
