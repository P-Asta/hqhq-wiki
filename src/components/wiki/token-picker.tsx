"use client";

/**
 * The "search what exists, offer what doesn't" combobox shared by the editor's
 * tag picker (visual-editor.md §5.2) and its version picker (§5.3).
 *
 * It exists because those two pickers are the same control twice. A tag is a
 * category, and decisions-v2 O13 says a category is nothing but a
 * `[[Category:X]]` in the source — no registry row required — so the tag picker
 * must be able to name one that does not exist yet. A version is the opposite:
 * versioning.md §1 keeps an admin-managed registry, and §6 gives its CRUD to
 * admins — though registering a new id is open to any signed-in editor
 * (/api/versions), so the version picker may also create, but only for a query
 * shaped like a registry id ("v64.1"). One control, two policies — hence `search`,
 * `canCreate` and `onSelect` are all the caller's, and this module knows
 * neither categories nor versions.
 *
 * Trade-offs worth knowing:
 *
 * - Requests are sequence-numbered rather than aborted. `search` is a promise
 *   the caller owns and need not be a `fetch` at all (the version registry is
 *   small enough to filter in memory), so a stale answer is *dropped* on
 *   arrival instead of cancelled at the socket.
 * - Results are stored together with the query they answered. That single fact
 *   drives both the loading state (results that do not answer the current query
 *   mean a search is still owed) and the create row, which is therefore only
 *   offered once the search has actually reported the name free — an author
 *   must never be invited to create a category that already exists.
 * - The active row is an index clamped during render, not corrected in an
 *   effect. Results arrive asynchronously and shrink the list under it, and
 *   deriving is both cheaper and the only shape the lint rules allow.
 */

import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactElement } from "react";

import { CONTROL_CLASSES } from "@/components/ui/input";
import { formatMessage } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** One row of the list: an existing token, or the one being offered for creation. */
export interface TokenOption {
  /** Stable identity: a category slug, a version id. */
  id: string;
  /** What the author reads. */
  label: string;
  /** Muted right-hand detail, e.g. "14 pages" or "current". */
  hint?: string;
}

export interface TokenPickerLabels {
  placeholder: string;
  /** Accessible name of the listbox. */
  listLabel: string;
  /** Nothing matched and nothing can be created. */
  empty: string;
  loading: string;
  /** Create row text; carries a `{name}` placeholder. */
  create: string;
  /** Muted note on the create row, e.g. "new". */
  createHint: string;
}

export interface TokenPickerProps {
  value: string;
  onValueChange: (next: string) => void;
  /** Debounced by the picker; may reject, in which case the list shows empty. */
  search: (query: string) => Promise<TokenOption[]>;
  /** An existing option was chosen, or the create row was (isNew). */
  onSelect: (option: TokenOption, isNew: boolean) => void;
  /** Lets the caller refuse a create row — a version id must look like "v64.1". */
  canCreate?: (query: string) => boolean;
  /**
   * The caller's identity function, when a token is something other than its
   * label: `slugifyTitle` for categories, whose identity is the slug (O13.2).
   * Without it two spellings of one token both look creatable.
   */
  identify?: (value: string) => string;
  /** Ids already chosen, so the list can mark them and not offer them twice. */
  selected?: readonly string[];
  disabled?: boolean;
  id?: string;
  className?: string;
  labels: TokenPickerLabels;
}

/** Long enough to swallow a burst of typing, short enough to feel live. */
const DEBOUNCE_MS = 200;

/** What one search answered, kept with its query so staleness is a comparison. */
interface Results {
  query: string;
  options: TokenOption[];
}

/** A rendered row: an option plus everything the list needs to draw it. */
interface Row {
  option: TokenOption;
  /** The create row — `onSelect` is told, so the caller can register it. */
  isNew: boolean;
  /** Already in `selected`: shown, marked, and not selectable. */
  chosen: boolean;
  domId: string;
  text: string;
  hint: string | undefined;
}

/**
 * Is `query` already among the results? This is the guard on the create row,
 * and therefore the module's promise that an author is never invited to create
 * a token that exists.
 *
 * Labels are compared case-folded, but a label is not an identity. A category
 * *is* its slug (decisions-v2 O13.2) and the search answers with the page title
 * or the humanized slug, so "tier-3-moons" and "Tier 3 moons" are one tag under
 * two spellings — string-equal never, slug-equal always. Callers that know how
 * their tokens are identified pass `identify`; the option's own id is checked
 * first because that is the identity the search itself reported.
 */
export function tokenTaken(
  query: string,
  found: readonly TokenOption[],
  identify?: (value: string) => string,
): boolean {
  const folded = query.trim().toLowerCase();
  const identity = identify === undefined ? "" : identify(query);
  return found.some(
    (option) =>
      option.label.trim().toLowerCase() === folded ||
      (identity !== "" &&
        (option.id === identity || (identify !== undefined && identify(option.label) === identity))),
  );
}

/**
 * The next selectable row from `from`, wrapping. `from` may be -1 (nothing
 * active) or `rows.length`, which is how Home and End reuse this. Returns -1
 * when every row is already chosen, so the caret never parks on a dead row.
 */
function nextSelectable(rows: readonly Row[], from: number, step: number): number {
  const count = rows.length;
  for (let hop = 1; hop <= count; hop += 1) {
    const index = (((from + step * hop) % count) + count) % count;
    const row = rows[index];
    if (row !== undefined && !row.chosen) return index;
  }
  return -1;
}

export function TokenPicker({
  value,
  onValueChange,
  search,
  onSelect,
  canCreate,
  identify,
  selected,
  disabled = false,
  id,
  className,
  labels,
}: TokenPickerProps): ReactElement {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Results | null>(null);
  const [activeRaw, setActiveRaw] = useState(-1);

  // The caller almost certainly passes an inline arrow; depending on it would
  // re-run the search on every render, so the effect reads the latest one
  // through a ref and depends only on the query.
  const searchRef = useRef(search);
  useEffect(() => {
    searchRef.current = search;
  }, [search]);

  // Bumped per request; a resolution whose ticket is no longer current is a
  // straggler and is discarded. Bumping it on unmount retires them all.
  const requestRef = useRef(0);
  useEffect(
    () => () => {
      requestRef.current += 1;
    },
    [],
  );

  const query = value.trim();

  // The empty query is searched too, on mount and whenever the box is cleared:
  // the list opens on focus, and a caller that answers "" with its popular
  // categories or the whole version registry is exactly the browse affordance
  // an author wants before typing anything.
  useEffect(() => {
    if (disabled) return;
    const handle = setTimeout(() => {
      const ticket = requestRef.current + 1;
      requestRef.current = ticket;
      searchRef.current(query).then(
        (options) => {
          if (requestRef.current === ticket) setResults({ query, options });
        },
        () => {
          // A rejected search is indistinguishable from "nothing here" for the
          // author; the spec asks for the empty list rather than an error row.
          if (requestRef.current === ticket) setResults({ query, options: [] });
        },
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query, disabled]);

  /* ---------------------------------------------------------------- */
  /* Rows, derived every render                                        */
  /* ---------------------------------------------------------------- */

  const found = results === null ? [] : results.options;
  // Results that answer some earlier query mean one is still owed: that is the
  // whole loading state, and it covers the debounce window for free.
  const fresh = results !== null && results.query === query;
  const busy = !disabled && !fresh;

  const chosenIds = new Set(selected ?? []);
  const rows: Row[] = found.map((option, index) => ({
    option,
    isNew: false,
    chosen: chosenIds.has(option.id),
    domId: `${listId}-o${index}`,
    text: option.label,
    hint: option.hint,
  }));

  const offerCreate =
    query !== "" &&
    fresh &&
    !tokenTaken(query, found, identify) &&
    (canCreate === undefined || canCreate(query));
  if (offerCreate) {
    rows.push({
      option: { id: query, label: query },
      isNew: true,
      chosen: false,
      domId: `${listId}-create`,
      text: formatMessage(labels.create, { name: query }),
      hint: labels.createHint,
    });
  }

  const activeIndex = activeRaw >= 0 && activeRaw < rows.length ? activeRaw : -1;
  const activeRow = activeIndex >= 0 ? rows[activeIndex] : undefined;
  const activeDomId = activeRow !== undefined && !activeRow.chosen ? activeRow.domId : undefined;

  // Keyboard navigation must be able to walk a list taller than the popover.
  useEffect(() => {
    if (!open || activeDomId === undefined) return;
    document.getElementById(activeDomId)?.scrollIntoView({ block: "nearest" });
  }, [open, activeDomId]);

  /* ---------------------------------------------------------------- */
  /* Interaction                                                       */
  /* ---------------------------------------------------------------- */

  const close = () => {
    setOpen(false);
    setActiveRaw(-1);
  };

  const choose = (row: Row) => {
    if (row.chosen) return;
    close();
    onSelect(row.option, row.isNew);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      // Only ours to eat while the list is open: a closed picker inside a
      // dialog must let Escape through to the dialog.
      if (!open) return;
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Enter") {
      // Swallowed unconditionally — this control lives inside the editor's
      // forms and must never submit one.
      event.preventDefault();
      if (activeRow !== undefined && open) choose(activeRow);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveRaw(nextSelectable(rows, open ? activeIndex : -1, step));
      setOpen(true);
      return;
    }
    if (!open) return;
    if (event.key === "Home") {
      event.preventDefault();
      setActiveRaw(nextSelectable(rows, -1, 1));
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveRaw(nextSelectable(rows, rows.length, -1));
    }
  };

  const listOpen = open && !disabled;

  return (
    <div className={cn("relative", className)}>
      <input
        id={id}
        type="text"
        role="combobox"
        value={value}
        disabled={disabled}
        placeholder={labels.placeholder}
        autoComplete="off"
        aria-expanded={listOpen}
        aria-controls={`${listId}-list`}
        aria-autocomplete="list"
        aria-activedescendant={listOpen ? activeDomId : undefined}
        onChange={(event) => {
          onValueChange(event.target.value);
          setActiveRaw(-1);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        // Pointer-downs inside the list are prevented below, so a blur here is
        // always a real departure: outside click, or Tab away.
        onBlur={close}
        onKeyDown={onKeyDown}
        className={cn(CONTROL_CLASSES, "h-10 px-3")}
      />
      {listOpen ? (
        <div
          onMouseDown={(event) => event.preventDefault()}
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-[var(--radius-md)] border border-hairline bg-surface shadow-[var(--shadow-md)]"
        >
          <ul id={`${listId}-list`} role="listbox" aria-label={labels.listLabel} aria-busy={busy}>
            {rows.map((row, index) => (
              <li
                key={row.domId}
                id={row.domId}
                role="option"
                aria-selected={row.chosen}
                aria-disabled={row.chosen || undefined}
                onClick={() => choose(row)}
                onMouseEnter={() => {
                  if (!row.chosen) setActiveRaw(index);
                }}
                className={cn(
                  "flex items-baseline justify-between gap-3 px-3 py-2 text-sm",
                  row.chosen ? "cursor-default text-faint" : "cursor-pointer text-body",
                  index === activeIndex && !row.chosen && "bg-canvas-soft text-ink",
                  row.isNew && "border-t border-hairline",
                )}
              >
                <span className={cn("truncate", row.isNew ? "text-link" : "font-medium")}>
                  {row.text}
                </span>
                {row.hint === undefined ? null : (
                  <span className="shrink-0 font-mono text-[11px] text-faint">{row.hint}</span>
                )}
              </li>
            ))}
          </ul>
          {/* A status line, not an option: an empty listbox with aria-busy is
              the honest markup, and neither message is ever selectable. */}
          {rows.length === 0 ? (
            <p role="status" className="px-3 py-2 text-sm text-mute">
              {busy ? labels.loading : labels.empty}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
