# Theme: "Vercel" (DECIDED 2026-08-31 by user — supersedes the LC-terminal theme)

Default visual theme for hqhq-wiki. **Light is the default**; dark mode is a first-class
complement (next-themes, `attribute="class"`, `defaultTheme="system"`). The whole app is
authored fresh against these tokens — no styling is inherited from any earlier codebase.

Direction: the Vercel design language. Near-white canvas, near-black ink, a single blue for
links and focus, hairline borders everywhere, generous whitespace, tight letter-spacing on
headings, monospace for technical labels, and color reserved for meaning (links, states) plus
one decorative gradient treatment at hero scale.

## Design tokens (CSS custom properties)

Define on `:root` (light = default), override under `.dark`. Bridge into Tailwind 4 with
`@theme inline` so utilities like `bg-canvas` / `text-ink` / `border-hairline` work.

```css
:root {
  /* canvas & surfaces */
  --canvas: #ffffff;          /* page background */
  --canvas-soft: #fafafa;     /* wells, alternate rows, code blocks */
  --canvas-soft-2: #f2f2f2;   /* pressed/nested wells */
  --surface: #ffffff;         /* cards, infobox, popovers */
  --backdrop: rgba(0, 0, 0, 0.4);

  /* text */
  --ink: #171717;             /* headings, strong, primary buttons */
  --body: #444444;            /* body text */
  --mute: #666666;            /* secondary text, captions */
  --faint: #999999;           /* placeholders, disabled */

  /* lines */
  --hairline: #eaeaea;
  --hairline-strong: #cccccc;

  /* primary action = ink (black buttons, Vercel style) */
  --primary: #171717;
  --on-primary: #ffffff;
  --primary-hover: #383838;

  /* links & states */
  --link: #0070f3;
  --link-hover: #0761d1;
  --link-soft: rgba(0, 112, 243, 0.1);
  --link-red: #ee0000;        /* red links (missing pages) */
  --success: #0070f3;
  --warning: #f5a623;
  --warning-soft: #fff3d8;
  --error: #ee0000;
  --error-soft: #fbeaea;
  --info: #0070f3;
  --info-soft: #e8f1fd;

  /* decorative gradients — hero/empty-state accents ONLY, never body text */
  --grad-a-start: #007cf0; --grad-a-end: #00dfd8;   /* develop  */
  --grad-b-start: #7928ca; --grad-b-end: #ff0080;   /* preview  */
  --grad-c-start: #ff4d4d; --grad-c-end: #f9cb28;   /* ship     */

  /* code */
  --code-bg: #fafafa;
  --code-ink: #171717;

  --selection-bg: #79ffe1;    /* cyan selection */
  --selection-fg: #0a0a0a;

  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.06);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.08);
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
}

.dark {
  --canvas: #0a0a0a;
  --canvas-soft: #111111;
  --canvas-soft-2: #1a1a1a;
  --surface: #0f0f0f;
  --backdrop: rgba(0, 0, 0, 0.6);
  --ink: #ededed;
  --body: #a1a1a1;
  --mute: #8f8f8f;
  --faint: #5c5c5c;
  --hairline: #2a2a2a;
  --hairline-strong: #444444;
  --primary: #ededed;
  --on-primary: #0a0a0a;
  --primary-hover: #cccccc;
  --link: #3291ff;
  --link-hover: #52a8ff;
  --link-soft: rgba(50, 145, 255, 0.15);
  --link-red: #ff6166;
  --success: #3291ff;
  --warning: #f7b955;
  --warning-soft: #2a2013;
  --error: #ff6166;
  --error-soft: #2a1314;
  --info: #3291ff;
  --info-soft: #10233d;
  --code-bg: #111111;
  --code-ink: #ededed;
  --selection-bg: #0761d1;
  --selection-fg: #ffffff;
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.5);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.6);
}
```

Every color pair must clear WCAG AA against its background. NEVER hardcode hex in components —
tokens only.

### Role badge colors (`--role-*`)

Account roles carry their own five tokens — `--role-manager`, `--role-site-developer`,
`--role-moderator`, `--role-verifier`, `--role-modded-verifier` — one per identifier in
`src/lib/roles.ts` (`ROLE_META[id].colorVar` names the variable, so the two stay in step).

They are the only token family read through an inline `style={{ color: \`var(…)\` }}` rather than
a Tailwind utility: the role is data, so the class name cannot be known at build time and
Tailwind would purge a computed one. The variable indirection is what keeps the rule above
intact — no component names a color.

The dark values are High Quota HQ's own role colors (its `roleColors` map), lightened where the
original failed AA on `--surface`; the light values are darkened counterparts for white. Anything
added here must clear 4.5:1 against `--surface` in **both** themes.

## Typography

- Everything: **Geist Sans**; code, slugs, revision ids, version chips, infobox labels:
  **Geist Mono** (`--font-mono`). Load BOTH in the root layout.
- Headings: semibold, tight tracking (h1 `-0.04em`, h2/h3 `-0.02em`). Article h2 gets a bottom
  hairline (`border-bottom: 1px solid var(--hairline); padding-bottom: .3em`).
- Body: 16px/1.65 in articles, 14px chrome text.

## Component directives

### Site chrome
- Header: `--canvas` bg, bottom hairline, height 64px. Left: wordmark — a small black rounded
  square with a white mono "HQ" glyph + "High Quota Wiki" semibold (dark mode inverts the
  square). Center/right: search input (hairline, radius-md, focus ring `--link`), locale
  switcher, theme toggle, sign-in (primary black button).
- Footer: hairline top, mute text, small.

### Article surface (`.wiki-prose`)
- Internal links `--link`, underline on hover only; missing pages `--link-red`; external links
  `--link` with a small ↗ (`::after`).
- `.infobox`: float right 300px; `--surface` bg, 1px `--hairline`, `--radius-lg`,
  `--shadow-sm`; title row: semibold `--ink`, bottom hairline (NO colored bar); section header
  rows: 11px uppercase tracking-wide `--mute`; label cells mono 12px `--mute`, value cells
  `--body`; image framed by a hairline, radius-sm. Mobile <720px: full width, no float.
- `.wiki-toc`: `--canvas-soft` bg, hairline, radius-md, padding 16px; "Contents" small
  semibold; numbering in mono `--faint`; [hide] toggle `--link`.
- `.wikitable`: full hairline grid, header row `--canvas-soft` semibold, cell padding 8px 12px,
  radius-md on the wrapper with `overflow-x: auto`.
- `sup.reference` links `--link`; `.references` 13px `--mute`.
- `blockquote`: 3px `--hairline-strong` left border, `--mute` text.
- `pre/code`: `--code-bg`, hairline, radius-md; inline code padded 2px 5px.
- `.version-scoped`: 2px `--link` left border + `--link-soft` tint — marks version-dependent
  passages.
- `.error` / `.wiki-error`: `--error` on `--error-soft`, radius-sm.
- `.notice` divs emitted by seed templates (Stub/Version/Verify) restyle to tonal banners via
  the state tokens (their inline styles set legacy colors — override where the sanitizer's
  allowed inline styles permit, and prefer class-based styling in templates over time).

### Version selector
A chip row under the article title, and nothing else (versioning.md §6): mono 12px chips, hairline
border, radius-md; active chip = `--primary` bg / `--on-primary` text; hover = `--canvas-soft-2`.
One chip per version the page is written for — no registry dropdown, no status words, no span
line. A selection governed by an earlier branch adds one quiet 12px `--mute` caption under the
chips ("Showing v65 — this page's v56 text") — a caption, not an `--info-soft` banner: it
identifies the branch on screen and warns about nothing. No version is privileged here, so there
is no "latest is …" clause and no reset link (versioning.md §6).

An article with no branches renders **no selector at all**: no chips, no wrapper, no note.

In the editor the same row gains per-chip actions, divided from the chip face by a hairline (an
`--on-primary` one on the active chip): an X in `--faint` that removes that version's writing
after a confirming Dialog, and a `+` offering to register a boundary the registry lacks.

Beside the chips sits the row's own `+`: a chip-shaped trigger (dashed `--hairline-strong` border,
mono 12px, `--mute`) opening the shared `ToolbarMenu` panel — `--surface`, hairline, `--radius-md`,
`--shadow-md` — which lists the versions this page does not write for yet and ends in a field for
an id the registry lacks. Dashed because it is the empty slot rather than a version, and a menu
rather than a modal because adding a version is one choice (versioning.md §6).

### Buttons & forms
Primary: `--primary` bg, `--on-primary` text, radius-sm, medium weight, hover
`--primary-hover`. Secondary: `--surface` + hairline, hover `--canvas-soft`. Danger: `--error`.
Inputs: hairline, radius-sm, focus ring 2px `--link` at 40% + border `--link`.

### Banners (`StatusBanner`)
Tonal: info/warning/error soft bg + strong text + hairline of the tone; radius-md; 13px.

### Hero (home page only)
Big tight-tracked heading; ONE gradient word or underline using `--grad-b-*`
(background-clip: text); subtitle `--mute`; below, the category grid as hairline cards
(radius-lg, hover: `--shadow-md` + translateY(-1px)).

### Fandom class inventory

Every class the Fandom extensions emit, and its treatment under `.wiki-prose` in
`src/app/globals.css`. Tokens only — no hardcoded color anywhere in this table.
Grammar reference: `wikitext-spec.md` → "Fandom extensions".

**Portable infobox** (`<infobox>` markup → `<aside>`; mirrors the `.infobox` directives above)

| Class | Treatment |
|---|---|
| `.portable-infobox` | Float right, 300px, `--surface`, 1px `--hairline`, `--radius-lg`, `--shadow-sm`, `overflow: hidden`, 13px/1.5 `--body` |
| `.pi-background` | `--surface` |
| `.pi-border-color` | `border-color: var(--hairline)` |
| `.pi-secondary-background` | `--canvas-soft` (header and navigation rows) |
| `.pi-secondary-font` | `--font-mono` |
| `.pi-font` | Inherited body face |
| `.pi-item-spacing` | The shared row padding, 8px 12px |
| `.pi-title` | 15px semibold `--ink`, centered, bottom hairline. **No colored bar** |
| `.pi-header` | 11px uppercase, tracking `.06em`, `--mute`, hairline above and below |
| `.pi-data` | The label/value grid: `38% 1fr`, hairline top rule |
| `.pi-data-label` | Mono 12px `--mute` |
| `.pi-data-value` | `--body`; `overflow-wrap: anywhere`; spans both columns when the row has no label |
| `.pi-image` | Centered figure, no margin |
| `.pi-image-thumbnail` | Framed: 1px `--hairline`, `--radius-sm`, `max-width: 100%` |
| `.pi-caption` | 12px `--mute`, centered |
| `.pi-navigation` | 12px `--mute`, centered, hairline top |
| `.pi-group` | Hairline top rule; first child's own rule suppressed |
| `.pi-horizontal-group` | Flex row of equal columns, each centered |
| `.pi-layout-*` / `.pi-theme-*` | `stacked` collapses the grid to one column (label above value); other values inherit the default card |
| `.pi-collapse`, `.pi-collapse-open/-closed` | **Never hides content** — collapsing is a JS affordance, and a reader must not lose a value to a control that does not exist. Marked with a rule only |
| Mobile `<720px` | Full width, no float |

**Tabber** (`<tabber>`, §F.2.1) — CSS-only, works with JavaScript disabled

| Class | Treatment |
|---|---|
| `.tabber` | `display: flex; flex-wrap: wrap` — labels `order: 1`, panels `order: 2` at 100% width |
| `.tabber-input` | The driving radio: visually hidden but **still focusable** (absolute, 1px, `opacity: 0`; never `display: none`), so arrow-key tab switching survives |
| `.tabber-tabs` / `.tabber-tab` | Tab label: 14px medium `--mute`, 2px transparent bottom border, `-1px` bottom margin so its underline meets the panel rule; hover `--ink` |
| `.tabber-input:checked + .tabber-tab` | Active tab: `--ink` text and `--ink` underline |
| `.tabber-input:focus-visible + .tabber-tab` | 2px `--link` outline, offset 2 (the Rules focus requirement) |
| `.tabber-panel` | `display: none` unless its radio is `:checked`; hairline top rule, 1em top padding |

**Poem** (`<poem>`, §F.2.2)

| Class | Treatment |
|---|---|
| `.poem` | 2px `--hairline` left rule, 1em left padding, 1.7 line-height, `--body` |

**Gallery options** (§F.2.3; the base `.gallery` grid is specified with the image styles)

| Class | Treatment |
|---|---|
| `.mw-gallery-traditional` | Default — framed `.thumb` card |
| `.mw-gallery-packed` | Unframed `.thumb`, hairline directly on the image |
| `.mw-gallery-nolines` | Unframed `.thumb`, flush caption |
| `.mw-gallery-spacing-small/-medium/-large` | Grid `gap`: 6 / 12 / 22px |
| `.mw-gallery-captionalign-left/-center/-right` | `text-align` on `.gallerytext` |
| `.mw-gallery-position-left/-center/-right` | `justify-content` on the `<ul>` |

**Sortable tables** (§F.2.4)

| Class | Treatment |
|---|---|
| `table.sortable` | No affordance on its own — the server-rendered table must not advertise a control that does not exist yet |
| `table.sortable.sortable-ready` | Added by the client island once hydrated; unlocks everything below |
| `th[role~="button"]` | `cursor: pointer`, `user-select: none`, 24px right padding for the indicator; hover `--canvas-soft-2`; `:focus-visible` 2px `--link` outline |
| `th[aria-sort="none"]::after` | Dim mono `↕` in `--faint` |
| `th[aria-sort="ascending"\|"descending"]::after` | Solid `↑` / `↓` in `--ink` |
| `th.unsortable`, `table.unsortable th` | Indicator and pointer suppressed |

**Fandom-authored classes appearing in article wikitext**

| Class | Treatment |
|---|---|
| `.fandom-table` | Fandom's table class, used **instead of** `.wikitable` in imported articles, so it gets the full grid: 1px `--hairline` border, `--radius-md`, `overflow: hidden`, 8px 12px cells, `--canvas-soft` semibold `--ink` header row, `--mute` caption |
| `.terminal-text` | The in-game terminal readout quoted on moon pages: `--code-bg` well, hairline + 3px `--hairline-strong` left rule, `--radius-md`, mono 13px `--code-ink`. Deliberately **not** green-on-black — the Rules reserve color for meaning |
| `.mw-ref-warning` | Already specified with the references styles: `--warning` on `--warning-soft`, `--warning` hairline, `--radius-sm`, 13px |

## Rules
- No decorative color outside the hero gradients. State colors only for state.
- Dark mode must be complete — every token pair defined above, no light-only styling.
- Focus states visible everywhere (`.focus-ring` utility: 2px `--link` outline offset 2).

## Source editor (`/edit`)

Fandom's source editor, drawn in this token system. Nothing here introduces a
new hue outside the `--syntax-*` scale defined below.

- **Header strip**: page heading (h1, 20px, tracking `-0.03em`), then a
  right-aligned cluster — a Source/Split/Preview segmented control (hairline
  box, active segment `--primary` / `--on-primary`), a secondary Cancel, and the
  primary "Save changes", disabled until the buffer is dirty. Bottom hairline.
- **Toolbar**: one wrapping row in a `--canvas-soft` well with a hairline and
  `--radius-md`; ghost icon buttons 32px tall, mono glyphs, groups separated by
  a 1px `--hairline` divider. Dropdowns and the special-characters grid are
  `--surface` popovers with a hairline and `--shadow-md`.
- **Source surface**: a `--canvas-soft` frame (hairline, `--radius-md`,
  focus-within = `--link` border + ring). Left, a `--canvas-soft-2` gutter of
  mono line numbers in `--faint`; right, a syntax-highlighted `<pre>` mirror
  under a transparent `<textarea>` whose caret is `--ink`. The two layers share
  one rule (`.wiki-source-layer` in globals.css) — Geist Mono 13px/20px,
  `tab-size: 4`, `white-space: pre`, no letter-spacing — because any metric that
  differs between them drifts the caret off its glyph.
- **Right rail**: a `--surface` card (hairline, `--radius-lg`) of sections split
  by hairlines; section titles 11px uppercase tracking-wide `--mute`; category
  chips are hairline pills on `--canvas-soft`. Stacks under the editor below
  `lg`.
- **Preview**: the real `.wiki-prose` surface, so it matches the article page
  exactly. No version control of its own: the strip above the editing surface
  picks the branch for both modes (versioning.md §6).

### Source editor syntax tokens

Wikitext highlighting is the one place the app needs a categorical palette, so
it gets its own named scale rather than borrowing state colors. Defined on
`:root`, overridden under `.dark`, bridged into Tailwind as
`text-syntax-*`.

| Token | Paints | Light | Dark |
|---|---|---|---|
| `--syntax-comment` | `<!-- … -->` (italic) | `#8a8a8a` | `#6f6f6f` |
| `--syntax-structure` | list bullets, table markup, `----` | `#525252` | `#a3a3a3` |
| `--syntax-heading` | `=` runs (semibold) | `#0f766e` | `#5eead4` |
| `--syntax-emphasis` | `'''` / `''` markers | `#a16207` | `#fbbf24` |
| `--syntax-link` | `[[`, link target, `\|`, `]]` | `#0070f3` | `#3291ff` |
| `--syntax-label` | link display text / external label | `#047857` | `#4ade80` |
| `--syntax-external` | `[https://…` opener and its `]` | `#1d4ed8` | `#93c5fd` |
| `--syntax-template` | `{{ … }}` and its separators | `#be185d` | `#f472b6` |
| `--syntax-param` | `{{{ … }}}` and its separators | `#9333ea` | `#d8b4fe` |
| `--syntax-tag` | `<tags>` and `&entities;` | `#c2410c` | `#fdba74` |

The body of a raw-text tag (`<nowiki>`, `<pre>`) is `--mute`, and ordinary prose
keeps `--body`, so the highlighting reads as accents on normal text rather than
as a colored block. Rule unchanged: no hardcoded hex in components — these
tokens are the only source.
