/**
 * Fandom extension tags: `<tabber>` and `<poem>`, plus the Fandom/MediaWiki
 * `<gallery>` option vocabulary (spec "Fandom extensions" §F.2 "Tabber, poem,
 * gallery options, sortable tables", extending §10.4 / §10.7).
 *
 * This module is PURE: it turns tag source into a small description that
 * render.ts (stage 6, §14.7) turns into HTML, and it owns the HTML shape for
 * everything whose content is already-rendered HTML. Nothing here touches the
 * ParseContext or the store, so it is trivially testable.
 *
 * ---------------------------------------------------------------------------
 * HTML CLASS CONTRACT (globals.css styles exactly these tokens)
 * ---------------------------------------------------------------------------
 *   .tabber                   tab group wrapper (flex row of labels + panels)
 *   .tabber-input             the visually-hidden radio driving one panel
 *   .tabber-tabs .tabber-tab  one clickable tab label (both classes emitted)
 *   .tabber-panel             one `<section>` panel, `display:none` unless its
 *                             radio is `:checked` — works with NO JavaScript
 *   .poem                     `<div>` wrapping a poem, newlines kept as `<br>`
 *   .mw-gallery-traditional|packed|nolines      `<gallery mode=…>`
 *   .mw-gallery-spacing-small|medium|large      `<gallery spacing=…>`
 *   .mw-gallery-captionalign-left|center|right  `<gallery captionalign=…>`
 *   .mw-gallery-position-left|center|right      `<gallery position=…>`
 */

/* ------------------------------------------------------------------ */
/* §F.2.1 `<tabber>`                                                   */
/* ------------------------------------------------------------------ */

/** One parsed tab: a plain-text title and the wikitext of its panel. */
export interface TabberTab {
  title: string;
  /** Expanded wikitext; the caller renders it as a BLOCK fragment. */
  source: string;
}

/** `<tab name="X">…</tab>` — the newer Fandom form. */
const TAB_ELEMENT_RE = /<tab\b([^>]*)>([\s\S]*?)<\/tab\s*>/gi;

/** `name="X"` / `name='X'` / `name=X` inside a `<tab>` open tag. */
const TAB_NAME_RE = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

/**
 * A tab TITLE line: everything before the first `=`, on the chunk's first
 * line, with no markup characters in it. Keeping the character class tight is
 * what stops `[[File:X|a=b]]` or `{{tpl|a=b}}` on the first line of a panel
 * from being mistaken for a title, and what makes `==Heading==` fall through
 * (its title would be empty).
 */
const TAB_TITLE_RE = /^[ \t]*([^\n={}[\]|<>]{1,120})=/;

/** The legacy Fandom separator between tabs. */
const TAB_SEPARATOR_RE = /\|-\|/;

/**
 * Parse the body of `<tabber>` into tabs.
 *
 * Two accepted syntaxes (§F.2.1):
 *
 * 1. Element form — `<tab name="Title">content</tab>` repeated.
 * 2. Legacy Fandom form — chunks separated by `|-|`, each chunk optionally
 *    opening with `Title=`. A chunk with no title line is appended to the
 *    previous tab, which is what makes the compact spelling
 *    `Title=|-|content|-|Next=|-|content` parse the same as the conventional
 *    `Title=\ncontent\n|-|\nNext=\ncontent`.
 *
 * Returns `[]` for a body with no usable content, so the caller can emit
 * nothing rather than an empty widget.
 */
export function parseTabber(inner: string): TabberTab[] {
  const body = inner.replace(/^\n/, "");
  if (/<tab\b[^>]*>[\s\S]*?<\/tab\s*>/i.test(body)) return parseTabElements(body);
  return parseTabberLegacy(body);
}

function parseTabElements(body: string): TabberTab[] {
  const tabs: TabberTab[] = [];
  TAB_ELEMENT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAB_ELEMENT_RE.exec(body)) !== null) {
    const attrs = m[1] ?? "";
    const name = TAB_NAME_RE.exec(attrs);
    const title = (name?.[1] ?? name?.[2] ?? name?.[3] ?? "").trim();
    tabs.push({
      title: title === "" ? `Tab ${tabs.length + 1}` : title,
      source: trimPanel(m[2] ?? ""),
    });
  }
  return tabs;
}

function parseTabberLegacy(body: string): TabberTab[] {
  const tabs: TabberTab[] = [];
  for (const rawChunk of body.split(TAB_SEPARATOR_RE)) {
    // The title must be the chunk's first non-blank line: the conventional
    // spelling puts a newline after each `|-|`, so leading blank lines are
    // dropped before matching (they carry no meaning inside a panel either).
    const chunk = rawChunk.replace(/^[ \t]*\n+/, "");
    const m = TAB_TITLE_RE.exec(chunk);
    const title = m ? (m[1] as string).trim() : "";
    if (m !== null && title !== "") {
      tabs.push({ title, source: trimPanel(chunk.slice((m[0] as string).length)) });
      continue;
    }
    const content = trimPanel(chunk);
    if (content === "") continue;
    const last = tabs[tabs.length - 1];
    if (last === undefined) {
      tabs.push({ title: "Tab 1", source: content });
    } else {
      last.source = last.source === "" ? content : `${last.source}\n${content}`;
    }
  }
  return tabs;
}

/** Panels are block fragments: drop the framing blank lines, keep the middle. */
function trimPanel(source: string): string {
  return source.replace(/^\n+/, "").replace(/\s+$/, "");
}

/** A tab whose panel HTML has already been produced by stage 6. */
export interface RenderedTab {
  title: string;
  html: string;
}

/**
 * Emit the no-JavaScript tab widget. Each tab contributes three siblings in
 * document order — radio, label, panel — so the active panel is selected by
 * the adjacent-sibling rule
 * `.tabber-input:checked + .tabber-tab + .tabber-panel`. That needs no
 * `:has()`, no per-index CSS and no upper bound on tab count; `order:` on the
 * flex container is what lifts every label into the tab row above the panels.
 *
 * `uid` must be unique on the page — render.ts allocates it from a per-page
 * counter so the radio `name` groups stay separate.
 */
export function renderTabberHtml(tabs: readonly RenderedTab[], uid: string): string {
  if (tabs.length === 0) return "";
  const group = `tabber-${uid}`;
  let html = `<div class="tabber">`;
  tabs.forEach((tab, index) => {
    const id = `${group}-${index + 1}`;
    const checked = index === 0 ? " checked" : "";
    html +=
      `<input class="tabber-input" type="radio" name="${escapeAttr(group)}"` +
      ` id="${escapeAttr(id)}"${checked} />` +
      `<label class="tabber-tabs tabber-tab" for="${escapeAttr(id)}">` +
      `${escapeText(tab.title)}</label>` +
      `<section class="tabber-panel" aria-label="${escapeAttr(tab.title)}">` +
      `${tab.html}</section>`;
  });
  return `${html}</div>`;
}

/* ------------------------------------------------------------------ */
/* §F.2.2 `<poem>`                                                     */
/* ------------------------------------------------------------------ */

/**
 * Rewrite a poem body into wikitext whose line breaks survive the inline
 * parse: one `<br />` per newline (the sanitizer §11.1 allows `<br>`), and
 * leading indentation turned into `&nbsp;` so a leading space cannot be
 * mistaken for the §3.2 space-pre rule. Everything else stays wikitext, so
 * links, apostrophes, entities and refs still parse.
 */
export function poemWikitext(inner: string): string {
  const body = inner.replace(/^\n/, "").replace(/\n[ \t]*$/, "");
  return body
    .split("\n")
    .map((line) => {
      const m = /^[ \t]+/.exec(line);
      if (m === null) return line;
      const indent = (m[0] as string).replace(/\t/g, "        ").length;
      return "&nbsp;".repeat(indent) + line.slice((m[0] as string).length);
    })
    .join("<br />\n");
}

/** Wrap already-rendered poem HTML. `<poem class="x">` appends to the class. */
export function renderPoemHtml(html: string, extraClass?: string): string {
  const cls =
    extraClass !== undefined && extraClass.trim() !== ""
      ? `poem ${extraClass.trim()}`
      : "poem";
  return `<div class="${escapeAttr(cls)}">${html}</div>`;
}

/* ------------------------------------------------------------------ */
/* §F.2.3 `<gallery>` options                                          */
/* ------------------------------------------------------------------ */

export type GalleryMode = "traditional" | "packed" | "nolines";

/** Every `<gallery …>` attribute this engine understands. */
export interface GalleryOptions {
  mode: GalleryMode;
  widths: number;
  heights: number;
  caption?: string;
  /** Author `class="…"`, appended verbatim. */
  extraClass?: string;
  spacing?: "small" | "medium" | "large";
  captionalign?: "left" | "center" | "right";
  position?: "left" | "center" | "right";
}

const MODES: ReadonlySet<string> = new Set(["traditional", "packed", "nolines"]);
const SPACINGS: ReadonlySet<string> = new Set(["small", "medium", "large"]);
const ALIGNMENTS: ReadonlySet<string> = new Set(["left", "center", "right"]);

function pick<T extends string>(
  value: string | undefined,
  allowed: ReadonlySet<string>,
): T | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  return allowed.has(v) ? (v as T) : undefined;
}

/** `Npx` / `N` → number; anything else keeps the caller's default (§10.4). */
export function parseGalleryPx(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const m = /^\s*(\d+)\s*(?:px)?\s*$/i.exec(value);
  return m ? Number(m[1]) : fallback;
}

/**
 * Normalize `<gallery>` attributes. `hideaddbutton` is accepted and ignored
 * (on Fandom it only ever controlled the "add a photo" button, which this
 * wiki does not have); unknown `mode` values fall back to `traditional`, per
 * §10.4.
 */
export function parseGalleryOptions(attrs: Record<string, string>): GalleryOptions {
  const options: GalleryOptions = {
    mode: pick<GalleryMode>(attrs.mode, MODES) ?? "traditional",
    widths: parseGalleryPx(attrs.widths, 120),
    heights: parseGalleryPx(attrs.heights, 120),
  };
  if (attrs.caption !== undefined) options.caption = attrs.caption;
  if (attrs.class !== undefined) options.extraClass = attrs.class;
  const spacing = pick<"small" | "medium" | "large">(attrs.spacing, SPACINGS);
  if (spacing !== undefined) options.spacing = spacing;
  const captionalign = pick<"left" | "center" | "right">(attrs.captionalign, ALIGNMENTS);
  if (captionalign !== undefined) options.captionalign = captionalign;
  const position = pick<"left" | "center" | "right">(attrs.position, ALIGNMENTS);
  if (position !== undefined) options.position = position;
  return options;
}

/**
 * The `<ul>` class list for a gallery. The two-token default
 * `gallery mw-gallery-traditional` is unchanged from §10.4 — optional classes
 * are only appended when the corresponding attribute was actually given.
 */
export function galleryClassList(options: GalleryOptions): string {
  const parts = ["gallery", `mw-gallery-${options.mode}`];
  if (options.spacing !== undefined) parts.push(`mw-gallery-spacing-${options.spacing}`);
  if (options.captionalign !== undefined) {
    parts.push(`mw-gallery-captionalign-${options.captionalign}`);
  }
  if (options.position !== undefined) parts.push(`mw-gallery-position-${options.position}`);
  if (options.extraClass !== undefined && options.extraClass !== "") {
    parts.push(options.extraClass);
  }
  return parts.join(" ");
}

/** One `<gallery>` line, split into its file, its options and its caption. */
export interface GalleryLine {
  file: string;
  alt?: string;
  /** `link=` target as written: a page title, a URL, or `""` for "no link". */
  link?: string;
  /** The caption source (wikitext); `""` when the line had no caption. */
  caption: string;
}

/**
 * Split one gallery line. The `File:`/`Image:` prefix is optional; pipes
 * beyond the first are caption text unless they match the two per-item
 * options §10.4 supports (`alt=`, `link=`), which Fandom uses too.
 */
export function parseGalleryLine(rawLine: string): GalleryLine | null {
  const line = rawLine.trim();
  if (line === "") return null;
  const parts = line.split("|");
  const file = (parts.shift() ?? "").replace(/^\s*(?:file|image)\s*:\s*/i, "").trim();
  if (file === "") return null;

  const out: GalleryLine = { file, caption: "" };
  const captionParts: string[] = [];
  for (const part of parts) {
    const alt = /^\s*alt\s*=\s*([\s\S]*)$/i.exec(part);
    if (alt) {
      out.alt = (alt[1] ?? "").trim();
      continue;
    }
    const link = /^\s*link\s*=\s*([\s\S]*)$/i.exec(part);
    if (link) {
      out.link = (link[1] ?? "").trim();
      continue;
    }
    captionParts.push(part);
  }
  out.caption = captionParts.join("|");
  return out;
}

/* ------------------------------------------------------------------ */
/* Local escapers (kept here so the module stays dependency-free)      */
/* ------------------------------------------------------------------ */

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}
