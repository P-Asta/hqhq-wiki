# Version scoping (game-version-aware content) — NORMATIVE

Decision O10, 2026-08-31. Requested behavior: a fact may hold **from v50 through v61**, then
change **at v62**. The reader picks `v50` or `v62` from the article's own selector and sees the
matching text. Version is a *view dimension of one page*, never a separate page — history, links,
translations and search all stay on the single page.

Supersedes the legacy `:::version-tabs` markdown block (docs/version-tabs.md) — that format is
retired with the markdown engine; this replaces it.

---

## 1. Version registry

Table `versions` (admin-managed, see §6):

| column | type | notes |
|---|---|---|
| `id` | TEXT PK | canonical id, lowercase, e.g. `v62`, `v64.1` |
| `label` | TEXT | display label, e.g. `v62`, `v64 Patch 1` |
| `ordinal` | INTEGER NOT NULL UNIQUE | sort key = `major*1000 + minor` (`v62`→62000, `v64.1`→64001) |
| `released_at` | INTEGER NULL | epoch ms; unknown = NULL |
| `notes` | TEXT NULL | changelog blurb |
| `status` | TEXT NOT NULL | `current` \| `supported` \| `legacy` |
| `created_at` | INTEGER NOT NULL | |

Site setting `default_version` (in `site_settings`) names the version used when the reader has not
chosen one. Ordering, "latest", and all range math use `ordinal` — never string compare.

Seed (ids only; labels editable, dates left NULL for editors to fill):
`v45, v47, v49, v50, v55, v56, v60, v62, v64, v66, v68, v69, v70`, `default_version = v70`,
`status`: newest = `current`, rest = `legacy`.

---

## 2. Wikitext syntax

The constructs below are all resolved during **expansion (stage 2)**, so downstream stages see
plain wikitext — version markers therefore work anywhere: inside tables, list items, infobox
parameters, template bodies, headings.

### 2.1 Version tags — the tag NAME is the range

**The version id IS the tag name.**

```wikitext
<v70>text</v70>           the text applies to v70 and to nothing else
<v70+v80>text</v70+v80>   v70 through v80, both ends included
<v70+>text</v70+>         v70 and every later version
```

A version id is `v<major>` or `v<major>.<minor>`, so `<v64.1>`, `<v64.1+v70>` and `<v64.1+>` are
all legal. The closing tag repeats the opening one exactly, compared case-insensitively like every
other tag name (spec §10).

**Prose with no version tag around it belongs to every version.** There is no fallback construct
because none is needed: not writing a tag is the fallback, and it is why a page that reads the same
at every version carries no version markup at all.

```wikitext
The base quota is <v50+v61>'''130'''</v50+v61><v62+>'''180'''</v62+> credits.
```

A version tag is an ordinary extension tag in every other respect (spec §10): its body is
wikitext, expanded in the frame the tag was written in, so a branch may use the arguments of the
template it sits in; an unclosed tag swallows to the end of the input; a closing name that does not
repeat the opening one does not close it, and is left to §10.7. The name is matched **whole**, so
`<var>`, `<video>` and `<v70x>` are not version tags.

Ordering is by ordinal (§1), never string compare. A window whose ends are inverted (`<v80+v70>`)
holds for nothing and renders nothing rather than being silently swapped — putting one version's
text under another version's id is the failure this feature exists to prevent. An id the registry
does not know keeps its derived ordinal (`v99` → 99000), so a tag naming a release nobody has
registered yet still windows sanely, and the id is still recorded as a boundary so the selector can
show that nobody registered it (§6).

Recognition is by shape, in one place: `parseVersionTagName` / `isVersionTag`
(src/lib/wikitext/versions.ts), asked by `isExtTagName` (src/lib/wikitext/preprocessor.ts), which
is the single answer to "extension tag or version tag?". Outside the engine the same shape is
`readVersionTagName` / `versionTagName` (src/lib/version-branches.ts) — the editor may not import
the engine, so the pattern is copied there once and pinned to this one by a drift test, and every
editor surface that meets version markup asks it rather than matching a name of its own.

### 2.2 The grammar this replaced

`<versions>`, `<variant>` and `<version since=… until=… only=…>` were the syntax until 2026-09-03
(user decision); they are no longer recognised, they render escaped like any unknown tag (§10.7),
and every page that used them was converted by `convertLegacyVersionMarkup`
(src/lib/visual-editor/version-tags.ts) and `scripts/migrate-version-tags.ts`, which hold the
mapping and the reasoning for it. `{{#ifversion:}}` and `{{#vswitch:}}` were never part of that
change and are unaffected.

### 2.3 `{{#ifversion: <range> | then | else}}`

For use inside templates and table cells.

Range grammar (whitespace-insensitive, comma = OR):

| form | meaning |
|---|---|
| `v62` | exactly v62 |
| `v50-v61` | v50 ≤ S ≤ v61 |
| `>=v62`, `>v61`, `<=v55`, `<v62` | comparisons on ordinal |
| `v50,v55,>=v62` | OR of the parts |
| `*` | always true |

```wikitext
{{#ifversion: >=v62 | {{Infobox row|Cost|1500}} | {{Infobox row|Cost|1400}} }}
```

### 2.4 `{{#vswitch: v50 = 130 | v62 = 180 | default = ? }}`

Picks the value of the **greatest boundary ≤ selected version**; `default` (optional) is used when
the selected version is below every boundary (absent ⇒ empty string). This is the compact form for
infobox parameters:

```wikitext
{{Infobox moon
| cost = {{#vswitch: v50=1400 | v62=1500 }}
| max_scrap = {{#vswitch: v50=26 | v64=30 }}
}}
```

### 2.5 Magic words

`{{VERSION}}` (selected id), `{{VERSIONLABEL}}`, `{{VERSIONORDINAL}}`, `{{LATESTVERSION}}`
(site default), `{{ISLATESTVERSION}}` (`1`/``). These are **not** volatile: output is cached per
version (§4), and a `default_version` change invalidates the whole render cache (§4).

### 2.6 Errors and edge cases

- Unknown version id in any range ⇒ content hidden, `meta.warnings` entry `unknown-version: <id>`,
  and a `<span class="wiki-error">` rendered in place **only** in preview mode
  (`ctx.preview === true`), never on saved pages. A version *tag* cannot reach this: its name is by
  construction `v<major>[.<minor>]`, which always has a derived ordinal (§2.1), so the rule now
  bites only on `{{#ifversion:}}` / `{{#vswitch:}}` ranges, which still accept arbitrary words.
- A closing name that does not repeat the opening one does not close the tag: `<v50+>x</v62+>` runs
  to the end of the input and the stray closer renders escaped (§10.7). **That is said as well as
  done** (amended 2026-09-05, from a reported page): stage 2 pushes
  `unclosed-version-tag: <name>` into `meta.warnings` whenever a version tag ran to the end of the
  input, because the rendering is right and the *page* is almost always wrong. What it costs is
  invisible in the output — the swallowed text disappears at every version outside the range, and
  any version tag caught inside the swallow is never expanded, so its boundary is never recorded
  (the rule below). The preprocessor carries the fact on `PPExtTag.unclosed`; nothing about what
  renders depends on it.
- Nested tags resolve normally, and a tag inside a branch the selection **hides** is still never
  expanded — but **its boundaries are discovered anyway** (amended 2026-09-05, from a reported
  page). This used to be a documented limitation with the advice "authors should not nest", and the
  report that retired it was not nesting on purpose:

  ```wikitext
  | Cell1 || <v69>aaa</69> || a       ← `</69>` closes nothing (§10.7)
  …
  <v60></v60>
  ```

  A mistyped closer makes `<v69>` swallow the rest of the page, so the author's `<v60>` block ends
  up inside it — and the article's selector lost v60 while the editor's strip, which reads openers
  out of the buffer, still showed it. No amount of advice about nesting covers a typo, and §3's own
  rule is that boundaries are recorded *before* branch selection precisely so the selector can offer
  a branch the current view hides. `recordNestedVersionTags` (expand.ts) therefore scans a hidden
  body for version tags and records what it names. It is a flat scan of the unexpanded text, so it
  finds a tag at any depth without re-entering the expander, and it adds ids to `meta` and nothing
  else: **not one byte of what renders changes.** `{{#ifversion:}}` and `{{#vswitch:}}` inside a
  hidden branch are still not discovered — reading those out of unexpanded wikitext means matching
  template calls with a budget, which this stage has no business growing.

  Stored pages keep the boundaries of the engine that last saved them (they are a derived column,
  `page_locales.version_boundaries`), so `yarn refresh:version-boundaries --apply` recomputes them
  and drops the render cache for whatever moved.
- A page whose every tag excludes the selection renders nothing from them (no placeholder).

---

## 3. Engine contract

`ParseContext` gains:

```ts
/** Selected game version id, or null on version-agnostic renders (search indexing). */
version: string | null;
/** Registry snapshot: id → { ordinal, label }, plus the site default. */
versions: VersionTable;
/** true in /api/preview — surfaces version warnings inline. */
preview?: boolean;
```

`PageMeta` gains:

```ts
/** Every version id named by any version construct reached during expansion. */
versionBoundaries: string[];
/** true when the page contains any version construct (drives selector + cache key). */
versionScoped: boolean;
```

Resolution lives in `src/lib/wikitext/versions.ts`, exporting:
`parseVersionTagName(name)`, `isVersionTag(name)`, `resolveVersionTag(tag, inner, ctx, meta)`,
`parseRange(expr)`, `matchesRange(range, ctx, meta)`, `vswitchPick(pairs, ctx, meta)`,
`compareVersions(a, b, table)`. The expander calls it for version tags (§2.1); the parser-function
module calls it for `#ifversion`/`#vswitch`. Both record boundaries into `meta.versionBoundaries`
**before** branch selection, so the selector lists every boundary on the page even when the current
view hides that content.

When `ctx.version === null`, every construct resolves as if the site default were selected, and
`meta.versionBoundaries` is still filled (used by the search indexer and by link/category
extraction, which must be version-independent — see §5).

---

## 4. Storage, cache, invalidation

- `parsed_cache` primary key becomes **(page_id, locale, version)**. Pages with
  `versionScoped === false` are stored once under version `'*'` and served for every selection.
- A page's `page_locales` row caches `version_scoped` (0/1) and `version_boundaries` (JSON array)
  from the last save, so the view layer knows whether to render a selector without parsing.
- Invalidation additions to db-schema Addendum A3/A4:
  - editing a page ⇒ delete all its cache rows (every version);
  - editing a template ⇒ delete dependents' rows (every version);
  - changing `site_settings.default_version` or any `versions` row ⇒ **flush `parsed_cache`
    entirely** (cheap, derived data) and clear `version_boundaries` staleness by lazy re-parse.
- Search (`search_docs`) indexes the **default-version** rendering only; version-specific text that
  is hidden at the default version is not searchable. Documented tradeoff (avoids N× index size).

---

## 5. Version-independence rules

To keep the link graph and categories stable regardless of what a reader selects:

- `meta.linksTo`, `meta.categories`, `meta.templatesUsed` and `redirect` are extracted with
  `ctx.version = null` (default-version resolution) at save time — one canonical parse.
- A `[[link]]` that exists only inside a `<v62+>` block is therefore recorded when
  the default version is ≥ v62. Documented limitation; acceptable because red-link/wanted-page
  reporting is a maintenance aid, not correctness-critical.
- Categories inside version blocks follow the same rule — a page cannot silently leave a category
  because the reader picked an old version.

---

## 6. UI

### The version selector — the versions this page is written for

**Amended 2026-09-03 (by user): the selector shows the versions this page actually writes for, as
chips, and nothing else. The same control appears in the editor, where each chip can also be
deleted.**

A page branching at v56 and v73 renders identically for every version between them: read at v60,
v65 or v70 it shows the v56 branch. So the control offers the *boundaries* — the versions where
the page says something different — and nothing else at all. `version_boundaries` is exactly that
list, recorded by the engine before branch selection (`versions.ts`) so a branch the current view
hides is still offered. High-quota players run several patches at once; this control is how one
page serves all of them.

What it therefore leaves out, and why each was worth leaving out:

- **The whole registry.** A dropdown listing every version answered "what does a reader on exactly
  v64 see" — a fair question whose answer on this page is "the same as v56", eleven times over. A
  list of thirteen identical renders is noise: its length is a property of the wiki rather than of
  the page in front of you, and it buried the two versions that *do* differ among eleven that do
  not.
- **The status words** (Current / Supported / Legacy). Registry facts, not facts about this
  article, and they made every chip read as a taxonomy.
- **The span each chip covers** ("v56 – v70"). It printed v70 — a registered version this page
  never wrote a word of — on a chip whose whole job is to name what the page *did* write.
- **The compact row on a page with no branches.** Such a page now renders **nothing**: no chips,
  no dropdown, no "this page reads the same on every version" line. No question is being put to
  that reader, so there is nothing to answer and no absence to explain. The `?v=` they arrived
  with still travels on through every link (see Reader affordances) — carrying a selection and
  offering a choice are different jobs, and only the second one needs a control.

Every choice is a plain `?v=` link (server render, no JS). Two rules survive the strip-down,
because they answer what the chips cannot:

1. **The active chip is the branch that GOVERNS the selection, not an id equal to it.** Boundaries
   `[v56, v73]` read at the site default v70 show the v56 branch, so v56 is the active chip. An
   equality test highlights nothing there and leaves the reader unable to tell which branch they
   are looking at — the reason this section was first amended. `pageVersionBranches`
   (src/lib/version-branches.ts) is where that is decided, once, for both surfaces.
2. **A caption names the branch being read.** It says which *branch* is on screen whenever the
   selection is not itself a boundary — "Showing v70 — this page's v56 text" — which is rule 1 in
   words, and no chip can spell it out alone. When the selection *is* a boundary the filled chip
   has already answered it and nothing is printed. It is a quiet line under the chips, not a
   banner: it identifies, it does not warn.

**Amended 2026-09-03 (by user): the site default is where a reader with no opinion starts, not a
destination.** It decides what a URL with no `?v=` renders — that is the whole of its job (§1,
Routes). It is **not** the canonical reading of a page, and the article must never frame it as the
one every other reading is away from. High-quota players run several patches at once, which is the
premise of this whole feature (decisions O10): a page covering v56 and v70 is equally about both.

So the selector prints **no** "latest is v70" clause and offers **no** "reset to latest" link, and
there is no banner left to carry them. Nothing in the control marks one chip as the real version:
the only chip that differs from its neighbours is the one that *governs the current selection*
(rule 1), which is a fact about this reader's `?v=` and not about the registry. The component is
not even passed the default id — the surest way for it not to privilege one — and the dictionary
keys that said otherwise (`version.showing`, `version.reset`) are deleted rather than reworded.

Two things this does **not** touch, because they answer different questions:

- **The unknown-`?v=` warning** (a version the registry lacks, resolved back to the default). There
  the page genuinely is not showing what was asked for, and saying so is not privileging anything.
  It stays a warning banner, in `<PageBanners>`.
- **The default itself.** `?v=`-less URLs still render it, `carriedVersion` still declines to
  append it, and the registry still has a newest row. Only the *framing* in the article changed.

A boundary the registry does not know is shown rather than hidden: the page names it, so somebody
needs to see that nobody registered it (§1).

### Reader affordances
- Version choice persists across navigation via the `v` query param, propagated by the internal
  links of **every** page — a version-scoped one and a plain one alike. A page that says the same
  thing at every version is a stop on the way, never the place a selection dies.
  - The engine renderer does **not** append `?v=`: `buildWikiLinkHref` only substitutes `$1` and
    a fragment into `config.articlePath`, and the engine is frozen. The read view rewrites the
    rendered HTML instead (`propagateVersion`, src/lib/wiki/read-view.ts), server-side, so no-JS
    readers keep their selection too.
  - Chrome links (categories, category members) are rewritten by the article route. Both sides
    ask the same question, `carriedVersion(selected, default)`: carry the selection unless it is
    the site default, so default URLs stay clean and an unknown id — already resolved back to the
    default — never travels.
  - **Every hop, not most of them.** A selection that one page can silently discard is not a
    selection, so the rule reaches the escapes as well: the `Edit` link (`/edit` reads `?v=` and
    rides it back on save), the "Redirected from" link, and the old-revision banner's "view the
    current revision" — leaving an old revision changes the revision and nothing else. History and
    "what links here" are version-independent (§5) and stay clean.
  - **An unwritten `Category:` page is a browse hub, not a blank page.** It lists its members and
    rewrites those member links like any article. It was the last place a version died — and the
    most-travelled one, which is why it looked to the reader as though the choice never held at
    all. It shows no selector, because it writes for no version; what it must not do is drop the
    `?v=` on its way through.
- Version-tag content that differs from the default gets `class="version-scoped"` — a subtle left
  border in `--accent-soft` so readers see *why* text changed with the selector.

### Editor

**The editor carries the same strip, above the editing surface, in both modes.** The point of
version scoping is that one page holds every version, so the person writing it needs the reader's
control — not a different one. Three differences, all because it is an editing surface:

- It is driven by the **buffer**, not by the saved page: typing `<v73+>` makes v73 appear at once,
  which is how an author sees the coverage they are building. `versionsUsed()`
  (src/lib/wikitext-highlight.ts) is the buffer-side twin of `version_boundaries`, and it reads
  both ends of a window for the same reason the engine records both (§3).
- **Each chip carries an X that removes that version's writing** (amended 2026-09-03 by user). A
  page that outlived a patch should be able to shed it, and the chip is where the author already
  sees that the patch is still here; the alternative was hunting the markup by hand, which is how
  a `</variant>` gets orphaned. The X asks first, in a dialog naming the version and the number of
  characters that go — `previewVersionRemoval` (src/lib/visual-editor/version-edit.ts) computes
  that number *as the edit it describes*, so the two cannot drift. What it removes is every tag
  whose name *starts* at that version — `<v56>`, `<v56+v60>` and `<v56+>` are all "what this page
  says from v56" — with its body. Two things it will not touch and reports instead:
  `{{#ifversion:}}` / `{{#vswitch:}}` calls naming the id, whose branches are arbitrary expressions
  and guessing which half to delete is how an editor loses a paragraph; and a window that *ends* at
  it (`<v50+v56>`), which is the last version of somebody else's passage. Confirming applies the same
  transform to the *live* buffer through the editor's `editContent`, so a delete cannot revert
  keystrokes the visual surface has not published yet.
- An **unregistered boundary offers to register itself** from its own chip (`POST /api/versions`,
  decisions-v2 O16.2). Not a registry listing in disguise: such a chip previews the site default
  instead of its own branch, so it is broken until registered, and this is the repair offered
  where the breakage shows. The author just wrote that id; sending them to the version dialog to
  legitimise it is the dead end this strip exists to remove.

Choosing a branch previews it: the visual surface repaints its atomic nodes at that version
(visual-editor.md §5) and source mode's preview pane re-renders. One control, both jobs — which is
what makes "write it, then check it" a single gesture, and why the preview pane no longer carries a
registry dropdown of its own and the page-tools rail no longer carries a second version list. The
editor's strip has no registry dropdown either, for the reader's reason above: previewing a
version this page never mentions is asking what a page that renders one way renders.

- **The row carries both directions.** A chip's `✕` removes that version's writing from the page
  (with a confirmation that counts the characters); a `+` beside the chips adds one. Adding was
  reachable only from Insert → Version block, three levels inside a menu — and on a page covering no
  version the row was not drawn at all, so there was no way in where an author would look for one.
  The `+` therefore renders even with no chips beside it; only a principal who may not edit sees
  neither.
- **Amended 2026-09-03 (by user): the `+` is a menu, not a modal.** It lists the registry versions
  this page does not write for yet, newest first — newest because the version being added is almost
  always the patch that just shipped, and registry order buried it under twelve older ones — and
  ends in a field for an id the registry does not have, validated against the shape
  `POST /api/versions` accepts (`v62`, `v64.1`). Choosing one appends an **empty `<vNN+>`** to the
  buffer and selects it, so the field described below is immediately the one the author is typing
  into. Open-ended because that is what a chip means here — what the page says from this version
  until the next chip — and appended rather than spliced into an existing tag, because narrowing
  somebody else's window to make room is an edit nobody asked for. Versions the page already writes
  for are not listed, and typing one changes nothing: a second boundary for one version is a
  boundary that shadows itself (§2.1).

  Adding a version to a page is **one choice**, and a modal is the weight of a form. The dialog
  still owns the questions that are a form — which of the three shapes, over which versions — and
  stays behind Insert → Version block for them.

  The empty passage is deliberate, and is the one place this and the dialog differ on purpose: the
  dialog *refuses* to insert a block whose passage is blank, because such a block is finished and
  renders nothing, while this one is made in order to be typed into and its field is on screen —
  focused — the moment it exists.
- **Broken version markup is named beside the chips** (amended 2026-09-05 by user: "the editor
  recognises v69, the article does not"). The chips are read from the buffer's *openers*
  (`versionsUsed`); the article is rendered from *pairs*. Normally the same answer — and where it
  is not, the two screens disagree with nothing to explain it. One mistyped closer does exactly
  that:

  ```wikitext
  | Cell1 || <v69>aaa</69> || a      ← `</69>`, not `</v69>`
  …
  <v68></v68>
  <v69></v69>
  ```

  `</69>` closes nothing (§10.7 — a tag name cannot begin with a digit, so it is not markup to
  anything and is published as plain text), so `<v69>` runs on to the `</v69>` at the bottom of the
  page and swallows the row's third cell and the whole `<v68>` block. At every version but v69 that
  content is gone, and v68 is never discovered as a boundary because a tag inside a hidden branch is
  never expanded (§2.6). The editor showed both chips; only the article knew.

  `versionMarkupProblems` (src/lib/wikitext-highlight.ts) reports the two facts that explain it,
  in source order, and the strip draws them under the chips: a **stray closer** — a closing tag
  whose name becomes a version id with a `v` in front — and an **unclosed opener**, the buffer's
  copy of the engine's own `unclosed-version-tag` warning, so it is seen while typing rather than
  after saving. The chips themselves are left alone: they are what the author wrote, and hiding v68
  from them would conceal the very markup the report is about.

  **The stray closer carries a repair; the unclosed opener does not.** `</69>` has exactly one
  reading — a tag name cannot begin with a digit, so it is not markup to anything, it is already
  published as literal text, and putting the `v` back is the only edit that turns it into
  something. So the strip offers a button that writes it (`repairVersionMarkup`), applied through
  `onContentChange`'s updater like the chip's `✕` so it cannot revert keystrokes the visual surface
  has not published, and by **offset** rather than by searching for the text again — a page may
  hold the same broken closer twice, or hold it once for real and once inside `<nowiki>` as
  documentation. Where an *unclosed* passage was meant to end is a guess, and guessing it would
  file somebody's paragraph under a version they never wrote it for, so that one is reported and
  left alone. It usually settles itself anyway: it is the same typo seen from the other side.
- **A construct that renders nothing at the previewed version shows nothing, not its markup**
  (amended 2026-09-04 by user, from a `<v69>` written into a table cell). Every atomic node in the
  visual surface draws the engine's rendering of its own wikitext (visual-editor.md §5), and a
  version tag outside its range renders the empty string — correctly, per §2.1. The fragment route
  used to say only `""`, which the surface read as "could not render" and answered by drawing the
  raw wikitext: an author switching versions saw `<v69>aaa</v69>` in the cell at every version but
  v69. The route now reports which fragments *threw*, so the two are told apart, and an empty
  render is drawn as an empty node carrying a placeholder — an inline chip with literally nothing
  in it is invisible, unclickable and undeletable while still being published.
- Insert → Version block opens the version-scope dialog (visual-editor.md §5.3), which writes the
  tag for the versions the author picked. **It is offered inside a table cell, and the tag it
  writes lands in that cell** (amended 2026-09-05 by user). Neither used to be true: the row was
  marked block-shaped, so the slash menu and the header's Insert menu withheld it wherever the
  caret was in a cell (visual-editor.md §7.3's rule, applied to a construct it was not about); and
  when the dialog was reached any other way, the block insertion resolved the caret's block to the
  *table* and filed the tag after the whole grid. A cell is the commonest place to want this —
  scoping one number of a table to a patch — and §2 is explicit that version markers "work
  anywhere: inside tables, list items, infobox parameters", which is the same sentence that sends
  `{{#ifversion:}}` to table cells in §2.3. A tag in a cell is an inline construct, so it keeps the
  dialog rather than gaining the in-place field (§6's rule for inline constructs, below):
  double-clicking the chip reopens the version dialog on it.
- Syntax-help panel documents §2 with copy buttons.

#### Typing into the version you picked

**Amended 2026-09-03 (by user): picking a version and changing its text is one gesture, done in the
page.** A version construct is an atomic node in the visual surface (visual-editor.md §5.1), so
until this amendment picking a chip and typing put the words in the shared prose *beside* the block
— there was nothing in the block to type into — and the only way into a branch was a dialog. "Pick
a version and change it" does not mean "pick a version, then open a dialog" to anyone.

The block stays atomic. Its wikitext is the truth and visual-editor.md §4's byte-identical
round-trip depends on nothing re-serializing it. What it stops being is **read-only**: under its
rendered preview it carries a `<textarea>` holding the passage the editor is previewing.

- **A form control, not a nested editable region.** The node keeps `contenteditable="false"`, so
  `domToDocument` still emits it out of `data-ve-src` and never out of what is drawn inside it —
  nothing on screen can reach what is published. A `<textarea>` inside such a node is interactive in
  its own right: its own editing host, caret, undo stack and IME composition, and typing in it does
  not disturb the surrounding contenteditable at all. That is what makes this safe, and it is why
  the field is a real form control rather than a second editable region — which would be one editing
  host holding two models, where every command, paste, selection and undo has to be told which half
  it is in.
- **The head row names the branch, never the chip.** Boundaries `[v56, v73]` previewed at v70 show
  the v56 branch (rule 1), so that is the branch the field holds and "Editing v56" is what it says.
  Labelling it v70 there would be this feature's own failure, one label further along.
- **Typing changes that passage and nothing else.** The node's `data-ve-src` is read back with
  `versionTagSpans`, and the governing passage's body is **spliced** — every other byte of the
  block comes back exactly as it was: the neighbouring window, the ids' own spelling, the absence
  of whitespace between the tags. It is debounced and then handed up the way the atomic dialog's
  apply is handed up, through the one function that writes `data-ve-src`, because a second path to
  the buffer is a second place to write a version's words into the wrong passage. The arithmetic —
  which passage a version renders, what replacing it does — is pure and unit-tested in
  `src/lib/visual-editor/version-branch.ts`.
- **No keystroke in a debounce is lost.** Switching chips flushes first (the editor island does it
  before it changes the previewed version); so do publishing, a mode switch and every edit made from
  outside the surface. A capture carries the branch id it was typed into, so even a write that lands
  late lands in the right branch, and starting to type in a second field commits the first.
- **A version this block does not write for is named, not refused** *(amended 2026-09-05 by user:
  "let version blocks be editable at every version")*. The tag runs from v70 and the editor is
  previewing v56: its range does not reach v56, so nothing of this block renders there. Until this
  amendment the field was replaced by a sentence saying so, and an author who wanted to fix that
  passage had to go and select the version it was written for first.

  What made refusing look necessary was the rule one line above — showing v70's words in a field
  labelled v56 is writing one version's text under another's id, which is the failure this whole
  feature is about — but that rule was already satisfied by a different answer: **the head row names
  the branch, never the chip.** So the field opens on the block's nearest passage (`nearestSpan`:
  the last one starting at or below the selection, or the first one above it where there is nothing
  behind) with that passage's own id on it, and `covers: false` tells the surface to add a line
  under it saying the preview above is empty on purpose. Nothing is written under a version it was
  not typed for; the author simply no longer has to leave to fix it.

  Nothing is *offered* beside it either, because a tag still has no second passage to add — writing
  for v56 means another tag, and the strip's `+` is where a page gains one.
- **A block may hold several tags, and the field edits the one on screen.** There is no group
  wrapper any more, so a page that says one thing from v45 and another from v56 writes two tags
  back to back — with nothing between them, since a newline there would be text belonging to every
  version. The surface's block scan takes that whole run as one atomic node, so the field asks the
  run: which passage does the previewed version render (rule 1 again — the greatest lower bound at
  or below it). Switching chips swaps the field between them.
- **What keeps the preview and the dialog.** A block with no passage to splice: prose beside the
  tags, an unclosed tag or a closer that does not repeat its name (§10.7), a self-closing tag, an
  attribute the name does not carry. Note that this is a *shorter* list than the dialog's, and
  deliberately so: the field only has to find one body, while the dialog has to spell the whole
  construct back — so a run of tags gets a field but opens the raw-wikitext dialog rather than the
  version dialog, which composes one tag. An inline construct keeps its dialog too: a chip inside a
  run of text has no head row, and a textarea in one would break the line.

Leaving the field repaints the block's preview at the previewed version, so "write it, then check
it" stays one gesture. On a locked surface (nobody signed in yet) the field still shows which
version says what, and takes nothing back.

#### The version-scope dialog — the three shapes, as a form

**Amended 2026-09-03 (by user): the dialog offers exactly the three forms the grammar has, and
refuses to insert a block that renders nothing.**

The dialog is the form that spells §2.1 so an author never has to. Since the tag NAME is the range,
it asks three questions and no more: which shape (this version only, a range, this version onward),
which version — a second picker appears for the far end of a range — and what the passage says.

- **One passage, one body.** A tag holds one passage; two passages that differ are two tags, which
  is what the strip's `+` adds and what the field inside each block then edits. The dialog seeds
  its body from the author's selection, because Fandom's gesture is "highlight the sentence, then
  scope it".
- **No fallback control.** Prose with no tag around it already belongs to every version (§2.1), so
  the `*` checkbox has nothing left to configure: *not writing a tag* is the fallback. It went with
  the grammar rather than staying as a control with nothing behind it, as did the multi-select of
  versions and its chip row (a tag names one range, not a list).
- **Insert refuses a block that renders nothing**, and says which nothing it is: a blank body shows
  nothing at any version, and an inverted window (`<v80+v70>`) holds for no version at all. §2.1
  renders that rather than swapping the ends, so the form refuses it rather than quietly reordering
  what the author typed. Whitespace counts as blank, because the reader sees nothing either way.
- **Double-clicking an existing block reopens this dialog, not the raw-wikitext one.** A version
  block is an atomic node in the visual surface (§5.1), so without an inverse the author had to
  hand-write the markup this dialog exists to avoid. `parseVersionBlock`
  (src/components/wiki/version-dialog.tsx) is that inverse, and the law it keeps is
  `buildVersionBlock(parseVersionBlock(x)) === x` for every block the dialog could have written.
  Away from that canonical spelling it still reads what real wikitext holds — an uppercase name, a
  closer whose case differs, `<v70+v70>` for `<v70>` — and returns the canonical spelling of the
  same meaning, which is safe because tag names compare case-insensitively (spec §10). It returns
  null wherever a rebuild would change or lose something — an attribute the name does not carry, a
  self-closing tag, a closing name that does not repeat the opening one, a construct with a
  neighbour — and the editor then falls through to the atomic wikitext dialog rather than rewriting
  somebody's page. Since the passage is editable in place, reopening is no longer how a branch gets
  filled in; it is how the block's **range and mode** are changed.

The preview pane reads the same composed draft, rendered at the version the tag starts at — inside
its range one tag emits one body, so there is nothing to choose between and no version dropdown
beside it.

### Routes (supplements routes.md)
- `/wiki/[...title]?v=<versionId>` (`/{locale}/wiki/…` off English — decisions-v2 O12) —
  invalid/unknown id ⇒ 404-free fallback to default with
  a banner.
- `/api/preview` body gains `version?: string`.
- `/api/admin/versions` `GET|POST|PATCH|DELETE` (admin) — registry CRUD; DELETE refuses if any
  `page_locales.version_boundaries` still names the id (409 with the referencing page list).
- `/special/version-coverage` (`/{locale}/special/version-coverage` off English) — report:
  pages by boundary, pages never updated since
  version X (uses `version_boundaries` + last-edit time). Helps maintainers find stale articles.

---

## 7. Test plan

Unit (`src/lib/wikitext/versions.test.ts`): the tag-name grammar (the three forms, minor ids, and
the names it must NOT swallow), range grammar (every form in §2.3), ordinal math with patch
versions, window resolution asserted at both ends and outside them, inverted windows, unregistered
ids, `#vswitch` boundary picking incl. default, and boundary recording for each of the three forms.

Integration (`versions.integration.test.ts`): one fixture page rendered at four versions asserting
different HTML; boundaries recorded from a **non-selected** branch; a version tag inside a table
cell, inside a template argument and inside an infobox parameter; nested tags; an unclosed tag and
a mismatched closing name; the retired tags rendering escaped; cache-key selection (`'*'` for
unscoped pages).

Editor (`version-dialog.test.ts`, `version-branch.test.ts`, `version-edit.test.ts`,
`editor-version-bar.test.tsx`): `build(parse(x)) === x` for each of the three shapes and for the
seeded pages' own wikitext; every refusal of `parseVersionBlock`; which passage a version renders
and the refusal to write into one it does not; removal of a tag that starts at an id, and the
count of the places that only name it; and the chip strip's boundaries, its X and its `+`, read
from the buffer.
