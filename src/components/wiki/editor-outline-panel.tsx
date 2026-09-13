"use client";

/**
 * The outline panel — the editor's map of the article
 * (docs/engine/visual-editor.md §10.1).
 *
 * It draws and it decides nothing else: the tree, the section arithmetic and
 * the refusals are all `editor-outline.ts`'s, so what is testable here is the
 * paint. That split is the same one the toolbars keep — a control that owns no
 * buffer cannot disagree with the buffer.
 *
 * **Where it lives, and why.** In the page-tools column, as its first card,
 * above the rail proper. The column is already where the facts *about* the page
 * are drawn from the buffer — the templates it transcludes, the categories it
 * files under — and an outline is the same kind of fact. Putting it there also
 * settles the constraint that decided against the obvious alternative: a third
 * column beside the surface would take its width from the writing column, and
 * on a laptop the writing column is the one thing that must not get narrower.
 * The page-tools column already exists and already costs that width.
 *
 * It is a card of its own rather than a section *inside* `EditorRail` for one
 * reason: the rail folds its own contents away, and an author who folds the
 * tool sections to see more of the page has more reason to want the map, not
 * less.
 *
 * **Two controls per row, and why both.** Clicking the row scrolls to the
 * heading and puts the caret there — the ordinary thing a table of contents
 * does. The two arrows move the whole section among its siblings, which is the
 * thing §3.1's block handle cannot give: an author restructuring an article
 * thinks in sections, and doing "swap Behaviour and Strategy" one block at a
 * time is a dozen presses through a dozen wrong arrangements. An arrow whose
 * section has nowhere to go is *disabled* rather than inert, the rule the
 * gutter handle already keeps — and "nowhere" includes the case that looks like
 * somewhere: a subsection whose only same-level neighbour lives under a
 * different heading (`sectionSibling` says why moving onto it would be a
 * re-parenting rather than a reorder).
 */

import type { ReactNode } from "react";

import { ChevronDownIcon, ChevronUpIcon } from "@/components/wiki/editor-icons";
import {
  sectionSibling,
  type OutlineHeading,
  type OutlineMoveDirection,
} from "@/components/wiki/editor-outline";
import { formatMessage } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface EditorOutlineLabels {
  /** The card's heading. */
  title: string;
  /** Shown while the article has no headings at all. */
  empty: string;
  /** Stands in for the text of a heading that has none (`== ==`). */
  untitled: string;
  /** Accessible name of a row's up arrow — "{title}" is the heading. */
  moveUp: string;
  /** The same, downwards. */
  moveDown: string;
}

export interface EditorOutlinePanelProps {
  /** The buffer's headings, in document order (`documentOutline`). */
  headings: readonly OutlineHeading[];
  /**
   * The section the caret is standing in, as an index into `headings`, or -1
   * for the lead — which is in no section, and is honestly marked as none
   * rather than as the first.
   */
  current: number;
  /**
   * Nobody may edit this page. The arrows go inert; the rows do not, because
   * reading a long article's structure is not editing it.
   */
  readOnly?: boolean;
  onSelect: (index: number) => void;
  onMove: (index: number, direction: OutlineMoveDirection) => void;
  labels: EditorOutlineLabels;
}

/**
 * Indent per nesting depth. Tailwind needs the class to be written out, and
 * four steps is all the outline can need: the format menu offers `h2`…`h5`
 * (§1), so a document written with the controls has at most four levels, and
 * one hand-written deeper than that stops indenting rather than marching off
 * the edge of an 18rem column.
 */
const DEPTH_CLASSES = ["pl-2", "pl-5", "pl-8", "pl-11"] as const;

/** The two arrows: same size, same states, one place to change them. */
function MoveButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="focus-ring inline-flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-mute transition-colors hover:bg-canvas-soft hover:text-ink disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}

export function EditorOutlinePanel({
  headings,
  current,
  readOnly = false,
  onSelect,
  onMove,
  labels,
}: EditorOutlinePanelProps) {
  return (
    <section className="flex min-w-0 flex-col rounded-[var(--radius-lg)] border border-hairline bg-surface">
      <div className="border-b border-hairline px-3 py-2">
        <h2 className="text-xs font-semibold tracking-tight text-ink">{labels.title}</h2>
      </div>

      {headings.length === 0 ? (
        <p className="px-3 py-3 text-xs text-faint">{labels.empty}</p>
      ) : (
        // A long article's outline scrolls inside the card rather than pushing
        // the rest of the page-tools column off the screen.
        <ul className="max-h-[20rem] overflow-y-auto py-1">
          {headings.map((heading, index) => {
            const title = heading.title === "" ? labels.untitled : heading.title;
            const canMoveUp = sectionSibling(headings, index, "up") >= 0;
            const canMoveDown = sectionSibling(headings, index, "down") >= 0;
            const isCurrent = index === current;
            return (
              <li
                key={`${heading.id}:${heading.blockIndex}`}
                className="flex items-center gap-0.5 pr-1.5"
              >
                <button
                  type="button"
                  title={title}
                  // The row is where the caret goes, so the row is what says it
                  // already holds the caret.
                  aria-current={isCurrent ? "true" : undefined}
                  onClick={() => onSelect(index)}
                  className={cn(
                    "focus-ring flex min-w-0 flex-1 items-baseline gap-1.5 rounded-[var(--radius-sm)] py-1 pr-1 text-left text-xs transition-colors hover:bg-canvas-soft hover:text-ink",
                    DEPTH_CLASSES[Math.min(heading.depth, DEPTH_CLASSES.length - 1)],
                    isCurrent ? "bg-canvas-soft-2 font-medium text-ink" : "text-body",
                  )}
                >
                  {/* Deliberately part of the button's accessible name: the
                      indent carries the level for a reader who can see it and
                      for nobody else. */}
                  <span className="shrink-0 font-mono text-[10px] text-faint">
                    {`H${heading.level}`}
                  </span>
                  <span className="min-w-0 truncate">{title}</span>
                </button>
                <MoveButton
                  label={formatMessage(labels.moveUp, { title })}
                  disabled={readOnly || !canMoveUp}
                  onClick={() => onMove(index, "up")}
                >
                  <ChevronUpIcon className="size-3.5" />
                </MoveButton>
                <MoveButton
                  label={formatMessage(labels.moveDown, { title })}
                  disabled={readOnly || !canMoveDown}
                  onClick={() => onMove(index, "down")}
                >
                  <ChevronDownIcon className="size-3.5" />
                </MoveButton>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
