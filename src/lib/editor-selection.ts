/**
 * Textarea selection surgery for the source editor's toolbar.
 *
 * Every toolbar button is a pure transform of `{ value, start, end }` into a
 * new `{ value, start, end }`; the React island then writes the value into
 * state and restores the caret. Keeping the surgery pure (no DOM, no refs)
 * makes the boundary cases — empty selection, selection that already carries
 * the markers, multi-line selections, end-of-buffer — unit-testable in the
 * node environment (see editor-selection.test.ts).
 *
 * Wikitext constructs referenced here are specified in
 * docs/engine/wikitext-spec.md: §1.1 emphasis, §2 headings, §4 lists,
 * §5 internal links, §6.2 external links.
 */

/** A textarea's editable state: its text plus the current selection range. */
export interface SelectionState {
  value: string;
  /** Selection anchor (`selectionStart`). */
  start: number;
  /** Selection focus (`selectionEnd`); equals `start` for a bare caret. */
  end: number;
}

/** How a toolbar button wraps (or unwraps) the selection. */
export interface WrapSpec {
  /** Text inserted before the selection, e.g. `"'''"`. */
  before: string;
  /** Text inserted after it; defaults to `before` reversed only when given. */
  after?: string;
  /** Inserted (and left selected) when nothing is selected. */
  placeholder?: string;
  /** Push the snippet onto its own line, and end the line after it. */
  block?: boolean;
  /** When the selection is already wrapped, remove the markers instead. */
  toggle?: boolean;
}

/** Clamp a range to the buffer and put it in ascending order. */
function normalize(state: SelectionState): SelectionState {
  const max = state.value.length;
  const a = Math.max(0, Math.min(max, state.start));
  const b = Math.max(0, Math.min(max, state.end));
  return { value: state.value, start: Math.min(a, b), end: Math.max(a, b) };
}

/** Offset of the first character of the line containing `at`. */
export function lineStartAt(value: string, at: number): number {
  return value.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
}

/** Offset of the newline ending the line containing `at` (or the buffer end). */
export function lineEndAt(value: string, at: number): number {
  const nl = value.indexOf("\n", at);
  return nl === -1 ? value.length : nl;
}

/**
 * Wrap the selection in `before`/`after` — the Bold/Italic/Underline/Link/
 * Reference family.
 *
 * - Nothing selected: the placeholder is inserted and left selected, so the
 *   next keystroke replaces it (Fandom's behaviour).
 * - `toggle` and the selection is exactly the wrapped text (or includes the
 *   markers): the markers are removed and the inner text stays selected.
 * - `block`: a newline is added before the snippet unless the caret already
 *   sits at the start of a line, and after it unless a newline follows.
 */
export function wrapSelection(state: SelectionState, spec: WrapSpec): SelectionState {
  const { value, start, end } = normalize(state);
  const after = spec.after ?? "";
  const before = spec.before;

  if (spec.toggle === true && before !== "") {
    const inner = unwrapAt(value, start, end, before, after);
    if (inner !== null) return inner;
  }

  const selected = value.slice(start, end);
  const body = selected !== "" ? selected : (spec.placeholder ?? "");

  let lead = "";
  let tail = "";
  if (spec.block === true) {
    if (start > 0 && value[start - 1] !== "\n") lead = "\n";
    if (end < value.length && value[end] !== "\n") tail = "\n";
  }

  const insert = lead + before + body + after + tail;
  const bodyAt = start + lead.length + before.length;
  return {
    value: value.slice(0, start) + insert + value.slice(end),
    start: bodyAt,
    end: bodyAt + body.length,
  };
}

/**
 * If the range is wrapped in `before`/`after` — either inside the markers or
 * spanning them — return the state with the markers removed. Otherwise null.
 */
function unwrapAt(
  value: string,
  start: number,
  end: number,
  before: string,
  after: string,
): SelectionState | null {
  // Selection sits inside the markers: '''[abc]'''
  if (
    value.slice(Math.max(0, start - before.length), start) === before &&
    value.slice(end, end + after.length) === after
  ) {
    const from = start - before.length;
    return {
      value: value.slice(0, from) + value.slice(start, end) + value.slice(end + after.length),
      start: from,
      end: from + (end - start),
    };
  }
  // Selection spans the markers: ['''abc''']
  const selected = value.slice(start, end);
  if (
    selected.length >= before.length + after.length &&
    selected.startsWith(before) &&
    selected.endsWith(after)
  ) {
    const inner = selected.slice(before.length, selected.length - after.length);
    return {
      value: value.slice(0, start) + inner + value.slice(end),
      start,
      end: start + inner.length,
    };
  }
  return null;
}

/**
 * Add `marker` (`"* "`, `"# "`, `":"`, …) to the start of every line the
 * selection touches — the list and indent buttons (spec §4). When every
 * non-blank line already carries it, the marker is removed instead, so the
 * button toggles.
 */
export function prefixLines(state: SelectionState, marker: string): SelectionState {
  const { value, start, end } = normalize(state);
  const from = lineStartAt(value, start);
  const to = lineEndAt(value, end);
  const lines = value.slice(from, to).split("\n");
  const meaningful = lines.filter((line) => line.trim() !== "");
  const present = meaningful.length > 0 && meaningful.every((line) => line.startsWith(marker));

  const next = lines.map((line) => {
    if (present) return line.startsWith(marker) ? line.slice(marker.length) : line;
    if (line.trim() === "" && meaningful.length > 0) return line;
    return marker + line;
  });

  const block = next.join("\n");
  return { value: value.slice(0, from) + block + value.slice(to), start: from, end: from + block.length };
}

/** `= … =` … `===== … =====` levels the heading button offers (spec §2). */
export type HeadingLevel = 0 | 2 | 3 | 4 | 5;

const HEADING_RE = /^(={1,6})[ \t]*(.*?)[ \t]*\1[ \t]*$/;

/**
 * Retitle every line the selection touches as a level-`level` heading;
 * `level === 0` strips the heading markers. Existing markers of any level are
 * replaced rather than nested, so the dropdown behaves like a level picker.
 */
export function setHeadingLevel(state: SelectionState, level: HeadingLevel): SelectionState {
  const { value, start, end } = normalize(state);
  const from = lineStartAt(value, start);
  const to = lineEndAt(value, end);
  const next = value
    .slice(from, to)
    .split("\n")
    .map((line) => {
      const match = HEADING_RE.exec(line.trim());
      const text = (match !== null ? match[2] : line).trim();
      if (level === 0) return text;
      const bars = "=".repeat(level);
      return text === "" ? `${bars}  ${bars}` : `${bars} ${text} ${bars}`;
    })
    .join("\n");
  return { value: value.slice(0, from) + next + value.slice(to), start: from, end: from + next.length };
}

const INTERNAL_LINK_RE = /\[\[([^[\]|]*)(?:\|([^[\]]*))?\]\]/g;
const EXTERNAL_LINK_RE = /\[((?:https?:)?\/\/[^\s[\]]+|(?:mailto|ftp|news|irc):[^\s[\]]+)(?:[ \t]+([^\]]*))?\]/g;

/**
 * Unlink: reduce `[[Target|label]]` → `label`, `[[Target]]` → `Target`,
 * `[https://x label]` → `label` and `[https://x]` → `https://x`
 * (spec §5.1, §6.2) across the selection. A bare caret unlinks its whole line,
 * which is what makes the button usable without selecting first.
 */
export function unlinkSelection(state: SelectionState): SelectionState {
  const { value, start, end } = normalize(state);
  const from = start === end ? lineStartAt(value, start) : start;
  const to = start === end ? lineEndAt(value, end) : end;
  const next = value
    .slice(from, to)
    .replace(INTERNAL_LINK_RE, (_m, target: string, label?: string) =>
      label !== undefined && label.trim() !== "" ? label : target,
    )
    .replace(EXTERNAL_LINK_RE, (_m, url: string, label?: string) =>
      label !== undefined && label.trim() !== "" ? label : url,
    );
  return { value: value.slice(0, from) + next + value.slice(to), start: from, end: from + next.length };
}

/**
 * Replace the selection with `text` and leave the caret after it — the
 * special-characters grid and the signature-less date stamp.
 */
export function insertAtCaret(state: SelectionState, text: string): SelectionState {
  const { value, start, end } = normalize(state);
  const at = start + text.length;
  return { value: value.slice(0, start) + text + value.slice(end), start: at, end: at };
}

/* ------------------------------------------------------------------ */
/* Command envelope                                                    */
/* ------------------------------------------------------------------ */

/**
 * What a toolbar button (or a rail quick action) asks the editor to do. The
 * editor reads the live textarea into a `SelectionState`, runs `applyCommand`,
 * writes the value back to React state and restores the returned selection.
 */
export type EditorCommand =
  | ({ kind: "wrap" } & WrapSpec)
  | { kind: "prefix"; marker: string }
  | { kind: "heading"; level: HeadingLevel }
  | { kind: "unlink" }
  | { kind: "insert"; text: string };

/** Dispatch one `EditorCommand` over a selection state. */
export function applyCommand(state: SelectionState, command: EditorCommand): SelectionState {
  switch (command.kind) {
    case "wrap":
      return wrapSelection(state, command);
    case "prefix":
      return prefixLines(state, command.marker);
    case "heading":
      return setHeadingLevel(state, command.level);
    case "unlink":
      return unlinkSelection(state);
    case "insert":
      return insertAtCaret(state, command.text);
  }
}
