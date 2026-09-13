"use client";

/**
 * Search input with a debounced suggestion dropdown (routes.md
 * /api/search/suggest). Standalone island on the /search page — the site
 * header keeps its own plain search form.
 *
 * Behavior: no-JS fallback is a plain GET form to the locale search route
 * (`/search` in English, `/{locale}/search` elsewhere — decisions-v2 O12).
 * With JS, keystrokes are debounced (200 ms) into the suggest API; the
 * dropdown is a WAI-ARIA combobox/listbox with ArrowUp/ArrowDown/Enter/
 * Escape handling. Enter with an active option navigates straight to the
 * page; Enter otherwise submits the full search.
 *
 * decisions-v2 O14.5: when the typed title has no exact match among the
 * suggestions, a "Create <query>" entry is appended as the LAST option. It
 * navigates to that title's article URL (`titleToPath`, slugified per O1),
 * because visiting a missing article is the create flow (O14.1).
 */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";

import { formatMessage } from "@/lib/i18n";
import { articleHref, searchHref, titleToPath, withQuery } from "@/lib/locale-path";
import { nsPrefix, parseTitle, type StorableNamespace } from "@/lib/title";

interface Suggestion {
  pageId: number;
  namespace: StorableNamespace;
  slug: string;
  locale: string;
  title: string;
}

export interface SuggestBoxLabels {
  /** Accessible name of the input (search.label). */
  label: string;
  placeholder: string;
  submit: string;
  /** Dropdown heading (search.suggestTitle). */
  suggestTitle: string;
  /** Create entry, with `{query}` (search.createSuggest — O14.5). */
  create: string;
}

/** One row of the dropdown: an existing page, or the O14.5 create action. */
export type SuggestOption =
  | { kind: "page"; key: string; href: string; label: string; hint: string }
  | { kind: "create"; key: string; href: string; label: string; hint: null };

/**
 * O14.5: offer to create the typed title unless a suggestion already IS that
 * title. Page identity is (namespace, slug) per O1, so the comparison runs on
 * the parsed title rather than on the raw string.
 */
export function buildOptions(
  suggestions: Suggestion[],
  query: string,
  locale: string,
  createLabel: string,
): SuggestOption[] {
  const options: SuggestOption[] = suggestions.map((item) => ({
    kind: "page",
    key: `${item.pageId}:${item.locale}`,
    href: articleHref(locale, item.namespace, item.slug),
    label: item.title,
    hint: `${nsPrefix(item.namespace)}${item.slug}`,
  }));

  const trimmed = query.trim();
  const parsed = trimmed === "" ? null : parseTitle(trimmed);
  const createHref = parsed === null ? null : titleToPath(parsed, locale);
  if (parsed === null || createHref === null) return options;

  const exact = suggestions.some(
    (item) => item.namespace === parsed.nsName && item.slug === parsed.slug,
  );
  if (exact) return options;

  options.push({
    kind: "create",
    key: "create",
    href: createHref,
    label: formatMessage(createLabel, { query: trimmed }),
    hint: null,
  });
  return options;
}

export interface SuggestBoxProps {
  locale: string;
  labels: SuggestBoxLabels;
  initialQuery?: string;
  /** Extra classes on the form wrapper. */
  className?: string;
}

const DEBOUNCE_MS = 200;

export function SuggestBox({ locale, labels, initialQuery = "", className }: SuggestBoxProps) {
  const router = useRouter();
  const listboxId = useId();
  const [query, setQuery] = useState(initialQuery);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const searchAction = searchHref(locale);
  const options = buildOptions(suggestions, query, locale, labels.create);

  const fetchSuggestions = useCallback(
    (value: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const url = `/api/search/suggest?q=${encodeURIComponent(value)}&locale=${encodeURIComponent(locale)}`;
      fetch(url, { signal: controller.signal })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
        .then((body: { suggestions?: Suggestion[] }) => {
          // Open even with zero hits: the create entry may be the only option,
          // and an unmatched query is exactly when it matters (O14.5).
          setSuggestions(body.suggestions ?? []);
          setOpen(true);
          setActiveIndex(-1);
        })
        .catch(() => {
          // Aborted or failed — keep the box usable, just drop suggestions.
        });
    },
    [locale],
  );

  const onChange = (value: string) => {
    setQuery(value);
    if (timerRef.current) clearTimeout(timerRef.current);
    const trimmed = value.trim();
    if (!trimmed) {
      setSuggestions([]);
      setOpen(false);
      setActiveIndex(-1);
      return;
    }
    timerRef.current = setTimeout(() => fetchSuggestions(trimmed), DEBOUNCE_MS);
  };

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    },
    [],
  );

  const close = () => {
    setOpen(false);
    setActiveIndex(-1);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const active = open && activeIndex >= 0 ? options[activeIndex] : undefined;
    if (active) {
      close();
      router.push(active.href);
      return;
    }
    const trimmed = query.trim();
    if (!trimmed) return;
    close();
    router.push(withQuery(searchAction, { q: trimmed }));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      close();
      return;
    }
    if (!open || options.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % options.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index <= 0 ? options.length - 1 : index - 1));
    }
  };

  return (
    <form
      role="search"
      action={searchAction}
      method="get"
      onSubmit={onSubmit}
      className={className}
    >
      <div className="relative">
        <input
          type="search"
          name="q"
          value={query}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={close}
          onFocus={() => {
            if (options.length > 0 && query.trim()) setOpen(true);
          }}
          role="combobox"
          aria-label={labels.label}
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
          placeholder={labels.placeholder}
          autoComplete="off"
          className="focus-ring h-11 w-full rounded-[var(--radius-md)] border border-hairline bg-canvas px-4 text-[15px] text-ink outline-none transition-[border-color,box-shadow] placeholder:text-faint focus:border-link focus:ring-2 focus:ring-link/40"
        />
        {open && options.length > 0 ? (
          <div className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-[var(--radius-md)] border border-hairline bg-surface shadow-md">
            <p className="border-b border-hairline px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-mute">
              {labels.suggestTitle}
            </p>
            <ul id={listboxId} role="listbox" aria-label={labels.suggestTitle}>
              {options.map((option, index) => (
                <li
                  key={option.key}
                  id={`${listboxId}-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  // mousedown fires before the input's blur closes the box.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    close();
                    router.push(option.href);
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={`flex cursor-pointer items-baseline justify-between gap-3 px-3 py-2 text-sm ${
                    index === activeIndex ? "bg-canvas-soft text-ink" : "text-body"
                  } ${option.kind === "create" ? "border-t border-hairline" : ""}`}
                >
                  <span
                    className={`truncate font-medium ${
                      option.kind === "create" ? "text-link" : ""
                    }`}
                  >
                    {option.label}
                  </span>
                  {option.hint === null ? null : (
                    <span className="shrink-0 font-mono text-[11px] text-faint">{option.hint}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <button type="submit" className="sr-only">
        {labels.submit}
      </button>
    </form>
  );
}
