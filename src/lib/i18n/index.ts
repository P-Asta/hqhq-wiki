/**
 * Fresh i18n system — the app's single entry point (`@/lib/i18n`).
 *
 * Usage (server components / route handlers):
 *
 * ```ts
 * const locale = resolveLocale(params.locale); // "en" fallback for unknowns
 * const dict = getDictionary(locale);          // sync, fully typed
 * const line = formatMessage(dict.wiki.lastEditedLine, { time, user });
 * ```
 *
 * Dictionaries are static TS modules bundled with the app: `getDictionary`
 * is synchronous, so server components call it directly and pass strings
 * down as props — there is no client-side dictionary loading. The module is
 * universal (no "server-only"): client components may import `formatMessage`
 * or types, but should receive strings, not whole dictionaries.
 */

import { en } from "./dictionaries/en";
import { ko } from "./dictionaries/ko";
import {
  DEFAULT_LOCALE,
  UI_LOCALES,
  type Dictionary,
  type Locale,
  type UiLocale,
} from "./types";

export { dateTimeFormat, formatMessage, type MessageParams } from "./format";
export { DEFAULT_LOCALE, UI_LOCALES };
export type { Dictionary, Locale, UiLocale };

/** All dictionaries, keyed by UI locale. `en` is authoritative and complete. */
const DICTIONARIES: Record<UiLocale, Dictionary> = { en, ko };

/**
 * Is `value` a UI locale the app ships a dictionary for?
 * Narrowing type guard for raw route params / cookies / headers.
 */
export function isUiLocale(value: string | null | undefined): value is UiLocale {
  return typeof value === "string" && (UI_LOCALES as readonly string[]).includes(value);
}

/**
 * Coerce an arbitrary locale string (route segment, content locale,
 * `Accept-Language` primary tag) to a shipped UI locale. Case-insensitive on
 * the primary subtag (`"ko-KR"` → `"ko"`); anything unknown → `"en"`
 * (decisions O4: EN fallback).
 */
export function resolveLocale(value: string | null | undefined): UiLocale {
  if (!value) return DEFAULT_LOCALE;
  const primary = value.toLowerCase().split("-", 1)[0];
  return isUiLocale(primary) ? primary : DEFAULT_LOCALE;
}

/**
 * The full message catalog for `locale` — synchronous and fully typed.
 * Accepts any locale code (content locales included); anything without a
 * shipped dictionary falls back to English.
 */
export function getDictionary(locale: Locale): Dictionary {
  return DICTIONARIES[resolveLocale(locale)];
}
