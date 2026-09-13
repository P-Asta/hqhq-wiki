/**
 * Seed / migrate the wiki database.
 *
 *   node ./node_modules/tsx/dist/cli.mjs scripts/seed.ts [--reset] [--dry-run]
 *
 * Writes the registries (languages, category display metadata, game versions,
 * site settings) and the seed pages from `src/lib/db/seed-data.ts` through the real
 * store APIs — `createPage` / `saveEdit` — so links, categories, template
 * dependencies, the FTS mirror and the render cache are all built exactly the
 * way an editor's save builds them (db-schema Addendum A4).
 *
 * Idempotent: a page whose head already holds the seed content is left alone
 * (no duplicate rows, no empty revisions), one whose content drifted is
 * updated on top of its current head, and a missing one is created. Running
 * this twice in a row produces the same database.
 *
 * The pages are rendered with the app's own engine configuration
 * (`buildWikiConfig`, src/lib/wiki/config.ts), so the HTML this script caches
 * carries exactly the hrefs the server renders — including O12's prefix-free
 * English article paths and O14.6's bare red links.
 *
 * Order matters: templates → articles → redirects → translations. Articles
 * transclude the templates, and the KO Titan revision records the EN head it
 * was translated from so the freshness badge (queries.outdatedTranslations)
 * reports it as current rather than outdated.
 *
 * Flags:
 *   --reset     delete the database file (plus -wal/-shm) first
 *   --dry-run   report what would change; writes nothing and parses nothing
 *   --db=PATH   override WIKI_DB_PATH for this run
 */

import fs from "node:fs";
import path from "node:path";

import { getWikiEnv } from "@/lib/env";
import { createDb, type WikiDb } from "@/lib/db/client";
import { HOME_CATEGORIES_KEY, getPageSource } from "@/lib/db/queries";
import {
  ARTICLES,
  HELP_PAGES,
  DEFAULT_VERSION,
  HOME_CATEGORIES,
  LANGUAGES,
  NAV_CATEGORIES,
  REDIRECTS,
  SEED_ACTOR,
  SITE_NAME,
  SITE_NAME_KEY,
  TEMPLATES,
  VERSIONS,
} from "@/lib/db/seed-data";
import {
  DEFAULT_VERSION_KEY,
  createLanguage,
  createPage,
  createPageStore,
  flushParsedCache,
  getSetting,
  listNavCategories,
  listVersions,
  loadVersionTable,
  saveEdit,
  seedLanguages,
  seedNavCategories,
  seedVersions,
  setSetting,
} from "@/lib/db/store";
import { NS_ID_BY_STORABLE, normalizeTitle } from "@/lib/title";
import { buildWikiConfig, MEDIA_PATH } from "@/lib/wiki/config";
import { parse } from "@/lib/wikitext/index";
import type { ParseResult, Title } from "@/lib/wikitext/types";

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

interface Options {
  reset: boolean;
  dryRun: boolean;
  dbPath: string;
}

const USAGE = `Usage: seed.ts [--reset] [--dry-run] [--db=PATH]

  --reset     delete the database file (and its -wal/-shm) before seeding
  --dry-run   print the plan; write nothing
  --db=PATH   database file (default: $WIKI_DB_PATH, else ./wiki-data/wiki.db)`;

function parseArgs(argv: string[]): Options {
  const opts: Options = { reset: false, dryRun: false, dbPath: getWikiEnv().dbPath };
  for (const arg of argv) {
    if (arg === "--reset") opts.reset = true;
    else if (arg === "--dry-run" || arg === "--dryRun") opts.dryRun = true;
    else if (arg.startsWith("--db=")) opts.dbPath = arg.slice("--db=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`seed: unknown argument ${arg}\n\n${USAGE}`);
      process.exit(2);
    }
  }
  return opts;
}

/* ------------------------------------------------------------------ */
/* Page upsert                                                         */
/* ------------------------------------------------------------------ */

type Namespace = "main" | "template" | "project";
type Action = "created" | "updated" | "unchanged" | "planned";

interface PageSpec {
  namespace: Namespace;
  slug: string;
  locale: string;
  title: string;
  content: string;
  /** EN basis for a translation (decisions O4); omitted for EN saves. */
  translatedFromRevId?: number | null;
  comment: string;
}

interface UpsertResult {
  action: Action;
  /** Head revision after the upsert; null in --dry-run. */
  revId: number | null;
  warnings: string[];
}

/**
 * The version-agnostic save-time parse (versioning.md §5): `version: null`, a
 * store built fresh for this one render (`createPageStore` memoizes), and the
 * registry snapshot as it stands right now — templates seeded earlier in this
 * run are therefore visible to the articles that transclude them.
 */
function makeParse(db: WikiDb, spec: PageSpec, sink: string[]) {
  return (content: string): ParseResult => {
    const page: Title = {
      namespace: NS_ID_BY_STORABLE[spec.namespace],
      pageName: normalizeTitle(spec.title),
    };
    const result = parse(content, {
      // The app's config, not a copy: same articlePath (O12), same bare red
      // links (O14.6), same messages — the cache this fills is read back by
      // the server, so a divergence here would surface as wrong hrefs.
      config: buildWikiConfig(spec.locale),
      store: createPageStore(db, { mediaPath: MEDIA_PATH }),
      page,
      version: null,
      versions: loadVersionTable(db),
    });
    sink.push(...result.meta.warnings);
    return result;
  };
}

function upsertPage(db: WikiDb, spec: PageSpec, dryRun: boolean): UpsertResult {
  const existing = getPageSource(db, {
    namespace: spec.namespace,
    slug: spec.slug,
    locale: spec.locale,
  });
  const head = existing?.pageLocale?.currentRevId ?? null;

  if (existing !== null && head !== null && existing.revision?.content === spec.content) {
    return { action: "unchanged", revId: head, warnings: [] };
  }
  if (dryRun) {
    return { action: "planned", revId: null, warnings: [] };
  }

  const warnings: string[] = [];
  const parseFor = makeParse(db, spec, warnings);

  if (existing === null) {
    const created = createPage(db, {
      namespace: spec.namespace,
      slug: spec.slug,
      locale: spec.locale,
      title: spec.title,
      content: spec.content,
      comment: spec.comment,
      author: SEED_ACTOR,
      parse: parseFor,
      translatedFromRevId: spec.translatedFromRevId,
    });
    return { action: "created", revId: created.revId, warnings };
  }

  const saved = saveEdit(db, {
    pageId: existing.page.id,
    locale: spec.locale,
    title: spec.title,
    content: spec.content,
    comment: spec.comment,
    // null when this locale has no head yet — i.e. a new translation.
    parentRevId: head,
    author: SEED_ACTOR,
    parse: parseFor,
    translatedFromRevId: spec.translatedFromRevId,
  });
  return { action: head === null ? "created" : "updated", revId: saved.revId, warnings };
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

interface Row {
  namespace: Namespace;
  slug: string;
  locale: string;
  title: string;
  action: Action;
  bytes: number;
}

function printTable(rows: Row[]): void {
  const cells: string[][] = [
    ["namespace", "slug", "loc", "title", "action", "bytes"],
    ...rows.map((r) => [r.namespace, r.slug, r.locale, r.title, r.action, String(r.bytes)]),
  ];
  const widths = cells[0].map((_, i) => Math.max(...cells.map((c) => displayWidth(c[i]))));
  const line = (c: string[]) =>
    c
      .map((v, i) => pad(v, widths[i]))
      .join("  ")
      .trimEnd();
  console.log(line(cells[0]));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const c of cells.slice(1)) console.log(line(c));
}

/** Terminal columns, counting CJK as double width so the columns line up. */
function displayWidth(value: string): number {
  return [...value].reduce((n, ch) => n + (isWide(ch) ? 2 : 1), 0);
}

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - displayWidth(value)));
}

function isWide(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xff60)
  );
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

function removeDbFiles(dbPath: string): string[] {
  const removed: string[] = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = path.resolve(`${dbPath}${suffix}`);
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      removed.push(file);
    }
  }
  return removed;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.reset) {
    if (opts.dryRun) {
      console.log(`[dry-run] would delete ${path.resolve(opts.dbPath)} (+ -wal/-shm)`);
    } else {
      for (const file of removeDbFiles(opts.dbPath)) console.log(`removed ${file}`);
    }
  }

  // A --dry-run against a database that does not exist must not create one.
  const exists = fs.existsSync(path.resolve(opts.dbPath));
  const target = opts.dryRun && (!exists || opts.reset) ? ":memory:" : opts.dbPath;
  // createDb applies the §C pragmas and runs ensureSchema (idempotent DDL).
  const db = createDb(target);

  console.log(`database: ${target === ":memory:" ? ":memory: (dry-run)" : path.resolve(target)}`);
  console.log(opts.dryRun ? "mode: dry-run (no writes, no parsing)\n" : "mode: write\n");

  /* Registries ----------------------------------------------------- */

  if (!opts.dryRun) {
    seedLanguages(db); // guarantees en/active
    for (const lang of LANGUAGES) {
      createLanguage(db, {
        code: lang.code,
        label: lang.label,
        nativeName: lang.nativeName,
        direction: lang.direction,
        status: lang.status,
        createdBy: null,
      });
    }
    seedNavCategories(
      db,
      NAV_CATEGORIES.map((c) => ({
        slug: c.slug,
        sortOrder: c.sortOrder,
        labels: c.labels,
        description: c.description,
      })),
    );
    // Writes the 13 ids and default_version, both ON CONFLICT DO NOTHING.
    seedVersions(db);
    // Never clobber a value an admin has since changed.
    if (getSetting<string>(db, SITE_NAME_KEY) === null) {
      setSetting(db, SITE_NAME_KEY, SITE_NAME, SEED_ACTOR.uid);
    }
    if (getSetting<string>(db, DEFAULT_VERSION_KEY) === null) {
      setSetting(db, DEFAULT_VERSION_KEY, DEFAULT_VERSION, SEED_ACTOR.uid);
    }
    // decisions-v2 O13.3: the curated home-grid order. Also never clobbered —
    // once an admin has arranged the home page, the seed keeps its hands off.
    if (getSetting<string[]>(db, HOME_CATEGORIES_KEY) === null) {
      setSetting(db, HOME_CATEGORIES_KEY, HOME_CATEGORIES, SEED_ACTOR.uid);
    }
  }

  /* Pages ----------------------------------------------------------- */

  const rows: Row[] = [];
  const warnings: { page: string; message: string }[] = [];

  function run(spec: PageSpec): UpsertResult {
    const result = upsertPage(db, spec, opts.dryRun);
    rows.push({
      namespace: spec.namespace,
      slug: spec.slug,
      locale: spec.locale,
      title: spec.title,
      action: result.action,
      bytes: Buffer.byteLength(spec.content, "utf8"),
    });
    for (const message of result.warnings) {
      warnings.push({ page: `${spec.namespace}:${spec.slug} [${spec.locale}]`, message });
    }
    return result;
  }

  for (const tpl of TEMPLATES) {
    run({
      namespace: "template",
      slug: tpl.slug,
      locale: "en",
      title: tpl.title,
      content: tpl.wikitext,
      comment: "Seed: template from seed-content-plan.md §2",
    });
  }

  for (const art of ARTICLES) {
    const en = run({
      namespace: "main",
      slug: art.slug,
      locale: "en",
      title: art.title,
      content: art.wikitext,
      comment: "Seed: article from seed-content-plan.md §3",
    });
    for (const tr of art.translations) {
      run({
        namespace: "main",
        slug: art.slug,
        locale: tr.locale,
        title: tr.title,
        content: tr.wikitext,
        // Records the EN head this translation was made from, so the page
        // reads as current (not outdated) until EN moves on (O4).
        translatedFromRevId: en.revId,
        comment: "Seed: translation from seed-content-plan.md §4",
      });
    }
  }

  for (const help of HELP_PAGES) {
    const en = run({
      namespace: "project",
      slug: help.slug,
      locale: "en",
      title: help.title,
      content: help.wikitext,
      comment: "Seed: help page (versioning.md)",
    });
    for (const tr of help.translations) {
      run({
        namespace: "project",
        slug: help.slug,
        locale: tr.locale,
        title: tr.title,
        content: tr.wikitext,
        translatedFromRevId: en.revId,
        comment: "Seed: help page translation (versioning.md)",
      });
    }
  }

  for (const red of REDIRECTS) {
    run({
      namespace: "main",
      slug: red.slug,
      locale: "en",
      title: red.title,
      content: red.wikitext,
      comment: `Seed: redirect to ${red.target} (decisions O9)`,
    });
  }

  /* Cache ------------------------------------------------------------ */

  // The render cache holds HTML produced by whatever engine + config was
  // current when a page was last saved, and this script leaves untouched
  // pages alone — so a code change (an `articlePath`, a red-link target, a
  // message string) would otherwise stay invisible on every page whose
  // wikitext did not also change. Flushing is the sanctioned invalidation
  // (versioning.md §4); each page re-renders once on its next view.
  if (!opts.dryRun) flushParsedCache(db);

  /* Summary --------------------------------------------------------- */

  printTable(rows);

  const byAction = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.action] = (acc[r.action] ?? 0) + 1;
    return acc;
  }, {});
  const byNamespace = rows.reduce<Record<string, number>>((acc, r) => {
    if (r.locale === "en") acc[r.namespace] = (acc[r.namespace] ?? 0) + 1;
    return acc;
  }, {});

  console.log("");
  console.log(
    `pages: ${Object.entries(byNamespace)
      .map(([ns, n]) => `${ns}=${n}`)
      .join(" ")}  (rows incl. translations: ${rows.length})`,
  );
  console.log(
    `actions: ${Object.entries(byAction)
      .map(([a, n]) => `${a}=${n}`)
      .join(" ")}`,
  );

  if (opts.dryRun) {
    console.log(
      `registries (would seed): languages=${LANGUAGES.length} ` +
        `categories-metadata=${NAV_CATEGORIES.length} versions=${VERSIONS.length} ` +
        `default_version=${DEFAULT_VERSION} sitename="${SITE_NAME}"`,
    );
  } else {
    const table = loadVersionTable(db);
    console.log(
      `registries: languages=${LANGUAGES.length} ` +
        `categories-metadata=${listNavCategories(db).length} ` +
        `versions=${listVersions(db).length} ` +
        `default_version=${table.defaultId} ` +
        `sitename="${getSetting<string>(db, SITE_NAME_KEY) ?? ""}"`,
    );
    console.log("render cache flushed — pages re-render on first view.");
  }

  if (warnings.length) {
    console.error(`\n${warnings.length} parse warning(s) — seed content is not clean:`);
    for (const w of warnings) console.error(`  ${w.page}: ${w.message}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nseed complete — 0 parse warnings.");
}

main();
