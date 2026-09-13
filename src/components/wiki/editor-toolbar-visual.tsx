"use client";

/**
 * **What visual mode can insert, and the exact bytes each insertion writes.**
 *
 * This file used to be the fixed toolbar of docs/engine/visual-editor.md §1 —
 * a row of dropdowns above the writing area. The user's 2026-09-04 direction
 * replaced that interaction model with Notion's, so the row is gone and the
 * two things it really owned stayed:
 *
 * - **the wikitext snippets**, which the source toolbar still wraps around a
 *   selection (`editor-toolbar-source.tsx` imports them from here, which is
 *   also why this module keeps its now-inaccurate name), and
 * - **the catalogue** of everything that row offered, which
 *   {@link visualSlashItems} now hands to the slash menu
 *   (`ve-slash-menu.tsx`). One list, so retiring the toolbar could not quietly
 *   drop a construct: every entry of `INSERT ▾`, `CITE ▾`, `NORMAL TEXT ▾`,
 *   `T ▾`, the list and indent buttons, link, media and the character grid is
 *   a row of it.
 *
 * The catalogue has since outgrown that toolbar in both directions
 * (2026-09-06). It **gained** the constructs no button ever had — a definition
 * list, a category, an external link, `<nowiki>`, a code block, a comment — and
 * the five block commands that were only ever reachable with a pointer; and it
 * **loses**, at the caret, the rows that would do nothing there, which is what
 * {@link VeSlashBlock} and `changesNothing` are for.
 *
 * The toolbar owned no document and neither does this: an item carries one
 * `VisualAction` (src/lib/visual-editor/actions.ts) and the surface that holds
 * the caret applies it. Nothing here knows where the caret is — the two
 * *contextual* parts of the catalogue (the table's twelve operations, the
 * page's named references) arrive as arguments, exactly as they used to arrive
 * as props.
 *
 * Wikitext is not localized, so snippets are raw strings and only a row's name
 * comes from the dictionary; a snippet's own placeholder words ("Source",
 * "Cell") are content the author is expected to overwrite. That is also why
 * every row's `keywords` are the **wikitext it writes** (`##`, `*`, `[[`,
 * `----`): a marker is the same string in every language, so an author who
 * knows the wikitext can type it and find the block, and no second dictionary
 * of synonyms has to be kept in step with the first.
 *
 * Grammar references are to docs/engine/wikitext-spec.md: §1.1 emphasis,
 * §2 headings, §4 lists, §5 links/files, §7 tables, §8 templates, §10 extension
 * tags (`<ref>`, `<references>`, `<gallery>`, and the Fandom `<infobox>` /
 * `<tabber>` blocks); the version tag is versioning.md §2.1.
 */

import type { ReactNode } from "react";

import {
  BoldIcon,
  BulletListIcon,
  CalendarIcon,
  CategoryIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClearFormattingIcon,
  CodeIcon,
  CommentIcon,
  DuplicateIcon,
  GalleryIcon,
  HeadingIcon,
  IndentIcon,
  InfoboxIcon,
  InsertBelowIcon,
  ItalicIcon,
  LinkIcon,
  MediaIcon,
  NowikiIcon,
  NumberListIcon,
  OmegaIcon,
  OutdentIcon,
  ParagraphIcon,
  QuoteIcon,
  RuleIcon,
  StrikethroughIcon,
  SubscriptIcon,
  SuperscriptIcon,
  TableIcon,
  TabsIcon,
  TemplateIcon,
  TrashIcon,
  UnderlineIcon,
  VersionsIcon,
  tableOpIcon,
} from "@/components/wiki/editor-icons";
import type { BlockHandleLabels } from "@/components/wiki/ve-block-handle";
import type { SlashItem } from "@/components/wiki/ve-slash-menu";
import { TABLE_OPS, tableOpLabel, type VeTableLabels } from "@/components/wiki/ve-table";
import { formatMessage } from "@/lib/i18n";
import type {
  VeBlockCommand,
  VeBlockFormat,
  VeTableContext,
  VisualAction,
} from "@/lib/visual-editor/actions";
import { refExcerpt, refReuseWikitext, type NamedRef } from "@/lib/wikitext-refs";

/* ------------------------------------------------------------------ */
/* Snippets (wikitext — never localized)                               */
/* ------------------------------------------------------------------ */

/**
 * A construct the source toolbar wraps around the selection and the slash menu
 * inserts whole. Keeping the caret split (`before` | `placeholder` | `after`)
 * here is what lets both modes emit the *same* wikitext while the textarea
 * still lands the caret on the word the author will retype.
 */
export interface EditorSnippet {
  before: string;
  placeholder: string;
  after: string;
}

/** The snippet as one string — what an atomic node in the visual surface gets. */
export function snippetText(snippet: EditorSnippet): string {
  return snippet.before + snippet.placeholder + snippet.after;
}

/** Fandom's portable-infobox block (spec §10, "Fandom extensions"). */
export const INFOBOX_SNIPPET = `<infobox>
  <title source="title"><default>{{PAGENAME}}</default></title>
  <image source="image"><caption source="caption"/></image>
  <group>
    <header>Details</header>
    <data source="type"><label>Type</label></data>
    <data source="difficulty"><label>Difficulty</label></data>
  </group>
</infobox>`;

export const GALLERY_SNIPPET = `<gallery>
File:Example.png|Caption
File:Example2.png|Caption
</gallery>`;

export const TABBER_SNIPPET = `<tabber>
|-|Tab 1=
First tab body.
|-|Tab 2=
Second tab body.
</tabber>`;

// Nor a version snippet: the slash menu's Version block raises
// { kind: "versions" } and the dialog writes the tag for the versions the
// author picked (visual-editor.md §5.3).

export const RULE_SNIPPET = "----";

export const TABLE_SNIPPET: EditorSnippet = {
  before: '{| class="wikitable"\n! Header 1 !! Header 2\n|-\n| ',
  placeholder: "Cell",
  after: " || Cell\n|}",
};

// There is deliberately no template snippet: Template raises
// { kind: "template" } and the dialog writes the call (visual-editor.md §5.1).
// An author never types braces.

/** A bare footnote, and the same one given a reusable name. */
export const REF_SNIPPET: EditorSnippet = {
  before: "<ref>",
  placeholder: "Source",
  after: "</ref>",
};

export const REF_NAMED_SNIPPET: EditorSnippet = {
  before: '<ref name="source">',
  placeholder: "Source",
  after: "</ref>",
};

/** Where the footnotes are printed; a block of its own, like `----`. */
export const REFERENCES_SNIPPET = "<references />";

/* — the constructs the retired toolbar never had a button for (added 2026-09-06
   by user: "slash에 기능 좀 더 추가") —

   Each is wikitext the engine already parses; none of them was reachable from
   the visual surface at all, which is what made them worth adding rather than
   the fifty others a wiki can spell. Two deliberate omissions, and both for the
   reason the same direction gave for hiding "Normal text": `<br>` is what
   Shift+Enter already writes, and `#REDIRECT` is only ever a page's first line —
   a row that wrote one into the middle of an article would be a row whose only
   use is a mistake. */

/** `; term : definition` — spec §4.3's same-line split, the third list marker. */
export const DEFINITION_SNIPPET: EditorSnippet = {
  before: "; ",
  placeholder: "Term",
  after: " : Definition",
};

/** Spec §5.10. A category is an atomic chip, wherever in the page it is put. */
export const CATEGORY_SNIPPET: EditorSnippet = {
  before: "[[Category:",
  placeholder: "Name",
  after: "]]",
};

/** Spec §6.2's labelled form — the one an article wants; a bare URL needs no row. */
export const EXTERNAL_LINK_SNIPPET: EditorSnippet = {
  before: "[https://example.com ",
  placeholder: "Label",
  after: "]",
};

/** Spec §10.1. The same bytes the source toolbar's `T ADVANCED ▾` wraps with. */
export const NOWIKI_SNIPPET: EditorSnippet = {
  before: "<nowiki>",
  placeholder: "text",
  after: "</nowiki>",
};

/** Spec §10.5. `lang` is left for the author: only they know what the code is. */
export const CODE_SNIPPET: EditorSnippet = {
  before: '<syntaxhighlight lang="">\n',
  placeholder: "code",
  after: "\n</syntaxhighlight>",
};

/** A note to other editors, which the reader never sees (spec §10.8). */
export const COMMENT_SNIPPET: EditorSnippet = {
  before: "<!-- ",
  placeholder: "note",
  after: " -->",
};

/**
 * The rows that cite a source the page already cites — one per named ref in
 * the buffer (`namedRefsUsed`, src/lib/wikitext-refs.ts), which is the
 * citation an author makes every time after the first.
 *
 * They are built here, from a list the editor island hands both modes, so the
 * two offer the same sources under the same names and insert the
 * byte-identical construct — the same reason the snippets above are shared.
 * The row reads as the footnote itself (its wikitext, elided) with the name
 * beside it, because "which source is this" is the question being asked and a
 * bare `name=` rarely answers it. An empty list adds no rows and no heading: a
 * page with no named references simply does not offer this.
 */
export interface CiteReuseRow {
  /** `<ref name="…" />` — what choosing the row inserts. */
  source: string;
  /** What the row reads: the footnote, or its name when the page only reuses it. */
  label: string;
  /** The identity Cite keys on, shown beside the label. */
  hint: string;
}

export function citeReuseRows(refs: readonly NamedRef[]): CiteReuseRow[] {
  return refs.map((ref) => {
    const excerpt = refExcerpt(ref.body);
    return {
      source: refReuseWikitext(ref),
      label: excerpt === "" ? ref.name : excerpt,
      // A group is half the identity (spec §10.3), so a row in one has to say
      // so — otherwise two footnotes called "x" read as one row twice.
      hint: ref.group === "" ? ref.name : `${ref.name} · ${ref.group}`,
    };
  });
}

/**
 * The special characters: dashes and rules, arrows, math relations,
 * typographic quotes, and the block glyph the Lethal Company wiki uses for
 * stat bars.
 */
export const SPECIAL_CHARACTERS = [
  "—", "–", "‑", "·", "•", "…", "×", "÷",
  "±", "≤", "≥", "≠", "≈", "∞", "°", "′",
  "←", "→", "↑", "↓", "↔", "⇒", "✓", "✗",
  "▮", "▯", "★", "☆", "†", "§", "¶", "№",
  "“", "”", "‘", "’", "«", "»", "½", "¼",
];

/** Signature-less: articles are never signed, but a dated note is common. */
export function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* The catalogue                                                       */
/* ------------------------------------------------------------------ */

/**
 * Every user-visible string a slash row can carry. It is the retired
 * toolbar's label bag with the trigger names removed: a menu that comes to the
 * caret has no `INSERT ▾` to name, and the panel's own two strings (its
 * heading and its no-match line) are `SlashMenuLabels`, which the surface
 * passes straight through.
 */
export interface VeSlashLabels {
  formatParagraph: string;
  formatHeading: string;
  /** "{level}" = 1…3, rendered as h3…h5 — how deep, not which tag. */
  formatSubHeading: string;
  formatPre: string;
  bulletList: string;
  numberedList: string;
  indentMore: string;
  indentLess: string;
  link: string;
  media: string;
  gallery: string;
  table: string;
  template: string;
  infobox: string;
  versions: string;
  tabber: string;
  rule: string;
  date: string;
  citeBasic: string;
  citeNamed: string;
  citeList: string;
  /** The six constructs the toolbar never had a button for (2026-09-06). */
  definitionList: string;
  category: string;
  externalLink: string;
  nowiki: string;
  codeBlock: string;
  comment: string;
  bold: string;
  italic: string;
  underline: string;
  strikethrough: string;
  superscript: string;
  subscript: string;
  code: string;
  clearFormatting: string;
  /**
   * The second line under every character row, and the one word that finds
   * them all: a glyph cannot be searched for in a language, so this is what an
   * author types to reach the whole grid.
   */
  specialCharacter: string;
}

/**
 * What the caret's own block already is, and what can still be done to it.
 *
 * It exists to keep rows that would do **nothing** out of the list (user
 * direction, 2026-09-06: "normal같이 기본적으로 가능한거는 안뜨게"). "Normal
 * text" chosen in a paragraph, "Heading" chosen in that heading, "Decrease
 * indent" at the left margin and "Move up" on the first block are all a row
 * the author can pick and watch not happen — and the commonest of them is the
 * commonest case there is, because "/" is pressed in an empty paragraph.
 *
 * A *report*, like `VeTableContext`: the surface owns the caret and answers
 * this; the catalogue draws from it and decides nothing. `null` means "no
 * block to ask about", and then nothing is hidden — the header's Insert menu
 * offers no format rows anyway, and a menu that hid rows on a guess would be
 * worse than one that shows a row too many.
 */
export interface VeSlashBlock {
  /**
   * The format the block already has, or null where the format rows cannot
   * say — a list, a table, a chip. Null hides nothing, which is right: a list
   * *can* be turned into a paragraph, and that row must stay.
   */
  format: VeBlockFormat | null;
  /** There is indentation to take away. */
  canOutdent: boolean;
  /** There is a block above / below to trade places with (§3.1). */
  canMoveUp: boolean;
  canMoveDown: boolean;
}

/** What the caret's surroundings add to, or take out of, the catalogue. */
export interface VeSlashInput {
  labels: VeSlashLabels;
  /** Named refs the buffer already carries — the "cite again" rows. */
  refs: readonly NamedRef[];
  /**
   * The caret is in a table **cell**, where a cell holds inline content and
   * nothing else (spec §7.3): a heading or a list made in one is a table the
   * model then has to refuse, so the block rows are simply not offered there.
   */
  inCell: boolean;
  /** The table the caret is standing in, or null — its twelve operations. */
  table: VeTableContext | null;
  /** Their names, the same bag the axis menus draw from (§3.2). */
  tableLabels: VeTableLabels;
  /** The caret's own block: what it already is, and what it can be given. */
  block: VeSlashBlock | null;
  /**
   * The gutter menu's names, for the five block rows — the same bag, for the
   * same reason `tableLabels` is: the grip's menu, the right-click menu and
   * these rows are three roads to one command, and a second dictionary would
   * be a second way for them to disagree about what it is called.
   */
  blockLabels: BlockHandleLabels;
}

/** One row, plus the fact that decides whether a cell may have it. */
interface Row {
  key: string;
  label: string;
  hint?: string;
  keywords?: readonly string[];
  icon: ReactNode;
  action: VisualAction;
  /** Safe inside a table cell: it writes inline content, or nothing at all. */
  inline: boolean;
  /**
   * A row the retired `INSERT ▾` / `CITE ▾` menus held — something the author
   * *adds* to the page, as opposed to a format they turn the current block
   * into, a mark, or a character.
   *
   * A flag on the row rather than a list of keys kept beside it: the header's
   * Insert menu ({@link visualInsertItems}) and the slash menu draw from this
   * one array, and a list of keys is a second place for a renamed row to be
   * quietly dropped from one of them.
   */
  insert?: true;
}

/**
 * The slash menu's items, in the order an empty query shows them.
 *
 * The order is editorial and it is the one thing this function decides: blocks
 * first, because "/" is pressed at the start of an empty paragraph more often
 * than anywhere else; then the constructs `INSERT ▾` held; then citations;
 * then the character styles, which are here for completeness rather than for
 * reaching — the bubble menu and `Ctrl+B`/`I`/`U` are the way to those; and
 * last the character grid, which is forty rows and must not push the blocks
 * off the top of the list.
 */
function catalogueRows(input: VeSlashInput): Row[] {
  const { labels, refs, blockLabels } = input;
  const block = input.block ?? null;
  const rows: Row[] = [
    // — what NORMAL TEXT ▾ offered (spec §2) —
    {
      key: "paragraph",
      label: labels.formatParagraph,
      icon: <ParagraphIcon />,
      action: { kind: "format", format: "paragraph" },
      inline: false,
    },
    {
      key: "h2",
      label: labels.formatHeading,
      keywords: ["==", "##"],
      icon: <HeadingIcon />,
      action: { kind: "format", format: "h2" },
      inline: false,
    },
    {
      key: "h3",
      label: formatMessage(labels.formatSubHeading, { level: 1 }),
      keywords: ["===", "###"],
      icon: <HeadingIcon />,
      action: { kind: "format", format: "h3" },
      inline: false,
    },
    {
      key: "h4",
      label: formatMessage(labels.formatSubHeading, { level: 2 }),
      keywords: ["====", "####"],
      icon: <HeadingIcon />,
      action: { kind: "format", format: "h4" },
      inline: false,
    },
    {
      key: "h5",
      label: formatMessage(labels.formatSubHeading, { level: 3 }),
      keywords: ["=====", "#####"],
      icon: <HeadingIcon />,
      action: { kind: "format", format: "h5" },
      inline: false,
    },
    {
      key: "bullet",
      label: labels.bulletList,
      keywords: ["*", "-"],
      icon: <BulletListIcon />,
      action: { kind: "list", list: "bullet" },
      inline: false,
    },
    {
      key: "number",
      label: labels.numberedList,
      keywords: ["#", "1."],
      icon: <NumberListIcon />,
      action: { kind: "list", list: "number" },
      inline: false,
    },
    {
      // The third list marker (spec §4.1), and the one with no button anywhere
      // in the retired toolbar: `;`/`:` is how a wiki writes a glossary, and
      // the only road to one was typing it. It is `wikitext` rather than
      // `insert` because the model *understands* a definition list — a chip
      // would be the editor refusing to read its own markup.
      key: "deflist",
      label: labels.definitionList,
      keywords: ["; ", ": ", ";"],
      icon: <BulletListIcon />,
      action: { kind: "wikitext", source: snippetText(DEFINITION_SNIPPET), block: true },
      inline: false,
      insert: true,
    },
    {
      key: "indent",
      label: labels.indentMore,
      keywords: [":", ">"],
      icon: <IndentIcon />,
      action: { kind: "indent", delta: 1 },
      inline: false,
    },
    {
      key: "outdent",
      label: labels.indentLess,
      icon: <OutdentIcon />,
      action: { kind: "indent", delta: -1 },
      inline: false,
    },
    {
      key: "pre",
      label: labels.formatPre,
      icon: <CodeIcon />,
      action: { kind: "format", format: "pre" },
      inline: false,
    },

    // — what INSERT ▾ offered (spec §5, §7, §8, §10; versioning.md §2) —
    // Link, media, template and the version block open the island's dialogs,
    // as the toolbar's buttons did; none of them writes braces or brackets by
    // hand, which is the whole point of those flows (§5.1, §5.2, §5.3).
    {
      key: "link",
      label: labels.link,
      keywords: ["[["],
      icon: <LinkIcon />,
      action: { kind: "link" },
      inline: true,
      insert: true,
    },
    {
      key: "media",
      label: labels.media,
      keywords: ["[[File:"],
      icon: <MediaIcon />,
      action: { kind: "media" },
      inline: true,
      insert: true,
    },
    {
      key: "template",
      label: labels.template,
      keywords: ["{{"],
      icon: <TemplateIcon />,
      action: { kind: "template" },
      inline: true,
      insert: true,
    },
    {
      key: "table",
      label: labels.table,
      keywords: ["{|"],
      icon: <TableIcon />,
      action: { kind: "insert", source: snippetText(TABLE_SNIPPET), block: true },
      inline: false,
      insert: true,
    },
    {
      key: "gallery",
      label: labels.gallery,
      keywords: ["<gallery>"],
      icon: <GalleryIcon />,
      action: { kind: "insert", source: GALLERY_SNIPPET, block: true },
      inline: false,
      insert: true,
    },
    {
      key: "infobox",
      label: labels.infobox,
      keywords: ["<infobox>"],
      icon: <InfoboxIcon />,
      action: { kind: "insert", source: INFOBOX_SNIPPET, block: true },
      inline: false,
      insert: true,
    },
    {
      key: "versions",
      label: labels.versions,
      keywords: ["<v"],
      icon: <VersionsIcon />,
      action: { kind: "versions" },
      // **Offered inside a cell**, unlike every other block-shaped construct
      // here. A version tag is an ordinary extension tag (versioning.md §2.1)
      // and its whole point is that it works anywhere the wikitext does —
      // "inside tables, list items, infobox parameters" is the first sentence
      // of §2, and `{{#ifversion:}}` is documented "for use inside templates
      // and table cells". Scoping one number of a table to a patch is the
      // commonest reason to reach for it at all, so a cell was the one place
      // the menus refused to offer the feature its own spec is about.
      // `insertAtomic` writes it inline there (spec §7.3), which is how the
      // tag is spelled in a cell anyway.
      inline: true,
      insert: true,
    },
    {
      key: "tabber",
      label: labels.tabber,
      keywords: ["<tabber>"],
      icon: <TabsIcon />,
      action: { kind: "insert", source: TABBER_SNIPPET, block: true },
      inline: false,
      insert: true,
    },
    {
      key: "rule",
      label: labels.rule,
      keywords: [RULE_SNIPPET],
      icon: <RuleIcon />,
      action: { kind: "insert", source: RULE_SNIPPET, block: true },
      inline: false,
      insert: true,
    },
    // — the constructs no toolbar button ever had (2026-09-06) —
    {
      key: "category",
      label: labels.category,
      keywords: ["[[Category:"],
      icon: <CategoryIcon />,
      // A category is an atomic chip wherever it is written (parse.ts), so it
      // goes in as one — but not into a cell, where a chip on its own line is
      // a table the model then has to refuse.
      action: { kind: "insert", source: snippetText(CATEGORY_SNIPPET), block: true },
      inline: false,
      insert: true,
    },
    {
      key: "extlink",
      label: labels.externalLink,
      keywords: ["[http", "[https"],
      icon: <LinkIcon />,
      // Content, not a chip: an external link is markup the model reads, and
      // the caret has to be able to walk into the label and retype it. The
      // link dialog can write one too — this is the road that needs no dialog.
      action: { kind: "wikitext", source: snippetText(EXTERNAL_LINK_SNIPPET) },
      inline: true,
      insert: true,
    },
    {
      key: "nowiki",
      label: labels.nowiki,
      keywords: ["<nowiki>"],
      icon: <NowikiIcon />,
      action: { kind: "insert", source: snippetText(NOWIKI_SNIPPET), block: false },
      inline: true,
      insert: true,
    },
    {
      key: "codeblock",
      label: labels.codeBlock,
      keywords: ["<syntaxhighlight>", "<source>"],
      icon: <CodeIcon />,
      action: { kind: "insert", source: snippetText(CODE_SNIPPET), block: true },
      inline: false,
      insert: true,
    },
    {
      key: "comment",
      label: labels.comment,
      keywords: ["<!--"],
      icon: <CommentIcon />,
      action: { kind: "insert", source: snippetText(COMMENT_SNIPPET), block: false },
      inline: true,
      insert: true,
    },
    {
      key: "date",
      label: labels.date,
      // Evaluated as the row is built, so the stamp is the day the menu was
      // opened rather than the day the page was loaded.
      icon: <CalendarIcon />,
      action: { kind: "insert", source: todayStamp(), block: false },
      inline: true,
      insert: true,
    },

    // — what CITE ▾ offered (spec §10) —
    {
      key: "cite-basic",
      label: labels.citeBasic,
      keywords: ["<ref>"],
      icon: <QuoteIcon />,
      action: { kind: "insert", source: snippetText(REF_SNIPPET), block: false },
      inline: true,
      insert: true,
    },
    {
      key: "cite-named",
      label: labels.citeNamed,
      keywords: ['<ref name="'],
      icon: <QuoteIcon />,
      action: { kind: "insert", source: snippetText(REF_NAMED_SNIPPET), block: false },
      inline: true,
      insert: true,
    },
    {
      key: "cite-list",
      label: labels.citeList,
      keywords: [REFERENCES_SNIPPET],
      icon: <QuoteIcon />,
      action: { kind: "insert", source: REFERENCES_SNIPPET, block: true },
      inline: false,
      insert: true,
    },
  ];

  // The one citation that matters after the first: a source the page already
  // cites (spec §10.3's reuse form). Nothing is added at all for a page with
  // no named refs — which is also the state the toolbar's menu drew nothing in.
  citeReuseRows(refs).forEach((row, index) => {
    rows.push({
      key: `cite-reuse-${index}`,
      label: row.label,
      hint: row.hint,
      keywords: [row.hint],
      icon: <QuoteIcon />,
      action: { kind: "insert", source: row.source, block: false },
      inline: true,
      insert: true,
    });
  });

  // — what B, I and T ▾ offered (spec §1.1) —
  // Here for completeness rather than for reaching: a selection gets the
  // bubble menu and the caret gets Ctrl+B/I/U. Superscript, subscript and
  // "clear formatting" have no other home at a collapsed caret, which is why
  // the whole group is listed rather than only those three.
  const marks: readonly { key: string; label: string; icon: ReactNode; action: VisualAction }[] = [
    { key: "bold", label: labels.bold, icon: <BoldIcon />, action: { kind: "mark", mark: "bold" } },
    {
      key: "italic",
      label: labels.italic,
      icon: <ItalicIcon />,
      action: { kind: "mark", mark: "italic" },
    },
    {
      key: "underline",
      label: labels.underline,
      icon: <UnderlineIcon />,
      action: { kind: "mark", mark: "underline" },
    },
    {
      key: "strike",
      label: labels.strikethrough,
      icon: <StrikethroughIcon />,
      action: { kind: "mark", mark: "strike" },
    },
    {
      key: "sup",
      label: labels.superscript,
      icon: <SuperscriptIcon />,
      action: { kind: "mark", mark: "sup" },
    },
    {
      key: "sub",
      label: labels.subscript,
      icon: <SubscriptIcon />,
      action: { kind: "mark", mark: "sub" },
    },
    { key: "code", label: labels.code, icon: <CodeIcon />, action: { kind: "mark", mark: "code" } },
    {
      key: "clear",
      label: labels.clearFormatting,
      icon: <ClearFormattingIcon />,
      action: { kind: "clearFormatting" },
    },
  ];
  for (const mark of marks) rows.push({ ...mark, inline: true });

  // — the five block commands (§3.1, §14) —
  // Added 2026-09-06 (user: "slash에 기능 좀 더 추가"). Two of them had a
  // keyboard already (`Ctrl+D`, `Alt+Arrow`) and three had none at all: the
  // grip's menu and the right-click menu are both pointer affordances, so
  // "delete this block" was a control half the readers of this wiki could not
  // reach. They are here rather than at the top because they act on a block
  // that already exists, and "/" is pressed to make one.
  //
  // Below the marks, above the character grid, and never inside a cell: a
  // "block" in a table is the whole table (§3 — a block is a direct child of
  // the root), so deleting or duplicating one from inside a cell would be a
  // row that ate the table the author was typing in.
  const commands: readonly { key: string; label: string; icon: ReactNode; command: VeBlockCommand }[] = [
    {
      key: "insert-below",
      label: blockLabels.insertBelow,
      icon: <InsertBelowIcon />,
      command: { kind: "insertBelow" },
    },
    {
      key: "duplicate",
      label: blockLabels.duplicate,
      icon: <DuplicateIcon />,
      command: { kind: "duplicate" },
    },
    {
      key: "move-up",
      label: blockLabels.moveUp,
      icon: <ChevronUpIcon />,
      command: { kind: "move", direction: "up" },
    },
    {
      key: "move-down",
      label: blockLabels.moveDown,
      icon: <ChevronDownIcon />,
      command: { kind: "move", direction: "down" },
    },
    {
      key: "delete-block",
      label: blockLabels.delete,
      icon: <TrashIcon />,
      command: { kind: "delete" },
    },
  ];
  for (const row of commands) {
    rows.push({
      key: `block-${row.key}`,
      label: row.label,
      icon: row.icon,
      action: { kind: "block", command: row.command },
      inline: false,
    });
  }

  // — what the character grid offered —
  // The glyph is its own label, because a character is not a word in any
  // language; the localized noun rides underneath it and is the keyword that
  // finds the whole grid at once.
  for (const character of SPECIAL_CHARACTERS) {
    rows.push({
      key: `char-${character}`,
      label: character,
      hint: labels.specialCharacter,
      keywords: [labels.specialCharacter],
      icon: <OmegaIcon />,
      action: { kind: "text", text: character },
      inline: true,
    });
  }

  return rows.filter((row) => !changesNothing(row.action, block));
}

/**
 * Whether this row, chosen at this caret, would leave the page exactly as it
 * is (user direction, 2026-09-06).
 *
 * Only the four questions the surface can answer for certain, and each of them
 * is a row an author can pick and watch do nothing: the format the block
 * already has, an outdent at the left margin, and a move off either end of the
 * document. A toggle is **not** on the list — "List" in a list turns it off,
 * which is a change and often the one that was wanted — and neither is a mark
 * or a construct, which do something wherever they are chosen.
 *
 * With no block to ask about, nothing is hidden: see {@link VeSlashBlock}.
 */
function changesNothing(action: VisualAction, block: VeSlashBlock | null): boolean {
  if (block === null) return false;
  switch (action.kind) {
    case "format":
      return action.format === block.format;
    case "indent":
      return action.delta === -1 && !block.canOutdent;
    case "block":
      if (action.command.kind !== "move") return false;
      return action.command.direction === "up" ? !block.canMoveUp : !block.canMoveDown;
    default:
      return false;
  }
}

/** A catalogue row as the menus consume it. */
function toItem(row: Row): SlashItem {
  return {
    key: row.key,
    label: row.label,
    hint: row.hint,
    keywords: row.keywords,
    icon: row.icon,
    action: row.action,
  };
}

/**
 * The rows the editor header's **Insert** menu shows — what `INSERT ▾` and
 * `CITE ▾` held, and nothing else.
 *
 * The slash menu is the fast road to these and stays the whole catalogue; this
 * is the road an author finds without being told there is one. It is
 * deliberately the short list: a dropdown cannot be typed at, so the forty
 * special characters and the marks (which have the bubble menu and
 * `Ctrl+B`/`I`/`U`) would only bury the ten constructs somebody opened it for.
 *
 * `inCell` prunes it the same way it prunes the slash menu: a cell holds inline
 * content and nothing else (spec §7.3), so a table or a gallery made in one is
 * a table the model then has to refuse.
 */
export function visualInsertItems(input: VeSlashInput): SlashItem[] {
  const rows = catalogueRows(input).filter((row) => row.insert === true);
  return (input.inCell ? rows.filter((row) => row.inline) : rows).map(toItem);
}

export function visualSlashItems(input: VeSlashInput): SlashItem[] {
  const { inCell, table, tableLabels } = input;
  const rows = catalogueRows(input);
  const items: SlashItem[] = (inCell ? rows.filter((row) => row.inline) : rows).map(toItem);

  // The twelve table operations, first, and only where there is a table to
  // apply them to. They are the keyboard's whole way to a table edit now that
  // the toolbar's `TABLE ▾` is gone (visual-editor.md §3.2): the axis menus
  // beside a table are a pointer affordance, and a control only a pointer can
  // reach is a control half the readers of this wiki do not have. An operation
  // the caret's cell cannot be given is left out rather than listed disabled —
  // a list that filters as you type has no room for rows that refuse.
  if (table === null) return items;
  const ops: SlashItem[] = TABLE_OPS.filter((op) => table.can[op]).map((op) => ({
    key: `table-${op}`,
    label: tableOpLabel(op, tableLabels, table.headerRow),
    keywords: ["{|"],
    icon: tableOpIcon(op),
    action: { kind: "table", op },
  }));
  return [...ops, ...items];
}
