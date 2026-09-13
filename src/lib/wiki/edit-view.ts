/**
 * Editor data loader + label builder, shared by the two routes that mount the
 * wikitext editor:
 *
 * - `/{locale}/edit/[...title]` — the canonical edit URL (routes.md), and
 * - the missing-page branch of `/{locale}/wiki/[...title]`, because
 *   **creating a page is just visiting its URL** (decisions-v2 **O14.1**).
 *
 * Both call `loadEditorView`, so a title nobody has written yet produces the
 * *same* editor state whichever URL the visitor arrived at (O14.6): the title
 * parsed from the URL, an empty source, no parent revision, and a heading that
 * reads as creation.
 *
 * Normative sources:
 * - docs/engine/decisions-v2.md O14 (create-by-visiting), O12 (URL scheme)
 * - docs/engine/decisions.md O1 (`$1` = nsPrefix + slug), O4 (translate flow)
 * - docs/engine/versioning.md §6 (`?v=` propagation)
 */

import "server-only";

import type { EditorLabels } from "@/components/wiki/editor";
import type { VeTableLabels } from "@/components/wiki/ve-table";
import type { WikiDb } from "@/lib/db/client";
import { getPageSource } from "@/lib/db/queries";
import type { Namespace } from "@/lib/db/schema";
import { loadVersionTable } from "@/lib/db/store";
import { formatMessage, type Dictionary, type Locale } from "@/lib/i18n";
import { articleHref, titlePathSegment } from "@/lib/locale-path";
import {
  humanizeSlug,
  parseTitle,
  pathToTitle,
  slugifyTitle,
  type StorableNamespace,
} from "@/lib/title";

/* ------------------------------------------------------------------ */
/* Title resolution (decisions O1)                                     */
/* ------------------------------------------------------------------ */

export interface EditorTitle {
  namespace: Namespace;
  nsName: StorableNamespace;
  slug: string;
  /** The `$1` catch-all segment: `nsPrefix + encodeURIComponent(slug)`. */
  titlePath: string;
}

/** The `[...title]` catch-all → a storable (namespace, slug); null ⇒ 404. */
export function resolveEditTitle(segments: string | string[]): EditorTitle | null {
  const parsed = pathToTitle(segments);
  if (!parsed) return null;
  const slug = slugifyTitle(parsed.slug) || parsed.slug.toLowerCase();
  return {
    namespace: parsed.nsName as Namespace,
    nsName: parsed.nsName,
    slug,
    titlePath: titlePathSegment(parsed.nsName, slug),
  };
}

/** "template" + "Infobox moon" → "Template:Infobox moon" ({{PAGENAME}}). */
export function previewTitleFor(nsName: StorableNamespace, title: string): string {
  if (nsName === "main") return title;
  return `${nsName.charAt(0).toUpperCase()}${nsName.slice(1)}:${title}`;
}

/* ------------------------------------------------------------------ */
/* The loader                                                          */
/* ------------------------------------------------------------------ */

export interface EditorViewInput {
  db: WikiDb;
  locale: Locale;
  /** The `[...title]` catch-all value. */
  segments: string | string[];
  /** `?v=` — carried into the preview dropdown and the save destination. */
  version?: string | null;
}

export interface EditorView {
  title: EditorTitle;
  /** Display title for this locale; humanized from the slug when unwritten. */
  displayTitle: string;
  /** Full page name used for `{{PAGENAME}}` in previews. */
  previewTitle: string;
  initialContent: string;
  /** Head revision the source came from — null when the page is being created. */
  parentRevId: number | null;
  /** EN head a new translation is based on (decisions O4), else null. */
  translatedFromRevId: number | null;
  /** True when this locale already has a head ⇒ "Editing", not "Creating". */
  exists: boolean;
  /** O4: the buffer was prefilled from the EN head. */
  translatingFromEn: boolean;
  /** EN title the translation notice names, when translating. */
  enTitle: string | null;
  versions: { id: string; label: string }[];
  defaultVersion: string;
  /** `?v=`, kept only when it names a registered version (versioning.md §6). */
  selectedVersion: string | null;
}

/**
 * Source + version registry for one title in one locale. Returns null only
 * when the catch-all does not resolve to a storable title (the route 404s).
 *
 * A title with no head in this locale is the create case: empty buffer, null
 * parent. The one exception is decisions O4's translate flow — a non-EN locale
 * whose EN head exists prefills from EN and records the basis revision.
 */
export function loadEditorView(input: EditorViewInput): EditorView | null {
  const { db, locale } = input;
  const title = resolveEditTitle(input.segments);
  if (!title) return null;

  const source = getPageSource(db, {
    namespace: title.namespace,
    slug: title.slug,
    locale,
  });
  const exists = Boolean(source?.pageLocale?.currentRevId && source.revision);

  const enSource =
    !exists && locale !== "en"
      ? getPageSource(db, { namespace: title.namespace, slug: title.slug, locale: "en" })
      : null;
  const translatingFromEn = Boolean(enSource?.revision);

  const displayTitle =
    source?.pageLocale?.title ?? enSource?.pageLocale?.title ?? humanizeSlug(title.slug);

  const versionTable = loadVersionTable(db);
  const requested = input.version?.trim().toLowerCase() || null;

  return {
    title,
    displayTitle,
    previewTitle: previewTitleFor(title.nsName, displayTitle),
    initialContent: exists ? (source?.revision?.content ?? "") : (enSource?.revision?.content ?? ""),
    parentRevId: source?.pageLocale?.currentRevId ?? null,
    translatedFromRevId: translatingFromEn ? (enSource?.pageLocale?.currentRevId ?? null) : null,
    exists,
    translatingFromEn,
    enTitle: translatingFromEn ? (enSource?.pageLocale?.title ?? displayTitle) : null,
    versions: versionTable.ordered.map((version) => ({ id: version.id, label: version.label })),
    defaultVersion: versionTable.defaultId,
    selectedVersion: requested && versionTable.byId[requested] ? requested : null,
  };
}

/* ------------------------------------------------------------------ */
/* Labels                                                              */
/* ------------------------------------------------------------------ */

/** "Editing X" / "Creating X" — O14.1 wants a heading that reads as creation. */
export function editorHeading(dict: Dictionary, view: EditorView): string {
  return formatMessage(view.exists ? dict.editor.editingTitle : dict.editor.creatingTitle, {
    title: view.displayTitle,
  });
}

/**
 * The whole `EditorLabels` bag from one dictionary. Both editor routes build
 * it here so they cannot drift apart.
 */
export function editorLabels(dict: Dictionary, view: EditorView): EditorLabels {
  const e = dict.editor;
  // The table operations are named once and handed to both controls that offer
  // them — the floating strip beside a table and the toolbar's table menu
  // (visual-editor.md §3.2). Two bags would let the two drift, and an author
  // who learns "Insert row below" from a tooltip has to find those same words
  // in the menu.
  // The six block formats, named once and handed to both controls that offer
  // to turn a block into one — the gutter handle's menu and the bubble menu.
  // Keyed by `VeBlockFormat` as a plain string map, because a dictionary must
  // not have to import the model's union to fill it.
  const blockFormats: Record<string, string> = {
    paragraph: e.toolbarFormatParagraph,
    h2: e.toolbarFormatHeading,
    // The dictionary numbers sub-headings from 1 and the model from h3: an
    // author is told how deep the heading sits, not which tag it becomes.
    h3: formatMessage(e.toolbarFormatSubHeading, { level: 1 }),
    h4: formatMessage(e.toolbarFormatSubHeading, { level: 2 }),
    h5: formatMessage(e.toolbarFormatSubHeading, { level: 3 }),
    pre: e.toolbarFormatPre,
  };
  const tableLabels: VeTableLabels = {
    insertRowAbove: e.tableInsertRowAbove,
    insertRowBelow: e.tableInsertRowBelow,
    moveRowUp: e.tableMoveRowUp,
    moveRowDown: e.tableMoveRowDown,
    deleteRow: e.tableDeleteRow,
    insertColumnLeft: e.tableInsertColumnLeft,
    insertColumnRight: e.tableInsertColumnRight,
    moveColumnLeft: e.tableMoveColumnLeft,
    moveColumnRight: e.tableMoveColumnRight,
    deleteColumn: e.tableDeleteColumn,
    headerRowOn: e.tableHeaderRowOn,
    headerRowOff: e.tableHeaderRowOff,
    deleteTable: e.tableDelete,
  };
  return {
    eyebrow: view.exists ? e.eyebrowEdit : e.eyebrowCreate,
    title: view.displayTitle,
    contentLabel: e.contentLabel,
    lineNumbers: e.lineNumbers,
    summaryLabel: e.summaryLabel,
    summaryPlaceholder: e.summaryPlaceholder,
    minorEdit: e.minorEdit,
    publish: e.publishShort,
    saving: e.saving,
    cancel: dict.common.cancel,
    saveFailed: e.saveFailed,

    // §8 — the two defences against losing an edit. The draft's wording is the
    // editor's own; the dialog's verbs borrow the site's generic ones, as the
    // version bar's confirmation does.
    draftTitle: e.draftTitle,
    draftFound: e.draftFound,
    draftStale: e.draftStale,
    draftStaleNew: e.draftStaleNew,
    draftRestore: e.draftRestore,
    draftDiscard: e.draftDiscard,
    discardTitle: e.discardTitle,
    discardBody: e.discardBody,
    discardConfirm: e.discardConfirm,
    discardKeep: e.discardKeep,
    close: dict.common.close,

    licenseNotice: e.licenseNotice,
    signInRequiredTitle: e.signInRequiredTitle,
    signInRequiredDescription: e.signInRequiredDescription,
    signInCta: dict.common.signIn,
    translatingNotice: view.translatingFromEn
      ? formatMessage(e.translatingFrom, {
          locale: "en",
          title: view.enTitle ?? view.displayTitle,
        })
      : null,
    headerCollapse: e.headerCollapse,
    headerExpand: e.headerExpand,
    fullscreenEnter: e.fullscreenEnter,
    fullscreenExit: e.fullscreenExit,
    railToggle: e.railToggle,

    mode: {
      menuLabel: e.modeMenuLabel,
      visualPill: e.modeVisualPill,
      sourcePill: e.modeSourcePill,
      visual: e.modeVisual,
      source: e.modeSource,
      userGuide: e.modeUserGuide,
      shortcuts: e.modeShortcuts,
    },

    // Visual mode's `INSERT ▾`, back above the writing area. Its rows are the
    // slash menu's own (`labels.visual.slashItems` names them), so only the
    // trigger and the "nothing applies here" line are new.
    insertMenu: {
      title: e.toolbarInsert,
      empty: e.slashEmpty,
    },

    sourceToolbar: {
      toolbarLabel: e.toolbarLabel,
      undo: e.toolbarUndo,
      redo: e.toolbarRedo,
      bold: e.toolbarBold,
      italic: e.toolbarItalic,
      underline: e.toolbarUnderline,
      strikethrough: e.toolbarStrikethrough,
      link: e.toolbarLink,
      unlink: e.toolbarUnlink,
      media: e.toolbarMedia,
      gallery: e.toolbarGallery,
      template: e.toolbarTemplate,
      insert: e.toolbarInsert,
      insertGallery: e.toolbarGallery,
      insertTable: e.toolbarTable,
      insertTemplate: e.toolbarTemplate,
      insertInfobox: e.toolbarInfobox,
      insertVersions: e.toolbarVersions,
      insertTabber: e.toolbarTabber,
      insertRule: e.toolbarRule,
      insertDate: e.toolbarDate,
      cite: e.toolbarCite,
      citeBasic: e.toolbarCiteBasic,
      citeNamed: e.toolbarCiteNamed,
      citeList: e.toolbarCiteList,
      citeReuse: e.toolbarCiteReuse,
      specialCharacters: e.toolbarSpecialCharacters,
      advanced: e.toolbarAdvanced,
      heading: e.toolbarHeading,
      headingParagraph: e.toolbarHeadingParagraph,
      headingLevel: e.toolbarHeadingLevel,
      bulletList: e.toolbarList,
      numberedList: e.toolbarNumberedList,
      indent: e.toolbarIndent,
      nowiki: e.toolbarNowiki,
      comment: e.toolbarComment,
      redirect: e.toolbarRedirect,
      help: e.syntaxHelpTitle,
      more: e.toolbarMore,
    },

    visual: {
      surfaceLabel: e.visualLabel,
      placeholder: e.visualPlaceholder,
      slashHint: e.visualSlashHint,
      rendering: e.visualRendering,
      renderedEmpty: e.visualRenderedEmpty,
      loadError: e.visualLoadError,
      edit: e.atomicEdit,
      remove: e.atomicRemove,
      kinds: {
        template: e.atomicTemplate,
        table: e.atomicTable,
        infobox: e.atomicInfobox,
        gallery: e.atomicGallery,
        tabber: e.atomicTabber,
        versions: e.atomicVersions,
        media: e.atomicMedia,
        category: e.atomicCategory,
        comment: e.atomicComment,
        pre: e.atomicPre,
        redirect: e.atomicRedirect,
        html: e.atomicHtml,
        nowiki: e.atomicNowiki,
        ref: e.atomicRef,
        magic: e.atomicMagic,
        unknown: e.atomicUnknown,
      },
      // §6's in-place passage field. Its wording is the editor's own, not the
      // `version.*` bag the chip row shares with the article: the article has
      // no field to name a version in, and this one is about *writing* a
      // passage rather than about which one is being read.
      contextMenu: e.visualContextMenu,
      branchHeading: e.versionBranchLabel,
      branchMissing: e.versionBranchMissing,
      branchElsewhere: e.versionBranchElsewhere,
      // §1's four Notion-shaped controls. Every string the surface can draw
      // now arrives through one of these four bags — there is no toolbar left
      // to carry any of them.
      handle: {
        add: e.blockHandleAdd,
        grip: e.blockHandleGrip,
        menu: e.blockHandleMenu,
        insertBelow: e.blockInsertBelow,
        duplicate: e.blockDuplicate,
        delete: e.blockDelete,
        // §3.1's two moves keep their names, because the menu row, the drag
        // and `Alt+Arrow` are one action: a reader who learns the wording from
        // the shortcuts table finds it again in the menu.
        moveUp: e.blockMoveUp,
        moveDown: e.blockMoveDown,
        turnInto: e.blockTurnInto,
        formats: blockFormats,
      },
      bubble: {
        toolbarLabel: e.bubbleLabel,
        bold: e.toolbarBold,
        italic: e.toolbarItalic,
        underline: e.toolbarUnderline,
        strikethrough: e.toolbarStrikethrough,
        code: e.toolbarCode,
        link: e.toolbarLink,
        clearFormatting: e.toolbarClearFormatting,
        // The same word as the handle's heading: one name for one act, drawn
        // in two places.
        turnInto: e.blockTurnInto,
        formats: blockFormats,
      },
      slashMenu: {
        title: e.slashTitle,
        empty: e.slashEmpty,
      },
      // §13's two panels. They share the slash panel's component and therefore
      // its label shape; only the heading tells the author which index they
      // are looking at, which is why there are two bags and not one.
      mentionPage: {
        title: e.mentionPageTitle,
        empty: e.mentionEmpty,
        loading: e.mentionLoading,
      },
      mentionTemplate: {
        title: e.mentionTemplateTitle,
        empty: e.mentionEmpty,
        loading: e.mentionLoading,
      },
      // The retired toolbar's whole list, under the retired toolbar's own
      // names: an author who learned "Sub-heading 1" from the dropdown finds
      // that row and no synonym for it.
      slashItems: {
        formatParagraph: e.toolbarFormatParagraph,
        formatHeading: e.toolbarFormatHeading,
        formatSubHeading: e.toolbarFormatSubHeading,
        formatPre: e.toolbarFormatPre,
        bulletList: e.toolbarList,
        numberedList: e.toolbarNumberedList,
        indentMore: e.toolbarIndentMore,
        indentLess: e.toolbarIndentLess,
        link: e.toolbarLink,
        media: e.toolbarMedia,
        gallery: e.toolbarGallery,
        table: e.toolbarTable,
        template: e.toolbarTemplate,
        infobox: e.toolbarInfobox,
        versions: e.toolbarVersions,
        tabber: e.toolbarTabber,
        rule: e.toolbarRule,
        date: e.toolbarDate,
        citeBasic: e.toolbarCiteBasic,
        citeNamed: e.toolbarCiteNamed,
        citeList: e.toolbarCiteList,
        // The six the toolbar never had a row for (2026-09-06). Two of them
        // borrow the *source* toolbar's names, because `T ADVANCED ▾` writes
        // the same bytes and one construct may not have two names.
        definitionList: e.slashDefinitionList,
        category: e.slashCategory,
        externalLink: e.slashExternalLink,
        nowiki: e.toolbarNowiki,
        codeBlock: e.slashCodeBlock,
        comment: e.toolbarComment,
        bold: e.toolbarBold,
        italic: e.toolbarItalic,
        underline: e.toolbarUnderline,
        strikethrough: e.toolbarStrikethrough,
        superscript: e.toolbarSuperscript,
        subscript: e.toolbarSubscript,
        code: e.toolbarCode,
        clearFormatting: e.toolbarClearFormatting,
        specialCharacter: e.slashSpecialCharacter,
      },
      // §3.2's controls. `table` is the SAME object the slash menu's
      // contextual rows are built from: the axis menus and those rows are two
      // ways into one set of operations, and two label bags would be two ways
      // for them to drift.
      tableControlsLabel: e.tableControlsLabel,
      tableColumnMenu: e.tableColumnMenu,
      tableRowMenu: e.tableRowMenu,
      table: tableLabels,
      tableDeleteTitle: e.tableDeleteTitle,
      tableDeleteBody: e.tableDeleteBody,
      tableDeleteLastRowBody: e.tableDeleteLastRowBody,
      tableDeleteLastColumnBody: e.tableDeleteLastColumnBody,
      tableDeleteConfirm: e.tableDeleteConfirm,
      tableHeaderRefusedTitle: e.tableHeaderRefusedTitle,
      tableHeaderRefusedBody: e.tableHeaderRefusedBody,
      // Why a refused table is a chip (§2). The reasons are the parser's own
      // (`VeTableRefusal`), so the chip names the construct rather than
      // shrugging — and the keys are exhaustive, so a thirteenth refusal is a
      // compile error rather than an empty sentence.
      tableRefusedWhy: e.tableRefusedWhy,
      tableRefusals: {
        "not-a-table": e.tableRefusalNotATable,
        indented: e.tableRefusalIndented,
        unclosed: e.tableRefusalUnclosed,
        "trailing-content": e.tableRefusalTrailingContent,
        "nested-table": e.tableRefusalNestedTable,
        "fostered-content": e.tableRefusalFosteredContent,
        "cell-continuation": e.tableRefusalCellContinuation,
        "caption-continuation": e.tableRefusalCaptionContinuation,
        "caption-attrs": e.tableRefusalCaptionAttrs,
        "second-caption": e.tableRefusalSecondCaption,
        "no-rows": e.tableRefusalNoRows,
        "not-a-fixed-point": e.tableRefusalNotAFixedPoint,
      },
      dialogCancel: dict.common.cancel,
      dialogClose: dict.common.close,
    },

    atomicDialogTitle: e.atomicDialogTitle,
    atomicDialog: {
      // The island expands atomicDialogTitle with the kind name before handing
      // this over; the raw string here is only the fallback.
      title: e.atomicDialogTitle,
      hint: e.atomicDialogHint,
      apply: e.atomicApply,
      close: dict.common.close,
    },

    template: {
      titleInsert: e.templateInsertTitle,
      titleEdit: e.templateEditTitle,
      searchLabel: e.templateSearchLabel,
      searchPlaceholder: e.templateSearchPlaceholder,
      searchEmpty: e.templateSearchEmpty,
      loading: dict.common.loading,
      back: e.templateBack,
      required: e.templateRequired,
      documented: e.templateDocumented,
      parametersEmpty: e.templateParametersEmpty,
      addParameter: e.templateAddParameter,
      addParameterPlaceholder: e.templateAddParameterPlaceholder,
      add: e.templateAdd,
      removeParameter: e.templateRemoveParameter,
      previewLabel: e.templatePreview,
      insert: e.templateInsert,
      apply: e.templateApply,
      editSource: e.templateEditSource,
      failed: e.templateFailed,
      close: dict.common.close,
    },

    media: {
      title: e.mediaTitle,
      tabUpload: e.mediaTabUpload,
      tabLibrary: e.mediaTabLibrary,
      dropHint: e.mediaDropHint,
      choose: e.mediaChoose,
      uploading: e.mediaUploading,
      librarySearch: e.mediaLibrarySearch,
      libraryEmpty: e.mediaLibraryEmpty,
      loading: dict.common.loading,
      captionLabel: e.mediaCaptionLabel,
      captionPlaceholder: e.mediaCaptionPlaceholder,
      layoutLabel: e.mediaLayoutLabel,
      layoutThumb: e.mediaLayoutThumb,
      layoutFrameless: e.mediaLayoutFrameless,
      layoutFull: e.mediaLayoutFull,
      alignLabel: e.mediaAlignLabel,
      alignRight: e.mediaAlignRight,
      alignLeft: e.mediaAlignLeft,
      alignCenter: e.mediaAlignCenter,
      alignNone: e.mediaAlignNone,
      widthLabel: e.mediaWidthLabel,
      insert: e.mediaInsert,
      close: dict.common.close,
      tooLarge: e.mediaTooLarge,
      badType: e.mediaBadType,
      badName: e.mediaBadName,
      failed: e.mediaFailed,
      replaceWarning: e.mediaReplaceWarning,
    },

    versions: {
      title: e.versionDialogTitle,
      titleEdit: e.versionDialogEditTitle,
      intro: e.versionDialogIntro,
      versionLabel: e.versionPickLabel,
      fromLabel: e.versionRangeFrom,
      toLabel: e.versionRangeTo,
      pickPrompt: e.versionPickPrompt,
      modeLabel: e.versionModeLabel,
      modeOnly: e.versionModeOnly,
      modeWindow: e.versionModeWindow,
      modeSince: e.versionModeSince,
      bodyLabel: e.versionBodyLabel,
      bodyPlaceholder: e.versionBodyPlaceholder,
      previewLabel: e.versionPreview,
      insert: e.versionInsert,
      apply: e.versionApply,
      allEmpty: e.versionAllEmpty,
      inverted: e.versionRangeInverted,
      close: dict.common.close,
      failed: e.versionFailed,
      invalidId: e.versionInvalidId,
      // versioning.md §1 defines exactly these three; the article selector
      // already translates them, so the dialog reuses that wording.
      status: {
        current: dict.version.current,
        supported: dict.version.supported,
        legacy: dict.version.archived,
      },
      picker: {
        placeholder: e.versionPickerPlaceholder,
        listLabel: e.versionPickerList,
        empty: e.versionPickerEmpty,
        loading: dict.common.loading,
        create: e.versionPickerCreate,
        createHint: e.versionPickerCreateHint,
      },
    },

    linkDialog: {
      title: e.linkDialogTitle,
      target: e.linkTarget,
      targetPlaceholder: e.linkTargetPlaceholder,
      text: e.linkText,
      apply: e.linkApply,
      remove: e.toolbarUnlink,
      close: dict.common.close,
      // The autocomplete's own wording. The verdict lines are the editor's,
      // not the search page's: `search.*` names what a reader is looking for,
      // and these two say what the link an author is about to write will BE.
      suggestions: e.linkSuggestions,
      existingPage: e.linkExistingPage,
      newPage: e.linkNewPage,
    },

    /**
     * §9's strip. Its wording is the editor's own rather than the site's
     * generic verbs: "Replace" here is a buffer edit over one match, not the
     * `common.*` word a dialog's confirm button carries.
     */
    find: {
      title: e.findTitle,
      find: e.findLabel,
      replace: e.findReplaceLabel,
      previous: e.findPrevious,
      next: e.findNext,
      matchCase: e.findMatchCase,
      wholeWord: e.findWholeWord,
      count: e.findCount,
      noResults: e.findNoResults,
      replaceOne: e.findReplaceOne,
      replaceAll: e.findReplaceAll,
      context: e.findContext,
      close: dict.common.close,
    },

    shortcuts: {
      title: e.shortcutsTitle,
      action: e.shortcutsAction,
      keys: e.shortcutsKeys,
      close: dict.common.close,
      bold: e.toolbarBold,
      italic: e.toolbarItalic,
      underline: e.toolbarUnderline,
      // §10.2's heading bindings, under the format menu's own names — the two
      // controls do the same thing and must not have two vocabularies.
      formatParagraph: e.toolbarFormatParagraph,
      formatHeading: e.toolbarFormatHeading,
      formatSubHeading1: formatMessage(e.toolbarFormatSubHeading, { level: 1 }),
      formatSubHeading2: formatMessage(e.toolbarFormatSubHeading, { level: 2 }),
      formatSubHeading3: formatMessage(e.toolbarFormatSubHeading, { level: 3 }),
      link: e.toolbarLink,
      // The same string names the strip and its shortcut row: an author who
      // learns "Find and replace" from the table finds that name on the panel.
      find: e.findTitle,
      undo: e.toolbarUndo,
      redo: e.toolbarRedo,
      publish: e.shortcutsPublishRow,
      moveUp: e.blockMoveUp,
      moveDown: e.blockMoveDown,
      tableNextCell: e.shortcutsTableNextCell,
      tablePreviousCell: e.shortcutsTablePreviousCell,
      tableLineBreak: e.shortcutsTableLineBreak,
      // The one binding the retired toolbar's disappearance made essential:
      // "/" is now how an author reaches every construct (§1).
      slashMenu: e.shortcutsSlashMenu,
      mention: e.shortcutsMention,
      // The gutter menu's own name for the row, so the shortcut and the row
      // are visibly one act (§14).
      duplicate: e.blockDuplicate,
    },

    // §10.1: the outline is a card of the page-tools column, not a section of
    // the rail, so its labels are the island's rather than the rail's.
    outline: {
      title: e.outlineTitle,
      empty: e.outlineEmpty,
      untitled: e.outlineUntitled,
      moveUp: e.outlineMoveUp,
      moveDown: e.outlineMoveDown,
    },
    countWords: e.countWords,
    countCharacters: e.countCharacters,

    rail: {
      title: e.railTitle,
      collapse: e.railCollapse,
      expand: e.railExpand,
      insertSection: e.railInsert,
      templatesSection: e.railTemplates,
      templatesEmpty: e.railTemplatesEmpty,
      categoriesSection: e.railCategories,
      categoriesEmpty: e.railCategoriesEmpty,
      categoryPlaceholder: e.railCategoryPlaceholder,
      categoryAdd: e.railCategoryAdd,
      categoryRemove: e.railCategoryRemove,
      tagsPicker: {
        placeholder: e.tagPickerPlaceholder,
        listLabel: e.tagPickerList,
        empty: e.tagPickerEmpty,
        loading: dict.common.loading,
        create: e.tagPickerCreate,
        createHint: e.tagPickerCreateHint,
      },
      settingsSection: e.railSettings,
      settingsLocale: e.railSettingsLocale,
      settingsVersion: e.railSettingsVersion,
      settingsParentRev: e.railSettingsParentRev,
      settingsNewPage: e.railSettingsNewPage,
    },
    railQuickActions: {
      file: e.toolbarImage,
      ref: e.toolbarReference,
      template: e.toolbarTemplate,
      table: e.toolbarTable,
    },

    /**
     * The §6 branch selector, above the editing surface in both modes. What
     * the row itself prints comes from `version.*` — the same keys the article
     * header's chips print, because the editor's control IS the reader's
     * control and two bags of wording for one row is how they drift apart.
     * Only the editor-only half (the X, and the confirmation behind it) adds
     * keys, and its buttons borrow the site's generic verbs.
     */
    versionBar: {
      chips: {
        heading: dict.version.boundaries,
        unregistered: dict.version.unregistered,
        remove: dict.version.remove,
        register: dict.version.registerVersion,
        busy: dict.common.loading,
      },
      registerFailed: dict.version.registerFailed,
      strayCloser: dict.version.strayCloser,
      unclosedTag: dict.version.unclosedTag,
      fixCloser: dict.version.fixCloser,
      add: dict.version.addVersion,
      addMenuEmpty: dict.version.addMenuEmpty,
      addOther: dict.version.addOther,
      addOtherPlaceholder: dict.version.addOtherPlaceholder,
      addOtherSubmit: dict.version.addOtherSubmit,
      // The picker's own refusal, because the id it refuses is the same id in
      // the same shape: one sentence about `v62` / `v64.1`, wherever it is
      // typed (`POST /api/versions`, versioning.md §1).
      addOtherInvalid: e.versionInvalidId,
      empty: dict.version.noVersions,
      removeTitle: dict.version.removeTitle,
      removeBody: dict.version.removeBody,
      removeEmpty: dict.version.removeEmpty,
      removeNothing: dict.version.removeNothing,
      removeLeftBehind: dict.version.removeLeftBehind,
      removeConfirm: dict.common.delete,
      cancel: dict.common.cancel,
      close: dict.common.close,
    },

    preview: {
      heading: e.preview,
      empty: e.previewEmpty,
      failed: e.previewFailed,
      loading: dict.common.loading,
      warningsTitle: e.previewWarnings,
      imageViewer: {
        viewer: dict.wiki.imageViewer,
        close: dict.common.close,
        filePage: dict.wiki.imageViewerFilePage,
      },
    },
    conflict: {
      title: e.conflictTitle,
      description: e.conflictDescription,
      yourText: e.conflictYourText,
      currentText: e.conflictCurrentText,
    },
    syntaxHelp: {
      title: e.syntaxHelpTitle,
      formatting: e.syntaxHelpFormatting,
      links: e.syntaxHelpLinks,
      templates: e.syntaxHelpTemplates,
      versions: e.syntaxHelpVersions,
      copy: e.copyExample,
      close: dict.common.close,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Create from search (decisions-v2 O14.5)                             */
/* ------------------------------------------------------------------ */

/**
 * The article URL to create `query` at, or null when the query is not a
 * creatable title or **already is** a page.
 *
 * Page identity is (namespace, slug) per decisions O1, so an existing row IS
 * the exact title match — that is the check O14.5 asks for. The href is the
 * ARTICLE url, never `/edit`: visiting it is the create flow (O14.1).
 */
export function createTargetHref(db: WikiDb, locale: Locale, query: string): string | null {
  const parsed = parseTitle(query);
  if (!parsed || !parsed.storable || parsed.nsName === null || parsed.slug === "") return null;
  const existing = getPageSource(db, {
    namespace: parsed.nsName as Namespace,
    slug: parsed.slug,
    locale,
  });
  if (existing) return null;
  return articleHref(locale, parsed.nsName, parsed.slug);
}
