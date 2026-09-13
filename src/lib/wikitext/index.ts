/**
 * Wikitext engine — pipeline entry point and stage contract.
 *
 * `parse()` wires the seven stage modules in the §14 order:
 *
 *   0 normalize → 1 preprocess → 2 expand → 3 sanitizeRawHtml
 *   → 4 parseBlocks → 5 parseInline (per inline region) → 6 render
 *
 * Version scoping (docs/engine/versioning.md): version tags — `<v70>`,
 * `<v70+v80>`, `<v70+>`, whose NAME is the range — and the
 * `#ifversion`/`#vswitch` parser functions resolve during stage 2 via
 * versions.ts, so later stages never see version markup. Boundaries are
 * recorded into `meta.versionBoundaries` before branch selection.
 *
 * Strip-marker semantics (spec §0.5, §14.8): `<nowiki>`/`<pre>`/
 * `<syntaxhighlight>` content (and rendered extension-tag output) is captured
 * at stage 1 and replaced in the expanded text by opaque markers
 * `\x7f'"UNIQ--<name>-<8 hex>-QINU"'\x7f`; NO stage between 1 and 6 sees
 * inside them. Stage 6 restores them LAST (iterated while markers remain —
 * markers may nest — with a bound). Raw \x7f in author input is stripped at
 * stage 0.
 */

import { parseBlocks } from "./blocks";
import { createPageMeta, expand, rootFrame } from "./expand";
import { parseInline } from "./inline";
import { normalize } from "./normalize";
import { preprocess } from "./preprocessor";
import { render } from "./render";
import { sanitizeRawHtml } from "./sanitize";
import type {
  BlockNode,
  Document,
  Frame,
  InlineNode,
  PageMeta,
  ParseContext,
  ParseResult,
  PPNode,
  TocEntry,
} from "./types";

/* ------------------------------------------------------------------ */
/* Stage intermediate shapes                                           */
/* ------------------------------------------------------------------ */

/** Marker string → protected content, restored verbatim at stage 6. */
export type StripTable = Map<string, string>;

/** Output of stage 2 (spec §14.3). */
export interface ExpandResult {
  /** Flat expanded wikitext containing strip markers. */
  text: string;
  strips: StripTable;
  /**
   * Page-scope collectors already partially filled during expansion
   * (templatesUsed incl. transitive+missing per Addendum A4, volatile,
   * warnings…). Refs are NOT yet numbered — numbering happens at render.
   */
  meta: PageMeta;
}

/** Output of stage 6 (spec §14.7). */
export interface RenderResult {
  /** Final HTML, strip markers restored. */
  html: string;
  toc: TocEntry[];
  /** Ref count per group after numbering (diagnostic/testing aid). */
  refs: Record<string, number>;
}

/* ------------------------------------------------------------------ */
/* Stage contract (spec §14.1–14.7) — implemented by the stage modules */
/* ------------------------------------------------------------------ */

export interface EngineStages {
  /**
   * Stage 0 (§14.1): CRLF/CR→LF, strip leading U+FEFF, remove U+0000 and
   * U+007F, ensure trailing \n. Decodes nothing else.
   * Module: normalize.ts, export `normalize`.
   */
  normalize(source: string): string;

  /**
   * Stage 1 (§14.2): single left-to-right scan → PPNode tree (templates,
   * parameters, ext tags, comments, text). Extension-tag capture beats brace
   * matching; comments removed (line-eating rule §10.8); brace runs must be
   * contiguous. `forInclusion` applies §8.6 noinclude/includeonly/onlyinclude
   * filtering before building the tree.
   * Module: preprocessor.ts, export `preprocess`.
   */
  preprocess(source: string, ctx: ParseContext, forInclusion: boolean): PPNode[];

  /**
   * Stage 2 (§14.3): walk the tree with `frame` — variables, parser
   * functions (§9, args lazy+trimmed), {{!}}/{{=}}, templates (loop/depth/
   * size checks, child frame, args lazy+cached), {{{params}}} (§8.4);
   * ext tags become strip markers (wikitext-content tags expand inner
   * first; nowiki/pre/syntaxhighlight keep raw content). Applies the T2529
   * auto-newline when splicing expansions starting with *#;: {| or ----
   * off line-start.
   * Module: expand.ts, export `expand`. Root call: frame = root frame
   * (title = the page being rendered, depth 0, no args).
   */
  expand(root: PPNode[], ctx: ParseContext, frame: Frame): ExpandResult;

  /**
   * Stage 3 (§14.4, §11): scan expanded text for <…>; allowlisted tags are
   * normalized to canonical tag tokens (attributes/style filtered here),
   * everything else entity-escaped in place. Strip markers untouched.
   * Module: sanitize.ts, export `sanitizeRawHtml`.
   */
  sanitizeRawHtml(expanded: string, ctx: ParseContext): string;

  /**
   * Stage 4 (§14.5): line-oriented block parse of the sanitized text, in
   * order: redirect check (once, whole page) → __WORD__ switches → tables
   * (recursive) → headings → ---- → lists → pre/paragraphs (with the
   * block-HTML exemption §3.1.4 and the A1/D-14 blank-line rule). Records
   * redirect/switches into `meta`; calls parseInline for inline regions.
   * Module: blocks.ts, export `parseBlocks`.
   */
  parseBlocks(sanitized: string, ctx: ParseContext, meta: PageMeta): BlockNode[];

  /**
   * Stage 5 (§14.6): inline parse of one region, in order: sanctioned HTML
   * tag tokens → internal links/files (§5, records linksTo/categories into
   * `meta`) → apostrophes (§1) → external links (§6) → text/entities.
   * Module: inline.ts, export `parseInline`.
   */
  parseInline(text: string, ctx: ParseContext, meta: PageMeta): InlineNode[];

  /**
   * Stage 6 (§14.7): AST → HTML. Numbers refs + emits reference lists
   * (§10.3, auto-append pending groups), builds+splices TOC (§2.5), dedupes
   * heading ids (§2.4), then restores strip markers LAST (iterate until none
   * remain, bounded). `doc.meta.toc` is filled here.
   * Module: render.ts, export `render`.
   */
  render(doc: Document, ctx: ParseContext, strips: StripTable): RenderResult;
}

/**
 * The stage modules, bound to the {@link EngineStages} contract. Exported so
 * callers (and tests) can drive one stage directly with the same functions
 * `parse()` uses, rather than re-importing each module.
 */
export const stages: EngineStages = {
  normalize,
  preprocess,
  expand,
  sanitizeRawHtml,
  parseBlocks,
  parseInline,
  render,
};

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/**
 * Thrown when `parse()` is called with an unusable context. Everything the
 * engine can recover from is reported through `meta.warnings` or rendered as
 * an inline `<span class="error">` instead (§8.5, §9.1) — this class is for
 * programmer errors at the call site only, so callers never need to wrap
 * `parse()` in a try/catch for content reasons.
 */
export class ParseContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseContextError";
  }
}

function assertContext(ctx: ParseContext): void {
  if (!ctx || typeof ctx !== "object") {
    throw new ParseContextError("parse(): ctx is required");
  }
  if (!ctx.config) throw new ParseContextError("parse(): ctx.config is required");
  if (!ctx.store) throw new ParseContextError("parse(): ctx.store is required");
  if (!ctx.page) throw new ParseContextError("parse(): ctx.page is required");
  if (!ctx.versions) throw new ParseContextError("parse(): ctx.versions is required");
}

/* ------------------------------------------------------------------ */
/* Pipeline entry point                                                */
/* ------------------------------------------------------------------ */

/**
 * Parse + render one page. Synchronous and deterministic: identical source +
 * ParseContext (incl. `ctx.now`) ⇒ byte-identical ParseResult (spec §14.11).
 *
 * `meta` is the single page-scope collector: stage 2 fills `templatesUsed`
 * (transitive + missing), `volatile`, `displayTitle`, `ifexistTargets`,
 * `versionBoundaries`/`versionScoped` and `warnings`; stage 4 adds `redirect`
 * and `behaviorSwitches`; stage 5 adds `linksTo` (red links included) and
 * `categories`; stage 6 fills `toc`.
 */
export function parse(source: string, ctx: ParseContext): ParseResult {
  assertContext(ctx);

  // Stage 0–1.
  const normalized = normalize(source);
  const tree = preprocess(normalized, ctx, false);

  // Stage 2 — expansion owns the PageMeta every later stage writes into.
  const expanded = expand(tree, ctx, rootFrame(ctx.page));
  const meta = expanded.meta;

  // Stage 3–5. `parseBlocks` calls stage 5 for each inline region it finds.
  const sanitized = sanitizeRawHtml(expanded.text, ctx);
  const children = parseBlocks(sanitized, ctx, meta, parseInline);

  // Stage 6.
  const doc: Document = { type: "document", children, meta };
  const rendered = render(doc, ctx, expanded.strips);

  return { doc, html: rendered.html, meta, toc: rendered.toc, refs: rendered.refs };
}

/**
 * A `PageMeta` with every collector empty — the shape `parse()` fills in.
 * Re-exported here so callers can build one without importing stage 2.
 */
export { createPageMeta };
