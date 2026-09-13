# Visual editor (DECIDED 2026-09-02 by user — "editor는 fandom wiki와 똑같이")

Normative spec for the **Fandom-shaped editor**: one edit surface with two interchangeable
modes — *Visual editing* (WYSIWYG) and *Source editing* (the wikitext mirror we already
had) — behind the mode pill Fandom puts in the top-right of the edit page.

**Amended 2026-09-04 (by user): the visual surface's *interaction* is Notion's.** The
frame stays Fandom's — the mode pill, the rail, the header, the publish bar, source
mode's toolbar — but visual mode's fixed toolbar is gone and six controls come to the
caret instead (§1). Everything §4 promises is unchanged, and that is the whole reason
the change was affordable: the controls moved, the bytes did not.

Three rules frame everything below.

- **Layout, chrome and interaction copy Fandom. Color does not.** The whole editor is drawn
  in the token system of `theme.md` (`--ink`, `--link`, `--hairline`, …) and works in light
  *and* dark. No hex literal appears in a component.
- **Round-tripping never rewrites what the author did not touch.** Opening an article in
  visual mode and publishing without an edit must produce a byte-identical revision. §4
  is how that is guaranteed.
- **Nothing this editor draws may reach the buffer.** Every control it puts on screen is
  React's markup *outside* the contenteditable, and every hint inside one is an attribute
  and a stylesheet rule. A button written into a paragraph is content `domToDocument`
  reads and `serializeDocument` publishes.

## 1 — Screen

**Amended 2026-09-04 (by user): the interaction model is Notion's.** The fixed toolbar
this section used to describe is gone from visual mode. Nothing above the writing area
tells an author what the editor can do; the controls come to the caret instead. The
frame around the surface — the rail, the header, the mode pill, the publish bar — is
unchanged, and **source mode keeps its toolbar**, because a textarea has no caret to
bring anything to.

```
 ⛶   EDIT PAGE                         ┌──────────┐   ┌──────────────────────┐
 🔖  Artifice                          │ Insert ▾ │   │ 👁 VISUAL EDITOR   ▾ │  ⌄
                                       └──────────┘   └──────────────────────┘
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  ⠿ +  68-Artifice is a moon in Lethal Company, with a difficulty rating of … │
│       ▔▔▔▔▔▔▔▔▔ ┌───────────────────────┐                                    │
│                 │ B I U S <> 🔗 Turn into│  ← the bubble menu, over a        │
│                 └───────────────────────┘     selection                      │
│  Moon Map                                                                    │
│  ▒ {{Map:Artifice}} ▒                          ← atomic node, not editable   │
│                                                                              │
│  /tab│                                                                       │
│  ┌──────────────────────────────┐                                            │
│  │ INSERT A BLOCK               │              ← the slash menu, at the      │
│  │ ⊞  Table                     │                 caret                      │
│  │ ▤  Tabs                      │                                            │
│  └──────────────────────────────┘                                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Left rail** — two floating circular buttons pinned to the left edge, as Fandom has
  them: *fullscreen* (widens the surface to the viewport) and *page tools* (toggles the
  right column). That column holds two cards: the article's **outline** (§10.1,
  `editor-outline-panel.tsx`) and the page-tools rail this repo already ships
  (`editor-rail.tsx`).
- **Header** — `EDIT PAGE` eyebrow in small caps over the page title. The title is the
  page name, not "Editing X"; creation says `CREATE PAGE`.
- **`Insert ▾`** *(amended 2026-09-04 by user, after the amendment above)* — the one
  control the frame keeps above the writing area, in **visual mode only**
  (`editor-insert-menu.tsx`). The amendment above moved every control to the caret and
  took with it the last thing on screen that said the editor can insert anything at all:
  an author who has not been told about `/` had no road to a table, and no row of buttons
  left to find one on. So the menu comes back, and it is deliberately the short list —
  what `INSERT ▾` and `CITE ▾` held (`visualInsertItems`, the same catalogue array the
  slash menu draws from, filtered by a flag on the row rather than by a second list of
  keys). The forty special characters and the seven marks are *not* in it: a dropdown
  cannot be typed at, so they would bury the ten constructs somebody opened it for, and
  each already has a home — the bubble menu, `Ctrl+B`/`I`/`U`, and the slash menu itself.
  Its rows are **pulled when it opens**, through `VisualEditorHandle.insertItems()`, for
  the reason `onContextChange` reports one number: pushing the caret's table and marks up
  to the island would re-render the whole editor per keystroke for a menu that is shut.
  Choosing a row runs `VisualEditorHandle.runAction`, which is the slash menu's own
  routing, so a construct inserted from here and the same one inserted from `/` go in
  identically, dialogs included. Source mode does not draw it: its own toolbar carries
  `INSERT ▾` already.
- **Mode pill** — `👁 VISUAL EDITOR ▾` / `[[]] SOURCE EDITOR ▾`, opening a menu of exactly
  four items in Fandom's order: **Visual editing**, **Source editing**, **Read the user
  guide**, **Keyboard shortcuts**. The active mode is shown selected and inert.
- **Chevron** next to the pill collapses the header strip (Fandom's chrome toggle).
- **Publish bar** — at the bottom: edit summary, "minor edit", Cancel, Publish, and a
  live word and character count beside the minor-edit box (§10.2). Fandom's publish
  affordance; ours keeps the summary inline rather than in a modal.

Source mode keeps this repo's live preview pane beside the textarea (`versioning.md` §6 previews
the version its chip strip has selected, and the pane is the only place source mode can show it).
Visual mode has no pane, because the surface already *is* the rendered article.

### The six controls that come to the caret

Each is a module of its own, and `visual-editor.tsx` only wires them up. **All six are
drawn by React *outside* the contenteditable**, which is the one rule none of them may
break: a `<button>` written inside a paragraph is markup `domToDocument` reads as that
paragraph's content and `serializeDocument` publishes. So each is positioned from
measured rectangles and none touches the surface's own DOM.

| control | opened by | module |
|---|---|---|
| slash menu | typing `/` at the caret | `ve-slash-menu.tsx` |
| gutter handle | putting the caret in a block (§3.1) | `ve-block-handle.tsx` |
| bubble menu | selecting text | `ve-bubble-menu.tsx` |
| input rules | typing `## `, `- `, `1. `, `> `, `--- `, `**x**` … | `src/lib/visual-editor/input-rules.ts` |
| mention panels | typing `[[`, `@` or `{{` (§13) | `ve-slash-menu.tsx`, `src/lib/visual-editor/mention.ts` |
| table axis controls | the caret entering a table (§3.2) | `visual-editor.tsx`, `ve-table.ts` |
| context menu | right-clicking a block (§3.3) | `ve-context-menu.tsx` |
| reordering | dragging a grip or an axis tab (§3.4) | `ve-sortable.ts` |

- **The slash menu** holds the retired toolbar's whole catalogue, and that is not a
  figure of speech: `visualSlashItems` (`editor-toolbar-visual.tsx`) is the one list, so
  retiring the row could not quietly drop a construct. Every entry of `INSERT ▾`,
  `CITE ▾`, `NORMAL TEXT ▾`, `T ▾`, the list and indent buttons, link, media and the
  character grid is a row of it — plus, while the caret is in a table, the twelve
  operations of §3.2 as contextual rows at the top. In a table **cell** the block rows
  are simply not offered: a cell holds inline content and nothing else (wikitext-spec
  §7.3), and a heading made in one is a table the model then has to refuse.

  **It has since outgrown that toolbar in both directions** *(amended 2026-09-06 by user:
  "slash에 기능 좀 더 추가하고 normal같이 기본적으로 가능한거는 안뜨게 해줘")*. It gained
  the constructs no button ever had — a **definition list** (`; term : definition`, the
  third list marker, wikitext-spec §4.1), a **category** (§5.10), an **external link**
  (§6.2), **`<nowiki>`** (§10.1), a **code block** (`<syntaxhighlight>`, §10.5) and a
  **hidden comment** (§10.8) — and the five **block commands** of §3.1 and §14, which
  until now lived only in the grip's menu and the right-click menu: both are pointer
  affordances, so "delete this block" was a control half the readers of this wiki could
  not reach. Two constructs were deliberately left out for the same reason the direction
  gives below: `<br>` is what Shift+Enter already writes, and `#REDIRECT` is only ever a
  page's first line, so a row that wrote one mid-article would be a row whose only use is
  a mistake.

  And it **leaves out the rows that would do nothing where the caret is**: the format the
  block already has, an outdent at the left margin, and a move off either end of the
  document. The commonest of those is the commonest case there is — "/" is pressed in an
  empty paragraph, where "Normal text" is a row you can pick and watch not happen. It is
  four questions the *surface* answers (`VeSlashBlock`, `slashBlockAt`), because only the
  surface knows where the caret is; a toggle is not among them, since "List" in a list
  turns the list off, which is a change and usually the wanted one. The header's `Insert ▾`
  asks none of them: it holds only constructs, and none of those can be a row that
  refuses.

  **A query may be typed in Korean** *(fixed 2026-09-06, user report: "slash로 크기를
  바꾸는 게 가끔 정상작동하지 않는다")*. It could not be, and the menu's own gate is why:
  an IME composition used to close the panel and `syncSlash` was skipped for as long as
  one was running. In Korean every syllable is a composition of its own, so "/제목" is
  three of them end to end and the panel that opened on "/" closed on "제" — coming back
  only if a `selectionchange` happened to land after a `compositionend` rather than
  during the next composition. That race *is* the "sometimes": when it lost, Enter reached
  the surface as a paragraph break; when it won, the menu came back holding the `consumed`
  of an older line and the deletion took the wrong characters, leaving "제목" inside the
  heading it had just made. The rule now distinguishes reading from writing: an **input
  rule** still may not fire mid-composition (it rewrites the block, and mid-syllable that
  takes the syllable apart), while the **panels** only read the line and read it on every
  input, on every `compositionend`, and on every selection change. Enter stays safe
  because the menu ignores any key whose `isComposing` is set — the first Enter commits
  the IME's candidate, the second takes the row. The same fix is what lets `[[` and `@`
  (§13) search for a page whose title is Korean, which on this wiki is most of them.

  **And a line ends where the author sees it end** *(fixed 2026-09-06, user report:
  "table에서 enter를 눌렀을 때 칸이 늘어난 판정이라 /가 정상 작동하지 않는다")*. Every
  one of these readings — the slash menu, the three mention triggers, the input rules —
  asks "what has been typed on this line", and the answer used to be the host's text
  nodes concatenated and nothing else. So a table cell holding two visual lines read as
  one string with no seam: the "/" starting the second line arrived as `"first line/"`,
  where a slash inside a word is deliberately not a menu, and nothing opened. The same
  in any paragraph after a Shift+Enter. `lineTextOf` (`ve-selection.ts`) writes one
  `"\n"` at a `<br>` and at the boundary of the `<p>`/`<div>` a browser wraps a split
  line in — the two tags `domToDocument` sees through on the way back, so the reading
  and the reader agree about where a line is. It also **places a caret standing on an
  element**, which is where a browser parks one on an empty line: the old rule gave up
  there rather than guess an offset, and every reading that depends on it did nothing.
  Nothing is guessed — the walk knows which child index it is at. Both are asserted in
  `ve-selection.test.ts`, over plain objects, because a string-building walk is exactly
  the kind that looks right and hands back the wrong string.

  **And the caret holder is read as a space.** `caretHolderAt` parks a zero-width space
  where a click asks for a position no text node holds — clicking the blank part of an
  empty line, or of a table cell, which is exactly how an author arrives at a line they
  are about to press "/" on. The reader already drops it (`withoutCaretHolders`, dom.ts)
  so it never reaches the buffer; what it reached was this reading, and U+200B is not
  whitespace to `\s`. So the slash right after one read as a slash *inside a word* — the
  case the rule exists to refuse, for `and/or` and `[[File:x.png]]` — and the menu simply
  did not open, silently, for the rest of that line. One character in, one out, so every
  offset stays where it was. This is the third thing in this surface that is markup only
  the surface can see and every reading of it must not: the labelled `<br>` filler and
  the empty text nodes beside a chip are the other two.
  The header's `Insert ▾` shows the same rows for the same caret, cut to the constructs
  (see §1's list): one catalogue, two roads to it. **The list scrolls past its own
  height** — it always could, but the window-level `scroll` listener that keeps the
  `fixed` controls anchored is bound in the capture phase, which makes it an ancestor of
  everything, so the panel's own list arrived there too and closed the menu the moment an
  author scrolled it. A scroll out of a panel that owns its scrollbar is skipped
  (`data-ve-slash-menu`, `data-ve-context-menu`): a list scrolling itself is not the page
  moving away from the caret the panel hangs off.

  **And the page does not scroll under an open panel at all** *(amended 2026-09-05 by
  user: "once the menu's scroll hits its limit the whole page scrolls, and that is what
  makes the menu vanish")*. Skipping the panel's own scroll was only half the promise:
  the browser **chains** a wheel the list cannot use up to the nearest ancestor that can,
  so reaching the last row scrolled the article — and a panel anchored to a caret or a
  pointer cannot follow that, so it closed. Two rules answer it, and they cover different
  halves: `overscroll-contain` on the scroller stops the leftover delta at either end of
  a list that *can* scroll, and `useContainedWheel` (`ve-panel-scroll.ts`) covers the case
  a stylesheet cannot — a list with nothing to scroll at all, where the wheel goes
  straight to the page. The hook also scrolls the list for a wheel that landed *beside*
  it (the slash menu's heading is inside the panel but outside its `<ul>`), which is why
  it has to know that a wheel reports **lines** on Windows and on Firefox rather than
  pixels. It registers `wheel` by hand because React attaches that one passively at the
  root, where `preventDefault` does nothing.
- **The gutter handle** is a "+" and a drag grip — see §3.4 for what the drag
  does now. **It follows the caret, not the pointer** (amended 2026-09-07): the pair
  belongs to the block being *edited*, and it appears beside that block only. Hover
  anchoring was tried first and dropped — the buttons chased the pointer across the
  article, moved out from under a hand reaching for them, and never sat on the block the
  author was actually typing in; the gutter's `mouseover`/`mouseleave` bookkeeping that
  propped it up (`blockBandIndex`, the `data-ve-handle` `relatedTarget` check) went with
  it. `selectionchange` is now the only thing that re-anchors the handle, which is also
  what a keyboard-only author already had. The "+" opens a new paragraph below
  with the slash menu already on it — Notion's main gesture. The grip drags the block to
  reorder it and, clicked, opens a menu: Insert below, Duplicate, Delete, Move up, Move
  down, and Turn into. §3.1 argued against a drag handle because a drag cannot be reached
  from a keyboard; the answer is not to drop the argument but to keep every move in the
  menu and on `Alt+Arrow` as well. A drag is the pointer's shortcut to a move the
  keyboard can already make.
- **The bubble menu** is B / I / U / S / code, the link, clear formatting and "Turn
  into". Deliberately small: anything rarer belongs to the slash menu, which is where an
  author reaches for a *construct* rather than for emphasis.
- **Input rules** recognise markdown's spelling **and** wikitext's, because the first is
  what an author arrives with and the second is what this wiki stores. The one collision
  is decided rather than guessed: `"# "` is a numbered list, not an h1 — wiki articles
  have no h1, and `"## "` and `"== "` already cover both spellings of a heading.
- **The empty line says so.** The paragraph the caret is standing in, while it is empty,
  prints "Write, or press '/' for blocks" — an attribute and a stylesheet rule, never
  markup in the document. With no toolbar on screen it is the only thing that says the
  menu exists.

### Source mode's toolbar

Unchanged, and still Fandom's: `undo · redo ‖ B · I · U · S · link · media · gallery ·
template ‖ INSERT ▾ ‖ CITE ▾ ‖ Ω ▾ ‖ T ADVANCED ▾ ‖ ☰`

- `T ADVANCED ▾` — heading levels, bullet/numbered list, indent, remove link, `<nowiki>`,
  HTML comment, redirect, syntax help.
- `CITE ▾` still lists the named references the buffer carries (§5.5), from the same
  `citeReuseRows` the slash menu's rows come from: the two modes cannot offer different
  sources or insert different bytes.
- `☰` toggles the page-tools rail (same target as the left-rail bookmark button).

## 2 — Document model

`src/lib/visual-editor/model.ts` is the single normative type module; the summary here is
prose for the same thing.

A document is `{ leading, blocks[] }`. `leading` is the exact text before the first block
(almost always `""`). A block is one of:

| kind | wikitext | notes |
|---|---|---|
| `paragraph` | one or more consecutive non-blank lines | inline children |
| `heading` | `== Title ==` … | `level` 1–6; UI offers 2–5 |
| `list` | a run of `*` `#` `:` `;` lines | **flat** items, each keeping its raw marker |
| `rule` | `----` | `dashes` keeps the run length |
| `table` | `{|…|}` whose cells hold inline content | `attrs`, `caption`, `rows[].cells[]`; see below |
| `atomic` | everything else | `source` kept verbatim, never re-serialized |

Lists are deliberately flat: `marker` is the literal wikitext prefix (`"*"`, `"**"`,
`"#*"`, `":"`, `";"`). Nesting is a *rendering* concern (§3), so no structural information
can be lost between the two forms.

A **table** is the one construct with two possible parses, and the rule deciding between
them is §4's: `{|…|}` becomes a `table` block — cells editable as content — only when it can
be written back unchanged, and stays an `atomic` of kind `"table"` otherwise. A cell's
`children` are inline, its `attrs` (`colspan="2"`) and the table's and the row's are kept
verbatim and never interpreted, and the caption is inline children or nothing. So a table
refuses when it nests another (wikitext-spec §7.9), when any cell or caption is continued
onto another line — which is what puts a list, a heading, a paragraph break or a nested table
inside a cell (§7.3) — when it carries fostered content (§7.7), an indent (§7.8), text after
`|}` (§7.1), a second or attributed caption (§7.4), or no cells at all (§7.5); and finally
when serializing what was read and reading that back does not reproduce it. Cell splitting is
the editor's own, not the engine's, because the engine splits *after* template expansion: the
pipes inside a `{{Verify|x}}` are not table markup, and a `{{…}}` or `[[…]]` is stepped over
whole. A table has at least one row and every row at least one cell — a row with none renders
nothing (§7.5) — which is why `removeRow`/`removeColumn` return null rather than an empty
table. Rows may be **ragged**: `src/lib/visual-editor/table.ts` holds the row and column
operations and the one rule they keep, that a column is an index and not a promise.
A table that refused says so on its chip, in the parser's own words (§3.2): the
difference between a chip and an editable grid is never "tables are not editable",
it is one named construct in this one table.

`atomic` covers the tables that refuse, block templates `{{…}}`, `<infobox>` `<gallery>` `<tabber>`
version tags (`<v70>`, `<v70+v80>`, `<v70+>` — versioning.md §2.1, recognised by shape rather
than by name), `<pre>` `<poem>` `<references>` and other block extension tags, raw block HTML,
`[[File:…]]` on its own line, `[[Category:…]]`, `<!-- comments -->`, `#REDIRECT`, and
leading-space preformatted lines. Its `atomic` field names which, so the surface can draw
the right chip; its `source` is emitted byte-for-byte on save.

Inline nodes: `text`, `mark` (`bold` `italic` `underline` `strike` `sup` `sub` `code`),
`link` (`[[target|children]]`), `extlink` (`[href children]`), `break` (`<br>`), and
`atomic` for inline templates, `<ref>`, `<nowiki>`, `<math>`, `[[File:…]]` used inline and
any HTML inline tag that is not one of the seven marks.

## 3 — DOM mapping

`src/lib/visual-editor/dom.ts` owns both directions. The contenteditable surface is
**uncontrolled**: React writes its HTML once per document load and reads it back on demand.

| model | DOM |
|---|---|
| paragraph | `<p data-ve="p" data-ve-id>` |
| heading | `<h2…h6 data-ve="h" data-ve-id>` |
| list | `<ul>`/`<ol>`/`<dl>` trees rebuilt from the flat markers, `data-ve="list"` on the root |
| rule | `<div data-ve="rule" contenteditable="false"><hr></div>` |
| table | `<table data-ve="table" data-ve-id data-ve-attrs>` |
| caption | `<caption data-ve="caption">` |
| row | `<tr data-ve-attrs>` |
| cell | `<th>`/`<td>` `data-ve="cell" data-ve-attrs` |
| block atomic | `<div data-ve="atomic" data-ve-kind data-ve-src contenteditable="false">` |
| mark | `<b> <i> <u> <s> <sup> <sub> <code>` |
| link | `<a data-ve="link" data-ve-target>` |
| extlink | `<a data-ve="extlink" data-ve-href>` |
| inline atomic | `<span data-ve="atomic" data-ve-kind data-ve-src contenteditable="false">` |
| break | `<br data-ve-break>` — the attribute carries the spelling (`<br>`, `<br />`) |

Two pieces of markup the writer **synthesizes** have no model behind them, and each is
labelled where it is written so the reader can drop it again:

- `<br data-ve-filler>` — the filler that gives an empty paragraph, cell or caption its
  height;
- `<li data-ve-hold>` / `<dd data-ve-hold>` — the item opened for a list level the marker
  jumped over (`*#`), which holds the deeper list and nothing else.

The labels are not decoration: an authored `<br>` spacer line and an item the author left
empty above an indented one produce byte-identical markup, and inferring "ours" from the
shape deletes them (§4). `ve-selection.ts` labels the holders it builds for the same reason.

A table's cells are ordinary editable regions of the surrounding contenteditable — no
`contenteditable="false"`, no `data-ve-src` — which is the whole point of the block. The
attribute strings ride in `data-ve-attrs` rather than as real HTML attributes: which of them
an article may keep is the engine's sanitizer's decision (wikitext-spec §7.2), and the
surface is not a renderer. No `<tbody>` is written, because browsers insert one anyway and
the reader walks through whatever they inserted.

Reading back is **tolerant**, because the browser and `document.execCommand` produce markup
we did not write: `STRONG`→bold, `EM`→italic, `INS`→underline, `DEL`/`STRIKE`→strike,
`TT`→code, `DIV`→paragraph, `FONT`/bare `SPAN`→transparent, unknown elements→their text.
Inside a table that means walking through an inserted `<tbody>`, adopting a cell left outside
a row, dropping a row left with no cells, seeing through the block wrapper a browser leaves
in a cell, and folding a pasted newline to a space — a cell cannot hold one, because every
table marker sits at the start of a line (§7.1).
Anything carrying `data-ve-src` is emitted from that attribute and never re-parsed. Markup
wearing no label of ours is the author's, so an unlabelled lone `<br>` is a break and an
unlabelled empty item is an empty bullet.

`domToDocument` takes a structural subset of `Node` (`VeDomNode`), so it is unit-testable
under vitest's node environment with plain objects.

### 3.1 — Moving a block

Every top-level block — paragraph, heading, list, rule, atomic chip, table — can be moved
up and down, and moving one is **a DOM move of that block's elements and nothing else**.

- **A handle in the gutter.** Hovering a block, or putting the caret in it, draws a "+"
  and a drag grip in the surface's left gutter (§1). They are React's markup and are
  drawn *outside* the contenteditable — a button written inside a paragraph is markup
  `domToDocument` reads as content and `serializeDocument` publishes. The grip's menu
  carries **Move up** and **Move down** as ordinary rows, disabled rather than inert where
  the move lands nowhere (the first block going up, the last going down).
- **`Alt+ArrowUp` / `Alt+ArrowDown`** move the block holding the caret and keep the caret
  in it — the binding every editor uses, and the only way to reorder a page without a
  pointer (§6). A chip cannot hold a caret, being `contenteditable="false"` (§5), so there
  the shortcut moves the *selected* chip: the state a click on one already sets.
- **The grip drags** (amended 2026-09-04). This section used to refuse a drag handle
  outright, because a drag cannot be reached from a keyboard. The refusal's *reason* is
  kept and its conclusion is not: the two moves stay in the menu and on `Alt+Arrow`, so
  the drag adds a road rather than replacing one. Three things make it safe inside a
  contenteditable — the drag starts on the grip, which is outside the surface, so the
  browser never tries to drag the *selection*; `dragover` is prevented on the wrapper,
  without which there is no drop target and no `drop` event at all; and the drop is
  prevented too, since an unprevented drop on a contenteditable inserts the drag's data
  as text. Which gap the pointer is in is `dropIndex`, a pure function over measured
  block extents (`ve-block-handle.tsx`), so the arithmetic is tested rather than clicked
  at. A drop of a **file** is not a move at all — it is a picture (§15).

Why the DOM move is the whole design is §4. The block keeps its element, so it keeps its
`data-ve-id`, so the next read still matches it to the block it was parsed from, so it is
still emitted from `source`: **a page whose paragraphs were only reordered republishes
with every paragraph byte-identical, in a new order.** `ve-selection.test.ts` asserts
that through the surface, over an article whose blocks a canonical rewrite *would* have
reformatted — rebuilding the markup instead would publish `==Layout==` as `== Layout ==`
and fold a two-line paragraph onto one line, for a move that touched neither.

One block is not always one element: a list whose marker changes at depth 0 (`*` then
`#`) writes sibling roots and only the first carries `data-ve-id` (§3). The move shifts
the whole run, or one list would be published as two.

The move is a plain DOM edit, so it sits outside the browser's undo transaction — and
since 2026-09-04 that is no longer the end of the sentence: `Ctrl+Z` walks it back
through the editor's own structural stack (§12), which restores the surface's markup
whole rather than rebuilding a block and canonicalizing bytes the move was careful to
keep.

### 3.2 — Editing a table

A `{|…|}` that parsed (§2) is edited as a grid: its cells are ordinary editable
regions, and twelve operations act on the row and column the **caret** is in.
They are reachable two ways, deliberately.

**The grid is drawn as the article draws it** *(amended 2026-09-04 by user: "cell
looks very odd in the editor")*. The `class="wikitable"` an author wrote rides in
`data-ve-attrs` and is published from there, never applied to the element
(`dom.ts`) — which is right, since applying it would make the surface's markup a
second source of truth for §4. But it left the editable table carrying *no*
class at all, so nothing styled it and the browser's default table came through:
no rules, no padding, no header shading, and an empty cell collapsed to the width
of its filler `<br>`. So `globals.css` restates `.wikitable`'s frame for
`.ve-surface table[data-ve="table"]`, deliberately and not by sharing a class:
the editor has to look like the article it publishes. Two differences, both
because it is being edited rather than read — a cell carries a floor width so an
empty one is still a click target, and the table wraps its cells rather than
becoming its own scroll container, since a scroller under the axis controls
(which are positioned from the wrapper) would slide them off the table they act
on. The caret's own cell is marked `data-ve-here` and drawn with a ring:
`:focus-within` cannot do it, because the editing host is the surface and never
the `<td>`. Every one of these is an attribute and a stylesheet rule, so
`domToDocument` — which reads a cell out of `data-ve-attrs` and its children,
and nothing else — can never publish one.

- **A floating control**, drawn at the table's top-left corner — just above its
  first row, or over it where the table is the page's first block — while the
  caret is inside the table, holding all twelve as icon buttons in three groups: the row's,
  the column's, then the header toggle and the table's own deletion. Like the
  move handle it is React's markup *outside* the contenteditable, and its
  `mousedown` is prevented so a click never takes the caret out of the cell the
  operation is about. It follows the **caret, not the pointer** — a strip that
  appeared on hover would vanish on the way to being clicked, because the
  pointer has to cross the surface to reach it.
- **The slash menu** (§1), the same twelve under the same names, offered as
  contextual rows at the top of the list while the caret is in a table — and
  left out entirely while it is not, since a list that filters as you type has
  no room for rows that refuse. A control only a pointer can reach is a control
  half the readers of this wiki do not have.

*Amended 2026-09-04*: the floating strip of twelve icon buttons became **two axis
menus**, which is Notion's shape and reads better than a line of twelve glyphs.
A tab above the caret's column opens the column's six operations and a tab
beside its row opens the row's. The operations, their names and their refusals
are unchanged — the icons were regrouped, not the edits.

*Amended 2026-09-05 (by user)*: **each tab is also that axis's grip** — press
and travel to drag the row or the column somewhere else (§3.4). A press that
does not travel still opens the menu, so the tab gained a gesture and lost
nothing.

*Amended 2026-09-05 (by user: "the + on a table works oddly — just take it
out")*: **the two "+"s are gone.** They were `insertColumnRight` and
`insertRowBelow` applied at the last row and column, drawn as bare glyphs on a
hit area the width of the table's edge — a control with no frame, no hover
state and no stylesheet rule of its own, which is what made pressing one feel
like nothing had been aimed at. Growing a table is now §3.3's job, where it is
named ("Insert column to the right") instead of drawn as a symbol, and where it
is one gesture from the cell the author means rather than a trip to the table's
far edge. Nothing was lost with them: both were positional applications of
operations §3.2 still offers three ways.

| operation | acts on |
|---|---|
| insert row above / below | the caret's row |
| move row up / down | the caret's row; disabled at the ends |
| delete row | the caret's row |
| insert column left / right | the caret's column |
| move column left / right | the caret's column; disabled at the ends |
| delete column | the caret's column, in every row that reaches it |
| header row on / off | every cell of the caret's row |
| delete table | the block |

**Every one of them is `src/lib/visual-editor/table.ts`'s**, and the surface only
chooses. Applying one reads the surface back with `domToDocument`, finds the
block by its `data-ve-id`, hands it to the pure operation and draws the answer
with `blockToHtml` — the same two halves of §3 the document load uses. No
wikitext is spelled in the component, so §4 decides what publishes exactly as it
does for every other block: the redrawn table keeps its id, so the next read
matches it to the block it was parsed from, and an operation that changed
nothing republishes the original bytes. `ve-table.test.ts` asserts that through
the surface, over an article whose other blocks a canonical rewrite *would* have
reformatted.

**Tab moves to the next cell**, wrapping to the start of the next row, and grows
a row at the very last cell — the behaviour every table editor has and the one
authors try before they look for a control. `Shift+Tab` walks back, to the *end*
of the row above. At the very first cell it does nothing and the browser keeps
the key, which is what stops a table from trapping focus: forward, Tab only ever
grows more rows.

**And so does Enter** *(amended 2026-09-06 by user: "table에서 enter를 눌렀을 때 다음
칸으로 가는 게 아니라 그냥 칸이 늘어난 판정이라")*. Left to the browser, Enter in a cell
wrapped that cell's content in a `<div>` and the cell grew a second line — a line the
**model cannot keep**: every table marker sits at the start of a line (wikitext-spec
§7.1), so `domToDocument` folds two blocks in a cell into one run joined by a space
(dom.ts, `isCellWrapper`). The cell looked two lines tall on screen and published as one,
which is the worst shape an editor can be in — it loses an edit silently. Enter therefore
takes the same step Tab does, through the same `tableTabStep`, and a cell's line break is
**Shift+Enter**: a `<br>`, which is inline content a cell may hold (§3.4) and which the
model keeps verbatim. Two keys, two meanings, instead of one key meaning something the
buffer cannot say.

That wrapper is also what broke `/` in a table, and the fix outlives it — see §1's note
on `lineTextOf`: a line now ends where the author sees it end, at a `<br>` or a wrapper
boundary, in a cell and in a paragraph alike.

**Enter is not answered on `keydown`, and that is the whole point.** Two cuts of this read the key
and both were wrong the same way: **while an IME is composing, Chrome does not report `Enter` at
all** — it reports `key: "Process"`, `keyCode: 229`, because the key belongs to the IME and the
browser says so by refusing to name it. Korean composes every syllable, so the last one is always
still composing when Enter is pressed, and `event.key === "Enter"` was therefore *never* true for
the author who reported this. The break went in every time *(user report, 2026-09-06, three rounds
of it: "shift+enter과 같은 효과가 지속적으로 나는 버그")* — and the second cut passed its test only
because the test spelled the event the way the code expected. A synthetic `KeyboardEvent` cannot
tell you what an IME sends.

So the rule is written against the **edit** instead of against the keyboard. Whatever key made a
paragraph break — a plain Enter, an Enter the IME committed on, a paste, a shortcut — the break
itself arrives as one cancelable `beforeinput`, and *that* is what a cell refuses. It cannot be
spelled wrong, because it is not a spelling: it is the edit the browser is about to make.

Blink will not split a table cell: its own Enter inside a `<td>` degrades to
`InsertLineBreakCommand` and writes a `<br>` — measured, in the author's own Chrome, against this
very page. That is *why* the symptom is "Enter behaves like Shift+Enter"; both names are refused
here, and the two keys are told apart by the **modifier** rather than by the name. `breakShiftRef`
carries `shiftKey` off the last keydown, which is the one thing about that key an IME cannot garble
(it renames the key to "Process" and still reports the modifier). Shift+Enter therefore still writes
its `<br>` — inline content a cell may hold (§3.4), the one way to put two lines in a cell and have
the model keep both.

The Enter that *can* be named is stopped one event earlier, on `keydown`: `beforeinput` is that
key's own default action, so preventing the key means the break is never even proposed.

**And `preventDefault` is not always a promise — which is round four** *(user report, 2026-09-06:
"아직도 마찬가지야")*. Driving this page in a real headless Chrome over CDP and reading the events
back settles what three rounds of reasoning could not: an ordinary Enter's `beforeinput` arrives
`cancelable: true` and refusing it works — but **every `beforeinput` an IME is composing on is
dispatched `cancelable: false`**. Korean composes every syllable, so the Enter that ends a cell's
last word is exactly the one this surface is not allowed to refuse. No amount of preventing could
ever have fixed it.

So the rule stops depending on the answer. Prevention runs first and does the work wherever it is
allowed to; where it is not, the break lands and is **taken back off**. `armCellBreak` remembers the
cell's `<br>`s and wrappers *by node* before the break — a count cannot say which one is new, and
Blink writes two `<br>`s at a cell's end where it writes one mid-word — and `healCellBreak` removes
exactly what the snapshot does not hold, then takes Tab's step. It runs on `input`, on
`compositionend` and on the next key, because the break can land on any of the three, and it is
armed by two things: a `beforeinput` that says `cancelable: false`, and the Enter an IME owns, which
`keydown` can still recognise by **`event.code`** — `"Enter"` is the physical key even when `key` is
`"Process"` and `keyCode` is 229. That press is deliberately *not* prevented: the syllable it is
committing would be swallowed with the break. Nothing the author typed and nothing the IME committed
is in the snapshot, so nothing of theirs can be removed by the repair.

The **step** still waits for the IME (`event.isComposing` on that same event): the caret may not
leave a cell with a half-assembled syllable in it, the composition ends on that keystroke, and the
author's next Enter steps — the rule §1's slash menu already keeps for its own Enter. It is read off
the event, never off a `composingRef`, since a flag that missed one `compositionend` would disable
Enter in tables for the rest of the session. Tab stays on `keydown`: it makes no edit for a
`beforeinput` to carry, and no IME is assembling anything when it is pressed. Both call one
`stepTableCell`, so the two keys cannot drift apart.

**Deleting the last row or the last column deletes the table**, because a table
with no rows renders nothing (wikitext-spec §7.5) and the model holds no such
thing — so all three deletions ask first, through a dialog of ours rather than
`window.confirm`, and the dialog says *which* of the three it is. The header-row
toggle is the one operation that can refuse: a data cell holding `!!` would
become two header cells (§7.3), and escaping it is forbidden by §4, so the row
is left alone and a notice says why. Nothing is disabled for it in advance,
because the condition is about a cell's wikitext and the controls know only the
markup's shape.

`Alt+Arrow` keeps moving the **block** inside a table, as §3.1 says — a table is
one block, and losing that would leave a page with a table in it unorderable
from a keyboard. Rows and columns move with their own controls.

The controls never appear over a table the model **refused** (§2). Such a table
is an atomic chip, and a chip's cells are the engine's rendering of somebody's
wikitext rather than anything the model holds — so the raw-wikitext dialog stays
the way in, and the chip carries the parser's own reason for the refusal
("a cell continues onto the next line", "it contains another table", …), because
"this table behaves differently" is otherwise something an author can only guess
at.

Two positions inside a table have no operations: the caption, which is in no
row, and a cell of a table nested inside another, which is in no row of either.

The slash menu's **Table** puts a table in, not a chip, and leaves the caret in its
first cell — a snippet inserted as an atomic would have needed a reload of the
surface before any of this looked at it. Every other insertion is still an
atomic, which is what those constructs are.

**An insertion made from inside a cell stays inside it** *(amended 2026-09-05 by
user)*. A cell holds inline content and nothing else (wikitext-spec §7.3), and
`nearestBlock` inside one answers with the **table** — so `insertAtomic`'s block
branch put the new node after the whole grid. That is what happened to a version
block composed from inside a cell: the author aimed the tag at the cell and the
editor filed it under the table (versioning.md §6). `insertAtomic` now writes a
single-line source inline whenever the caret's host is a cell or a caption,
whatever the caller asked for — the menus already keep genuinely block-shaped
constructs out of a cell, so what reaches it is a construct that can be inline: a
version tag, a link, a picture, a template call. A multi-line source is the one
thing §7.3 cannot spell in a cell, so it keeps the old placement rather than
being written as markup the next parse would refuse.

### 3.3 — Right-clicking a block

**Added 2026-09-05 (by user: "put in something where you right-click a block — a
table, say — and get its special functions: add a column to the right, add a row
below").** `ve-context-menu.tsx`.

The third road to §3.2's twelve operations and §3.1's block commands, and the
one that needs no control on screen. The axis menus sit beside the table and the
gutter handle sits beside the block; both are pointer affordances that have to
be *aimed at* first. Right-clicking the thing you mean is the gesture every grid
in every application answers — which is also why the two "+"s could go with it.

- **No vocabulary of its own.** Every row is a `VeTableOp` or a
  `BlockMenuCommand` the surface already routes, named out of the same
  dictionary and built by `contextMenuRows` from `TABLE_OPS` and
  `blockMenuRows`. A menu with an operation of its own would be a fourth road
  able to disagree with the other three.
- **It is about the block and the cell the *pointer* was over, never the
  caret's.** Right-clicking the third row of a table while typing in the first
  has to be about the third row, and whether a right-click moves the caret is
  the browser's business rather than a thing this may depend on. Both are
  captured when the menu opens and handed to the operations explicitly; the axis
  controls and the cell ring are pointed at the same place, so what is
  highlighted is what the menu is about.
- **The browser keeps its own menu wherever this has nothing better**: a locked
  surface, the branch field's textarea (where spellcheck, cut and paste are the
  whole point of a right-click), and the surface's padding, which is in no
  block.
- **An operation the cell cannot be given is left out, a block command that
  cannot fire is disabled.** The first is the slash menu's rule — a list that is
  read rather than filtered has no room for rows that refuse. The second is the
  gutter menu's, because those four rows are the same four every time and a list
  that changed length at the ends of a document would move under the pointer.
- Like every other control here it is React's markup **outside** the
  contenteditable, positioned `fixed` from the pointer. `contextMenuPosition`
  keeps it on screen by flipping about the pointer rather than sliding: a panel
  left under the finger arms its first row before that finger has moved.
- **Its wheel never reaches the page**, for the reason §1 gives for the slash
  menu's: this panel is anchored to a pointer that has stopped moving, so a page
  scroll closes it — and running out of rows is not a reason to be closed.

### 3.4 — Dragging something into a new place

**Added 2026-09-05 (by user: "let inner elements be dragged too, and animate the
move — the element goes to the mouse, and the slot it will fill empties out as
it moves").** `ve-sortable.ts`, plus the drag in `visual-editor.tsx`.

Three things reorder by drag now, all with the same gesture and the same
arithmetic: **blocks** down the page from the gutter grip (§3.1), and a table's
**rows** and **columns** from the two axis tabs (§3.2), which were already
sitting beside the row and over the column they name. There is nothing new to
find on screen — every grip was already there, and every one of them was already
a menu.

- **The author's own element follows the pointer**, not a picture of it. That is
  what the direction asked for and it is why this is `transform` and a marker
  attribute rather than a floating copy: a style attribute and a `data-ve-*`
  marker are read by nothing and published by nothing (§3, §4), so the real
  paragraph can be lifted and carried without the buffer ever knowing. Every
  trace is swept off before the move is committed — an element still holding a
  transform would sit where the drag left it rather than where the document now
  puts it.
- **The hole is the drop indicator.** The line this replaced said where a block
  would land; the gap says it in the shape of the thing that will fill it. Every
  slot the drag has passed slides one dragged-size the other way (`sortShift`),
  which is one CSS transition and no layout at all.
- **One set of sums for all three** (`ve-sortable.ts`): which slot the pointer is
  over, how far each other slot shifts, and where the dragged run settles. Three
  copies of that would be three chances for the picture and the move to
  disagree, which is the one failure an animation makes invisible. `sortGap`
  converts a slot to `moveBlockRun`'s "insert before" index, and the test asserts
  the two describe the same arrangement for every pair.
- **A press is still a click.** Both grips open menus, so nothing happens until
  the pointer travels five pixels; past that the release's synthesised click is
  swallowed, so a drag never also opens the menu of the block it just moved.
- **The move is listened for on the `window`.** The first thing a drag does is
  hide the chrome that would otherwise hang over a document sliding underneath
  it — which unmounts the very button the press landed on, so a pointer capture
  on it would end the drag on its own first frame.
- **A block moves its elements; a row or a column goes through the model.** A
  block keeps its `data-ve-id` and republishes from `source` (§3.1, §4), exactly
  as `Alt+Arrow` leaves it. A table's rows are not blocks — the table is one
  block and its rows are its wikitext — so those go through `moveRow` /
  `moveColumn` and `applyTableMove`, which is one history step for a drag across
  six rows rather than six. Neither is a thirteenth table operation: `VeTableOp`
  is positional by design and "put this row at index 4" is not a shape any of
  the twelve has.
- **Escape gives up**, and `prefers-reduced-motion` gets the move without the
  travel — the arrangement still changes, it simply arrives.

What is *not* draggable is a **list item**: a list is one block, its items have
no grip of their own, and there is no pure "move item" to drive one. `Tab` and
the input rules are how a list is restructured today.

## 4 — Round-trip guarantee

Every parsed block carries three extra fields:

- `source` — its exact original wikitext,
- `canonical` — `serializeBlock()` of the block as parsed,
- `gapAfter` — the exact whitespace that followed it.

On save, a block is emitted as `source` when `serializeBlock(block) === canonical`, and as
`serializeBlock(block)` otherwise. Blocks created in the editor have all three `null` and
are always canonical; their gap is `"\n\n"` (`"\n"` when last).

`gapAfter` belongs to a **pair**, not to a block: it is what separated this block from the
one that followed it *at parse time*. A block whose successor changed — the author typed a
paragraph behind it, or split it in two — loses it (`domToDocument`), and the serializer
re-derives any remaining gap that cannot separate the pair it now sits between. A lone
`"\n"` separates a paragraph from a heading but glues it to another paragraph, which is why
reusing one unconditionally published a newly typed paragraph merged into the one above it.

Therefore `serializeDocument(parseDocument(x)) === x` for **any** input — after `x` has had CRLF
and lone CR folded to LF, which `parseDocument` does first and the engine's stage 0 does anyway —
and only blocks the author actually changed are rewritten. `roundtrip.test.ts` asserts this over every seed
article in `src/lib/db/seed-content/`, both directly and through the surface —
`documentToHtml` → `domToDocument` → `serializeDocument`, which is the path a real publish
takes and the only one where the two halves of §3 can disagree.

Text is serialized verbatim — the serializer inserts no `<nowiki>`. A paragraph's internal
newlines are folded to spaces in the model (wikitext renders them as spaces), so an
*untouched* multi-line paragraph is preserved by the `source` rule and an *edited* one
collapses onto one line. That is the same trade Fandom's VE makes.

A table takes the same trade at a larger scale, because there are more ways to spell one. The
canonical form opens every row with `|-` (including the first, which wikitext lets an author
leave implicit), writes a row's like cells on one line joined with `||` / `!!`, and puts the
caption first wherever the `|+` was:

```
{| attrs
|+ caption
|-
! header !! header
|-
| cell || cell
|}
```

It is a fixed point — parsing it yields exactly the table that writes it — so an author who
wrote their table one cell per line keeps those bytes through the `source` rule and adopts
this form only once they actually edit that table. Since nothing is escaped, a `||` typed
into a cell splits it in two on the next parse, exactly as a typed `''` becomes italics.

## 5 — Atomic previews

Atomic nodes render their real HTML, as Fandom does. `POST /api/preview/fragments` takes
`{ fragments: string[], title, locale, version }` and returns
`{ htmls: string[], failed: number[], warnings: string[] }`, rendering each through the
same `renderPreview()` the live preview uses. The surface requests the distinct atomic
sources once per document load and injects the result into each node's
`contenteditable="false"` body; the model is untouched, so previews can never affect what
is saved. A fragment that fails renders as a labelled chip instead.

**`failed` is not `htmls[i] === ""`** *(amended 2026-09-04 by user, from a table cell that
misbehaved)*. An empty render is an ordinary, correct answer: a version tag renders
**nothing** at every version outside its range (versioning.md §2.1), and so does a
`{{#if:}}` whose test is false. While the route said only `""` and the surface read `""`
as "could not render", it fell back to drawing the wikitext — so a cell holding
`<v69>aaa</v69>` showed the author raw markup at every version but v69, and content at
v69. The route therefore reports the indices that actually **threw**, `readFragments`
(`visual-editor.tsx`) keeps the two apart, and `paintFragment` has three outcomes rather
than two: the wikitext for a failure, the HTML for a render, and for an empty render a
node marked `data-ve-blank` — because an inline chip with nothing in it is invisible,
unclickable and undeletable while still being published. The placeholder that marks it is
punctuation drawn by a stylesheet rule; the sentence explaining it is a `title` from the
dictionary, since no user-visible English may live in a stylesheet.

Clicking an atomic node selects it; the chip's own edit button (and Enter) opens a dialog. For
a template call that is the template dialog below; for everything else it is a dialog holding the
node's raw wikitext.

**A caret beside a chip deletes it** *(added 2026-09-05 by user)*. Backspace with the caret
immediately after one removes it, and Delete immediately before one does the same — every atomic,
not only a version block: a template call, a picture, a category, a `<ref>` are all one
`[data-ve-src]` node standing in a run of text, and a rule that held for one of them would be a
rule the author has to remember the shape of. The surface has to answer this itself because a chip
is `contenteditable="false"` and what a browser does to one beside the caret is its own business —
one selects it, another eats a character of the wrapper, and inside a table cell, where a version
tag most often is, several do nothing at all. **It is a walk, not a match on `(container, offset)`** — which is what the first
attempt was, and why it went on doing nothing between two chips in a cell. There is no one place a
browser puts the caret there: it may report the cell and an index, a text node the engine invented
between the two, an inline wrapper's edge, or a position *inside* the chip's own rendered preview.
So `atomicBeside` (`ve-selection.ts`) walks document order the way the delete would — out of every
edge the caret is sitting on, then into the neighbour's own nearest edge — stepping over the empty
text nodes browsers leave around a `contenteditable="false"` node throughout (`neighbourIndex`),
because one of those between the caret and the chip is exactly what makes the answer always
"nothing there". It takes a node interface a real `Node` satisfies structurally, which is what lets
the walk be *tested*: vitest runs in a node environment here, and this is the sort of walk that
looks right and does nothing.

**And beside a table, or a `----`, the block goes** *(added 2026-09-06, user report: "backspace를
사용해서 table이 지워지지도 않아")*. Those two are the blocks that are **not** chips — a table's
cells are ordinary editable regions (§3) and a rule is an `<hr>` — so this walk did not look for
them and no browser deletes either from outside: the caret at the start of the paragraph under a
table pressed Backspace and nothing whatsoever happened, with the only ways out being the grip
menu, the right-click menu and the axis menu's *Delete table*. The predicate is now `isFrozenBlock`
— a chip, a table, a rule — with the last two matched **only as blocks of the root**, never as
markup inside a chip's rendered preview, which is the engine's drawing and not the buffer. A chip
goes through `removeAtomic` and a block through `deleteBlockUnit`, which is the same removal the
grip menu's *Delete* makes, so it goes **at once** rather than through the axis menu's confirmation
*(user direction: "바로 삭제")*: three roads to one act, and a Backspace that opened a dialog would
be the one of them that argues. The structural stack has it, so `Ctrl+Z` puts the table back.

The walk stops at the caret's own host — a cell, a caption, a list item. Backspace at the very
start of a cell must not reach back into the cell before it and delete something the author cannot
see the caret next to, and at the start of a list item it means "join this to the one above", not
"eat what is inside it".

**A wall has to be held, not merely not crossed** *(user report, 2026-09-06: "table에서 backspace를
누를때 한번에 지워지지 않고 선택이 되는")*. Bowing out at a cell's edge left the key to Chrome, and
Chrome does not do nothing with it: a Backspace at the start of a cell selects the **whole table** —
every cell drawn blue, no caret anywhere — and waits for a second press, which then takes the table
or empties its cells depending on where that selection landed. An author who meant to delete one
character watched their table light up instead. So `cellAtCaretEdge` answers every rim the two rules
above have not already taken, and the answer is that the key is **spent**: prevented, and nothing
done. There is no character to eat and no cell to merge with — a merged cell is not something
wikitext can say (§7.3) — so "nothing" is the whole of the correct behaviour, and preventing is the
only way to get it.

**And a rim has to be recognised through a holder** *(same report, one round later: "아직도
마찬가지야")*. Both rim rules asked `hostText(...).offset === 0`, and **clicking into a cell is what
makes that answer wrong**: a press on a cell's own box parks a `​` and puts the caret *after*
it (`caretHolderAt`, and §5 says why that is the only way to get a caret beside a chip at all), while
`lineTextOf` maps a holder to a space so its offsets stay aligned. The caret then reads as offset
**1** at the start of the cell, every guard returned null, and the key went to Chrome — which
answers a Backspace at a cell's start by selecting the whole table. The author's own cell held two
version chips and nothing else, so it could not be reached by any gesture *except* the click that
parks the holder: for them the rim guard had never once run. `cellSideIsBare` now asks the **DOM**
instead of a flattened string — everything between the cell's edge and the caret is cloned and looked
at, and a holder and a filler `<br>` are not content — so nothing has to stay aligned for the rule to
hold. `tableAtCaretEdge` uses the same reading, which is what makes Backspace in a freshly-clicked
first cell delete the table at once rather than one press late.

**And a holder is not a character to the chip walk either** *(user report, 2026-09-06: "cell안에
있는 version tag를 지우려고 시도하면")*. The same parked `​` stood between the caret and the chip
it had been parked beside, so `atomicBeside` — which may only leave a text node from its edge — saw
a character in front of it and answered nothing, and the browser then deleted the invisible.
Deleting one version tag took three presses, the first two of which looked like nothing at all.
`neighbourIndex` now counts a holder-only text node as blank, exactly as it already counted an empty
one and a filler `<br>`, and `atomicBeside` may step out of a text node whose content on the caret's
side is holders. Both are pure and pinned in `ve-selection.test.ts`.

**And "the whole table is selected" is not a selection *of* the table.** Chrome's state runs from
inside the first cell to inside the last, so `rangeCoversNode`'s `selectNode` reading answered no for
the very selection the author was looking at and the press fell through to a plain range delete —
which empties the cells and leaves the table standing *(user report: "아직도 표가 한번에 안지워져")*.
It now reads `selectNodeContents` as well, which is what is drawn on screen; the caller has already
required a frozen block, so a run of text selected inside a paragraph cannot match.

**A key may not add a line to a cell.** Chrome answers a Backspace between two chips by putting a
`<br>` where the text it removed had been — measured — and an unlabelled `<br>` in a cell is an
authored line the model keeps and publishes: the author deleted a version tag and the row grew
taller *(user report: "갑자기 개행이 되는")*. Deleting cannot mean "and add a line", so the repair
§3.2 built for the uncancellable break is armed for **every** key pressed in a cell rather than for
the two that were reported — the engine's inventiveness is not a list anyone can keep in step, a pass
that finds nothing costs two walks of one cell, and what is taken off is only ever what the snapshot
does not hold. **Shift+Enter is the one key not armed**, because a `<br>` is exactly what it means;
and each key drops the previous key's snapshot before arming its own, since one armed for the last
key is not a claim about this one — left standing, it took Shift+Enter's own line straight back off.
A cell emptied by the repair is given the **labelled** filler back, or it would have no height.

**And the table that is already selected** *(added 2026-09-06: "커서는 안보이고 표를 드래그해서
선택한거처럼 보여")*. There is a state with no caret on screen at all, where the table is drawn the
way a drag-selection is — Chrome puts one there by itself, and then wants a **second** Backspace
before it will delete it. Everything above bows out of a non-collapsed selection, on the grounds
that a selection is the browser's to delete; for an ordinary run of text that is right, and for a
whole table it is how the key came to need pressing twice. `frozenBlockInSelection` answers that
state, and is deliberately strict about it: exactly **one** block of the root may be touched, it has
to be covered whole, and it has to be a block the caret cannot stand in. A selection spanning a
table *and* the paragraph under it is a plain range delete and stays the browser's — asserted by
hand in the browser, because deleting half of what somebody selected is the one failure here that
loses text.

**With one opening, at the two ends of the table itself** *(added 2026-09-06, after the outside
case above was not what the author was pressing)*. `/table` leaves the caret in the **first cell**,
which is exactly where somebody who has just made a table and wants it gone presses Backspace — and
the walls meant that key did nothing there, forever. At the very start of the first cell there is
nothing of the table behind the caret at all: what is behind it is the table. So `tableAtCaretEdge`
answers there, and at the very end of the last cell for Delete, and nowhere else inside. It takes
no behaviour away, which is the test it had to pass: at those two positions a browser does nothing
whatsoever with the key — there is no cell to merge with and no character to eat — so the press was
already being thrown away. From an **ordinary block** it does reach one step out, because a caret at
the start of a line with a chip standing as the block above it is the one shape where every editor
does: the neighbour has to *be* a chip and is never descended into, so Backspace after a paragraph
still merges the two lines rather than pulling a picture out of the end of the first.

**And the caret has to be able to get beside a chip at all** *(user report: "I clicked to the right
of the block and the caret went to the first position")*. An inline chip is
`contenteditable="false"` and a cell often holds nothing else, so there is no text node after it
for a browser to put a caret in; engines fall back to the start of the host, and Backspace then has
nothing behind it — which is what made the chip feel undeletable in the first place. **Naming that position in a Range is not
enough either**: `(cell, 1)` past a chip is a place with nothing in it, and engines normalize a
caret out of one — to the start of the host, or, as the author found next, into the *next cell*. So
a press that lands on a host's own box rather than on any of its content is answered twice over:
`caretIndexForClick` reads which position it meant (vertical distance picks the line; past a
child's midpoint means after it), and `caretHolderAt` **makes** that position where there is not
one — a single zero-width space, parked beside the chip.

That is the one character the surface is allowed to write into the document that the author never
typed, and it is why `withoutCaretHolders` (`dom.ts`) strips it from every read, so it cannot reach
the model or the buffer. It is the same bargain `editableBody`'s labelled `<br>` filler already
makes for an empty region — markup that exists only to hold a caret, and that the reader drops —
and `dom.test.ts` holds it to §4: a cell read back through a holder serializes exactly as empty as
it looks, and a page republishes byte for byte. Stripping it unconditionally also cleans up after a
paste from a word processor, which is where a stray one otherwise comes from.

**But a blank line is not a place to park one** *(user report, 2026-09-07: "입력칸을 클릭할때
높이가 늘어나는 버그가 있어")*. An empty region's one child is the filler `<br>` that gives it its
height, so a click anywhere right of its left edge reads as the position *after* that break — and a
holder there is a character on a **second line**. The empty paragraph the author clicked into stood
up twice as tall, and the surface, the editor's box and everything under it grew with it, on a
click that was only meant to put the caret somewhere. There is nothing to stand beside in an empty
region and exactly one caret position in it, which is the one an engine lands on unaided: the rule
now parks nothing there and leaves the press to the browser. The same break ends any region that
finishes with one, so a holder that would go last goes in front of it instead — the end of the line
that was clicked, rather than the start of an empty one under it. Which of the three a click asks
for — the text that is already there, a parked holder, or nothing — is `caretHolderSlot`, split out
from the DOM writing so the rule itself is pinned in `visual-editor.test.ts`.

One node is atomic but not read-only: a version block carries an editable field under its preview,
holding the passage the editor is previewing (versioning.md §6, amended 2026-09-03 by user). It is
a `<textarea>` inside the `contenteditable="false"` node — a form control has its own editing host
and disturbs the surrounding contenteditable not at all — and it writes through `data-ve-src` like
every other atomic edit, so §4 is untouched: the wikitext is still the only thing that gets
published, and a block the version parser refuses keeps the raw-wikitext dialog above.

A block may hold several tags back to back — §2.1 has no group wrapper, so that is what a page
with two windows looks like — and the field holds the passage the previewed version renders,
swapping between them as the chips are clicked. It has two states and no more: a passage to edit,
or a sentence saying the block writes nothing at that version. There is nothing to offer in the
second case — writing for that version means *another tag*, which is what the chip strip's `+`
adds (versioning.md §6).

The edit is a **splice**: only that passage's body is replaced, so a run's other tags and the ids'
own spelling come back byte for byte. That is why the field serves blocks the version dialog
refuses — the dialog has to spell a whole construct back and a run is not one tag.

## 5.1 — Templates

Fandom's template flow, and the reason an author never types braces:

- **Insert → Template** opens a search over the `Template:` namespace
  (`GET /api/templates?q=`), title substring, redirects excluded, the editor's locale with an EN
  fallback.
- Choosing one loads its **parameter form** (`GET /api/templates/{name}`). The parameters come
  from the template's own body: every `{{{name|default}}}` in first-appearance order — which for
  this wiki's infoboxes is the order the rows render in. A parameter used *without* a default is
  **required** (spec §8.4 makes the engine print raw braces when it is missing), so the form shows
  it first and will not let it be removed. Everything else lives under "add parameter", Fandom's
  "add more information", alongside a free-text field for a parameter the template does not
  declare.
- An optional `<templatedata>` JSON block on the template page enriches that list with labels,
  descriptions, types, `required`/`suggested` and an explicit `paramOrder`. It is read straight
  from the wikitext by `src/lib/visual-editor/template-params.ts`, not by the engine — which is
  frozen and does not know the tag, and therefore still renders the block as literal text on the
  template page. Teaching stage 3 the tag is the follow-up that fixes that; nothing else depends
  on it.
- The dialog previews the call it is building through `POST /api/preview`, so the author sees the
  real infobox, and shows the wikitext it will write underneath.
- **Double-clicking a template node** reopens the same form on the existing call. Round-tripping
  preserves the name exactly as written (`Infobox_moon`, underscore included) and whether the call
  was one line or many, so an edit never reformats a page's source.
- Parser functions and magic words (`{{#if:}}`, `{{PAGENAME}}`, `{{ns:0}}`) are deliberately *not*
  templates here: they have no form to offer, so they fall through to raw wikitext editing.

The source editor's Insert → Template opens the same dialog, and inserts at the caret.

## 5.2 — Pictures

`POST /api/media` has always existed (decisions O6); the editor now has the way in
(decisions-v2 **O16.5**). The media dialog has two tabs that end in the same place:

- **Upload** — a file input and a drop zone. The file is validated *before* it is sent against the
  shared constants in `src/lib/media.ts` (`MEDIA_MAX_BYTES`, `MEDIA_ALLOWED_EXTENSIONS`), so the
  common mistakes are caught without a round trip. Uploading a canonical name that already exists
  replaces that file — the route upserts — so the dialog warns first.
- **On this wiki** — `GET /api/media?q=`, newest first, as a thumbnail grid.

A third way in was added 2026-09-04: a picture **dropped or pasted onto the writing
surface** opens this dialog with the file already uploading (§15). It is a way in, not a
second uploader.

Every way lands on the same placement controls — caption, layout (thumbnail /
frameless / full), alignment, width — over a live preview of the real image, and Insert writes the
call: `[[File:Ship.png|thumb|right|300px|Caption]]`. Options that are off emit nothing, so a plain
insert is just `[[File:Ship.png]]`. `buildFileWikitext` is pure and unit-tested.

## 5.3 — Tags and game versions

Both are picked with the same control, `TokenPicker`: type to search what exists, and take
**“Create *X*”** as the last row when nothing matches (decisions-v2 **O16.1**).

- **Tags** are categories — membership is the `[[Category:X]]` tags in the body and nothing else
  (O13). The picker searches `GET /api/categories`, shows each tag's live member count, marks the
  ones the page already carries, and ends at the same `addCategory()` that the plain input used to.
- **Versions** are the registry (versioning.md §1). The picker reads `GET /api/versions` and can
  register a missing one through `POST /api/versions`, which **any editor may call** (O16.2): the
  id is validated, the ordinal derives from it, and the row lands as `legacy`. Renaming,
  re-ordering and deleting stay admin-only.

The **version-scope dialog** is what makes a page writable for every patch (O16.3). Since the tag
NAME became the range (versioning.md §2.1), the form is that grammar and nothing else: three modes,
a picker for the version — a second one for the far end of a range — and one body.

| mode | wikitext |
|---|---|
| this version onward | `<v62+>…</v62+>` |
| a range of versions | `<v50+v61>…</v50+v61>` |
| this version only | `<v62>…</v62>` |

Text with **no** tag around it already belongs to every version (§2.1), so there is no fallback to
configure and the dialog has no control for one. Ids are emitted folded, the spelling the registry
keeps them in, and the two ends are emitted in the order the author gave them: §2.1 renders an
inverted window for *no* version rather than swapping it, so the dialog refuses to write one
instead of quietly reordering it — the same refusal it makes for a block with no text in it.

`buildVersionBlock(parseVersionBlock(x)) === x` for every block the dialog could have written,
which is what lets a block already on the page reopen in the form that wrote it. Since the passage
is editable in place (§5 above), reopening is no longer how a branch gets filled in — it is how the
block's *range and mode* are changed. The chip strip above the surface lists the versions a page
already writes for — read from the buffer, not the database — so the coverage gaps are visible
while writing, and clicking one previews the page as it stands there.

## 5.4 — Links

`Ctrl/Cmd+K` and the bubble menu's link button open a dialog over the selection: a target, an
optional label, Insert, and Remove where the caret was already inside a link. The target
field is a **combobox over the page index** (`GET /api/search/suggest`), with the
behaviour `suggest-box.tsx` already established — 200 ms debounce, Arrow/Enter/Escape, a
`mousedown` taken before the blur, the previous request aborted.

Three decisions in it are pure functions, and each of them is a fact about this wiki
rather than about comboboxes (`editor-link-dialog.tsx`):

- **What is searched.** The index holds **bare page names** — `Template:Infobox moon` is
  indexed as `Infobox moon` — so sending the target as typed answers nothing for any page
  outside the main namespace, which is exactly the set hardest to spell from memory.
  `linkSearchQuery` splits the prefix off with `parseTitle` (spec §5.7–§5.8) and drops the
  fragment and the plain-link colon. A URL is not a page name, so an external target fires
  no request at all.
- **What a chosen suggestion writes.** `linkSuggestionTarget` emits `:Category:X` and
  `:File:X`. The leading colon is not decoration: `[[Category:Mechanics]]` *files* the
  page into that category and renders nothing, and `[[File:…]]` embeds the image (spec
  §5.8). This dialog makes links; the media dialog places images.
- **Whether the page exists.** `linkTargetStatus` compares on `(namespace, slug)` per
  decisions O1, so `gold_bar`, `Gold bar` and `gold bar` are one page. Its answer is a
  persistent line under the wikitext preview, `text-mute` and never an error, saying the
  target names an existing page or a new one — a red link is allowed, and worth knowing
  about *before* publishing rather than after. It says nothing at all until the search has
  answered **this** target: a list answering an earlier keystroke is not evidence about
  this one, and a failed request records no answer rather than an empty one, so a dropped
  connection can never claim a real page is new. `Talk:` and `User:` are permanently
  "nothing", because decisions O2 makes them permanently red rather than newly written.

Nothing here blocks Insert, and `TokenPicker` (§5.3) is deliberately not reused: its whole
shape is the create row, and a link has none — the typed target *is* the new page. It also
keeps its results private, and this dialog's headline fact is a fact *about* those
results, drawn under the field whether or not the list is open.

Source mode's link button still wraps the selection in `[[…]]` without opening the dialog,
which is what it did before; the autocomplete is therefore visual mode's — where, since
2026-09-04, typing `[[` reaches the same index without opening anything at all (§13).

## 5.5 — Reusing a reference

Citing one source twice is `<ref name="x" />`, and the hard part is remembering the name
written twenty paragraphs up. `CITE ▾` therefore lists the named references the **buffer**
already carries, in both modes (§1).

`src/lib/wikitext-refs.ts` is the scan, and it walks `highlight()`'s tokens, so
`<nowiki>`, `<pre>`, `<syntaxhighlight>` and comments are opaque exactly as they are for
`versionsUsed` and `templatesUsed`. It reads `name=` in every attribute spelling the
engine accepts, dedupes on `(group, name)` in first-appearance order, keeps the first
defining body, and fills a body in from a definition that follows a reuse.

It refuses two things, both because offering them would put a second `Cite error` on the
page: a name the engine's own validator rejects (a local copy, pinned to the engine's by a
drift test) and a group that cannot be quoted. And `refReuseWikitext` repeats `group=`
when there is one, because **Cite keys a footnote by group *and* name** — a reuse that
dropped the group renders "no text provided for ref". That was found against
`POST /api/preview` rather than assumed.

## 6 — Keyboard

`Ctrl/Cmd+B` bold, `+I` italic, `+U` underline, `+K` link, `+D` duplicate the caret's
block (§14), `+F` find and replace (§9), `+0` normal text and `+2`…`+5` the four heading
levels (§10.2), `+Z`/`+Shift+Z` undo/redo — the structural stack first (§12), the
browser's after it — `Ctrl/Cmd+Enter` publish, `Alt+ArrowUp`/`Alt+ArrowDown` move
the block the caret is in (§3.1), `Tab`/`Shift+Tab` the next and previous cell of a table
(§3.2) — where **`Enter` takes Tab's step as well**, and `Shift+Enter` writes the cell's
line break (§3.2 says why the browser's own Enter could not stay) — `Escape` closes a
dialog, a menu, a panel or the find strip.

Three of them are **typed characters rather than chords**, and the table prints them as
such: `/` opens the slash menu (§1), `[[` and `@` the page search, `{{` the template
search (§13). They are in the table because with no toolbar on screen the shortcuts
dialog is where an author goes to find out what the editor can do.

The dialog lists exactly these — and prints
`Option` rather than `Alt` on Apple keyboards, since a keycap that is not on the reader's
keyboard is the one thing that table must not show. The two table rows print a bare `Tab`
for the same reason: outside a table it is not a shortcut at all, it is how a keyboard
leaves the surface.

## 7 — What is deliberately not built

No real-time collaboration, no `<nowiki>` auto-escaping (§4), and no rendering of
`<templatedata>` as a documentation table on the template page (§5.1 explains why, and
what would fix it). Nor, in find and replace: no regular expressions, no search across
pages, and no highlight of every match inside the visual surface — §9 says why the last
one is a trade rather than an omission.

Two entries **left this list on 2026-09-04**, and both left with their reasons answered
rather than dropped: drag-to-reorder (§3.1 — the keyboard keeps every move it had, and
the drag is an extra road to it) and uploading a picture from the surface (§15 — the drop
opens §5.2's dialog and uploads through it, so there is still exactly one uploader).

Nor, in a paste: the clipboard's `text/html` is never read (§11). It is a whole other
editor's DOM, and every structure worth recovering — a heading, a list, a table, a link —
is in the plain text as markdown or as tab-separated cells.

Nor, in the mention panels (§13): no fuzzy matching of our own over the search's answer,
no inserting a page that does not exist yet (the typed target *is* the new page — that is
the link dialog's own rule, §5.4), and no `@`-mention of a **user**, since this wiki has
no notion of addressing one.

Nor, in the outline: no promoting or demoting a heading, and no dragging a section under
another one. Both are *re-parenting*, which is a different edit from a reorder — it
rewrites the heading's own wikitext, and the whole reason §10.1's move can promise §4 is
that it rewrites nothing. The same rule is why a subsection cannot be moved onto a
same-level heading under a different parent, even though that arrow would look available.
There is also no numbering of the rows: the engine's own TOC numbers sections at render
time (`src/lib/wikitext/toc.ts`), and a second numbering in the editor would be a second
answer to the same question.

Nor, in the structural undo (§12): no merging of the two stacks. There is the browser's,
which cannot be read, and the editor's, and after an edit that reached the first one the
second is dropped rather than guessed at.

Nor, inside a table: no dragging a row or a column to reorder it — the axis menus and
`table.ts`'s `moveRow`/`moveColumn` do that, and a drag would be a second gesture for an
edit the keyboard has to be able to make anyway. No cell merging (`colspan`/`rowspan` are attributes the engine's sanitizer
owns and the editor keeps verbatim — §2 — and a control that wrote them would be the editor
deciding what an article's markup means), no editing a table's own `class=`/`style=`, no caption
control, and no selecting a range of cells. Each is a real feature; none can be added without the
editor beginning to *interpret* an attribute string it currently only carries.

## 8 — Never losing an edit

Two defences, because they fail differently: one catches the author who leaves on purpose,
the other catches the tab that is closed, crashed or reopened a day later. Neither may fire
on a page the author never touched, and neither may cost a keystroke.

"Touched" is deliberately stricter than "worth publishing". The translate flow (decisions O4)
prefills a new page from the EN head, which enables Publish but is not an edit anybody made;
both defences below read the stricter of the two, so leaving a prefilled page that was only
looked at warns about nothing and stores nothing.

### 8.1 — Leaving

While the buffer has been changed, a `beforeunload` handler asks the browser to warn. It is
registered **once**, on mount, and reads a ref: re-binding it per keystroke would be a cost
per keystroke, and it is also how such a listener leaks — the removal has to name the same
function object, and a new closure per render does not.

Cancel asks through a dialog of ours rather than `window.confirm`, which cannot be
translated, cannot be themed and blocks the whole tab. Cancel stays a *link*, so a
Ctrl-click still opens the article beside the editor and loses nothing; only a plain click
on a changed buffer is intercepted. Confirming discards the draft along with the buffer,
because the dialog says it will.

A successful publish disarms both.

### 8.2 — The draft

The buffer is written to `localStorage` on a one-second debounce, under a key naming the
**page, the locale and the parent revision** —
`hqhq-wiki:draft:{locale}:{titlePath}:r{n}`, both parts percent-encoded so that one page's
key can never be a prefix of another's. Opening the editor reads every draft row for that
page and offers at most one: a banner saying when it was saved, with *restore* and
*discard*.

Which one, and whether to warn, are pure functions in
`src/components/wiki/editor-draft.ts`, tested without a browser:

- A draft equal to the server's text is **not offered**. That is a page which was opened
  and closed, and a banner that appears for everybody is one nobody reads.
- The draft filed under *this* revision's key wins, and is offered plainly. It was written
  against exactly the text on screen.
- A draft found under **another** revision of the same page is still the author's work, so
  it is still offered — but never silently. Somebody has published since, and restoring it
  writes over them, so the banner says which revision it was written against. Withholding
  it instead would be the other way to lose an edit.

Every storage call is guarded: `localStorage` throws on first access in private mode and
wherever site data is blocked, and `setItem` throws on a full quota. A row that cannot be
read, cannot be parsed, or carries a shape this code did not write is not a draft — it
could otherwise reach a buffer that Publish posts over an article.

Publishing clears every draft of the page at every revision, and so does an explicit
discard.

## 9 — Find and replace

Renaming one item across a long article is a real chore, and the browser's own find cannot
do the second half of it. `Ctrl/Cmd+F` opens a strip directly above the editing surface,
in **both** modes: query and replacement, match count, case-sensitive and whole-word
toggles, next/previous, replace one and replace all. `Escape` closes it and hands the focus
back to wherever the shortcut was pressed.

The strip is not modal. The article stays editable underneath it, which is what makes
"replace, look, replace" one motion rather than three.

### 9.1 — The search is over the buffer

**Not over either DOM.** That single decision is what makes one implementation serve both
modes, and it is the only way a replacement can be exact:

- Source mode edits the wikitext and visual mode edits a rendering of it, so a search
  written against a surface would be a second search to write, to test and to keep in step.
  The one string both modes agree on is the buffer.
- A match is a pair of offsets, so applying one is a splice. No markup is consulted,
  invented or re-parsed, and §4 decides what publishes exactly as it does for a keystroke.
- It reaches text no surface shows. A name inside `{{Infobox moon|…}}` is an atomic node's
  `source` (§5), and renaming *that* is half of why an author opens this at all.

`src/components/wiki/editor-find.ts` is the matching, as pure functions — given text, a
query and the toggles, the list of ranges — so all of it is tested without a browser.
Three rules it keeps that a naive version gets wrong:

1. **The query is literal.** No `RegExp` is ever built from it, so `[[`, `{{`, `.` and `*`
   are characters. Whole-word is the one place a regex appears and it tests a single
   *character* of the buffer, in the Unicode class `\p{L}\p{N}_` — a rule written
   `[A-Za-z]` would call every Hangul syllable a word boundary.
2. **Case folding preserves length**, because an index into the folded haystack has to be
   an index into the original. A character whose lowercase is not one unit long (`İ`) is
   left unfolded rather than allowed to move every offset after it.
3. **Matches never overlap.** `aa` occurs once in `aaa`: the scan resumes at the end of the
   match it took, because overlapping ranges cannot all be replaced and a count the buttons
   refuse to honour is a lie.

Whole-word asks for a boundary only where the *query's own* edge is a word character —
`[[` does not begin inside a word, so a toggle that refused every hit of it would read as
broken rather than as a rule.

### 9.2 — Applying one

A replacement goes through the island's `editContent`, the same path the page-tools rail's
tag chips and the version strip's `+` take: it reads the base off the **live** surface, so
a replacement can never revert keystrokes the visual editor's debounce has not published
yet. The transform runs *inside* that read and recomputes the offsets against exactly the
string it was handed — an index computed a render earlier could name a different span of a
buffer that has taken a keystroke since.

**Replace-all never reads its own output.** The result is assembled by copying the spans
*between* the matches out of the original string, so a replacement containing the query
(`cat` → `cats`) is written once per original match instead of finding itself forever.
Replacing one at a time keeps the same promise a different way: the strip anchors on an
*offset* rather than an index, and after a replacement that offset is the end of what was
just written, so the next match is the first hit that is not the output.

In source mode the textarea's caret is left sane: the replacement is selected and its line
scrolled to the middle of the pane (`revealInTextarea`, in `editor-source.tsx`, which owns
those metrics). React re-renders the controlled textarea with a new value and the browser
parks the caret at its end; this puts it back.

### 9.3 — Showing the match, without writing anything

The strip prints the current match **in context**, cut straight out of the buffer. That is
the presentation that is identical in both modes and the only one that can show a match the
visual surface never renders.

Beyond that the match is **scrolled to and selected** — and deliberately *not* highlighted
inside the contenteditable. Marking every hit there would mean writing elements into the
surface that `domToDocument` then has to be taught to ignore, and §3's rule runs the other
way: markup wearing none of our labels is the author's. A wrapper left behind by a
stripping pass that ran a moment late would publish itself and cost §4's byte-identical
republish on a block nobody edited. A scroll and a browser selection write nothing at all —
a `Range` is made of nodes that are already there — so the round trip cannot notice the
search happened.

Crossing from an offset to the surface is therefore deliberately *coarse*: `blockSpans`
cuts the buffer into the blocks the surface drew from it (the arithmetic of
`serializeDocument`, restricted to a freshly parsed document, where every block emits its
own `source` and its own `gapAfter`), and the surface is asked for a block plus an ordinal
— the third "Artifice" of that paragraph is the third one however the paragraph spells its
bold. The block is named twice, by `data-ve-id` and by position, because the two keys fail
in different places: the parser numbers blocks positionally while the surface mints an id
for every block the author creates, so the id is exact until something is typed and the
position is right afterwards. Where even that does not land — a chip, whose body is the engine's
rendering rather than the buffer's text; a match spanning `'''`; a buffer holding CRLF,
which the parser folds and the spans then refuse to guess at — the block is scrolled to and
nothing is selected. Failing by doing *less* is the rule: a wrong selection would be the
editor claiming a match is somewhere it is not.

The focus is handed back after every reveal, because moving the document selection can move
the focus with it in some engines, and a strip whose next arrow typed into the article
would be worse than one that did not scroll.

### 9.4 — The shortcut is the way in

`Ctrl/Cmd+F` is bound to the window, not to the editing surface, so it works from a page
that has just loaded and nothing has been clicked in yet — and it is suppressed while a
dialog is up, since opening the strip behind a modal would pull the focus out of the trap
that dialog promised a screen reader. Pressed a second time it puts the caret back in the
query field rather than remounting the strip, which would throw away the replacement and
the toggles halfway through a rename. It opens seeded with the selection, single-line and
short, so "select the name, press the shortcut" is already the rename.

## 10 — The outline, and the size of the page

### 10.1 — The outline

A long wiki article is navigated by its headings, and the editor had no map of one at all.
`Ctrl+F` finds a word; nothing answered "what is on this page, and in what order".

The outline is a card in the **page-tools column**, above the rail's own card, listing
every heading in document order at the depth the wikitext gives it. Three placements were
possible and the column won on the constraint that rules the others out: a third column
beside the surface would take its width from the writing column, and on a laptop the
writing column is the one thing that must not get narrower. The page-tools column already
exists, already costs that width, and is already where the facts *about* the page are
drawn from the buffer — the templates it transcludes, the categories it files under. An
outline is the same kind of fact. It is a card of its own rather than a section inside
`editor-rail.tsx` because the rail folds its contents away, and an author who folds the
tool sections to see more of the page wants the map more, not less.

It is **derived from the buffer**, which is the decision §9.1 already made for find and
replace and for the same reason: source mode edits the wikitext and visual mode edits a
rendering of it, so an outline written against a surface would be a second outline to
write, to test and to keep in step. `editor-outline.ts` is all of the arithmetic, pure and
tested without a browser.

Every row carries its position **twice**, because the two surfaces ask in different units
and the two keys fail in different places: a **block index**, which is what `blockUnits`
counts and what a move moves, and a **buffer range**, which is what the source textarea
scrolls to. The ranges obey `blockSpans`' rule exactly (§9.3): a buffer the parser had to
fold — one holding CRLF — yields no ranges at all rather than ranges that are off by a
little, and a row with no range simply does not scroll in source mode. Its block index
still works, so visual mode is unaffected.

**Clicking a row** scrolls to the heading and puts the caret in it. In visual mode that is
`focusBlock`, which finds the block by `data-ve-id` and falls back to its position — the
same two keys, failing in the same two places, as §9.3's reveal. In source mode it is
`revealInTextarea` over the heading's range, followed by a `focus()` the find strip
deliberately does not do.

**Moving a section** is what the block handle of §3.1 cannot give. A section is the
heading and everything under it up to the next heading of the same or a higher level, and
it moves **among its siblings** — the nearest heading in that direction at the same level
with the same parent. Both halves matter:

- Walking away from a row, a *deeper* heading belongs to another section and is stepped
  over, so a section always clears the whole of the neighbour it passes rather than
  landing inside it.
- A *shallower* heading is the enclosing section's edge and stops the walk. So under
  `== A ==  === A1 ===  == B ==  === B1 ===`, `A1` has **no** next sibling: `B1` is at the
  same level, but moving `A1` onto it would take it out of `A` and put it into `B`. That
  is a re-parenting, not a reorder, and §7 says why this editor does not offer one. The
  arrow is disabled instead — disabled rather than inert, the rule §3.1's gutter handle
  already keeps.

The blocks *before* the first heading are in no section, and no plan can displace them: a
page's lead belongs to the page, and a mover able to move it could bury the article's
first sentence under a subsection.

The plan — a run of blocks, a destination, and the block count it was computed over — is
applied by each surface in its own terms, and there is exactly one mover per surface:

- **Visual mode** re-parents the elements with `moveBlockRun` (`ve-selection.ts`), which
  *is* `moveBlock`'s move over a longer run — `moveBlock` now delegates to it, so §3.1's
  promise carries over without being re-argued. Every block keeps its `data-ve-id`, so
  `domToDocument` still matches it to the block it was parsed from and §4 still emits it
  from `source`: **an article whose sections were swapped republishes with every
  paragraph, heading and table byte-identical, in a new order.** The surface is not
  reloaded either, so the caret stays where it was and no atomic preview is re-fetched.
- **Source mode** has no DOM to re-parent, so `applySectionMove` moves the blocks in the
  model and re-serializes. Every block is untouched and comes back from its own `source`;
  what cannot be carried along is the whitespace, because `gapAfter` belongs to a *pair*
  and three of the document's pairs no longer exist. §4's rule for that is already
  written down and `domToDocument` already keeps it — a block whose successor changed
  loses its gap — so this keeps the same rule rather than inventing a second one. That is
  also what makes the two movers agree byte for byte, which `ve-selection.test.ts`
  asserts: a section that came out different depending on which mode the author happened
  to be in would be a difference nobody could see until they switched.

The plan carries its **block count** so a surface can refuse it. The visual surface
serializes on a 250 ms debounce, so the buffer a row was drawn from can trail the DOM;
before anything moves, the plan is recomputed against the text read back off the *live*
surface (the discipline `editContent` already follows), the clicked row is checked against
that fresh outline, and the surface refuses outright if its own block count disagrees.
Moving the wrong six paragraphs is much worse than moving none.

**The caret's section is marked**, and the two surfaces are asked differently because only
one of them can afford to be asked often:

- The visual surface already reports its caret's context on every selection change, and
  that report is deduplicated by a fingerprint; the block index joins the fingerprint, so
  a caret walking a paragraph reports nothing and only *crossing* a block does. The
  section is then resolved at render, and cannot be stale.
- The source textarea reports an offset through React's `onSelect`, which fires on every
  arrow key. A render per arrow key is precisely the per-keystroke cost §8 forbids, so the
  section is resolved in the handler and only the resolved index is stored — React bails
  out of nearly every one of them. The price is a mark resolved against the outline of a
  moment ago, which can only differ if a heading was typed since, and typing moves the
  caret, which recomputes it.

The lead is marked as **no** section rather than as the first one, because that is what it
is.

The whole map costs one `parseDocument` per buffer change, memoised. That was measured
rather than assumed: it is *cheaper* than any one of the four `highlight()` scans this
island already runs per keystroke — the version bar's `versionsUsed`, the rail's
`templatesUsed` and `categoriesUsed`, and `namedRefsUsed` (§5.5).

### 10.2 — Two conveniences

**The word and character count**, in the publish bar beside the minor-edit box. It counts
the **buffer** — the wikitext, braces and all — which is a limitation stated rather than
hidden: the buffer is the one string both modes share, and counting rendered prose would
mean running the engine on every keystroke to answer a number in the corner of the screen.
A word is a run of non-whitespace, which is the eojeol Korean actually separates as well as
the word English does, and the whitespace set is JavaScript's own `\s` — which includes
U+3000, the ideographic space CJK text is really written with. Characters are counted as a
reader counts them: **code points**, so one emoji is one character rather than the two
units `String.length` reports. The scan is one pass with no allocation, memoised on the
buffer, so it costs no keystroke; and it is not an `aria-live` region, because a figure
re-announced on every keystroke would talk over the article being written.

**`Ctrl/Cmd+0` and `Ctrl/Cmd+2`…`Ctrl/Cmd+5`** set the caret's block format in the visual
surface — normal text, then the four heading levels the format menu offers. They are the
numbers the wikitext itself spells (`Ctrl+2` writes `== x ==`) and the bindings MediaWiki's
own visual editor uses. `1` and `6` are absent because the menu offers neither `h1` nor
`h6` (§1), and a shortcut for a format the format menu refuses would be two answers to one
question. They are read off `event.key` — the digit the reader's keyboard *prints* — so
Shift is not excluded: a layout that needs Shift for a digit reports the digit, and one
that does not reports something else entirely for the shifted key.

**The shortcuts dialog** now lists every binding §6 names, which it had fallen two waves
behind on: `Alt+Arrow` (§3.1), `Ctrl/Cmd+F` (§9) and these five. The five carry the format
menu's own names rather than names of their own, so an author who learns "Sub-heading 1"
from the block menu meets that name and no synonym here.

## 11 — What the clipboard means

Added 2026-09-04. A paste used to be `insertText`: two paragraphs arrived as one, a
spreadsheet arrived as tab characters, a heading arrived as `## Title` in running prose,
and a link arrived as bare punctuation the author then wrapped by hand. Every one of
those is a structure the clipboard already knew about and the editor threw away.

`src/lib/visual-editor/paste.ts` is the whole decision and it is pure: it sees strings
and returns strings, never a DOM and never a `Range`. The surface decides only *where*
the answer goes.

**`text/plain` only, always.** The clipboard's `text/html` is not read and must not be
(§7). Everything below is recovered from the plain text — which is also the flavour a
spreadsheet, a terminal, a markdown file and a chat client all agree on.

**The paste is read as one document, not line by line**, and the first of three readings
that fits wins:

1. **A URL.** Over a selection it becomes the link around it; alone at the caret it
   becomes `[[Page]]` when it names a page of *this* wiki, and is left as text otherwise,
   since the engine linkifies a free URL already (wikitext-spec §6.2) and `[url]` would
   put a `[1]` on screen in its place. A URL of ours is read back through `pathToTitle`,
   the same function the article route reads it with, and a `Category:` or `File:` page
   keeps the **leading colon** that makes it a link rather than a filing or an embed —
   the rule §5.4 already keeps for the link dialog.
2. **Wikitext.** Text carrying this wiki's own markup (`[[`, `{{`, `{|`, `== x ==`,
   `----`, `<ref>`, a version tag) is pasted **verbatim**: somebody copying a passage out
   of another article means the bytes they copied. `''` is deliberately not in that set —
   it is also how a sentence spells a quotation inside a quotation.
3. **Markdown, or a grid.** Anything else. Markdown's emphases, links, code spans,
   headings, lists, quotes, rules and fenced code become this wiki's spellings of the
   same things; a **tab-separated grid** (two or more lines, all the same width) and a
   **markdown table** become a real table. `#` is `==`, because a wiki article's h1 is
   its title (§1's input rules decide the same collision the same way), and a markdown
   table's alignment colons are dropped rather than written as a `style=` the editor
   would then only be carrying (§7).

**Inside a table cell the answer is always inline** (wikitext-spec §7.3), with the lines
folded to spaces: a cell holds inline content and nothing else, and a block pasted into
one is a table the model then has to refuse — which turns a table somebody was editing
back into a chip.

Nothing is escaped, on purpose (§4): a `|` that survives into a cell splits it on the
next parse exactly as a typed `''` becomes italics.

The surface places the answer in two ways, and the difference is what each *is*. An
**inline** answer goes in through `insertHTML`, so the browser splits nothing, deletes
the selection itself and records the paste on its own undo stack — that is the common
paste, landing mid-sentence. **Blocks** are placed the way every other block insertion is
placed: after the block the caret is in, or *over* it where that block is empty, which is
the paste an author actually makes. `paste.test.ts` asserts that every block answer is a
fixed point of the parser, because the surface draws what it parses and §4 decides what
publishes.

### 11.1 — And what a copy puts on it

The other half, and the one that makes copying *between* articles lossless: a copy or a
cut out of the visual surface writes **wikitext** to the clipboard, not the rendering.

What the browser would put there is the rendered text, which is lossy in exactly the
places this editor is about — a link comes out as its label, an infobox as the words
inside its preview, a heading as a line of prose. Copy a paragraph, paste it into the next
article, and the links were gone. With the wikitext on the clipboard, §11's second reading
pastes it back verbatim and nothing is lost; pasting into **source mode**, or into a
diff, or into a bug report, gives the bytes as well.

The selection is read with `domToDocument` over a *clone* of the selected markup — the
same reader a save runs, so a link is a link and a chip is its `data-ve-src` — against an
empty `prev`, since a fragment of a page has no original bytes of its own to keep and §4's
bookkeeping belongs to the blocks that stayed behind. A cut then deletes through
`execCommand`, so it stays on the browser's undo stack like any other cut.

Only `text/plain` is written. Wikitext is the one thing this editor edits, and a
`text/html` flavour would mean deciding what our own chrome — a chip's buttons, a version
block's field — looks like in somebody else's document.

## 12 — Undoing an edit the browser never saw

Added 2026-09-04, and it is what made §3.1's drag affordable.

Typing, the marks, the list commands and `insertHTML` go through `document.execCommand`,
which puts them on the **browser's** undo stack. But four of this editor's edits are
plain DOM surgery and the browser knows nothing about them: moving a block (§3.1),
dropping one after a drag, a table operation (§3.2), and a paste that arrived as blocks
(§11) — plus the duplications and insertions that work the same way. Before this,
`Ctrl+Z` did nothing at all after any of them.

`ve-history.ts` is a stack of **snapshots of the surface's own markup**, and a snapshot
rather than an inverse operation for a reason §4 dictates: every one of those edits is a
DOM move that rebuilds nothing, and an "opposite move" would have to know that in four
places. Markup restored whole comes back carrying the `data-ve-id`s and `data-ve-src`s it
went in with, so the next read still matches every block to the block it was parsed from
and an undone page still publishes its original bytes.

**The window is the one thing to understand.** A structural undo is offered only while
nothing has been typed since; the moment anything reaches the browser's own stack, this
one is dropped and `Ctrl+Z` is the browser's again. That is a deliberate refusal to
guess — there is no way to interleave two stacks when one of them cannot be read, and a
snapshot restored on top of the browser's undo could resurrect text the author had just
removed. It is the same rule the input rules already keep for their own one-step undo,
and it covers the case that actually happens: a drag lands wrong, and `Ctrl+Z`
immediately after puts it back.

There is exactly one funnel for that window rather than a list of keys: an `input` event
is the browser recording an edit, every `execCommand` dispatches one, and no structural
edit of ours does. So `onInput` empties the stack, and the rule is about what reached the
document rather than about which keycap was pressed.

The stack is bounded twice — fifty edits, four megabytes of markup — and the oldest go
first, which is also the order an author stops caring about them in.

## 13 — `[[`, `@` and `{{`

Added 2026-09-04. A wiki is written in links, and the hard part has never been the
brackets: it is remembering how the page is spelled. The link dialog (§5.4) answers that
with a combobox, but it costs the author the sentence. So the two things an author types
*inside* a sentence open the search where they stand:

| typed | searches | a row writes |
|---|---|---|
| `[[art…` | the page index (`GET /api/search/suggest`) | `[[Artifice]]` |
| `@art…` | the same | the same |
| `{{inf…` | the `Template:` namespace (`GET /api/templates?q=`) | opens §5.1's parameter form on that template |

`src/lib/visual-editor/mention.ts` is the reading and it is pure: it sees the text before
the caret — the same string `slashContext` is asked about — and nothing else.

- **The triggers are the wikitext**, which is what an author who knows this wiki already
  types. The panel is then a help rather than a mode: ignore it, close the brackets by
  hand, and exactly the same wikitext ends up in the buffer. Nothing is written on its
  own, and dismissing is not an edit.
- **`@` is the one borrowed symbol**, admitted only at a **word boundary** so an email
  address never opens a page search: in `crew@company` the `@` follows a letter and means
  what it has always meant.
- **A query stops** at the closing bracket, at a newline, and at `|` — which opens a
  link's *label* (spec §5.3), from where what is being typed is no longer a page name —
  and it is capped, because a "page name" the length of a paragraph is a paragraph.
- **The nearest trigger wins**, both against the other kind and against the slash menu:
  two panels claiming the arrows and Enter from the document in the capture phase is a
  row taken in a list the author was not looking at.

The panel is the slash menu's own component (`ve-slash-menu.tsx`), so the two lists share
one keyboard contract and one set of manners. Two things differ, and both are props: the
rows are **not filtered again** here — the search already answered this query, and
re-ranking would drop a page it matched on something other than the words in its title —
and the panel has a `busy` line, since an empty list with a request still owed is not the
same as no matches.

A **page** row writes the link as content, not as a chip: `[[Gold bar]]` becomes an
`<a data-ve="link">` the caret can walk through (the `wikitext` action, `actions.ts`).
A **template** row raises §5.1's dialog on itself instead, because `{{Infobox moon}}`
with no parameters is a call that renders nothing — the name becomes the dialog's
`initialSource`, and braces are still never typed.

## 14 — Two more conveniences

Both added 2026-09-04, both Notion's.

**The space below the article is a place to write.** A page that ends in a table, an
infobox or any other chip ends in something a caret cannot be put into, so clicking under
it did nothing and the block's own "+" was the only way to another paragraph. A click in
the surface's bottom padding — told apart from a click in the left gutter by the
pointer's `y` against the last block's bottom edge — now appends one and puts the caret
in it. A page already ending in an empty paragraph gets the caret and no second blank
line, and no slash menu opens: the pointer went there to write, not to pick a block.

**`Ctrl/Cmd+D` duplicates the caret's block**, which is the gutter menu's Duplicate row
under a keyboard. The copy is given **fresh ids**, and that is the whole of §4 here: an
id is what matches a block to the one it was parsed from, so a copy carrying the
original's would be two blocks claiming one history.

## 15 — A picture dropped on the page

Added 2026-09-04, and it is the entry §7 used to refuse. Dropping an image file onto the
surface, or pasting one — which is what a screenshot is — opens §5.2's media dialog with
that file **already uploading**. Everything after that is the flow it always had: the
name-clash warning, then caption, layout, alignment and width over a live preview, then
`[[File:…]]`.

The surface uploads nothing itself, and that is the point: one uploader, one validation
(`src/lib/media.ts`, run by the dialog), one set of placement controls. A dropped picture
is not a second way to get a different answer.

Exactly one file at a time. A drop of five is a batch upload, which this editor does not
have and which a dialog shaped around one file's caption and alignment cannot serve;
taking the first of five silently would be worse than taking none, so a multi-file drop
does nothing. Whether something *is* a picture is read off the file's own type rather
than its name — a drag of an extensionless file still says `image/png` — and that
question decides only whether the drop is a picture or a block move (§3.1).
