"use client";

/**
 * The version-scope dialog: how an author says "this bit is different in v62"
 * without writing version markup by hand (docs/engine/visual-editor.md §5.3,
 * decisions-v2 O16.3, wikitext per versioning.md §2).
 *
 * This is the point of the whole version feature. versioning.md O10 promises
 * that a fact may hold from v50 and change at v62 on *one* page, and that a
 * page written for one patch stays writable for every other one. Until this
 * dialog that promise cost the author a syntax lesson, which is why pages went
 * stale one patch after they were written. High-quota players run every patch;
 * the markup has to be a form.
 *
 * **The form IS the grammar** (§2.1, amended 2026-09-03 by user). A version
 * construct is one tag whose NAME is the range it applies to, and the name has
 * exactly three shapes — so the form has exactly three modes, one picker for
 * the version (a second one for the far end of a range) and one body:
 *
 *     only     <v70>text</v70>            this version and no other
 *     window   <v70+v80>text</v70+v80>    v70 through v80, both ends included
 *     since    <v70+>text</v70+>          v70 and every later version
 *
 * What went with the retired grammar, rather than being kept as a control with
 * nothing behind it: the multi-select of versions and its chip row (a tag names
 * one range, not a list), the `*` fallback checkbox (prose with no tag around
 * it already belongs to every version, so the fallback is *not writing a tag*),
 * and the field-per-branch (one tag holds one passage — two passages are two
 * tags, which is what the page's own `+` menu adds).
 *
 * What this module owns, and what it deliberately does not:
 *
 * - The markup is produced by `buildVersionBlock` and read back by
 *   `parseVersionBlock`, and nowhere else. Both are pure and exported so
 *   versioning.md §2 can be asserted in a node test rather than through the
 *   DOM; everything else here is the form around them.
 * - `parseVersionBlock` is the way back in. A version block is an atomic node
 *   in the visual surface, so without an inverse the author who wanted to
 *   change what a block IS — its range, its mode — had to hand-write the
 *   markup this dialog exists to avoid.
 * - The combobox is `TokenPicker`, not a second one. Picking a version and
 *   inventing one are the same gesture (O16.1), and the picker already knows
 *   how to offer "create" only once a search has reported the id free.
 * - Registering a version is `POST /api/versions`, which any editor may call
 *   (O16.2): the id is validated, the ordinal derives from it, the row lands as
 *   `legacy`, and the call is idempotent — two authors racing on `v71` both
 *   simply end up with `v71`. Every refusal (a 400 on the id, a 409 on the
 *   ordinal, an outage) is a line under the picker, never a thrown dialog.
 *
 * Three decisions worth stating:
 *
 * - All state lives in `VersionDialogBody`, which `Dialog` mounts only while it
 *   is open. Reopening on a different block must not inherit the last one's
 *   range or body, and a mount is a cheaper reset than an effect writing state
 *   back into the render that just produced it.
 * - The picker is `disabled` until the registry has arrived. That is not
 *   cosmetic: `TokenPicker` re-runs its search when `disabled` flips, so the
 *   list fills itself the moment the registry lands — no second effect here
 *   pushing results into a control that owns them.
 * - The rendered preview is stored together with the source it answered, so an
 *   answer that no longer matches the form is visibly stale rather than quietly
 *   wrong, and no effect has to clear it. It renders at the tag's own starting
 *   version, and there is no version dropdown beside it any more: one tag emits
 *   one body for every version in its range, so there is nothing to choose
 *   between.
 *
 * `initialBody` *seeds* the body, because Fandom's gesture is "select the
 * sentence, then scope it" — the passage starts as the sentence the author
 * highlighted, and they edit it.
 *
 * Insert refuses a block that renders nothing, and says which nothing it is: a
 * blank body shows nothing at any version, and a window whose ends are inverted
 * (`<v80+v70>`) holds for no version at all — §2.1 renders it rather than
 * silently swapping the ends, so the form refuses it rather than silently
 * writing it.
 *
 * The preview posts to the public `POST /api/preview` (decisions-v2 O15.1) with
 * a placeholder title and the default locale. Version constructs resolve during
 * expansion and are locale-independent, so the only thing that can read
 * differently here than on the page is a `{{PAGENAME}}` or a locale-bound
 * template *inside* the body — a smaller price than threading the editor's page
 * context through a dialog whose subject is the registry.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FieldMessage } from "@/components/ui/field-message";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  TokenPicker,
  type TokenOption,
  type TokenPickerLabels,
} from "@/components/wiki/token-picker";
import { DEFAULT_LOCALE } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  deriveVersionOrdinal,
  readVersionTagName,
  versionTagName,
} from "@/lib/version-branches";

/** Long enough to survive a burst of typing in the body field. */
const PREVIEW_DEBOUNCE_MS = 400;

/**
 * `{{PAGENAME}}` inside a branch body has no real answer here — the dialog is
 * opened from an article whose title it is not given — and /api/preview demands
 * a non-empty one, so the fragment renders under a placeholder.
 */
const PREVIEW_TITLE = "Preview";

/** The route's own id shape (versioning.md §1: `v62`, `v64.1`). */
const VERSION_ID_RE = /^v(\d+)(?:\.(\d+))?$/i;

/* ------------------------------------------------------------------ */
/* Wikitext — the draft                                                */
/* ------------------------------------------------------------------ */

/**
 * A version construct as the dialog holds it: **one tag, one passage** (§2.1).
 *
 * The range lives in two fields rather than in a mode flag, because that is
 * what the tag name is — a lower bound, and how far it runs. The three shapes
 * of the grammar are the three shapes of this pair, and {@link versionBlockMode}
 * is the only place that correspondence is written down.
 */
export interface VersionBlockDraft {
  /** The version the passage starts at. */
  from: string;
  /**
   * The version it stops after: equal to `from` for a passage that applies to
   * exactly one version, `null` for one that runs to every later version.
   */
  to: string | null;
  body: string;
}

/** Which of §2.1's three forms a draft spells. */
export type VersionMode = "only" | "window" | "since";

/** Ids compare trimmed and case-insensitively, as version-edit.ts has them. */
function foldId(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * The form a draft is in — derived, never stored, so the mode buttons and the
 * markup cannot disagree about which one the author is looking at.
 *
 * A window on itself IS the single-version form (`<v70+v70>` and `<v70>` mean
 * the same thing, and only the second reads like what it means), which is why
 * this asks the ids rather than a flag beside them.
 */
export function versionBlockMode(draft: VersionBlockDraft): VersionMode {
  if (draft.to === null) return "since";
  return foldId(draft.to) === foldId(draft.from) ? "only" : "window";
}

/**
 * The draft, spelled as versioning.md §2.1 wikitext. Pure, exported for tests.
 *
 * `""` for a draft that names no range — no version picked, or a window whose
 * far end is still empty. An empty construct renders nothing and reads like
 * damage in the source, so the dialog disables its confirm for that case and
 * reaching it here means a caller asked for a block it did not want.
 */
export function buildVersionBlock(draft: VersionBlockDraft): string {
  if (draft.from.trim() === "") return "";
  if (draft.to !== null && draft.to.trim() === "") return "";
  // The name IS the range, and `versionTagName` is where that spelling lives —
  // shared with the highlighter and the block classifier so a tag this writes
  // is a tag every other surface recognises.
  const name = versionTagName({ from: draft.from, to: draft.to });
  return `<${name}>${draft.body}</${name}>`;
}

/**
 * True when the passage is empty — a block that renders nothing at any version,
 * and therefore reads identically at all of them.
 *
 * Whitespace counts as empty: `<v70></v70>` and `<v70>  </v70>` put nothing on
 * the page either way, and the promise being tested is about what the reader
 * sees.
 */
export function isEmptyVersionBlock(draft: VersionBlockDraft): boolean {
  return draft.body.trim() === "";
}

/**
 * True when a window's ends are the wrong way round (`<v80+v70>`).
 *
 * §2.1 renders such a tag for *nothing* rather than swapping the ends for the
 * author, because putting one version's text under another version's id is the
 * failure this whole feature exists to prevent. The engine's answer is to show
 * nothing; the form's answer is to refuse to write it, which is the same rule
 * one step earlier.
 *
 * Ordinals are derived from the ids alone, as everywhere else outside the
 * engine: an id the registry has never seen still sorts where registering it
 * would put it, and a pair this cannot order is not called inverted.
 */
export function isInvertedWindow(draft: VersionBlockDraft): boolean {
  if (draft.to === null) return false;
  const from = deriveVersionOrdinal(draft.from);
  const to = deriveVersionOrdinal(draft.to);
  if (from === null || to === null) return false;
  return to < from;
}

/* ------------------------------------------------------------------ */
/* Wikitext — the form that fills the draft                             */
/* ------------------------------------------------------------------ */

/**
 * The dialog's editable state, apart from the React that holds it.
 *
 * It is a separate shape from {@link VersionBlockDraft} because the form knows
 * one thing the markup does not: the far end of a range has to survive a trip
 * through the other two modes and back, so it is a string of its own rather
 * than a `to` that keeps being nulled and re-typed.
 */
export interface VersionFormState {
  mode: VersionMode;
  /** The version the passage starts at. */
  from: string;
  /** The far end, used only by `window` mode but never thrown away. */
  to: string;
  body: string;
}

/**
 * The form as it opens: on a block already on the page, or on a fresh pick.
 *
 * A new block starts in `since` mode at the version the editor is previewing,
 * because that is what an author reaches this dialog to say — *this changed at
 * the patch I am looking at* — and it means the form is one keystroke from
 * being insertable rather than one search.
 *
 * Reopening splits the tag back into the controls that wrote it, which is what
 * makes the dialog the way to change what a block IS: its range and its mode.
 */
export function versionFormState(
  draft: VersionBlockDraft | null,
  version: string,
  given: string,
): VersionFormState {
  if (draft === null) {
    return { mode: "since", from: version.trim(), to: "", body: given };
  }
  return {
    mode: versionBlockMode(draft),
    from: draft.from,
    // A window keeps its own far end; the other two forms have none to keep,
    // and switching to `window` then starts from the version it opened at.
    to: draft.to !== null && foldId(draft.to) !== foldId(draft.from) ? draft.to : "",
    body: draft.body,
  };
}

/**
 * The draft the form currently describes — what the preview, the wikitext echo
 * and Insert all read, so none of the three can show something the others do
 * not.
 */
export function composeVersionDraft(state: VersionFormState): VersionBlockDraft {
  const from = state.from.trim();
  if (state.mode === "since") return { from, to: null, body: state.body };
  if (state.mode === "only") return { from, to: from, body: state.body };
  return { from, to: state.to.trim(), body: state.body };
}

/* ------------------------------------------------------------------ */
/* Wikitext — reading one back                                         */
/* ------------------------------------------------------------------ */

/**
 * The inverse of {@link buildVersionBlock}, so a block already on the page can
 * be opened in this dialog instead of in the raw-wikitext one.
 *
 * Without it the feature is one-way: a version block is an atomic node in the
 * visual surface, so the author who wants to change the range they just wrote
 * has to hand-write the markup this dialog exists to avoid.
 *
 * The law it keeps: **`buildVersionBlock(parseVersionBlock(x)) === x` for every
 * block this dialog could have written.** Away from that canonical spelling it
 * still reads what real wikitext contains — an uppercase name, a closer whose
 * case differs from its opener, `<v70+v70>` for `<v70>` — and gives back the
 * canonical spelling of the *same* meaning, which is safe because tag names
 * compare case-insensitively (spec §10) and the engine reads both windows the
 * same way.
 *
 * What it refuses, returning null so the caller falls back to raw wikitext:
 *
 * - anything but exactly one construct filling the whole source. A construct
 *   with a neighbour is not one block, and the atomic node it came from would
 *   come back as something else;
 * - a name that is not a version tag, and a closing name that does not repeat
 *   the opening one — which does not close it at all (§10.7), so where the
 *   passage ends is a guess and this does not guess about prose;
 * - a self-closing tag, which would come back with a closer it never had;
 * - an attribute. The name carries the whole meaning (§2.1), so the engine
 *   parses attributes and ignores them — but rebuilding would *drop* them,
 *   and silently dropping the author's bytes is the loss this refuses.
 *
 * The body comes back **verbatim**, tables, template calls and nested links
 * included. That is why the scan below is the one version-edit.ts uses rather
 * than a regex stopping at the first `</v70+>`: comments and raw-text elements
 * are masked first, so a closer quoted inside a `<nowiki>` or a `<pre>` cannot
 * end the passage early.
 */
export function parseVersionBlock(source: string): VersionBlockDraft | null {
  try {
    return readBlock(source);
  } catch {
    // Markup this cannot read is markup the author edits as source, never a
    // half-read draft that would rewrite their page on OK.
    return null;
  }
}

/**
 * One HTML tag, tolerating quoted attribute values that contain `>`. Copied
 * from version-edit.ts (which copied it from parse.ts) rather than imported, so
 * this leaves that module's exports as they are; the lazy attribute group is
 * what keeps `<v70+/>` from reading as a plain opener.
 *
 * `.` and `+` are in the name class because a version tag's name carries its
 * range (§2.1) — without them `<v70+v80>` would scan as a `v70` element with
 * `+v80` for an attribute, and `</v70+v80>` would never be paired with it.
 */
const TAG_RE = /<(\/?)([A-Za-z][A-Za-z0-9.+]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/y;

/** Elements whose body is raw text (wikitext-spec §10.1, §10.2, §10.5). */
const RAW_TEXT_TAGS: ReadonlySet<string> = new Set(["nowiki", "pre", "syntaxhighlight", "source"]);

interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * The first `</name…>` after `from`, or -1. A raw-text element closes on a
 * literal search, never on depth counting (spec §10.1); the memo of where the
 * last closer sits keeps a buffer of unclosed openers from costing a full pass
 * each.
 */
function rawClose(text: string, from: number, name: string, memo: Map<string, number>): number {
  let last = memo.get(name);
  if (last === undefined) {
    const all = new RegExp(`</${name}\\s*>`, "gi");
    last = -1;
    for (let m = all.exec(text); m !== null; m = all.exec(text)) last = m.index;
    memo.set(name, last);
  }
  if (from > last) return -1;
  const re = new RegExp(`</${name}\\s*>`, "gi");
  re.lastIndex = from;
  const m = re.exec(text);
  return m === null ? -1 : m.index + m[0].length;
}

/**
 * The stretches of `text` that hold no markup: HTML comments and raw-text
 * elements, each taken whole, tags included. Both degenerate shapes run to the
 * end of the buffer, as the engine has them.
 */
function protectedSpans(text: string): Span[] {
  const spans: Span[] = [];
  const lastClose = new Map<string, number>();
  const lastGt = text.lastIndexOf(">");
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt === -1) break;
    if (text.startsWith("<!--", lt)) {
      const close = text.indexOf("-->", lt + 4);
      const end = close === -1 ? text.length : close + 3;
      spans.push({ start: lt, end });
      i = end;
      continue;
    }
    // Past the last `>` no tag can close, so the lazy attribute run would read
    // to the end of the buffer once per `<` — the difference between linear and
    // quadratic on a buffer of half-typed openers.
    if (lt > lastGt) break;
    TAG_RE.lastIndex = lt;
    const m = TAG_RE.exec(text);
    if (m === null) {
      i = lt + 1;
      continue;
    }
    const openEnd = lt + m[0].length;
    const name = m[2].toLowerCase();
    if (m[1] === "/" || !RAW_TEXT_TAGS.has(name)) {
      i = openEnd;
      continue;
    }
    if (m[4] === "/") {
      spans.push({ start: lt, end: openEnd });
      i = openEnd;
      continue;
    }
    const found = rawClose(text, openEnd, name, lastClose);
    const end = found === -1 ? text.length : found;
    spans.push({ start: lt, end });
    i = end;
  }
  return spans;
}

interface TagMatch {
  readonly start: number;
  readonly end: number;
  readonly attrs: string;
  /** Lowercased element name. */
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
}

/** Every tag outside the masked stretches, in source order. */
function scanTags(text: string, spans: readonly Span[]): TagMatch[] {
  const out: TagMatch[] = [];
  const lastGt = text.lastIndexOf(">");
  let i = 0;
  let cursor = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt === -1 || lt > lastGt) break;
    while (cursor < spans.length && spans[cursor].end <= lt) cursor += 1;
    if (cursor < spans.length && spans[cursor].start <= lt) {
      i = spans[cursor].end;
      continue;
    }
    TAG_RE.lastIndex = lt;
    const m = TAG_RE.exec(text);
    if (m === null) {
      i = lt + 1;
      continue;
    }
    out.push({
      start: lt,
      end: lt + m[0].length,
      attrs: m[3],
      name: m[2].toLowerCase(),
      closing: m[1] === "/",
      selfClosing: m[4] === "/",
    });
    i = lt + m[0].length;
  }
  return out;
}

/**
 * For every opening tag, the index of the tag that closes it, or null when it
 * never closes. One stack per element name, resolved in a single pass.
 */
function pairTags(tags: readonly TagMatch[]): (number | null)[] {
  const close: (number | null)[] = tags.map(() => null);
  const stacks = new Map<string, number[]>();
  for (let i = 0; i < tags.length; i += 1) {
    const tag = tags[i];
    if (tag.selfClosing) continue;
    let stack = stacks.get(tag.name);
    if (stack === undefined) {
      stack = [];
      stacks.set(tag.name, stack);
    }
    if (!tag.closing) {
      stack.push(i);
      continue;
    }
    const open = stack.pop();
    if (open !== undefined) close[open] = i;
  }
  return close;
}

/**
 * The whole source, or nothing: a construct with a neighbour is not a draft.
 *
 * Every refusal here is a rebuild that would change the author's bytes, and
 * they are listed on {@link parseVersionBlock} where a caller meets them.
 */
function readBlock(source: string): VersionBlockDraft | null {
  const tags = scanTags(source, protectedSpans(source));
  if (tags.length === 0) return null;
  const open = tags[0];
  // A self-closing tag would come back with a closer it never had, which is a
  // rewrite rather than a read.
  if (open.start !== 0 || open.closing || open.selfClosing) return null;
  const range = readVersionTagName(open.name);
  if (range === null) return null;
  // The name carries the whole meaning (§2.1), so the engine parses attributes
  // and ignores them — but a rebuild would drop them, and dropping the author's
  // bytes silently is the one thing this pair may never do.
  if (open.attrs.trim() !== "") return null;
  // `pairTags` matches on the folded name, so the closer may spell its case
  // however it likes — and one that does not repeat the name at all closes
  // nothing (§10.7), leaving `closeIdx` null.
  const closeIdx = pairTags(tags)[0];
  if (closeIdx === null || tags[closeIdx].end !== source.length) return null;
  return { from: range.from, to: range.to, body: source.slice(open.end, tags[closeIdx].start) };
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

/** The subset of a `versions` row this dialog reads (versioning.md §1). */
interface RegistryVersion {
  id: string;
  label: string;
  ordinal: number;
  /** `current` | `supported` | `legacy` — shown verbatim as a chip hint. */
  status: string;
}

/**
 * The API answers are narrowed rather than asserted: this component runs
 * against whatever the deployment's routes return, and a shape that has drifted
 * should cost the author a row, not a crashed dialog.
 */
function isRegistryVersion(value: unknown): value is RegistryVersion {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "label" in value &&
    typeof value.label === "string" &&
    "ordinal" in value &&
    typeof value.ordinal === "number" &&
    "status" in value &&
    typeof value.status === "string"
  );
}

/** `GET /api/versions` → the rows it understood, ordinal-ascending. */
function readRegistry(payload: unknown): RegistryVersion[] {
  if (typeof payload !== "object" || payload === null || !("versions" in payload)) return [];
  const list = payload.versions;
  if (!Array.isArray(list)) return [];
  const rows: RegistryVersion[] = [];
  for (const entry of list) if (isRegistryVersion(entry)) rows.push(entry);
  return rows.sort((a, b) => a.ordinal - b.ordinal);
}

/** `POST /api/versions` → the row, whether it was created (201) or found (200). */
function readCreated(payload: unknown): RegistryVersion | null {
  if (typeof payload !== "object" || payload === null || !("version" in payload)) return null;
  return isRegistryVersion(payload.version) ? payload.version : null;
}

/** The unified error body's code (src/lib/api-response.ts). */
function readErrorCode(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return null;
  const error = payload.error;
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

/** `POST /api/preview` → the rendered fragment. */
function readHtml(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || !("html" in payload)) return null;
  return typeof payload.html === "string" ? payload.html : null;
}

/* ------------------------------------------------------------------ */
/* Props                                                               */
/* ------------------------------------------------------------------ */

export interface VersionDialogLabels {
  title: string;
  /** Title when the dialog was reopened on a block already on the page. */
  titleEdit: string;
  intro: string;
  /** Label over the picker in the two one-version forms. */
  versionLabel: string;
  /** Labels over the two pickers of the range form. */
  fromLabel: string;
  toLabel: string;
  /** Stands in for an id while a picker has none. */
  pickPrompt: string;
  modeLabel: string;
  /** The three shapes of a tag name (§2.1), in the author's words. */
  modeOnly: string;
  modeWindow: string;
  modeSince: string;
  bodyLabel: string;
  bodyPlaceholder: string;
  previewLabel: string;
  insert: string;
  /** Confirm label when a block already on the page was reopened. */
  apply: string;
  /**
   * Why the confirm is refused: the passage is blank, so the block renders
   * nothing at any version and the page reads identically at all of them.
   */
  allEmpty: string;
  /** Why the confirm is refused: the range ends before it starts (§2.1). */
  inverted: string;
  close: string;
  failed: string;
  /** Shown when the typed id is not a valid version id. */
  invalidId: string;
  /**
   * The registry's `status` enum, translated. It reaches the author as a chip
   * hint beside every version, so the raw API token would be the one English
   * word in an otherwise translated dialog; an unknown status falls back to
   * the token itself rather than disappearing.
   */
  status: Record<string, string>;
  picker: TokenPickerLabels;
}

export interface VersionDialogProps {
  open: boolean;
  /**
   * A block already on the page, read back by {@link parseVersionBlock} — the
   * way in for an author who wants to change what the block IS. Null composes a
   * new block, which is the Insert case.
   */
  initialDraft?: VersionBlockDraft | null;
  /**
   * The version the editor is previewing, which seeds a new block's range: an
   * author reaches this dialog to say "this changed at the patch I am looking
   * at", and starting anywhere else makes them search for what is on screen.
   */
  initialVersion?: string;
  /** Text to seed the passage with — the author's current selection, usually. */
  initialBody?: string;
  onClose: () => void;
  onApply: (source: string) => void;
  getIdToken: () => Promise<string | null>;
  labels: VersionDialogLabels;
}

export function VersionDialog(props: VersionDialogProps): ReactElement {
  const editing = (props.initialDraft ?? null) !== null;
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={editing ? props.labels.titleEdit : props.labels.title}
      closeLabel={props.labels.close}
      // The form and its preview sit side by side on a laptop, and Dialog locks
      // body scroll — so the panel has to be able to scroll itself.
      className="max-h-[85vh] max-w-3xl overflow-y-auto"
    >
      <VersionDialogBody {...props} />
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Body                                                                */
/* ------------------------------------------------------------------ */

/** Which refusal to name under a picker; the wording is a label. */
type PickerProblem = "invalid" | "failed";

/** What registering an id ended in — the id it produced, or why it did not. */
type RegisterResult = { ok: true; id: string } | { ok: false; problem: PickerProblem };

/** A rendered preview, tagged with the source it answered. */
interface Rendered {
  source: string;
  html: string;
}

/**
 * One end of the range: a combobox over the registry, and the id it currently
 * holds.
 *
 * Its own component because the range form has two of them and they must not
 * share a search box, a create row or a refusal — an outage while registering
 * the far end has nothing to say about the near one. What they do share is the
 * registry itself and the one `POST /api/versions`, both of which stay in the
 * parent where the row that arrives can reach every field at once.
 */
function VersionPickField({
  fieldId,
  label,
  value,
  options,
  disabled,
  loadFailed,
  onPick,
  registerVersion,
  labels,
}: {
  fieldId: string;
  label: string;
  value: string;
  options: readonly TokenOption[];
  disabled: boolean;
  /** The registry never arrived: said here, under the picker it emptied. */
  loadFailed: boolean;
  onPick: (id: string) => void;
  registerVersion: (id: string) => Promise<RegisterResult>;
  labels: VersionDialogLabels;
}): ReactElement {
  const [query, setQuery] = useState("");
  const [problem, setProblem] = useState<PickerProblem | null>(null);
  const [creating, setCreating] = useState(false);

  // The registry is small enough that filtering it in memory beats a request
  // per keystroke — which is why TokenPicker takes a promise and not a URL.
  const search = useCallback(
    async (raw: string): Promise<TokenOption[]> => {
      const folded = raw.trim().toLowerCase();
      if (folded === "") return [...options];
      return options.filter((option) => option.id.toLowerCase().includes(folded));
    },
    [options],
  );

  const canCreate = useCallback((raw: string) => VERSION_ID_RE.test(raw.trim()), []);

  const pick = useCallback(
    (option: TokenOption, isNew: boolean) => {
      setQuery("");
      setProblem(null);
      if (!isNew) {
        onPick(option.id);
        return;
      }
      void (async () => {
        setCreating(true);
        const result = await registerVersion(option.id);
        setCreating(false);
        if (result.ok) onPick(result.id);
        else setProblem(result.problem);
      })();
    },
    [onPick, registerVersion],
  );

  const typed = query.trim();
  // Said before the picker's create row is even reached: an author who types
  // "62" or "patch 3" learns immediately why nothing is on offer.
  const typedInvalid =
    typed !== "" &&
    !VERSION_ID_RE.test(typed) &&
    !options.some((option) => option.id.toLowerCase().includes(typed.toLowerCase()));

  const message =
    problem === "invalid" || (problem === null && typedInvalid)
      ? labels.invalidId
      : problem === "failed" || loadFailed
        ? labels.failed
        : null;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={fieldId}>{label}</Label>
        {value === "" ? (
          <span className="text-[11px] text-faint">{labels.pickPrompt}</span>
        ) : (
          <span className="font-mono text-xs font-medium text-ink">{value}</span>
        )}
      </div>
      <TokenPicker
        id={fieldId}
        value={query}
        onValueChange={setQuery}
        search={search}
        onSelect={pick}
        canCreate={canCreate}
        // The id already chosen is marked rather than offered again: picking it
        // twice is the one gesture that would change nothing.
        selected={value === "" ? [] : [value]}
        disabled={disabled || creating}
        labels={labels.picker}
      />
      {message === null ? null : <FieldMessage tone="error">{message}</FieldMessage>}
    </div>
  );
}

function VersionDialogBody({
  initialDraft = null,
  initialVersion = "",
  initialBody,
  onClose,
  onApply,
  getIdToken,
  labels,
}: VersionDialogProps): ReactElement {
  const fieldId = useId();

  // Computed once, on the mount `Dialog` gives every opening: reopening on a
  // different block must not inherit the last one's range or passage.
  const [start] = useState<VersionFormState>(() =>
    versionFormState(initialDraft, initialVersion, initialBody ?? ""),
  );
  const editing = initialDraft !== null;

  const [registry, setRegistry] = useState<RegistryVersion[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [mode, setMode] = useState<VersionMode>(start.mode);
  const [from, setFrom] = useState(start.from);
  /** Kept while another mode is showing, so switching back does not re-ask. */
  const [to, setTo] = useState(start.to);
  const [body, setBody] = useState(start.body);
  const [rendered, setRendered] = useState<Rendered | null>(null);

  const previewAbort = useRef<AbortController | null>(null);

  /* ---------------- registry, loaded once per opening ---------------- */

  useEffect(() => {
    const controller = new AbortController();
    // Every setState below happens after an await, never synchronously in the
    // effect body — which is both the lint rule and the honest description:
    // nothing is known about the registry until the response is.
    void (async () => {
      try {
        // GET is anonymous: the registry is already public on every article.
        const res = await fetch("/api/versions", { signal: controller.signal, cache: "no-store" });
        if (!res.ok) {
          setLoadFailed(true);
          setRegistry([]);
          return;
        }
        setRegistry(readRegistry(await res.json()));
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        // An empty registry rather than a null one: the picker then enables, and
        // an author who knows the id can still register it and carry on.
        setLoadFailed(true);
        setRegistry([]);
      }
    })();
    return () => controller.abort();
  }, []);

  /* ---------------- the picker's options and its create row ---------------- */

  // Newest first: a version block is nearly always about a recent patch, and
  // the registry only grows at that end.
  const options = useMemo<TokenOption[]>(
    () =>
      [...(registry ?? [])]
        .sort((a, b) => b.ordinal - a.ordinal)
        // The id, not the label, because the id is what lands in the wikitext
        // and what the author has to recognise there later.
        .map((row) => ({
          id: row.id,
          label: row.id,
          hint: labels.status[row.status] ?? row.status,
        })),
    [registry, labels.status],
  );

  const registerVersion = useCallback(
    async (raw: string): Promise<RegisterResult> => {
      const id = raw.trim().toLowerCase();
      if (!VERSION_ID_RE.test(id)) return { ok: false, problem: "invalid" };
      try {
        // A null token means signed out: send no Authorization header at all
        // and let the server answer 401.
        const token = await getIdToken();
        const res = await fetch("/api/versions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          },
          body: JSON.stringify({ id }),
        });
        const payload: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          // 400 is the route refusing the id itself; 409 is an ordinal already
          // taken by another id, and anything else is an outage or a missing
          // grant. Only the first is about the author's spelling.
          const problem = readErrorCode(payload) === "validation-error" ? "invalid" : "failed";
          return { ok: false, problem };
        }
        const created = readCreated(payload);
        if (created !== null) {
          setRegistry((current) => [
            ...(current ?? []).filter((row) => row.id !== created.id),
            created,
          ]);
        }
        // 200 with `created: false` means another editor registered it a moment
        // ago; either way the id is real now and belongs in the range.
        return { ok: true, id: created?.id ?? id };
      } catch {
        return { ok: false, problem: "failed" };
      }
    },
    [getIdToken],
  );

  /* ---------------- preview ---------------- */

  // One draft, read by the preview, by the wikitext echo and by Insert — so
  // what the author is shown is what lands on the page.
  const draft = composeVersionDraft({ mode, from, to, body });
  const block = buildVersionBlock(draft);
  /** Where the passage starts, which is the one version worth rendering at. */
  const draftVersion = draft.from;

  useEffect(() => {
    if (block === "") return;
    const timer = setTimeout(() => {
      void (async () => {
        previewAbort.current?.abort();
        const controller = new AbortController();
        previewAbort.current = controller;
        try {
          const res = await fetch("/api/preview", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              wikitext: block,
              title: PREVIEW_TITLE,
              locale: DEFAULT_LOCALE,
              // The tag's own starting version: inside its range it emits the
              // same passage for every version, so this is the whole of what
              // there is to see, and outside it there is nothing.
              version: draftVersion,
            }),
            signal: controller.signal,
          });
          if (!res.ok) return;
          const html = readHtml(await res.json());
          if (html !== null) setRendered({ source: block, html });
        } catch {
          // A preview that does not arrive is not worth an error state: the
          // wikitext beside it is the authoritative thing this dialog produces.
        }
      })();
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [block, draftVersion]);

  useEffect(
    () => () => {
      previewAbort.current?.abort();
    },
    [],
  );

  const stale = rendered !== null && rendered.source !== block;

  /* ---------------- render ---------------- */

  /**
   * A passage nobody can read: blank at every version, or a window whose ends
   * are the wrong way round — which §2.1 renders for no version rather than
   * quietly swapping. Refused, and named — never silently inserted.
   */
  const allEmpty = isEmptyVersionBlock(draft);
  const inverted = isInvertedWindow(draft);
  const insertable = block !== "" && !allEmpty && !inverted;

  // Enter belongs to the body text, so the keyboard commit is the Ctrl/Cmd+Enter
  // the publish bar already answers to (visual-editor.md §6).
  const onBodyKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    if (insertable) onApply(block);
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] leading-relaxed text-mute">{labels.intro}</p>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
        <div className="flex min-w-0 flex-col gap-4">
          <div>
            <span id={`${fieldId}-mode`} className="mb-1.5 block text-[13px] font-medium text-ink">
              {labels.modeLabel}
            </span>
            <div role="group" aria-labelledby={`${fieldId}-mode`} className="flex flex-wrap gap-2">
              <ModeButton active={mode === "since"} onSelect={() => setMode("since")}>
                {labels.modeSince}
              </ModeButton>
              <ModeButton active={mode === "window"} onSelect={() => setMode("window")}>
                {labels.modeWindow}
              </ModeButton>
              <ModeButton active={mode === "only"} onSelect={() => setMode("only")}>
                {labels.modeOnly}
              </ModeButton>
            </div>
          </div>

          {/* One picker per end of the range the mode asks for. The registry is
              the same list for both, and it is loaded once above. */}
          <VersionPickField
            fieldId={`${fieldId}-from`}
            label={mode === "window" ? labels.fromLabel : labels.versionLabel}
            value={from}
            options={options}
            // Also the load gate: TokenPicker re-searches when this flips, so
            // the list fills itself as soon as the registry lands.
            disabled={registry === null}
            loadFailed={loadFailed}
            onPick={setFrom}
            registerVersion={registerVersion}
            labels={labels}
          />
          {mode === "window" ? (
            <VersionPickField
              fieldId={`${fieldId}-to`}
              label={labels.toLabel}
              value={to}
              options={options}
              disabled={registry === null}
              loadFailed={loadFailed}
              onPick={setTo}
              registerVersion={registerVersion}
              labels={labels}
            />
          ) : null}

          <div>
            <Label htmlFor={`${fieldId}-body`}>{labels.bodyLabel}</Label>
            <Textarea
              id={`${fieldId}-body`}
              rows={5}
              value={body}
              placeholder={labels.bodyPlaceholder}
              spellCheck={false}
              onChange={(event) => setBody(event.target.value)}
              onKeyDown={onBodyKeyDown}
              className="font-mono text-[13px] leading-5"
            />
          </div>
        </div>

        <section className="flex min-w-0 flex-col gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-mute">
            {labels.previewLabel}
          </h3>
          <div className="max-h-64 min-h-24 overflow-auto rounded-[var(--radius-md)] border border-hairline bg-canvas p-3">
            {rendered === null ? null : (
              <div
                className={cn("wiki-prose text-sm transition-opacity", stale && "opacity-50")}
                dangerouslySetInnerHTML={{ __html: rendered.html }}
              />
            )}
          </div>
          {/* The wikitext itself, because this dialog's output is source the
              author will meet again in the source editor. */}
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] border border-hairline bg-canvas-soft p-2 font-mono text-[11px] leading-4 text-mute">
            {block}
          </pre>
        </section>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-hairline pt-3">
        {inverted || (allEmpty && block !== "") ? (
          <FieldMessage tone="error" className="me-auto mt-0">
            {inverted ? labels.inverted : labels.allEmpty}
          </FieldMessage>
        ) : null}
        <Button variant="secondary" onClick={onClose}>
          {labels.close}
        </Button>
        <Button disabled={!insertable} onClick={() => onApply(block)}>
          {editing ? labels.apply : labels.insert}
        </Button>
      </div>
    </div>
  );
}

/**
 * The three shapes of a tag name, as toggles rather than radios: a radiogroup
 * owes the reader arrow-key navigation, and this is the same pressed-state
 * control the media dialog uses for its library tiles.
 */
function ModeButton({
  active,
  onSelect,
  children,
}: {
  active: boolean;
  onSelect: () => void;
  children: string;
}): ReactElement {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={cn(
        "focus-ring rounded-[var(--radius-sm)] border px-3 py-1.5 text-[13px] transition-colors",
        active
          ? "border-hairline-strong bg-canvas-soft-2 font-medium text-ink"
          : "border-hairline bg-surface text-mute hover:bg-canvas-soft hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
