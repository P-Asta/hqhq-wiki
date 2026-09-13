/**
 * Recompute every stored page's version boundaries against the current engine.
 *
 *   yarn refresh:version-boundaries            # dry run: prints what would change
 *   yarn refresh:version-boundaries --apply    # writes the columns, drops the cache
 *
 * `page_locales.version_scoped` and `page_locales.version_boundaries` are
 * **derived** columns: they are what the save-time parse found, written once by
 * `saveEdit` and read straight back by the article route whenever the render
 * cache answers (src/lib/wiki/service.ts). Derived data written once goes stale
 * the moment the thing deriving it changes — and the article's version selector
 * is drawn from these columns, so a page keeps showing the boundaries of the
 * engine that last saved it until somebody happens to edit it again.
 *
 * That is what this is for. The engine changed on 2026-09-05: a version tag
 * inside a branch the current reading **hides** now has its boundary recorded
 * (docs/engine/versioning.md §2.6, `recordNestedVersionTags` in expand.ts).
 * Before it, one mistyped closer — `</69>` for `</v69>` — swallowed the rest of
 * a page and every version block below it went missing from the selector. The
 * fix lands on new saves by itself; this is how the pages already in the
 * database catch up.
 *
 * How it writes, and why that way:
 *
 * - **The columns, not a revision.** Nothing about the *content* is wrong, so
 *   there is nothing to put in the history: this recomputes a cached answer
 *   about content nobody is touching. That is the opposite of
 *   `migrate-version-tags.ts`, which rewrites wikitext and therefore has to
 *   write a revision somebody can see and revert.
 * - **The same parse the save path uses** — `version: null`, the
 *   version-independent read of `parseForSave` — so a boundary set written here
 *   is byte for byte what the next real save would write. Two ways of computing
 *   one column is how they drift.
 * - **Heads only.** Old revisions keep no boundary columns of their own; the
 *   selector is about the page as it now stands.
 * - **The render cache goes with it.** A cached row is HTML rendered by the old
 *   engine, and leaving it would show the new selector over the old article.
 *   Only pages whose boundaries actually moved are dropped, so a re-run after
 *   nothing changed costs nothing.
 * - **Idempotent, and quiet when there is nothing to do.** Re-running reports
 *   `0 pages` and writes nothing, which is what makes it safe in a deploy step.
 *
 * `--conditions=react-server` in the package.json script is not decoration:
 * `service.ts` is marked `server-only`, and that marker package throws on
 * import unless the resolver is told it is resolving for the server.
 *
 * Flags:
 *   --apply    write the columns and drop the stale cache (default: dry run)
 *   --db=PATH  override WIKI_DB_PATH for this run
 */

import { eq } from "drizzle-orm";

import { createDb, type WikiDb } from "@/lib/db/client";
import { invalidatePageCache, loadVersionTable } from "@/lib/db/store";
import { pageLocales, pages, revisions } from "@/lib/db/schema";
import { getWikiEnv } from "@/lib/env";
import { buildParseContext, toEngineTitle } from "@/lib/wiki/context";
import { parse } from "@/lib/wikitext";
import type { Locale } from "@/lib/i18n";
import type { StorableNamespace } from "@/lib/title";

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

interface Options {
  apply: boolean;
  dbPath: string;
}

const USAGE = `Usage: refresh-version-boundaries.ts [--apply] [--db=PATH]

  --apply    write the recomputed columns and drop the stale render cache
  --db=PATH  database file (default: $WIKI_DB_PATH, else ./wiki-data/wiki.db)`;

function parseArgs(argv: string[]): Options {
  const opts: Options = { apply: false, dbPath: getWikiEnv().dbPath };
  for (const arg of argv) {
    if (arg === "--apply") opts.apply = true;
    else if (arg.startsWith("--db=")) opts.dbPath = arg.slice("--db=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`refresh-version-boundaries: unknown argument ${arg}\n\n${USAGE}`);
      process.exit(2);
    }
  }
  return opts;
}

/* ------------------------------------------------------------------ */
/* The recomputation                                                   */
/* ------------------------------------------------------------------ */

interface Head {
  pageLocaleId: number;
  pageId: number;
  locale: string;
  namespace: string;
  title: string;
  content: string;
  scoped: boolean;
  boundaries: string;
}

/** Every page head, with the columns this is about. */
function heads(db: WikiDb): Head[] {
  return db
    .select({
      pageLocaleId: pageLocales.id,
      pageId: pageLocales.pageId,
      locale: pageLocales.locale,
      namespace: pages.namespace,
      title: pageLocales.title,
      content: revisions.content,
      scoped: pageLocales.versionScoped,
      boundaries: pageLocales.versionBoundaries,
    })
    .from(pageLocales)
    .innerJoin(pages, eq(pages.id, pageLocales.pageId))
    .innerJoin(revisions, eq(revisions.id, pageLocales.currentRevId))
    .all() as Head[];
}

/**
 * Two boundary lists mean the same thing when they hold the same ids.
 *
 * Order is discovery order, which is not part of the answer: the selector sorts
 * by ordinal before it draws anything (`pageVersionBranches`). Comparing the
 * JSON verbatim would report every page whose tags merely moved.
 */
function sameIds(before: string, after: readonly string[]): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(before);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  const was = new Set(parsed.map((id: unknown) => String(id)));
  if (was.size !== new Set(after).size) return false;
  return after.every((id) => was.has(id));
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const db = createDb(opts.dbPath);
  const versions = loadVersionTable(db);
  const rows = heads(db);

  let changed = 0;
  for (const head of rows) {
    const ctx = buildParseContext({
      db,
      locale: head.locale as Locale,
      page: toEngineTitle(head.namespace as StorableNamespace, head.title),
      // The version-independent read, exactly as the save path does it.
      version: null,
      versions,
    });
    const { meta } = parse(head.content, ctx);
    if (meta.versionScoped === head.scoped && sameIds(head.boundaries, meta.versionBoundaries)) {
      continue;
    }
    changed += 1;
    const now = JSON.stringify(meta.versionBoundaries);
    console.log(
      `${head.locale}:${head.title}\n  was ${head.boundaries}${head.scoped ? "" : " (unscoped)"}` +
        `\n  now ${now}${meta.versionScoped ? "" : " (unscoped)"}`,
    );
    if (!opts.apply) continue;

    db.update(pageLocales)
      .set({ versionScoped: meta.versionScoped, versionBoundaries: now })
      .where(eq(pageLocales.id, head.pageLocaleId))
      .run();
    // The cached HTML was rendered by the engine that produced the old answer.
    invalidatePageCache(db, head.pageId, head.locale);
  }

  console.log(
    changed === 0
      ? `refresh-version-boundaries: ${rows.length} pages, nothing to do.`
      : opts.apply
        ? `refresh-version-boundaries: updated ${changed} of ${rows.length} pages.`
        : `refresh-version-boundaries: ${changed} of ${rows.length} pages would change. Re-run with --apply.`,
  );
}

main();
