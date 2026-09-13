"use client";

/**
 * The editing surface: a line-number gutter, a syntax-highlighted `<pre>`
 * mirror, and a transparent `<textarea>` stacked on top of it.
 *
 * Why a mirror rather than a contenteditable: the textarea keeps native
 * undo/redo, IME composition (Korean is a first-class locale here), spell
 * check and mobile keyboards, and `.wiki-source-layer` in globals.css pins
 * both layers to identical metrics so the caret never drifts from its glyph.
 * Soft wrapping is off, so one source line is always one gutter row — which
 * is also what makes tabs and CJK line up, since both layers measure them
 * with the same font.
 *
 * The textarea is the only scroller; its offsets are pushed to the mirror and
 * the gutter on every scroll (mirror and gutter are `overflow: hidden`, which
 * still accepts a programmatic `scrollTop`).
 */

import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";

import { EditorHighlight } from "@/components/wiki/editor-highlight";
import { cn } from "@/lib/utils";

/**
 * Put a range of the buffer on screen: select it, and scroll the line it sits
 * on into the middle of the pane (visual-editor.md §9).
 *
 * It lives here rather than in the island because the metrics it needs are this
 * module's: `.wiki-source-layer` pins the textarea, the mirror and the gutter to
 * one line box, and reading that box off the textarea is what keeps the answer
 * true if the box ever changes.
 *
 * **Selection without focus, deliberately.** The find panel keeps the keyboard
 * while the author steps through matches, and `focus()` here would take it away
 * on every arrow press. A textarea remembers a selection it was given while
 * blurred, so Escape hands the focus back with the match already selected —
 * which is also what makes a replacement's caret sane: React re-renders the
 * controlled textarea with a new value, the browser parks the caret at the end
 * of it, and this puts it back on the text that was just written.
 *
 * Only the vertical scroll is set. Soft wrapping is off, so a match far along a
 * very long line can still be off to the right — and a horizontal guess would
 * need a character advance this file cannot measure without drawing something.
 * A wrong guess scrolls the author away from the line they were shown.
 */
export function revealInTextarea(
  textarea: HTMLTextAreaElement,
  range: { start: number; end: number },
): void {
  textarea.setSelectionRange(range.start, range.end);

  const view = textarea.ownerDocument.defaultView;
  if (view === null) return;
  const style = view.getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(style.lineHeight);
  // `line-height: normal` parses to NaN; there is no line box to count in then,
  // so the selection stands on its own rather than scrolling to a guess.
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
  const paddingTop = Number.parseFloat(style.paddingTop);

  const value = textarea.value;
  let line = 0;
  for (let i = 0; i < range.start && i < value.length; i += 1) {
    if (value.charCodeAt(i) === 10) line += 1;
  }

  const top = (Number.isFinite(paddingTop) ? paddingTop : 0) + line * lineHeight;
  const centred = top - Math.max(0, (textarea.clientHeight - lineHeight) / 2);
  const furthest = Math.max(0, textarea.scrollHeight - textarea.clientHeight);
  // The mirror and the gutter follow through the textarea's own `scroll` event,
  // which a programmatic write fires like any other.
  textarea.scrollTop = Math.max(0, Math.min(centred, furthest));
}

export interface EditorSourceProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** Owned by the editor island, which needs it for selection surgery. */
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  readOnly?: boolean;
  ariaLabel: string;
  /** aria-label for the gutter, so screen readers can skip the numbers. */
  lineNumbersLabel: string;
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /**
   * Where the caret is now, as an offset into the buffer — how the outline
   * learns which section is being written in (visual-editor.md §10.1).
   *
   * Through React's `onSelect`, which fires for a plain caret move and not only
   * for a selection, and *only* when a handler is registered — so a page that
   * asks for nothing pays for nothing. The caller is expected to fold the
   * offset down to something coarse before it reaches state, because this fires
   * on every arrow key and §8's rule is that nothing may cost a keystroke.
   */
  onCaretChange?: (offset: number) => void;
  className?: string;
}

export function EditorSource({
  id,
  value,
  onChange,
  textareaRef,
  readOnly = false,
  ariaLabel,
  lineNumbersLabel,
  onKeyDown,
  onCaretChange,
  className,
}: EditorSourceProps) {
  const mirrorRef = useRef<HTMLPreElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);

  const lineCount = useMemo(() => {
    let lines = 1;
    for (let i = 0; i < value.length; i += 1) if (value.charCodeAt(i) === 10) lines += 1;
    return lines;
  }, [value]);

  const syncScroll = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    const mirror = mirrorRef.current;
    if (mirror !== null) {
      mirror.scrollTop = textarea.scrollTop;
      mirror.scrollLeft = textarea.scrollLeft;
    }
    const gutter = gutterRef.current;
    if (gutter !== null) gutter.scrollTop = textarea.scrollTop;
  }, [textareaRef]);

  // A toolbar insertion can move the caret off-screen and changes the mirror's
  // height; re-sync after every value change, not only on user scrolls.
  useEffect(syncScroll, [value, syncScroll]);

  return (
    <div
      className={cn(
        "grid min-w-0 grid-cols-[auto_minmax(0,1fr)] overflow-hidden rounded-[var(--radius-md)] border border-hairline bg-canvas-soft focus-within:border-link focus-within:ring-2 focus-within:ring-link/40",
        className,
      )}
    >
      {/* The numbers are absolutely positioned so a long document cannot
          stretch the fixed-height row; the gutter still scrolls because its
          inner block overflows it. */}
      <div
        ref={gutterRef}
        aria-hidden
        aria-label={lineNumbersLabel}
        className="relative w-12 overflow-hidden border-r border-hairline bg-canvas-soft-2"
      >
        <div className="wiki-source-gutter absolute inset-x-0 top-0 pr-2">
          {Array.from({ length: lineCount }, (_unused, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
      </div>

      <div className="relative min-w-0 bg-canvas">
        <EditorHighlight source={value} mirrorRef={mirrorRef} />
        <textarea
          id={id}
          ref={textareaRef}
          value={value}
          readOnly={readOnly}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label={ariaLabel}
          className="wiki-source-layer wiki-source-input"
          onChange={(event) => onChange(event.target.value)}
          onScroll={syncScroll}
          onKeyDown={onKeyDown}
          onSelect={
            onCaretChange === undefined
              ? undefined
              : (event) => onCaretChange(event.currentTarget.selectionStart)
          }
        />
      </div>
    </div>
  );
}
