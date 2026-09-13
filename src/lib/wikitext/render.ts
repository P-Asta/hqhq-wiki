/**
 * Stage 6 — render + finalize (spec §14.7).
 *
 * Walks the block/inline AST into an HTML string, allocates heading ids
 * (§2.4), builds and splices the TOC (§2.5), numbers refs and emits reference
 * lists (§10.3), and finally restores strip markers (§14.8) — LAST, iterating
 * because markers may nest.
 *
 * ---------------------------------------------------------------------------
 * HTML CLASS CONTRACT (the app styles exactly these tokens)
 * ---------------------------------------------------------------------------
 *   .toc .wiki-toc            TOC container (`<div id="toc">`, role=navigation)
 *   .toctitle .toclevel-N     TOC title box / one entry per relative level
 *   .tocnumber .toctext       the "1.2" and the flattened heading text
 *   .wikitable .infobox       NOT emitted here — they pass through from the
 *                             author's `{| class="wikitable"` and from template
 *                             raw HTML (`<table class="infobox">`), filtered by
 *                             sanitize.ts
 *   .new .red-link            internal link whose target does not exist
 *                             (`class="new red-link"` — MW's `new` plus ours)
 *   .external .text           bracketed external link with a label (§6.2)
 *   .external .autonumber     bracketed bare external link `[1]`
 *   .external .free           bare URL in running text
 *   .reference                inline `<sup>` ref marker
 *   .references               the `<ol>` reference list
 *   .mw-ref-warning           auto-appended-list maintenance note (§10.3)
 *   .error                    parser/cite error spans (§8.5, §9.1, §10.3)
 *   .mw-file .mw-thumb        image link / thumb figure (D-7)
 *   .mw-halign-left|right|center|none   thumb float
 *   .mw-image-border          `|border` option
 *   .gallery .mw-gallery-traditional|packed|nolines .gallerybox .thumb
 *   .gallerytext              gallery item caption
 *   .gallerycaption           `<gallery caption="…">`
 *   .mw-gallery-spacing-*     `<gallery spacing=…>` (Fandom ext §F.2.3)
 *   .mw-gallery-captionalign-* / .mw-gallery-position-*    ditto
 *   .tabber .tabber-input .tabber-tabs .tabber-tab .tabber-panel
 *                             `<tabber>` widget (Fandom ext §F.2.1)
 *   .poem                     `<poem>` block (Fandom ext §F.2.2)
 *   .portable-infobox .pi-title .pi-image .pi-image-thumbnail .pi-caption
 *   .pi-header .pi-group .pi-data .pi-data-label .pi-data-value .pi-navigation
 *                             `<infobox>` portable infobox (Fandom ext)
 *   .mw-highlight .language-X `<syntaxhighlight>` output (§10.5, produced by
 *                             expand.ts into the strip table)
 *   .redirectMsg .redirectText  redirect page box (§12.3)
 *
 * Headings carry their id on the `h*` element itself (divergence D-2) — there
 * is deliberately NO `<span class="mw-headline">` wrapper; style `h2[id]`.
 * ---------------------------------------------------------------------------
 *
 * Strip-table contract (expand.ts): values for `nowiki` / `pre` /
 * `syntaxhighlight` are FINAL HTML and are reinserted verbatim; `ref`,
 * `references`, `gallery` (and any other wikitext-content extension tag) store
 * an `ExtPayload` (`{tag, attrs, inner}`) that this stage resolves. Ref bodies
 * are expanded *wikitext*, so rendering them needs the inline parser; that
 * dependency is injected — `render(doc, ctx, strips, deps)` or
 * `setDefaultRenderWikitext()` — rather than imported, because render.ts must
 * not depend on stage 5. Without it a ref body is sanitized only (safe, but
 * links and formatting inside it stay literal).
 */

import { parseTitle } from "@/lib/title";

import { parseBlocks } from "./blocks";
import {
  STRIP_MARKER_RE,
  decodeExtPayload,
  stripMarker,
  type ExtPayload,
} from "./expand";
import {
  galleryClassList,
  parseGalleryLine,
  parseGalleryOptions,
  parseTabber,
  poemWikitext,
  renderPoemHtml,
  renderTabberHtml,
  type GalleryOptions,
  type RenderedTab,
} from "./fandom-tags";
import type { RenderResult, StripTable } from "./index";
import { parseInline } from "./inline";
import { decodeInfoboxModel, renderPortableInfobox } from "./portable-infobox";
import {
  buildWikiLinkHref,
  fileStoreKey,
  fullTitleText,
  linkPathSegment,
  titleKey,
  wikiLinkTitleAttr,
} from "./links";
import { RefRegistry } from "./refs";
import {
  VOID_TAGS,
  escapeAll,
  escapeAttr,
  escapeText,
  filterAttributes,
  hasAllowedScheme,
  sanitizeRawHtml,
  serializeAttrs,
  stripTags,
} from "./sanitize";
import {
  IdAllocator,
  anchorIdFromHtml,
  buildToc,
  renderToc,
  shouldShowToc,
  type HeadingRecord,
} from "./toc";
import type {
  BlockNode,
  Document,
  Gallery,
  ImageLink,
  InlineNode,
  PageMeta,
  ParseContext,
  Table,
  Title,
} from "./types";

/** Bound on the restore loop — markers may nest, but not indefinitely. */
const MAX_RESTORE_ROUNDS = 24;

/** Private copy: `STRIP_MARKER_RE` is global and shared across modules. */
function markerRegex(): RegExp {
  return new RegExp(STRIP_MARKER_RE.source, "g");
}

/** Sequence base for markers minted here (AST-level `<ref>` nodes). */
const LOCAL_MARKER_BASE = 0xf0000000;

/** Internal payload tag for an AST-level ref whose body is already HTML. */
const RENDERED_REF_TAG = "ref-rendered";

/**
 * Marker name minted for a `<references />` whose flush is postponed to the
 * second restore pass — see {@link flushDeferredReferences}.
 */
const DEFERRED_REFS_NAME = "refs-deferred";

/* ------------------------------------------------------------------ */
/* Injected wikitext renderer (ref bodies, gallery captions)           */
/* ------------------------------------------------------------------ */

/** Expanded wikitext → inline HTML. Implemented by the pipeline wiring. */
export type WikitextRenderer = (
  wikitext: string,
  ctx: ParseContext,
  meta: PageMeta,
) => string;

export interface RenderDeps {
  /** Renders the inline wikitext of ref bodies and gallery captions. */
  renderWikitext?: WikitextRenderer;
}

let defaultRenderWikitext: WikitextRenderer | null = null;

/**
 * Register the inline renderer once, from the pipeline entry point, for callers
 * that use the plain 3-argument `EngineStages.render` signature.
 */
export function setDefaultRenderWikitext(fn: WikitextRenderer | null): void {
  defaultRenderWikitext = fn;
}

/* ------------------------------------------------------------------ */
/* Render state                                                        */
/* ------------------------------------------------------------------ */

interface RenderState {
  ctx: ParseContext;
  meta: PageMeta;
  ids: IdAllocator;
  refs: RefRegistry;
  headings: HeadingRecord[];
  strips: StripTable;
  /** Markers minted by this stage (AST-level ref nodes). */
  local: Map<string, string>;
  /**
   * Fandom parity — deferred `<references />` flushes, marker → group.
   * Pass 1 of the restore loop registers every ref (including refs that live
   * in content resolved LATER than the tag: gallery captions, file captions,
   * any extension payload); pass 2 replaces these markers with the rendered
   * list, so a ref discovered after the tag still lands in it instead of
   * triggering a spurious auto-appended second list.
   */
  deferredRefs: Map<string, string>;
  markerSeq: number;
  extLinkSeq: number;
  /** Per-page counter for `<tabber>` radio-group names (Fandom ext §F.2.1). */
  tabberSeq: number;
  renderWikitext: WikitextRenderer | null;
}

function mintMarker(st: RenderState, name: string): string {
  for (;;) {
    const marker = stripMarker(name, LOCAL_MARKER_BASE + st.markerSeq);
    st.markerSeq += 1;
    if (!st.strips.has(marker) && !st.local.has(marker)) return marker;
  }
}

/**
 * Ref bodies and gallery captions are expanded wikitext that never went
 * through stages 3–5, so run those three here — on the SAME `RenderState`, so
 * ref numbering, id allocation and external-link autonumbers stay page-wide
 * and any strip marker inside comes back out for the outer restore loop.
 * `deps.renderWikitext` (or `setDefaultRenderWikitext`) overrides it.
 */
function renderWikitextFragment(st: RenderState, wikitext: string): string {
  if (st.renderWikitext) return st.renderWikitext(wikitext, st.ctx, st.meta);
  const sanitized = sanitizeRawHtml(wikitext, st.ctx);
  return renderInlineNodes(parseInline(sanitized, st.ctx, st.meta), st);
}

/**
 * Like {@link renderWikitextFragment} but for content that may contain BLOCK
 * constructs — `<tabber>` panels hold whole sections, tables and lists
 * (Fandom ext §F.2.1). Runs stages 3–5 on the same `RenderState`, so heading
 * ids, ref numbering and external-link autonumbers stay page-wide and any
 * strip marker inside comes back out for the outer restore loop.
 */
function renderWikitextBlockFragment(st: RenderState, wikitext: string): string {
  const sanitized = sanitizeRawHtml(wikitext, st.ctx);
  return renderBlocks(parseBlocks(sanitized, st.ctx, st.meta, parseInline), st);
}

/** Strip markers must never leak into ids or TOC text. */
function withoutMarkers(text: string): string {
  return text.replace(markerRegex(), "");
}

/* ------------------------------------------------------------------ */
/* Links (§5.2 — href helpers shared with links.ts so they can't drift) */
/* ------------------------------------------------------------------ */

/** Article href for a bare `Title` (file pages, redirect targets). */
export function pageHref(title: Title, ctx: ParseContext, exists: boolean): string {
  const pattern = exists ? ctx.config.articlePath : ctx.config.redLinkPath;
  return pattern.replace("$1", linkPathSegment(title, ctx));
}

function fileTitle(name: string): Title {
  return { namespace: 6, pageName: name };
}

function redLink(title: Title, label: string, ctx: ParseContext): string {
  const suffix = ctx.config.messages.redLinkTitleSuffix;
  return (
    `<a href="${escapeAttr(pageHref(title, ctx, false))}" class="new red-link" ` +
    `title="${escapeAttr(`${fullTitleText(title, ctx)} ${suffix}`)}">${escapeText(label)}</a>`
  );
}

/* ------------------------------------------------------------------ */
/* Inline rendering                                                    */
/* ------------------------------------------------------------------ */

const BLOCK_TYPES: ReadonlySet<string> = new Set([
  "p", "heading", "hr", "pre", "list", "dl", "table", "html-block", "toc",
  "references", "gallery", "redirect",
]);

function isBlockNode(node: InlineNode | BlockNode): node is BlockNode {
  return BLOCK_TYPES.has(node.type);
}

function renderInlineNodes(nodes: readonly InlineNode[], st: RenderState): string {
  let out = "";
  for (const node of nodes) out += renderInlineNode(node, st);
  return out;
}

function renderInlineNode(node: InlineNode, st: RenderState): string {
  switch (node.type) {
    case "text":
      return escapeText(node.value);
    case "entity":
      return node.value;
    case "b":
      return `<b>${renderInlineNodes(node.children, st)}</b>`;
    case "i":
      return `<i>${renderInlineNodes(node.children, st)}</i>`;
    case "br":
      return "<br />";
    case "strip":
      return node.marker;
    case "ref": {
      // AST-level ref (`RefMarker`): mint a marker carrying the already
      // rendered body so numbering still happens in the single restore pass,
      // in document order, alongside the refs that came from stage 2.
      const attrs: Record<string, string> = { group: node.group };
      if (node.name !== undefined) attrs.name = node.name;
      const payload: ExtPayload = {
        tag: RENDERED_REF_TAG,
        attrs,
        inner: node.content === undefined ? null : renderInlineNodes(node.content, st),
      };
      const marker = mintMarker(st, "refnode");
      st.local.set(marker, JSON.stringify(payload));
      return marker;
    }
    case "wikilink": {
      const label = renderInlineNodes(node.children, st);
      const href = escapeAttr(buildWikiLinkHref(node, st.ctx));
      const titleAttr = wikiLinkTitleAttr(node, st.ctx);
      const cls = node.exists || node.selfAnchor ? "" : ` class="new red-link"`;
      const title = titleAttr === null ? "" : ` title="${escapeAttr(titleAttr)}"`;
      return `<a href="${href}"${cls}${title}>${label}</a>`;
    }
    case "extlink":
      return renderExternalLink(node, st);
    case "image":
      return renderImage(node, st);
    case "html-inline": {
      // Children may include BLOCK nodes when this element is a wrapper the
      // author opened on its own line (§3.1 rule 4), so render them mixed.
      if (node.tag === "") return renderMixedChildren(node.children, st);
      const attrs = serializeAttrs(filterAttributes(node.tag, node.attrs));
      if (VOID_TAGS.has(node.tag)) return `<${node.tag}${attrs} />`;
      return `<${node.tag}${attrs}>${renderMixedChildren(node.children, st)}</${node.tag}>`;
    }
    default:
      return "";
  }
}

function renderExternalLink(
  node: Extract<InlineNode, { type: "extlink" }>,
  st: RenderState,
): string {
  const rel = st.ctx.config.externalLinkRel;
  const relAttr = rel === "" ? "" : ` rel="${escapeAttr(rel)}"`;
  const href = escapeAttr(node.href);
  if (node.style === "autonumber") {
    st.extLinkSeq += 1;
    const n = node.number ?? st.extLinkSeq;
    return `<a class="external autonumber"${relAttr} href="${href}">[${n}]</a>`;
  }
  const cls = node.style === "free" ? "external free" : "external text";
  return `<a class="${cls}"${relAttr} href="${href}">${renderInlineNodes(node.children, st)}</a>`;
}

/* ------------------------------------------------------------------ */
/* Images (§5.9, divergence D-7)                                       */
/* ------------------------------------------------------------------ */

interface Box {
  width: number;
  height: number;
}

/**
 * §5.9 resize group. `{N}px` sets the width, `x{N}px` the height (the other
 * side follows the natural aspect ratio), `{W}x{H}px` is a BOUNDING BOX the
 * image is fitted inside with its aspect ratio preserved, and `upright`/
 * `upright={f}` multiplies `thumbDefaultWidth` for thumb/frameless. `frame`
 * ignores the whole group and renders at natural size (§5.9 format row).
 * A parameter that matches none of those shapes never reaches here — §5.9
 * makes it the caption instead (links.ts `buildImageLink`).
 */
function scaleBox(natural: Box, node: ImageLink, ctx: ParseContext): Box {
  const { width: nw, height: nh } = natural;
  if (node.format === "frame") return { width: nw, height: nh };
  if (node.width !== undefined && node.height !== undefined) {
    if (nw <= 0 || nh <= 0) return { width: node.width, height: node.height };
    const scale = Math.min(node.width / nw, node.height / nh);
    return {
      width: Math.max(1, Math.round(nw * scale)),
      height: Math.max(1, Math.round(nh * scale)),
    };
  }
  if (node.width !== undefined) {
    return { width: node.width, height: nw > 0 ? Math.round((node.width * nh) / nw) : nh };
  }
  if (node.height !== undefined) {
    return { width: nh > 0 ? Math.round((node.height * nw) / nh) : nw, height: node.height };
  }
  if (node.format === "thumb" || node.format === "frameless") {
    const width = Math.round(ctx.config.thumbDefaultWidth * (node.upright ?? 1));
    return { width, height: nw > 0 ? Math.round((width * nh) / nw) : nh };
  }
  return { width: nw, height: nh };
}

/**
 * `width`/`height` presentational hints, omitted when either side is unknown.
 *
 * `PageStore.getFile` reports a row that never recorded its dimensions as
 * 0x0, and an `<img width="0">` is invisible: the CSS in globals.css relaxes
 * the height (`height: auto`) but not the width, so the hint stands. No
 * attribute at all means natural size, which is the honest answer when the
 * wiki does not know the box.
 */
function sizeAttrs(width: number, height: number): string {
  if (width <= 0 || height <= 0) return "";
  return ` width="${width}" height="${height}"`;
}

function renderImage(node: ImageLink, st: RenderState): string {
  const target = fileTitle(node.file);
  const file = st.ctx.store.getFile(fileStoreKey(node.file));
  if (!node.exists || file === null) {
    // §5.9: missing file → red link to the file page, filename as the text.
    return redLink(target, node.file, st.ctx);
  }

  const captionHtml = renderInlineNodes(node.caption, st);
  const captionText = withoutMarkers(stripTags(captionHtml));
  const box = scaleBox({ width: file.width, height: file.height }, node, st.ctx);
  const alt = node.alt ?? (captionText !== "" ? captionText : node.file);
  const cls = node.border ? ` class="mw-image-border"` : "";
  const valign =
    node.valign !== undefined && node.format === "inline"
      ? ` style="vertical-align:${escapeAttr(node.valign)}"`
      : "";
  const img =
    `<img src="${escapeAttr(file.src)}" alt="${escapeAttr(alt)}"` +
    `${sizeAttrs(box.width, box.height)}${cls}${valign} />`;

  const isFigure = node.format === "thumb" || node.format === "frame";
  const linked = wrapImageLink(img, node, st, target, isFigure ? "" : captionText);
  if (!isFigure) return linked;
  const halign = node.halign ?? "right";
  const style =
    node.format === "frame" || box.width <= 0 ? "" : ` style="width:${box.width + 2}px"`;
  return (
    `<figure class="mw-thumb mw-halign-${halign}"${style}>${linked}` +
    `<figcaption>${captionHtml}</figcaption></figure>`
  );
}

function wrapImageLink(
  img: string,
  node: ImageLink,
  st: RenderState,
  target: Title,
  titleText: string,
): string {
  if (node.link === null) return img;
  const titleAttr = titleText === "" ? "" : ` title="${escapeAttr(titleText)}"`;
  if (typeof node.link === "string") {
    if (!hasAllowedScheme(node.link)) return img;
    const rel = st.ctx.config.externalLinkRel;
    const relAttr = rel === "" ? "" : ` rel="${escapeAttr(rel)}"`;
    return `<a href="${escapeAttr(node.link)}" class="external"${relAttr}${titleAttr}>${img}</a>`;
  }
  const linkTarget = node.link ?? target;
  const exists =
    node.link === undefined ? true : st.ctx.store.exists(titleKey(linkTarget));
  const href = escapeAttr(pageHref(linkTarget, st.ctx, exists));
  return `<a href="${href}" class="mw-file"${titleAttr}>${img}</a>`;
}

/* ------------------------------------------------------------------ */
/* Galleries (§10.4 + Fandom options §F.2.3)                           */
/* ------------------------------------------------------------------ */

interface GalleryRow {
  file: string;
  exists: boolean;
  alt?: string;
  /** `link=` target as written; `""` means "render the image unlinked". */
  link?: string;
  captionHtml: string;
}

/**
 * `link=` on a gallery item (§10.4 per-item options). An empty value means no
 * link at all; a value with an allowed URL scheme becomes an external link;
 * anything else is a page title.
 */
function galleryItemHref(link: string, st: RenderState): string | null {
  if (link === "") return null;
  if (hasAllowedScheme(link)) return link;
  const parsed = parseTitle(link, st.ctx.config.namespaces);
  if (parsed === null) return null;
  const target: Title = { namespace: parsed.namespace, pageName: parsed.pageName };
  return pageHref(target, st.ctx, st.ctx.store.exists(titleKey(target)));
}

function renderGalleryItems(
  options: GalleryOptions,
  items: readonly GalleryRow[],
  st: RenderState,
): string {
  const { widths, heights, caption } = options;
  let html = `<ul class="${escapeAttr(galleryClassList(options))}">`;
  if (caption !== undefined && caption !== "") {
    html += `<li class="gallerycaption">${escapeText(caption)}</li>`;
  }
  for (const item of items) {
    const target = fileTitle(item.file);
    html += `<li class="gallerybox" style="width: ${widths + 35}px"><div class="thumb">`;
    const file = item.exists ? st.ctx.store.getFile(fileStoreKey(item.file)) : null;
    if (file === null) {
      html += redLink(target, item.file, st.ctx);
    } else {
      const scale = Math.min(
        file.width > 0 ? widths / file.width : 1,
        file.height > 0 ? heights / file.height : 1,
        1,
      );
      const w = Math.max(1, Math.round(file.width * scale));
      const h = Math.max(1, Math.round(file.height * scale));
      const img =
        `<img src="${escapeAttr(file.src)}" alt="${escapeAttr(item.alt ?? item.file)}"` +
        `${sizeAttrs(file.width > 0 ? w : 0, file.height > 0 ? h : 0)} />`;
      // `link=` overrides the default "link to the file page" behavior.
      const href =
        item.link === undefined
          ? pageHref(target, st.ctx, true)
          : galleryItemHref(item.link, st);
      html +=
        href === null ? img : `<a href="${escapeAttr(href)}" class="mw-file">${img}</a>`;
    }
    html += `</div><div class="gallerytext">${item.captionHtml}</div></li>`;
  }
  return `${html}</ul>`;
}

function renderGalleryNode(node: Gallery, st: RenderState): string {
  const rows: GalleryRow[] = node.items.map((item) => ({
    file: item.file,
    exists: item.exists,
    ...(item.alt !== undefined ? { alt: item.alt } : {}),
    captionHtml: renderInlineNodes(item.caption, st),
  }));
  const options: GalleryOptions = {
    mode: node.attrs.mode === "packed" ? "packed" : "traditional",
    widths: node.attrs.widths,
    heights: node.attrs.heights,
    ...(node.attrs.caption !== undefined ? { caption: node.attrs.caption } : {}),
    ...(node.attrs.class !== undefined ? { extraClass: node.attrs.class } : {}),
  };
  return renderGalleryItems(options, rows, st);
}

/** `<gallery>` reached as a strip payload: one entry per non-blank line. */
function renderGalleryPayload(payload: ExtPayload, st: RenderState): string {
  const options = parseGalleryOptions(payload.attrs ?? {});
  const rows: GalleryRow[] = [];
  for (const rawLine of (payload.inner ?? "").split("\n")) {
    const line = parseGalleryLine(rawLine);
    if (line === null) continue;
    rows.push({
      file: line.file,
      exists: st.ctx.store.getFile(fileStoreKey(line.file)) !== null,
      ...(line.alt !== undefined ? { alt: line.alt } : {}),
      ...(line.link !== undefined ? { link: line.link } : {}),
      captionHtml: line.caption !== "" ? renderWikitextFragment(st, line.caption) : "",
    });
  }
  return renderGalleryItems(options, rows, st);
}

/* ------------------------------------------------------------------ */
/* Block rendering                                                     */
/* ------------------------------------------------------------------ */

function renderBlocks(nodes: readonly BlockNode[], st: RenderState): string {
  let out = "";
  for (const node of nodes) out += renderBlock(node, st);
  return out;
}

function renderBlock(node: BlockNode, st: RenderState): string {
  switch (node.type) {
    case "p": {
      // A paragraph whose whole content disappeared — a lone `[[Category:…]]`
      // line (§5.7 "no output line"), a comment-only line — emits nothing
      // rather than an empty `<p></p>`.
      const inner = renderInlineNodes(node.children, st);
      return inner === "" ? "" : `<p>${inner}</p>`;
    }
    case "hr":
      return "<hr />";
    case "heading": {
      const inner = renderInlineNodes(node.children, st);
      const plain = withoutMarkers(inner);
      // §2.4: the id comes from the RENDERED content, with strip markers
      // (refs, nowiki) removed; ids are deduplicated in document order.
      const id = st.ids.allocate(anchorIdFromHtml(plain));
      st.headings.push({ level: node.level, id, html: plain });
      return `<h${node.level} id="${escapeAttr(id)}">${inner}</h${node.level}>`;
    }
    case "pre": {
      const attrs = node.attrs ? serializeAttrs(filterAttributes("pre", node.attrs)) : "";
      if (node.literal) {
        const text = node.children
          .map((child) =>
            child.type === "text" ? escapeAll(child.value) : renderInlineNode(child, st),
          )
          .join("");
        return `<pre${attrs}>${text}</pre>`;
      }
      return `<pre${attrs}>${renderInlineNodes(node.children, st)}</pre>`;
    }
    case "list": {
      const tag = node.ordered ? "ol" : "ul";
      const attrs = node.attrs ? serializeAttrs(filterAttributes(tag, node.attrs)) : "";
      let html = `<${tag}${attrs}>`;
      for (const item of node.items) {
        html += `<li>${renderMixedChildren(item.children, st)}</li>`;
      }
      return `${html}</${tag}>`;
    }
    case "dl": {
      let html = "<dl>";
      for (const item of node.items) {
        const tag = item.type === "dt" ? "dt" : "dd";
        html += `<${tag}>${renderMixedChildren(item.children, st)}</${tag}>`;
      }
      return `${html}</dl>`;
    }
    case "table":
      return renderTable(node, st);
    case "html-block":
      // NON-WRAPPING by contract (blocks.ts header, §3.1 rule 4): the raw
      // block-level tag that triggered the exemption is already among the
      // inline children, so `tag`/`attrs` are informational only and this
      // stage must never synthesize a second element around them.
      return renderMixedChildren(node.children, st);
    case "toc":
      return "";
    case "references":
      return st.refs.flush(node.group);
    case "gallery":
      return renderGalleryNode(node, st);
    case "redirect":
      return renderRedirect(node.target, node.targetText, st);
    default:
      return "";
  }
}

function renderMixedChildren(
  children: readonly (InlineNode | BlockNode)[],
  st: RenderState,
): string {
  let out = "";
  for (const child of children) {
    out += isBlockNode(child) ? renderBlock(child, st) : renderInlineNode(child, st);
  }
  return out;
}

function renderTable(node: Table, st: RenderState): string {
  let out = "";
  // §7.7: content fostered out of the table is emitted before it.
  if (node.fostered.length > 0) out += renderBlocks(node.fostered, st);
  out += `<table${serializeAttrs(filterAttributes("table", node.attrs))}>`;
  if (node.caption) {
    out +=
      `<caption${serializeAttrs(filterAttributes("caption", node.caption.attrs))}>` +
      `${renderInlineNodes(node.caption.children, st)}</caption>`;
  }
  out += "<tbody>";
  for (const row of node.rows) {
    out += `<tr${serializeAttrs(filterAttributes("tr", row.attrs))}>`;
    for (const cell of row.cells) {
      const tag = cell.header ? "th" : "td";
      out += `<${tag}${serializeAttrs(filterAttributes(tag, cell.attrs))}>`;
      out += renderBlocks(cell.children, st);
      out += `</${tag}>`;
    }
    out += "</tr>";
  }
  return `${out}</tbody></table>`;
}

/** §12.3 redirect page box. */
function renderRedirect(target: Title, targetText: string, st: RenderState): string {
  const exists = st.ctx.store.exists(titleKey(target));
  const href = escapeAttr(pageHref(target, st.ctx, exists));
  const display = escapeAttr(fullTitleText(target, st.ctx));
  const cls = exists ? "" : ` class="new red-link"`;
  return (
    `<div class="redirectMsg"><p>${escapeText(st.ctx.config.messages.redirectTo)}</p>` +
    `<ul class="redirectText"><li>` +
    `<a href="${href}"${cls} title="${display}">${escapeText(targetText)}</a>` +
    `</li></ul></div>`
  );
}

/* ------------------------------------------------------------------ */
/* Extension-tag payloads (§10) + strip-marker restoration (§14.8)     */
/* ------------------------------------------------------------------ */

function resolveExtPayload(payload: ExtPayload, st: RenderState): string {
  const attrs = payload.attrs ?? {};
  const group = attrs.group ?? "";
  const name = attrs.name !== undefined && attrs.name !== "" ? attrs.name : null;
  switch (payload.tag) {
    case "ref": {
      const body =
        payload.inner === null || payload.inner.trim() === ""
          ? null
          : renderWikitextFragment(st, payload.inner);
      return st.refs.use(group, name, body);
    }
    case RENDERED_REF_TAG:
      return st.refs.use(group, name, payload.inner);
    case "references": {
      // Definitions in the body still register HERE, in document order, so a
      // ref that only ever appears inside `<references>` keeps its number.
      collectReferencesBody(payload.inner, group, st);
      // The list itself is emitted by pass 2 (see `flushDeferredReferences`).
      const marker = mintMarker(st, DEFERRED_REFS_NAME);
      st.deferredRefs.set(marker, group);
      return marker;
    }
    case "gallery":
      return renderGalleryPayload(payload, st);
    case "tabber":
      return renderTabberPayload(payload, st);
    case "poem":
      return renderPoemPayload(payload, st);
    case "infobox":
      return renderInfoboxPayload(payload, st);
    default:
      // Unknown extension tag: emit nothing rather than leak raw markup.
      return "";
  }
}

/**
 * Fandom ext §F.2.1. Panels are full block wikitext, so each one goes through
 * stages 3–5 on the shared `RenderState`; the widget itself is CSS-only, so a
 * reader with JavaScript disabled can still reach every panel.
 */
function renderTabberPayload(payload: ExtPayload, st: RenderState): string {
  const tabs = parseTabber(payload.inner ?? "");
  if (tabs.length === 0) return "";
  st.tabberSeq += 1;
  const uid = String(st.tabberSeq);
  const rendered: RenderedTab[] = tabs.map((tab) => ({
    title: tab.title,
    html: tab.source === "" ? "" : renderWikitextBlockFragment(st, tab.source),
  }));
  return renderTabberHtml(rendered, uid);
}

/** Fandom ext §F.2.2: newlines become `<br />`, the rest stays wikitext. */
function renderPoemPayload(payload: ExtPayload, st: RenderState): string {
  const source = poemWikitext(payload.inner ?? "");
  const html = source === "" ? "" : renderWikitextFragment(st, source);
  return renderPoemHtml(html, payload.attrs?.class);
}

/**
 * Fandom portable infobox. Stage 2 already resolved every `source=` against the
 * template frame and applied the empty rule, so the payload's `inner` is the
 * finished {@link InfoboxModel}; all that is left is turning its (still
 * wikitext) values into inline HTML on the shared `RenderState`, exactly as a
 * `<gallery>` caption is rendered — which is what keeps `[[links]]`, `<ref>`s
 * and strip markers inside an infobox value working page-wide.
 */
function renderInfoboxPayload(payload: ExtPayload, st: RenderState): string {
  const model = decodeInfoboxModel(payload.inner);
  if (model === null) return "";
  return renderPortableInfobox(model, {
    renderInline: (wikitext: string) => renderWikitextFragment(st, wikitext),
  });
}

/**
 * §10.3: a `<references>` body may contain `<ref name=…>…</ref>` definitions.
 * Stage 2 has already turned those into strip markers inside `inner`, so the
 * markers are looked up here; the literal-tag fallback covers a body that never
 * went through expansion.
 */
function collectReferencesBody(
  inner: string | null,
  group: string,
  st: RenderState,
): void {
  if (inner === null || inner.trim() === "") return;

  const re = markerRegex();
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    const value = st.strips.get(m[0]) ?? st.local.get(m[0]);
    if (value === undefined) continue;
    const payload = decodeExtPayload(value) ?? decodeLocalPayload(value);
    if (!payload) continue;
    if (payload.tag !== "ref" && payload.tag !== RENDERED_REF_TAG) continue;
    const name = payload.attrs?.name;
    if (name === undefined || name === "") continue;
    const body =
      payload.tag === RENDERED_REF_TAG
        ? (payload.inner ?? "")
        : renderWikitextFragment(st, payload.inner ?? "");
    st.refs.define(payload.attrs?.group ?? group, name, body);
  }

  const tagRe = /<ref\b([^>]*)>([\s\S]*?)<\/ref\s*>/gi;
  let t: RegExpExecArray | null;
  while ((t = tagRe.exec(inner)) !== null) {
    const attrs = parseSimpleAttrs(t[1] ?? "");
    const name = attrs.name;
    if (name === undefined || name === "") continue;
    st.refs.define(attrs.group ?? group, name, renderWikitextFragment(st, t[2] ?? ""));
  }
}

function parseSimpleAttrs(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out[(m[1] as string).toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}

function decodeLocalPayload(value: string): ExtPayload | null {
  if (!value.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as Partial<ExtPayload>;
    if (typeof p.tag !== "string") return null;
    return {
      tag: p.tag,
      attrs: typeof p.attrs === "object" && p.attrs !== null ? p.attrs : {},
      inner: typeof p.inner === "string" ? p.inner : null,
    };
  } catch {
    return null;
  }
}

/**
 * Restore every strip marker (§14.8), LAST. Values that are not extension
 * payloads are final HTML (nowiki/pre/syntaxhighlight) and go back verbatim.
 * Markers may nest — a ref body may hold a nowiki marker — so the pass
 * iterates, outermost first, with a bound.
 */
function restoreStrips(html: string, st: RenderState): string {
  let out = html;
  for (let round = 0; round < MAX_RESTORE_ROUNDS; round += 1) {
    if (!markerRegex().test(out)) break;
    let changed = false;
    out = out.replace(markerRegex(), (marker: string) => {
      // Deferred reference lists survive every round of pass 1 untouched.
      if (st.deferredRefs.has(marker)) return marker;
      changed = true;
      const value = st.strips.get(marker) ?? st.local.get(marker);
      if (value === undefined) return "";
      const payload = decodeExtPayload(value) ?? decodeLocalPayload(value);
      return payload ? resolveExtPayload(payload, st) : value;
    });
    if (!changed) break;
  }
  return out;
}

/**
 * Pass 2 of the restore (Fandom parity, G3): every `<references />` marker held
 * back by pass 1 is now flushed, left to right, with the registry complete.
 * A page with one `<references />` therefore gets exactly ONE `<ol
 * class="references">` holding every ref on the page — including refs whose
 * only occurrence is inside deferred content such as a `<gallery>` caption —
 * and `autoAppend()` finds nothing pending, so no "Missing <references />"
 * note is emitted.
 */
function flushDeferredReferences(html: string, st: RenderState): string {
  if (st.deferredRefs.size === 0) return html;
  return html.replace(markerRegex(), (marker: string) => {
    const group = st.deferredRefs.get(marker);
    if (group === undefined) return marker;
    st.deferredRefs.delete(marker);
    return st.refs.flush(group);
  });
}

/* ------------------------------------------------------------------ */
/* Stage 6 entry point                                                 */
/* ------------------------------------------------------------------ */

interface Chunk {
  html: string;
  /** The chunk that produced the first wikitext heading. */
  firstHeading?: boolean;
  /** A `__TOC__` placeholder chunk (§2.6). */
  tocPlaceholder?: boolean;
}

/**
 * Stage 6 (§14.7). `deps.renderWikitext` (or the module default set by the
 * pipeline) supplies the inline parser used for ref bodies and gallery
 * captions; the parameter is optional so this stays assignable to
 * `EngineStages["render"]`.
 */
export function render(
  doc: Document,
  ctx: ParseContext,
  strips: StripTable,
  deps: RenderDeps = {},
): RenderResult {
  const meta = doc.meta;
  const st: RenderState = {
    ctx,
    meta,
    ids: new IdAllocator(),
    refs: new RefRegistry(ctx),
    headings: [],
    strips,
    local: new Map(),
    deferredRefs: new Map(),
    markerSeq: 0,
    extLinkSeq: 0,
    tabberSeq: 0,
    renderWikitext: deps.renderWikitext ?? defaultRenderWikitext,
  };

  // 1. Blocks → chunks, remembering where the TOC may go.
  const chunks: Chunk[] = [];
  for (const node of doc.children) {
    if (node.type === "toc") {
      chunks.push({ html: "", tocPlaceholder: true });
      continue;
    }
    const before = st.headings.length;
    const chunk: Chunk = { html: renderBlock(node, st) };
    if (before === 0 && st.headings.length > 0) chunk.firstHeading = true;
    chunks.push(chunk);
  }

  // 2. TOC (§2.5). The outline is always computed (the UI uses it); it is
  //    spliced into the page only when the switches/threshold call for it.
  const toc = buildToc(st.headings);
  meta.toc = toc;
  if (shouldShowToc(st.headings.length, meta.behaviorSwitches)) {
    const tocHtml = renderToc(toc, ctx);
    if (tocHtml !== "") {
      const placeholder = chunks.findIndex((c) => c.tocPlaceholder === true);
      if (placeholder >= 0) {
        (chunks[placeholder] as Chunk).html = tocHtml;
      } else {
        const first = chunks.findIndex((c) => c.firstHeading === true);
        chunks.splice(first >= 0 ? first : chunks.length, 0, { html: tocHtml });
      }
    }
  }

  let html = chunks.map((c) => c.html).join("");

  // 3. Strip markers last (§14.8) — this is where refs get numbered.
  html = restoreStrips(html, st);

  // 3b. Fandom parity: now that every deferred payload has registered its
  //     refs, emit the reference lists their `<references />` tags stand for.
  html = flushDeferredReferences(html, st);

  // 4. §10.3: refs still pending get an automatically appended list.
  const auto = st.refs.autoAppend();
  if (auto !== "") html += flushDeferredReferences(restoreStrips(auto, st), st);

  for (const warning of st.refs.warnings) {
    if (!meta.warnings.includes(warning)) meta.warnings.push(warning);
  }

  return { html, toc, refs: { ...st.refs.counts } };
}
