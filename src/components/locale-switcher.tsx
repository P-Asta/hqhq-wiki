"use client";

/**
 * Locale switcher island. A compact native select over the registered
 * languages; switching re-prefixes the current path for the chosen locale
 * through `localePath` (decisions-v2 O12: English is prefix-free, so picking
 * English strips the prefix and picking Korean adds `/ko`). Query params are
 * intentionally dropped — they may be locale-bound.
 */

import { usePathname, useRouter } from "next/navigation";
import type { ChangeEvent } from "react";

import { Select } from "@/components/ui/select";
import { KNOWN_URL_LOCALES, localePath, parseLocalePath } from "@/lib/locale-path";

export interface LocaleOption {
  code: string;
  /** English label ("Korean") — used for the option title. */
  label: string;
  /** Autonym ("한국어") — what the option shows. */
  nativeName: string;
}

export interface LocaleSwitcherProps {
  current: string;
  options: LocaleOption[];
  /** Accessible name (common.languageLabel). */
  ariaLabel: string;
}

export function LocaleSwitcher({ current, options, ariaLabel }: LocaleSwitcherProps) {
  const router = useRouter();
  const pathname = usePathname();

  const onChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value;
    if (next === current) return;
    // Strip whatever prefix the current URL carries — the shipped UI locales
    // plus every registry code offered in this switcher — then re-apply the
    // chosen one. A locale with no dictionary is not URL-addressable, so its
    // links land in the English tree (O12 rule 2, routes.md).
    const known = [...KNOWN_URL_LOCALES, ...options.map((option) => option.code)];
    const { path } = parseLocalePath(pathname, known);
    router.push(localePath(next, path));
  };

  return (
    <Select
      value={current}
      onChange={onChange}
      aria-label={ariaLabel}
      wrapperClassName="w-auto"
      className="h-8 w-auto min-w-24 bg-canvas pl-2.5 pr-7 text-[13px] text-body"
    >
      {options.map((option) => (
        <option key={option.code} value={option.code} title={option.label}>
          {option.nativeName}
        </option>
      ))}
    </Select>
  );
}
