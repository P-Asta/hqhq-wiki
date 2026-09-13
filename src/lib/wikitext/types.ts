/**
 * Shared engine types for the hqhq-wiki wikitext engine.
 *
 * Source of truth: docs/engine/wikitext-spec.md §0.4, §14.9, §14.10 and its
 * Addenda A2 (redirect shape), A3 (localizable messages), A4 (templatesUsed /
 * linksTo completeness); docs/engine/decisions.md.
 *
 * The engine is fully synchronous (better-sqlite3 is sync; parse() is sync).
 */

/* ------------------------------------------------------------------ */
/* Titles                                                              */
/* ------------------------------------------------------------------ */

/** `"ns:Normalized_page_name"` cache key (spec §14.10). */
export type TitleKey = string;

export interface Title {
  /** Numeric namespace per spec §5.8 (0 Main, 4 Project, 6 File, 10 Template, 14 Category, …). */
  namespace: number;
  /** Normalized page name: first letter uppercased, spaces (not underscores). */
  pageName: string;
  /**
   * Fragment, kept verbatim (encoded only inside hrefs). Per spec Addendum A2
   * a redirect's fragment travels here on the redirect target Title.
   */
  fragment?: string;
}

/* ------------------------------------------------------------------ */
/* Namespaces                                                          */
/* ------------------------------------------------------------------ */

/**
 * Namespace lookup used for title parsing (spec §5.8). Matching is
 * case-insensitive and underscore/space-insensitive; aliases include
 * `Image:` → File and the site name → Project.
 */
export interface NamespaceTable {
  /** id → canonical English name; `""` for main (id 0). */
  canonical: Record<number, string>;
  /**
   * Normalized prefix (lowercased, `_`→space, trimmed) → id. Includes the
   * canonical names themselves plus aliases.
   */
  byAlias: Record<string, number>;
}

/* ------------------------------------------------------------------ */
/* Config (spec §0.4 + Addendum A3 messages)                           */
/* ------------------------------------------------------------------ */

/**
 * Parser-emitted localizable strings (spec Addendum A3). Values are supplied
 * per rendering locale from the UI dictionary system (lib/i18n), keys
 * namespaced `wikitext.*` there (decisions.md "Engine i18n messages").
 */
export interface WikiMessages {
  tocTitle: string; // "Contents" / "목차"
  redLinkTitleSuffix: string; // "(page does not exist)"
  redirectTo: string; // "Redirect to:"
  citeErrorNoText: (name: string) => string;
  templateLoop: string;
  templateDepthExceeded: string;
  unknownVersion: (id: string) => string; // versioning.md §2.6
  // #expr error strings MAY remain EN-only (they mirror MW's exactly).
}

/**
 * Global configuration (spec §0.4). Instantiated per rendering locale:
 * `articlePath` is the locale's `/{locale}/wiki/$1` pattern (spec Addendum A5)
 * and `messages` come from that locale's dictionary (Addendum A3).
 */
/* ------------------------------------------------------------------ */
/* Game versions (docs/engine/versioning.md — decision O10)            */
/* ------------------------------------------------------------------ */

export interface VersionEntry {
  id: string; // "v62", "v64.1"
  label: string;
  /** major*1000 + minor — the ONLY ordering key (never string-compare ids). */
  ordinal: number;
  status: "current" | "supported" | "legacy";
}

/** Registry snapshot handed to the engine (versioning.md §3). */
export interface VersionTable {
  byId: Record<string, VersionEntry>;
  /** Ordinal-ascending list. */
  ordered: VersionEntry[];
  /** `site_settings.default_version` — used when ctx.version is null. */
  defaultId: string;
}

export interface WikiConfig {
  siteName: string; // "HQHQ Wiki" — value of {{SITENAME}}
  articlePath: string; // "/{locale}/wiki/$1" — internal link href pattern
  redLinkPath: string; // articlePath + "?redlink=1" (or same as articlePath)
  externalLinkRel: string; // "nofollow noopener" or "" per SEO policy
  caseSensitive: false; // first letter of titles is case-insensitive (MW default)
  maxTemplateDepth: number; // 40 — expansion frame depth
  maxIncludeSize: number; // 2_097_152 — bytes of post-expansion include text
  maxExpensiveCalls: number; // 100 — #ifexist etc.
  thumbDefaultWidth: number; // 220 px, base width for |thumb|
  uprightDefaultFactor: number; // 0.75
  timezone: "UTC"; // for CURRENT* variables
  fragmentMode: "html5"; // heading id encoding, §2.5
  namespaces: NamespaceTable; // §5.8
  messages: WikiMessages; // Addendum A3
}

/* ------------------------------------------------------------------ */
/* External interfaces (spec §14.9)                                    */
/* ------------------------------------------------------------------ */

export interface PageStore {
  /**
   * Normalized title → raw wikitext, or null. Sync for build-time rendering.
   * For Template-ns titles this MUST resolve to the template page's EN head
   * revision regardless of rendering locale (db-schema Addendum A8).
   */
  getSource(title: TitleKey): string | null;
  exists(title: TitleKey): boolean;
  /** File metadata for [[File:…]] and <gallery>. `src` = /api/media/<canonical> (decisions O6). */
  getFile(name: string): { src: string; width: number; height: number } | null;
}

export interface ParseOptions {
  config: WikiConfig;
  store: PageStore;
  page: Title; // the page being rendered (for PAGENAME etc.)
  now?: Date; // injected clock for CURRENT* (tests!)
  /**
   * Selected game version id (versioning.md §3). `null` = version-agnostic
   * render: constructs resolve as if `versions.defaultId` were selected, and
   * this is the mode used for link/category/redirect extraction at save time
   * (versioning.md §5) and for search indexing.
   */
  version: string | null;
  /** Registry snapshot; ordering and range math use `ordinal` only. */
  versions: VersionTable;
  /** /api/preview only: render version warnings inline (versioning.md §2.6). */
  preview?: boolean;
}

/**
 * The context threaded through every pipeline stage. Currently identical to
 * ParseOptions; stages must treat it as read-only (page-scoped mutable state —
 * ref collectors, expansion counters — lives in engine-internal structures,
 * not here). Determinism: same source + same ParseContext (incl. `now`) ⇒
 * byte-identical output (spec §14.11).
 */
export type ParseContext = ParseOptions;

/* ------------------------------------------------------------------ */
/* Expansion frames (spec §0.5, §14.3)                                 */
/* ------------------------------------------------------------------ */

/** One template-call argument as captured at the call site (args lazy, cached). */
export interface FrameArg {
  /** Expanded+trimmed name; null = positional (numbered 1..n by position). */
  name: string | null;
  /** Unexpanded value nodes. */
  value: PPNode[];
  /** Cache of the expanded value (expand-once semantics, spec §14.3). */
  expanded?: string;
}

/**
 * One level of template expansion, carrying the argument list and the
 * ancestor-title chain (for loop detection) — spec §0.5.
 */
export interface Frame {
  /** Title of the template being expanded; null for the root (page) frame. */
  title: Title | null;
  args: FrameArg[];
  parent: Frame | null;
  /** Root frame = 0; checked against config.maxTemplateDepth. */
  depth: number;
}

/* ------------------------------------------------------------------ */
/* Preprocessor tree (stages 1–2, spec §14.10)                         */
/* ------------------------------------------------------------------ */

export type PPNode = PPText | PPTemplate | PPParameter | PPExtTag | PPComment;

export interface PPText {
  kind: "text";
  value: string;
}

export interface PPComment {
  kind: "comment";
  value: string;
}

/** `{{ … }}` */
export interface PPTemplate {
  kind: "template";
  name: PPNode[]; // may contain nested nodes
  params: { name: PPNode[] | null; value: PPNode[] }[]; // null name = positional
}

/** `{{{ … }}}` */
export interface PPParameter {
  kind: "parameter";
  name: PPNode[];
  default?: PPNode[];
}

export interface PPExtTag {
  kind: "ext";
  name: string; // lowercased
  attrs: Record<string, string>;
  inner: string | null; // raw; null for self-closing
  /**
   * No `</name>` was ever found, so §10.7's rule applied and this tag's body
   * ran to the end of the input.
   *
   * Carried because the *rendering* is right and the **page** is usually
   * wrong: one mistyped closer (`</69>` for `</v69>`) silently swallows
   * everything after it, and for a version tag it also HIDES that content at
   * every version outside the range. Stage 2 turns this into a warning so the
   * editor can say so; nothing about what gets rendered depends on it.
   */
  unclosed?: true;
}

/* ------------------------------------------------------------------ */
/* Document AST (stages 4–6, spec §14.10)                              */
/* ------------------------------------------------------------------ */

export interface Document {
  type: "document";
  children: BlockNode[];
  meta: PageMeta;
}

/**
 * One interlanguage link (`[[ru:Artifice]]`) — Fandom parity, "Fandom
 * extensions / Image sizes, interlanguage links, ref ordering" in
 * wikitext-spec.md. `lang` is the lowercased language code exactly as the
 * prefix was written (`ru`, `zh-hans`); `title` is the raw remainder, kept
 * verbatim because it names a page on a FOREIGN wiki and must not be
 * normalized by this wiki's namespace/case rules (§5.7 does not apply).
 */
export interface LanguageLink {
  lang: string;
  title: string;
}

export interface PageMeta {
  categories: { name: string; sortKey: string | null }[];
  displayTitle?: string; // sanitized HTML, §13.1
  /**
   * `{{DEFAULTSORT:key}}` — the sort key applied to every category on the page
   * that carries no explicit `|sortkey` (Fandom extensions). Last one wins.
   */
  defaultSort?: string;
  /**
   * Interlanguage links swallowed from the output (Fandom extensions), in
   * document order, deduplicated by `lang`+`title`. Optional so existing
   * `PageMeta` literals stay valid; `createPageMeta()` always supplies `[]`.
   */
  languageLinks?: LanguageLink[];
  /** Addendum A2: fragment (if any) is carried in target.fragment. */
  redirect?: { target: Title };
  behaviorSwitches: Set<string>; // "NOTOC", "TOC", …
  toc: TocEntry[];
  /**
   * Every transclusion target *attempted* during expansion — transitive and
   * including nonexistent (red-linked) templates (spec Addendum A4). Feeds
   * template_links for cache invalidation.
   */
  templatesUsed: TitleKey[];
  /** Outgoing internal links, red links included (spec Addendum A4). Feeds page_links. */
  linksTo: TitleKey[];
  /**
   * Every title probed by `{{#ifexist:}}` during expansion, in call order.
   * A subset of `linksTo` (§9.2 registers the probe as a link); kept apart so
   * the cache layer can tell a real outgoing link from an existence probe.
   */
  ifexistTargets: TitleKey[];
  /** Used CURRENT* or #ifexist ⇒ output must not be cached (db-schema Addendum A5). */
  volatile: boolean;
  /**
   * Every version id named by any version construct reached during expansion —
   * recorded BEFORE branch selection so the selector lists boundaries whose
   * content the current view hides (versioning.md §3).
   */
  versionBoundaries: string[];
  /** Any version construct present ⇒ selector shown, cache keyed by version. */
  versionScoped: boolean;
  warnings: string[];
}

export interface TocEntry {
  level: number; // h-level 1..6
  tocLevel: number; // relative, §2.5
  number: string; // "2.1"
  id: string;
  html: string; // flattened inline content
}

export type BlockNode =
  | Paragraph
  | Heading
  | HorizontalRule
  | Preformatted
  | ListBlock
  | DefinitionList
  | Table
  | HtmlBlock
  | TocPlaceholder
  | ReferencesBlock
  | Gallery
  | RedirectNotice;

export interface Paragraph {
  type: "p";
  children: InlineNode[];
}

export interface Heading {
  type: "heading";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  id: string;
  children: InlineNode[];
}

export interface HorizontalRule {
  type: "hr";
}

export interface Preformatted {
  type: "pre";
  literal: boolean; // literal=true → tag form (§10.2)
  attrs?: Attrs;
  children: InlineNode[]; // or single Text when literal
}

export interface ListBlock {
  type: "list";
  ordered: boolean;
  attrs?: Attrs;
  items: ListItem[];
}

export interface ListItem {
  type: "li";
  children: (InlineNode | BlockNode)[];
}

export interface DefinitionList {
  type: "dl";
  items: (DefTerm | DefData)[];
}

export interface DefTerm {
  type: "dt";
  children: (InlineNode | BlockNode)[];
}

export interface DefData {
  type: "dd";
  children: (InlineNode | BlockNode)[];
}

export interface Table {
  type: "table";
  attrs: Attrs;
  caption?: { attrs: Attrs; children: InlineNode[] };
  rows: TableRow[];
  fostered: BlockNode[];
}

export interface TableRow {
  type: "tr";
  attrs: Attrs;
  cells: TableCell[];
}

export interface TableCell {
  type: "cell";
  header: boolean;
  attrs: Attrs;
  children: BlockNode[];
}

export interface HtmlBlock {
  type: "html-block";
  tag: string;
  attrs: Attrs;
  children: (InlineNode | BlockNode)[];
}

export interface TocPlaceholder {
  type: "toc";
}

export interface ReferencesBlock {
  type: "references";
  group: string;
  auto: boolean;
}

export interface Gallery {
  type: "gallery";
  attrs: GalleryAttrs;
  items: GalleryItem[];
}

export interface RedirectNotice {
  type: "redirect";
  target: Title;
  targetText: string;
}

export type InlineNode =
  | Text
  | Bold
  | Italic
  | WikiLink
  | ExternalLink
  | ImageLink
  | HtmlInline
  | LineBreak
  | RefMarker
  | StripMarker
  | Entity;

export interface Text {
  type: "text";
  value: string;
}

export interface Entity {
  type: "entity";
  value: string; // "&copy;" kept for exact output
}

export interface Bold {
  type: "b";
  children: InlineNode[];
}

export interface Italic {
  type: "i";
  children: InlineNode[];
}

export interface WikiLink {
  type: "wikilink";
  target: Title;
  exists: boolean;
  selfAnchor: boolean; // [[#frag]]
  children: InlineNode[]; // label incl. trail
}

export interface ExternalLink {
  type: "extlink";
  href: string;
  style: "text" | "autonumber" | "free";
  number?: number;
  children: InlineNode[];
}

export interface ImageLink {
  type: "image";
  file: string;
  exists: boolean;
  format: "inline" | "thumb" | "frame" | "frameless";
  halign?: "left" | "right" | "center" | "none";
  valign?:
    | "baseline"
    | "sub"
    | "super"
    | "top"
    | "text-top"
    | "middle"
    | "bottom"
    | "text-bottom";
  width?: number;
  height?: number;
  upright?: number;
  border: boolean;
  alt?: string;
  link?: Title | string | null; // null = link= (none)
  caption: InlineNode[];
}

export interface HtmlInline {
  type: "html-inline";
  tag: string;
  attrs: Attrs;
  /**
   * Inline children normally. A p-ALLOWING block container opened on its own
   * source line (`<div>` … `</div>` spanning paragraphs, §3.1 rule 4) also
   * holds BLOCK children, so the wrapped content nests inside the element
   * instead of spilling out after it.
   */
  children: (InlineNode | BlockNode)[];
}

export interface LineBreak {
  type: "br";
}

export interface RefMarker {
  type: "ref";
  group: string;
  name?: string;
  content?: InlineNode[]; // absent = pure reuse
  index: number; // assigned at render
}

export interface StripMarker {
  type: "strip";
  marker: string; // resolved at render
}

export type Attrs = Record<string, string>;

export interface GalleryAttrs {
  caption?: string;
  widths: number;
  heights: number;
  perrow?: number;
  mode: "traditional" | "packed";
  class?: string;
}

export interface GalleryItem {
  file: string;
  exists: boolean;
  caption: InlineNode[];
  alt?: string;
  link?: Title | string;
}

/** Optional source span any node MAY carry (spec §14.10, trailing note). */
export interface SourceSpan {
  start: number;
  end: number;
}

/* ------------------------------------------------------------------ */
/* Result                                                              */
/* ------------------------------------------------------------------ */

export interface ParseResult {
  doc: Document;
  html: string;
  meta: PageMeta; // same object as doc.meta, exposed for convenience
  /** Same array as `meta.toc`, exposed for convenience (§2.5). */
  toc: TocEntry[];
  /** Refs registered per group during this render (§10.3), keyed by group. */
  refs: Record<string, number>;
}

/* ------------------------------------------------------------------ */
/* Expansion hooks (added by preprocessor agent: the parser-function /  */
/* magic-word module is owned by another agent; stage 2 dispatches into */
/* it through this interface — see src/lib/wikitext/expand.ts)          */
/* ------------------------------------------------------------------ */

/** One argument of a parser-function call; the value is expanded lazily. */
export interface ParserFunctionArg {
  /** Expanded + trimmed argument name, or null for a positional argument. */
  name: string | null;
  /** Unexpanded value nodes (expand via `value()` to keep laziness). */
  nodes: PPNode[];
  /** Expanded + trimmed value (spec §9.1); memoized per call. */
  value(): string;
}

/** Services stage 2 exposes to parser-function / magic-word handlers. */
export interface ExpandApi {
  ctx: ParseContext;
  frame: Frame;
  /** The page-scope metadata sink (§8.8). */
  meta: PageMeta;
  /** Expand raw wikitext in the current frame (re-entrant). */
  expandText(text: string): string;
  /** Expand preprocessed nodes in the current frame. */
  expandNodes(nodes: readonly PPNode[]): string;
  /** Register protected content, returning its strip marker (§0.5). */
  addStrip(name: string, content: string): string;
  /** Charge one expensive call; false ⇒ over `maxExpensiveCalls` (§9.2). */
  countExpensive(): boolean;
  /** Mark the render time-dependent (CURRENT*, #ifexist — §9.5). */
  markVolatile(): void;
  /** Record a page-level warning (deduped). */
  warn(message: string): void;
}

/**
 * Handlers return the expansion, or null when they do not know the name (the
 * expander then falls back to literal wikitext + a warning).
 */
export interface ExpandHooks {
  evaluateParserFunction?(
    name: string,
    args: ParserFunctionArg[],
    api: ExpandApi,
  ): string | null;
  evaluateMagicWord?(name: string, api: ExpandApi): string | null;
  /** Extends the built-in colon-function name set of §9.4 (optional). */
  isParserFunction?(name: string): boolean;
}
