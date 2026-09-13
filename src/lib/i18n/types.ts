import type { AuditAction } from "@/lib/db/store";

/**
 * i18n core types: the UI locale union and the typed `Dictionary` every
 * locale must implement in full.
 *
 * Normative sources:
 * - docs/engine/decisions.md "Engine i18n messages" (wikitext.* keys feed
 *   `WikiConfig.messages`, see src/lib/wiki/context.ts `buildWikiMessages`)
 * - docs/engine/decisions.md O4 (EN is the authoritative content locale;
 *   unknown locales fall back to EN)
 * - docs/engine/versioning.md §6 (version selector wording)
 * - docs/engine/routes.md (special pages, admin, auth surfaces)
 *
 * Every leaf is a plain string. Parameterized messages embed `{name}`
 * placeholders and are expanded with `formatMessage` (src/lib/i18n/format.ts);
 * the placeholder names each message expects are listed in its doc comment.
 */

/** UI locales the app ships dictionaries for. */
export const UI_LOCALES = ["en", "ko"] as const;

/**
 * A locale the app ships a full dictionary for. Use where a value is known
 * to be one of the shipped UI locales (e.g. after `resolveLocale`).
 */
export type UiLocale = (typeof UI_LOCALES)[number];

/**
 * A rendering/content locale code — deliberately open-ended (`string`).
 * Content locales come from the `languages` table and are not limited to the
 * shipped UI locales; the wiki service renders pages in whatever locale a
 * revision carries. Dictionary lookups for a non-UI locale fall back to
 * `"en"` (`getDictionary` / `resolveLocale`, decisions O4).
 */
export type Locale = string;

/** Locale the UI falls back to when a requested locale has no dictionary. */
export const DEFAULT_LOCALE: UiLocale = "en";

/**
 * The complete message catalog for one UI locale. `en` is authoritative:
 * every locale must provide exactly this key set (enforced by
 * src/lib/i18n/i18n.test.ts key-parity tests).
 */
export interface Dictionary {
  /** Chrome shared across every page: header, footer, theme, generic verbs. */
  common: {
    /** Site display name (also `{{SITENAME}}` — keep in sync with SITE_NAME). */
    siteName: string;
    /** One-line site tagline used on the home page hero and meta description. */
    tagline: string;
    signIn: string;
    signOut: string;
    register: string;
    profile: string;
    admin: string;
    loading: string;
    save: string;
    cancel: string;
    close: string;
    confirm: string;
    delete: string;
    back: string;
    actions: string;
    /** Accessible label of the theme switcher. */
    themeLabel: string;
    themeLight: string;
    themeDark: string;
    themeSystem: string;
    /** Accessible label of the locale switcher. */
    languageLabel: string;
    /** Skip-navigation link for keyboard users. */
    skipToContent: string;
    /** Accessible label of the mobile menu toggle. */
    menu: string;
    /** Display name for edits whose author account no longer resolves. */
    anonymous: string;
    /** Signed in, but the server could not verify the session (no Admin creds). */
    unverified: string;
    /** Footer: content licensing line. */
    footerLicense: string;
    /** Footer: "{name}" = site name. */
    footerCopyright: string;
  };

  /** Global navigation entries (header, sidebar, footer nav). */
  navigation: {
    home: string;
    mainPage: string;
    recentChanges: string;
    allPages: string;
    wantedPages: string;
    whatLinksHere: string;
    outdatedTranslations: string;
    languages: string;
    specialPages: string;
    adminConsole: string;
  };

  /** Home page (`/{locale}`). */
  home: {
    title: string;
    description: string;
    /** Heading of the recent-changes panel. */
    recentChanges: string;
    noRecentChanges: string;
    /** Heading of the category browse panel. */
    browseCategories: string;
    /** Sub-line of the category browse panel (decisions-v2 O13.3). */
    categoriesDescription: string;
    /** Link from the home grid to `/special/categories` (O13.3). */
    browseAllCategories: string;
    /** Live member count on a category card — "{count}" = number of pages. */
    categoryPageCount: string;
    /** Shown in place of the grid when no page carries a category yet. */
    noCategories: string;
    /** Heading of the site statistics strip. */
    statistics: string;
  };

  /**
   * Article read view (`/{locale}/wiki/[...title]`): tab labels, banners,
   * category footer, red-link CTA. Consumed by `articleViewLabels`
   * (src/lib/wiki/read-view.ts).
   */
  wiki: {
    edit: string;
    history: string;
    viewSource: string;
    translatePage: string;
    /** "Last edited {time} by {user}". */
    lastEditedLine: string;
    categories: string;
    noCategories: string;
    /** "{title}" = the redirect page the reader arrived through. */
    redirectedFrom: string;
    /** EN-fallback banner (decisions O4): title. */
    missingTranslationTitle: string;
    /** EN-fallback banner: body. */
    missingTranslationDescription: string;
    /** EN-fallback banner: translate CTA button. */
    translateCta: string;
    /** Badge on a translation older than its EN source: title. */
    outdatedTitle: string;
    outdatedDescription: string;
    outdatedAction: string;
    /** Badge on a page originally authored in this locale (not a translation). */
    originalTitle: string;
    originalDescription: string;
    /** Red-link / missing page view: title. */
    pageNotFoundTitle: string;
    pageNotFoundDescription: string;
    /**
     * Missing page, visitor may NOT edit (decisions-v2 O14.2): the classic
     * MediaWiki notice, shown with a sign-in CTA and a link to the edit URL.
     */
    noTextTitle: string;
    noTextDescription: string;
    /** Create-page CTA on the missing page view — links to the edit URL. */
    createPage: string;
    whatLinksHere: string;
    /** Old-revision banner: title. */
    oldRevisionTitle: string;
    oldRevisionDescription: string;
    oldRevisionAction: string;
    /** Category pages: subcategory list heading. */
    subcategories: string;
    /** Category pages: member list heading. */
    categoryMembers: string;
    emptyCategory: string;
    /** Image viewer (clicking an article image): accessible name of the overlay. */
    imageViewer: string;
    /** Image viewer: link that still opens the `File:` description page. */
    imageViewerFilePage: string;
  };

  /**
   * Game-version selector and banners (versioning.md §6). Consumed by the
   * article header selector and the home page version panel.
   */
  version: {
    /** Short label next to the selector control. */
    label: string;
    /** Heading of version listings ("Game versions"). */
    title: string;
    /** The registry's newest version ("Latest"). */
    /**
     * Badge on the site-default version in the home panel. It says "default",
     * not "latest": the default is where a reader with no opinion starts, and
     * versioning.md §6 is explicit that nothing here is a destination.
     */
    defaultBadge: string;
    /** Status label: `current`. */
    current: string;
    /** Status label: `supported`. */
    supported: string;
    /** Status label: `legacy`. */
    archived: string;
    /** Unknown `?v=` banner (versioning.md §6 routes): title. */
    unknownVersionTitle: string;
    /** Unknown `?v=` banner: body ("{version}" = the requested id). */
    unknownVersionDescription: string;

    /* — the branch selector, shared by the article and the editor (§6) — */

    /** Heading of the chip row: the versions this page is written for. */
    boundaries: string;
    /** Chip note for a boundary the registry does not have (§1). */
    unregistered: string;
    /**
     * The only sentence the article prints beside the chips: which *branch* is
     * on screen when the selection is not itself a boundary. "{version}" = what
     * is selected, "{branch}" = the branch that governs it.
     */
    showingBranch: string;
    /** Editor only: register a boundary the page names but the registry lacks. */
    registerVersion: string;
    /** "{id}" = the version that could not be registered. */
    registerFailed: string;
    /**
     * Editor only: a closing tag that closes nothing and is one letter from
     * closing a version tag. "{tag}" as written, "{suggestion}" as meant.
     */
    strayCloser: string;
    /**
     * Editor only: a version tag no closer ever repeated, so spec §10.7 makes
     * it swallow the rest of the page. "{tag}" = the opening tag.
     */
    unclosedTag: string;
    /** Editor only: the button that repairs a stray closer to "{suggestion}". */
    fixCloser: string;
    /** The editor's "+": write for a version this page does not cover yet. */
    addVersion: string;

    /* — the "+" menu: choosing which version to write for next (§6) — */

    /** No registry version is left uncovered, so the menu lists none. */
    addMenuEmpty: string;
    /** Label of the menu's field for an id the registry does not have. */
    addOther: string;
    /** Placeholder of that field — an example id, not prose. */
    addOtherPlaceholder: string;
    /** Its confirm. */
    addOtherSubmit: string;

    /** Stands in for the chips while the page covers no version. */
    noVersions: string;

    /* — editor only: taking a version's writing off the page (§6) — */

    /** Accessible name of a chip's X — "{id}". */
    remove: string;
    /** Confirmation title — "{id}". */
    removeTitle: string;
    /** Confirmation body when prose goes — "{id}", "{chars}". */
    removeBody: string;
    /** Body when the version has no text of its own to lose — "{id}". */
    removeEmpty: string;
    /** Body when nothing can be removed automatically — "{id}". */
    removeNothing: string;
    /** Occurrences the removal refuses to touch — "{id}", "{count}". */
    removeLeftBehind: string;
  };

  /** Edit and translate views (`/{locale}/wiki/.../edit`). */
  editor: {
    /** Page heading when editing: "{title}" = page title. */
    editingTitle: string;
    /** Page heading when creating: "{title}" = page title. */
    creatingTitle: string;
    /** Translate flow notice: "{locale}" = source locale, "{title}" = source page. */
    translatingFrom: string;
    /** Accessible label of the wikitext textarea. */
    contentLabel: string;
    summaryLabel: string;
    summaryPlaceholder: string;
    minorEdit: string;
    preview: string;
    /** Version dropdown over the preview pane (versioning.md §6). */
    previewVersionLabel: string;
    publish: string;
    /** Edit-conflict screen: title. */
    conflictTitle: string;
    conflictDescription: string;
    conflictYourText: string;
    conflictCurrentText: string;
    /** Toolbar buttons. */
    toolbarBold: string;
    toolbarItalic: string;
    toolbarLink: string;
    toolbarHeading: string;
    toolbarList: string;
    toolbarTemplate: string;
    toolbarImage: string;
    toolbarTable: string;
    toolbarReference: string;
    /** Inserts an infobox template call. */
    toolbarInfobox: string;
    /** Opens the version-scope dialog, which writes the tag (versioning.md §2.1). */
    toolbarVersions: string;
    /** Syntax-help panel: panel title and section titles. */
    syntaxHelpTitle: string;
    syntaxHelpFormatting: string;
    syntaxHelpLinks: string;
    syntaxHelpTemplates: string;
    syntaxHelpVersions: string;
    /** Notice under the publish button about licensing of contributions. */
    licenseNotice: string;
    /** Anonymous /edit: read-only banner title (routes.md). */
    signInRequiredTitle: string;
    /** Anonymous /edit: read-only banner body. */
    signInRequiredDescription: string;
    /** Preview pane placeholder before any content has been rendered. */
    previewEmpty: string;
    /** Preview request failed (network / server error). */
    previewFailed: string;
    /** Publish button label while the save request is in flight. */
    saving: string;
    /** Save failed for a non-conflict reason ("{message}" = server detail). */
    saveFailed: string;
    /** Heading over the parser-warning list in the preview pane. */
    previewWarnings: string;
    /** Copy button on syntax-help examples. */
    copyExample: string;

    /* — Fandom-style source editor (src/components/wiki/editor.tsx) — */

    /** Accessible name of the source surface's line-number gutter. */
    lineNumbers: string;
    /** Primary action in the editor header strip. */
    saveChanges: string;
    /** Accessible name of the Source/Split/Preview segmented control. */
    viewLabel: string;
    viewSource: string;
    viewSplit: string;
    viewPreview: string;
    /** Accessible name of the `role="toolbar"` row. */
    toolbarLabel: string;
    toolbarUnderline: string;
    toolbarUnlink: string;
    /** Heading dropdown: the "no heading" entry. */
    toolbarHeadingParagraph: string;
    /** Heading dropdown entry: "{level}" = 2…5. */
    toolbarHeadingLevel: string;
    toolbarNumberedList: string;
    toolbarIndent: string;
    /** Trigger of the Insert dropdown. */
    toolbarInsert: string;
    /** Inserts a `<gallery>` block (spec §10). */
    toolbarGallery: string;
    /** Inserts a Fandom `<tabber>` block (spec "Fandom extensions"). */
    toolbarTabber: string;
    toolbarRule: string;
    /** Signature-less date stamp. */
    toolbarDate: string;
    /** Trigger of the special-characters popover. */
    toolbarSpecialCharacters: string;
    /** Editor right rail: header and section titles. */
    railTitle: string;
    railCollapse: string;
    railExpand: string;
    railInsert: string;
    railTemplates: string;
    railTemplatesEmpty: string;
    railCategories: string;
    railCategoriesEmpty: string;
    railCategoryPlaceholder: string;
    railCategoryAdd: string;
    /** Remove-category button: "{name}" = the category. */
    railCategoryRemove: string;
    railSettings: string;
    railSettingsLocale: string;
    railSettingsVersion: string;
    railSettingsParentRev: string;
    /** Shown for "Based on" when the page has no revision yet. */
    railSettingsNewPage: string;

    /* — Visual/source editor chrome (spec §1: header, mode pill, left rail) — */

    /** Eyebrow over the page title when editing an existing page. */
    eyebrowEdit: string;
    /** Eyebrow over the page title when the page does not exist yet. */
    eyebrowCreate: string;
    /** Accessible name of the mode pill's menu. */
    modeMenuLabel: string;
    /** Mode pill face while the visual surface is active. */
    modeVisualPill: string;
    /** Mode pill face while the source surface is active. */
    modeSourcePill: string;
    /** Mode menu entry: switch to the visual surface. */
    modeVisual: string;
    /** Mode menu entry: switch to the source surface. */
    modeSource: string;
    /** Mode menu entry: link out to the editing guide. */
    modeUserGuide: string;
    /** Mode menu entry: opens the shortcuts dialog. */
    modeShortcuts: string;
    /** Chevron next to the mode pill, when the header strip is open. */
    headerCollapse: string;
    /** Chevron next to the mode pill, when the header strip is collapsed. */
    headerExpand: string;
    /** Left-rail button: widen the surface to the viewport. */
    fullscreenEnter: string;
    /** Left-rail button: leave the widened surface. */
    fullscreenExit: string;
    /** Left-rail button: toggle the page-tools rail. */
    railToggle: string;
    /**
     * Publish bar’s primary action. Deliberately shorter than `publish`
     * ("Publish changes"), which the legacy source-only header still uses.
     */
    publishShort: string;

    /* — Visual/source toolbars (spec §1 "Toolbars") — */

    toolbarUndo: string;
    toolbarRedo: string;
    toolbarFormatParagraph: string;
    toolbarFormatHeading: string;
    /** Sub-heading entry — "{level}" = 1…3 (rendered as h3…h5). */
    toolbarFormatSubHeading: string;
    toolbarFormatPre: string;
    toolbarStrikethrough: string;
    toolbarSuperscript: string;
    toolbarSubscript: string;
    toolbarCode: string;
    toolbarClearFormatting: string;
    toolbarIndentMore: string;
    toolbarIndentLess: string;
    /** Trigger of the citation dropdown. */
    toolbarCite: string;
    toolbarCiteBasic: string;
    toolbarCiteNamed: string;
    toolbarCiteList: string;
    /** Heading over the CITE menu's "cite a source already on the page" rows. */
    toolbarCiteReuse: string;
    toolbarMedia: string;
    /** Trigger of the source-mode advanced dropdown. */
    toolbarAdvanced: string;
    toolbarNowiki: string;
    toolbarComment: string;
    toolbarRedirect: string;
    toolbarUpload: string;
    /** Overflow trigger shown when the toolbar does not fit. */
    toolbarMore: string;

    /* — Visual surface and its atomic nodes (spec §2, §5) — */

    /** Accessible name of the contenteditable surface. */
    visualLabel: string;
    /** Shown in the empty surface before anything is typed, and unfocused. */
    visualPlaceholder: string;
    /**
     * Printed in the empty paragraph the caret is standing in — Notion's
     * answer to the discoverability the fixed toolbar used to provide, and the
     * only thing on screen that says the slash menu exists (§1).
     */
    visualSlashHint: string;
    /** Status while an atomic node's server render is in flight. */
    visualRendering: string;
    visualRenderedEmpty: string;
    visualContextMenu: string;
    /** Shown in place of the document when the buffer could not be parsed. */
    visualLoadError: string;
    /** Atomic node edit button — "{label}" = one of the `atomic*` nouns below. */
    atomicEdit: string;
    /** Atomic node remove button — "{label}" = one of the `atomic*` nouns below. */
    atomicRemove: string;
    /** Atomic node dialog title — "{label}" = one of the `atomic*` nouns below. */
    atomicDialogTitle: string;
    /** Atomic node dialog: explains why the body is raw wikitext. */
    atomicDialogHint: string;
    /** Atomic node dialog: confirm button. */
    atomicApply: string;
    /** Nouns naming an atomic node kind; substituted into the `{label}` messages. */
    atomicTemplate: string;
    atomicTable: string;
    atomicInfobox: string;
    atomicGallery: string;
    atomicTabber: string;
    atomicVersions: string;
    atomicMedia: string;
    atomicCategory: string;
    atomicComment: string;
    atomicPre: string;
    atomicRedirect: string;
    atomicHtml: string;
    atomicNowiki: string;
    atomicRef: string;
    atomicMagic: string;
    /** Fallback noun for a block the model could not classify. */
    atomicUnknown: string;

    /* — the slash menu (visual-editor.md §1) — */

    /** Heading over the slash panel's rows, and its accessible name. */
    slashTitle: string;
    /** The one line a query that matched nothing shows instead of rows. */
    slashEmpty: string;
    /**
     * The second line under every special-character row, and the one word that
     * finds them all: a glyph cannot be searched for in a language.
     */
    slashSpecialCharacter: string;
    /** `; Term : Definition` — wikitext-spec §4.1's third list marker. */
    slashDefinitionList: string;
    /** `[[Category:…]]` — spec §5.10. */
    slashCategory: string;
    /** `[https://… label]` — spec §6.2's labelled form. */
    slashExternalLink: string;
    /** `<syntaxhighlight lang="…">` — spec §10.5. */
    slashCodeBlock: string;

    /* — the mention panels (visual-editor.md §13) — */

    /** Heading over the rows `[[` and `@` open — the page index. */
    mentionPageTitle: string;
    /** Heading over the rows `{{` opens — the Template: namespace. */
    mentionTemplateTitle: string;
    /** The line a search that found nothing shows instead of rows. */
    mentionEmpty: string;
    /**
     * The line shown while the search has not answered yet. It is not the same
     * sentence as {@link mentionEmpty}: "nothing matches" is a claim about an
     * index, and one keystroke ago it had not been asked.
     */
    mentionLoading: string;

    /* — the gutter handle and the bubble menu (visual-editor.md §1, §3.1) — */

    /** The handle's "+" — it adds a block below, so it says so. */
    blockHandleAdd: string;
    /** The grip, which both drags a block and opens its menu. */
    blockHandleGrip: string;
    /** The grip's panel, announced when focus enters it. */
    blockHandleMenu: string;
    blockInsertBelow: string;
    blockDuplicate: string;
    blockDelete: string;
    /**
     * Heading over the format rows of the grip's menu, and the face of the
     * bubble menu's format control. One word for one act, drawn twice.
     */
    blockTurnInto: string;
    /** Accessible name of the bar that comes to a selection. */
    bubbleLabel: string;

    /* — moving a block (visual-editor.md §3.1) — */

    /**
     * Accessible name of the gutter's up button, and the shortcut table's row
     * for `Alt+↑`. It names the direction, because the button is an arrow and
     * an arrow is not a name.
     */
    blockMoveUp: string;
    /** The same, downward. */
    blockMoveDown: string;

    /* — the table controls (visual-editor.md §3.2) — */

    /** Accessible name of the group of controls drawn around a table. */
    tableControlsLabel: string;
    /** The control over the caret's column, and the menu it opens. */
    tableColumnMenu: string;
    /** The control beside the caret's row, and the menu it opens. */
    tableRowMenu: string;
    tableInsertRowAbove: string;
    tableInsertRowBelow: string;
    tableMoveRowUp: string;
    tableMoveRowDown: string;
    tableDeleteRow: string;
    tableInsertColumnLeft: string;
    tableInsertColumnRight: string;
    tableMoveColumnLeft: string;
    tableMoveColumnRight: string;
    tableDeleteColumn: string;
    /**
     * The header toggle names what the click will DO, so it says which of the
     * two it is rather than leaving an author to read a pressed state off an
     * icon: `On` while the row is a body row, `Off` while it is a header row.
     */
    tableHeaderRowOn: string;
    tableHeaderRowOff: string;
    tableDelete: string;

    /** Title of the dialog every table-destroying edit asks through. */
    tableDeleteTitle: string;
    /** Body when the author asked for the table itself to go. */
    tableDeleteBody: string;
    /** Body when it is the last row, so deleting it deletes the table (§7.5). */
    tableDeleteLastRowBody: string;
    /** The same for the last column. */
    tableDeleteLastColumnBody: string;
    /** Confirms the deletion; the dialog's other button is `common.cancel`. */
    tableDeleteConfirm: string;

    /** Title of the notice explaining why a row could not become a header row. */
    tableHeaderRefusedTitle: string;
    /** Why: a data cell holding `!!`, which a header line splits on (§7.3). */
    tableHeaderRefusedBody: string;

    /*
     * Why one table is a chip rather than an editable grid (§2). The reason is
     * printed on the chip itself, because "this table behaves differently" is
     * otherwise something an author can only guess at.
     */
    /** Wraps the reason below — "{reason}". */
    tableRefusedWhy: string;
    tableRefusalNotATable: string;
    tableRefusalIndented: string;
    tableRefusalUnclosed: string;
    tableRefusalTrailingContent: string;
    tableRefusalNestedTable: string;
    tableRefusalFosteredContent: string;
    tableRefusalCellContinuation: string;
    tableRefusalCaptionContinuation: string;
    tableRefusalCaptionAttrs: string;
    tableRefusalSecondCaption: string;
    tableRefusalNoRows: string;
    tableRefusalNotAFixedPoint: string;

    /* — Editor dialogs (link, shortcuts, mode switch) — */

    linkDialogTitle: string;
    linkTarget: string;
    linkTargetPlaceholder: string;
    linkText: string;
    linkApply: string;
    /** Accessible name of the link dialog's page-suggestion listbox. */
    linkSuggestions: string;
    /** The typed target names a page that already exists. */
    linkExistingPage: string;
    /** It does not — allowed, and worth knowing before publishing (a red link). */
    linkNewPage: string;
    shortcutsTitle: string;
    shortcutsAction: string;
    shortcutsKeys: string;
    /** Shortcut table row naming the publish binding. */
    shortcutsPublishRow: string;
    /** Shortcut table row naming "/" — the way to every construct (§1). */
    shortcutsSlashMenu: string;
    /** Shortcut table row naming `[[` — the page and template search (§13). */
    shortcutsMention: string;
    /** Shortcut table row for Tab inside a table (§3.2). */
    shortcutsTableNextCell: string;
    /** The same, backwards. */
    shortcutsTablePreviousCell: string;
    /** Shortcut row for `Shift+Enter` — a line break inside a cell (§3.2). */
    shortcutsTableLineBreak: string;
    /** Warning shown before switching modes (spec §4 round-tripping caveat). */
    modeSwitchNotice: string;

    /* — find and replace (visual-editor.md §9) — */

    /**
     * Accessible name of the strip Ctrl/Cmd+F opens, and the shortcut table's
     * row for that binding. It names both halves, because a panel that only
     * found things would be the browser's own.
     */
    findTitle: string;
    /** The query field's name and its placeholder — the strip has room for one. */
    findLabel: string;
    /** The replacement field's, likewise. */
    findReplaceLabel: string;
    findPrevious: string;
    findNext: string;
    /** Toggle: only hits spelled with the same capitals count. */
    findMatchCase: string;
    /** Toggle: only hits that are a whole word count. */
    findWholeWord: string;
    /** "{index} of {total}" — which hit is current, out of how many. */
    findCount: string;
    /** The query is not in the buffer. Not an error: a page may simply not say it. */
    findNoResults: string;
    /** Replaces the hit on screen. */
    findReplaceOne: string;
    /** Replaces every hit, in one edit. */
    findReplaceAll: string;
    /** Name of the line printing the current hit with the buffer either side. */
    findContext: string;

    /* — the outline, and the publish bar's counts (visual-editor.md §10) — */

    /** Heading of the outline card in the page-tools column. */
    outlineTitle: string;
    /** The article has no headings yet, so there is no map to draw. */
    outlineEmpty: string;
    /** Stands in for the text of a heading that has none (`== ==`). */
    outlineUntitled: string;
    /**
     * A row's up arrow — "{title}" is the heading. It says *section*, not
     * heading: what moves is the heading and everything under it (§10.1).
     */
    outlineMoveUp: string;
    /** The same, downwards. */
    outlineMoveDown: string;
    /** Publish bar's live word count — "{count}" is already grouped for the locale. */
    countWords: string;
    /** The same for characters, which are counted as the reader sees them. */
    countCharacters: string;

    /* — never losing an edit (visual-editor.md §8) — */

    /** Heading of the banner offering a draft found in this browser. */
    draftTitle: string;
    /** "{when}" = when the draft was written, in the reader's own time zone. */
    draftFound: string;
    /**
     * The draft was written against another revision — "{revision}" — so
     * somebody else has published since and restoring may undo them (§8.2).
     */
    draftStale: string;
    /** The same, for a draft written while the page did not exist yet. */
    draftStaleNew: string;
    draftRestore: string;
    draftDiscard: string;
    /** Title of the dialog Cancel asks through while the buffer is dirty. */
    discardTitle: string;
    discardBody: string;
    /** Confirms leaving; the draft goes with the changes. */
    discardConfirm: string;
    /** Dismisses the dialog and stays in the editor. */
    discardKeep: string;

    /* — template dialog (visual-editor.md §5.1) — */

    /** Dialog title while picking a template to insert. */
    templateInsertTitle: string;
    /** Dialog title while editing an existing call. */
    templateEditTitle: string;
    templateSearchLabel: string;
    templateSearchPlaceholder: string;
    templateSearchEmpty: string;
    /** Returns to the search step from the parameter form. */
    templateBack: string;
    /** Badge on a parameter the template uses without a default (spec §8.4). */
    templateRequired: string;
    /** Badge shown when the template ships a `<templatedata>` block. */
    templateDocumented: string;
    templateParametersEmpty: string;
    templateAddParameter: string;
    templateAddParameterPlaceholder: string;
    templateAdd: string;
    /** "{name}" = the parameter being dropped from the call. */
    templateRemoveParameter: string;
    templatePreview: string;
    templateInsert: string;
    templateApply: string;
    /** Escape hatch from the form to the raw-wikitext dialog. */
    templateEditSource: string;
    templateFailed: string;

    /* — tag & version pickers (visual-editor.md §5.3) — */

    tagPickerPlaceholder: string;
    tagPickerList: string;
    tagPickerEmpty: string;
    /** "{name}" = the tag being invented. */
    tagPickerCreate: string;
    tagPickerCreateHint: string;
    versionPickerPlaceholder: string;
    versionPickerList: string;
    versionPickerEmpty: string;
    /** "{name}" = the version id being registered. */
    versionPickerCreate: string;
    versionPickerCreateHint: string;

    /* — the rail's "versions on this page" section — */



    /* — version-scoped authoring (versioning.md §2) — */

    versionDialogTitle: string;
    /** Dialog title when a block already on the page was reopened in the form. */
    versionDialogEditTitle: string;
    versionDialogIntro: string;
    /** Label over the version picker in the two one-version forms. */
    versionPickLabel: string;
    /** Labels over the two pickers of the range form. */
    versionRangeFrom: string;
    versionRangeTo: string;
    /** Stands in for an id while a picker has none. */
    versionPickPrompt: string;
    versionModeLabel: string;
    /** The three shapes of a version tag's name (§2.1), in the author's words. */
    versionModeOnly: string;
    versionModeWindow: string;
    versionModeSince: string;
    versionBodyLabel: string;
    versionBodyPlaceholder: string;
    versionPreview: string;
    versionInsert: string;
    /** Confirm label when a block already on the page was reopened. */
    versionApply: string;
    /** Why the confirm is refused: the passage is blank, so nothing renders. */
    versionAllEmpty: string;
    /** Why the confirm is refused: the range ends before it starts (§2.1). */
    versionRangeInverted: string;
    versionFailed: string;
    versionInvalidId: string;

    /* — the passage a version block is edited at, in place (versioning.md §6) — */

    /**
     * Head row over the field inside the block: "Editing {branch}". `{branch}`
     * is the version the tag STARTS at, which is the version the words belong
     * to and may not be the one the chip row has selected.
     */
    versionBranchLabel: string;
    /** The block writes nothing at the previewed version — "{version}". */
    versionBranchMissing: string;
    versionBranchElsewhere: string;

    /* — media dialog (visual-editor.md §5.2) — */

    mediaTitle: string;
    mediaTabUpload: string;
    mediaTabLibrary: string;
    mediaDropHint: string;
    mediaChoose: string;
    mediaUploading: string;
    mediaLibrarySearch: string;
    mediaLibraryEmpty: string;
    mediaCaptionLabel: string;
    mediaCaptionPlaceholder: string;
    mediaLayoutLabel: string;
    mediaLayoutThumb: string;
    mediaLayoutFrameless: string;
    mediaLayoutFull: string;
    mediaAlignLabel: string;
    mediaAlignRight: string;
    mediaAlignLeft: string;
    mediaAlignCenter: string;
    mediaAlignNone: string;
    mediaWidthLabel: string;
    mediaInsert: string;
    /** "{max}" = a human file size, e.g. "10 MB". */
    mediaTooLarge: string;
    /** "{types}" = the allowed extension list. */
    mediaBadType: string;
    /** "{chars}" = the characters a filename may not contain. */
    mediaBadName: string;
    mediaFailed: string;
    /** "{name}" = the canonical filename about to be overwritten. */
    mediaReplaceWarning: string;
  };

  /** Page history view (`/{locale}/wiki/.../history`). */
  history: {
    /** "{title}" = page title. */
    title: string;
    columnRevision: string;
    columnDate: string;
    columnAuthor: string;
    columnSummary: string;
    columnSize: string;
    compare: string;
    /** Rollback action (POST body {action:"rollback"} — routes.md). */
    rollback: string;
    /** "Restore this revision" on an old-revision view. */
    restore: string;
    currentBadge: string;
    minorBadge: string;
    empty: string;
    /** Keyset pagination: link to the next (older) page of revisions. */
    older: string;
    /** Rollback confirm dialog title. */
    rollbackConfirmTitle: string;
    /** Rollback confirm dialog body ("{rev}" = target revision id). */
    rollbackConfirmDescription: string;
    /** Rollback request failed. */
    rollbackFailed: string;
    /** Accessible label of the "from" radio ("{rev}" = revision id). */
    selectFrom: string;
    /** Accessible label of the "to" radio ("{rev}" = revision id). */
    selectTo: string;
    /** Accessible label of the per-locale tab row. */
    localeTabsLabel: string;
  };

  /** Revision diff view. */
  diff: {
    title: string;
    /** "{from}" / "{to}" = revision labels being compared. */
    comparing: string;
    noChanges: string;
    addedLabel: string;
    removedLabel: string;
    backToHistory: string;
  };

  /** Search box, results page, and suggest dropdown. */
  search: {
    /** Accessible label of the search input. */
    label: string;
    placeholder: string;
    submit: string;
    /** "{query}" = the search terms. */
    resultsTitle: string;
    /** "{count}" = number of hits. */
    resultCount: string;
    noResults: string;
    /** Suggest dropdown heading. */
    suggestTitle: string;
    /**
     * decisions-v2 O14.5 — a query with no exact title match offers to create
     * that page. "{query}" = the raw query the reader typed.
     */
    createTitle: string;
    createDescription: string;
    /** Same action as the last entry of the suggest dropdown. */
    createSuggest: string;
    /** Chip on a result served from the EN index for a non-EN reader. */
    enChip: string;
    /** Unit label for page counts (home statistics strip). */
    pages: string;
  };

  /** Special pages (routes.md): titles and shared column headers. */
  special: {
    recentChangesTitle: string;
    wantedPagesTitle: string;
    allPagesTitle: string;
    /** "{title}" = target page. */
    whatLinksHereTitle: string;
    outdatedTranslationsTitle: string;
    columnPage: string;
    columnNamespace: string;
    columnLocale: string;
    columnDate: string;
    columnUser: string;
    columnSummary: string;
    /** Wanted pages: inbound red-link count — "{count}" = number. */
    columnInboundLinks: string;
    /** Outdated translations: the stale translated page. */
    columnTranslation: string;
    /** Outdated translations: EN revisions behind — "{count}" = number. */
    columnRevisionsBehind: string;
    filterLabel: string;
    namespaceAll: string;
    empty: string;
    versionCoverageTitle: string;
    /** Version-coverage report subtitle. */
    versionCoverageDescription: string;
    columnVersion: string;
    /** "All versions" option of the version-coverage filter. */
    versionAll: string;
    /** Keyset-pagination link text. */
    loadMore: string;
    /** Recent-changes filter checkbox. */
    hideMinorLabel: string;
    /** Chip on a minor edit row. */
    minorBadge: string;
    /** Chip on a non-EN head with no EN basis (decisions O4). */
    originalBadge: string;
    /** Chip on a redirect row (all-pages listing). */
    redirectBadge: string;
    /** What-links-here section: ordinary wiki links. */
    linksSection: string;
    /** What-links-here section: template transclusions. */
    transclusionsSection: string;
    /** What-links-here section: redirect pages targeting this page. */
    redirectsSection: string;
    /** `/special/categories` (decisions-v2 O13.4): page title. */
    categoriesTitle: string;
    /** `/special/categories`: subtitle. */
    categoriesDescription: string;
    /** `/special/categories`: shown when no category exists at all. */
    categoriesEmpty: string;
    /** Category listing column: the category itself. */
    columnCategory: string;
    /** Category listing column: member page count. */
    columnMembers: string;
    /** Category listing column: subcategory count. */
    columnSubcategories: string;
    /** Chip on a category whose `Category:` description page is unwritten. */
    noDescriptionPageBadge: string;
    /** `/special/categories`: uncategorized-pages section heading (O13.4). */
    uncategorizedTitle: string;
    /** Uncategorized-pages section: subtitle. */
    uncategorizedDescription: string;
    /** Uncategorized-pages section: shown when every article is categorized. */
    uncategorizedEmpty: string;
  };

  /** Languages listing page. */
  languages: {
    title: string;
    description: string;
    columnCode: string;
    columnName: string;
    columnNativeName: string;
    columnStatus: string;
    columnPages: string;
    statusActive: string;
    statusInactive: string;
    /** Registry rows awaiting admin activation. */
    statusProposed: string;
    /** Per-language stale-translation count column. */
    columnOutdated: string;
    proposeTitle: string;
    proposeDescription: string;
    directionLabel: string;
    directionLtr: string;
    directionRtl: string;
    proposeAction: string;
    activateAction: string;
    deactivateAction: string;
    /** Shown in place of the propose form for anonymous visitors. */
    signInToPropose: string;
    proposeSuccess: string;
    /** "{message}" = server error message. */
    requestFailed: string;
  };

  /** Admin console (`/{locale}/admin`). */
  admin: {
    title: string;
    tabGrants: string;
    tabBans: string;
    tabVersions: string;
    tabAudit: string;
    /** Moderation queue tab — the reports users filed. */
    tabReports: string;
    reportsEmpty: string;
    /** Accessible name of the open/resolved/dismissed filter. */
    reportFilterLabel: string;
    reportStatusOpen: string;
    reportStatusResolved: string;
    reportStatusDismissed: string;
    reportStatusAll: string;
    /** The reported account. */
    reportColumnTarget: string;
    /** Who filed it. */
    reportColumnReporter: string;
    reportColumnReason: string;
    /** Close a report having acted on it. */
    reportResolve: string;
    /** Close a report without acting. */
    reportDismiss: string;
    userLabel: string;
    grantRole: string;
    revokeRole: string;
    banUser: string;
    unbanUser: string;
    banReasonLabel: string;
    bannedBadge: string;
    versionIdLabel: string;
    versionLabelLabel: string;
    addVersion: string;
    setDefaultVersion: string;
    /** "{version}" = current default version id. */
    defaultVersionLine: string;
    auditColumnAction: string;
    auditColumnActor: string;
    auditColumnTarget: string;
    auditColumnDate: string;
    /** Grants tab intro line (mentions the no-self-revoke rule). */
    grantsDescription: string;
    uidLabel: string;
    displayNameLabel: string;
    grantColumnGrantedBy: string;
    grantColumnGrantedAt: string;
    grantStatusActive: string;
    grantStatusRevoked: string;
    grantsEmpty: string;
    /** Bans tab intro line (mentions the O5 dual write). */
    bansDescription: string;
    /** Placeholder of the ban tab's username picker. */
    usernamePlaceholder: string;
    /** Accessible name of the username picker's suggestion list. */
    usernameSuggestions: string;
    /** Shown in the picker when no account matches what was typed. */
    usernameEmpty: string;
    /** Accessible name of a row's "⋯" menu — "{name}" = what the row is about. */
    rowActions: string;
    versionsEmpty: string;
    /** Badge on the site-default version row. */
    versionDefaultBadge: string;
    /** Delete refusal headline — "{version}" = version id. */
    versionDeleteBlockedTitle: string;
    /** Delete refusal body — "{count}" = referencing page count. */
    versionDeleteBlockedBody: string;
    /** Edit dialog title — "{version}" = version id. */
    versionEditTitle: string;
    auditEmpty: string;
    /**
     * What each audit action reads as. Keyed by the stored identifier
     * (store.ts AuditAction) — the log stores a stable id and shows a
     * sentence, so the record survives a wording change.
     */
    auditActions: Record<AuditAction, string>;
    /** Generic fetch failure — "{message}" = server error message. */
    loadFailed: string;
    /** Generic mutation failure — "{message}" = server error message. */
    actionFailed: string;
    /** Shown while the anonymous visitor is bounced to /login. */
    signInRedirect: string;
  };

  /** Auth flows (Firebase): login, register, reset, profile. */
  auth: {
    signInTitle: string;
    signInDescription: string;
    emailLabel: string;
    /** Sign-in field label: it takes an address or an account name. */
    identifierLabel: string;
    passwordLabel: string;
    usernameLabel: string;
    signInAction: string;
    registerTitle: string;
    registerAction: string;
    resetTitle: string;
    resetAction: string;
    resetSent: string;
    forgotPassword: string;
    needAccount: string;
    alreadyHaveAccount: string;
    /** Register panel subtitle. */
    registerDescription: string;
    /** Reset-password panel subtitle. */
    resetDescription: string;
    /** Link from the register/reset panels back to sign-in. */
    backToSignIn: string;
    /** Firebase auth/email-already-in-use. */
    emailInUse: string;
    /** Firebase auth/weak-password. */
    weakPassword: string;
    /** Any unmapped auth failure. */
    genericError: string;
    /** Login page notice when already authenticated — "{name}" = username. */
    alreadySignedIn: string;
    profileTitle: string;
    profilePictureLabel: string;
    rolesLabel: string;
    /** Wrong password, unknown address, unknown name: one answer for all three. */
    invalidCredentials: string;
    /** Register: the chosen account name is already in use. */
    usernameTaken: string;
    /** Register: the name is shorter than 3 or longer than 32 characters. */
    usernameLength: string;
    /** Register: the name used characters outside a-z 0-9 _ . - */
    usernameCharacters: string;
    /** Shown to a banned account attempting to edit. */
    bannedNotice: string;
    /** Profile page: heading of the own-edits list. */
    contributionsTitle: string;
    contributionsEmpty: string;
    /** Profile page CTA when signed out. */
    signInToViewProfile: string;
    /** Profile page: label of the Firebase uid line. */
    accountIdLabel: string;
  };

  /** Wiki Q&A agent (AskDock side panel + scripts/agent-server.ts). */
  ask: {
    /** Header toggle-button label (opens/closes the side panel). */
    toggle: string;
    /** Panel heading. */
    title: string;
    /** Accessible label of the question box. */
    inputLabel: string;
    placeholder: string;
    send: string;
    /** Status line while the agent is working on an answer. */
    thinking: string;
    /** Activity row while the agent searches — "{query}" = search terms. */
    searchingLine: string;
    /** Activity row while the agent reads — "{title}" = the page title. */
    readingLine: string;
    /** Heading over the cited pages under an answer. */
    sourcesLabel: string;
    /** Empty state before the first question: title. */
    emptyTitle: string;
    /** Empty state: body. */
    emptyDescription: string;
    /** Agent failure — "{message}" = detail relayed from the server. */
    errorLine: string;
    /** The agent server could not be reached or the socket dropped. */
    connectionError: string;
  };

  /**
   * Acting on a person — the user chip's menu and the report dialog. Shared
   * by every surface that names an account (history, recent changes, the
   * audit log, the report queue), so the same act reads the same everywhere.
   */
  moderation: {
    /** Accessible name of a chip's menu — "{name}". */
    userActions: string;
    /** Menu row: file a report. */
    report: string;
    /** Menu row: ban. */
    ban: string;
    /** Menu row: lift a ban. */
    unban: string;
    /** Menu row: copy the account id. */
    copyId: string;
    /** Report dialog title — "{name}". */
    reportTitle: string;
    reportDescription: string;
    reportReasonLabel: string;
    reportReasonPlaceholder: string;
    reportSubmit: string;
    /** Report confirmation — "{name}". */
    reportSent: string;
    /** Report failure — "{message}". */
    reportFailed: string;
    /** Ban confirmation from a chip — "{name}". */
    banApplied: string;
    /** Unban confirmation from a chip — "{name}". */
    banLifted: string;
  };

  /**
   * Account role display names, keyed by the identifier stored in Firestore
   * (src/lib/roles.ts ROLE_IDS). `admin` reads "Manager" — the stored value and
   * the shown one deliberately differ, matching the High Quota HQ site this
   * shares its user collection with.
   */
  roles: {
    admin: string;
    "site-developer": string;
    moderator: string;
    verifier: string;
    "modded-verifier": string;
  };

  /** Error pages and generic failure states. */
  errors: {
    notFoundTitle: string;
    notFoundDescription: string;
    forbiddenTitle: string;
    forbiddenDescription: string;
    genericTitle: string;
    genericDescription: string;
    conflictTitle: string;
    tryAgain: string;
    goHome: string;
  };

  /**
   * Engine messages (decisions.md "Engine i18n messages", spec Addendum A3).
   * `buildWikiMessages` (src/lib/wiki/context.ts) maps this section onto the
   * engine's `WikiMessages`; every key it reads must exist here. The two
   * parameterized entries are template strings expanded via `formatMessage`.
   */
  wikitext: {
    /** `{{TOC}}` box title. */
    tocTitle: string;
    /** Appended to a red link's `title` attribute. */
    redLinkTitleSuffix: string;
    /** Lead-in of the rendered redirect pointer. */
    redirectTo: string;
    /** Cite error for an empty named ref — "{name}" = the ref name. */
    citeErrorNoText: string;
    templateLoop: string;
    templateDepthExceeded: string;
    /** Preview warning for an unregistered version — "{id}" = version id. */
    unknownVersion: string;
  };
}
