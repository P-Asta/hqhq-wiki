/**
 * Fandom PORTABLE INFOBOX — the `<infobox>` extension tag (Fandom parity).
 *
 * Normative source: docs/engine/wikitext-spec.md → "Fandom extensions" →
 * "Portable infobox (`<infobox>`)". The host-engine rules it plugs into are
 * §10 (extension tags), §14.3 (stage 2 / frames) and §14.8 (strip markers).
 *
 * `<infobox>` is PARSER-LEVEL markup, not raw HTML: preprocessor.ts registers
 * it in the extension-tag table, so §11 never escapes it and its body is
 * captured verbatim (its children — `<data>`, `<default>`, … — are ours, not
 * the sanitizer's). The tag is then handled in three steps:
 *
 *   1. parse    — `parseInfoboxMarkup()` turns the body into an element tree.
 *                 Only element names legal in the current parent are treated
 *                 as markup; every other `<…>` stays verbatim wikitext, so
 *                 `<br />` or `<span>` inside a `<default>` survives.
 *   2. resolve  — `resolveInfobox()` runs in STAGE 2 (expand.ts), because
 *                 `source="cost"` binds to the CURRENT FRAME's template
 *                 argument (§14.3) and `<format>`/`<default>`/`<label>` are
 *                 wikitext that must expand in that same frame. Output is the
 *                 JSON-serializable {@link InfoboxModel}, parked behind a
 *                 strip marker (§14.8) with the empty rule already applied.
 *   3. render   — `renderPortableInfobox()` runs in STAGE 6 (render.ts) and
 *                 turns the model into HTML. Every value is expanded wikitext,
 *                 so it goes through sanitize + inline parse there, exactly
 *                 like a `<gallery>` caption does.
 *
 * The two host interfaces ({@link InfoboxExpandHost}, {@link InfoboxRenderHost})
 * keep this module free of engine internals — and keep the engine's own files
 * down to a handful of added lines each.
 *
 * Class names follow Fandom's (`portable-infobox`, `pi-*`) so the stylesheet
 * can target them; no colors or inline styles are emitted here (theme.md).
 */

import { parseAttributes } from "./preprocessor";
import { escapeAttr } from "./sanitize";

/* ------------------------------------------------------------------ */
/* 1. Markup tree — the XML as written                                 */
/* ------------------------------------------------------------------ */

/** One `<infobox>` child element, as parsed (values still unresolved). */
export interface InfoboxElement {
  /** Lowercased element name. */
  name: string;
  /** Lowercased attribute names → raw values. */
  attrs: Record<string, string>;
  /** Verbatim wikitext written directly inside the element (children excluded). */
  text: string;
  children: InfoboxElement[];
}

/** Elements that may appear directly in an `<infobox>` or a `<group>`. */
const ITEM_TAGS: readonly string[] = [
  "title",
  "image",
  "data",
  "header",
  "group",
  "panel",
  "section",
  "navigation",
];

/**
 * Legal children per element. An element with an EMPTY list is a leaf: its
 * content is captured verbatim up to the matching close tag, so wikitext and
 * raw HTML inside `<default>`/`<format>`/`<label>`/`<header>` are untouched.
 * `<panel>`/`<section>` are Fandom's tabbed/older containers; we treat both as
 * groups (documented divergence).
 */
const CHILDREN: Readonly<Record<string, readonly string[]>> = {
  infobox: ITEM_TAGS,
  group: ITEM_TAGS,
  panel: ITEM_TAGS,
  section: ITEM_TAGS,
  data: ["label", "default", "format"],
  title: ["default", "format"],
  image: ["caption", "default", "alt"],
  caption: ["default", "format"],
  header: [],
  navigation: [],
  label: [],
  default: [],
  format: [],
  alt: [],
};

/** `<name attrs>`, `</name>` or `<name attrs/>` — attributes stay raw. */
const TAG_RE = /<(\/?)([A-Za-z][A-Za-z0-9_-]*)([^<>]*?)(\/?)>/y;

function isLeaf(name: string): boolean {
  const kids = CHILDREN[name];
  return kids !== undefined && kids.length === 0;
}

function isAllowedChild(parent: string, child: string): boolean {
  return (CHILDREN[parent] ?? []).includes(child);
}

/** Non-greedy `</name>` search; an unclosed element runs to the end (§10). */
function findClose(source: string, name: string, from: number): { end: number; next: number } {
  const re = new RegExp("</" + name + "\\s*>", "gi");
  re.lastIndex = from;
  const m = re.exec(source);
  if (!m) return { end: source.length, next: source.length };
  return { end: m.index, next: m.index + m[0].length };
}

function appendText(stack: InfoboxElement[], text: string): void {
  if (text === "") return;
  const top = stack[stack.length - 1];
  top.text += text;
}

function lastIndexOfName(stack: InfoboxElement[], name: string): number {
  for (let i = stack.length - 1; i > 0; i -= 1) {
    if (stack[i].name === name) return i;
  }
  return -1;
}

/**
 * Parse an `<infobox>` body into its element tree. Tolerant by design: an
 * unknown tag, a stray close tag or a missing close tag degrades to text
 * rather than throwing — a malformed infobox must never break a page.
 */
export function parseInfoboxMarkup(source: string): InfoboxElement[] {
  const root: InfoboxElement = { name: "infobox", attrs: {}, text: "", children: [] };
  const stack: InfoboxElement[] = [root];
  let i = 0;

  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt < 0) {
      appendText(stack, source.slice(i));
      break;
    }
    appendText(stack, source.slice(i, lt));

    TAG_RE.lastIndex = lt;
    const m = TAG_RE.exec(source);
    if (m === null) {
      appendText(stack, "<");
      i = lt + 1;
      continue;
    }
    const name = m[2].toLowerCase();
    const next = TAG_RE.lastIndex;

    if (m[1] === "/") {
      const idx = lastIndexOfName(stack, name);
      if (idx > 0) {
        stack.length = idx;
        i = next;
        continue;
      }
      appendText(stack, "<"); // stray close tag: literal text
      i = lt + 1;
      continue;
    }

    const top = stack[stack.length - 1];
    if (!isAllowedChild(top.name, name)) {
      appendText(stack, "<"); // not markup HERE: leave it to the wikitext parser
      i = lt + 1;
      continue;
    }

    // parseAttributes() is stage 1's own attribute reader (reuse, not a copy).
    const el: InfoboxElement = {
      name,
      attrs: parseAttributes(m[3]),
      text: "",
      children: [],
    };
    top.children.push(el);

    if (m[4] === "/") {
      i = next;
      continue;
    }
    if (isLeaf(name)) {
      const close = findClose(source, name, next);
      el.text = source.slice(next, close.end);
      i = close.next;
      continue;
    }
    stack.push(el);
    i = next;
  }

  return root.children;
}

/* ------------------------------------------------------------------ */
/* 2. Resolved model — what stage 2 hands to stage 6                   */
/* ------------------------------------------------------------------ */

export interface InfoboxTitleItem {
  type: "title";
  source?: string;
  /** Expanded wikitext. */
  value: string;
}

export interface InfoboxImageItem {
  type: "image";
  source?: string;
  /** Expanded wikitext: a bare filename or a `[[File:…]]` link (both legal). */
  value: string;
  caption?: string;
  alt?: string;
}

export interface InfoboxDataItem {
  type: "data";
  source?: string;
  label?: string;
  value: string;
}

export interface InfoboxHeaderItem {
  type: "header";
  value: string;
}

export interface InfoboxNavigationItem {
  type: "navigation";
  value: string;
}

export interface InfoboxGroupItem {
  type: "group";
  layout?: string;
  collapse?: string;
  /** `"incomplete"` — render the group and its empty rows anyway. */
  show?: string;
  items: InfoboxItem[];
}

export type InfoboxItem =
  | InfoboxTitleItem
  | InfoboxImageItem
  | InfoboxDataItem
  | InfoboxHeaderItem
  | InfoboxNavigationItem
  | InfoboxGroupItem;

export interface InfoboxModel {
  theme?: string;
  layout?: string;
  items: InfoboxItem[];
}

/** Stage 2 services: frame arguments (§14.3) and in-frame expansion. */
export interface InfoboxExpandHost {
  /**
   * The current frame's template argument `name`, already expanded, or null
   * when the call did not supply it. On a page rendered outside any template
   * (the template page itself, or an `<infobox>` typed into an article) every
   * source is absent, so `<default>`s apply.
   */
  getArg(name: string): string | null;
  /** Expand wikitext in the current frame (`{{tpl}}`, `{{{param}}}`, `<ref>`…). */
  expand(wikitext: string): string;
}

/* ---------------- resolution helpers ---------------- */

function childByName(el: InfoboxElement, name: string): InfoboxElement | undefined {
  return el.children.find((c) => c.name === name);
}

/** Attribute value reduced to a CSS-safe token, or undefined. */
function cssToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const token = value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return token === "" ? undefined : token;
}

/**
 * Resolve one element's value:
 *
 *   1. `source=` → the frame argument. Non-empty ⇒ `<format>` (expanded in the
 *      frame, where `{{{source}}}` therefore resolves to the same value) or
 *      the raw value.
 *   2. empty/absent ⇒ `<default>` (expanded, NOT formatted — Fandom's rule).
 *   3. still empty ⇒ the element's own text, for the elements whose body is
 *      their content (`<title>`, `<caption>`, `<header>`, `<navigation>`,
 *      `<label>`). `<data>`/`<image>` ignore stray body text, as Fandom does.
 */
function resolveValue(
  el: InfoboxElement,
  host: InfoboxExpandHost,
  useOwnText: boolean,
): string {
  const source = (el.attrs.source ?? "").trim();
  const raw = source === "" ? null : host.getArg(source);
  if (raw !== null && raw.trim() !== "") {
    const format = childByName(el, "format");
    if (format !== undefined) return host.expand(format.text).trim();
    return raw.trim();
  }
  const fallback = childByName(el, "default");
  if (fallback !== undefined) {
    const value = host.expand(fallback.text).trim();
    if (value !== "") return value;
  }
  return useOwnText ? host.expand(el.text).trim() : "";
}

function sourceOf(el: InfoboxElement): string | undefined {
  const source = (el.attrs.source ?? "").trim();
  return source === "" ? undefined : source;
}

function resolveItems(
  elements: readonly InfoboxElement[],
  host: InfoboxExpandHost,
  keepEmpty: boolean,
): InfoboxItem[] {
  const out: InfoboxItem[] = [];
  for (const el of elements) {
    const item = resolveItem(el, host, keepEmpty);
    if (item !== null) out.push(item);
  }
  return out;
}

function resolveItem(
  el: InfoboxElement,
  host: InfoboxExpandHost,
  keepEmpty: boolean,
): InfoboxItem | null {
  switch (el.name) {
    case "title": {
      const value = resolveValue(el, host, true);
      if (value === "") return null;
      const item: InfoboxTitleItem = { type: "title", value };
      const source = sourceOf(el);
      if (source !== undefined) item.source = source;
      return item;
    }
    case "image": {
      // An image with no file can never render anything, `show=` or not.
      const value = resolveValue(el, host, false);
      if (value === "") return null;
      const item: InfoboxImageItem = { type: "image", value };
      const source = sourceOf(el);
      if (source !== undefined) item.source = source;
      const caption = childByName(el, "caption");
      if (caption !== undefined) {
        const text = resolveValue(caption, host, true);
        if (text !== "") item.caption = text;
      }
      const alt = childByName(el, "alt");
      if (alt !== undefined) {
        const text = resolveValue(alt, host, true);
        if (text !== "") item.alt = text;
      }
      return item;
    }
    case "data": {
      const value = resolveValue(el, host, false);
      if (value === "" && !keepEmpty) return null; // THE EMPTY RULE
      const item: InfoboxDataItem = { type: "data", value };
      const source = sourceOf(el);
      if (source !== undefined) item.source = source;
      const label = childByName(el, "label");
      if (label !== undefined) {
        const text = resolveValue(label, host, true);
        if (text !== "") item.label = text;
      }
      return item;
    }
    case "header": {
      const value = resolveValue(el, host, true);
      return value === "" ? null : { type: "header", value };
    }
    case "navigation": {
      const value = resolveValue(el, host, true);
      return value === "" ? null : { type: "navigation", value };
    }
    case "group":
    case "panel":
    case "section":
      return resolveGroup(el, host);
    default:
      return null;
  }
}

/**
 * A group renders only when it has at least one non-`<header>` item left after
 * the empty rule — a group whose data all resolved empty disappears, headers
 * included. `show="incomplete"` reverses that: empty `<data>` rows are kept
 * (label + empty value) so readers can see which fields are missing.
 */
function resolveGroup(el: InfoboxElement, host: InfoboxExpandHost): InfoboxGroupItem | null {
  const show = (el.attrs.show ?? "").trim().toLowerCase();
  const keepEmpty = show === "incomplete";
  const items = resolveItems(el.children, host, keepEmpty);
  if (items.length === 0) return null;
  if (!keepEmpty && !items.some((item) => item.type !== "header")) return null;

  const group: InfoboxGroupItem = { type: "group", items };
  const layout = cssToken(el.attrs.layout);
  if (layout !== undefined) group.layout = layout;
  const collapse = (el.attrs.collapse ?? "").trim().toLowerCase();
  if (collapse === "open" || collapse === "closed") group.collapse = collapse;
  if (keepEmpty) group.show = "incomplete";
  return group;
}

/**
 * Stage 2 entry point: `<infobox>` body + attributes → resolved model.
 * `attrs.theme-source` names a template argument holding the theme, exactly
 * like a value `source=` (Fandom).
 */
export function resolveInfobox(
  inner: string,
  attrs: Record<string, string>,
  host: InfoboxExpandHost,
): InfoboxModel {
  const model: InfoboxModel = {
    items: resolveItems(parseInfoboxMarkup(inner), host, false),
  };
  const themeSource = (attrs["theme-source"] ?? "").trim();
  const theme = cssToken(
    themeSource === "" ? attrs.theme : (host.getArg(themeSource) ?? attrs.theme),
  );
  if (theme !== undefined) model.theme = theme;
  const layout = cssToken(attrs.layout);
  if (layout !== undefined) model.layout = layout;
  return model;
}

/* ---------------- strip-marker payload (§14.8) ---------------- */

/** The model travels as the `inner` string of the tag's `ExtPayload`. */
export function encodeInfoboxModel(model: InfoboxModel): string {
  return JSON.stringify(model);
}

/** Inverse of {@link encodeInfoboxModel}; null when the payload is unusable. */
export function decodeInfoboxModel(value: string | null): InfoboxModel | null {
  if (value === null || value === "") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    const model = parsed as Partial<InfoboxModel>;
    if (!Array.isArray(model.items)) return null;
    return { ...model, items: model.items } as InfoboxModel;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 3. Rendering (stage 6)                                              */
/* ------------------------------------------------------------------ */

/** Stage 6 service: expanded wikitext → inline HTML, on the page's state. */
export interface InfoboxRenderHost {
  renderInline(wikitext: string): string;
}

/**
 * Values are wikitext AND may be multi-line (a `map_layout=` with one entry per
 * line is idiomatic on Fandom). Each line is inline-parsed on its own and the
 * lines are joined with `<br />`, so the break survives instead of collapsing.
 */
function renderValue(value: string, host: InfoboxRenderHost): string {
  if (!value.includes("\n")) return host.renderInline(value);
  return value
    .split("\n")
    .map((line) => host.renderInline(line))
    .join("<br />");
}

function dataSource(source: string | undefined): string {
  return source === undefined ? "" : ` data-source="${escapeAttr(source)}"`;
}

/** Image options we forward to the file-link renderer (§5.9): size + alt/link. */
function isKeptImageOption(option: string): boolean {
  return (
    /^\d+\s*px$/i.test(option) ||
    /^x\d+\s*px$/i.test(option) ||
    /^\d+x\d+\s*px$/i.test(option) ||
    /^upright(?:\s*=\s*[\d.]+)?$/i.test(option) ||
    /^alt\s*=/i.test(option) ||
    /^link\s*=/i.test(option)
  );
}

/** Characters that would break out of the `[[File:…]]` we rebuild. */
function safeFilePart(text: string): string {
  return text.replace(/[[\]{}|<>\n]/g, "").trim();
}

/**
 * `<image source="image">` accepts both forms Fandom accepts: a bare filename
 * (`Artifice_Moon.png`) and a link (`[[Artifice_Moon.png]]`,
 * `[[File:X.png|250px]]`). Both resolve to the same `[[File:…]]`, which the
 * engine's own file-link renderer then draws — including the red-link
 * degradation for a missing file (§5.9). When several images are given, the
 * first one wins.
 */
export function parseInfoboxImageValue(
  value: string,
): { file: string; options: string[] } | null {
  let text = value.trim();
  if (text.startsWith("[[")) {
    const end = text.indexOf("]]", 2);
    text = end < 0 ? text.slice(2) : text.slice(2, end);
  }
  const parts = text.split("|");
  const file = safeFilePart(
    (parts.shift() ?? "").trim().replace(/^:/, "").replace(/^\s*(?:file|image|media)\s*:\s*/i, ""),
  );
  if (file === "") return null;
  const options = parts.map((p) => p.trim()).filter((p) => isKeptImageOption(p));
  return { file, options };
}

/** Add a class to the rendered `<img>` (no-op on a red link — no `<img>`). */
function withImgClass(html: string, cls: string): string {
  const withExisting = /(<img\b[^>]*\sclass=")/i;
  if (withExisting.test(html)) return html.replace(withExisting, `$1${cls} `);
  return html.replace(/<img\b/i, `<img class="${cls}"`);
}

function renderImageItem(item: InfoboxImageItem, host: InfoboxRenderHost): string {
  const spec = parseInfoboxImageValue(item.value);
  if (spec === null) return "";
  const options = [...spec.options];
  if (item.alt !== undefined && !options.some((o) => /^alt\s*=/i.test(o))) {
    const alt = safeFilePart(item.alt);
    if (alt !== "") options.push("alt=" + alt);
  }
  const link = `[[File:${spec.file}${options.length > 0 ? "|" + options.join("|") : ""}]]`;
  const img = withImgClass(host.renderInline(link), "pi-image-thumbnail");
  const caption =
    item.caption === undefined
      ? ""
      : `<figcaption class="pi-item-spacing pi-caption">${renderValue(item.caption, host)}</figcaption>`;
  return `<figure class="pi-item pi-image">${img}${caption}</figure>`;
}

function renderGroupItem(item: InfoboxGroupItem, host: InfoboxRenderHost): string {
  const body = renderItems(item.items, host);
  if (body === "") return "";
  const classes = ["pi-item", "pi-group", "pi-border-color"];
  if (item.collapse !== undefined) classes.push("pi-collapse", "pi-collapse-" + item.collapse);
  if (item.layout === "horizontal") classes.push("pi-horizontal-group");
  return `<section class="${classes.join(" ")}">${body}</section>`;
}

function renderItem(item: InfoboxItem, host: InfoboxRenderHost): string {
  switch (item.type) {
    case "title":
      return (
        `<h2 class="pi-item pi-item-spacing pi-title"${dataSource(item.source)}>` +
        `${renderValue(item.value, host)}</h2>`
      );
    case "header":
      return (
        `<h2 class="pi-item pi-header pi-secondary-font pi-item-spacing pi-secondary-background">` +
        `${renderValue(item.value, host)}</h2>`
      );
    case "navigation":
      return (
        `<nav class="pi-item pi-navigation pi-item-spacing pi-secondary-background">` +
        `${renderValue(item.value, host)}</nav>`
      );
    case "data": {
      const label =
        item.label === undefined
          ? ""
          : `<h3 class="pi-data-label pi-secondary-font">${renderValue(item.label, host)}</h3>`;
      return (
        `<div class="pi-item pi-data pi-item-spacing"${dataSource(item.source)}>${label}` +
        `<div class="pi-data-value pi-font">${renderValue(item.value, host)}</div></div>`
      );
    }
    case "image":
      return renderImageItem(item, host);
    case "group":
      return renderGroupItem(item, host);
    default:
      return "";
  }
}

function renderItems(items: readonly InfoboxItem[], host: InfoboxRenderHost): string {
  let html = "";
  for (const item of items) html += renderItem(item, host);
  return html;
}

/**
 * Stage 6 entry point: resolved model → HTML. An infobox with nothing left to
 * show (every value empty, no defaults) renders NOTHING, not an empty shell.
 */
export function renderPortableInfobox(model: InfoboxModel, host: InfoboxRenderHost): string {
  const body = renderItems(model.items, host);
  if (body === "") return "";
  const classes = ["portable-infobox", "pi-background", "pi-border-color"];
  if (model.theme !== undefined) classes.push("pi-theme-" + model.theme);
  classes.push("pi-layout-" + (model.layout ?? "default"));
  return `<aside class="${classes.join(" ")}">${body}</aside>`;
}
