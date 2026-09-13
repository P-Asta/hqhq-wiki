# hqhq-wiki Wikitext Engine — Implementation Specification

**Status:** Authoritative. Deviations require an entry in Appendix A (Divergences).
**Audience:** Engineers implementing the TypeScript wikitext parser for hqhq-wiki (Next.js, Lethal Company High Quota wiki).
**Compatibility target:** MediaWiki core parser (legacy PHP parser semantics, ~MW 1.39) + ParserFunctions + Cite, except where Appendix A says otherwise.

This document is self-contained: every module can be implemented from this spec without consulting MediaWiki source. Where MediaWiki's behavior is a historical accident we still specify it exactly (it is what wiki authors expect), and where we intentionally diverge, the divergence is called out inline as **D-n** and collected in Appendix A.

---

## 0. Scope, conventions, and global configuration

### 0.1 In scope

Inline formatting (`''`/`'''`), headings + TOC, paragraphs/pre/hr, lists, internal links (incl. files, categories, subpages), external links, tables, templates + parameters, parser functions and magic variables, extension-style tags (`nowiki`, `pre`, `ref`/`references`, `gallery`, `syntaxhighlight`), raw-HTML allowlist + sanitization, redirects, `DISPLAYTITLE`, behavior switches (`__TOC__` etc.), and the full parsing pipeline + AST.

### 0.2 Out of scope (explicitly)

| Feature | Behavior in hqhq-wiki |
|---|---|
| `subst:` / `safesubst:` | No pre-save transform exists. `{{subst:X}}` is treated as `{{X}}` (the prefix is stripped and the template transcluded). **D-8** |
| Signatures `~~~`, `~~~~`, `~~~~~` | Rendered literally as typed (no PST). **D-9** |
| Interwiki / interlanguage links | Unknown namespace-like prefixes are part of the title (see §5.8). No interwiki table. |
| Scribunto `{{#invoke:}}` | Renders `<span class="error">Script support is not available: #invoke</span>`. |
| `<math>` | Renders as escaped literal text like any unknown tag (§10.7). |
| Magic links (ISBN, RFC, PMID) | Not linked; rendered as plain text. **D-10** |
| Labeled Section Transclusion, `<section>` | Not supported. |
| `<poem>`, `<timeline>`, other extensions | Unknown-tag behavior (§10.7). |
| Language converter `-{ }-` | Treated as plain text. |

### 0.3 Conventions used in this document

- Input examples are fenced as `wikitext`; expected output as `html`.
- Expected HTML shows the **shape** that matters: attribute order and insignificant whitespace between block tags are not normative; tag structure, attribute values, class names, ids, and text content are normative.
- Unless a wrapping element is the point of the example, inline examples are shown inside the `<p>` the paragraph pass would add.
- "EOL" = end of a source line. "Line" = text between `\n` characters after newline normalization.
- "trim" = strip Unicode whitespace (at minimum space, tab, `\n`, `\r`, `\f`) from both ends.

### 0.4 Global configuration constants

```ts
interface WikiConfig {
  siteName: string;              // "HQHQ Wiki" — value of {{SITENAME}}
  articlePath: string;           // "/wiki/$1" — internal link href pattern
  redLinkPath: string;           // "/wiki/$1?redlink=1" (or same as articlePath)
  externalLinkRel: string;       // "nofollow noopener" or "" per SEO policy
  caseSensitive: false;          // first letter of titles is case-insensitive (MW default)
  maxTemplateDepth: 40;          // expansion frame depth
  maxIncludeSize: 2_097_152;     // bytes of post-expansion include text
  maxExpensiveCalls: 100;        // #ifexist etc.
  thumbDefaultWidth: 220;        // px, base width for |thumb|
  uprightDefaultFactor: 0.75;
  timezone: 'UTC';               // for CURRENT* variables
  fragmentMode: 'html5';         // heading id encoding, §2.5
  namespaces: NamespaceTable;    // §5.8
}
```

### 0.5 Terminology

- **Strip marker**: an opaque placeholder of the form `\x7f'"`UNIQ--<name>-<8 hex digits>-QINU`"'\x7f` substituted for protected content (`<nowiki>`, rendered extension tags) so later passes cannot see or mangle it. Restored at the very end of rendering. The `\x7f` (DEL) bytes make accidental collision with author text impossible; any raw `\x7f` in input is stripped during normalization.
- **Frame**: one level of template expansion, carrying the argument list and the ancestor-title chain (for loop detection).
- **Title**: a normalized page name `{ namespace: number, pageName: string, fragment?: string }`; normalization rules in §5.7.

### 0.6 Pipeline overview (normative detail in §14)

1. **Normalize** input text (§14.1).
2. **Preprocess**: build a brace/tag token tree; strip comments; capture extension tags; expand templates, template parameters, parser functions and variables with frames and limits (§8, §9, §14.2–14.4). Output: expanded wikitext with strip markers.
3. **Sanitize** raw HTML tags left in the text (§11).
4. **Block parse** the expanded text: redirect check, tables, headings, hr, lists, pre, paragraphs (§2–§4, §7, §12).
5. **Inline parse** leaf text: internal links/files → apostrophe bold/italic → external links (§1, §5, §6).
6. **Render** AST → HTML; build TOC; append references if needed; restore strip markers; emit page metadata (categories, display title) (§14.6–14.8).

Everything below is written module by module in that order of user-visible importance, not pipeline order.

---

## 1. Inline formatting: `''italic''`, `'''bold'''`, and apostrophe madness

Bold and italic are produced by runs of apostrophes (U+0027 only; typographic quotes never count). This is the most order-dependent part of the grammar. It is **strictly line-scoped**: the algorithm runs once per source line of inline content, and unclosed formatting never continues onto the next line.

### 1.1 Tokenization of a line

Split the line on every maximal run of **2 or more** apostrophes (`/''+/`). Runs of exactly 1 apostrophe are plain text (`it's`). Then normalize each run:

| Run length | Interpretation |
|---|---|
| 2 | italic toggle token `I` |
| 3 | bold toggle token `B` |
| 4 | **1 literal apostrophe appended to the preceding text** + bold token `B` |
| 5 | bold-italic token `BI` |
| 6+ | **(length − 5) literal apostrophes appended to preceding text** + `BI` token |

Count `numItalics` = number of `I` tokens + number of `BI` tokens; `numBold` = number of `B` tokens + number of `BI` tokens. (The literal apostrophes split off from 4/6+ runs count toward neither.)

### 1.2 The bold-vs-italic re-balancing rule

If — and only if — `numBold` **and** `numItalics` are **both odd** on the line, exactly one `B` token is reinterpreted as *literal apostrophe + `I` token* (i.e. the author probably wrote `l'''arc''` meaning `l'` + italic). Choose which `B` by scanning `B` tokens left to right and classifying each by the text immediately preceding it (the token's left context, after the literal-apostrophe adjustments of §1.1):

- last char of preceding text is a **space** → candidate class *space*;
- else second-to-last char is a **space** (i.e. the token is preceded by a single-character word) → class *single-letter word*; the scan **stops at the first one of these**;
- else → class *multi-letter word* (this includes a `B` at the very start of the line, and — matching the PHP `substr` clamping quirk — a `B` preceded by exactly one character at line start).

Pick, in priority order: the first *single-letter word* candidate; else the first *multi-letter word* candidate; else the first *space* candidate; if there are no `B` tokens at all (both odd counts came from `BI` tokens), do nothing.

Conversion: replace that `B` token with an `I` token and append one `'` to the preceding text.

### 1.3 The state machine

Walk the token/text sequence with state ∈ { `''` (empty), `i`, `b`, `ib`, `bi`, `both` } and a side `buffer`. Text chunks: if state is `both`, append to `buffer`; otherwise emit to output.

Token `I` (`''`):

| state | emit | new state |
|---|---|---|
| (empty) | `<i>` | `i` |
| `i` | `</i>` | (empty) |
| `b` | `<i>` | `bi` |
| `bi` | `</i>` | `b` |
| `ib` | `</b></i><b>` | `b` |
| `both` | `<b><i>` + buffer + `</i>` | `b` |

Token `B` (`'''`):

| state | emit | new state |
|---|---|---|
| (empty) | `<b>` | `b` |
| `b` | `</b>` | (empty) |
| `i` | `<b>` | `ib` |
| `bi` | `</i></b><i>` | `i` |
| `ib` | `</b>` | `i` |
| `both` | `<i><b>` + buffer + `</b>` | `i` |

Token `BI` (`'''''`):

| state | emit | new state |
|---|---|---|
| (empty) | *(start buffering; buffer := "")* | `both` |
| `b` | `</b><i>` | `i` |
| `i` | `</i><b>` | `b` |
| `bi` | `</i></b>` | (empty) |
| `ib` | `</b></i>` | (empty) |
| `both` | `<i><b>` + buffer + `</b></i>` | (empty) |

End of line — close what remains, in this exact order:

- state `b` or `ib`: emit `</b>`
- then state `i`, `bi`, or `ib`: emit `</i>`
- then state `bi`: emit `</b>`
- state `both` with non-empty buffer: emit `<b><i>` + buffer + `</i></b>`

Note the deliberate asymmetries: a `BI` closed by another `BI` renders `<i><b>…</b></i>`, but a `BI` left unclosed at EOL renders `<b><i>…</i></b>`.

### 1.4 Scope and interaction with other constructs

- The pass runs over each line of inline content **after** internal/external link parsing in the AST pipeline. Apostrophes inside a link **label** participate in the same line's token stream (MediaWiki behaves this way because it converts links to HTML first and then runs quotes over the whole line). If an italic/bold region would cross a link-label boundary, close it at the boundary and reopen inside/outside so the emitted tree stays well-nested. **D-1** (MW can emit misnested tags here; we do not.)
- Apostrophes inside `<nowiki>` are strip markers by this point and invisible to the pass.
- Apostrophes in link **targets**, template names, and attribute values are never formatting.
- Headings, list items, table cells and captions each run the pass on their own content line(s) independently.

### 1.5 Examples (hand-run through §1.1–1.3)

1. Basic pair:

```wikitext
''italic'' and '''bold'''
```
```html
<p><i>italic</i> and <b>bold</b></p>
```

2. Five apostrophes both sides:

```wikitext
'''''x'''''
```
```html
<p><i><b>x</b></i></p>
```
(`BI` opens `both`-buffering; closing `BI` in state `both` emits `<i><b>x</b></i>`.)

3. Run of four — first apostrophe is text:

```wikitext
''''four''''
```
```html
<p>'<b>four'</b></p>
```
(Opening 4-run → literal `'` + `B`; closing 4-run → `'` appended to `four` + `B`.)

4. Run of six — surplus apostrophes are text:

```wikitext
''''''six''''''
```
```html
<p>'<i><b>six'</b></i></p>
```
(6-run → `'` + `BI` on both sides; counts are 1 bold/1 italic — both odd — but there is no plain `B` token, so re-balancing does nothing.)

5. Re-balancing, multi-letter word case (`numBold`=1, `numItalics`=1):

```wikitext
'''a'' b
```
```html
<p>'<i>a</i> b</p>
```
(The lone `B` is converted to `'` + `I`.)

6. Re-balancing, single-letter word wins:

```wikitext
It's a'''nice'' day
```
```html
<p>It's a'<i>nice</i> day</p>
```
(`B` preceded by `a` which is preceded by a space → single-letter-word candidate → becomes `a'` + `I`.)

7. No re-balancing when only bold count is odd:

```wikitext
'''''x''
```
```html
<p><b><i>x</i></b></p>
```
(`BI` then `I`: state `both` → emit `<b><i>x</i>`, state `b`; EOL closes `</b>`.)

8. `BI` closed by `B`:

```wikitext
'''''x'''
```
```html
<p><i><b>x</b></i></p>
```
(state `both` + `B` → `<i><b>x</b>`, state `i`; EOL closes `</i>`.)

9. Interleaved close (`ib` path):

```wikitext
''a'''b'''c''
```
```html
<p><i>a<b>b</b>c</i></p>
```

10. Overlapping regions forced well-formed:

```wikitext
'''''a'' b'''
```
```html
<p><b><i>a</i> b</b></p>
```
(state `both` + `I` → `<b><i>a</i>`, state `b`.)

11. Unclosed bold auto-closes at EOL and does not leak to the next line:

```wikitext
'''bold
next line
```
```html
<p><b>bold</b>
next line</p>
```
(Same paragraph — single newline — but the second line starts with empty formatting state. A stray `'''` on the second line would open a `<b>` that closes empty at its own EOL.)

12. Italic across an internal link label (well-nested output, D-1):

```wikitext
''[[Rocket]]''s
```
```html
<p><i><a href="/wiki/Rocket" title="Rocket">Rockets</a></i></p>
```

---

## 2. Headings and the table of contents

### 2.1 Recognition

A heading is a **whole line** matching, for some level `n` from 6 down to 1 (try 6 first):

```
^ ={n} (.+) ={n} [ \t]* $
```

with `(.+)` non-empty and greedy. Consequences of trying levels high-to-low with this exact pattern:

- `== Foo ==` → level 2, content ` Foo ` (content is trimmed for display, anchor, and TOC — see 2.4).
- Unbalanced markers fall through to a lower level and the surplus `=` become **content**: `==Foo=` → `<h1>=Foo</h1>`; `=Foo==` → `<h1>Foo=</h1>`.
- `====` (a line of exactly four `=`) → `<h1>==</h1>` (levels 6..2 can't match a non-empty content; level 1 matches with content `==`).
- Trailing spaces/tabs after the closing run are allowed. **Anything else after** the closing `=` run (even a single visible char) makes the line a plain paragraph line.
- HTML comments are stripped before block parsing (§14.2), so `== Foo == <!-- x -->` **is** a heading.
- Headings are recognized **after** template expansion: a template that expands to `== Late ==` at start of line produces a real heading, and `== {{PAGENAME}} ==` works.
- A heading marker not at line start (`text == Foo ==`) is plain text. `<nowiki>== Foo ==</nowiki>` is plain text.
- Level 1 (`= Foo =`) is legal wikitext; it renders `<h1>` (skins discourage it; the parser does not).

### 2.2 Content

Heading content is inline-parsed like any other line (links, bold/italic, refs, templates already expanded). Block markup inside a heading is not possible (the heading is one line by definition).

### 2.3 Output shape

```html
<h2 id="Anchor_id">Inline content</h2>
```

We emit the id directly on the `h*` element (MediaWiki legacy wraps content in `<span class="mw-headline" id=…>`; Parsoid and modern MW put the id on the heading — we follow the modern shape). **D-2**. `[edit]` section links are not emitted by the parser; `__NOEDITSECTION__` is accepted and recorded but is a rendering no-op until section editing exists.

### 2.4 Anchor id generation

1. Take the heading's **rendered inline content**, strip all tags, decode entities → plain text.
2. Trim whitespace; collapse internal whitespace runs to single spaces.
3. Replace each space with `_`.
4. Encode per `fragmentMode: 'html5'`: keep Unicode letters/digits/punctuation as-is; the id must simply be a valid HTML id (anything but whitespace). Do **not** dot-encode (`.23`-style legacy encoding is not used). When such an id is placed in a URL fragment (`href="#…"`), percent-encode it with `encodeURIComponent`, then un-escape `%3A`→`:` for readability. **D-3** (MW additionally emits a legacy dot-encoded fallback span; we do not.)
5. Empty result → id `_`.

**Duplicate handling:** ids are unique per page. Keep a counter per base id; the 2nd occurrence gets `_2` appended, the 3rd `_3`, etc. (`Foo`, `Foo_2`, `Foo_3`). The suffixing applies to the post-encoding id, and a literal heading `Foo 2` (id `Foo_2`) colliding with a generated `Foo_2` gets bumped to `Foo_2_2` — uniqueness wins, order of appearance decides.

### 2.5 TOC generation

- Collect headings **in document order** (wikitext headings only; raw HTML `<h2>` etc. do not enter the TOC — **D-4**).
- The TOC is rendered when the page has **≥ 4 headings**, or `__FORCETOC__` or `__TOC__` is present — unless `__NOTOC__` is present. `__TOC__` wins over `__NOTOC__` (an explicit placement forces display).
- Placement: at the location of the first `__TOC__` (only the first one places; later occurrences are removed); otherwise immediately **before the first heading**.
- **TOC levels are relative, not absolute**: `tocLevel` starts at 0; for each heading, if its `h`-level is greater than the previous heading's, `tocLevel` increases by exactly **1** (regardless of the jump size); if lower, it decreases until the matching open level (as tracked on a stack of h-levels); numbering is hierarchical per tocLevel (`1`, `1.1`, `1.2`, `2`…). So the sequence h2, h4, h4, h2 yields toc levels 1, 2, 2, 1 and numbers 1, 1.1, 1.2, 2.

Output shape:

```html
<div id="toc" class="toc" role="navigation">
  <div class="toctitle"><h2>Contents</h2></div>
  <ul>
    <li class="toclevel-1"><a href="#First"><span class="tocnumber">1</span> <span class="toctext">First</span></a>
      <ul>
        <li class="toclevel-2"><a href="#Sub"><span class="tocnumber">1.1</span> <span class="toctext">Sub</span></a></li>
      </ul>
    </li>
  </ul>
</div>
```

TOC text is the heading's rendered inline content **with links flattened to their text** (a heading containing `[[A|b]]` shows `b` in the TOC, not a nested link) and formatting kept (`<i>` etc.).

### 2.6 Behavior switches (double-underscore words)

Recognized anywhere in the expanded text, case-sensitive, all occurrences removed from output and recorded in page metadata:

| Switch | Effect |
|---|---|
| `__TOC__` | Force TOC; place at first occurrence. |
| `__NOTOC__` | Suppress auto-TOC (overridden by `__TOC__`/`__FORCETOC__`… precedence: `__TOC__` > `__FORCETOC__` > `__NOTOC__`). |
| `__FORCETOC__` | Show TOC in default position even with < 4 headings. |
| `__NOEDITSECTION__` | Recorded; no-op for now (no section edit links emitted anyway). |
| `__HIDDENCAT__` | On a Category page: mark the category hidden (metadata only). |
| `__NOINDEX__` / `__INDEX__` | Recorded in metadata for the Next.js layer to map to robots meta. |

Unknown `__WORD__` sequences are left as literal text. Removal happens after template expansion (a template can emit `__NOTOC__`). Like MediaWiki's `doDoubleUnderscore`, removal occurs before block parsing, and a line left empty by the removal produces no paragraph.

### 2.7 Examples

1. Basic + TOC threshold (4 headings → TOC before the first):

```wikitext
== Alpha ==
== Beta ==
== Gamma ==
== Delta ==
```
```html
<div id="toc" class="toc" role="navigation">…1 Alpha, 2 Beta, 3 Gamma, 4 Delta…</div>
<h2 id="Alpha">Alpha</h2>
<h2 id="Beta">Beta</h2>
<h2 id="Gamma">Gamma</h2>
<h2 id="Delta">Delta</h2>
```

2. Inline markup and anchor stripping:

```wikitext
=== The ''[[Bracken]]'' room ===
```
```html
<h3 id="The_Bracken_room">The <i><a href="/wiki/Bracken" title="Bracken">Bracken</a></i> room</h3>
```
(TOC entry text: `The <i>Bracken</i> room` — link flattened, italics kept.)

3. Unbalanced:

```wikitext
==Unbalanced=
```
```html
<h1 id="=Unbalanced">=Unbalanced</h1>
```

4. Duplicates:

```wikitext
== Loot ==
== Loot ==
== Loot ==
```
```html
<h2 id="Loot">Loot</h2>
<h2 id="Loot_2">Loot</h2>
<h2 id="Loot_3">Loot</h2>
```

5. Not headings:

```wikitext
== Foo == bar
 == Leading space ==
```
```html
<p>== Foo == bar</p>
<pre>== Leading space ==
</pre>
```
(First line has trailing text → paragraph. Second line starts with a space → preformatted, §3.3.)

6. Relative TOC levels:

```wikitext
__FORCETOC__
== A ==
==== Deep ====
== B ==
```
TOC numbers: `1 A`, `1.1 Deep` (toclevel-2 despite being an h4), `2 B`.

---

## 3. Paragraphs, newlines, preformatted blocks, `<br>`, `----`

Block assembly is line-based over the expanded, table/heading/list-consumed text.

### 3.1 Line classification (per remaining line)

1. Blank line (empty or only whitespace) → paragraph separator (3.2).
2. Starts with exactly one or more spaces **and has visible content** → preformatted line (3.3).
3. `----` at line start (4 or more hyphens) → `<hr />`; any text after the hyphen run on the same line is processed as a **new** line following the hr.
4. Line whose first token is an allowed block-level HTML tag (open or close) — `table, caption, thead, tbody, tfoot, tr, td, th, div, blockquote, ol, ul, dl, li, dt, dd, pre, p, h1–h6, hr, center, figure, figcaption` — suppresses `<p>` wrapping for that line (the HTML flows as-is; inline parsing still runs on the text around the tags).
5. Anything else → paragraph text.

### 3.2 Paragraphs and blank-line runs

- Consecutive non-blank paragraph lines join into **one** `<p>`, with the newline characters preserved inside it (HTML collapses them to spaces).
- 1 blank line ends the paragraph and starts a new one.
- 2 consecutive blank lines: the following paragraph **begins with `<br />`**.
- k ≥ 3 consecutive blank lines: emit (k − 2) empty paragraphs `<p><br /></p>`, then the following paragraph begins with `<br />`.
- Blank lines at the very start/end of the document produce nothing.
- A line that becomes empty after comment stripping is a blank line, except the comment-eats-its-line rule (§14.2) removes it entirely (no paragraph break beyond what the surrounding newlines already imply).

Examples:

```wikitext
a
b

c


d
```
```html
<p>a
b</p>
<p>c</p>
<p><br />
d</p>
```

```wikitext
a



b
```
```html
<p>a</p>
<p><br /></p>
<p><br />
b</p>
```
(k = 3 blank lines → (k − 2) = 1 empty `<p><br /></p>`, then the next paragraph starts with `<br />`. Normative rule restated: k=1 → plain break; k=2 → next paragraph starts with `<br />`; each blank line beyond 2 adds one `<p><br /></p>` before it.)

### 3.3 Space-indented preformatted blocks

- A run of consecutive lines each starting with **one space** (only the first space is the marker; further spaces are content) becomes a single `<pre>` block. Each line contributes `content + "\n"`.
- **Inline markup is still parsed** inside space-pre: links, bold/italic, template output, refs all render. (This is the crucial difference from the `<pre>` tag, §10.2, whose content is literal.)
- A whitespace-only line does **not** open a pre block; but if it occurs between two pre lines it stays inside the block (as an empty line).
- A space-indented line inside a table cell/list item is **not** pre (block context there is governed by the cell/item parser; only top-of-block lines qualify).

```wikitext
 def parse():
     return '''ast'''
```
```html
<pre>def parse():
    return <b>ast</b>
</pre>
```

Normative: a fully empty line (zero characters) **closes** the pre; a whitespace-only line *between two pre lines* stays inside the block as an empty line.

```wikitext
 one

 two
```
```html
<pre>one
</pre>
<pre>two
</pre>
```

If the middle line instead contains a single space, the result is one block:

```html
<pre>one

two
</pre>
```

### 3.4 `<br>` and `----`

- `<br>`, `<br/>`, `<br />`, `<BR>`, `<br clear=left>` (attr dropped unless allowed) all normalize to `<br />`. A `<br>` does not end the paragraph.
- `----` → `<hr />`. Longer runs (`---------`) still produce exactly one `<hr />`. Three or fewer hyphens are plain text.

```wikitext
before
----
after
------rest
```
```html
<p>before</p>
<hr />
<p>after</p>
<hr />
<p>rest</p>
```

### 3.5 Examples

1. Single newline = same paragraph:

```wikitext
Line one
line two
```
```html
<p>Line one
line two</p>
```

2. `<br>` variants:

```wikitext
a<br>b<BR/>c
```
```html
<p>a<br />b<br />c</p>
```

3. Pre with entity and link:

```wikitext
 quota &amp; [[loot]]
```
```html
<pre>quota &amp; <a href="/wiki/Loot" title="Loot">loot</a>
</pre>
```

---

## 4. Lists: `*`, `#`, `;`, `:`

Lists are line-prefix driven. Every line's **prefix** is its longest leading run of characters from `*#;:`. The prefix determines a nesting path; consecutive lines share list structure to the extent their prefixes share a common prefix.

### 4.1 Marker semantics

| Char | Opens | Item element |
|---|---|---|
| `*` | `<ul>` | `<li>` |
| `#` | `<ol>` | `<li>` |
| `;` | `<dl>` | `<dt>` |
| `:` | `<dl>` | `<dd>` |

`;` and `:` share the same container: at the same depth, switching between `;` and `:` stays inside one `<dl>` (close `</dt>`, open `<dd>`), it does not close and reopen the `<dl>`.

### 4.2 Line-to-line algorithm

Maintain `lastPrefix` (initially empty). For each list line with prefix `P` and content `C`:

1. `common` = longest common prefix of `P` and `lastPrefix`, **treating `;` and `:` as equal** at the same position (they share a `<dl>`); but when they differ, the item element changes (`</dt>` → `<dd>` or `</dd>` → `<dt>`).
2. Close containers for `lastPrefix` beyond `common` (innermost first): emit `</li>`/`</dt>`/`</dd>` and `</ul>`/`</ol>`/`</dl>` for each dropped char.
3. For the shared part: close the current item and open a new one at the deepest shared level (`</li><li>` etc.). Exception: if `P` is strictly longer than `lastPrefix` and extends it, the new deeper list nests **inside the still-open item** (do not close it).
4. Open containers for each char of `P` beyond `common`: `<ul><li>`, `<ol><li>`, `<dl><dt>`, `<dl><dd>`.
5. Parse `C` (see 4.3 / 4.4) as the item's inline content.

A non-list line (including a blank line) closes everything back to depth 0. **A blank line therefore terminates the list; a following `#` list restarts numbering at 1.**

Nested lists live inside the parent `<li>`: `* a` then `** b` renders `<ul><li>a<ul><li>b</li></ul></li></ul>`.

### 4.3 Definition-list same-line split (`; term : definition`)

On a line whose prefix ends with `;`, search the content for the first `:` **at top level** — i.e. not inside `[[…]]`, not inside a strip marker, and not inside an HTML tag's `<…>` angle brackets. If found:

- `term` = content before the colon, with trailing whitespace trimmed;
- `definition` = content after the colon, with leading whitespace trimmed;
- render `<dt>term</dt><dd>definition</dd>` (the `<dd>` is a sibling at the same `<dl>` level).

If no eligible colon exists, the whole content is the `<dt>`. Multiple colons: only the **first** splits; the rest are literal text in the definition. A colon inside an external-link bracket construct (`[http://… …]`) must also be skipped — implementers should run this search on the line's raw text but skip over `[[…]]`, `[…]` and `<…>` spans. **D-5** (MediaWiki's `findColonNoLinks` mangles some URL cases; we specify the sane behavior: any colon inside a link construct never splits.)

### 4.4 Item content

Item content is inline-parsed. Block constructs cannot start inside a list line's content: `*{| …` renders a literal `{|` (tables require line-start, §7.1); `*== x ==` is literal. However, a list item may be **continued** structurally: `#:` under `#` puts a `<dl><dd>` inside the ordered item, preserving numbering; `#*` nests a bullet list inside it.

An empty content (`*` alone on a line) yields an empty `<li></li>`.

### 4.5 `:` as indentation

Lines starting with `:` outside any list context are still definition-list markup: each `:` adds one `<dl><dd>` level. This is the wiki idiom for indentation (talk pages), and it is also the only permitted way to indent a table (§7.8).

### 4.6 Examples

1. Flat and nested bullets:

```wikitext
* one
* two
** two.one
* three
```
```html
<ul><li>one</li>
<li>two
<ul><li>two.one</li></ul></li>
<li>three</li></ul>
```

2. Ordered with continuation (numbering survives `#:` and `#*`):

```wikitext
# first
#: aside about first
# second
#* sub-bullet
# third
```
```html
<ol><li>first
<dl><dd>aside about first</dd></dl></li>
<li>second
<ul><li>sub-bullet</li></ul></li>
<li>third</li></ol>
```

3. Blank line restarts numbering:

```wikitext
# a
# b

# c
```
```html
<ol><li>a</li>
<li>b</li></ol>
<ol><li>c</li></ol>
```

4. Definition list, same line and split lines:

```wikitext
; Quota : the scrap value target
; Bracken
: a monster
: another definition
```
```html
<dl><dt>Quota</dt>
<dd>the scrap value target</dd>
<dt>Bracken</dt>
<dd>a monster</dd>
<dd>another definition</dd></dl>
```

5. Colon protected inside a link (no split at the `:` in the target):

```wikitext
; [[Help:Contents|Help]] : the help page
```
```html
<dl><dt><a href="/wiki/Help:Contents" title="Help:Contents">Help</a></dt>
<dd>the help page</dd></dl>
```

6. Mixed markers `*#;`:

```wikitext
*# a
*#; term : def
*# b
```
```html
<ul><li><ol><li>a
<dl><dt>term</dt>
<dd>def</dd></dl></li>
<li>b</li></ol></li></ul>
```
(Note: line 2's prefix `*#;` shares `*#` with line 1, so the `<dl>` opens inside the still-open `<li>` of the `<ol>`; line 3 returns to `*#`, closing the `<dl>` and starting a new `<li>` — wait, `a` and the dl: line 2 extends line 1's prefix, so the dl nests inside item `a`; line 3 then closes the dl and opens a sibling `<li>b</li>`. The HTML above reflects exactly that.)

7. `;`/`:` share one `<dl>` even when order reverses:

```wikitext
: dd first
; dt second
```
```html
<dl><dd>dd first</dd>
<dt>dt second</dt></dl>
```

8. Indentation:

```wikitext
:: two levels in
```
```html
<dl><dd><dl><dd>two levels in</dd></dl></dd></dl>
```

9. Empty items:

```wikitext
*
* x
```
```html
<ul><li></li>
<li>x</li></ul>
```

---

## 5. Internal links `[[…]]`, files, categories

### 5.1 Grammar

```
link       := "[[" target ( "|" label-text )? "]]" trail?
target     := page-title ( "#" fragment )?   ; may be empty only if fragment present
label-text := any wikitext not containing "]]" at bracket depth 0
trail      := /[a-z]+/  (ASCII lowercase letters immediately after "]]")
```

- Scanning: on `[[`, find the matching `]]`. Link syntax does **not** nest — if another `[[` appears before the first `]]` **outside a file link**, the outer `[[` is abandoned: emit it as literal text and resume parsing at the inner `[[`. Exception: **file/image links** (§5.9) parse their option text with bracket balancing, so captions may contain links.
- The **first** `|` at top level splits target from label. In a non-file link, later pipes are part of the label verbatim (`[[A|b|c]]` → label `b|c`). In file links every top-level `|` separates an option (§5.9).
- Targets may not contain: `<` `>` `[` `]` `{` `}` `|` (post-split), newline, or the strip-marker byte. A percent sign followed by two hex digits is decoded during normalization. An invalid target makes the whole construct render as literal text (`[[bad<title]]` prints as-is, with entities escaped).
- Whitespace around the target is trimmed; interior whitespace/underscores normalize per §5.7.

### 5.2 Basic rendering

Existing target:

```html
<a href="/wiki/Encoded_Title" title="Display Title">label</a>
```

Non-existent target (**red link**):

```html
<a href="/wiki/Encoded_Title?redlink=1" class="new" title="Display Title (page does not exist)">label</a>
```

Existence is answered by the `PageStore` (§14.9); when unknown (e.g. static export without a store), treat as existing.

- Default label = the target **as written by the author**, only trimmed of leading/trailing whitespace (underscores stay as typed; namespace prefix and fragment stay if written). So `[[quota]]` displays `quota` (link resolves to `Quota`), `[[Help:Style#Naming]]` displays `Help:Style#Naming`, `[[main_hall]]` displays `main_hall`.
- Label content is inline-parsed (bold/italic, templates were already expanded). Nested links are not allowed in labels (outer link is abandoned, see 5.1).

### 5.3 Pipe trick `[[…|]]`

An empty label triggers the pipe trick, computed at **parse time** (MediaWiki does it at save time; **D-6**):

1. If the target contains a `#` fragment → pipe trick does **not** apply; label = full target text as written.
2. Strip a leading namespace prefix (and leading `:`).
3. If the result ends with a parenthetical ` (…)` → remove it.
4. Else, if the result contains a comma → keep only the text before the **first** `,` (and drop one following space).
5. If the computed label is empty, fall back to the full target.

Examples: `[[Pipe (computing)|]]` → `Pipe`; `[[Help:Style|]]` → `Style`; `[[Help:Style (guide)|]]` → `Style`; `[[Boston, Massachusetts|]]` → `Boston`; `[[Foo#Bar|]]` → `Foo#Bar`.

### 5.4 Link trails

ASCII lowercase letters immediately following `]]` are appended to the **label** (not the target): `[[moon]]s` → `<a href="/wiki/Moon" title="Moon">moons</a>`. The trail stops at the first non-`[a-z]` character (`[[moon]]'s` → `<a…>moon</a>'s`; `[[moon]]S` → `<a…>moon</a>S`). `<nowiki/>` placed between breaks the trail: `[[moon]]<nowiki/>s` → `<a…>moon</a>s` (marker consumed, no merge). Trails apply to piped links too: `[[a|b]]c` → label `bc`.

### 5.5 Fragments

- `[[Page#Section]]` → `href="/wiki/Page#Fragment"` with the fragment encoded per §2.4 step 4 (spaces→`_`, then percent-encoding for URL). `title="Page"` (title attribute omits the fragment).
- `[[#Section]]` → same-page anchor: `<a href="#Section">#Section</a>` (no title attribute, never a red link).
- Fragment does not affect existence checks (page-level only).

### 5.6 Subpage links

Subpages are enabled in all namespaces (config). With current page `Guides/Routing`:

| Wikitext | Target | Default label |
|---|---|---|
| `[[/Speedrun]]` | `Guides/Routing/Speedrun` | `/Speedrun` |
| `[[/Speedrun/]]` | `Guides/Routing/Speedrun` | `Speedrun` (slashes hidden) |
| `[[../]]` | `Guides` | `Guides` (parent title) |
| `[[../Looting]]` | `Guides/Looting` | `../Looting` |
| `[[../../Top]]` | resolves upward; if it climbs past the root, the link is rendered as literal text | |

### 5.7 Title normalization & case rules

Applied to targets (and template names, §8.2):

1. Decode HTML entities and percent-encoded sequences.
2. Replace `_` with space; collapse runs of whitespace to one space; trim.
3. Strip one leading `:` (marks "main namespace / no special handling", see 5.8).
4. Split off namespace prefix at the first `:` if the prefix (trimmed, case-insensitive) matches a known namespace or alias.
5. **Uppercase the first letter of the page name** (Unicode-aware). Titles differing only in the case of their first letter are the same page; all other positions are case-sensitive: `[[quota]]` ≡ `[[Quota]]`, but `[[QUOTA]]` is a different page.
6. Fragment: kept verbatim (then encoded for href).
7. Empty page name after normalization (and no fragment) → invalid link, render literally.

**Href encoding:** spaces→`_`, then percent-encode with `encodeURIComponent`, then revert these bytes for readability: `%2F`→`/`, `%3A`→`:`, `%21`→`!`, `%2A`→`*`, `%27`→`'`, `%28`→`(`, `%29`→`)`, `%2C`→`,`, `%3B`→`;`, `%40`→`@`, `%24`→`$`, `%7E`→`~`. (Matches MediaWiki `wfUrlencode`.)

### 5.8 Namespaces

```
0 (Main, "")   1 Talk          2 User        3 User talk
4 Project      5 Project talk  6 File        7 File talk
8 MediaWiki    9 MediaWiki talk 10 Template  11 Template talk
12 Help        13 Help talk    14 Category   15 Category talk
```

- `Project` resolves to the site name (`HQHQ Wiki:…` and `Project:…` both work). Alias: `Image:` → `File:`, `Image talk:` → `File talk:`.
- Matching is case-insensitive and underscore/space-insensitive (`help_talk:X` works).
- An unknown prefix is **not** a namespace; the colon is just text: `[[Lore:Company]]` is a main-namespace page literally named `Lore:Company`.
- A leading `:` forces "plain link" handling: `[[:Category:X]]`, `[[:File:X]]` link to the page instead of categorizing/embedding.

### 5.9 File (image) links `[[File:…|options|caption]]`

Every top-level `|` separates parameters. Each parameter is matched (after trimming) against the option table below; **the last parameter that matches nothing becomes the caption** (earlier unmatched parameters are discarded with a warning). Within conflicting options of one group, the **last one wins**.

| Group | Values | Effect |
|---|---|---|
| format | `thumb`, `thumbnail`, `frame`, `framed`, `frameless` | thumb/frame render a figure with caption; frame ignores size options; frameless is inline-sized like thumb but w/o chrome |
| resize | `{N}px`, `x{N}px`, `{W}x{H}px`, `upright`, `upright={factor}` | width / height / bounding box; `upright` multiplies `thumbDefaultWidth` by factor (default 0.75), only meaningful with thumb/frameless |
| halign | `left`, `right`, `center`, `none` | horizontal alignment/float; `center` implies block |
| valign | `baseline`, `sub`, `super`, `top`, `text-top`, `middle`, `bottom`, `text-bottom` | inline vertical-align (non-floated, non-thumb only) |
| misc | `border` | thin border on inline image |
| kv | `alt=text` | img alt text (default: caption text stripped, else filename) |
| kv | `link=Target` / `link=` (empty) | wrap image in link to internal page or URL; empty = no link |
| kv | `page=N`, `class=…`, `lang=…` | page selection (PDF/DjVu; ignored for bitmaps), extra img class, ignored |

Caption is full wikitext (inline-parsed; may contain links — bracket-balanced scan per §5.1). Caption is **displayed** only for `thumb`/`frame`; otherwise it becomes the `title` attribute (and alt fallback).

Output shapes (canonical for hqhq-wiki; MW legacy markup differs — **D-7**):

Inline: 

```html
<a href="/wiki/File:Map.png" class="mw-file" title="{caption-or-empty}"><img src="{resolved-src}" alt="{alt}" width="…" height="…" /></a>
```

Thumb:

```html
<figure class="mw-thumb mw-halign-{left|right|center|none}" style="width:{w+2}px">
  <a href="/wiki/File:Map.png" class="mw-file"><img … /></a>
  <figcaption>{parsed caption}</figcaption>
</figure>
```

Missing file → red link to the file page with the filename as text. `[[Media:X.png]]` → direct link to the raw file URL, plain `<a class="internal">`.

### 5.10 Category links

- `[[Category:Monsters]]` → **renders nothing**; adds `Monsters` to page metadata `categories`. Optional sort key: `[[Category:Monsters|Bracken]]` → `{ name: "Monsters", sortKey: "Bracken" }`. Duplicate category: last sort key wins.
- A line containing only category links (+ whitespace) produces no output line at all (no empty paragraph, no stray blank).
- `[[:Category:Monsters]]` → ordinary link: `<a href="/wiki/Category:Monsters" title="Category:Monsters">Category:Monsters</a>`; pipe/label/trail rules all apply.
- Category page existence: red-link rules apply to the `:`-form only.

### 5.11 Examples

1. Case-insensitive first letter + trail:

```wikitext
The [[bracken]]s hunt.
```
```html
<p>The <a href="/wiki/Bracken" title="Bracken">brackens</a> hunt.</p>
```

2. Piped + trail + red link:

```wikitext
[[Nonexistent page|that page]]s
```
```html
<p><a href="/wiki/Nonexistent_page?redlink=1" class="new" title="Nonexistent page (page does not exist)">that pages</a></p>
```

3. Fragment + encoding:

```wikitext
[[Sales & Deals#50% off]]
```
```html
<p><a href="/wiki/Sales_%26_Deals#50%25_off" title="Sales &amp; Deals">Sales &amp; Deals#50% off</a></p>
```

4. Abandoned outer link (no nesting):

```wikitext
[[Foo|see [[Bar]] here]]
```
```html
<p>[[Foo|see <a href="/wiki/Bar" title="Bar">Bar</a> here]]</p>
```

5. Thumb with everything:

```wikitext
[[File:Facility map.png|thumb|left|upright=1.2|alt=Facility layout|The ''main'' facility]]
```
```html
<figure class="mw-thumb mw-halign-left" style="width:266px">
  <a href="/wiki/File:Facility_map.png" class="mw-file"><img src="…" alt="Facility layout" width="264" height="…" /></a>
  <figcaption>The <i>main</i> facility</figcaption>
</figure>
```
(264 = round(220 × 1.2); container +2px chrome; rounding: round-half-up to integer px.)

6. Category vs. category link:

```wikitext
[[Category:Moons|Titan]]
See [[:Category:Moons]].
```
```html
<p>See <a href="/wiki/Category:Moons" title="Category:Moons">Category:Moons</a>.</p>
```
(+ metadata `categories: [{name:"Moons", sortKey:"Titan"}]`; first line vanishes entirely.)

---

## 6. External links

### 6.1 Protocols

Allowed schemes (case-insensitive; the set is config, this is the default): `http://`, `https://`, `ftp://`, `ftps://`, `sftp://`, `ssh://`, `git://`, `svn://`, `irc://`, `ircs://`, `xmpp:`, `telnet://`, `nntp://`, `mailto:`, `news:`, `tel:`, `sms:`, `urn:`, `geo:`, `magnet:`, `bitcoin:`, and protocol-relative `//`. Anything else (`javascript:`, `data:`, `vbscript:`…) is **never** linked — bracketed forms with a bad scheme render as literal text.

### 6.2 Three forms

**Bracketed with label** — `[url label]`: url runs to the first whitespace; everything after the first whitespace run (up to `]`) is the label, inline-parsed:

```html
<a class="external text" rel="nofollow noopener" href="url">label</a>
```

**Bracketed bare** — `[url]`: auto-numbered per page, counter starts at 1, increments in document order across the whole page:

```html
<a class="external autonumber" rel="nofollow noopener" href="url">[1]</a>
```

**Free (bare) URL** in running text: linkified with the URL as its own label:

```html
<a class="external free" rel="nofollow noopener" href="url">url</a>
```

### 6.3 URL character rules

- In-URL characters: everything except whitespace, `<`, `>`, `[`, `]`, `"`, and the strip-marker byte. `|` ends a URL inside table/template contexts naturally because expansion happened earlier; a literal `|` never belongs to a URL.
- **Free URLs only** — trailing-punctuation trimming: strip from the end any run of `,` `;` `.` `:` `!` `?` and a final `)` **unless** the URL contains an unmatched `(` before it. Trimmed characters render as plain text after the link. (`http://x.com/foo_(bar)` keeps the `)`; `See http://x.com.` links `http://x.com` and leaves `.`.)
- Free URLs must start at a word boundary (start of line, after whitespace, or after `(`/punctuation — not inside a word: `xhttp://a` is not a link).
- Inside a bracketed link, the label may itself contain a URL; it is **not** re-linkified (plain text).
- The href is emitted with `"` and `<`/`>` entity-escaped; no other re-encoding (authors are responsible for valid URLs).

### 6.4 Examples

1. Labeled:

```wikitext
[https://lethal.wiki the other wiki]
```
```html
<p><a class="external text" rel="nofollow noopener" href="https://lethal.wiki">the other wiki</a></p>
```

2. Auto-numbered, two on a page:

```wikitext
See [https://a.example] and [https://b.example].
```
```html
<p>See <a class="external autonumber" rel="nofollow noopener" href="https://a.example">[1]</a> and <a class="external autonumber" rel="nofollow noopener" href="https://b.example">[2]</a>.</p>
```

3. Free URL with punctuation trim and paren protection:

```wikitext
Go to https://x.example/a_(b), then stop.
```
```html
<p>Go to <a class="external free" rel="nofollow noopener" href="https://x.example/a_(b)">https://x.example/a_(b)</a>, then stop.</p>
```

4. Bad scheme stays literal:

```wikitext
[javascript:alert(1) click]
```
```html
<p>[javascript:alert(1) click]</p>
```

5. Formatting in label; single square brackets pass through:

```wikitext
[https://x.example ''styled'' [label]]
```
```html
<p><a class="external text" rel="nofollow noopener" href="https://x.example"><i>styled</i> [label</a>]</p>
```
(The first `]` closes the link — a `]` inside the label is impossible; the trailing `]` is literal text. MediaWiki behaves identically.)

---

## 7. Tables `{| … |}`

Tables are parsed **after** template expansion (so templates may emit any table fragment) and **before** the other block passes. The table scanner is line-based and recursive (for nesting).

### 7.1 Line grammar

A table starts at a line whose content — after an optional run of `:` indent characters (§7.8) — begins with `{|`. Inside a table, each line is classified by its first one or two characters:

| Line start | Meaning |
|---|---|
| `{\|` attrs | (nested) table start — pushes a new table context |
| `\|}` rest | table end; `rest` (if any) is re-queued as a new line after the table |
| `\|+` … | caption |
| `\|-` `-`* attrs | row separator (extra dashes tolerated: `\|----` ≡ `\|-`) |
| `!` … | header cell line |
| `\|` … | data cell line |
| anything else | continuation: appended (with its newline) to the **current cell's** content; if no cell is open yet, it is *fostered* content (§7.7) |

All markers must be at line start (no leading spaces — a space-indented `|` line is cell continuation content, not a marker).

### 7.2 Attributes (tables, rows, captions, cells)

Attribute strings (`{| CLASS…`, `|- ATTRS`, and the cell/caption forms below) are parsed as HTML attributes: `name=value` pairs, value in `"…"`, `'…'`, or unquoted (to next whitespace), bare names allowed. They are then filtered through the sanitizer allowlist for the corresponding element (§11.3); disallowed attributes are **dropped silently**. Attribute text is never displayed.

### 7.3 Cells

**Data line** (`|…`): strip the leading `|`, split the remainder on every literal `||`. Each piece is one `<td>`.
**Header line** (`!…`): strip the leading `!`, split on every `!!` **and also** every `||`. Each piece is one `<th>`.
(On data lines `!!` does **not** split.)

For each cell piece, attempt the **attribute split**: if the piece contains a `|` and the text before the first `|` contains no `[[`, then text-before-pipe = attribute string, text-after = content (only the first `|` splits; later ones are content). If the would-be attribute segment contains `[[`, the entire piece is content. If the attribute segment fails to yield any allowed attribute, it is still consumed (content does not fall back) — `| bogus | text` renders a plain `<td>text</td>`, the word `bogus` is lost.

`rowspan`/`colspan`/`scope`/`headers` etc. are ordinary allowed attributes on `td`/`th`.

Cell content = the text after the marker on that line **plus** all following continuation lines until the next marker line. Content is parsed as full **block** wikitext (paragraph rules, lists, nested tables, headings are allowed inside cells; a single-line cell with plain text is emitted without a `<p>` wrapper; multi-line content gets normal block treatment).

### 7.4 Caption `|+`

At most one is rendered (first wins; later captions are dropped with a warning). Same attribute-split rule as cells: `|+ attrs | caption` or `|+ caption`. Caption content is inline-parsed (may contain links/formatting) and may continue on following lines like a cell.

```html
<caption {attrs}>caption</caption>
```

The caption element is emitted first inside `<table>` regardless of where the `|+` line appeared (it must appear before the first row to be MediaWiki-portable; we accept it anywhere before `|}`).

### 7.5 Rows

- Cells appearing before any `|-` open an implicit first row.
- `|-` closes the current row (if it has cells) and opens a new one with the given attributes.
- A `|-` that ends up with **zero cells** emits nothing (no empty `<tr>`); this includes a leading `|-` directly under `{|` and trailing `|-` before `|}`.

### 7.6 Output shape

```html
<table {attrs}>
  <caption>…</caption>?
  <tbody>
    <tr {attrs}><th {attrs}>…</th><td {attrs}>…</td></tr>
    …
  </tbody>
</table>
```

We always emit `<tbody>` (browsers insert it anyway; emitting it keeps the AST and DOM aligned). No `<thead>` inference is performed.

### 7.7 Fostered content

Non-marker lines that occur inside `{| … |}` but **before the first cell** (e.g. text directly under `{|`) cannot legally live inside `<table>`. Emit them **before** the `<table>` element, in order, parsed as normal block content. (This matches what browsers/Parsoid do; the legacy PHP parser leaves them inside the table and lets the browser foster-parent them.)

### 7.8 Indented tables

A table-start line may be preceded by `:` characters: `::{| …` wraps the whole table in that many `<dl><dd>` levels. This is the **only** list marker that may combine with `{|`; `*{|` or `#{|` render the `{|` as literal text inside the list item.

### 7.9 Nesting

A line starting with `{|` while inside a cell's continuation region starts a **nested table**, terminated by its own `|}`. Nesting depth is unlimited (subject to global node limits). The nested table's lines are consumed by the inner scanner; the outer table resumes after the inner `|}`.

### 7.10 Pipes from templates: `{{!}}` and `{{=}}`

Because `|` and `=` are structural inside template calls (§8.3), authors inside a template that must **emit** table markup use the built-in magic words `{{!}}` → `|` and `{{=}}` → `=`. These expand during preprocessing, i.e. *before* table parsing, so the emitted pipes are real table markup. Both must be implemented as built-ins (not as wiki templates).

### 7.11 Examples

1. Full basic table:

```wikitext
{| class="wikitable" style="width:20em"
|+ Scrap values
|-
! Item !! Value
|-
| Gold bar || 210
|-
| style="color:red" | Flask || 30
|}
```
```html
<table class="wikitable" style="width:20em">
<caption>Scrap values</caption>
<tbody>
<tr><th>Item</th><th>Value</th></tr>
<tr><td>Gold bar</td><td>210</td></tr>
<tr><td style="color:red">Flask</td><td>30</td></tr>
</tbody>
</table>
```

2. Attribute-vs-content edge cases in one row:

```wikitext
{|
| colspan="2" | wide || [[a|b]] || x | y | z
|}
```
```html
<table><tbody>
<tr><td colspan="2">wide</td><td><a href="/wiki/A" title="A">b</a></td><td>y | z</td></tr>
</tbody></table>
```
(Cell 2: the `|` inside `[[a|b]]` doesn't split because `||` splitting uses the literal two-pipe token and the attribute split is vetoed by `[[`. Cell 3: `x` is consumed as a — bogus, dropped — attribute string; only the first `|` splits, so content is `y | z`.)

3. Multi-line cell with a list and an implicit first row:

```wikitext
{|
| Monsters:
* [[Bracken]]
* [[Thumper]]
| Safe
|}
```
```html
<table><tbody>
<tr>
<td><p>Monsters:</p>
<ul><li><a href="/wiki/Bracken" title="Bracken">Bracken</a></li>
<li><a href="/wiki/Thumper" title="Thumper">Thumper</a></li></ul></td>
<td>Safe</td>
</tr>
</tbody></table>
```
(Note: both `|` lines belong to the same implicit row; each `|` line starts a new cell.)

4. Nested table:

```wikitext
{|
| outer
|
{| class="inner"
| nested
|}
|}
```
```html
<table><tbody>
<tr><td>outer</td>
<td>
<table class="inner"><tbody><tr><td>nested</td></tr></tbody></table>
</td></tr>
</tbody></table>
```

5. Rowspan + header line with `||` separator:

```wikitext
{|
! A !! B || C
|-
| rowspan="2" | tall || r1
|-
| r2
|}
```
```html
<table><tbody>
<tr><th>A</th><th>B</th><th>C</th></tr>
<tr><td rowspan="2">tall</td><td>r1</td></tr>
<tr><td>r2</td></tr>
</tbody></table>
```

6. Indented table + trailing junk after `|}`:

```wikitext
:{|
| x
|} tail
```
```html
<dl><dd><table><tbody><tr><td>x</td></tr></tbody></table></dd></dl>
<p>tail</p>
```

7. Fostered content and empty rows:

```wikitext
{|
stray
|-
|-
| only cell
|-
|}
```
```html
<p>stray</p>
<table><tbody><tr><td>only cell</td></tr></tbody></table>
```

---

## 8. Templates and parameters `{{…}}`, `{{{…}}}`

Template expansion happens in the **preprocessor**, on a token tree, before any block/inline parsing. All examples assume the templates named exist in the `Template:` namespace unless stated.

### 8.1 Brace matching

Scan for runs of `{`. When a run of `}` is found, match innermost-first with this preference:

- If the open run has ≥ 3 and the close run has ≥ 3 → consume **3+3** as a **parameter** `{{{…}}}` node.
- Else if both have ≥ 2 → consume **2+2** as a **template** `{{…}}` node.
- Leftover braces are literal text.

Worked out: `{{{{a}}}}` (4/4) → `{` + `{{{a}}}` + `}`; `{{{{{a}}}}}` (5/5) → `{{ {{{a}}} }}` (template whose name is the value of parameter `a`); `{{a}` → all literal. Unclosed `{{` at end of input → literal. Matching respects nesting: `{{a|{{b}}}}` is a template `a` whose argument contains template `b` (the first `}}` closes `b`). `<nowiki>`-protected and comment-protected braces never participate.

### 8.2 Name resolution

The text before the first top-level `|` (or the whole interior) is expanded (it may itself contain templates/parameters), then trimmed, then resolved:

1. If it starts with `#` or matches a parser-function/variable name with a `:` (§9.1), it is not a template.
2. `subst:`/`safesubst:` prefix → stripped (D-8), continue.
3. Leading `:` → transclude from the **main** namespace: `{{:Bestiary}}` transcludes page `Bestiary`.
4. Explicit namespace prefix → that page: `{{Help:Box}}`, `{{User:Pasta/Sig}}`.
5. Otherwise → `Template:` namespace with first letter capitalized: `{{infobox moon}}` → `Template:Infobox moon`.
6. Nonexistent target → render a red link to it: `<a href="/wiki/Template:X?redlink=1" class="new" title="Template:X (page does not exist)">Template:X</a>`. (`{{:Missing}}` likewise links `Missing`.)
7. Name containing illegal title characters → the whole call renders literally.

### 8.3 Argument parsing

Split the interior on **top-level** `|` (pipes inside nested `{{…}}`, `{{{…}}}`, `[[…]]`, or strip markers do not split). For each argument:

- If it contains a **top-level `=`** (equals inside nested constructs/links don't count), the first `=` splits name from value → **named parameter**: name and value are each **trimmed** of whitespace including newlines.
- Otherwise → **positional parameter**, numbered 1, 2, 3… in order of appearance. Positional values are **NOT trimmed** — every space and newline is preserved.
- A named parameter with a numeric name assigns that position: `{{T|1=x}}` sets parameter 1 (and its value IS trimmed, because it was named).
- Duplicates (same name/position assigned twice, by any mix of forms): **the last occurrence wins**. `{{T|1=a|b}}` → parameter 1 = `b` (the anonymous arg is position 1 and comes later).
- `{{T|}}` has one positional parameter with value `""` (empty ≠ absent).
- Literal `=` in a positional parameter requires `{{=}}`: `{{T|a{{=}}b}}` → positional 1 = `a=b` (the magic word expands after argument splitting — it is a template-call node inside the value, so it does not act as a separator).

### 8.4 Parameter use `{{{name}}}`, `{{{name|default}}}`

Inside a template body, `{{{x}}}` expands to the argument `x` of the **current frame**:

- Parameter name is expanded then trimmed; numeric names map to positionals.
- If the argument exists (even as empty string) → its value.
- Else if a default is given (everything after the first top-level `|`; **further pipes are part of the default**: `{{{a|b|c}}}` default is `b|c`) → the default, expanded.
- Else → the literal text `{{{x}}}`.
- On a page rendered outside any template frame (top level), arguments never exist: `{{{x}}}` renders literally; `{{{x|d}}}` renders `d`.

### 8.5 Evaluation model

- **Frames**: expanding a template creates a child frame carrying its argument list (unexpanded token trees) and the chain of ancestor titles.
- **Lazy arguments**: an argument's value is expanded only when first used (via `{{{…}}}` or by a parser function), then cached per frame. Unused arguments are never expanded. (Required so `{{#if:…|{{Expensive}}|x}}` only expands the taken branch, §9.2.)
- **Loop detection**: if a template's title equals any ancestor frame's title → do not expand; emit `<span class="error">Template loop detected: <a href="/wiki/Template:X" title="Template:X">Template:X</a></span>`. (A template may appear twice as a *sibling* — only ancestry counts.)
- **Depth limit** `maxTemplateDepth` (40): exceeding it emits `<span class="error">Template recursion depth limit exceeded (40)</span>` in place of the call.
- **Size limit** `maxIncludeSize` (2 MiB of cumulative expanded template output): once exceeded, further template calls render as unexpanded wikitext links (like nonexistent) with a page-level warning.

### 8.6 `<noinclude>`, `<includeonly>`, `<onlyinclude>`

Applied to the **raw text** of a page when building its preprocessor tree, depending on context:

- Rendering the page itself: strip `<includeonly>…</includeonly>` (content dropped); keep `<noinclude>` content (tags removed); `<onlyinclude>` tags removed, content kept.
- Transcluding the page: if the source contains at least one `<onlyinclude>` section, the transcluded text is **exactly the concatenation of all `<onlyinclude>` interiors** (everything else dropped — even `<includeonly>` outside them). Otherwise: drop `<noinclude>` interiors, keep `<includeonly>` interiors (tags removed).
- These three tags nest with themselves only in degenerate ways; do not support nesting of the same tag. Unclosed tag → runs to end of page. They are processed before comment stripping and are invisible to all later stages.

### 8.7 The auto-newline rule (T2529)

If a template expansion (or parameter/parser-function expansion) begins with `*`, `#`, `;`, `:`, `{|`, or `----` and the call site is **not** at start of line, prepend `\n` to the expansion, so the block markup works. `foo {{Bullet}}` where `Template:Bullet` = `* x` renders a paragraph `foo` followed by a `<ul>`.

### 8.8 Templates and page-scoped state

Categories, refs, `__NOTOC__`, `DISPLAYTITLE` etc. produced inside templates apply to the **rendering page** (there is a single page-scope metadata sink).

### 8.9 Examples

1. Substitution of positionals and named:

`Template:Hello` = `Hi {{{1}}}, welcome to {{{site|the wiki}}}!`

```wikitext
{{Hello|Pasta}}
{{Hello|Pasta|site=HQHQ}}
{{Hello}}
```
```html
<p>Hi Pasta, welcome to the wiki!
Hi Pasta, welcome to HQHQ!
Hi {{{1}}}, welcome to the wiki!</p>
```

2. Trimming rules:

`Template:Echo` = `[{{{1}}}][{{{k}}}]`

```wikitext
{{Echo| a |k= b }}
```
```html
<p>[ a ][b]</p>
```
(Positional keeps its spaces; named is trimmed.)

3. Later duplicate wins:

```wikitext
{{Echo|1=first|second|k=x}}
```
```html
<p>[second][x]</p>
```

4. Empty vs. absent:

`Template:Opt` = `{{#if:{{{1|}}}|set|unset}}/{{{1|DEF}}}`

```wikitext
{{Opt|}} vs {{Opt}}
```
```html
<p>unset/ vs unset/DEF</p>
```
(`{{Opt|}}`: param 1 exists as `""` → default not used → empty; `{{Opt}}`: param absent → default `DEF`.)

5. Brace-count puzzles (with `Template:T` = `V`, page param `a` = `T`):

```wikitext
{{{{{a}}}}} / {{{{a}}}} / {{ {{a}} }}
```
Inside a frame where `a=T`: first → `{{T}}` → `V`. Second → `{` + `{{{a}}}` + `}` → `{T}`. Third: the inner `{{a}}` is a template call to `Template:A` (the surrounding spaces belong to the outer name and are trimmed away); its expansion becomes the outer call's *name*. If `Template:A` does not exist, the expansion is red-link HTML, which contains characters illegal in titles — so per §8.2 rule 7 the **outer** call renders literally as text. Test all three.

6. Loop:

`Template:Loop` = `x{{Loop}}y`

```wikitext
{{Loop}}
```
```html
<p>x<span class="error">Template loop detected: <a href="/wiki/Template:Loop" title="Template:Loop">Template:Loop</a></span>y</p>
```

7. Main-namespace transclusion + onlyinclude:

Page `Bestiary` = `intro<onlyinclude>CORE</onlyinclude>outro`

```wikitext
{{:Bestiary}}
```
```html
<p>CORE</p>
```

8. Auto-newline:

`Template:Item` = `* {{{1}}}`

```wikitext
Loot: {{Item|Gold bar}}
```
```html
<p>Loot: </p>
<ul><li>Gold bar</li></ul>
```

---

## 9. Parser functions and magic variables

### 9.1 Invocation syntax

`{{NAME: arg1 | arg2 | … }}` — recognized during preprocessing when `NAME` (case-insensitive for `#…` functions and colon-functions; case-**sensitive** for the ALL-CAPS variables) matches a registered function and a `:` follows within the name segment. The text after `:` up to the first top-level `|` is argument 1. **All parser-function arguments are trimmed** after (lazy) expansion — including positionals; this differs from template calls. An unknown `{{#name:…}}` renders `<span class="error">Unknown parser function: #name</span>`. **D-11** (MW's fallback varies; we standardize on the error span.)

Variables without arguments (`{{PAGENAME}}`) are matched before template resolution; an existing `Template:PAGENAME` is shadowed by the variable (write `{{Template:PAGENAME}}` to force the template — matches MW).

### 9.2 Control flow

`{{#if: test | then | else }}`
- `test` is expanded and trimmed; **non-empty → then**, empty or whitespace-only → else. Missing branch → empty string. Branches are trimmed. Only the selected branch is expanded (lazy).
- `{{#if: 0 | y | n }}` → `y` (the string `0` is non-empty!).

`{{#ifeq: a | b | then | else }}`
- Both sides expanded, trimmed. If **both** are numeric (parse as finite decimal/scientific numbers) → numeric comparison (`01` = `1`, `1e3` = `1000.0`); else exact case-sensitive string comparison.

`{{#ifexist: title | then | else }}`
- True iff the normalized title exists in the PageStore (files: the File page or the stored media; `#ifexist:Media:X` checks the file store). Counts against `maxExpensiveCalls`; over the limit → else-branch + page warning.

`{{#ifexpr: expr | then | else }}` — evaluate per `#expr`; nonzero → then; error in expr → the error message itself.

`{{#switch: value | c1 = r1 | c2 | c3 = r2 | #default = d | fallback }}`
- Expand+trim `value`. Walk cases in order. A case **without** `=` falls through: it matches if equal to `value` and then takes the next case's `=` value (chains: `|a|b|c=r` gives all three `r`).
- Comparison rule = `#ifeq` (numeric when both numeric, else case-sensitive string).
- `#default = d` supplies the default; if several, the **last** wins. A **trailing** bare value (a last argument with no `=`) also acts as a default; when both forms are present and nothing matched, `#default` wins.
- First matching case wins; cases after a match are not expanded.
- `{{#switch: x }}` (no cases) → empty.

### 9.3 `{{#expr: … }}`

Numeric expression evaluator over IEEE doubles. Tokens: decimal numbers (`.5`, `2.`, `1e-3` via the `e` operator or literal exponent — implement literal `1.5e3` too), constants `e`, `pi`, operators below, parentheses. Case-insensitive keywords. Result formatting: `-0` → `0`; integers (|x| < 1e16 and integral) print without decimal point; otherwise up to 14 significant digits, no trailing zeros; `true`→`1`, `false`→`0`.

Precedence, highest → lowest (same-line = equal, all binary ops left-associative):

1. `( )`
2. unary functions: `not`, `ceil`, `trunc`, `floor`, `abs`, `sqrt`, `exp`, `ln`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`
3. unary `-`, `+`
4. `e` (scientific: `2e3` = 2×10³)
5. `^` (power; left-assoc: `2^3^2` = 64; `0^0` = 1; negative base with fractional exponent → error `Result of ^ is not a number`)
6. `*`, `/`, `div`, `mod` (`div` = `/`, both real division; `mod` = C-style integer remainder: operands truncated toward zero first, sign follows dividend; `x mod 0`, `x / 0`, `x div 0` → error)
7. `+`, `-`
8. `round` (binary: `a round n` = half-away-from-zero rounding of `a` to `n` decimal places; negative `n` rounds to tens/hundreds…)
9. `=`, `!=`, `<>` (≡ `!=`), `<`, `>`, `<=`, `>=` (result 1/0; equality on doubles is exact)
10. `and` (both nonzero → 1)
11. `or`

Errors render `<strong class="error">Expression error: {message}.</strong>` — messages: `Unrecognized word "x"`, `Unrecognized punctuation character "$"`, `Division by zero`, `Unexpected closing bracket`, `Unclosed bracket`, `Missing operand for {op}`.

### 9.4 String / namespace functions

| Call | Result |
|---|---|
| `{{lc: TExT }}` | `text` (arg trimmed, Unicode lowercase) |
| `{{uc: text}}` | `TEXT` |
| `{{lcfirst:Foo}}` | `foo` (first code point only) |
| `{{ucfirst:foo bar}}` | `Foo bar` |
| `{{ns:10}}` / `{{ns:template}}` | `Template` (canonical form; `{{ns:0}}` → empty string; unknown number/name → empty string **D-12**) |
| `{{urlencode:a b&c}}` | `a+b%26c` (query-style; `{{urlencode:x|PATH}}` → `%20`-style, `{{urlencode:x|WIKI}}` → `_`-style) |
| `{{anchorencode:My § Heading}}` | id per §2.4 (`My_§_Heading`) |
| `{{formatnum:1234567.8}}` | `1,234,567.8` (en grouping; `{{formatnum:x|R}}` strips grouping) |
| `{{padleft:7|3|0}}` | `007` (value, length, pad-string default `0`) |
| `{{padright:7|3|x}}` | `7xx` |
| `{{#titleparts: A/B/C | 2 | 2 }}` | `B/C` — split on `/` (max 25 segments); arg2 = number of segments to return (0/omitted = all), arg3 = 1-based first segment (negative counts from end). `{{#titleparts:A/B/C|1}}` → `A`; `{{#titleparts:A/B/C||2}}` → `B/C`. |

### 9.5 Page and site variables

Evaluated against the page being rendered (the **root** page, not the template containing the call — matches MW default frame semantics) and `WikiConfig`:

| Variable | Example value on page `Help:Guides/Routing` |
|---|---|
| `{{PAGENAME}}` | `Guides/Routing` |
| `{{FULLPAGENAME}}` | `Help:Guides/Routing` |
| `{{NAMESPACE}}` | `Help` (empty on main-ns pages) |
| `{{NAMESPACENUMBER}}` | `12` |
| `{{SUBPAGENAME}}` | `Routing` |
| `{{BASEPAGENAME}}` | `Guides` |
| `{{ROOTPAGENAME}}` | `Guides` |
| `{{TALKPAGENAME}}` | `Help talk:Guides/Routing` |
| `{{SUBJECTPAGENAME}}` | `Help:Guides/Routing` |
| `{{PAGENAMEE}}`, `{{FULLPAGENAMEE}}`, … | `E` suffix = href-encoded per §5.7 (`Guides/Routing`) |
| `{{SITENAME}}` | `HQHQ Wiki` |
| `{{SERVER}}` / `{{SERVERNAME}}` | from config (absolute origin / hostname) |
| `{{CURRENTYEAR}}` | `2026` |
| `{{CURRENTMONTH}}` | `08` (2-digit) — `{{CURRENTMONTH1}}` → `8` |
| `{{CURRENTMONTHNAME}}` | `August` — `{{CURRENTMONTHABBREV}}` → `Aug` |
| `{{CURRENTDAY}}` | `30` (no pad) — `{{CURRENTDAY2}}` → `30` (2-digit) |
| `{{CURRENTDOW}}` | day of week, Sunday = `0` |
| `{{CURRENTDAYNAME}}` | `Sunday` |
| `{{CURRENTTIME}}` | `HH:mm` UTC |
| `{{CURRENTHOUR}}` | `HH` |
| `{{CURRENTWEEK}}` | ISO week number, no pad |
| `{{CURRENTTIMESTAMP}}` | `yyyyMMddHHmmss` |
| `{{REVISIONID}}`, `{{NUMBEROFARTICLES}}`… | optional; empty string if the store can't answer |

All `CURRENT*` use `config.timezone` (UTC); `LOCAL*` variants are aliases for the same clock. **CAUTION:** these make output time-dependent; the renderer must surface a `volatile: true` flag in ParseResult when any is used, so the Next.js layer can choose revalidation.

### 9.6 Examples

1. `#if` whitespace-only test:

```wikitext
{{#if:   |yes|no}}-{{#if: 0 |yes|no}}-{{#if:|yes}}
```
```html
<p>no-yes-</p>
```

2. `#ifeq` numeric vs string:

```wikitext
{{#ifeq: 01 | 1 | eq | ne }}/{{#ifeq: abc | ABC | eq | ne }}/{{#ifeq: 1e3 | 1000 | eq | ne }}
```
```html
<p>eq/ne/eq</p>
```

3. `#switch` with fallthrough and default:

```wikitext
{{#switch: b | a | b | c = ABC | #default = other }}
{{#switch: z | a = A | #default = D | b = B }}
{{#switch: 07 | 7 = seven | no }}
```
```html
<p>ABC
D
seven</p>
```

4. `#expr` precedence and errors:

```wikitext
{{#expr: 2 + 3 * 4 }} {{#expr: (2+3)*4 }} {{#expr: 2^3^2 }} {{#expr: 7 mod -3 }} {{#expr: 3.14159 round 2 }} {{#expr: 1/0 }}
```
```html
<p>14 20 64 1 3.14 <strong class="error">Expression error: Division by zero.</strong></p>
```

5. Case functions and ns:

```wikitext
{{ucfirst:{{lc:LOOT}}}} in {{ns:14}}:{{PAGENAME}}
```
On page `Titan`: 
```html
<p>Loot in Category:Titan</p>
```

---

## 10. Extension-style tags

Extension tags are captured by the **preprocessor** as single nodes (their content is opaque to brace matching) and rendered by handlers into strip markers. Tag names are case-insensitive; attributes use HTML syntax and are sanitized per handler. An extension tag opened but never closed swallows text to the end of the input (except `<nowiki>`, same rule). `<tag/>` self-closing is allowed for all.

Registered tags: `nowiki`, `pre`, `ref`, `references`, `gallery`, `syntaxhighlight`, `source` (alias). (`<code>` is **not** an extension tag — it is allowed raw HTML, §11, and its content is parsed normally.)

### 10.1 `<nowiki>`

- `<nowiki>content</nowiki>`: content is emitted as plain text via a strip marker, with `<` and `>` escaped. **No** wikitext inside is interpreted — braces, brackets, apostrophes, pipes, list/table markers are all inert. Character references are the one thing still live: `&…;` sequences pass through for the browser to resolve, so `<nowiki>&amp;</nowiki>` displays `&` while `<nowiki>[[x]]</nowiki>` displays `[[x]]`. (Matches MediaWiki.)
- `<nowiki />` (empty): expands to an empty strip marker — invisible, but it splits adjacent constructs: kills link trails (§5.4), separates apostrophe runs (`''ital''<nowiki/>'s`), breaks `}}`+`}` ambiguity.
- Capture is non-greedy: `<nowiki>a</nowiki>b<nowiki>c</nowiki>` is two nodes.
- Inside attribute values or link targets a `<nowiki>` marker makes the construct invalid (markers are illegal in titles/attributes); content stays literal.

### 10.2 `<pre>` (tag form)

`<pre attrs>content</pre>` → `<pre {sanitized attrs}>escaped content</pre>` as a **block**. Content is treated exactly like nowiki (no wikitext parsing, tags escaped, entities resolved) and preserves all whitespace. Leading newline directly after `<pre>` is dropped. Unlike space-indented pre (§3.3), **nothing** inside is parsed:

```wikitext
<pre>''not italic'' {{NotATemplate}}</pre>
```
```html
<pre>''not italic'' {{NotATemplate}}</pre>
```

A `<pre>` inside a paragraph line splits the paragraph (it is always block-level).

### 10.3 `<ref>` and `<references/>` (Cite)

Attributes: `name="id"` (letters/digits/`-_. :` — a purely numeric name is an error), `group="label"`. Content: full wikitext, inline-parsed in the page's context (templates inside were already expanded by the preprocessor; refs can equally be *produced by* templates).

Semantics:

- Each `<ref>content</ref>` registers a footnote in its group (default group `""`) and renders an inline marker: `<sup id="cite_ref-{key}" class="reference"><a href="#cite_note-{key}">&#91;{n}&#93;</a></sup>` where `n` is the 1-based index within the group (group `g` renders `[g n]`).
- `name=`d refs: first occurrence with content defines it; `<ref name="x" />` (or a later `<ref name="x">dup</ref>` — content must match or first definition wins with a warning) **reuses** the same number. Reuse before definition is legal (definition may come later in the page, including inside `<references>`).
- Keys: unnamed → `{seq}`; named → `{name}_{defIndex}-{useIndex}` for the sup ids, note id `cite_note-{name}-{seq}`. Exact key format is internal; ids must be unique and stable.
- `<references />` renders the accumulated list for its group and **clears** it:

```html
<ol class="references">
<li id="cite_note-2"><a href="#cite_ref-2">↑</a> parsed ref content</li>
<li id="cite_note-x-3">↑ <sup><a href="#cite_ref-x-3-0">a</a></sup> <sup><a href="#cite_ref-x-3-1">b</a></sup> parsed content</li>
</ol>
```
(Single-use ref: one `↑` backlink; multi-use: lettered backlinks `a b c…`.)
- `<references>…</references>` with body: the body may contain only whitespace and `<ref name=…>content</ref>` definitions; they define/redefine named refs (rendered numbers still come from in-text usage order); the list then renders as above.
- A named ref used but never defined → in the list: `<span class="error">Cite error: no text provided for ref "x"</span>`.
- Refs pending at end of page with no `<references/>` → auto-append a `<references/>` for each pending group at the very end, preceded by `<div class="mw-ref-warning">` maintenance note.
- `{{reflist}}` is **not** a built-in — it is an ordinary wiki template; ship a default `Template:Reflist` containing `<references />` wrapped in a div.
- Nested `<ref>` inside ref content: not supported; inner tag renders as literal escaped text.

### 10.4 `<gallery>`

Block tag. Attributes: `caption="…"`, `widths=Npx` (default 120), `heights=Npx` (default 120), `perrow=N` (0/absent = responsive), `class`, `mode` (only `traditional` and `packed` need support; unknown → traditional). Content: one entry per non-blank line:

```
File:Name.ext|caption wikitext
```

The `File:`/`Image:` prefix is optional per line; lines that don't resolve to an existing file render an error item. Caption is inline-parsed; pipes beyond the first are caption text unless they match image options `alt=`/`link=` (support those two).

```html
<ul class="gallery mw-gallery-traditional">
  <li class="gallerybox" style="width: {widths+35}px">
    <div class="thumb"><a href="/wiki/File:X.png"><img … /></a></div>
    <div class="gallerytext">caption</div>
  </li>…
</ul>
```

### 10.5 `<syntaxhighlight lang="…">` / `<source>`

Rendered as an escaped code block (no server-side highlighting; the client may highlight):

```wikitext
<syntaxhighlight lang="ts">const a: number = 1 & 2;</syntaxhighlight>
```
```html
<pre class="mw-highlight"><code class="language-ts">const a: number = 1 &amp; 2;</code></pre>
```

Supported attributes: `lang` (sanitized to `[a-zA-Z0-9_-]+`, default `text`), `inline` (render `<code class="language-…">` inline, no pre), `line` (adds class `mw-highlight-lines`). Content rules identical to `<pre>` (no parsing, escape everything, strip one leading newline).

### 10.6 `<code>`, `<tt>` reminder

Plain allowed HTML: `<code>''x''</code>` → `<code><i>x</i></code>` (content **is** parsed). To show literal wikitext in code style, combine: `<code><nowiki>[[x]]</nowiki></code>`.

### 10.7 Unknown tags

Any `<word …>` where `word` is neither an allowed HTML tag (§11) nor a registered extension tag is escaped and shown literally: `<foo bar="1">` → `&lt;foo bar="1"&gt;`. Same for the closing tag. (This includes `<script>`, `<style>`, `<math>`, `<poem>`.)

### 10.8 HTML comments

`<!-- … -->` are removed during preprocessing (never reach output). **Line-eating rule:** if a comment (plus surrounding spaces/tabs) spans from just after a newline to just before a newline — i.e. removing it would leave a whitespace-only line — the entire line including one trailing newline is removed, so comments on their own lines don't create paragraph breaks. An unclosed `<!--` swallows everything to end of input.

```wikitext
a
<!-- note -->
b
```
```html
<p>a
b</p>
```

---

## 11. Raw HTML: allowlist and sanitization

Raw HTML is sanitized during the post-expansion pass (§14.5). The sanitizer tokenizes tags with an HTML5-ish lexer; anything not matching a well-formed tag is escaped as text.

### 11.1 Allowed elements

Inline: `b i em strong s strike u del ins sub sup small big code tt kbd samp var abbr cite dfn q mark bdi bdo span time data wbr br font ruby rb rt rp`
Block: `div p blockquote pre center hr h1 h2 h3 h4 h5 h6 ul ol li dl dt dd table caption thead tbody tfoot tr td th figure figcaption details summary`

Notes:
- `a`, `img`, `script`, `style`, `iframe`, `form`, `input`, `button`, `video`, `audio`, `object`, `embed`, `meta`, `link` are **not allowed** — escaped as literal text. Links and images only via wikitext syntax.
- Void elements: `br hr wbr` — self-closing or bare; a `</br>` is normalized to `<br />`.
- Deprecated-but-allowed (`font`, `center`, `big`, `strike`, `tt`) pass through unchanged.

### 11.2 Balancing

Output must be well-formed: track open raw-HTML elements per block scope; at the end of the enclosing block (paragraph, cell, item, document), close unclosed elements in LIFO order; drop close-tags with no matching open. Overlap (`<b><i></b></i>`) is repaired by closing/reopening (`<b><i></i></b>`). (Legacy MW delegates this to Tidy/RemexHtml; we require the equivalent behavior in-parser.)

### 11.3 Allowed attributes

Global (all allowed elements): `id class style lang dir title role` + `aria-describedby aria-flowto aria-hidden aria-label aria-labelledby aria-owns` + `data-*` (but **reject** `data-mw`, `data-parsoid`, `data-ooui`, and any name with invalid chars).

Per element, in addition:

| Element(s) | Attributes |
|---|---|
| `table` | `border cellpadding cellspacing align bgcolor frame rules summary width` |
| `td th` | `colspan rowspan headers scope abbr axis align valign bgcolor width height nowrap` |
| `tr` | `align valign bgcolor` |
| `ol` | `start reversed type` |
| `li` | `value type` |
| `blockquote q del ins` | `cite` (URL, scheme-checked like §6.1), `datetime` (del/ins) |
| `time` | `datetime` |
| `bdo` | `dir` (required semantics: only `ltr`/`rtl` accepted anywhere `dir` is allowed) |
| `font` | `size color face` |
| `br` | `clear` |
| `h1–h6, p, div, hr` | `align`, `width`(hr), `noshade`(hr) |

Everything else — most importantly **all `on*` event handlers**, `href`, `src`, `srcset`, `background`, `formaction` — is dropped. Attribute values are entity-decoded, then re-encoded on output; `id` values are passed through §2.4 encoding and deduplicated against heading ids.

### 11.4 `style` attribute filtering

Accept the declared style only if ALL of the following hold after (1) decoding HTML entities, (2) decoding CSS backslash escapes (`\6A avascript` forms), (3) stripping well-formed `/* … */` comments, and (4) lowercasing for matching:

- contains no null/control characters and is valid UTF-8;
- contains **no unclosed comment** (`/*` without `*/` → reject);
- does not match any of: `expression`, `javascript:`, `vbscript:`, `url(`, `image(`, `image-set(`, `attr(`, `var(`, `-moz-binding`, `behavior:`, `accelerator:`, `filter:` with `progid`, `@import`, `</` .

On rejection, replace the whole attribute value with `/* insecure input */`. (Blocking `url(` means no external background images — intended; MediaWiki does the same by default.)

### 11.5 Character references

`&amp; &lt; &gt; &quot; &#39; &#x…; &#…;` and all HTML5 named entities are recognized in text and attribute values. Unknown `&word;` is escaped (`&amp;word;`). Numeric references to control chars, surrogates, or > 0x10FFFF are replaced with U+FFFD. In output, text nodes always escape `< > &` (and `"` inside attributes).

### 11.6 Examples

1. Allowed with style:

```wikitext
<span style="color: #c00; font-weight:bold">danger</span>
```
```html
<p><span style="color: #c00; font-weight:bold">danger</span></p>
```

2. Hostile style + event handler stripped:

```wikitext
<div style="background:url(javascript:alert(1))" onclick="x()" class=ok>hi</div>
```
```html
<div style="/* insecure input */" class="ok">hi</div>
```

3. Disallowed tag escaped, allowed content parsed:

```wikitext
<script>alert(1)</script> and <sup>[[note]]</sup>
```
```html
<p>&lt;script&gt;alert(1)&lt;/script&gt; and <sup><a href="/wiki/Note" title="Note">note</a></sup></p>
```

4. Balancing:

```wikitext
<b>bold <i>both</b> italic?</i>
```
```html
<p><b>bold <i>both</i></b> italic?</p>
```

5. Wikitext inside allowed HTML still parses:

```wikitext
<blockquote>''quoted'' from [[Sigurd]]</blockquote>
```
```html
<blockquote><p><i>quoted</i> from <a href="/wiki/Sigurd" title="Sigurd">Sigurd</a></p></blockquote>
```

---

## 12. Redirects

### 12.1 Recognition

A page is a redirect iff its source — after stripping a BOM, leading whitespace, and leading HTML comments — **begins with** the keyword `#REDIRECT` (case-insensitive; also accept `#redirect` in any case mix) optionally followed by `:`, then optional whitespace, then an internal link `[[Target]]` (label and trail ignored; the first `[[…]]` after the keyword is the target). Nothing may precede it except the whitespace/comments listed. `#REDIRECT` anywhere else on the page is plain text (it will render as an ordered-list item `REDIRECT` if at line start! `#` is list markup).

The target may carry a fragment: `#REDIRECT [[Moons#Titan]]`. Invalid target (bad title, or missing `[[…]]`) → the page is not a redirect; the text renders normally (the `#REDIRECT` line becomes an `<ol>` item, matching MW).

### 12.2 Follow behavior

- Navigating to a redirect page: the app serves the **target** page (HTTP redirect or rewrite — Next.js layer's choice), honoring the fragment; append `?redirect=no` to view the redirect page itself.
- Exactly **one hop** is followed. Redirect→redirect (double redirect) is *not* chased: the user lands on the second redirect page rendered per 12.3. Redirect to self or nonexistent target: render per 12.3 (target as red link).

### 12.3 Rendering the redirect page itself (`?redirect=no`)

```html
<div class="redirectMsg"><p>Redirect to:</p>
<ul class="redirectText"><li><a href="/wiki/Moons#Titan" title="Moons">Moons#Titan</a></li></ul></div>
```

Content **after** the redirect line is parsed and rendered below (categories in it still register — this is how redirects are categorized).

### 12.4 Metadata

`ParseResult.redirect = { target: Title, fragment?: string }` is set whenever 12.1 matches, even if the body is also rendered.

---

## 13. Magic behavior: `DISPLAYTITLE`, signatures

### 13.1 `{{DISPLAYTITLE:…}}`

Syntax: parser function taking one argument. Records `displayTitle` in page metadata; the Next.js layer substitutes it for the `<h1>`/`<title>`.

- The argument is expanded, then sanitized: only inline formatting that doesn't change the *text content* is kept — allowed tags `i b em strong s u sub sup span small` (with sanitized attributes); everything else stripped to text.
- Restriction (MW `$wgRestrictDisplayTitle` = true): the argument's **text content**, after title normalization (§5.7), must equal the page's actual title; only then is it applied. Otherwise it is ignored and a warning is recorded. This permits case changes of the first letter (`{{DISPLAYTITLE:iPhone}}` on page `IPhone`), formatting, and underscore/space tweaks — not renames.
- Multiple calls: last valid one wins.
- Output of the call itself: empty string.

### 13.2 Signatures `~~~`, `~~~~`, `~~~~~`

Out of scope (no pre-save transform in this engine). Tilde runs render **literally** as typed. Do not expand, do not error. (If a PST is ever added, it — not the parser — replaces them at save time.) **D-9**.

### 13.3 Other magic words already covered

Behavior switches — §2.6. `{{!}}`/`{{=}}` — §7.10. Variables — §9.5.

---

## 14. Parsing pipeline and AST (normative architecture)

Module layout suggestion: `src/engine/wikitext/{normalize,preprocessor,expand,sanitize,blocks,inline,render,types}.ts`.

### 14.1 Stage 0 — Normalize

- CRLF/CR → LF. Strip U+FEFF at start. Remove U+0000 and U+007F. Ensure the text ends with `\n`.
- Decode nothing else here (entities are handled contextually later).

### 14.2 Stage 1 — Preprocess into a token tree

Single left-to-right scan producing a **PPTree** (see types below) with nodes for: template calls `{{…}}`, parameter uses `{{{…}}}`, extension tags (registered names, §10, plus `noinclude`/`includeonly`/`onlyinclude`), HTML comments, and text. Rules:

- Extension-tag capture beats brace matching: `{{x|<nowiki>}}</nowiki>}}` — the nowiki grabs `}}` as content; the template closes at the final `}}`.
- Comments are removed at this stage (with the line-eating rule, §10.8). A comment **inside** a template name or argument simply vanishes: `{{Temp<!-- -->late}}` calls `Template:Template` (matches MW). But brace **runs must be contiguous characters**: `{<!-- -->{Foo}}` is not a template call — the two `{` are separate runs, so the braces stay literal.
- Include-context filtering (§8.6) is applied to a page's raw text before building its tree, parameterized by "is this a transclusion?".
- Heading lines are *not* special at this stage (we do not need preprocessor headings since section editing is out of scope).

### 14.3 Stage 2 — Expand

Walk the PPTree with a `Frame`:

```
expand(tree, frame):
  Text            → as-is
  Comment         → ""
  ExtTag          → invoke handler later; here: keep as ExtTag with *expanded* inner
                    only for tags whose content is wikitext (ref, gallery caption, references);
                    nowiki/pre/syntaxhighlight keep raw content; then → strip marker
  TemplateCall    → resolve name (§8.2 / §9.1):
                      variable        → value
                      parser function → evaluate (§9), args lazily expanded+trimmed
                      {{!}} / {{=}}   → "|" / "="
                      template        → loop/depth/size checks → expand target's tree
                                        in a child frame (args lazy, cached)
  ParameterUse    → frame argument or default or literal (§8.4)
```

Output: a flat string of expanded wikitext + a strip-marker table + page-scope collectors already partially filled (refs are *not* yet numbered — numbering happens at render).

The T2529 auto-newline (§8.7) is applied when splicing any expansion whose first characters are `*#;:` , `{|`, or `----` and the splice point is not at line start.

### 14.4 Stage 3 — Sanitize raw HTML

Scan the expanded text for `<…>` sequences. Allowed tags (§11) are normalized into canonical tag tokens (attributes filtered here); everything else is entity-escaped in place. After this stage the only `<` characters in the text belong to sanctioned tags or escaped entities. (Strip markers are opaque and untouched.)

### 14.5 Stage 4 — Block parse

Line-oriented, in this order of precedence per line/region:

1. Redirect check (§12) — done once on the whole page before anything.
2. `__WORD__` behavior switches: remove + record (§2.6).
3. **Tables** (§7): the table scanner consumes whole line ranges (recursively); cell contents re-enter stage 4 as nested block regions.
4. **Headings** (§2) on remaining lines.
5. `----` → hr (§3.4).
6. **Lists** (§4): prefix machine over consecutive lines; item contents are inline regions (no nested block re-entry except the structural nesting the prefixes encode).
7. **Pre** (space-indent) and **paragraph assembly** (§3), with the block-HTML-line exemption (§3.1 rule 4).

Rationale for order: tables before headings/lists so that `|`-lines inside tables are never misread; headings before lists is irrelevant (disjoint markers) but fixed for determinism. Template expansion already happened, so all of these see final markup.

### 14.6 Stage 5 — Inline parse

For each inline region (paragraph line-run, heading content, cell one-liners, list items, captions):

1. Replace sanctioned HTML tag tokens with HtmlElement nodes (balancing per §11.2).
2. Internal links & files (§5) — single scan, bracket-balanced for files.
3. Apostrophe algorithm per line (§1), operating over the node stream.
4. External links (§6): bracketed then free URLs, skipping inside `<a>`-producing nodes.
5. Remaining text → Text nodes (entity handling per §11.5).

### 14.7 Stage 6 — Render + finalize

- Walk the AST → HTML string. Number refs and emit reference lists (§10.3); build TOC (§2.5) and splice it; generate heading ids with dedupe (§2.4); auto-append pending references.
- **Restore strip markers last** (single pass, markers may nest → iterate until none remain, bounded).
- Assemble `ParseResult` metadata.

### 14.8 Where `<nowiki>` protection lives (summary)

`<nowiki>`/`<pre>`/`<syntaxhighlight>` content is captured at Stage 1 (preprocessor), so it is invisible to template expansion, sanitization, block and inline parsing alike; it re-enters the output only at Stage 6 marker restoration. This single rule answers every "does X see inside nowiki?" question: **no stage between 1 and 6 does.**

### 14.9 External interfaces

```ts
export interface PageStore {
  /** Normalized title → raw wikitext, or null. Sync for build-time rendering. */
  getSource(title: TitleKey): string | null;
  exists(title: TitleKey): boolean;
  /** File metadata for [[File:…]] and <gallery>. */
  getFile(name: string): { src: string; width: number; height: number } | null;
}

export interface ParseOptions {
  config: WikiConfig;
  store: PageStore;
  page: Title;            // the page being rendered (for PAGENAME etc.)
  now?: Date;             // injected clock for CURRENT* (tests!)
}
```

### 14.10 AST type definitions (complete)

```ts
// ---------- titles ----------
export type TitleKey = string; // "ns:Normalized_page_name" cache key
export interface Title {
  namespace: number;        // §5.8
  pageName: string;         // normalized, first letter uppercased, spaces
  fragment?: string;
}

// ---------- preprocessor tree (stage 1–2) ----------
export type PPNode = PPText | PPTemplate | PPParameter | PPExtTag | PPComment;
export interface PPText     { kind: 'text'; value: string }
export interface PPComment  { kind: 'comment'; value: string }
export interface PPTemplate {                    // {{ … }}
  kind: 'template';
  name: PPNode[];                                // may contain nested nodes
  params: { name: PPNode[] | null; value: PPNode[] }[]; // null name = positional
}
export interface PPParameter {                   // {{{ … }}}
  kind: 'parameter';
  name: PPNode[];
  default?: PPNode[];
}
export interface PPExtTag {
  kind: 'ext';
  name: string;                                  // lowercased
  attrs: Record<string, string>;
  inner: string | null;                          // raw; null for self-closing
}

// ---------- document AST (stage 4–6) ----------
export interface Document {
  type: 'document';
  children: BlockNode[];
  meta: PageMeta;
}
export interface PageMeta {
  categories: { name: string; sortKey: string | null }[];
  displayTitle?: string;                          // sanitized HTML, §13.1
  redirect?: { target: Title };
  behaviorSwitches: Set<string>;                  // "NOTOC", "TOC", …
  toc: TocEntry[];
  templatesUsed: TitleKey[];                      // for cache invalidation
  linksTo: TitleKey[];                            // outgoing internal links
  volatile: boolean;                              // used CURRENT*/#ifexist
  warnings: string[];
}
export interface TocEntry {
  level: number;          // h-level 1..6
  tocLevel: number;       // relative, §2.5
  number: string;         // "2.1"
  id: string;
  html: string;           // flattened inline content
}

export type BlockNode =
  | Paragraph | Heading | HorizontalRule | Preformatted
  | ListBlock | DefinitionList | Table | HtmlBlock
  | TocPlaceholder | ReferencesBlock | Gallery | RedirectNotice;

export interface Paragraph      { type: 'p'; children: InlineNode[] }
export interface Heading        { type: 'heading'; level: 1|2|3|4|5|6; id: string; children: InlineNode[] }
export interface HorizontalRule { type: 'hr' }
export interface Preformatted   { type: 'pre'; literal: boolean;      // literal=true → tag form (§10.2)
                                  attrs?: Attrs; children: InlineNode[] /* or single Text when literal */ }
export interface ListBlock      { type: 'list'; ordered: boolean; attrs?: Attrs; items: ListItem[] }
export interface ListItem       { type: 'li'; children: (InlineNode | BlockNode)[] }
export interface DefinitionList { type: 'dl'; items: (DefTerm | DefData)[] }
export interface DefTerm        { type: 'dt'; children: (InlineNode | BlockNode)[] }
export interface DefData        { type: 'dd'; children: (InlineNode | BlockNode)[] }
export interface Table          { type: 'table'; attrs: Attrs; caption?: { attrs: Attrs; children: InlineNode[] };
                                  rows: TableRow[]; fostered: BlockNode[] }
export interface TableRow       { type: 'tr'; attrs: Attrs; cells: TableCell[] }
export interface TableCell      { type: 'cell'; header: boolean; attrs: Attrs; children: BlockNode[] }
export interface HtmlBlock      { type: 'html-block'; tag: string; attrs: Attrs; children: (InlineNode | BlockNode)[] }
export interface TocPlaceholder { type: 'toc' }
export interface ReferencesBlock{ type: 'references'; group: string; auto: boolean }
export interface Gallery        { type: 'gallery'; attrs: GalleryAttrs; items: GalleryItem[] }
export interface RedirectNotice { type: 'redirect'; target: Title; targetText: string }

export type InlineNode =
  | Text | Bold | Italic | WikiLink | ExternalLink | ImageLink
  | HtmlInline | LineBreak | RefMarker | StripMarker | Entity;

export interface Text         { type: 'text'; value: string }
export interface Entity       { type: 'entity'; value: string }       // "&copy;" kept for exact output
export interface Bold         { type: 'b'; children: InlineNode[] }
export interface Italic       { type: 'i'; children: InlineNode[] }
export interface WikiLink     { type: 'wikilink'; target: Title; exists: boolean;
                                selfAnchor: boolean;                  // [[#frag]]
                                children: InlineNode[] }              // label incl. trail
export interface ExternalLink { type: 'extlink'; href: string; style: 'text'|'autonumber'|'free';
                                number?: number; children: InlineNode[] }
export interface ImageLink    { type: 'image'; file: string; exists: boolean;
                                format: 'inline'|'thumb'|'frame'|'frameless';
                                halign?: 'left'|'right'|'center'|'none';
                                valign?: 'baseline'|'sub'|'super'|'top'|'text-top'|'middle'|'bottom'|'text-bottom';
                                width?: number; height?: number; upright?: number;
                                border: boolean; alt?: string;
                                link?: Title | string | null;         // null = link= (none)
                                caption: InlineNode[] }
export interface HtmlInline   { type: 'html-inline'; tag: string; attrs: Attrs; children: InlineNode[] }
export interface LineBreak    { type: 'br' }
export interface RefMarker    { type: 'ref'; group: string; name?: string;
                                content?: InlineNode[];               // absent = pure reuse
                                index: number }                       // assigned at render
export interface StripMarker  { type: 'strip'; marker: string }       // resolved at render

export type Attrs = Record<string, string>;
export interface GalleryAttrs { caption?: string; widths: number; heights: number;
                                perrow?: number; mode: 'traditional'|'packed'; class?: string }
export interface GalleryItem  { file: string; exists: boolean; caption: InlineNode[];
                                alt?: string; link?: Title | string }

// ---------- result ----------
export interface ParseResult {
  doc: Document;
  html: string;
  meta: PageMeta;      // same object as doc.meta, exposed for convenience
}
```

Every node MAY additionally carry `span?: { start: number; end: number }` (offsets into the **original** source where meaningful; nodes born from template expansion carry the span of the call site).

### 14.11 Determinism and limits

Rendering the same source with the same `ParseOptions` (including `now`) must be byte-identical. Enforce: `maxTemplateDepth`, `maxIncludeSize`, `maxExpensiveCalls`, plus a global node budget (e.g. 1e6 AST nodes) and a wall-clock-free design (no regex catastrophic backtracking — all scanners must be linear; write the apostrophe splitter and URL matcher without nested quantifiers).

---

## 15. Conformance test corpus

Turn each case into a unit test (`vitest`): parse the input with the fixtures below and assert the expected HTML shape / metadata. Whitespace between block-level tags is not asserted; everything else is.

**Fixture templates** (exist in the test PageStore):

```
Template:1x     = {{{1}}}
Template:N      = [{{{k}}}]
Template:Bullet = * {{{1}}}
Template:Boxtop = {| class="box"
Template:Boxend = |}
Template:Loop   = {{Loop}}
```
Pages `Bracken`, `Moon`, `Quota`, `Bar`, `Page`, `Target`, `File:X.png` (100×80) exist; everything else does not.

### Apostrophes

- **C-01** `'''''x'''''` → `<p><i><b>x</b></i></p>`
- **C-02** `''''x''''` → `<p>'<b>x'</b></p>`
- **C-03** `''''''x''''''` → `<p>'<i><b>x'</b></i></p>`
- **C-04** `'''a'' b` → `<p>'<i>a</i> b</p>` (both-odd re-balance, multi-letter word)
- **C-05** `It's a'''nice'' day` → `<p>It's a'<i>nice</i> day</p>` (single-letter word wins)
- **C-06** `'''unclosed` → `<p><b>unclosed</b></p>` (EOL close)
- **C-07** `''a'''b'''c''` → `<p><i>a<b>b</b>c</i></p>`
- **C-08** `'''''a'' b'''` → `<p><b><i>a</i> b</b></p>`
- **C-09** `''one` + `\n` + `two''` → `<p><i>one</i>\ntwo<i></i></p>` (formatting never crosses lines)

### Headings

- **C-10** `====` → `<h1 id="==">==</h1>`
- **C-11** `== A ==␠␠` (trailing spaces) → `<h2 id="A">A</h2>`
- **C-12** `== A == b` → `<p>== A == b</p>` (not a heading)
- **C-13** `=={{1x|B}}==` → `<h2 id="B">B</h2>` (expansion before heading recognition)
- **C-14** `== X ==\n== X ==` → ids `X`, `X_2`

### Paragraphs / pre / hr

- **C-15** `a\nb` → `<p>a\nb</p>`
- **C-16** `a\n\n\nb` → `<p>a</p><p><br />\nb</p>` (two blank lines)
- **C-17** `␠''pre'' with markup` → `<pre><i>pre</i> with markup\n</pre>` (space-pre parses inline)
- **C-18** `----text` → `<hr /><p>text</p>`

### Lists

- **C-19** `* a\n*# b\n*# c` → `<ul><li>a<ol><li>b</li><li>c</li></ol></li></ul>`
- **C-20** `; [[Help:Contents]] : d` → dt is the link (colon inside `[[…]]` doesn't split), dd = `d`
- **C-21** `# a\n\n# b` → two separate `<ol>`s, numbering restarts
- **C-22** `# a\n#: note\n# b` → `<ol><li>a<dl><dd>note</dd></dl></li><li>b</li></ol>`
- **C-23** `*{|\n| x\n|}` → `<ul><li>{|</li></ul><p>| x\n|}</p>` (tables cannot start inside a list item)
- **C-24** `:{|\n| x\n|}` → `<dl><dd><table><tbody><tr><td>x</td></tr></tbody></table></dd></dl>`

### Internal links

- **C-25** `[[a|b]]c` → `<a href="/wiki/A" title="A">bc</a>` (trail joins label)
- **C-26** `[[quota]]` → `<a href="/wiki/Quota" title="Quota">quota</a>` (first-letter case folding)
- **C-27** `[[Pipe (computing)|]]` → label `Pipe`; red link (page missing)
- **C-28** `[[Boston, Massachusetts|]]` → label `Boston`
- **C-29** `[[Foo#Bar|]]` → label `Foo#Bar` (fragment disables pipe trick)
- **C-30** `[[moon]]<nowiki/>s` → `<a …>moon</a>s` (marker breaks trail)
- **C-31** `[[Foo|see [[Bar]] here]]` → `<p>[[Foo|see <a href="/wiki/Bar" title="Bar">Bar</a> here]]</p>`
- **C-32** `[[Category:Moons|T]]` alone on a line → no output line; `meta.categories = [{name:"Moons", sortKey:"T"}]`
- **C-33** `[[:Category:Moons]]` → plain link to the category page
- **C-34** `[[File:X.png|thumb|A [[Bracken]] pic]]` → `<figure>` with caption containing the Bracken link (bracket balancing inside file syntax)

### External links

- **C-35** `[https://a.example] [https://b.example]` → `[1]`, `[2]` autonumbers in order
- **C-36** `https://x.example/a_(b),` → link keeps `(b)`, trailing `,` is text
- **C-37** `[javascript:alert(1) x]` → literal text, no link
- **C-38** `[https://x.example ''lbl'']` → `<a class="external text" …><i>lbl</i></a>`

### Tables

- **C-39** `{{Boxtop}}\n| cell\n{{Boxend}}` → `<table class="box">…<td>cell</td>…</table>` (`{|` produced by templates)
- **C-40** `{|\n| {{#if:x|a{{!}}b|c}}\n|}` → `<td>b</td>` (`{{!}}` becomes a real pipe → `a` parsed as a bogus, dropped attribute)
- **C-41** `{|\n| [[a|b]] || x | y\n|}` → cells: `<td><a …>b</a></td><td>y</td>` (`[[` vetoes attr split; `x` consumed as dropped attrs)
- **C-42** `{|\n! a !! b || c\n|}` → three `<th>`
- **C-43** nested `{|` in a cell (input as §7.11-4) → nested `<table>`
- **C-44** `{|\n|+ class="c" | Cap\n| x\n|}` → `<caption class="c">Cap</caption>`
- **C-45** `{|\nstray\n| x\n|}` → `<p>stray</p>` emitted before the `<table>`

### Templates & parameters

- **C-46** `{{1x| a }}` → text ` a ` (positional param NOT trimmed)
- **C-47** `{{N|k= v }}` → `[v]` (named param trimmed)
- **C-48** `{{1x|1=a|b}}` → `b` (later duplicate wins)
- **C-49** `{{Loop}}` → `<span class="error">Template loop detected: <a …>Template:Loop</a></span>`
- **C-50** `{{{{a}}}}` (top level) → literal text `{{{{a}}}}` (brace matching: `{` + `{{{a}}}` + `}`; top-level param renders literally)
- **C-51** `{{1x|<ref>R</ref>}}` → `<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup>` + auto-appended references list (ref inside template)
- **C-52** `foo {{Bullet|x}}` → `<p>foo </p><ul><li>x</li></ul>` (auto-newline before `*`)
- **C-53** `{{subst:1x|y}}` → `y` (subst stripped, D-8)
- **C-54** `{{1x|a<nowiki>|</nowiki>b}}` → `a|b` (protected pipe is not a separator)

### Parser functions

- **C-55** `{{#if: |y|n}}{{#if: 0 |y|n}}` → `ny` (whitespace-only false; `0` true)
- **C-56** `{{#ifeq: 1e3 | 1000 | eq | ne }}` → `eq`; `{{#ifeq: abc | ABC | eq | ne }}` → `ne`
- **C-57** `{{#switch: b | a | b | c = ABC | other }}` → `ABC` (fallthrough)
- **C-58** `{{#expr: 2^3^2 }}` → `64`; `{{#expr: 1/0 }}` → `<strong class="error">Expression error: Division by zero.</strong>`
- **C-59** `{{ucfirst:{{lc:LOOT}}}}` → `Loot` (nesting)
- **C-60** `{{PAGENAME}}`/`{{SUBPAGENAME}}` on page `Help:Guides/Routing` → `Guides/Routing` / `Routing`

### Extension tags & sanitization

- **C-61** `<nowiki>[[x]] {{1x|y}} ''z''</nowiki>` → literal `[[x]] {{1x|y}} ''z''`
- **C-62** `<pre>''x''</pre>` → literal `''x''` in pre; contrast `␠''x''` → `<pre><i>x</i>\n</pre>`
- **C-63** `<code>''x''</code>` → `<code><i>x</i></code>` (code content IS parsed)
- **C-64** `A<ref name=a>First</ref> B<ref name=a/>\n<references/>` → both markers show `[1]`; list has one item with two backlinks (`a b`)
- **C-65** `X<ref name=missing/>\n<references/>` → list contains `<span class="error">Cite error: no text provided for ref "missing"</span>`
- **C-66** `<script>alert(1)</script>` → `<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>`
- **C-67** `<div onclick="x()" style="background:url(e)">hi</div>` → `<div style="/* insecure input */">hi</div>` (onclick dropped)
- **C-68** `<b>unclosed` → `<p><b>unclosed</b></p>` (balanced at paragraph end)
- **C-69** `<syntaxhighlight lang="ts">a < b</syntaxhighlight>` → `<pre class="mw-highlight"><code class="language-ts">a &lt; b</code></pre>`

### Redirects & interplay

- **C-70** `#REDIRECT [[Target#Frag]]` → `meta.redirect = {target: Target, fragment: "Frag"}`; page body renders redirect notice
- **C-71** `text\n#REDIRECT [[Target]]` → NOT a redirect; second line renders `<ol><li>REDIRECT <a …>Target</a></li></ol>`
- **C-72** `== T ==\n<!-- c -->\n== T ==\n== A ==\n== B ==` → 4 headings → TOC renders; comment line vanishes without a paragraph break; ids `T`, `T_2`, `A`, `B`
- **C-73** `{{1x|== H ==}}` on its own line → `<h2 id="H">H</h2>` (headings recognized after expansion)
- **C-74** `<nowiki>== H ==</nowiki>` on its own line → `<p>== H ==</p>`

---

## Appendix A — Intentional divergences from MediaWiki

| ID | Where | Divergence |
|---|---|---|
| D-1 | §1.4 | Apostrophe regions crossing link-label boundaries are re-nested to emit well-formed HTML (MW can emit misnested tags fixed later by Tidy/Remex). |
| D-2 | §2.3 | Heading id sits on the `h*` element; no `<span class="mw-headline">` wrapper. |
| D-3 | §2.4 | HTML5 fragment mode only; no legacy dot-encoded fallback anchors. |
| D-4 | §2.5 | Raw HTML headings do not enter the TOC. |
| D-5 | §4.3 | Definition-split colon search never splits inside any link construct (MW's `findColonNoLinks` has URL edge bugs). |
| D-6 | §5.3 | Pipe trick applied at parse time (MW: save-time PST), so it also works inside transclusions. |
| D-7 | §5.9 | Canonical `<figure>/<figcaption>` image markup instead of MW legacy `div.thumb` markup. |
| D-8 | §0.2/§8.2 | `subst:` treated as plain transclusion. |
| D-9 | §13.2 | `~~~~` renders literally. |
| D-10 | §0.2 | No ISBN/RFC/PMID magic links. |
| D-11 | §9.1 | Unknown parser functions render a standard error span. |
| D-12 | §9.4 | `{{ns:}}` with unknown value → empty string (MW emits an error for bad input in some versions). |
| D-13 | §10.3 | Simplified, stable ref id key format (behavioral numbering identical). |

Anything else that differs from MediaWiki observed behavior is a bug in the implementation — or in this spec; when a conflict is found, verify against a live MediaWiki (e.g. the wikipedia.org sandbox), fix the spec first, then the code, and add a corpus case.

---

## Addendum (critic)

Amendments from the pre-implementation completeness review (2026-08-31). Each item is normative with the same authority as the numbered sections. Cross-references: `docs/engine/critique.md`.

### A1. Blank lines inside open raw block-level HTML — new divergence **D-14**

Trigger: the seed infobox templates (seed-content-plan §2) emit `{{#if:…|<tr>…</tr>}}` rows on their own source lines inside a raw `<table>`. Omitted parameters expand to empty, leaving blank lines between `<tr>` lines — with §3.2 as written, two-plus consecutive omitted params (e.g. the KO Titan fixture omitting `weather` and `interior`) would emit `<p><br /></p>` / `<br />` fragments *inside* `<table>`, which is invalid there.

Rule: while at least one raw HTML element whose content model does not allow `<p>` is open — `table`, `thead`, `tbody`, `tfoot`, `tr`, `ul`, `ol`, `dl` — blank lines produce **no output** (no empty paragraphs, no `<br />` prefixes); they still terminate any open paragraph. The §3.2 blank-run accumulation applies only when the run is followed by a paragraph-text line in a context that accepts `<p>`. **D-14** (legacy MW emits fostered empty paragraphs here and relies on the HTML5 tree builder to relocate them; we specify clean output directly). Append to Appendix A: `| D-14 | §3.2/Addendum A1 | Blank lines inside open p-rejecting raw HTML elements emit nothing. |`

### A2. Redirect metadata shape (internal consistency fix)

§12.4 writes `ParseResult.redirect = { target: Title, fragment?: string }` while §14.10 declares `PageMeta.redirect?: { target: Title }`. Normative shape: **`{ target: Title }`**, with any fragment carried in `target.fragment` (the `Title` type already has `fragment?`). §12.4's separate `fragment` field is superseded. Corpus case C-70 asserts `meta.redirect.target.fragment === "Frag"`.

### A3. Localizable parser-emitted strings (i18n)

The spec hardcodes English strings in output: TOC title `Contents` (§2.5), red-link `title` suffix `(page does not exist)` (§5.2), `Redirect to:` (§12.3), cite errors (§10.3), template loop/depth errors (§8.5). Add to `WikiConfig`:

```ts
messages: {
  tocTitle: string;                       // "Contents" / "목차"
  redLinkTitleSuffix: string;             // "(page does not exist)"
  redirectTo: string;                     // "Redirect to:"
  citeErrorNoText: (name: string) => string;
  templateLoop: string;
  templateDepthExceeded: string;
  // #expr error strings MAY remain EN-only (they mirror MW's exactly).
}
```

The engine is instantiated per rendering locale (messages sourced from the i18n dictionaries of reuse-audit §3), which is safe because the render cache is keyed `(page_id, locale)`. Korean headings need no change: §2.4 `fragmentMode: 'html5'` already keeps Hangul (`== 개요 ==` → `id="개요"`, percent-encoded only inside `href` fragments) — confirmed intentional, covered.

### A4. `templatesUsed` / `linksTo` completeness (cache-invalidation contract)

`PageMeta.templatesUsed` MUST list every transclusion target *attempted* during expansion — including transitively transcluded templates (a template used by a template) and **nonexistent** targets (red-linked templates). `PageMeta.linksTo` likewise includes red links. The DB layer (db-schema Addendum A4) builds `template_links` / `page_links` from these fields; omitting transitive or missing targets breaks render-cache invalidation on template edits and on page creation.

### A5. `articlePath` is per-locale; `$1` pending the slug decision

`WikiConfig` is instantiated per rendering locale — the real pattern is `/{locale}/wiki/$1`; examples in this spec show the locale-less `/wiki/$1` for brevity and conformance tests assert that shape. What substitutes `$1` (MW-encoded title vs. DB slug) is governed by the title↔slug mapping decision, currently OPEN — see critique.md O1.

### A6. Block-level HTML wrappers hold their content (§3.1 rule 4, clarification)

§3.1 rule 4 says a line whose first token is an allowed block-level HTML tag suppresses `<p>` wrapping and "the HTML flows as-is". This clarifies what *as-is* means when the element does not close on its own line, which the rule did not previously state and which §11.2 ("balance per block scope") could be read as answering the wrong way.

Rule: a **p-allowing** block container — `div`, `blockquote`, `center`, `figure` — that opens on its own line and does not close on that line stays open across the blocks that follow. The lines between it and its matching close tag are parsed as ordinary blocks (paragraphs, headings, lists, tables all work inside a wrapper), and those blocks become the element's children. Its "block scope" for §11.2 balancing is therefore the whole run, not the opening line.

```wikitext
<div class="terminal-text">
68-Artifice

CONDITIONS: …
</div>
```
```html
<div class="terminal-text"><p>68-Artifice</p><p>CONDITIONS: …</p></div>
```

Consequences:

- Nesting depth is tracked per element name, so `<div><div>…</div>…</div>` closes in the right order; a self-closing `<div />` opens and closes.
- Text before the close tag on its line is still content; text after it returns to the block scanner.
- An unclosed wrapper runs to the end of the page and is closed there (§11.2 LIFO).
- **Contrast Addendum A1 / D-14**: a p-REJECTING element (`table`, `thead`, `tbody`, `tfoot`, `tr`, `ul`, `ol`, `dl`) keeps its existing treatment — the run becomes ONE inline region and blank lines inside it emit nothing — because a `<p>` there would be invalid.
- `pre`, `p`, `h1`–`h6` and `hr` are leaves and are unaffected; `td`, `th`, `li` and `dd` occur inside a p-rejecting run, which owns them.

Without this, the wrapper closed at the end of its opening line and its later close tag was dropped as a stray, so an author's `<div class="…">` rendered **empty** with its content spilled out after it as siblings — losing the wrapper's styling. Covered by `src/lib/wikitext/pipeline.test.ts` ("block HTML wrappers hold their content") and, on the reference article, by `fandom-conformance.test.ts`.

---

## Fandom extensions

Additive parity with Fandom (wikia) wikitext, layered on the MediaWiki-compatible
core above. Nothing in this chapter changes the behavior of any construct
specified in §0–§15: where Fandom and MediaWiki agree, the MediaWiki rule — and
the §15 corpus — remains authoritative, and every construct not named here keeps
exactly the behavior its numbered section gives it.

The chapter is one story in four parts. **F.1** is the portable infobox, the
`<infobox>` block a Fandom infobox *template* is written in. **F.2** is Fandom's
tag vocabulary (`<tabber>`, `<poem>`, the extended `<gallery>`) and sortable
tables. **F.3** collects the article-level parity fixes — image sizes,
interlanguage links, reference ordering, the red-link class, behavior switches.
**F.4** describes the source editor's two *readers* of this grammar, which add no
grammar of their own.

**Reference fixture.** `docs/engine/fixtures/fandom-artifice.wikitext` is the
verbatim wikitext of the "68-Artifice" article from the Lethal Company Fandom
wiki. It is CC BY-SA content, kept as a TEST FIXTURE ONLY — never seeded, never
served. `src/lib/wikitext/fandom-conformance.test.ts` renders it end to end
against a map-backed `PageStore` and asserts this chapter's claims on it.

### F.0 Support matrix

"Supported" means specified here and covered by tests; "partial" means the
construct renders usefully but not identically to Fandom; "no" means it is not
implemented, and the row says what the reader sees instead.

| Construct | Status | Notes |
|---|---|---|
| `<infobox>` portable infobox | **supported** | Full element set (F.1.2), `source=`/`<default>`/`<format>`, the empty rule, themes and layouts. |
| `<panel>` / `<section>` inside an infobox | **partial** | Render as plain `<group>`s — every row is reachable, but there is no tab strip (divergence **F-1**). |
| `<tabber>` / `<tab>` | **supported** | Both the legacy `Title=` / `\|-\|` and element syntaxes; CSS-only, works with JavaScript disabled. |
| `<poem>` | **supported** | Line breaks preserved, `class` forwarded. |
| `<gallery>` + Fandom attributes | **supported** | `mode`, `widths`, `heights`, `spacing`, `captionalign`, `position`, `caption`, `class`; `hideaddbutton` accepted and ignored. |
| `class="sortable"` tables | **supported** | Client-side progressive enhancement (F.2.4); bails out cleanly on merged cells or fewer than two data rows. |
| Image size options (`{N}px`, `x{N}px`, `{W}x{H}px`, `upright`) | **supported** | Resolved against the file's natural size; every `<img>` gets `width`+`height`. |
| Interlanguage links (`[[ru:X]]`) | **supported** | Swallowed into `meta.languageLinks`; the prefix list is frozen in `links.ts` (no interwiki table). |
| `<ref>` inside deferred content (gallery/thumb captions) | **supported** | Two-pass restoration, so one `<references />` holds every note (F.3.3). |
| Red-link class | **supported** | One spelling everywhere: `class="new red-link"`. |
| Fandom behavior switches (`__NOWYSIWYG__`, `__NOGALLERY__`, …) | **supported** | Recognized, removed, recorded in `meta.behaviorSwitches`; the app decides what each means. |
| `{{DEFAULTSORT:}}` | **supported** | Page-wide category sort key, position-independent. |
| `<infobox>` custom CSS themes | **partial** | `pi-theme-*` / `pi-layout-*` classes are emitted; the theme owns the tokens, and no colors or inline styles are ever emitted (theme.md). |
| Lua / Scribunto (`{{#invoke:}}`) | **no** | Not implemented. `#invoke` is an unknown parser function, so it renders as `<span class="error">` (§9.1) and the page still renders. |
| DynamicPageList (`<dpl>`, `<DPL>`) | **no** | Unknown extension tag ⇒ escaped and shown literally (§10.7). A wiki this size has no use for query-generated lists. |
| `<tabview>` (Fandom's cross-*article* tabs) | **no** | Unknown tag ⇒ literal (§10.7). Unlike `<tabber>` it transcludes other pages, which would make one page's render depend on many. |
| `<choose>` / `<option>` (random content) | **no** | Unknown tag ⇒ literal. Deliberately excluded: it breaks the §14.11 determinism guarantee the parse cache depends on. |
| `<verbatim>`, `<nowiki>`-alikes beyond §10 | **no** | Unknown tag ⇒ literal (§10.7). |
| Fandom message-wall / forum markup | **no** | Out of scope: those are social features, not wikitext. |


### F.1 Portable infobox (`<infobox>`)

Fandom's **Portable Infobox** markup: the `<infobox>` XML block that a Fandom
infobox *template* is written in, and which produces the boxed summary beside an
article's lead. Covers engine gap G5. Additive: `<infobox>` was previously an
unknown tag (§10.7, shown literally), so nothing that parsed before changes.

`<infobox>` is **parser-level markup, not raw HTML**. It is a registered
extension tag (§10), so §11 never sees it and never escapes it; its children
(`<data>`, `<label>`, …) are read by the infobox parser, not by the sanitizer.
Everything that ends up in the output is still sanitized, because every value is
rendered through the same path a `<gallery>` caption takes (§14.7).

#### F.1.1 Where it runs in the pipeline

| Stage | What happens |
|---|---|
| 1 — preprocess (§14.2) | Captured as one opaque `PPExtTag`; the body is **not** brace-matched, so `{{{cost}}}` and `{{PAGENAME}}` inside it survive verbatim. |
| 2 — expand (§14.3) | The body is parsed into an element tree and **resolved against the current frame**; the finished model is parked behind a strip marker (§14.8). |
| 4 — block parse (§14.5) | The marker is **block-level** (like `<gallery>`): it splits a paragraph and is never wrapped in `<p>`. |
| 6 — render (§14.7) | The model becomes HTML; each value is sanitized + inline-parsed on the page's render state, so refs, ids and autonumbers stay page-wide. |

Resolution must happen in stage 2 because `source=` binds to the **template
call's arguments**: when `Template:Location`'s body is an `<infobox>` block and
an article writes `{{Location|cost=1500}}`, `source="cost"` reads `1500` from
that call's frame. An `<infobox>` rendered outside any template call — on the
template page itself, or typed into an article — has no arguments, so every
source is absent and the `<default>`s (and the empty rule) apply.

#### F.1.2 Element table

"Legal in" is enforced: an element written where it is not legal is **not**
markup there and stays verbatim wikitext, so `<span>` or `<br />` inside a
`<default>` reaches the renderer intact. All element and attribute names are
case-insensitive; `<tag/>` self-closing is allowed everywhere.

| Element | Legal in | Attributes | Child elements | Output |
|---|---|---|---|---|
| `<infobox>` | (root) | `theme`, `theme-source`, `layout` | `title` `image` `data` `header` `group` `panel` `section` `navigation` | `<aside class="portable-infobox pi-background pi-border-color [pi-theme-X] pi-layout-Y">` |
| `<title>` | `infobox`, `group` | `source` | `default`, `format` | `<h2 class="pi-item pi-item-spacing pi-title" data-source="…">` |
| `<image>` | `infobox`, `group` | `source` | `caption`, `default`, `alt` | `<figure class="pi-item pi-image">` wrapping the file link, whose `<img>` gains `class="pi-image-thumbnail"` |
| `<caption>` | `image` | `source` | `default`, `format` | `<figcaption class="pi-item-spacing pi-caption">` |
| `<alt>` | `image` | `source` | — | feeds the image's `alt=` (no element of its own) |
| `<data>` | `infobox`, `group` | `source` | `label`, `default`, `format` | `<div class="pi-item pi-data pi-item-spacing" data-source="…">` |
| `<label>` | `data` | `source` | — | `<h3 class="pi-data-label pi-secondary-font">` |
| `<default>` | `data`, `title`, `image`, `caption` | — | — | none — supplies the fallback value |
| `<format>` | `data`, `title`, `caption` | — | — | none — supplies the value template |
| `<header>` | `infobox`, `group` | — | — | `<h2 class="pi-item pi-header pi-secondary-font pi-item-spacing pi-secondary-background">` |
| `<group>` | `infobox`, `group` | `collapse`, `show`, `layout` | same as `<infobox>` | `<section class="pi-item pi-group pi-border-color [pi-collapse pi-collapse-open\|closed] [pi-horizontal-group]">` |
| `<panel>`, `<section>` | `infobox`, `group` | as `<group>` | as `<group>` | identical to `<group>` (divergence **F-1**) |
| `<navigation>` | `infobox`, `group` | — | — | `<nav class="pi-item pi-navigation pi-item-spacing pi-secondary-background">` |

Attribute values:

- `theme` / `layout` are reduced to a CSS-safe token (`[a-z0-9-]`, runs collapsed
  to `-`) before becoming `pi-theme-X` / `pi-layout-Y`, so a hostile value can
  never break out of the class attribute. Absent `layout` ⇒ `pi-layout-default`.
- `theme-source="p"` reads the theme from template argument `p`, falling back to
  `theme` when that argument is absent.
- `collapse` is honored only for the values `open` and `closed`; anything else is
  ignored (no `pi-collapse` class).
- `show` is honored only for the value `incomplete` (see the empty rule).

#### F.1.3 Value resolution order

For `<title>`, `<image>`, `<data>`, `<caption>`, `<label>`, `<header>` and
`<navigation>`, in order, first hit wins:

1. **`source=`** → that argument of the current frame. If it resolves **non-empty**
   (after trimming): the element's `<format>` if it has one — expanded as
   wikitext **in the same frame**, so `{{{cost}}}` inside a `<format>` is the
   same value the `source` named — otherwise the argument value itself.
2. **`<default>`**, expanded as wikitext in the frame. `<format>` is deliberately
   **not** applied to a default (Fandom's rule): `<format>{{{cost}}} credits</format>`
   with no `cost` supplied must not print a bare `credits`.
3. **The element's own body text**, for the elements whose body *is* their content
   — `<title>`, `<caption>`, `<header>`, `<navigation>`, `<label>`. `<data>` and
   `<image>` ignore stray body text, as Fandom does.

#### F.1.4 THE EMPTY RULE

A value is *empty* when it is absent, or resolves to whitespace only.

- A **`<data>`** with an empty value renders **nothing** — no row, no label.
- An **`<image>`** with an empty value renders nothing (never an empty figure).
- A **`<group>`** renders only if at least one **non-`<header>`** item survived;
  a group whose data all resolved empty disappears **together with its headers**.
- An **`<infobox>`** with nothing left to show renders **nothing at all** — the
  empty `<aside>` shell is never emitted.
- **`<group show="incomplete">`** reverses the rule *for that group*: its empty
  `<data>` rows are kept (label rendered, `<div class="pi-data-value pi-font">`
  empty) and the group renders even when every row is empty, so a reader can see
  which fields a page still needs. `show` is per-group and is not inherited by a
  nested group.

#### F.1.5 Values are wikitext, and may be multi-line

Every resolved value — and every `<label>` — is **wikitext**: `[[links]]`,
`'''bold''', ''italic''`, templates, entities and `<ref>`s all work, and
disallowed raw HTML inside a value is escaped by §11 like anywhere else.

A value containing newlines (idiomatic on Fandom — the fixture's `map_layout` is
three interiors on three lines) is **not** collapsed: each line is inline-parsed
on its own and the lines are joined with `<br />`, so

```wikitext
|map_layout=Mineshaft (49.77%)
Mansion (35.28%)
Factory (14.95%)
```
```html
<div class="pi-data-value pi-font">Mineshaft (49.77%)<br />Mansion (35.28%)<br />Factory (14.95%)</div>
```

#### F.1.6 `<image>` values

Fandom accepts several spellings for the same picture, and so does this engine.
All of them normalize to a `[[File:…]]` that the engine's own file-link renderer
(§5.9) draws, which is what makes sizes, `alt=`/`link=` and — importantly — the
**missing-file red link** behave exactly as they do in article text:

| Written | Resolves to |
|---|---|
| `Artifice_Moon.png` | `[[File:Artifice_Moon.png]]` |
| `[[Artifice_Moon.png]]` | idem |
| `[[File:X.png\|250px]]` | `[[File:X.png\|250px]]` |
| `[[Image:X.png]]`, `[[:File:X.png]]` | `[[File:X.png]]` |

Only the options the box can use are forwarded — `{N}px`, `x{N}px`, `{W}x{H}px`,
`upright[={f}]`, `alt=`, `link=`; layout options such as `thumb`/`left` are
dropped, because the infobox supplies its own frame. When the value holds more
than one image the **first** wins. A missing file degrades to the ordinary red
file link (§5.9) inside the `<figure>`; it never throws.

#### F.1.7 Class contract

Fandom's own class names, so a stylesheet written for a Fandom wiki (and this
wiki's theme) can target the box directly: `.portable-infobox`, `.pi-title`,
`.pi-image`, `.pi-image-thumbnail`, `.pi-caption`, `.pi-header`, `.pi-group`,
`.pi-data`, `.pi-data-label`, `.pi-data-value`, `.pi-navigation`, plus the
modifiers `.pi-theme-*`, `.pi-layout-*`, `.pi-collapse[-open|-closed]`,
`.pi-horizontal-group` and Fandom's styling hooks `.pi-item`, `.pi-item-spacing`,
`.pi-background`, `.pi-border-color`, `.pi-font`, `.pi-secondary-font`,
`.pi-secondary-background`. A `<data>` and a `<title>` also carry
`data-source="…"`, as Fandom's do, so scripts and styles can address one field.

**No colors, no inline styles are emitted** (theme.md): the classes are the whole
contract, and the theme owns every token.

#### F.1.8 Divergences from Fandom

| # | Divergence |
|---|---|
| **F-1** | `<panel>` and `<section>` (Fandom's tabbed/legacy containers) render as plain `<group>`s — the rows are all reachable, but there is no tab strip. |
| **F-2** | `<format>` is not applied to a `<default>` value. Fandom's renderer behaves this way; it is stated here because it is the one rule most easily read the other way. |
| **F-3** | `show="incomplete"` keeps a group's empty rows *and* the group. Fandom documents only "display the group when its content is incomplete"; keeping the labelled empty rows is the reading that makes the attribute useful, and it is the behavior tested. |
| **F-4** | Malformed markup degrades instead of failing: an unknown or misplaced tag stays verbatim wikitext, an unclosed element runs to the end of the block (§10), a stray close tag is literal text. A broken infobox must never break the page. |

### F.2 Fandom tags and table behavior

Fandom's tag vocabulary and table behavior. Implemented in `src/lib/wikitext/fandom-tags.ts`
(pure parsing + HTML shapes), wired into stage 6 in `render.ts`, registered as extension tags in
`preprocessor.ts` (`FANDOM_CONTENT_EXT_TAGS`), and styled in `src/app/globals.css`. Additive
throughout: the §15 corpus is untouched, and `<gallery>`'s existing §10.4 behavior is unchanged
for every attribute not listed below.

#### F.2.1 `<tabber>` — tab groups

A **content** extension tag (§10.1): its body is stripped in stage 2 and becomes wikitext again in
stage 6, so templates and parser functions inside a panel expand normally.

Two accepted syntaxes:

| Form | Shape |
|---|---|
| Legacy (Fandom's own) | `Title=` opens a tab; `\|-\|` separates tabs |
| Element | `<tab name="Title">…</tab>`, repeated |

The element form wins whenever the body contains a well-formed `<tab>…</tab>`.

Legacy parsing rules:

- The body is split on `|-|`. Each chunk's **first non-blank line** may be a title line: everything
  before the first `=`, containing none of `` \n = { } [ ] | < > ``.
- The tight character class is load-bearing. It is what stops `{{tpl|a=b}}`, `[[File:X|a=b]]` or
  `==Heading==` on a panel's first line from being read as a tab title.
- A chunk with no title line is **appended to the previous tab**. That is what makes the compact
  spelling `Title=|-|body|-|Next=|-|body` parse identically to the conventional multi-line form.
- A leading blank line is dropped before the title is matched (the conventional form puts a newline
  after every `|-|`).
- An unnamed `<tab>` is titled `Tab {n}` positionally rather than dropped.
- A body yielding zero tabs renders **nothing** — never an empty widget.

Panel content is parsed as a **block** fragment (stages 3–5 on the shared render state), so a panel
may contain headings, lists and tables. Because the state is shared, refs raised inside a panel join
the page-wide numbering and land in the page's `<references />` (§10.3), and heading ids stay unique.

Rendered shape — three siblings per tab, in document order:

```html
<div class="tabber">
  <input class="tabber-input" type="radio" name="tabber-{uid}" id="tabber-{uid}-{n}" checked>
  <label class="tabber-tabs tabber-tab" for="tabber-{uid}-{n}">Title</label>
  <section class="tabber-panel" aria-label="Title">…panel HTML…</section>
  …
</div>
```

- **No JavaScript is required.** The active panel is selected by
  `.tabber-input:checked + .tabber-tab + .tabber-panel`, so every panel is reachable server-side.
  The adjacent-sibling chain needs no `:has()`, no per-index CSS and no upper bound on tab count;
  `order:` on the flex container lifts the labels into a row above the panels.
- The radio stays focusable (visually hidden, never `display: none`), so the tab strip keeps native
  radio-group keyboard behavior.
- `{uid}` comes from a per-page counter (`RenderState.tabberSeq`), so two tabbers on one page are
  independent radio groups.
- Only the first tab is `checked`.

#### F.2.2 `<poem>`

A content extension tag. Line breaks are preserved **and the body stays wikitext**: each newline
becomes `<br />`, so links, apostrophe markup, entities and refs inside a poem still parse.

- Leading indentation becomes `&nbsp;` (one per space, a tab counting as eight). This is what stops
  a leading space from triggering the §3.2 space-pre rule and turning a verse into a `<pre>` block.
- Interior blank lines survive as empty verses.
- `<poem class="x">` appends `x` to the wrapper's class.
- Output: `<div class="poem">…</div>`.

#### F.2.3 `<gallery>` options

Extends §10.4 with Fandom's/MediaWiki's full attribute vocabulary. Unknown enum values fall back to
the default rather than erroring.

| Attribute | Values | Effect |
|---|---|---|
| `mode` | `traditional` (default), `packed`, `nolines` | Adds `mw-gallery-{mode}` to the `<ul>` |
| `widths` | `N` or `Npx` (default 120) | Bounding width for each thumbnail |
| `heights` | `N` or `Npx` (default 120) | Bounding height |
| `spacing` | `small`, `medium`, `large` | Adds `mw-gallery-spacing-{v}` |
| `captionalign` | `left`, `center`, `right` | Adds `mw-gallery-captionalign-{v}` |
| `position` | `left`, `center`, `right` | Adds `mw-gallery-position-{v}` |
| `caption` | text | Leading `<li class="gallerycaption">` |
| `class` | tokens | Appended verbatim to the `<ul>` class list |
| `hideaddbutton` | any | **Accepted and ignored** (it only ever controlled Fandom's "add a photo" button) |

The default class list is unchanged from §10.4 (`gallery mw-gallery-traditional`); an optional class
is appended **only** when its attribute was actually given, so existing expectations still hold.

Each thumbnail is scaled by `min(widths/w₀, heights/h₀, 1)` — a bounding box, never an upscale.

Per-item options after the first pipe:

| Option | Meaning |
|---|---|
| `alt=…` | `alt` attribute (default: the file name) |
| `link=Title` | Link the image at an article or, with an allowed scheme, an external URL |
| `link=` (empty) | Render the image **unlinked** |
| anything else | Caption — parsed as **wikitext**, and pipes beyond the first rejoin into it |

The `File:`/`Image:` prefix is optional. A blank or file-less line is skipped. A missing file
red-links (§5.8) instead of emitting a broken `<img>`. Because captions are resolved in stage 6, a
`<ref>` inside one registers in document order and reaches the page's `<references />` (gap G3).

#### F.2.4 Sortable tables

A **client-side** behavior, not an engine change: the parser already passes `class="sortable"`
through (§7.2 attribute filtering), and the island in
`src/components/wiki/sortable-table.tsx` hydrates any `table.sortable` inside `.wiki-prose`. It is
mounted once from `src/components/wiki-html.tsx`. Recognized on any table whose class list contains
`sortable` — `wikitable sortable` and `sortable fandom-table` both qualify.

Progressive enhancement: the island stamps `.sortable-ready` on the table when it hydrates, and
globals.css hangs every affordance (cursor, sort arrows) off that class, so a reader without
JavaScript is never shown a control that does nothing.

**Bail-out rules** (the table is left exactly as rendered, with no error):

- `class="unsortable"` on the table.
- Any `rowspan` or `colspan` anywhere in the table — reordering rows under a merged cell would
  visibly corrupt it, so "row N, column C" must be unambiguous.
- No all-`<th>` header row, or fewer than two data rows.
- `class="unsortable"` on a single `<th>` excludes just that column.

**Interaction**: activating a header cycles `none → ascending → descending → none`, where `none`
restores the original row order captured at hydration time. Headers get
`role="columnheader button"` + `tabindex="0"` (MediaWiki's pairing: the cell keeps its table
semantics and is also announced as activatable) and respond to click, `Enter` and `Space`.
`aria-sort` carries the state and is the CSS hook, so the two can never disagree; at most one header
is ever non-`none`.

**Sort keys**: a cell's `data-sort-value` attribute wins if present (the MediaWiki convention, and
the escape hatch for dates); otherwise the cell's rendered text is used, so `[[Robot toy|Robot Toy]]`
sorts as `Robot Toy`.

**Comparator** (`compareCells`, pure and exported for testing). Values are ranked
**number → text → blank**, then compared within a rank:

- *Numeric* — a cell whose **leading** token is a number, after an optional run of
  comparison/currency glyphs (`~ ≈ < > ≤ ≥ ± + -`, `$ € £ ¥`). Thousands separators and decimals are
  understood, and everything after the number is ignored. This is what sorts the real cell strings
  `4.73%`, `56▮`, `21 lb`, `$1,234.50` and `0 - 9 (avg. 3)` numerically.
- A number that does **not** start the cell (`Version 50`) is deliberately *not* numeric: those are
  names, and sorting them by an embedded digit would scramble a text column.
- *Text* — `Intl.Collator` with `sensitivity: "base"` (case/accent-insensitive) and `numeric: true`,
  so `Level 9` precedes `Level 10`.
- Whitespace is collapsed and trimmed first (including `&nbsp;`), so the fixture's `| No` and `|No`
  compare equal.
- Ties break by original position, making the sort **stable** in both directions.

### F.3 Images, interlanguage links, reference ordering, behavior switches

Covers engine gaps G1–G4 and the Fandom behavior switches (G6). All of it is additive: the §15 corpus is untouched, and every construct not named here keeps its §5/§10 behavior exactly.

#### F.3.1 Image size options (§5.9 resize group)

The `resize` row of the §5.9 option table is now honored end-to-end (it was parsed and then discarded). Grammar, matched case-insensitively after trimming, with whitespace around the `x` tolerated as MediaWiki does:

| Parameter | Meaning |
|---|---|
| `{N}px` | Requested **width**; height scales to preserve the aspect ratio. |
| `x{N}px` | Requested **height**; width scales. |
| `{W}x{H}px` | **Bounding box**: `scale = min(W/w₀, H/h₀)`, applied to both axes. |
| `upright` | Width = `thumbDefaultWidth × uprightDefaultFactor` (§0.4; 220 × 0.75). |
| `upright={factor}` | Width = `thumbDefaultWidth × factor`. |

Resolution rules:

- The size is computed in stage 6 against the natural dimensions from `PageStore.getFile()`. A requested size larger than the natural one is still emitted verbatim — MediaWiki emits the requested `width`/`height` and lets the client scale, so `[[File:A.png|1100px]]` on an 800×600 file gives `width="1100" height="825"`.
- Within the group the **last** matching parameter wins (§5.9), and `{W}x{H}px` clears a previously-set single axis (and vice versa), so mixed spellings cannot produce a half-set box.
- `frame` **ignores** the whole resize group (§5.9 format row) — the natural dimensions are emitted.
- Rounding is round-half-up to an integer px, floored at 1.
- A parameter that *looks* like a size but is not one (`12ab px`, `x px`) matches nothing and therefore falls through to the §5.9 "last unmatched parameter becomes the caption" rule — no warning, no size.
- Sizes apply to **thumb and non-thumb alike**. A sized non-thumb image stays inline inside its paragraph (no `<figure>`); only `thumb`/`frame` get figure chrome, whose `style="width:{w+2}px"` uses the *computed* width.

Every image path emits explicit `width` and `height` attributes, which is what lets the browser reserve layout space (no layout shift) for Fandom-style articles.

#### F.3.2 Interlanguage links — swallowed into `meta.languageLinks`

A link whose prefix is a **language code** is page metadata, not output — exactly like `[[Category:…]]` (§5.10):

```wikitext
[[ru:Artifice]]
```

renders **nothing** and contributes `{ lang: "ru", title: "Artifice" }` to the new additive `PageMeta.languageLinks?: LanguageLink[]` field (types.ts §14.10).

- The prefix set is a **frozen list** in `links.ts` (`LANGUAGE_CODES`): the assigned ISO 639-1 two-letter codes plus the script/region variants and non-639-1 wiki codes Fandom and Wikimedia actually use as link prefixes (`zh-hans`, `pt-br`, `be-tarask`, `simple`, `nds`, …). MediaWiki drives this from the interwiki table; hqhq-wiki has no interwiki table, so the list is normative here. Matching is case-insensitive on the prefix only.
- **A namespace always wins** (§5.8): a prefix that is a known namespace or alias is never a language link, so `[[File:X]]` is unaffected. A prefix that is neither a namespace nor a language code keeps its §5.8 behavior — it is just text before a colon, so `[[Guide:X]]` and `[[Map:X]]` still link to main-namespace pages literally named that.
- The remainder after the colon is **not** put through §5.7 title normalization: it names a page on a different wiki.
- The escaped form `[[:ru:Artifice]]` renders **as an ordinary link**, the same MediaWiki rule that makes `[[:Category:X]]` a link (§5.8).
- Duplicates (same `lang` + `title`) are recorded once.
- A line containing nothing but interlanguage links (and/or category links) and whitespace produces **no output line at all** — the §5.10 rule now covers both kinds of swallowed metadata link.

#### F.3.3 Reference ordering with deferred content (§10.3)

**Problem.** `<ref>` tags inside content that is rendered *late* — a `<gallery>` caption, a file/thumb caption, any extension payload restored at §14.8 marker-restoration time — registered **after** an explicit `<references />` had already flushed. The result was a spurious second, auto-appended list plus a bogus "missing `<references />`" maintenance note.

**Rule.** A `<references />` list is rendered **after every deferred content region on the page has been resolved**, so the registry is complete when any list is emitted. Concretely, stage 6 restoration is two passes:

1. **Pass 1** restores all strip markers (§14.8), iterating until none remain. Ref registration from gallery captions, thumb captions and other extension payloads happens here. Each `<references />` emits a *placeholder marker* that pass 1 deliberately leaves untouched.
2. **Pass 2** replaces those placeholders, left to right, each flushing its group from the now-complete registry.

Consequences, all normative:

- A page with one `<references />` produces **exactly one** `<ol class="references">`, containing every ref on the page including gallery-caption refs.
- The list appears **where the tag was written**, not at the end of the page.
- Nothing is pending after pass 2, so no `<div class="mw-ref-warning">` is emitted when the tag is present.
- Numbering is still **in-text usage order** (§10.3); a deferred ref simply takes the number its position earns.
- With no `<references />` at all, the §10.3 auto-append (with its maintenance note) is unchanged.
- Multiple `<references />` for the same group keep §10.3 semantics: the first flush empties the group, so later ones render empty.

#### F.3.4 Red-link class — one spelling

Every red link, from every code path (inline `[[…]]`, template-produced links, file/image red links, gallery error items), renders identically:

```html
<a href="/wiki/Missing_page?redlink=1" class="new red-link" title="Missing page (page does not exist)">…</a>
```

`new` is MediaWiki's class (so ported stylesheets work); `red-link` is ours (theme.md tokens key off it). The `?redlink=1` href (`config.redLinkPath`) and the `title="… (page does not exist)"` suffix (`config.messages.redLinkTitleSuffix`, Addendum A3) are unchanged. This supersedes the bare `class="new"` shown in the §5.11 example 2.

#### F.3.5 Fandom behavior switches and `{{DEFAULTSORT:}}`

Added to the §2.6 table (recognized, removed from output, recorded in `meta.behaviorSwitches`; the app layer decides what each means):

| Switch | Note |
|---|---|
| `__NOWYSIWYG__` | Fandom: disable the visual editor on this page. |
| `__NOGALLERY__` | On a category page: list members without thumbnails. |
| `__EXPECTUNUSEDCATEGORY__` | Suppress the "unused category" maintenance report. |
| `__STATICREDIRECT__` | Keep this redirect's target when the target is moved. |
| `__HIDDENCAT__` | Already in §2.6; listed for completeness. |

Unknown `__WORD__` sequences remain **literal text** (§2.6) — the switch list is closed. Removal still happens before block parsing, and a line left empty by the removal produces no paragraph.

`{{DEFAULTSORT:key}}` (aliases `{{DEFAULTSORTKEY:}}`, `{{DEFAULTCATEGORYSORT:}}`) expands to nothing and sets the page-wide category sort key:

- Every `[[Category:X]]` **without** an explicit `|sortkey` gets `sortKey = key`; an explicit sort key still wins (§5.10).
- Position-independent: it applies to category links written before *and* after it, because expansion (§14.3) completes before any category link is scanned (§14.6).
- The last one on the page wins; a conflicting redefinition emits a warning.
- An empty key (`{{DEFAULTSORT:}}`) clears it.
- Recorded as the additive `PageMeta.defaultSort?: string`.

### F.4 Source editor: display tokenizer and snippet vocabulary

The Fandom-style source editor (`src/components/wiki/editor.tsx` and children)
adds **no grammar**. It adds two client-side readers of the grammar, both
dependency-free and both non-normative — the parser in `src/lib/wikitext/**`
remains the only authority on what anything *means*.

#### F.4.1 `highlight()` — a display tokenizer (`src/lib/wikitext-highlight.ts`)

`highlight(source)` returns a flat `HighlightToken[]` used to paint the editor's
`<pre>` mirror. Two invariants, both tested:

1. **Lossless** — `highlight(s).map((t) => t.text).join("") === s` for every
   input, including the reference fixture
   `docs/engine/fixtures/fandom-artifice.wikitext`. This is what lets the mirror
   sit exactly under a transparent `<textarea>`.
2. **Total** — it terminates on any input; unbalanced `[[`, `{{`, `<nowiki>`,
   `{|` and friends degrade to plain text rather than throwing.

It recognizes, by span only: §1.1 `'''`/`''` markers, §2 heading `=` runs,
§3.4 `----`, §4 `*`/`#`/`:`/`;` line markers, §5 `[[…|…]]` targets, pipes and
labels, §6.2 external links, §7 `{|`/`|-`/`|+`/`|`/`!`/`||`/`!!`/`|}`,
§8 `{{…}}` and `{{{…}}}` with their separators, §10 extension tags — `<ref>`,
`<gallery>`, `<references/>`, `<nowiki>`, `<pre>`, `<syntaxhighlight>` and the
Fandom `<infobox>` / `<tabber>` blocks plus this wiki's version tags, whose
NAME is their range (`<v70>`, `<v70+v80>`, `<v70+>` — versioning.md §2.1), with
raw-text bodies kept opaque — and §11 comments and
character references. Link and external-link frames are dropped at a newline
(links never span lines, §5.1) while template and parameter frames survive one,
because a Fandom infobox call is written one parameter per line.

Markup tokens are emitted **one delimiter per token**; only `text` and
`link-label` runs coalesce. That is what lets two small readers walk the same
stream structurally, with no second parser:

- `templatesUsed(source)` — unique `{{Template}}` names in first-use order,
  skipping parser functions (`{{#…}}`, §9), magic words (`{{PAGENAME}}`) and
  anything inside a comment or a raw-text tag.
- `categoriesUsed` / `addCategory` / `removeCategory` — the `[[Category:X|sort]]`
  memberships (§5.6) the editor rail shows as chips. `addCategory` appends at the
  bottom, joining an existing category block when there is one; matching is
  case-insensitive and tolerant of `_`/space, as §5.7 normalization is.

#### F.4.2 Snippets the Insert menu writes

The toolbar emits wikitext only — never localized, never a new construct. The
Fandom-specific skeletons it offers are the ones the sections above specify:
`<infobox>` (portable infobox, with `<title>`/`<image>`/`<group>`/`<header>`/
`<data source>`/`<label>`/`<default>`), `<tabber>` with `|-|Name=` panes,
`<gallery>` with `File:…|Caption` lines. A version tag is not among them: its
name carries a range (versioning.md §2.1), so Insert → Version block opens the
dialog that asks for one instead of dropping a skeleton to be edited by hand.
Toolbar buttons apply pure transforms over the textarea
selection (`src/lib/editor-selection.ts`); the emphasis, heading, list, indent
and unlink transforms are defined against §1.1, §2, §4, §5.1 and §6.2
respectively.
