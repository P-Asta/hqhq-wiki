"use client";

/**
 * Username autocomplete for the admin console — the picker High Quota HQ's own
 * admin panel has, with the gaps it left closed: arrow-key navigation, an
 * outside-click that actually dismisses, and combobox ARIA.
 *
 * The rows come from GET /api/admin/users (a prefix search over Firestore's
 * `usernameLower`), so what the list shows is exactly what the ban route will
 * resolve. Typing freely is allowed — the picker is an aid, not a gate; the
 * server refuses names that match no single account either way.
 */

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { adminFetch, type GetIdToken } from "@/components/admin/admin-tabs";
import { CONTROL_CLASSES } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Below this the dropdown stays shut — one letter matches half the wiki. */
const MIN_QUERY_CHARS = 2;
/** Long enough to stop typing, short enough not to feel laggy. */
const DEBOUNCE_MS = 250;

export interface UserRow {
  uid: string;
  username: string;
  banned: boolean;
}

export interface UsernamePickerLabels {
  placeholder: string;
  /** Accessible name of the suggestion list. */
  listLabel: string;
  /** Nothing matched the query. */
  empty: string;
  loading: string;
  /** Muted marker on an already-banned row. */
  bannedHint: string;
}

export interface UsernamePickerProps {
  value: string;
  onValueChange: (next: string) => void;
  /** A row was picked — carries the uid, which a typed name never can. */
  onSelect?: (row: UserRow) => void;
  getIdToken: GetIdToken;
  disabled?: boolean;
  id?: string;
  labels: UsernamePickerLabels;
}

export function UsernamePicker({
  value,
  onValueChange,
  onSelect,
  getIdToken,
  disabled,
  id,
  labels,
}: UsernamePickerProps) {
  // Answers are stored WITH the query they answer, so "still loading" is
  // derived (the newest answer is for an older query) rather than tracked as a
  // second piece of state that could disagree with the first.
  const [answer, setAnswer] = useState<{ query: string; users: UserRow[] } | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** Sequence number: a stale answer arriving late is dropped, not rendered. */
  const requestRef = useRef(0);
  const listId = useId();

  const query = value.trim();
  /** Too short to search: no request, no rows — derived, never stored. */
  const idle = disabled || query.length < MIN_QUERY_CHARS;

  useEffect(() => {
    if (idle) {
      // Invalidate any in-flight answer so it cannot land after this.
      requestRef.current += 1;
      return;
    }
    const seq = ++requestRef.current;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const body = await adminFetch<{ users: UserRow[] }>(
            getIdToken,
            `/api/admin/users?q=${encodeURIComponent(query)}`,
          );
          if (seq !== requestRef.current) return;
          setAnswer({ query, users: body.users });
        } catch {
          // A failed lookup shows as "no matches" — the field still works.
          if (seq === requestRef.current) setAnswer({ query, users: [] });
        }
      })();
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, idle, getIdToken]);

  // The reference's own click-outside checks a wrapper class its markup never
  // had, so its dropdown never closed; this one holds the element itself.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const choose = useCallback(
    (row: UserRow) => {
      onValueChange(row.username);
      onSelect?.(row);
      setOpen(false);
      setActive(-1);
    },
    [onValueChange, onSelect],
  );

  const visible = open && !idle;
  const current = answer !== null && answer.query === query;
  const loading = !idle && !current;
  // Keep the previous answer on screen while a new one is in flight, so the
  // list does not blink empty between keystrokes.
  const items = idle ? [] : (answer?.users ?? []);
  // Clamp during render rather than fixing it up in an effect.
  const activeIndex = active >= 0 && active < items.length ? active : -1;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      // Only swallow it while the list is open, so a closed picker inside a
      // form or dialog lets Escape through.
      if (!visible) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key === "Enter") {
      // Never submit the surrounding form from inside the picker.
      if (visible && activeIndex >= 0) {
        event.preventDefault();
        choose(items[activeIndex]);
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (items.length === 0) return;
      event.preventDefault();
      setOpen(true);
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = activeIndex < 0 ? (step > 0 ? 0 : items.length - 1) : activeIndex + step;
      setActive(((next % items.length) + items.length) % items.length);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <input
        id={id}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-expanded={visible}
        aria-controls={visible ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={visible && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        value={value}
        disabled={disabled}
        placeholder={labels.placeholder}
        onChange={(e) => {
          onValueChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        // Tabbing away must not leave the list floating over the next field.
        // The list itself preventDefaults mousedown, so a click still lands.
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className={cn(CONTROL_CLASSES, "h-10 px-3")}
      />
      {visible ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={labels.listLabel}
          aria-busy={loading}
          // Beat the input's blur so a click lands on the row, not past it.
          onMouseDown={(event) => event.preventDefault()}
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-[var(--radius-md)] border border-hairline bg-surface p-1 shadow-[var(--shadow-md)]"
        >
          {items.length === 0 ? (
            <li role="presentation" className="px-2 py-1.5 text-[13px] text-faint">
              <span role="status">{loading ? labels.loading : labels.empty}</span>
            </li>
          ) : (
            items.map((row, index) => (
              <li
                key={row.uid}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                onClick={() => choose(row)}
                onMouseEnter={() => setActive(index)}
                className={cn(
                  "flex cursor-pointer items-center justify-between gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-[13px]",
                  index === activeIndex ? "bg-canvas-soft text-ink" : "text-body",
                )}
              >
                <span className="truncate">{row.username}</span>
                {row.banned ? (
                  <span className="shrink-0 text-[11px] text-error">{labels.bannedHint}</span>
                ) : null}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
