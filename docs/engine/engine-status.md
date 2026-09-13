# Engine status — wikitext engine + DB layer, end of the ENGINE phase

Date: 2026-08-31. Written by the integrator after wiring `parse()` and landing the
conformance / versioning / seed-fixture suites. Normative sources: `wikitext-spec.md`
(incl. its Addendum), `decisions.md` (O1–O10), `versioning.md`, `db-schema.md`,
`routes.md`, `seed-content-plan.md`.

State: **`src/lib/wikitext/**`, `src/lib/db/**` and `src/lib/title.ts` are complete and
green.** 750 tests pass, `tsc --noEmit` reports nothing in those trees, and
`eslint src/lib/wikitext src/lib/db --max-warnings 0` is clean.

---

## 1. Module inventory

### `src/lib/wikitext/` — the engine

| Module | Stage / role | Spec |
|---|---|---|
| `index.ts` | **Pipeline entry point.** `parse()`, the `EngineStages` contract, the `stages` bundle, `ParseContextError`, `StripTable`/`ExpandResult`/`RenderResult` | §14 |
| `types.ts` | Every shared type: `Title`, `WikiConfig`, `PageStore`, `ParseContext`, `PageMeta`, the AST, `ParseResult`, `ExpandApi`/`ExpandHooks` | §0.4, §14.9–14.10 |
| `normalize.ts` | Stage 0 — CRLF→LF, BOM, U+0000/U+007F removal, trailing newline | §14.1 |
| `preprocessor.ts` | Stage 1 — PPNode tree, ext-tag capture, comments (line-eating), `noinclude`/`includeonly`/`onlyinclude`, `parseRedirect` | §14.2, §8.6, §10.8 |
| `expand.ts` | Stage 2 — frames, templates, `{{{params}}}`, ext tags → strip markers, T2529 auto-newline, limits; owns the `PageMeta` | §14.3, §8 |
| `parser-functions.ts` | `{{#if}}`…`{{#titleparts}}`, string/ns functions, `DISPLAYTITLE`, `#ifversion`/`#vswitch` | §9, §13.1 |
| `magic-words.ts` | `{{PAGENAME}}`, `CURRENT*`, `{{VERSION}}`… | §9.5, versioning §2.5 |
| `expr.ts` | `#expr`/`#ifexpr` evaluator + MW-identical error strings | §9.3 |
| `versions.ts` | **final, do not edit** — range grammar, variant windowing, boundary recording | versioning §2–§3 |
| `sanitize.ts` | Stage 3 — tag allowlist, attribute/style filtering, entities, escaping helpers | §14.4, §11 |
| `blocks.ts` | Stage 4 — redirect, `__WORD__`, tables, headings, `----`, lists, pre/paragraphs, A1/D-14 | §14.5, §2–§4, §7 |
| `tables.ts` | `{\|…\|}` scanner (recursive, fostering) — called by `blocks.ts` | §7 |
| `lists.ts` | `*#;:` prefix machine — called by `blocks.ts` | §4 |
| `inline.ts` | Stage 5 — HTML tokens, links, apostrophes, external links, entities | §14.6, §1, §11.2 |
| `links.ts` | `[[…]]`/`[[File:…]]` scanning, hrefs, title attributes, pipe trick, subpages | §5 |
| `external-links.ts` | Protocols, trailing punctuation, autonumbering | §6 |
| `render.ts` | Stage 6 — AST→HTML, refs, TOC splice, id dedupe, strip-marker restore | §14.7 |
| `refs.ts` | `RefRegistry` — numbering, backlinks, `<references/>`, auto-append | §10.3 |
| `toc.ts` | Outline build, id allocation/encoding, TOC HTML | §2.4–2.5 |

### `src/lib/db/` — storage

`client.ts` (`createDb`), `schema.ts` + `ddl.ts` (drizzle schema and raw DDL/FTS/triggers),
`store.ts` (writes: `saveEdit`, `createPage`, `rollback`, version registry, admin grants,
`createPageStore`, the `WikiStoreError` hierarchy), `queries.ts` (reads: page views,
history, search, `whatLinksHere`, `wantedPages`, `versionCoverage`, …).

`src/lib/title.ts` — decisions O1: `normalizeTitle`, `slugifyTitle`, `parseTitle`,
`nsPrefix`/`pathToTitle`, `canonicalFilename`, `DEFAULT_NAMESPACES`. The locale-scoped
hrefs (`titleToPath`, `articleHref`, …) live in `src/lib/locale-path.ts` per decisions-v2 O12.

---

## 2. Test counts

`node ./node_modules/vitest/vitest.mjs run src/lib` → **23 files, 750 tests, 0 failures.**

| Suite | Tests | Scope |
|---|---|---|
| `wikitext/conformance.test.ts` | 74 | **the whole §15 corpus, C-01…C-74**, one `it()` per case |
| `wikitext/seed-fixtures.test.ts` | 26 | the 12 `<!-- fixture:… -->` blocks of `seed-content-plan.md` |
| `wikitext/versions.integration.test.ts` | 18 | versioning.md §7 "Integration" |
| `wikitext/pipeline.test.ts` | 19 | stage 0, the `parse()`/`PageMeta` contract, determinism |
| `wikitext/blocks.test.ts` | 79 | stage 4 |
| `wikitext/inline.test.ts` | 73 | stage 5 |
| `wikitext/parser-functions.test.ts` | 67 | §9 |
| `wikitext/expand.test.ts` | 44 | stage 2 |
| `wikitext/versions.test.ts` | 34 | versions.ts unit (unchanged) |
| `wikitext/sanitize.test.ts` | 35 | §11 |
| `wikitext/preprocessor.test.ts` | 33 | stage 1 |
| `wikitext/render.test.ts` | 30 | stage 6 |
| `wikitext/expr.test.ts` | 30 | §9.3 |
| `wikitext/links.test.ts` · `magic-words` · `toc` · `external-links` | 21 · 19 · 17 · 10 | §5 · §9.5 · §2.5 · §6 |
| `db/store.test.ts` · `db/queries.test.ts` · `db/schema.test.ts` | 48 · 26 · 2 | db-schema §D |
| `title.test.ts` · `auth/server` · `firebase/user-auth` | 36 · 6 · 3 | O1 · salvaged |

### Corpus pass state

**74 / 74 cases implemented and passing.** Two carry an extra assertion because §15's
written expectation contradicts a normative section (details in §4 below): **C-46** and
**C-73**. Every Appendix A divergence is encoded as the expectation, never worked around —
D-1 (C-04/05), D-5 (C-20), D-7 (C-34), D-8 (C-53), D-11 (C-58 neighbours), D-13 (C-64/65),
D-14 (seed + versioning suites).

Seed fixtures: all four documents (Titan EN, Jester EN, Quota EN, Titan KO) parse with
**zero warnings**, non-empty HTML, the infobox `<table>` present, the documented categories
(including the ones `{{Stub}}`/`{{Verify}}` inject from inside templates), the documented
red links marked, refs numbered through `{{Reflist}}`, and **no `<p><br` anywhere inside a
`<table>`** — the D-14 regression the plan's addendum calls for.

---

## 3. Module fixes made while integrating

The stage modules were individually green but had never met each other. Seven seams needed
work; all are in engine files I own.

1. **`normalize.ts` created** — stage 0 existed only in the spec; the pipeline needs it, and
   removing U+007F is what makes strip markers unforgeable.
2. **`expand.ts`: parser-generated HTML now travels behind a strip marker.** §11 forbids raw
   `<a>`, so the §8.2-rule-6 red link and the §8.5 loop/depth error spans were being
   entity-escaped by stage 3 and shown as literal `&lt;a href=…&gt;`. They are now
   `addHtmlStrip(...)` payloads restored verbatim at stage 6 (§14.8 is exactly this
   mechanism). Consequence: a template name containing a strip marker can never resolve, so
   §8.2 rule 7 now also triggers on a marker in the name.
3. **`render.ts`: `html-block` is non-wrapping.** `blocks.ts` documents it as a transparent
   container whose raw tag already lives in the inline children; `render.ts` was also
   synthesizing the element, so C-67 produced `<div><div …>hi</div></div>`.
4. **`render.ts`: an empty paragraph emits nothing.** A lone `[[Category:…]]` line left a
   `<p></p>` (C-32 requires "no output line").
5. **`render.ts`: ref bodies and gallery captions now run stages 3→5→6.** The fallback only
   sanitized, so a `<ref>` containing `[https://… label]` or `[[Link]]` rendered as plain
   text. They now share the caller's `RenderState`, keeping ref numbering, id allocation and
   strip restoration page-wide.
6. **`blocks.ts`: block-level strip markers split a paragraph** (§10.2 "always block-level").
   `<pre>`, block `<syntaxhighlight>`, `<references>` and `<gallery>` reach stage 4 as
   markers; they were being wrapped in `<p>` (C-62, C-69).
7. **`blocks.ts`: a raw HTML run inside a p-rejecting element is ONE inline region.** §11.2
   balances "per block scope", and for `<table>`/`<tr>`/`<ul>`/`<ol>`/`<dl>` that scope spans
   until the element closes. Per-line regions auto-closed the seed infobox's `<table>` after
   its opening line, producing `<table class="infobox"></table><tr>…`. Two `blocks.test.ts`
   expectations moved with it (the run now keeps its `\n` separators, and a stray text line
   inside an open `<table>` stays bare instead of becoming a `<p>` — which is precisely the
   invalid markup Addendum A1 exists to prevent).
8. **`sanitize.ts`: §11.4's control-character check exempts CSS whitespace**, exactly as
   MediaWiki's `Sanitizer::checkCss` does. §8.7's auto-newline fires on a `{{#switch:}}` whose
   winning branch starts with `#`, so the seed infobox's
   `style="color:{{#switch:…|S=#b3261e|…}};"` legitimately contains an LF and was being
   rejected as `/* insecure input */`.

### Additive type changes

- `PageMeta.ifexistTargets: TitleKey[]` — the titles `{{#ifexist:}}` probed, in call order
  (a subset of `linksTo`, kept apart so the cache layer can tell a probe from a real link).
  `expand.ts` aliases its legacy `pfState.ifexistTargets` onto the same array.
- `ParseResult.toc` and `ParseResult.refs` — the same array as `meta.toc`, and the per-group
  ref counts from stage 6.

---

## 4. Deviations, with justification

| # | Where | Deviation | Why |
|---|---|---|---|
| **V-1** | §15 C-46 | The bare corpus input `{{1x\| a }}` renders `<pre>a \n</pre>`, not `<p> a </p>`. | The retained LEADING space lands at line start, so §3.3 makes it a space-pre (the same MediaWiki gotcha). The case's subject — that a positional argument is not trimmed — is asserted inline as well: `x{{1x\| a }}y` → `<p>x a y</p>`. |
| **V-2** | §15 C-73 | The bare corpus input `{{1x\|== H ==}}` renders `<p>{{{1}}}</p>`, not `<h2 id="H">H</h2>`. | §8.3 splits an argument at its **first top-level `=` even when the name is empty** — as MediaWiki's preprocessor does (`$search .= '='` only while `eqpos === null`). §15's expectation is unreachable under §8.3, which is the normative rule. The case's subject — headings recognized after expansion — is asserted with the index made explicit: `{{1x\|1=== H ==}}` → `<h2 id="H">H</h2>`. |
| **V-3** | §15 link hrefs | Hrefs are `/wiki/<slug>` (e.g. `/wiki/quota`), not §15's `/wiki/Quota`. | Spec Addendum A5 defers `$1` to the title↔slug decision; decisions O1 settles it as `nsPrefix + slugifyTitle`. Not a divergence, the spec's own escape hatch. |
| **V-4** | §15 C-51/C-64 | Footnote brackets are `&#91;`/`&#93;`, which §15 writes as `[`/`]`. | §10.3's own HTML sample specifies the entities (and MediaWiki emits them). The tests decode before comparing. |
| **V-5** | seed plan §3.1 Addendum | `Eclipsed` is listed as an intentional red link but the Titan fixture never writes `[[Eclipsed]]` — only italic prose. | Asserted as prose, not a link. **The plan's addendum should drop it from the A1 red-link list.** The other four (Fancy lamp, Snare Flea, Eyeless Dog, Extension ladder) are real and asserted. |
| **V-6** | §13.1 DISPLAYTITLE | `{{DISPLAYTITLE:''Quota''}}` on page `Quota` is REJECTED; `{{DISPLAYTITLE:<i>Quota</i>}}` is accepted. | §13.1 defines the sanitization over *tags* only. MediaWiki additionally runs `doQuotes()` on the argument, so it accepts the apostrophe form. Left as the spec reads (no test or seed content depends on it). **Open, low priority:** either amend §13.1 or apply §1 to the argument. |
| **V-7** | §8.7 + attributes | The auto-newline fires inside attribute values: `title="…version{{#if:…\|: …}}."` gains a raw LF, as does the infobox colour style. | Spec §8.7 and MediaWiki both apply T2529 to every non-line-start expansion, parser functions included, so the engine is right and **the templates were wrong**. Not harmless, as this row claimed until 2026-09-07: stage 4 is line-oriented, so an LF inside a `title=` cuts the tag in half — the `<` escapes to visible `&lt;sup …` text and the rest of the attribute, now a line opening with `:`, becomes a `<dl><dd>`. It hit every seeded page carrying a `{{Verify\|reason}}`. Fixed in the templates (`&#58;` for the colon, the `#` of a colour hoisted out of the `#switch`) and pinned by `seed-fixtures.test.ts` › "no template splices an LF into an attribute value". The `style=` case really was cosmetic — CSS tolerates the LF — but it is fixed for the same reason. |
| **V-8** | versioning §2.6 | An unregistered but well-formed id (`v99`) gets a derived ordinal and no `unknown-version` warning; only a malformed id (`nightly`) warns. | Deliberate behavior of the final `versions.ts` ("so a range naming a not-yet-registered version still orders sanely"). Both paths are asserted in `versions.integration.test.ts`. |

Non-deviation worth recording: `{{#ifexist:}}` records its target in **both** `linksTo`
(spec Addendum A4, matching MediaWiki's link registration) and the new `ifexistTargets`.

---

## 5. Public API surface for the APP phase

Everything below is stable; nothing else in `src/lib/wikitext/**` should be imported by
`src/app/**`.

### Parsing

```ts
import { parse, stages, createPageMeta, ParseContextError } from "@/lib/wikitext/index";
import type {
  ParseResult, ParseContext, ParseOptions, PageMeta, PageStore,
  WikiConfig, WikiMessages, Title, TitleKey, TocEntry, VersionTable,
} from "@/lib/wikitext/types";

function parse(source: string, ctx: ParseContext): ParseResult;
```

`ParseContext` (= `ParseOptions`) — read-only, supplied per render:

```ts
{ config: WikiConfig;      // per rendering locale: articlePath + messages
  store: PageStore;
  page: Title;             // the page being rendered
  now?: Date;              // injected clock for CURRENT* (tests)
  version: string | null;  // null = version-agnostic (save-time extraction, indexing)
  versions: VersionTable;
  preview?: boolean }      // /api/preview: version warnings rendered inline
```

`ParseResult`:

```ts
{ doc: Document;              // the AST, if the caller wants it
  html: string;               // ready to inject
  meta: PageMeta;             // === doc.meta
  toc: TocEntry[];            // === meta.toc
  refs: Record<string, number> }   // refs registered per group
```

`PageMeta` — what the DB layer persists:
`categories` · `displayTitle?` · `redirect?` (`{ target: Title }`, fragment on
`target.fragment`, Addendum A2) · `behaviorSwitches` · `toc` · `templatesUsed` (transitive +
missing) · `linksTo` (red links included) · `ifexistTargets` · `volatile` (⇒ never cache) ·
`versionBoundaries` · `versionScoped` (false ⇒ cache under `'*'`) · `warnings`.

Guarantees: **synchronous**; deterministic (same source + same `ParseContext` including
`now` ⇒ byte-identical output, §14.11); it throws only `ParseContextError`, and only for a
malformed context — every content problem is reported inline (`<span class="error">`) or in
`meta.warnings`.

`stages` exposes the seven stage functions under the `EngineStages` contract for callers
that need one stage (e.g. `stages.preprocess` for a syntax-check endpoint).

### PageStore factory

```ts
import { createDb, type WikiDb } from "@/lib/db/client";
import { createPageStore, loadVersionTable } from "@/lib/db/store";

const db = createDb(process.env.WIKI_DB_PATH ?? "./wiki-data/wiki.db");
const store = createPageStore(db, { mediaPath: "/api/media/" }); // decisions O6
const versions = loadVersionTable(db);                            // versioning §1
```

`createPageStore` returns the engine's `PageStore`. It memoizes its lookups, so **create one
per render** rather than sharing it across requests. Transclusion always resolves to the
template's EN head (db-schema A8), falling back to the earliest-created locale head for
pages created non-EN-first (decisions O4).

### Error classes

- `ParseContextError` (`src/lib/wikitext/index.ts`) — programmer error at the `parse()` call
  site; never raised for content.
- `WikiStoreError` (`src/lib/db/store.ts`) and its subclasses, each carrying `status` and
  `code` for `lib/api-response.ts`: `EditConflictError` (409, also carries `currentRevId`),
  `PageMissingError`, `PageExistsError`, `RevisionMissingError`, `LanguageMissingError`,
  `InvalidTitleError`, `VersionMissingError`, `VersionInUseError` (409 + referencing pages),
  `GrantMissingError`, `SelfRevokeError`.

### Titles

`@/lib/title` — `slugifyTitle`, `normalizeTitle`, `parseTitle`, `nsPrefix`,
`pathToTitle`, `canonicalFilename`, `DEFAULT_NAMESPACES`, `STORABLE_NAMESPACES`,
`NS_MAIN`/`NS_PROJECT`/`NS_FILE`/`NS_TEMPLATE`/`NS_CATEGORY`.

`@/lib/locale-path` (decisions-v2 O12) — `localePath`, `homeHref`, `articleHref`,
`editHref`, `historyHref`, `diffHref`, `whatLinksHereHref`, `titleRouteHref`, `searchHref`,
`specialHref`, `titleToPath`, `withQuery`, `parseLocalePath`. The ONLY module allowed to put
a locale into a URL; `buildWikiConfig` builds `articlePath` from it.

### Caching rules the app must honor

- Never cache when `meta.volatile` (CURRENT*, `#ifexist`) — db-schema A5.
- Cache key is `(page_id, locale, version)`; `version = '*'` when
  `meta.versionScoped === false`, otherwise the selected id — versioning §4.
- `saveEdit` already writes `page_links`/`template_links`/`category_links`/`search_docs`
  from `meta`, invalidates the page's cache rows and, for a template edit, its dependents'.
  Save-time extraction must use `version: null` so the link graph stays
  version-independent (versioning §5).

---

## 6. Known gaps for the APP phase

- **DISPLAYTITLE apostrophes** (V-6) — decide before editors meet it.
- **Raw block HTML that is not p-rejecting and spans lines** (`<div>` … blank line …
  `</div>`) is still balanced per line, so the `<div>` closes on its own line and the stray
  `</div>` is dropped. Every seed template writes such elements on one line, and §11.2's
  document-scope balancing for these is unimplemented. Revisit if editors hit it.
- **`<gallery>` items** render a red link to the File page when the file is absent (§5.9);
  there is no separate placeholder construct, as the seed plan's addendum notes.
- Search indexes the default-version rendering only (versioning §4) — a documented tradeoff,
  not a bug.
