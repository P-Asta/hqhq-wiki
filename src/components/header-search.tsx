"use client";

/**
 * Header search island. Plain GET form to the locale search route (`/search`
 * in English, `/{locale}/search` elsewhere — decisions-v2 O12) so it works
 * without JS; with JS we intercept and use the client router (no full page
 * load). Empty queries are ignored.
 */

import { useRouter } from "next/navigation";
import type { FormEvent } from "react";

import { searchHref, withQuery } from "@/lib/locale-path";

export interface HeaderSearchProps {
  locale: string;
  /** Accessible name for the input (search.label). */
  label: string;
  placeholder: string;
  /** Text of the (visually hidden) submit button (search.submit). */
  submitLabel: string;
}

export function HeaderSearch({ locale, label, placeholder, submitLabel }: HeaderSearchProps) {
  const router = useRouter();
  const action = searchHref(locale);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = String(new FormData(event.currentTarget).get("q") ?? "").trim();
    if (!query) return;
    router.push(withQuery(action, { q: query }));
  };

  return (
    <form role="search" action={action} method="get" onSubmit={onSubmit} className="relative w-full max-w-sm">
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      >
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5L14 14" />
      </svg>
      <input
        type="search"
        name="q"
        aria-label={label}
        placeholder={placeholder}
        autoComplete="off"
        className="focus-ring h-9 w-full rounded-[var(--radius-md)] border border-hairline bg-canvas pl-9 pr-3 text-sm text-ink outline-none transition-[border-color,box-shadow] placeholder:text-faint focus:border-link focus:ring-2 focus:ring-link/40"
      />
      <button type="submit" className="sr-only">
        {submitLabel}
      </button>
    </form>
  );
}
