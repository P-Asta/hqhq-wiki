/**
 * Engine configuration — the `WikiConfig` (spec §0.4) and its messages
 * (Addendum A3), in a **universal** module.
 *
 * Why it is not part of src/lib/wiki/context.ts: `context.ts` builds a
 * `ParseContext`, which needs a `PageStore`, which opens better-sqlite3, so it
 * carries `import "server-only"`. `scripts/seed.ts` renders the seed pages
 * outside the Next.js server and cannot import a server-only module, and it
 * caches the HTML it renders — so when it built its own config the two could
 * drift, and they did: the seed wrote red links as `/wiki/$1?redlink=1` while
 * the app rendered them as `/wiki/$1` (decisions-v2 O14.6). Cached HTML wins at
 * read time, so seeded pages showed the wrong red-link target.
 *
 * One definition, imported by both, ends that class of bug.
 *
 * Normative sources:
 * - docs/engine/wikitext-spec.md §0.4 (config), Addendum A3 (messages),
 *   Addendum A5 (articlePath)
 * - docs/engine/decisions.md O1 (`$1` = nsPrefix + slug), O6 (media path)
 * - docs/engine/decisions-v2.md O12 (locale-optional URLs), O14.6 (red links
 *   point at the article URL)
 */

import { formatMessage, getDictionary, type Locale } from "@/lib/i18n";
import { localePath } from "@/lib/locale-path";
import {
  DEFAULT_NAMESPACES,
  NS_ID_BY_STORABLE,
  normalizeTitle,
  type StorableNamespace,
} from "@/lib/title";
import type { Title, WikiConfig, WikiMessages } from "@/lib/wikitext/types";

/** Value of `{{SITENAME}}` and the `Project:` namespace alias (§5.8). */
export const SITE_NAME = "HQHQ Wiki";

/** decisions O6: `PageStore.getFile().src` prefix. */
export const MEDIA_PATH = "/api/media/";

/* ------------------------------------------------------------------ */
/* Messages (spec Addendum A3 — dictionary `wikitext.*`)               */
/* ------------------------------------------------------------------ */

/**
 * Map the locale dictionary's `wikitext.*` section onto the engine's
 * `WikiMessages`. The two parameterized messages are plain strings in the
 * dictionary (`{name}` / `{id}`) and become functions here.
 */
export function buildWikiMessages(locale: Locale): WikiMessages {
  const m = getDictionary(locale).wikitext;
  return {
    tocTitle: m.tocTitle,
    redLinkTitleSuffix: m.redLinkTitleSuffix,
    redirectTo: m.redirectTo,
    citeErrorNoText: (name: string) => formatMessage(m.citeErrorNoText, { name }),
    templateLoop: m.templateLoop,
    templateDepthExceeded: m.templateDepthExceeded,
    unknownVersion: (id: string) => formatMessage(m.unknownVersion, { id }),
  };
}

/* ------------------------------------------------------------------ */
/* Config (spec §0.4 — one instance per rendering locale)              */
/* ------------------------------------------------------------------ */

/**
 * Per-locale engine configuration. `articlePath` follows decisions-v2 O12 —
 * `/wiki/$1` for English (prefix-free) and `/{locale}/wiki/$1` for every other
 * locale — with `$1 = nsPrefix + slug` (decisions O1). The prefix comes from
 * `localePath`, the single owner of the URL scheme, so rendered wikitext links
 * and app chrome can never disagree.
 *
 * `redLinkPath` is the **article path itself** (decisions-v2 O14.6): visiting
 * a page that does not exist *is* the create flow, so a red link needs no
 * `?redlink=1&action=edit` detour. The engine still marks the anchor
 * `class="new red-link"` with the "(page does not exist)" title suffix
 * (wikitext-spec §5.11 / Addendum A3) — only the address changed.
 *
 * Numeric limits are the spec §0.4 defaults.
 */
export function buildWikiConfig(
  locale: Locale,
  messages: WikiMessages = buildWikiMessages(locale),
): WikiConfig {
  const articlePath = localePath(locale, "/wiki/$1");
  return {
    siteName: SITE_NAME,
    articlePath,
    redLinkPath: articlePath,
    externalLinkRel: "nofollow noopener",
    caseSensitive: false,
    maxTemplateDepth: 40,
    maxIncludeSize: 2_097_152,
    maxExpensiveCalls: 100,
    thumbDefaultWidth: 220,
    uprightDefaultFactor: 0.75,
    timezone: "UTC",
    fragmentMode: "html5",
    namespaces: DEFAULT_NAMESPACES,
    messages,
  };
}

/* ------------------------------------------------------------------ */
/* Titles                                                              */
/* ------------------------------------------------------------------ */

/**
 * Storable namespace + display title → the engine `Title` of the page being
 * rendered (drives `{{PAGENAME}}`, `{{FULLPAGENAME}}`, subpage links).
 */
export function toEngineTitle(namespace: StorableNamespace, pageName: string): Title {
  return { namespace: NS_ID_BY_STORABLE[namespace], pageName: normalizeTitle(pageName) };
}
