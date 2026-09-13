/**
 * Engine wiring: the per-render `ParseContext` the app hands to `parse()`.
 *
 * The configuration half — `WikiConfig`, its messages, `{{SITENAME}}`, the
 * media path and `toEngineTitle` — lives in the universal ./config.ts and is
 * re-exported here, because `scripts/seed.ts` renders (and caches) the seed
 * pages outside the server and cannot import a `server-only` module. This
 * module stays server-only: a `ParseContext` carries a `PageStore`, which
 * opens SQLite.
 *
 * Normative sources:
 * - docs/engine/wikitext-spec.md §14.9 (PageStore), §0.4 (config)
 * - docs/engine/versioning.md §3 (VersionTable, `version: null`)
 *
 * Everything here is synchronous. `buildParseContext` creates ONE PageStore
 * per call because the store memoizes (db/store.ts `createPageStore`).
 */

import "server-only";

import type { WikiDb } from "@/lib/db/client";
import { createPageStore, loadVersionTable, type Db } from "@/lib/db/store";
import type { Locale } from "@/lib/i18n";
import type {
  PageStore,
  ParseContext,
  Title,
  VersionTable,
  WikiConfig,
} from "@/lib/wikitext/types";

import { buildWikiConfig, MEDIA_PATH } from "./config";

export { buildWikiConfig, buildWikiMessages, MEDIA_PATH, SITE_NAME, toEngineTitle } from "./config";

/* ------------------------------------------------------------------ */
/* Parse context (spec §14.9 / versioning.md §3)                       */
/* ------------------------------------------------------------------ */

export interface BuildParseContextInput {
  db: Db | WikiDb;
  /** Rendering locale: picks the messages AND the `articlePath` prefix. */
  locale: Locale;
  /** The page being rendered. */
  page: Title;
  /**
   * Selected game version, or `null` for the version-agnostic render used at
   * save time and for indexing (versioning.md §5).
   */
  version: string | null;
  /** Registry snapshot; loaded from the db when omitted. */
  versions?: VersionTable;
  /** Reuse a store/config across a multi-parse request; built when omitted. */
  store?: PageStore;
  config?: WikiConfig;
  /** `/api/preview` only: version warnings rendered inline (§2.6). */
  preview?: boolean;
  /** Injected clock for `CURRENT*` (tests). */
  now?: Date;
}

/** Assemble the read-only context `parse()` takes. */
export function buildParseContext(input: BuildParseContextInput): ParseContext {
  const ctx: ParseContext = {
    config: input.config ?? buildWikiConfig(input.locale),
    store: input.store ?? createPageStore(input.db, { mediaPath: MEDIA_PATH }),
    page: input.page,
    version: input.version,
    versions: input.versions ?? loadVersionTable(input.db),
  };
  if (input.preview) ctx.preview = true;
  if (input.now) ctx.now = input.now;
  return ctx;
}
