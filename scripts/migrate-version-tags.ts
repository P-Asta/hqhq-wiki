/**
 * Move stored pages off the retired version grammar.
 *
 *   yarn migrate:version-tags            # dry run: prints a diff, writes nothing
 *   yarn migrate:version-tags --apply    # saves each conversion as a new revision
 *
 * `<versions>`, `<variant>` and `<version>` stopped being recognised when the
 * version id became the tag name (docs/engine/versioning.md §2.1). They do not
 * fail loudly — §10.7 escapes an unknown tag — so every stored page still
 * written the old way is showing its own markup to readers as literal text.
 * This script is how the database catches up with the seed.
 *
 * The transform itself is `convertLegacyVersionMarkup`
 * (src/lib/visual-editor/version-tags.ts), the same function the seed content
 * was converted with and the same one its tests pin to §2.2's mapping table.
 * Nothing about the rewrite is decided here; this file decides only *which
 * pages*, and how the result is written.
 *
 * How it writes, and why that way:
 *
 * - **A revision, never an UPDATE.** Each converted page goes through
 *   `saveEditWithParse` (src/lib/wiki/service.ts) — the path the editor's Save
 *   button takes — so the change lands in the page's history with a comment and
 *   an author, is visible in recent changes, and can be reverted by anyone with
 *   the rollback button. A migration that edited `revisions.content` in place
 *   would be a change nobody could see and nobody could undo.
 * - **Attributed to a maintenance account** (`MIGRATION_ACTOR`), upserted into
 *   `users` before the first save so the revision's author FK resolves exactly
 *   as an editor's would — and so the history says plainly that a script, not
 *   a person, made the change.
 * - **Heads only.** History is immutable and stays exactly as it was written;
 *   an old revision rendering its markup escaped is what an old revision of a
 *   page written in a retired grammar looks like.
 * - **Idempotent.** A page already in the new grammar converts to itself, so
 *   the second run reports nothing and saves nothing.
 *
 * What it deliberately does not convert, and reports instead:
 *
 * - Old-grammar tags inside `<pre>` / `<nowiki>` / `<syntaxhighlight>` /
 *   comments. On the Version scoping help page those blocks are *documentation*
 *   — prose about the grammar, not markup — and re-running `yarn seed` is what
 *   updates that page's teaching, not this.
 * - Anything the converter refuses (prose parked between two variants, an
 *   `only=` crossed with a `since=`, an id nothing can order). Those are printed
 *   with their reason and left byte for byte, because a person has to decide
 *   what they meant.
 *
 * `--conditions=react-server` in the package.json script is not decoration:
 * `service.ts` is marked `server-only`, and that marker package throws on
 * import unless the resolver is told it is resolving for the server — which is
 * precisely what this is doing.
 *
 * Flags:
 *   --apply      write the conversions (default: dry run)
 *   --context=N  diff context lines (default 3)
 *   --db=PATH    override WIKI_DB_PATH for this run
 */

import fs from "node:fs";
import path from "node:path";

import { eq } from "drizzle-orm";

import { createDb, type WikiDb } from "@/lib/db/client";
import { pageLocales, pages, revisions } from "@/lib/db/schema";
import { listVersions, upsertUser } from "@/lib/db/store";
import { getWikiEnv } from "@/lib/env";
import { diffLines } from "@/lib/diff";
import type { VersionRegistryEntry } from "@/lib/version-branches";
import {
  convertLegacyVersionMarkup,
  type LegacySkip,
  type LegacySkipReason,
} from "@/lib/visual-editor/version-tags";
import { saveEditWithParse } from "@/lib/wiki/service";

/** Author of every revision this script writes; upserted before the first save. */
const MIGRATION_ACTOR = { uid: "migration", displayName: "Migration script" } as const;

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

interface Options {
  apply: boolean;
  context: number;
  dbPath: string;
}

const USAGE = `Usage: migrate-version-tags.ts [--apply] [--context=N] [--db=PATH]

  --apply      save each conversion as a new revision (default: dry run)
  --context=N  lines of context around each diff hunk (default 3)
  --db=PATH    database file (default: $WIKI_DB_PATH, else ./wiki-data/wiki.db)`;

function parseArgs(argv: string[]): Options {
  const opts: Options = { apply: false, context: 3, dbPath: getWikiEnv().dbPath };
  for (const arg of argv) {
    if (arg === "--apply") opts.apply = true;
    else if (arg.startsWith("--context=")) {
      const n = Number(arg.slice("--context=".length));
      if (!Number.isInteger(n) || n < 0) {
        console.error(`migrate-version-tags: --context needs a whole number\n\n${USAGE}`);
        process.exit(2);
      }
      opts.context = n;
    } else if (arg.startsWith("--db=")) opts.dbPath = arg.slice("--db=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`migrate-version-tags: unknown argument ${arg}\n\n${USAGE}`);
      process.exit(2);
    }
  }
  return opts;
}

/* ------------------------------------------------------------------ */
/* Unified diff                                                        */
/* ------------------------------------------------------------------ */

interface UnifiedLine {
  readonly prefix: " " | "-" | "+";
  readonly text: string;
}

/**
 * The app's own line diff (src/lib/diff.ts), flattened to `-`/`+` lines.
 *
 * `diffLines` pairs a removed run with the added run beside it into `changed`
 * rows, because the article view shows them side by side. A unified diff has
 * one column, so each block is re-grouped the way `diff -u` prints it: every
 * removal, then every addition. Interleaving them reads as though four lines
 * became one and then three more vanished.
 */
function unifiedLines(before: string, after: string): UnifiedLine[] {
  const out: UnifiedLine[] = [];
  let removed: string[] = [];
  let added: string[] = [];

  const flush = (): void => {
    for (const text of removed) out.push({ prefix: "-", text });
    for (const text of added) out.push({ prefix: "+", text });
    removed = [];
    added = [];
  };

  for (const row of diffLines(before, after)) {
    const left = row.left === null ? null : row.left.segments.map((s) => s.text).join("");
    const right = row.right === null ? null : row.right.segments.map((s) => s.text).join("");
    if (row.kind === "context") {
      flush();
      out.push({ prefix: " ", text: left ?? "" });
      continue;
    }
    if (left !== null) removed.push(left);
    if (right !== null) added.push(right);
  }
  flush();
  return out;
}

/**
 * `@@ -a,b +c,d @@` hunks with `context` lines around each change. Lines are
 * printed in full, however long they are: a conversion nobody can read in the
 * dry run is a conversion nobody can approve.
 */
function unifiedDiff(before: string, after: string, context: number): string[] {
  const lines = unifiedLines(before, after);
  const changed = lines.map((line) => line.prefix !== " ");

  // Where each line sits on each side, before it is consumed.
  let leftNo = 0;
  let rightNo = 0;
  const starts = lines.map((line) => {
    const at = { left: leftNo + 1, right: rightNo + 1 };
    if (line.prefix !== "+") leftNo += 1;
    if (line.prefix !== "-") rightNo += 1;
    return at;
  });

  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!changed[i]) {
      i += 1;
      continue;
    }
    const from = Math.max(0, i - context);
    // Two changes closer than 2×context share a hunk; further apart they get
    // their own, which is what keeps a long page's report readable.
    let last = i;
    let j = i;
    while (j < lines.length) {
      if (changed[j]) {
        last = j;
        j += 1;
        continue;
      }
      let k = j;
      while (k < lines.length && !changed[k] && k - j < context * 2) k += 1;
      if (k < lines.length && changed[k]) {
        j = k;
        continue;
      }
      break;
    }
    const to = Math.min(lines.length - 1, last + context);
    const hunk = lines.slice(from, to + 1);
    const leftCount = hunk.filter((line) => line.prefix !== "+").length;
    const rightCount = hunk.filter((line) => line.prefix !== "-").length;
    out.push(`@@ -${starts[from].left},${leftCount} +${starts[from].right},${rightCount} @@`);
    for (const line of hunk) out.push(line.prefix + line.text);
    i = to + 1;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The pages                                                           */
/* ------------------------------------------------------------------ */

/** Every (page, locale) head — the only revisions a migration may rewrite. */
function loadHeads(db: WikiDb) {
  return db
    .select({
      pageId: pages.id,
      namespace: pages.namespace,
      slug: pages.slug,
      locale: pageLocales.locale,
      title: pageLocales.title,
      revId: revisions.id,
      content: revisions.content,
      translatedFromRevId: revisions.translatedFromRevId,
    })
    .from(pageLocales)
    .innerJoin(pages, eq(pages.id, pageLocales.pageId))
    .innerJoin(revisions, eq(revisions.id, pageLocales.currentRevId))
    .orderBy(pages.namespace, pages.slug, pageLocales.locale)
    .all();
}

function registryOf(db: WikiDb): VersionRegistryEntry[] {
  return listVersions(db).map((row) => ({ id: row.id, label: row.label, ordinal: row.ordinal }));
}

/** One line per refusal, in the terms the converter reports them. */
const REASON: Record<LegacySkipReason, string> = {
  unclosed: "the construct never closes — the engine ran it to the end of the page",
  "stray-content": "prose sits between the variants, which the old group never rendered",
  "no-branches": "the group holds no variants",
  attributes: "an attribute combination the new grammar cannot spell",
  "malformed-id": "an id nothing can order",
  "duplicate-id": "two branches name one version",
  "too-deep": "constructs nested past the depth guard",
  unreadable: "the scan could not read this page; nothing was changed",
};

function describe(skip: LegacySkip): string {
  return `    left alone at offset ${skip.at}: ${skip.tag || "(whole page)"} — ${REASON[skip.reason]}`;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const dbFile = path.resolve(opts.dbPath);

  if (!fs.existsSync(dbFile)) {
    // Never create one: a mistyped --db must not look like an empty wiki.
    console.error(`migrate-version-tags: no database at ${dbFile}`);
    process.exit(1);
  }

  const db = createDb(opts.dbPath);
  const registry = registryOf(db);
  const heads = loadHeads(db);

  console.log(`database: ${dbFile}`);
  console.log(
    opts.apply
      ? "mode: apply (each conversion is saved as a new revision)\n"
      : "mode: dry run (nothing is written) — pass --apply to save these conversions\n",
  );
  console.log(
    `registry: ${registry.length} versions` +
      (registry.length ? ` (${registry[0].id} … ${registry[registry.length - 1].id})` : ""),
  );
  console.log(`heads: ${heads.length} page/locale rows\n`);

  const actor = MIGRATION_ACTOR;
  upsertUser(db, actor);
  const comment =
    "Migration: version markup converted to the tag-name grammar (versioning.md §2.1)";

  let converted = 0;
  let constructs = 0;
  let refused = 0;
  let quotedPages = 0;
  let quotedTags = 0;
  let failed = 0;

  for (const head of heads) {
    const result = convertLegacyVersionMarkup(head.content, registry);
    const where = `${head.namespace}:${head.slug} [${head.locale}]`;

    if (result.quoted > 0) {
      quotedPages += 1;
      quotedTags += result.quoted;
    }
    if (result.changed === 0 && result.skipped.length === 0) continue;

    console.log(
      `── ${where} — ${head.title} (rev ${head.revId})` +
        `  ${result.changed} construct${result.changed === 1 ? "" : "s"}`,
    );

    for (const skip of result.skipped) {
      refused += 1;
      console.log(describe(skip));
    }

    if (result.changed === 0) {
      console.log("    nothing converted; the page is unchanged\n");
      continue;
    }

    converted += 1;
    constructs += result.changed;
    for (const line of unifiedDiff(head.content, result.text, opts.context)) {
      console.log(`  ${line}`);
    }

    if (opts.apply) {
      try {
        const saved = saveEditWithParse({
          db,
          pageId: head.pageId,
          namespace: head.namespace,
          locale: head.locale,
          title: head.title,
          content: result.text,
          comment,
          // The head this conversion was computed from: if anything else saved
          // the page while this ran, the write is refused rather than silently
          // overwriting it.
          parentRevId: head.revId,
          // Carried through unchanged — converting the markup says nothing
          // about whether a translation is still current (decisions O4).
          translatedFromRevId: head.translatedFromRevId,
          author: actor,
        });
        console.log(`    saved as rev ${saved.revId}\n`);
      } catch (err) {
        failed += 1;
        console.error(`    FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    } else {
      console.log("");
    }
  }

  /* Summary --------------------------------------------------------- */

  console.log("");
  console.log(
    opts.apply
      ? `converted ${converted} page/locale head(s), ${constructs} construct(s)`
      : `would convert ${converted} page/locale head(s), ${constructs} construct(s)`,
  );
  if (refused > 0) {
    console.log(`left alone for a person to read: ${refused} construct(s) — see above`);
  }
  if (quotedTags > 0) {
    console.log(
      `documentation untouched: ${quotedTags} old-grammar tag(s) inside <pre>/<nowiki>/comments ` +
        `on ${quotedPages} page(s). Those are prose about the grammar; the seeded help page's ` +
        `teaching is updated by \`yarn seed\`, not by this.`,
    );
  }
  if (converted === 0 && refused === 0) {
    console.log("nothing to do — every head is already in the tag-name grammar.");
  } else if (!opts.apply) {
    console.log("\nnothing was written. Re-run with --apply to save these as new revisions.");
  }
  if (failed > 0) {
    console.error(`\n${failed} page(s) failed to save.`);
    process.exitCode = 1;
  }
}

main();
