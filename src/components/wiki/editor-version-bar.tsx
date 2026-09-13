"use client";

/**
 * The editor's half of the §6 version selector (docs/engine/versioning.md).
 *
 * §6 is explicit that the author gets the *reader's* control, not a different
 * one: the point of version scoping is that one page holds every version, so
 * the person writing it needs the control the person reading it has. This is
 * therefore `VersionChips` — the same row the article header renders — with
 * the differences that being an editing surface forces:
 *
 * - **The buffer is the source of boundaries**, not the saved page.
 *   `versionsUsed` (src/lib/wikitext-highlight.ts) is the client-side twin of
 *   the engine's `version_boundaries`, so typing `<v73+>` puts v73 on the row at
 *   once — which is how an author sees the coverage they are building rather
 *   than the coverage they last published. It tokenises the whole buffer and
 *   this component re-renders on every keystroke, so the walk is memoised on
 *   `content`.
 * - **A chip can be deleted** (amended 2026-09-03 by user). A page that
 *   outlived a patch should be able to shed it, and the chip is where the
 *   author already sees that the patch is still here. The X asks first —
 *   `previewVersionRemoval` says how many characters go and what it will not
 *   touch — and then the same transform applies it.
 * - **An unregistered boundary offers to register itself** (§6 editor notes,
 *   decisions-v2 O16.2), from its own chip. Not a registry listing: such a
 *   chip previews the *site default* instead of its own branch, so it is
 *   broken until registered, and this is the repair. `POST /api/versions` is
 *   open to any principal that may edit, the id is validated server-side, and
 *   the row lands as `legacy`.
 * - **The `+` beside the chips is a menu** (amended 2026-09-03 by user). It
 *   lists the versions this page does not write for yet and ends in a field
 *   for an id the registry has not caught up to. Adding a version to a page is
 *   one choice — which version — and the version-scope dialog was the weight of
 *   a form for it; the dialog keeps the questions that are a form (which of the
 *   three tag shapes, over which versions), behind Insert → Version block.
 *
 * Choosing a branch is choosing the editor's preview version: the visual
 * surface repaints its atomic nodes at it — and swaps the branch its in-place
 * field holds (§6) — and source mode's preview pane re-renders. One control,
 * every job.
 *
 * **This bar does not own the buffer.** Both edits it can cause are handed up
 * as intentions rather than as text: a removal as a function through
 * `onContentChange`, exactly as the rail's chips are, and an addition as an id
 * through `onAddVersion`. The editor applies each to the *live* surface, which
 * may hold keystrokes the debounce has not published into `content` yet. That
 * is also why the number in the removal confirmation is computed from
 * `content` while the edit is recomputed from the flushed base: the
 * alternative is a delete that silently reverts the sentence someone was in
 * the middle of typing.
 */

import { useCallback, useId, useMemo, useState } from "react";
import type { KeyboardEvent, ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FieldMessage } from "@/components/ui/field-message";
import { Input } from "@/components/ui/input";
import { MenuItem, MenuSeparator, ToolbarMenu } from "@/components/wiki/editor-menu";
import { VersionChips, type VersionChipsLabels } from "@/components/wiki/version-chips";
import { formatMessage } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  deriveVersionOrdinal,
  pageVersionBranches,
  type VersionRegistryEntry,
} from "@/lib/version-branches";
import { previewVersionRemoval, removeVersionBranch } from "@/lib/visual-editor/version-edit";
import {
  repairVersionMarkup,
  versionMarkupProblems,
  versionsUsed,
  type VersionMarkupProblem,
} from "@/lib/wikitext-highlight";

export interface EditorVersionBarLabels {
  chips: VersionChipsLabels;
  /** The registration was refused or never answered — "{id}". */
  registerFailed: string;
  /**
   * A closing tag that closes nothing and is one letter from closing a version
   * tag — "{tag}" as written, "{suggestion}" as it was probably meant.
   */
  strayCloser: string;
  /** A version tag no closer ever repeated, so it swallows the rest — "{tag}". */
  unclosedTag: string;
  /** The button that repairs a stray closer — "{suggestion}" is what it writes. */
  fixCloser: string;
  /** The "+" that opens the add-a-version menu. */
  add: string;
  /** The menu lists nothing: every registered version is already covered. */
  addMenuEmpty: string;
  /** Label over the menu's field for an id the registry does not have. */
  addOther: string;
  /** Placeholder of that field — an example id, not prose. */
  addOtherPlaceholder: string;
  /** Its confirm. */
  addOtherSubmit: string;
  /** Why a typed id was refused — the shape `POST /api/versions` accepts. */
  addOtherInvalid: string;
  /** Stands in for the chips when the page covers no version yet. */
  empty: string;

  /* — the removal confirmation — */

  /** Dialog title — "{id}". */
  removeTitle: string;
  /** Something to delete — "{id}" and "{chars}". */
  removeBody: string;
  /** The version has no text of its own to lose, so no prose goes — "{id}". */
  removeEmpty: string;
  /** Nothing this transform may delete — "{id}". */
  removeNothing: string;
  /** Occurrences it refuses to touch — "{id}" and "{count}". */
  removeLeftBehind: string;
  /** The destructive button (common.delete). */
  removeConfirm: string;
  /** The way out (common.cancel). */
  cancel: string;
  /** The dialog's own close button (common.close). */
  close: string;
}

export interface EditorVersionBarProps {
  /** The live buffer: boundaries track what is being typed, not what was saved. */
  content: string;
  registry: readonly VersionRegistryEntry[];
  /** The version the editor is previewing at. */
  selected: string;
  onSelect: (id: string) => void;
  /**
   * Hand an edit to whoever owns the buffer. The same shape the rail uses, and
   * for the same reason: the owner reads the base off the live surface, so an
   * edit made here cannot revert unflushed keystrokes.
   */
  onContentChange: (edit: (current: string) => string) => void;
  /**
   * Write for a version this page does not cover yet — the counterpart of the
   * X on a chip, and now one choice rather than a form: the owner gives the
   * page an empty `<vNN+>` passage and previews it, so the author lands in the
   * field that passage is written in.
   */
  onAddVersion?: (id: string) => void;
  /** A boundary registered itself; the caller extends its registry in place. */
  onRegistered?: (entry: VersionRegistryEntry) => void;
  getIdToken: () => Promise<string | null>;
  /** No principal may edit — the row stays readable but inert. */
  disabled?: boolean;
  labels: EditorVersionBarLabels;
}

/** The id shape `POST /api/versions` accepts (versioning.md §1: v62, v64.1). */
const VERSION_ID_RE = /^v\d{1,6}(\.\d{1,4})?$/i;

/**
 * The registry versions this page does not write for yet, newest first.
 *
 * Newest first because that is the order an author reaches for them: the
 * version they are adding is almost always the patch that just shipped, and a
 * registry-order list would bury it under thirteen older ones. Ids the ordinal
 * rule cannot read keep their registry order and sort last — they cannot be
 * placed, but they are still versions somebody registered.
 */
export function uncoveredVersions(
  registry: readonly VersionRegistryEntry[],
  boundaries: readonly string[],
): VersionRegistryEntry[] {
  const covered = new Set(boundaries.map((id) => id.trim().toLowerCase()));
  return registry
    .filter((entry) => !covered.has(entry.id.trim().toLowerCase()))
    .map((entry, index) => ({
      entry,
      index,
      ordinal: entry.ordinal ?? deriveVersionOrdinal(entry.id),
    }))
    .sort((a, b) => {
      if (a.ordinal === null || b.ordinal === null) {
        if (a.ordinal === null && b.ordinal === null) return a.index - b.index;
        return a.ordinal === null ? 1 : -1;
      }
      return b.ordinal - a.ordinal || a.index - b.index;
    })
    .map((row) => row.entry);
}

/**
 * The counterpart of a chip's X: a menu of the versions this page could write
 * for next (amended 2026-09-03 by user).
 *
 * **Why a menu and not the version-scope dialog.** Adding a version to a page
 * is *one choice* — which version — and a modal is the weight of a form. The
 * dialog is still what composes a block from nothing: which of §2.1's three
 * shapes the tag takes, and over which versions, are its questions, and
 * Insert → Version block is where they are asked. This asks the one question,
 * adds an empty passage for the answer and leaves the author typing in it.
 *
 * Deliberately chip-shaped, as the plain `+` was: the row should read as one
 * control — "these are the versions this page covers, and here is another" —
 * not as a list with a stray button beside it. Dashed, because it is the empty
 * slot rather than a version. That is the whole reason `ToolbarMenu` grew a
 * `triggerClassName` instead of this growing a third popover.
 *
 * The typed id is the same escape hatch the version picker has (O16.2): the
 * registry lags the game, and an author who already knows the patch number
 * should not have to wait for somebody to register it. It is validated here
 * against the shape `POST /api/versions` accepts, and the boundary it creates
 * offers to register itself from its own chip — which is where that repair
 * already lives.
 */
function AddVersionMenu({
  options,
  labels,
  onAdd,
}: {
  options: readonly VersionRegistryEntry[];
  labels: EditorVersionBarLabels;
  onAdd?: (id: string) => void;
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [invalid, setInvalid] = useState(false);
  const fieldId = useId();

  const choose = useCallback(
    (id: string) => {
      setOpen(false);
      setTyped("");
      setInvalid(false);
      onAdd?.(id);
    },
    [onAdd],
  );

  const submitTyped = useCallback(() => {
    // Folded the way the route folds it, so `V71` and `v71` are one version
    // and the chip that appears is the one the registry would create.
    const id = typed.trim().toLowerCase();
    if (!VERSION_ID_RE.test(id)) {
      setInvalid(true);
      return;
    }
    choose(id);
  }, [choose, typed]);

  if (onAdd === undefined) return null;

  return (
    <ToolbarMenu
      label={labels.add}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setInvalid(false);
      }}
      trigger={
        <>
          <span aria-hidden>+</span>
          {labels.add}
        </>
      }
      triggerClassName="h-auto shrink-0 rounded-[var(--radius-md)] border border-dashed border-hairline-strong px-2.5 py-1 font-mono text-xs font-medium"
      panelClassName="w-60"
    >
      {options.length === 0 ? (
        // Not a disabled row: there is nothing to choose, and a menu item that
        // cannot be chosen reads as one that is temporarily out of reach.
        <p className="px-2 py-1.5 text-[13px] text-mute">{labels.addMenuEmpty}</p>
      ) : (
        <div className="max-h-56 overflow-y-auto">
          {options.map((option) => (
            <MenuItem key={option.id} label={option.label} onSelect={() => choose(option.id)} />
          ))}
        </div>
      )}

      <MenuSeparator />

      {/* `role="none"` so the field is not read as a menu row: it is the way
          past the list, for a patch the registry has not caught up to. */}
      <div role="none" className="flex flex-col gap-1.5 px-2 py-1.5">
        <label className="text-[11px] font-medium text-mute" htmlFor={fieldId}>
          {labels.addOther}
        </label>
        <div className="flex items-center gap-1.5">
          <Input
            id={fieldId}
            value={typed}
            placeholder={labels.addOtherPlaceholder}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setTyped(event.target.value);
              setInvalid(false);
            }}
            onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
              // The panel's roving loop owns the arrow keys; inside a text
              // field they are the caret's, so they stop here.
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.stopPropagation();
                return;
              }
              if (event.key !== "Enter") return;
              event.preventDefault();
              submitTyped();
            }}
            className={cn("h-8 font-mono text-xs", invalid && "border-error")}
          />
          <Button variant="secondary" size="sm" onClick={submitTyped}>
            {labels.addOtherSubmit}
          </Button>
        </div>
        {invalid ? <FieldMessage tone="error">{labels.addOtherInvalid}</FieldMessage> : null}
      </div>
    </ToolbarMenu>
  );
}

/* ------------------------------------------------------------------ */
/* The confirmation                                                    */
/* ------------------------------------------------------------------ */

/** What the dialog says, and whether there is anything to say yes to. */
export interface RemovalConfirmation {
  /** What the delete costs, in the author's words. */
  body: string;
  /** Occurrences the transform refuses to touch, or null when there are none. */
  leftBehind: string | null;
  /** False ⇒ this would change nothing, so the dialog offers no confirm. */
  removable: boolean;
}

/**
 * Describe removing `id` from `content` — the confirmation's whole text.
 *
 * Pure, and exported, because it is the one place a number reaches a person:
 * every branch of it reads the *same* `previewVersionRemoval` result that the
 * confirmed edit will recompute, so the sentence and the edit cannot disagree
 * about what happens.
 *
 * Three outcomes, and they are genuinely different things to be told:
 *
 * - prose goes — say how much;
 * - nothing goes but the buffer still changes — the version has a passage with
 *   nothing written in it yet, which is exactly what the `+` menu makes, and
 *   the empty tag still goes. Quoting "0 characters" over a real edit is the
 *   drift this avoids;
 * - nothing changes at all — the page names the id only where an edit has to
 *   be made by hand (the far end of another version's range, a parser-function
 *   branch) or only inside a quoted example, so there is no delete to confirm
 *   and the dialog says so instead of offering a button that lies.
 *
 * `name` is what the person is shown — the registry's label for this version,
 * which is what its chip says — while `id` is what the transform matches on.
 * They are the same string for every version nobody relabelled; where they
 * differ, a dialog naming `v64` about a chip reading `v64 Patch 1` is a dialog
 * the author has to stop and decode.
 */
export function removalConfirmation(
  content: string,
  id: string,
  labels: EditorVersionBarLabels,
  name: string = id,
): RemovalConfirmation {
  const removal = previewVersionRemoval(content, id);
  const changed = removal.text !== content;

  let body: string;
  if (removal.removedChars > 0) {
    body = formatMessage(labels.removeBody, { id: name, chars: removal.removedChars });
  } else if (changed) {
    body = formatMessage(labels.removeEmpty, { id: name });
  } else {
    body = formatMessage(labels.removeNothing, { id: name });
  }

  return {
    body,
    leftBehind:
      removal.leftBehind > 0
        ? formatMessage(labels.removeLeftBehind, { id: name, count: removal.leftBehind })
        : null,
    removable: changed,
  };
}

/* ------------------------------------------------------------------ */
/* POST /api/versions                                                  */
/* ------------------------------------------------------------------ */

/**
 * The created (201) or already-present (200) row, as much of it as this bar
 * needs. Parsed defensively rather than trusted: it is a network payload, and a
 * row with no id is not one that can go into a registry.
 */
function readRegistered(payload: unknown): VersionRegistryEntry | null {
  if (typeof payload !== "object" || payload === null || !("version" in payload)) return null;
  const row = payload.version;
  if (typeof row !== "object" || row === null || !("id" in row)) return null;
  const { id } = row;
  if (typeof id !== "string" || id.trim() === "") return null;
  const label = "label" in row && typeof row.label === "string" ? row.label : id;
  const ordinal = "ordinal" in row && typeof row.ordinal === "number" ? row.ordinal : undefined;
  return { id, label, ordinal };
}

export function EditorVersionBar({
  content,
  registry,
  selected,
  onSelect,
  onContentChange,
  onAddVersion,
  onRegistered,
  getIdToken,
  disabled = false,
  labels,
}: EditorVersionBarProps): ReactElement | null {
  /** The id whose registration is in flight, so exactly one chip says so. */
  const [registering, setRegistering] = useState<string | null>(null);
  /** The id whose registration was refused; cleared when anything is retried. */
  const [failed, setFailed] = useState<string | null>(null);
  /** The id whose X was clicked — the dialog is open for exactly this one. */
  const [pending, setPending] = useState<string | null>(null);

  const boundaries = useMemo(() => versionsUsed(content), [content]);

  /**
   * Version markup the engine will not read the way it was written.
   *
   * The chips above are drawn from the buffer's *openers*; the article is
   * drawn from pairs. Normally the same answer — and when it is not, the
   * editor and the page disagree with nothing on screen to explain it. That is
   * what one mistyped closer does: `</69>` closes nothing (spec §10.7), so
   * `<v69>` runs on to the next `</v69>` anywhere below and swallows
   * everything between, which then vanishes at every other version and takes
   * any version tag inside it out of the article's boundaries with it
   * (versioning.md §2.6). Both chips still showed here; only the page knew.
   *
   * So the disagreement is named where the chips are, which is where an author
   * looking at the chips will be.
   */
  const problems = useMemo(() => versionMarkupProblems(content), [content]);

  // The model does the §6 work: ordinal sorting, and the rule that matters —
  // marking the branch that *governs* `selected` rather than one whose id
  // equals it.
  const branches = useMemo(
    () => pageVersionBranches({ boundaries, registry, selected }),
    [boundaries, registry, selected],
  );

  /** The chip the dialog is about, so it can be named the way its chip is. */
  const pendingBranch = useMemo(
    () => (pending === null ? null : (branches.find((branch) => branch.id === pending) ?? null)),
    [branches, pending],
  );

  /** What the `+` menu can offer: registry versions this page does not cover. */
  const uncovered = useMemo(
    () => uncoveredVersions(registry, boundaries),
    [registry, boundaries],
  );

  const confirmation = useMemo(
    () =>
      pending === null
        ? null
        : removalConfirmation(content, pending, labels, pendingBranch?.label ?? pending),
    [content, pending, pendingBranch, labels],
  );

  const register = useCallback(
    async (id: string): Promise<void> => {
      // One at a time: two registrations in flight share one `registering` slot
      // and one `failed` slot, so the second would erase the first's state and
      // only one failure could ever be reported between them.
      if (registering !== null) return;
      setFailed(null);
      setRegistering(id);
      try {
        // A null token (signed out) means *no* Authorization header, not an
        // empty one, which would read as a malformed credential. The server
        // then answers 401 — the honest failure for an unauthenticated write.
        const token = await getIdToken();
        const response = await fetch("/api/versions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          },
          body: JSON.stringify({ id }),
        });
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          setFailed(id);
          return;
        }
        // 200 with `created: false` is another editor having registered it a
        // moment ago; either way the id is real now, so the caller's registry
        // gains it and the chip stops saying nobody knows this version.
        onRegistered?.(readRegistered(payload) ?? { id, label: id });
      } catch {
        // A refusal, a 4xx and an outage are one thing to the author: the
        // boundary stays unregistered and the page keeps working. Nothing here
        // may throw into the editor, and `finally` is what guarantees the
        // chip stops saying "registering" whichever way this ended.
        setFailed(id);
      } finally {
        setRegistering(null);
      }
    },
    [getIdToken, onRegistered, registering],
  );

  const applyRemoval = useCallback(() => {
    if (pending === null) return;
    // Recomputed against the buffer the owner is actually holding, not against
    // the `content` prop the confirmation was measured from — see the header.
    onContentChange((current) => removeVersionBranch(current, pending).text);
    setPending(null);
  }, [onContentChange, pending]);

  /**
   * Put the missing `v` back.
   *
   * Through `onContentChange`'s updater like the removal above, so it is
   * applied to the buffer the island is actually holding rather than to the
   * `content` prop this was measured from — the visual surface publishes on a
   * debounce, and a splice computed against a stale copy would revert whatever
   * was typed in between. `repairVersionMarkup` re-checks the offset for the
   * same reason and returns the source untouched if the tag has moved.
   */
  const repair = useCallback(
    (problem: VersionMarkupProblem) => {
      onContentChange((current) => repairVersionMarkup(current, problem));
    },
    [onContentChange],
  );

  const canAdd = onAddVersion !== undefined && !disabled;

  // A page covering no version still needs the way IN — that is what the row
  // is FOR on an editing surface, and leaving it to the INSERT menu is how
  // "I cannot add a version" happened. Only with nothing to show *and* nothing
  // to offer is there no row: the registry is not an offer of its own.
  if (branches.length === 0 && !canAdd) return null;

  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[var(--radius-md)] border border-hairline bg-canvas-soft px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {branches.length === 0 ? (
          <span className="text-[11px] text-mute">{labels.empty}</span>
        ) : (
          <VersionChips
            branches={branches}
            labels={labels.chips}
            className="min-w-0"
            // No `hrefFor`: the editor previews in place, it never navigates.
            //
            // Choosing a version is *reading*, so it stays available to
            // everyone — including the moment before `/api/auth/me` answers,
            // which is most of what a reader ever sees of this row. Only the
            // two actions that write are gated: deleting a version takes prose
            // out of the page, and registering one edits the site registry.
            onSelect={onSelect}
            onRemove={disabled ? undefined : (id) => setPending(id)}
            onRegister={disabled ? undefined : (id) => void register(id)}
            busyId={registering}
          />
        )}
        <AddVersionMenu
          options={uncovered}
          labels={labels}
          onAdd={canAdd ? onAddVersion : undefined}
        />
      </div>

      {failed === null ? null : (
        <FieldMessage tone="error" className="mt-0">
          {formatMessage(labels.registerFailed, { id: failed })}
        </FieldMessage>
      )}

      {problems.map((problem) => (
        <FieldMessage key={`${problem.kind}:${problem.at}`} tone="warning" className="mt-0">
          {problem.kind === "stray-closer"
            ? formatMessage(labels.strayCloser, {
                tag: problem.tag,
                suggestion: problem.suggestion ?? "",
              })
            : formatMessage(labels.unclosedTag, { tag: problem.tag })}
          {/* Only the stray closer is offered a repair: it has exactly one
              reading, while where an unclosed passage was meant to END is a
              guess, and guessing it would file somebody's paragraph under a
              version they never wrote it for. Repairing the closer usually
              settles the unclosed report too, since that is the same typo seen
              from the other side. */}
          {problem.kind === "stray-closer" && problem.suggestion !== undefined && !disabled ? (
            <Button
              variant="secondary"
              size="sm"
              className="ml-2 align-middle"
              onClick={() => repair(problem)}
            >
              {formatMessage(labels.fixCloser, { suggestion: problem.suggestion })}
            </Button>
          ) : null}
        </FieldMessage>
      ))}

      {pending === null || confirmation === null ? null : (
        <Dialog
          open
          onClose={() => setPending(null)}
          title={formatMessage(labels.removeTitle, { id: pendingBranch?.label ?? pending })}
          closeLabel={labels.close}
        >
          <div className="flex flex-col gap-3">
            <p className="text-sm text-body">{confirmation.body}</p>
            {confirmation.leftBehind === null ? null : (
              <p className="text-[13px] text-mute">{confirmation.leftBehind}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setPending(null)}>
                {labels.cancel}
              </Button>
              {/* No confirm button when nothing would change: a Delete that
                  deletes nothing is the lie this dialog exists to prevent. */}
              {confirmation.removable ? (
                <Button variant="danger" size="sm" onClick={applyRemoval}>
                  {labels.removeConfirm}
                </Button>
              ) : null}
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
