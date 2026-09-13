/**
 * The version chip row — docs/engine/versioning.md §6.
 *
 * **Amended 2026-09-03 (by user): the row shows the versions this page writes
 * for, as chips, and nothing else.** No status words, no registry list, no
 * span line under the label. A page that writes for v56 and v70 shows two
 * chips; a page that writes for none shows nothing at all. The reasoning is
 * the boundaries' own: a page branching at v56 and v70 renders identically at
 * v57…v69, so a control listing thirteen versions offered eleven identical
 * answers and buried the two that differ.
 *
 * One presentational row, shared by the two surfaces that need the *same*
 * control: the article header renders it on the server as plain `?v=` links,
 * and the editor renders it from the live buffer as buttons that repaint the
 * preview. Neither surface owns the row; both hand it a model built by
 * `pageVersionBranches` (src/lib/version-branches.ts) plus the strings to
 * print, and nothing else.
 *
 * The §6 rule that survives the strip-down, because no chip can answer it on
 * its own: **the active chip is the branch that GOVERNS the selection**, never
 * one whose id equals it — boundaries `[v56, v70]` read at v65 fill the *v56*
 * chip. The model decides that (`branch.active`); this row only draws it, and
 * draws nothing filled when the selection sits below every boundary, because a
 * fallback highlight there would tell the reader something untrue.
 *
 * A boundary the registry does not know keeps its chip and gains a note (§1):
 * the page names that version, so somebody has to see that nobody registered
 * it — and it stays selectable, because it is what the page says.
 *
 * **Actions ride beside the chip's face, never inside it.** `onRemove` and
 * `onRegister` are editor-only, and what they produce is a real `<button>` —
 * a *sibling* of the link or button that selects the branch, never a child of
 * it. A button nested in the article's `<Link>` would be markup no browser
 * agrees how to activate; here the article passes no handlers and so gets no
 * buttons at all.
 *
 * There is deliberately no "use client" directive: the article selector is a
 * server component and must stay one. The module is universal, so a client
 * component that imports it simply pulls it into its own bundle — which is how
 * the editor gets the `onSelect` form.
 */

import Link from "next/link";
import type { ReactElement, ReactNode } from "react";

import { formatMessage } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { VersionBranch } from "@/lib/version-branches";

/**
 * Every user-visible string the row prints (dictionary keys `version.*`).
 *
 * The three action strings are optional because the article side has no
 * actions to name — and a handler whose wording is missing renders **no**
 * button: an unlabelled icon button is worse than an absent one, and a
 * hard-coded fallback would be a user-visible string coming from code rather
 * than from the dictionary.
 */
export interface VersionChipsLabels {
  /** Names the row for assistive tech ("Versions on this page"). */
  heading: string;
  /** Note on a boundary the registry does not have (§1). */
  unregistered: string;
  /** Editor only: the X's accessible name — placeholder `{id}`. */
  remove?: string;
  /** Editor only: the offer to register an unknown boundary — `{id}`. */
  register?: string;
  /** Editor only: accessible name of an action whose request is in flight. */
  busy?: string;
}

export interface VersionChipsProps {
  branches: readonly VersionBranch[];
  labels: VersionChipsLabels;
  /** Article side: each chip is a link to this href. */
  hrefFor?: (id: string) => string;
  /** Editor side: each chip is a button that calls this. */
  onSelect?: (id: string) => void;
  /** Editor only: delete this version's writing from the page. */
  onRemove?: (id: string) => void;
  /** Editor only: an unregistered id can be registered from its own chip. */
  onRegister?: (id: string) => void;
  /** That chip is mid-request: its actions go inert and say so. */
  busyId?: string | null;
  className?: string;
}

const ROW = "flex min-w-0 list-none flex-wrap items-center gap-1.5";

/** The chip's frame: border, fill, and the hover that answers the whole chip. */
const SHELL =
  "inline-flex max-w-full items-stretch rounded-[var(--radius-md)] border transition-colors";
const SHELL_IDLE =
  "border-hairline bg-surface text-body hover:border-hairline-strong hover:bg-canvas-soft-2 hover:text-ink";
const SHELL_ACTIVE = "border-transparent bg-primary text-on-primary shadow-[var(--shadow-sm)]";

/** The face selects the branch; its colour is inherited from the frame. */
const FACE =
  "focus-ring flex min-w-0 flex-col items-start gap-0.5 break-words rounded-[var(--radius-md)]" +
  " px-2.5 py-1 text-left font-mono text-xs font-medium leading-tight";
const NOTE = "text-[11px] font-normal leading-tight";
const NOTE_IDLE = "text-faint";
const NOTE_ACTIVE = "text-on-primary/80";

const ACTION =
  "focus-ring inline-flex shrink-0 items-center border-l px-1.5 transition-colors disabled:opacity-50";
const ACTION_IDLE = "border-hairline text-faint hover:text-ink";
const ACTION_ACTIVE = "border-on-primary/30 text-on-primary/80 hover:text-on-primary";

const ICON = "size-3";

function XIcon(): ReactElement {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={ICON}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
    >
      <path d="M4 4l8 8m0-8l-8 8" />
    </svg>
  );
}

function PlusIcon(): ReactElement {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={ICON}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
    >
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

interface ChipActionProps {
  /** Accessible name *and* tooltip: the icon alone names nothing. */
  label: string;
  active: boolean;
  busy: boolean;
  onClick: () => void;
  children: ReactNode;
}

function ChipAction({ label, active, busy, onClick, children }: ChipActionProps): ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={busy}
      aria-busy={busy ? "true" : undefined}
      onClick={onClick}
      className={cn(ACTION, active ? ACTION_ACTIVE : ACTION_IDLE)}
    >
      {children}
    </button>
  );
}

interface ChipProps {
  branch: VersionBranch;
  labels: VersionChipsLabels;
  href?: string;
  onSelect?: (id: string) => void;
  onRemove?: (id: string) => void;
  onRegister?: (id: string) => void;
  busy: boolean;
}

function Chip({
  branch,
  labels,
  href,
  onSelect,
  onRemove,
  onRegister,
  busy,
}: ChipProps): ReactElement {
  const active = branch.active;
  const noteClass = cn(NOTE, active ? NOTE_ACTIVE : NOTE_IDLE);
  // Exactly one chip may carry this, and none does when the selection sits
  // below every boundary (§6 rule 1) — `active` is the model's answer, not an
  // equality test done here.
  const current = active ? "true" : undefined;

  const face = (
    <>
      <span>{branch.label}</span>
      {branch.unregistered ? <span className={noteClass}>{labels.unregistered}</span> : null}
    </>
  );

  let selector: ReactElement;
  if (href !== undefined) {
    selector = (
      <Link href={href} aria-current={current} className={FACE}>
        {face}
      </Link>
    );
  } else if (onSelect !== undefined) {
    selector = (
      <button
        type="button"
        aria-current={current}
        className={FACE}
        onClick={() => onSelect(branch.id)}
      >
        {face}
      </button>
    );
  } else {
    selector = (
      <span aria-current={current} className={FACE}>
        {face}
      </span>
    );
  }

  // An unregistered chip previews the site default instead of its own branch,
  // so it is broken until somebody registers it: this is a repair offered
  // where the breakage shows, not a registry listing (§6 editor notes).
  const register =
    branch.unregistered && onRegister !== undefined && labels.register !== undefined
      ? formatMessage(labels.register, { id: branch.id })
      : null;
  // Named the way the chip is named — the registry's label — so the button and
  // the face a screen reader reads out one after the other are about a version
  // the listener can tell is the same one. Registration is the exception: it
  // creates a registry row, and the id is what that row will be called.
  const remove =
    onRemove !== undefined && labels.remove !== undefined
      ? formatMessage(labels.remove, { id: branch.label })
      : null;

  return (
    <span className={cn(SHELL, active ? SHELL_ACTIVE : SHELL_IDLE)}>
      {selector}
      {register === null || onRegister === undefined ? null : (
        <ChipAction
          label={busy && labels.busy !== undefined ? labels.busy : register}
          active={active}
          busy={busy}
          onClick={() => onRegister(branch.id)}
        >
          <PlusIcon />
        </ChipAction>
      )}
      {remove === null || onRemove === undefined ? null : (
        <ChipAction label={remove} active={active} busy={busy} onClick={() => onRemove(branch.id)}>
          <XIcon />
        </ChipAction>
      )}
    </span>
  );
}

export function VersionChips({
  branches,
  labels,
  hrefFor,
  onSelect,
  onRemove,
  onRegister,
  busyId,
  className,
}: VersionChipsProps): ReactElement | null {
  // The versions this page writes for, and nothing else — so a page that
  // writes for none draws nothing at all rather than an empty frame.
  if (branches.length === 0) return null;

  // Passing both is a programming error; `hrefFor` wins, so the surface that
  // made the mistake still navigates instead of doing nothing.
  const select = hrefFor === undefined ? onSelect : undefined;

  const body = (
    <ul className={ROW}>
      {branches.map((branch) => (
        <li key={branch.id} className="min-w-0">
          <Chip
            branch={branch}
            labels={labels}
            href={hrefFor === undefined ? undefined : hrefFor(branch.id)}
            onSelect={select}
            onRemove={onRemove}
            onRegister={onRegister}
            busy={busyId !== null && busyId !== undefined && busyId === branch.id}
          />
        </li>
      ))}
    </ul>
  );

  const shell = cn("min-w-0", className);
  // Links are navigation; buttons and inert chips are a labelled group.
  return hrefFor === undefined ? (
    <div role="group" aria-label={labels.heading} className={shell}>
      {body}
    </div>
  ) : (
    <nav aria-label={labels.heading} className={shell}>
      {body}
    </nav>
  );
}
