/**
 * Cite: `<ref>` / `<references />` (spec §10.3, divergence D-13).
 *
 * Numbering happens at render (§14.3: "refs are NOT yet numbered — numbering
 * happens at render"), in document order, which is exactly the left-to-right
 * order in which render.ts restores strip markers. One `RefRegistry` lives per
 * page render.
 *
 * Key format (internal but stable, D-13):
 *   unnamed  sup `cite_ref-{g}{n}`              note `cite_note-{g}{n}`
 *   named    sup `cite_ref-{g}{name}-{n}-{u}`   note `cite_note-{g}{name}-{n}`
 * where `{g}` is `""` for the default group and `"{group}-"` otherwise, `{n}`
 * the rendered number and `{u}` the 0-based use index (for backlinks).
 *
 * Error strings come from `ctx.config.messages` (Addendum A3) wherever the
 * spec localizes them.
 */

import { escapeAttr, escapeText } from "./sanitize";
import { encodeFragment } from "./toc";
import type { ParseContext } from "./types";

/* ------------------------------------------------------------------ */
/* Ref names (§10.3)                                                   */
/* ------------------------------------------------------------------ */

const REF_NAME_RE = /^[\p{L}\p{N}\-_. :]+$/u;

/** Letters/digits/`-_. :`; a purely numeric name is an error (§10.3). */
export function isValidRefName(name: string): boolean {
  if (name === "") return false;
  if (!REF_NAME_RE.test(name)) return false;
  return !/^\d+$/.test(name.trim());
}

/** Backlink labels a, b, … z, aa, ab … (multi-use refs, §10.3). */
export function backlinkLabel(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

interface RefItem {
  group: string;
  name: string | null;
  /** Rendered HTML of the ref body; null until defined. */
  body: string | null;
  /** Rendered number within the group batch. */
  n: number;
  noteId: string;
  /** Sup ids of every in-text use, in order. */
  uses: string[];
}

interface GroupState {
  items: RefItem[];
  byName: Map<string, RefItem>;
  counter: number;
}

const UP_ARROW = "↑";

export class RefRegistry {
  private readonly groups = new Map<string, GroupState>();
  /** Total refs registered per group, across flushes — RenderResult.refs. */
  readonly counts: Record<string, number> = {};
  readonly warnings: string[] = [];

  constructor(private readonly ctx: ParseContext) {}

  private state(group: string): GroupState {
    let g = this.groups.get(group);
    if (!g) {
      g = { items: [], byName: new Map(), counter: 0 };
      this.groups.set(group, g);
    }
    return g;
  }

  private static idPrefix(group: string): string {
    if (group === "") return "";
    return `${group.replace(/\s+/g, "_")}-`;
  }

  /**
   * Register one in-text `<ref>` and return its inline marker HTML.
   * `bodyHtml === null` marks a pure reuse (`<ref name="x" />`).
   */
  use(group: string, name: string | null, bodyHtml: string | null): string {
    if (name !== null && !isValidRefName(name)) {
      const message = `Cite error: invalid ref name "${name}"`;
      this.warnings.push(message);
      return `<span class="error">${escapeText(message)}</span>`;
    }
    const g = this.state(group);
    const prefix = RefRegistry.idPrefix(group);
    let item: RefItem | undefined = name !== null ? g.byName.get(name) : undefined;

    if (item === undefined) {
      g.counter += 1;
      const n = g.counter;
      item = {
        group,
        name,
        body: bodyHtml,
        n,
        noteId: name === null ? `cite_note-${prefix}${n}` : `cite_note-${prefix}${name}-${n}`,
        uses: [],
      };
      g.items.push(item);
      if (name !== null) g.byName.set(name, item);
    } else if (bodyHtml !== null) {
      if (item.body === null) {
        item.body = bodyHtml;
      } else if (item.body !== bodyHtml) {
        this.warnings.push(`Cite: conflicting content for ref "${name ?? ""}"`);
      }
    }

    this.counts[group] = (this.counts[group] ?? 0) + 1;
    const useIndex = item.uses.length;
    const supId =
      item.name === null
        ? `cite_ref-${prefix}${item.n}`
        : `cite_ref-${prefix}${item.name}-${item.n}-${useIndex}`;
    item.uses.push(supId);

    const label = group === "" ? String(item.n) : `${group} ${item.n}`;
    return (
      `<sup id="${escapeAttr(supId)}" class="reference">` +
      `<a href="#${escapeAttr(encodeFragment(item.noteId))}">&#91;${escapeText(label)}&#93;</a></sup>`
    );
  }

  /**
   * Define (or redefine) a named ref without an in-text marker — the body form
   * `<references>…<ref name="x">text</ref>…</references>` (§10.3).
   */
  define(group: string, name: string, bodyHtml: string): void {
    if (!isValidRefName(name)) {
      this.warnings.push(`Cite error: invalid ref name "${name}"`);
      return;
    }
    const g = this.state(group);
    const existing = g.byName.get(name);
    if (existing) {
      existing.body = bodyHtml;
      return;
    }
    const prefix = RefRegistry.idPrefix(group);
    g.counter += 1;
    const item: RefItem = {
      group,
      name,
      body: bodyHtml,
      n: g.counter,
      noteId: `cite_note-${prefix}${name}-${g.counter}`,
      uses: [],
    };
    g.items.push(item);
    g.byName.set(name, item);
  }

  /** Groups that still hold unrendered refs (auto-append candidates). */
  pendingGroups(): string[] {
    const out: string[] = [];
    for (const [group, state] of this.groups) {
      if (state.items.length > 0) out.push(group);
    }
    return out;
  }

  /**
   * Render the accumulated list for `group` and clear it (§10.3); numbering
   * restarts for refs that follow.
   */
  flush(group: string): string {
    const g = this.groups.get(group);
    if (!g || g.items.length === 0) return `<ol class="references"></ol>`;
    let html = `<ol class="references">`;
    for (const item of g.items) {
      html += `<li id="${escapeAttr(item.noteId)}">`;
      if (item.uses.length === 0) {
        html += UP_ARROW;
      } else if (item.uses.length === 1) {
        html += `<a href="#${escapeAttr(encodeFragment(item.uses[0] as string))}">${UP_ARROW}</a>`;
      } else {
        html += UP_ARROW;
        item.uses.forEach((supId, i) => {
          html += ` <sup><a href="#${escapeAttr(encodeFragment(supId))}">${backlinkLabel(i)}</a></sup>`;
        });
      }
      html += " ";
      if (item.body === null) {
        const message = this.ctx.config.messages.citeErrorNoText(item.name ?? "");
        html += `<span class="error">${escapeText(message)}</span>`;
      } else {
        html += item.body;
      }
      html += "</li>";
    }
    html += `</ol>`;
    g.items = [];
    g.byName.clear();
    g.counter = 0;
    return html;
  }

  /**
   * §10.3: refs still pending at end of page get an automatic list per group,
   * preceded by a maintenance note. (The note is parser maintenance output,
   * not article prose — it stays EN, like the `#expr` errors of A3.)
   */
  autoAppend(): string {
    const pending = this.pendingGroups();
    if (pending.length === 0) return "";
    let html = "";
    for (const group of pending) {
      html += `<div class="mw-ref-warning">${escapeText(
        group === ""
          ? "Missing <references /> tag; the reference list is appended automatically."
          : `Missing <references group="${group}" /> tag; the reference list is appended automatically.`,
      )}</div>`;
      html += this.flush(group);
    }
    return html;
  }
}
