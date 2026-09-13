"use client";

/**
 * The find-and-replace strip, above whichever surface is on screen
 * (docs/engine/visual-editor.md §9).
 *
 * It is one panel for both modes because it searches the **buffer** rather
 * than a surface: `editor-find.ts` holds the matching, this file holds the
 * controls, and neither knows which of the two editors is mounted below it.
 * Renaming an item across a long article is the chore this exists for, and the
 * browser's own Ctrl+F cannot do the second half of it.
 *
 * **Why nothing is highlighted in the article.** Marking every hit inside the
 * contenteditable would mean writing elements into the surface that
 * `domToDocument` then has to be taught to ignore — and §3's rule is the
 * opposite one: markup wearing none of our labels is the *author's*, so a
 * wrapper left behind by a stripping pass that ran a moment late would publish
 * itself and break §4's byte-identical guarantee for a block nobody edited.
 * A find panel is not worth that risk. So the current match is shown three
 * ways that write nothing:
 *
 * - **in context here**, cut straight out of the buffer, which is the only
 *   presentation that is identical in both modes and the only one that can show
 *   a match the visual surface never renders at all (a name inside a template
 *   call is an atomic node's `source`);
 * - **scrolled to**, and
 * - **selected**, using the browser's own selection — a Range over the text
 *   nodes that are already there, which is markup-free by construction.
 *
 * The panel owns the query, the toggles and which match is current; it owns no
 * buffer. Both replace buttons hand a request up to the island, which applies
 * it to the text it has just read back off the live surface (§9), and hands
 * back where the replacement landed so the strip can step past its own output.
 */

import { useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { CONTROL_CLASSES } from "@/components/ui/input";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CloseIcon,
  MatchCaseIcon,
  SearchIcon,
  WholeWordIcon,
} from "@/components/wiki/editor-icons";
import {
  findMatches,
  matchContext,
  matchIndexBefore,
  matchIndexFrom,
  type FindApplyOutcome,
  type FindApplyRequest,
  type FindMatch,
  type FindOptions,
} from "@/components/wiki/editor-find";
import { formatMessage } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** What the island is asked to put on screen, in the buffer's own terms. */
export interface FindReveal {
  match: FindMatch;
  /**
   * The text at `match` — the query when stepping through hits, the
   * replacement just written when one has been applied. The visual surface
   * looks for it inside the block the offset falls in, so it has to be the
   * string that is actually there now.
   */
  needle: string;
  options: FindOptions;
}

export interface EditorFindLabels {
  /** Accessible name of the strip as a whole. */
  title: string;
  /** Field name; also its placeholder, since the strip has no room for both. */
  find: string;
  replace: string;
  previous: string;
  next: string;
  matchCase: string;
  wholeWord: string;
  /** "{index} of {total}". */
  count: string;
  noResults: string;
  replaceOne: string;
  replaceAll: string;
  /** Accessible name of the line printing the match with its surroundings. */
  context: string;
  close: string;
}

export interface EditorFindPanelProps {
  /**
   * The buffer to search. The visual surface serializes on a debounce, so this
   * can trail the caret by a fraction of a second — which is a stale *count*,
   * never a stale edit: the island re-reads the live surface before it applies
   * anything (§9).
   */
  text: string;
  /** Whatever was selected when the shortcut was pressed (`seedQuery`). */
  initialQuery: string;
  /** So the shortcut can re-focus the field when the strip is already open. */
  inputId: string;
  /** A reader who cannot publish can still search; replacing is not offered. */
  readOnly?: boolean;
  onClose: () => void;
  onReveal: (reveal: FindReveal) => void;
  /** Applies one replacement, or all of them, and says where it landed. */
  onApply: (request: FindApplyRequest) => FindApplyOutcome;
  labels: EditorFindLabels;
}

/** The strip's icon buttons: same size, same states, one place to change them. */
function IconButton({
  label,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "focus-ring inline-flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border transition-colors disabled:pointer-events-none disabled:opacity-40",
        pressed === true
          ? "border-hairline-strong bg-primary text-on-primary"
          : "border-transparent text-mute hover:bg-canvas-soft hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

export function EditorFindPanel({
  text,
  initialQuery,
  inputId,
  readOnly = false,
  onClose,
  onReveal,
  onApply,
  labels,
}: EditorFindPanelProps) {
  const [query, setQuery] = useState(initialQuery);
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  /**
   * The buffer offset the strip wants to stand at or after — not an index,
   * because the buffer changes underneath it. An index would name a different
   * hit after every replacement and after every keystroke in the article; an
   * offset survives both, and re-deriving the index from it is what makes
   * "Replace" step past the text it has just written rather than into it.
   *
   * It starts *before* the buffer so that the first hit is one the arrows can
   * land on: an anchor equal to a match's start means that match is where the
   * author already is, and the next arrow moves off it.
   */
  const [anchor, setAnchor] = useState(-1);

  const options = useMemo<FindOptions>(
    () => ({ caseSensitive, wholeWord }),
    [caseSensitive, wholeWord],
  );
  const matches = useMemo(() => findMatches(text, query, options), [text, query, options]);
  const index = matchIndexFrom(matches, anchor);
  const current = index < 0 ? null : matches[index];
  const context = current === null ? null : matchContext(text, current);

  const retarget = (next: string) => {
    setQuery(next);
    // A new query starts a new search, so the arrows begin at its first hit.
    setAnchor(-1);
  };

  /**
   * Step to the neighbouring match, wrapping.
   *
   * Both directions are asked in terms of the anchor rather than of the index,
   * which is what makes the first press right: the strip starts standing *before*
   * the buffer, so the next match is the first one and the previous match is the
   * last one — rather than both being the first.
   */
  const go = (delta: 1 | -1) => {
    if (current === null) return;
    const target =
      delta === -1
        ? matches[matchIndexBefore(matches, anchor)]
        : current.start === anchor
          ? matches[(index + 1) % matches.length]
          : current;
    setAnchor(target.start);
    onReveal({ match: target, needle: query, options });
  };

  const apply = (only: number | null) => {
    if (query === "" || readOnly) return;
    const outcome = onApply({ query, replacement, options, index: only });
    // Past its own output: the next arrow then finds the first hit that is not
    // the replacement, even when the replacement contains the query.
    setAnchor(outcome.landed === null ? -1 : outcome.landed.end);
  };

  const countLabel =
    query === ""
      ? ""
      : matches.length === 0
        ? labels.noResults
        : formatMessage(labels.count, { index: index + 1, total: matches.length });

  const fieldClasses = cn(CONTROL_CLASSES, "h-8 min-w-0 px-2 text-sm");

  return (
    <div
      role="group"
      aria-label={labels.title}
      onKeyDown={(event) => {
        // Escape belongs to the strip while the focus is inside it; the island
        // takes the focus back to wherever the shortcut was pressed.
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        onClose();
      }}
      className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-hairline bg-canvas-soft p-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <SearchIcon className="ml-1 size-4 shrink-0 text-faint" />

        <label htmlFor={inputId} className="sr-only">
          {labels.find}
        </label>
        <input
          id={inputId}
          autoFocus
          value={query}
          placeholder={labels.find}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => retarget(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.ctrlKey || event.metaKey) return;
            event.preventDefault();
            go(event.shiftKey ? -1 : 1);
          }}
          className={cn(fieldClasses, "w-44 flex-1 sm:w-56 sm:flex-none")}
        />

        {/* The count is a live region so a screen reader hears the search
            narrow as the query is typed, and hears a replace-all empty it. */}
        <span
          aria-live="polite"
          className="min-w-[6rem] shrink-0 text-xs tabular-nums text-mute"
        >
          {countLabel}
        </span>

        <div className="flex items-center gap-1">
          <IconButton
            label={labels.matchCase}
            pressed={caseSensitive}
            onClick={() => {
              setCaseSensitive(!caseSensitive);
              setAnchor(-1);
            }}
          >
            <MatchCaseIcon />
          </IconButton>
          <IconButton
            label={labels.wholeWord}
            pressed={wholeWord}
            onClick={() => {
              setWholeWord(!wholeWord);
              setAnchor(-1);
            }}
          >
            <WholeWordIcon />
          </IconButton>
          <IconButton
            label={labels.previous}
            disabled={current === null}
            onClick={() => go(-1)}
          >
            <ChevronUpIcon />
          </IconButton>
          <IconButton label={labels.next} disabled={current === null} onClick={() => go(1)}>
            <ChevronDownIcon />
          </IconButton>
        </div>

        <div className="ml-auto">
          <IconButton label={labels.close} onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </div>
      </div>

      {readOnly ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {/* Aligned under the find field: the magnifier's width, then the
              same label/field pair. */}
          <span aria-hidden className="ml-1 size-4 shrink-0" />
          <label htmlFor={`${inputId}-replace`} className="sr-only">
            {labels.replace}
          </label>
          <input
            id={`${inputId}-replace`}
            value={replacement}
            placeholder={labels.replace}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => setReplacement(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.ctrlKey || event.metaKey) return;
              event.preventDefault();
              // Enter here replaces the hit on screen, never all of them: a
              // replace-all is a whole-article edit and asks to be clicked.
              apply(index);
            }}
            className={cn(fieldClasses, "w-44 flex-1 sm:w-56 sm:flex-none")}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={current === null}
            onClick={() => apply(index)}
          >
            {labels.replaceOne}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={matches.length === 0}
            onClick={() => apply(null)}
          >
            {labels.replaceAll}
          </Button>
        </div>
      )}

      {context === null ? null : (
        <p
          aria-label={labels.context}
          className="truncate rounded-[var(--radius-sm)] bg-canvas px-2 py-1 font-mono text-xs text-mute"
        >
          {context.clippedBefore ? <span aria-hidden>…</span> : null}
          {context.before}
          <mark className="rounded-[var(--radius-sm)] bg-primary/20 px-0.5 text-ink">
            {context.match}
          </mark>
          {context.after}
          {context.clippedAfter ? <span aria-hidden>…</span> : null}
        </p>
      )}
    </div>
  );
}
