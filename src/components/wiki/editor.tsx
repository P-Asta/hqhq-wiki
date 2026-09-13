"use client";

/**
 * The edit page (routes.md `/edit`), shaped like Fandom's editor and drawn in
 * the Vercel token system (theme.md). Normative layout:
 * docs/engine/visual-editor.md §1.
 *
 * One island owns the buffer and hands it to whichever surface the mode pill
 * selected:
 *
 * - **Visual editing** — `<VisualEditor>`, a contenteditable over the parsed
 *   document model (`src/lib/visual-editor/**`). It is the article, editable in
 *   place; templates, tables and infoboxes are atomic nodes rendered through
 *   `/api/preview/fragments`.
 * - **Source editing** — the line-numbered highlighted textarea this editor has
 *   always had, beside the live preview.
 *
 * The two modes share one `content` string, so switching is lossless: the
 * visual surface serializes back to wikitext on every debounce, and §4 of the
 * spec guarantees that blocks the author never touched are re-emitted byte for
 * byte.
 *
 * Behaviour carried over unchanged from the first editor:
 * - anon: read-only surface + sign-in CTA (auth is a stateless Bearer flow, so
 *   the server cannot know — the island resolves it via useAuth);
 * - debounced live preview via POST /api/preview, rendered at whichever branch
 *   the version bar has selected (versioning.md §6);
 * - summary + minor + hidden parentRevId, published via PUT /api/pages;
 * - 409 → conflict UI diffing theirs vs yours, parentRevId rebased onto the new
 *   head so a merged retry can succeed;
 * - translating-from-EN notice for non-EN locales (decisions O4);
 * - the page-tools rail and the syntax-help drawer.
 *
 * **Nothing typed here is lost by leaving** (spec §8). Two independent
 * defences, because they fail differently: a `beforeunload` guard and a
 * confirmation behind Cancel catch the author who leaves on purpose, and a
 * debounced local draft catches the tab that is closed, crashed or restored on
 * another day. Neither is allowed to cost a keystroke — the guard reads a ref
 * and the draft is written on a one-second debounce — and neither may fire on
 * a page nobody touched, which is what `dirty` decides for both. The rules
 * about *which* draft belongs to *which* page are in editor-draft.ts, where
 * they can be tested without a browser.
 */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { useAuth } from "@/components/auth-provider";
import { Button, ButtonLink } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FieldMessage } from "@/components/ui/field-message";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBanner } from "@/components/ui/status-banner";
import {
  ConflictNotice,
  type ConflictNoticeLabels,
} from "@/components/wiki/conflict-notice";
import {
  AtomicDialog,
  type AtomicDialogLabels,
} from "@/components/wiki/editor-atomic-dialog";
import {
  DRAFT_KEY_PREFIX,
  draftKey,
  draftKeysForPage,
  draftOffer,
  serializeDraft,
  type DraftEntry,
  type DraftOffer,
  type StoredDraft,
} from "@/components/wiki/editor-draft";
import {
  applyFindReplace,
  blockSpanAt,
  blockSpans,
  findMatches,
  occurrenceInSpan,
  seedQuery,
  type FindApplyOutcome,
  type FindApplyRequest,
  type FindMatch,
  type FindOptions,
} from "@/components/wiki/editor-find";
import {
  EditorFindPanel,
  type EditorFindLabels,
  type FindReveal,
} from "@/components/wiki/editor-find-panel";
import { countText } from "@/components/wiki/editor-counts";
import {
  BookmarkIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  FullscreenIcon,
} from "@/components/wiki/editor-icons";
import {
  applySectionMove,
  documentOutline,
  sectionAtBlock,
  sectionAtOffset,
  sectionMovePlan,
  type OutlineMoveDirection,
} from "@/components/wiki/editor-outline";
import {
  EditorOutlinePanel,
  type EditorOutlineLabels,
} from "@/components/wiki/editor-outline-panel";
import {
  LinkDialog,
  type LinkDialogLabels,
  type LinkDialogValue,
} from "@/components/wiki/editor-link-dialog";
import {
  EditorInsertMenu,
  type EditorInsertMenuLabels,
} from "@/components/wiki/editor-insert-menu";
import {
  EditorModeMenu,
  type EditorModeMenuLabels,
} from "@/components/wiki/editor-mode-menu";
import { EditorRail, type EditorRailLabels } from "@/components/wiki/editor-rail";
import {
  EditorVersionBar,
  type EditorVersionBarLabels,
} from "@/components/wiki/editor-version-bar";
import {
  ShortcutsDialog,
  type ShortcutsDialogLabels,
} from "@/components/wiki/editor-shortcuts";
import { EditorSource, revealInTextarea } from "@/components/wiki/editor-source";
import {
  SourceToolbar,
  type SourceToolbarLabels,
} from "@/components/wiki/editor-toolbar-source";
import {
  MediaDialog,
  type MediaDialogLabels,
} from "@/components/wiki/media-dialog";
import { PreviewPane, type PreviewPaneLabels } from "@/components/wiki/preview-pane";
import { SyntaxHelp, type SyntaxHelpLabels } from "@/components/wiki/syntax-help";
import {
  TemplateDialog,
  type TemplateDialogLabels,
} from "@/components/wiki/template-dialog";
import {
  parseVersionBlock,
  VersionDialog,
  type VersionBlockDraft,
  type VersionDialogLabels,
} from "@/components/wiki/version-dialog";
import {
  VisualEditor,
  type VeAtomicSelection,
  type VisualEditorHandle,
  type VisualEditorLabels,
} from "@/components/wiki/visual-editor";
import { applyCommand, type EditorCommand } from "@/lib/editor-selection";
import { addVersionToPage } from "@/lib/visual-editor/version-branch";
import { dateTimeFormat, formatMessage } from "@/lib/i18n";
import { localePath, titleRouteHref, withQuery } from "@/lib/locale-path";
import { cn } from "@/lib/utils";
import type { VersionRegistryEntry } from "@/lib/version-branches";
import type {
  EditorChromeAction,
  EditorMode,
  SourceAction,
  VisualAction,
} from "@/lib/visual-editor/actions";
import { parseTemplateCall } from "@/lib/visual-editor/template-params";
import { namedRefsUsed } from "@/lib/wikitext-refs";

const PREVIEW_DEBOUNCE_MS = 600;
const CONTENT_ID = "editor-content";
/**
 * The find strip's query field. It has a stable id because the shortcut has to
 * reach it while the strip is already open — pressing Ctrl/Cmd+F twice puts the
 * caret back in the field everywhere else, and remounting the strip to do that
 * would throw away the replacement and the toggles halfway through a rename.
 */
const FIND_INPUT_ID = "editor-find-query";
/** Fandom remembers which surface you last used; so do we. */
const MODE_STORAGE_KEY = "hqhq-wiki:editor-mode";
/**
 * The page-tools rail is the only place categories can be edited (O14.4), so it
 * opens by default and stays wherever the author last put it — Fandom's own
 * editor has no persistent rail, and collapsing it is how you get that look.
 */
const RAIL_STORAGE_KEY = "hqhq-wiki:editor-rail";
/**
 * How long the buffer sits still before it is written to storage (§8.2).
 *
 * Longer than the visual surface's own 250 ms read, so a draft write is never
 * the thing that follows a keystroke: by the time this fires the buffer has
 * already been serialized once and the string is sitting in state.
 */
const DRAFT_DEBOUNCE_MS = 1000;

/* ------------------------------------------------------------------ */
/* Draft storage (§8.2) — every call guarded: private mode throws       */
/* ------------------------------------------------------------------ */

/**
 * Every draft row on this origin, for `draftOffer` to sift.
 *
 * The whole namespace rather than one key, because §8.2's warning case is a
 * draft filed under a revision this page has moved past: it can only be found
 * by looking. `localStorage` throws on the first access in private mode and in
 * browsers configured to block site data, so the failure is one empty list —
 * there is simply no draft, which is exactly what the caller does with it.
 */
function readDraftEntries(): DraftEntry[] {
  try {
    const store = window.localStorage;
    const out: DraftEntry[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key === null || !key.startsWith(DRAFT_KEY_PREFIX)) continue;
      const value = store.getItem(key);
      if (value !== null) out.push({ key, value });
    }
    return out;
  } catch {
    return [];
  }
}

/** Writes one draft; a full quota is not worth interrupting an edit for. */
function writeDraft(key: string, draft: StoredDraft): void {
  try {
    window.localStorage.setItem(key, serializeDraft(draft));
  } catch {
    // Quota, private mode, storage disabled. The buffer is still on screen.
  }
}

function removeDrafts(keys: readonly string[]): void {
  try {
    for (const key of keys) window.localStorage.removeItem(key);
  } catch {
    // As above: losing the ability to forget a draft costs nothing on screen.
  }
}

/**
 * When a draft was written, in the reader's own time zone — this is the one
 * timestamp in the app that is about *their* device rather than about the
 * wiki, so it is deliberately not `formatDateTime`'s UTC (read-view.ts). It is
 * only ever rendered on the client, so it cannot disagree with a server pass.
 */
function formatDraftTime(locale: string, savedAt: number): string {
  return dateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(savedAt),
  );
}

/**
 * A remembered editor preference (which surface, whether the rail is open).
 *
 * Reading `localStorage` during render would not match what the server drew, and
 * writing the answer back from an effect is a cascading render — so the stored
 * value arrives through `useSyncExternalStore`, whose server snapshot is the
 * default and whose client snapshot is the real one. React swaps them during
 * hydration on its own. The local override carries a choice made in *this* tab,
 * which `storage` events deliberately do not report.
 */
function subscribeToStorage(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Private mode, or storage disabled — the caller's default stands.
    return null;
  }
}

function useStoredPreference<T extends string>(
  key: string,
  fallback: T,
  parse: (raw: string | null) => T,
): [T, (next: T) => void] {
  const stored = useSyncExternalStore(
    subscribeToStorage,
    () => parse(readStored(key)),
    () => fallback,
  );
  const [override, setOverride] = useState<T | null>(null);
  const set = useCallback(
    (next: T) => {
      try {
        window.localStorage.setItem(key, next);
      } catch {
        // Not being able to remember the choice is not worth surfacing.
      }
      setOverride(next);
    },
    [key],
  );
  return [override ?? stored, set];
}

export interface EditorLabels {
  /** Small-caps line above the title: "Edit page" / "Create page". */
  eyebrow: string;
  /** The page name, shown as the editor's heading. */
  title: string;
  contentLabel: string;
  lineNumbers: string;
  summaryLabel: string;
  summaryPlaceholder: string;
  minorEdit: string;
  publish: string;
  saving: string;
  cancel: string;
  /** "{message}" = server error detail. */
  saveFailed: string;

  /* — never losing an edit (§8) — */

  draftTitle: string;
  /** "{when}" = when the draft was saved, in the reader's own time zone. */
  draftFound: string;
  /** "{revision}" = the revision the draft was written against (§8.2). */
  draftStale: string;
  /** The same, for a draft written before the page existed. */
  draftStaleNew: string;
  draftRestore: string;
  draftDiscard: string;
  discardTitle: string;
  discardBody: string;
  discardConfirm: string;
  discardKeep: string;
  /** `common.close` — the X on the dialogs this island owns directly. */
  close: string;
  licenseNotice: string;
  signInRequiredTitle: string;
  signInRequiredDescription: string;
  signInCta: string;
  /** Pre-formatted "Translating from the en article X" line, or null. */
  translatingNotice: string | null;
  headerCollapse: string;
  headerExpand: string;
  fullscreenEnter: string;
  fullscreenExit: string;
  railToggle: string;
  mode: EditorModeMenuLabels;
  /** Visual mode's `INSERT ▾`, back in the header (editor-insert-menu.tsx). */
  insertMenu: EditorInsertMenuLabels;
  sourceToolbar: SourceToolbarLabels;
  visual: VisualEditorLabels;
  /** "{label}" = the localized atomic kind, e.g. "template". */
  atomicDialogTitle: string;
  atomicDialog: AtomicDialogLabels;
  template: TemplateDialogLabels;
  media: MediaDialogLabels;
  versions: VersionDialogLabels;
  linkDialog: LinkDialogLabels;
  find: EditorFindLabels;
  /** The outline card of the page-tools column (§10.1). */
  outline: EditorOutlineLabels;
  /** Publish bar's live counts — "{count}", grouped for the reader's locale. */
  countWords: string;
  countCharacters: string;
  shortcuts: ShortcutsDialogLabels;
  rail: EditorRailLabels;
  /** Accessible names for the rail's quick-action buttons, keyed by id. */
  railQuickActions: Record<string, string>;
  versionBar: EditorVersionBarLabels;
  preview: PreviewPaneLabels;
  conflict: ConflictNoticeLabels;
  syntaxHelp: SyntaxHelpLabels;
}

export interface EditorProps {
  /** UI locale = content locale being edited (routes.md). */
  locale: string;
  /** `nsPrefix+slug` catch-all value, e.g. "template:infobox-moon". */
  titlePath: string;
  /** Display title for this locale (sent as displayTitle on save). */
  displayTitle: string;
  /** Full page name for {{PAGENAME}} in previews, e.g. "Template:Infobox moon". */
  previewTitle: string;
  initialContent: string;
  /** Head revision the source was loaded from; null when creating. */
  initialParentRevId: number | null;
  /** EN head this translation is based on (non-EN creates only), else null. */
  translatedFromRevId: number | null;
  /** The registry as the route loaded it, ordinal-ascending (versioning.md §1). */
  versions: VersionRegistryEntry[];
  defaultVersion: string;
  /**
   * The reader's `?v=` selection, when it names a registered version
   * (versioning.md §6). It seeds the version bar and rides along to the
   * article on Save/Cancel so a version-scoped reading survives an edit — the
   * create flow reaches the editor straight from an article URL (O14).
   */
  selectedVersion?: string | null;
  labels: EditorLabels;
}

interface ConflictState {
  currentRevId: number | null;
  currentText: string;
}

interface LinkDialogState {
  open: boolean;
  initial: LinkDialogValue | null;
  /** True when the caret was already inside a link, so Remove makes sense. */
  editing: boolean;
}

interface AtomicDialogState {
  open: boolean;
  selection: VeAtomicSelection | null;
  target: DialogTarget;
}

/**
 * Where a dialog's wikitext goes: over the atomic node the author opened, or at
 * the caret as a fresh insertion.
 */
type DialogTarget = "atomic" | "insert" | "replace";

/**
 * Where the template dialog should put what it builds: over the atomic node the
 * author double-clicked, or at the caret as a fresh insertion (§5.1).
 */
interface TemplateDialogState {
  open: boolean;
  /** The call being edited; null starts at the search step. */
  source: string | null;
  target: DialogTarget;
}

/**
 * The version-scope dialog's opening (versioning.md §6, visual-editor.md §5.3).
 *
 * `draft` is the block being reopened, already read back by
 * `parseVersionBlock`; null composes a new one. `body` is what the passage
 * starts from — the author's selection when they scoped one.
 */
interface VersionDialogState {
  open: boolean;
  draft: VersionBlockDraft | null;
  body: string;
  target: DialogTarget;
}

/**
 * A match the island has been asked to put on screen (§9).
 *
 * It carries the buffer its offsets index rather than reading state when the
 * effect runs: a replacement's offsets belong to the text the replacement
 * produced, and by the time an effect could read `content` it would be reading
 * whatever the surface has serialized since. It carries the mode for the same
 * reason — the surface that asked is the one that should scroll, so switching
 * modes later cannot re-run somebody else's scroll.
 */
interface RevealState {
  text: string;
  match: FindMatch;
  /** What stands at `match` now: the query, or a replacement just written. */
  needle: string;
  options: FindOptions;
  mode: EditorMode;
}

export function Editor({
  locale,
  titlePath,
  displayTitle,
  previewTitle,
  initialContent,
  initialParentRevId,
  translatedFromRevId,
  versions,
  defaultVersion,
  selectedVersion = null,
  labels,
}: EditorProps) {
  const router = useRouter();
  const { profile, error: authError, loading: authLoading, getIdToken } = useAuth();
  // The RESOLVED principal, not merely a Firebase user: a banned account signs
  // in fine (the ban lives in Firestore, not in Firebase Auth) and would only
  // find out at save, having written a revision the server always refuses.
  const canEdit = profile !== null && authError === null;

  const [content, setContent] = useState(initialContent);
  const [summary, setSummary] = useState("");
  const [minor, setMinor] = useState(false);
  const [parentRevId, setParentRevId] = useState<number | null>(initialParentRevId);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);

  /* — chrome — */
  const [mode, setStoredMode] = useStoredPreference<EditorMode>(
    MODE_STORAGE_KEY,
    "visual",
    (raw) => (raw === "source" ? "source" : "visual"),
  );
  /**
   * Bumped whenever `content` changed from OUTSIDE the visual surface (mode
   * switch, a category chip from the rail, a conflict rebase). The surface is
   * uncontrolled, so this is the only thing that makes it reload.
   */
  const [docKey, setDocKey] = useState(0);
  const [headerOpen, setHeaderOpen] = useState(true);
  const [railState, setRailState] = useStoredPreference<"open" | "closed">(
    RAIL_STORAGE_KEY,
    "open",
    (raw) => (raw === "closed" ? "closed" : "open"),
  );
  const railOpen = railState === "open";
  const [fullscreen, setFullscreen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [linkDialog, setLinkDialog] = useState<LinkDialogState>({
    open: false,
    initial: null,
    editing: false,
  });
  const [atomicDialog, setAtomicDialog] = useState<AtomicDialogState>({
    open: false,
    selection: null,
    target: "atomic",
  });
  const [templateDialog, setTemplateDialog] = useState<TemplateDialogState>({
    open: false,
    source: null,
    target: "insert",
  });
  const [mediaOpen, setMediaOpen] = useState(false);
  /**
   * A picture dropped or pasted onto the visual surface (visual-editor.md
   * §15). It rides *with* the open state so the dialog mounts already holding
   * it, and it is cleared on close so reopening the dialog by hand does not
   * upload yesterday's drop again.
   */
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  /* — find and replace (§9) — */
  const [findOpen, setFindOpen] = useState(false);
  /** What the strip opens with: whatever was selected when the key was pressed. */
  const [findSeed, setFindSeed] = useState("");
  const [reveal, setReveal] = useState<RevealState | null>(null);
  /**
   * The visual surface serializes on a debounce, so `content` — and therefore
   * `dirty` — trails the author by up to a quarter of a second. That is long
   * enough to type a word and hit Ctrl+Enter into a disabled button, so the
   * surface's raw `input` event arms publishing immediately and the reload
   * that follows a mode switch or an outside edit disarms it again.
   */
  const [visualTouched, setVisualTouched] = useState(false);
  const [versionDialog, setVersionDialog] = useState<VersionDialogState>({
    open: false,
    draft: null,
    body: "",
    target: "insert",
  });

  /**
   * A passage the `+` menu just added and wants the caret in. It cannot be
   * focused where it is asked for — the surface has not reloaded yet — so it
   * travels as state and is taken in an effect below.
   */
  const [focusBranch, setFocusBranch] = useState<{ id: string } | null>(null);

  /**
   * The draft offer (§8.2). `null` means storage has not been read yet, which
   * is not the same as "no draft": the read happens after mount, because the
   * server render has no `localStorage` and a banner painted from one would
   * not survive hydration.
   */
  const [draft, setDraft] = useState<DraftOffer | null>(null);
  /** Open while Cancel is asking whether to throw the buffer away (§8.1). */
  const [confirmLeave, setConfirmLeave] = useState(false);

  /**
   * Which block the visual caret stands in, counted the way `blockUnits` counts
   * them — what the outline marks the current section from (§10.1).
   *
   * It arrives already deduplicated: `onContextChange` fires only when the
   * surface's fingerprint changes and the block index is part of that
   * fingerprint, so this costs a render when the caret *crosses* a block and
   * never while it walks one.
   */
  const [visualBlock, setVisualBlock] = useState(-1);
  /**
   * The section the SOURCE caret is in, already resolved to an index.
   *
   * The offset itself is deliberately not state. React's `onSelect` fires on
   * every arrow key, and a render per arrow key is the per-keystroke cost §8
   * forbids; the section index changes only when the caret crosses a heading,
   * so storing that is what lets React bail out of nearly all of them.
   */
  const [sourceSection, setSourceSection] = useState(-1);

  /**
   * The named references the buffer already carries, so `CITE ▾` can offer to
   * cite one again instead of asking an author to remember a `name=` written
   * twenty paragraphs up (spec §10.3, src/lib/wikitext-refs.ts).
   *
   * Scanned here rather than in either toolbar for the reason the toolbars own
   * no document: they draw from reports. One scan therefore serves whichever
   * mode is on screen, and the two offer the same sources under the same
   * names. It tokenises the whole buffer and this island re-renders on every
   * keystroke, so — like the version bar's `versionsUsed` — the walk is
   * memoised on `content`.
   */
  const namedRefs = useMemo(() => namedRefsUsed(content), [content]);

  /**
   * The article's heading tree, and the block count a section move is checked
   * against (§10.1).
   *
   * One `parseDocument` per buffer change, memoised the way every other
   * buffer-derived list on this page is. It is measurably *cheaper* than any
   * one of the four `highlight()` scans this island already runs per keystroke
   * — the version bar's `versionsUsed`, the rail's `templatesUsed` and
   * `categoriesUsed`, and `namedRefs` above — so the map costs less than the
   * lists that were already there.
   */
  const outline = useMemo(() => documentOutline(content), [content]);

  /** The publish bar's live figures (§10.2): one pass, no allocation. */
  const counts = useMemo(() => countText(content), [content]);
  /**
   * Grouped digits, because "52480 characters" is a number nobody reads. A
   * locale this app serves need not be a valid BCP-47 tag, and `Intl` throws
   * on one that is not, so the platform default stands in rather than the
   * count disappearing.
   */
  const groupNumber = useMemo(() => {
    try {
      return new Intl.NumberFormat(locale);
    } catch {
      return new Intl.NumberFormat();
    }
  }, [locale]);

  // A `?v=` outside the registry is ignored rather than honored (§6).
  const carriedVersion =
    selectedVersion !== null && versions.some((option) => option.id === selectedVersion)
      ? selectedVersion
      : null;
  const [previewVersion, setPreviewVersion] = useState(carriedVersion ?? defaultVersion);
  /**
   * The registry, seeded from the route and owned here from then on: the
   * version bar lets an author register a boundary the page already names
   * (§6, decisions-v2 O16.2), and that new version has to reach the chips and
   * the dropdown without a reload — this page is an unsaved buffer, and a
   * reload to learn about `v72` would cost the edit that named it.
   */
  const [registry, setRegistry] = useState<VersionRegistryEntry[]>(() => [...versions]);
  const addRegisteredVersion = useCallback((entry: VersionRegistryEntry) => {
    setRegistry((current) => [...current.filter((row) => row.id !== entry.id), entry]);
  }, []);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewWarnings, setPreviewWarnings] = useState<string[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const visualRef = useRef<VisualEditorHandle | null>(null);
  /** Where the focus goes when the find strip closes (§9). */
  const findReturnRef = useRef<HTMLElement | null>(null);
  /**
   * How a replacement's outcome gets out of the transform `editContent` runs.
   * The transform has to be the thing that computes it — it is handed the text
   * read back off the *live* surface, and offsets from any older copy could
   * name a different span — so its by-product cannot be a return value.
   */
  const findOutcomeRef = useRef<FindApplyOutcome | null>(null);

  const articleHref = withQuery(titleRouteHref(locale, "wiki", titlePath), {
    v: carriedVersion && carriedVersion !== defaultVersion ? carriedVersion : undefined,
  });

  // A brand-new page has nothing to compare against, so any content at all
  // counts as a change worth saving.
  const dirty =
    content !== initialContent ||
    (initialParentRevId === null && content.trim() !== "") ||
    (mode === "visual" && visualTouched);

  /**
   * Whether the **author** has changed anything — which is not `dirty`, and
   * the difference is the whole "never on a page nobody touched" rule of §8.
   *
   * `dirty` also counts the text a brand-new page arrives prefilled with: the
   * translate flow seeds the buffer from the EN head (decisions O4), and that
   * has to enable Publish. But it came from the server, not from a keystroke,
   * so guarding it would warn on the way out of a page nobody typed into and
   * file a "draft" of somebody else's article.
   */
  const edited = content !== initialContent || (mode === "visual" && visualTouched);

  /* ---------------- mode ---------------- */

  const switchMode = useCallback(
    (next: EditorMode) => {
      if (next === mode) return;
      setStoredMode(next);
      // Both directions reload the visual surface from the shared buffer.
      setDocKey((key) => key + 1);
    },
    [mode, setStoredMode],
  );

  /**
   * Replace the buffer from outside the visual surface. Anything that edits
   * `content` without going through the contenteditable has to come through
   * here, or the surface and the buffer drift apart.
   */
  const replaceContent = useCallback((next: string) => {
    setContent(next);
    setVisualTouched(false);
    setDocKey((key) => key + 1);
  }, []);

  /**
   * Apply an edit made outside the editing surface — the rail's tag chips.
   * The base is read from the live surface rather than from `content`, which
   * the debounce can leave a keystroke or two behind; applying a tag to that
   * stale copy would quietly undo whatever was typed in the meantime.
   */
  const editContent = useCallback(
    (apply: (current: string) => string) => {
      const base = mode === "visual" ? (visualRef.current?.flush() ?? content) : content;
      replaceContent(apply(base));
    },
    [mode, content, replaceContent],
  );

  /* ---------------- never losing an edit (§8) ---------------- */

  /**
   * Whether the buffer is worth guarding, read from a listener that is bound
   * once. A `beforeunload` handler re-registered on every keystroke would be
   * exactly the per-keystroke cost §8 forbids, and re-registering is also how
   * such a listener leaks: the removal has to name the same function object,
   * and a new closure per render does not.
   */
  const editedRef = useRef(edited);
  /**
   * Set the moment this editor is deliberately being left — a successful
   * publish, or Cancel confirmed. It disarms the guard and, just as
   * importantly, the draft writer: a debounce armed a moment before Publish
   * would otherwise fire *after* the drafts were cleared and file the edit
   * again, so the next visit would offer back what was just published.
   */
  const leavingRef = useRef(false);

  useEffect(() => {
    editedRef.current = edited;
  });

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!editedRef.current || leavingRef.current) return;
      // Both, deliberately: `preventDefault` is what the spec reads, and a
      // non-empty `returnValue` is what engines older than it read. Neither
      // shows a message of ours — the browser prints its own sentence and
      // cannot be styled — which is why Cancel asks through a dialog of our
      // own instead (§8.1).
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  /** Forget every draft of this page, in this locale, at any revision (§8.2). */
  const clearDrafts = useCallback(() => {
    removeDrafts(draftKeysForPage(readDraftEntries(), { titlePath, locale }));
  }, [locale, titlePath]);

  /**
   * Look for a draft, once, after mount.
   *
   * Deferred by a tick rather than run in the effect body: the repo forbids a
   * synchronous `setState` there, and this read walks every row in storage —
   * work with no business on the path to first paint. It is also why the
   * banner cannot exist during the server render, and therefore why the
   * timestamp in it can be drawn in the reader's own time zone.
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      const identity = { titlePath, locale, parentRevId: initialParentRevId };
      setDraft(draftOffer(readDraftEntries(), identity, initialContent));
    }, 0);
    return () => clearTimeout(timer);
  }, [initialContent, initialParentRevId, locale, titlePath]);

  /**
   * Write the buffer down, on a debounce, while it differs from what was
   * loaded.
   *
   * `edited` is the whole guard against firing on a page nobody touched: a
   * reader who opens the editor and leaves stores nothing, so nobody is
   * offered an untouched article back as a "draft".
   */
  useEffect(() => {
    if (!canEdit || !edited) return;
    const timer = setTimeout(() => {
      if (leavingRef.current) return;
      writeDraft(
        draftKey({ titlePath, locale, parentRevId }),
        { content, savedAt: Date.now(), parentRevId },
      );
    }, DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [canEdit, content, edited, locale, parentRevId, titlePath]);

  /**
   * Take the draft. The row it came from goes with it: the debounce will file
   * the buffer again under this revision's own key within the second, and a
   * draft offered from an older revision must not stay behind to be offered a
   * second time (§8.2).
   */
  const restoreDraft = useCallback(() => {
    if (draft === null || draft.kind !== "offer") return;
    removeDrafts([draft.key]);
    replaceContent(draft.draft.content);
    setDraft({ kind: "none" });
  }, [draft, replaceContent]);

  const discardDraft = useCallback(() => {
    if (draft === null || draft.kind !== "offer") return;
    removeDrafts([draft.key]);
    setDraft({ kind: "none" });
  }, [draft]);

  /**
   * Cancel, on a buffer with changes in it: ask, in a dialog of ours (§8.1).
   * `window.confirm` is the alternative and it is not one — it cannot be
   * translated, cannot be themed, and blocks the whole tab.
   *
   * A modified click is left alone on purpose: Ctrl/Cmd/Shift-clicking the
   * link opens the article in another tab and leaves this editor exactly where
   * it is, so there is nothing to confirm.
   */
  const onCancelClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (!edited) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      setConfirmLeave(true);
    },
    [edited],
  );

  const leaveWithoutPublishing = useCallback(() => {
    leavingRef.current = true;
    // The dialog said the draft goes too, so it goes: a "discard" that quietly
    // kept the text and offered it back on the next visit would be a lie.
    clearDrafts();
    setConfirmLeave(false);
    router.push(articleHref);
  }, [articleHref, clearDrafts, router]);

  /* ---------------- source-mode commands ---------------- */

  /**
   * Read the live selection out of the textarea, run the pure command over it
   * (src/lib/editor-selection.ts) and restore the caret the transform asked
   * for. The textarea is the source of truth here rather than React state so
   * the caret is never a render behind.
   */
  const runCommand = useCallback((command: EditorCommand) => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    const next = applyCommand(
      { value: textarea.value, start: textarea.selectionStart, end: textarea.selectionEnd },
      command,
    );
    setContent(next.value);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el === null) return;
      el.focus();
      el.setSelectionRange(next.start, next.end);
    });
  }, []);

  /* ---------------- dialogs ---------------- */

  const openLinkDialog = useCallback(() => {
    if (mode === "source") {
      runCommand({
        kind: "wrap",
        before: "[[",
        after: "]]",
        placeholder: "Page name",
        toggle: true,
      });
      return;
    }
    const existing = visualRef.current?.selectedLink() ?? null;
    if (existing !== null) {
      setLinkDialog({ open: true, initial: existing, editing: true });
      return;
    }
    const selected = visualRef.current?.selectionText() ?? "";
    setLinkDialog({
      open: true,
      initial: selected === "" ? null : { target: "", text: selected },
      editing: false,
    });
  }, [mode, runCommand]);

  const closeLinkDialog = useCallback(
    () => setLinkDialog({ open: false, initial: null, editing: false }),
    [],
  );

  /**
   * Whatever the author has selected, as plain text — what the version dialog
   * seeds each branch with, so "make this differ in v62" starts from the
   * sentence they highlighted rather than from a placeholder.
   */
  const selectionText = useCallback((): string => {
    if (mode === "visual") return visualRef.current?.selectionText() ?? "";
    const textarea = textareaRef.current;
    if (textarea === null) return "";
    return textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
  }, [mode]);

  const toggleRail = useCallback(
    () => setRailState(railOpen ? "closed" : "open"),
    [railOpen, setRailState],
  );

  /**
   * Put a dialog's wikitext where it belongs. Replacing the node the author
   * opened is the editing case; inserting is the "Insert → …" case, which the
   * source surface has to do through its own selection commands.
   */
  const placeWikitext = useCallback(
    (source: string, target: DialogTarget) => {
      if (target === "atomic") {
        visualRef.current?.replaceAtomic(source);
        return;
      }
      // "replace" is for a dialog that was *seeded* with the selection — the
      // version dialog wraps the sentence the author highlighted, so leaving
      // that sentence in the buffer as well would publish it twice, once
      // unconditionally and once inside the version branch.
      const replacing = target === "replace";
      if (mode === "visual") {
        // An inline atomic replaces the range; a block one lands after it.
        visualRef.current?.applyAction({ kind: "insert", source, block: !replacing });
        return;
      }
      if (replacing) {
        runCommand({ kind: "insert", text: source });
        return;
      }
      runCommand({ kind: "wrap", before: source, block: true });
    },
    [mode, runCommand],
  );

  /**
   * A template call gets Fandom's parameter form and a version construct gets
   * the version-scope dialog; every other atomic node — tables, galleries, raw
   * HTML — is edited as wikitext, because there is no form to draw for it
   * (§5.1).
   *
   * The version case is the way back in. Without it a version block — an
   * atomic node like any other — opened as raw wikitext, so the author who
   * wanted to change the range they had just written had to hand-write the
   * markup that dialog exists to avoid. A block `parseVersionBlock` will not
   * take back is one it cannot rebuild without losing something, so that falls
   * through to source editing rather than rewriting somebody's page.
   */
  const openAtomicEditor = useCallback((selection: VeAtomicSelection) => {
    if (selection.atomic === "template" && parseTemplateCall(selection.source) !== null) {
      setTemplateDialog({ open: true, source: selection.source, target: "atomic" });
      return;
    }
    if (selection.atomic === "versions") {
      // A block atomic keeps its trailing gap outside `source`, but an inline
      // one can arrive padded; the parser wants the construct and nothing else.
      const draft = parseVersionBlock(selection.source.trim());
      if (draft !== null) {
        setVersionDialog({ open: true, draft, body: "", target: "atomic" });
        return;
      }
    }
    setAtomicDialog({ open: true, selection, target: "atomic" });
  }, []);

  const closeVersionDialog = useCallback(
    () => setVersionDialog({ open: false, draft: null, body: "", target: "insert" }),
    [],
  );

  /**
   * Compose a new version block from nothing — Insert → Version block, which
   * is where the questions only the dialog can ask are asked: which of §2.1's
   * three forms the tag takes, and over which versions (visual-editor.md §5.3).
   *
   * Seeded from a selection ⇒ the block stands in its place; seeded from
   * nothing ⇒ it is a new block of its own.
   */
  const openVersionDialog = useCallback(() => {
    const body = selectionText();
    setVersionDialog({ open: true, draft: null, body, target: body === "" ? "insert" : "replace" });
  }, [selectionText]);

  /**
   * Choose the branch the surfaces preview — the version strip's chips, and
   * the version the in-place branch field therefore holds (§6).
   *
   * **Flushes first.** The visual surface's branch field writes on a debounce,
   * so at the instant a chip is clicked the version being left may still be
   * holding keystrokes. Reading them out here means they are in the buffer
   * before anything repaints, which is the difference between "switch versions"
   * and "switch versions, losing the last word you typed".
   */
  const selectPreviewVersion = useCallback((id: string) => {
    visualRef.current?.flush();
    setPreviewVersion(id);
  }, []);

  /**
   * The version strip's `+`: give the page a passage for `id` and put the
   * author in it (§6, amended 2026-09-03).
   *
   * Adding a version to a page is one choice, so it is a menu rather than the
   * dialog — and what it writes is an *empty* `<vNN+>`, deliberately. The
   * dialog refuses to insert a blank block because such a block is finished and
   * renders nothing; this one is made in order to be typed into, and the field
   * that holds it is on screen (and focused) the moment it exists.
   *
   * `editContent` is the same path the rail's chips and the chip X take: it
   * reads the base off the live surface, so adding a version cannot revert
   * keystrokes the debounce has not published.
   */
  const addVersionBranch = useCallback(
    (id: string) => {
      editContent((current) => addVersionToPage(current, id));
      setPreviewVersion(id);
      // The field for the branch just made exists only once the surface has
      // reloaded from the new buffer, which it does in its own effect — so the
      // focus is asked for as state and taken below, where React's bottom-up
      // effect order guarantees the child has already rebuilt. A fresh object
      // every time, so adding the same version twice is two requests.
      setFocusBranch({ id });
    },
    [editContent],
  );

  /**
   * Put the caret in the branch the `+` menu just made (§6). Effects run
   * child-first, so the surface's document load — and with it the field — has
   * happened by the time this runs. The field scrolls itself into view, which
   * is what makes a block appended at the foot of a long page findable.
   */
  useEffect(() => {
    if (focusBranch === null) return;
    visualRef.current?.focusBranch(focusBranch.id);
  }, [focusBranch]);

  const closeTemplateDialog = useCallback(
    () => setTemplateDialog({ open: false, source: null, target: "insert" }),
    [],
  );

  const closeAtomicDialog = useCallback(
    () => setAtomicDialog({ open: false, selection: null, target: "atomic" }),
    [],
  );

  /* ---------------- find and replace (§9) ---------------- */

  /**
   * Whether a modal is up. The shortcut is bound to the *window* — a reader who
   * has not clicked into anything yet still expects Ctrl/Cmd+F to work — so this
   * is what keeps it from opening the strip behind a dialog and pulling the
   * focus out of a trap that dialog promised a screen reader (`aria-modal`).
   */
  const modalOpen =
    confirmLeave ||
    helpOpen ||
    shortcutsOpen ||
    linkDialog.open ||
    atomicDialog.open ||
    templateDialog.open ||
    mediaOpen ||
    versionDialog.open;

  /**
   * Ctrl/Cmd+F: open the strip, or put the caret back in its query field when
   * it is already open.
   *
   * Returns whether the key was taken, so the listener suppresses the browser's
   * own find only where this one answered — a shortcut swallowed while a dialog
   * is up would leave the reader with no find at all.
   *
   * The visual surface serializes on a debounce, so it is flushed on the way in:
   * the strip counts matches in `content`, and opening it on a buffer a quarter
   * of a second old would print a count for a sentence that has been finished
   * since. `setContent` is what the surface's own debounce calls, so this cannot
   * reload it or move the caret.
   */
  const onFindShortcut = useCallback((): boolean => {
    if (modalOpen) return false;
    if (findOpen) {
      const field = document.getElementById(FIND_INPUT_ID);
      if (field instanceof HTMLInputElement) {
        field.focus();
        field.select();
      }
      return true;
    }
    const active = document.activeElement;
    findReturnRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    if (mode === "visual") {
      const flushed = visualRef.current?.flush();
      if (flushed !== undefined && flushed !== content) setContent(flushed);
    }
    setFindSeed(seedQuery(selectionText()));
    setFindOpen(true);
    return true;
  }, [content, findOpen, modalOpen, mode, selectionText]);

  /**
   * The listener is bound once and reads a ref, the same shape §8.1's
   * `beforeunload` guard uses and for the same two reasons: re-binding per
   * render is how such a listener leaks (the removal has to name the same
   * function object), and the editor re-renders on every keystroke.
   */
  const findShortcutRef = useRef(onFindShortcut);
  useEffect(() => {
    findShortcutRef.current = onFindShortcut;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.defaultPrevented || event.key.toLowerCase() !== "f") return;
      if (findShortcutRef.current()) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /** Escape and the strip's own close: the focus goes back where it came from. */
  const closeFind = useCallback(() => {
    setFindOpen(false);
    const target = findReturnRef.current;
    findReturnRef.current = null;
    if (target !== null && target.isConnected) {
      target.focus();
      return;
    }
    // Nothing held the focus when the strip opened — the shortcut works from a
    // page that has just loaded — so it goes to the surface being edited.
    if (mode === "source") textareaRef.current?.focus();
    else visualRef.current?.focus();
  }, [mode]);

  const requestReveal = useCallback(
    (request: FindReveal) => {
      setReveal({ text: content, mode, ...request });
    },
    [content, mode],
  );

  /**
   * Apply one replacement, or all of them.
   *
   * Through `editContent`, like the rail's chips and the version strip's `+`:
   * it reads the base off the *live* surface, so a replacement can never revert
   * keystrokes the debounce has not published — and the transform recomputes the
   * match offsets against exactly that string, so they cannot name a span of an
   * older buffer.
   */
  const applyFind = useCallback(
    (request: FindApplyRequest): FindApplyOutcome => {
      // Seeded with "nothing happened", which is also the answer if a surface
      // that has gone away leaves the transform unrun.
      findOutcomeRef.current = { text: content, replaced: 0, landed: null };
      editContent((current) => {
        const applied = applyFindReplace(current, request);
        findOutcomeRef.current = applied;
        return applied.text;
      });
      const outcome = findOutcomeRef.current;
      if (outcome.landed !== null) {
        setReveal({
          text: outcome.text,
          match: outcome.landed,
          // What stands there now is the replacement, spelled exactly — so it
          // is looked for exactly, whatever the query's toggles were.
          needle: request.replacement,
          options: { caseSensitive: true, wholeWord: false },
          mode,
        });
      }
      return outcome;
    },
    [content, editContent, mode],
  );

  /**
   * Put the requested match on screen, once the surface holding it has been
   * rebuilt: effects run child-first, so a replacement's reload has already
   * happened by the time this runs.
   *
   * Neither branch writes anything into the document — a textarea selection and
   * a DOM Range are both made of what is already there — which is why §4 is
   * untouched by a search (`editor-find.ts` says why that mattered).
   *
   * The focus is handed back afterwards. Moving the document selection can move
   * the focus with it in some engines, and a strip whose next arrow typed into
   * the article instead would be worse than one that did not scroll at all.
   */
  useEffect(() => {
    if (reveal === null) return;
    const before = document.activeElement;
    const restore = before instanceof HTMLElement && before !== document.body ? before : null;

    if (reveal.mode === "source") {
      const textarea = textareaRef.current;
      if (textarea !== null) revealInTextarea(textarea, reveal.match);
    } else {
      const span = blockSpanAt(blockSpans(reveal.text), reveal.match.start);
      if (span !== null) {
        const hits = findMatches(reveal.text, reveal.needle, reveal.options);
        const index = hits.findIndex((hit) => hit.start === reveal.match.start);
        visualRef.current?.revealMatch({
          blockId: span.id,
          blockIndex: span.index,
          needle: reveal.needle,
          caseSensitive: reveal.options.caseSensitive,
          wholeWord: reveal.options.wholeWord,
          occurrence: index < 0 ? 0 : occurrenceInSpan(hits, span, index),
        });
      }
    }

    if (restore !== null && restore.isConnected && document.activeElement !== restore) {
      restore.focus();
    }
  }, [reveal]);

  /* ---------------- the outline (§10.1) ---------------- */

  /**
   * The section the caret is standing in, as an index into `outline.headings`.
   *
   * Derived here rather than stored, because the two surfaces report different
   * things and only one of them can afford to be asked often. The visual
   * surface reports a *block*, deduplicated for it, so the section is resolved
   * at render and can never be stale. The source textarea reports an *offset*
   * on every arrow key, so its section is resolved in the handler instead — the
   * price being an outline one keystroke old, which can only differ if a
   * heading was typed since, and typing moves the caret, which recomputes it.
   */
  const currentSection =
    mode === "visual" ? sectionAtBlock(outline.headings, visualBlock) : sourceSection;

  const onSourceCaret = useCallback(
    (offset: number) => {
      const next = sectionAtOffset(outline.headings, offset);
      setSourceSection((current) => (current === next ? current : next));
    },
    [outline],
  );

  /** A row was clicked: scroll to that heading and leave the caret in it. */
  const goToSection = useCallback(
    (index: number) => {
      const heading = outline.headings[index];
      if (heading === undefined) return;
      if (mode === "visual") {
        visualRef.current?.focusBlock(heading.id, heading.blockIndex);
        return;
      }
      const textarea = textareaRef.current;
      // No range means the buffer and its own parse disagree about their
      // lengths (`documentOutline` says when). Scrolling to a guess would be
      // worse than not scrolling.
      if (textarea === null || heading.range === null) return;
      revealInTextarea(textarea, heading.range);
      // `revealInTextarea` deliberately does not focus — the find strip keeps
      // the keyboard while it steps through hits — but this is the other
      // caller, and "put the caret there" is the whole of the request.
      textarea.focus();
      setSourceSection(index);
    },
    [mode, outline],
  );

  /**
   * Move a whole section among its siblings.
   *
   * The plan is recomputed against the text read back off the **live** surface,
   * for the reason `editContent` reads the same way: the visual surface
   * serializes on a debounce, and a plan computed from a buffer one keystroke
   * behind names the wrong blocks — and moving the wrong six paragraphs is far
   * worse than moving none. The clicked row is checked against that fresh
   * outline first: a heading that is no longer where the panel drew it is not
   * the heading the author asked about.
   *
   * Then the two surfaces part company, and the difference is §3.1's. The
   * visual surface *re-parents* the elements, so every block keeps its
   * `data-ve-id`, republishes from `source`, and the surface is not reloaded —
   * no caret lost, no atomic preview re-fetched. Source mode has no DOM to
   * re-parent, so it moves the blocks in the model and re-serializes, which is
   * byte-identical for everything except the joints (`applySectionMove`).
   */
  const moveSectionBy = useCallback(
    (index: number, direction: OutlineMoveDirection) => {
      if (!canEdit) return;
      const row = outline.headings[index];
      if (row === undefined) return;
      const base = mode === "visual" ? (visualRef.current?.flush() ?? content) : content;
      const fresh = base === content ? outline : documentOutline(base);
      const heading = fresh.headings[index];
      if (heading === undefined) return;
      if (heading.level !== row.level || heading.title !== row.title) return;
      const plan = sectionMovePlan(fresh.headings, index, direction, fresh.blockCount);
      if (plan === null) return;
      if (mode === "visual") visualRef.current?.moveSection(plan);
      else replaceContent(applySectionMove(base, plan));
    },
    [canEdit, content, mode, outline, replaceContent],
  );

  /* ---------------- toolbar routing ---------------- */

  const runChrome = useCallback(
    (action: EditorChromeAction): void => {
      switch (action.kind) {
        case "undo":
        case "redo":
          // The source textarea rides the browser's own undo stack, being
          // native. The visual surface is asked *through its handle* instead:
          // it keeps a stack of its own for the structural edits `execCommand`
          // never recorded (visual-editor.md §12), and it falls back to the
          // browser's when that one is empty — which it is for all of an
          // ordinary typing session.
          if (mode === "source") {
            textareaRef.current?.focus();
            document.execCommand(action.kind);
            return;
          }
          visualRef.current?.focus();
          visualRef.current?.applyAction({ kind: action.kind });
          return;
        case "help":
          setHelpOpen(true);
          return;
        case "toggleRail":
          toggleRail();
          return;
        case "link":
          openLinkDialog();
          return;
        case "media":
          setMediaFile(action.file ?? null);
          setMediaOpen(true);
          return;
        case "versions":
          openVersionDialog();
          return;
        case "template":
          // Fandom never inserts bare braces: Insert → Template is the search
          // and the parameter form (§5.1). A name arrives with the action when
          // the author already picked one in the `{{` panel (§13), and it
          // opens the form on that template rather than on the search step.
          setTemplateDialog({
            open: true,
            source: action.name === undefined ? null : `{{${action.name}}}`,
            target: "insert",
          });
          return;
      }
    },
    [mode, openLinkDialog, openVersionDialog, toggleRail],
  );

  /**
   * The actions the visual surface cannot apply itself, raised from its slash
   * menu and its bubble menu exactly as the retired toolbar raised them (§1).
   * Everything else never leaves the surface: it owns the caret, so it applies
   * its own formats, lists, inserts and table edits without asking.
   */
  const onVisualChrome = useCallback(
    (action: EditorChromeAction) => runChrome(action),
    [runChrome],
  );

  /**
   * The header Insert menu's two halves (editor-insert-menu.tsx): what the
   * caret can take, and what choosing a row does.
   *
   * Both are the surface's own answers rather than a second implementation
   * here — `runAction` is the very function the slash menu calls, so a
   * construct inserted from the header and one inserted from "/" go in
   * identically, dialogs included.
   */
  const insertMenuItems = useCallback(() => visualRef.current?.insertItems() ?? [], []);

  const onInsertAction = useCallback((action: VisualAction) => {
    visualRef.current?.runAction(action);
  }, []);

  const onSourceAction = useCallback(
    (action: SourceAction) => {
      switch (action.kind) {
        case "undo":
        case "redo":
        case "help":
        case "toggleRail":
        case "link":
        case "media":
        case "template":
        case "versions":
          runChrome(action);
          return;
        case "command":
          runCommand(action.command);
          return;
      }
    },
    [runChrome, runCommand],
  );

  /* ---------------- debounced live preview ---------------- */

  useEffect(() => {
    // The visual surface *is* the preview, so the pane (and its request) only
    // exist in source mode.
    if (!canEdit || mode !== "source") return;
    // All setState happens inside the debounce callback (never synchronously
    // in the effect body) so typing cannot trigger cascading renders.
    const timer = setTimeout(() => {
      if (content.trim() === "") {
        setPreviewHtml(null);
        setPreviewWarnings([]);
        setPreviewLoading(false);
        return;
      }
      setPreviewLoading(true);
      void (async () => {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        try {
          // /api/preview is public (O15) — no Authorization header at all.
          const res = await fetch("/api/preview", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              wikitext: content,
              title: previewTitle,
              locale,
              version: previewVersion,
            }),
            signal: controller.signal,
          });
          if (!res.ok) {
            setPreviewError(true);
            return;
          }
          const data = (await res.json()) as { html: string; meta: { warnings: string[] } };
          setPreviewHtml(data.html);
          setPreviewWarnings(data.meta.warnings ?? []);
          setPreviewError(false);
        } catch (err) {
          if (!(err instanceof DOMException && err.name === "AbortError")) {
            setPreviewError(true);
          }
        } finally {
          if (abortRef.current === controller) setPreviewLoading(false);
        }
      })();
    }, PREVIEW_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [canEdit, mode, content, previewVersion, previewTitle, locale]);

  /* ---------------- publish ---------------- */

  const publish = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    // The visual surface serializes on a debounce, so ask it for the buffer as
    // of *now* rather than trusting a state update that may not have landed.
    const payload = mode === "visual" ? (visualRef.current?.flush() ?? content) : content;
    try {
      // A null token means signed out: send no Authorization header at all
      // (an empty one reads as a malformed credential) and let the guard 401.
      const token = await getIdToken();
      const res = await fetch(`/api/pages/${titlePath}`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          locale,
          content: payload,
          comment: summary || undefined,
          minor,
          parentRevId,
          displayTitle,
          // undefined is dropped by JSON.stringify → the server derives the
          // EN basis itself for non-EN saves (decisions O4).
          translatedFromRevId: translatedFromRevId ?? undefined,
        }),
      });

      if (res.ok) {
        // Published: the buffer is now the article, so the guard stands down
        // and every draft of this page — at any revision — is obsolete (§8.2).
        leavingRef.current = true;
        clearDrafts();
        router.push(articleHref);
        router.refresh();
        return;
      }

      const body = (await res.json().catch(() => null)) as {
        error?: { code?: string; message?: string; currentRevId?: number | null };
      } | null;

      if (res.status === 409 && body?.error?.code === "edit-conflict") {
        // Load the head that beat us so the author can merge by hand.
        const src = (await fetch(
          `/api/pages/${titlePath}?locale=${encodeURIComponent(locale)}`,
          { cache: "no-store" },
        )
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)) as {
          pageLocale?: { currentRevId: number | null } | null;
          revision?: { content: string } | null;
        } | null;
        const currentRevId =
          src?.pageLocale?.currentRevId ?? body.error.currentRevId ?? null;
        setConflict({ currentRevId, currentText: src?.revision?.content ?? "" });
        setParentRevId(currentRevId);
        return;
      }

      setSaveError(
        formatMessage(labels.saveFailed, {
          message: body?.error?.message ?? `HTTP ${res.status}`,
        }),
      );
    } catch {
      setSaveError(formatMessage(labels.saveFailed, { message: "network error" }));
    } finally {
      setSaving(false);
    }
  }, [
    mode,
    content,
    getIdToken,
    titlePath,
    locale,
    summary,
    minor,
    parentRevId,
    displayTitle,
    translatedFromRevId,
    router,
    articleHref,
    clearDrafts,
    labels.saveFailed,
  ]);

  const canSave = canEdit && dirty && !saving;

  /* ---------------- keyboard ---------------- */

  /** Ctrl/Cmd+Enter saves from anywhere inside the editor (spec §6). */
  const onEditorKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canSave) {
        event.preventDefault();
        void publish();
      }
    },
    [canSave, publish],
  );

  /** Ctrl/Cmd+B / +I / +K on the source surface (Fandom's shortcuts). */
  const onSourceKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "b") {
        event.preventDefault();
        runCommand({ kind: "wrap", before: "'''", after: "'''", placeholder: "bold", toggle: true });
      } else if (key === "i") {
        event.preventDefault();
        runCommand({ kind: "wrap", before: "''", after: "''", placeholder: "italic", toggle: true });
      } else if (key === "k") {
        event.preventDefault();
        runCommand({
          kind: "wrap",
          before: "[[",
          after: "]]",
          placeholder: "Page name",
          toggle: true,
        });
      }
    },
    [runCommand],
  );

  /* ---------------- render ---------------- */

  const atomicLabel =
    atomicDialog.selection === null
      ? ""
      : labels.visual.kinds[atomicDialog.selection.atomic];

  return (
    <div
      onKeyDown={onEditorKeyDown}
      className={cn(
        "flex flex-col gap-4",
        // Fandom's expand button takes the editor out of the article column
        // and gives it the whole viewport.
        fullscreen && "fixed inset-0 z-40 overflow-y-auto bg-canvas p-4 lg:p-6",
      )}
    >
      <div className="flex min-w-0 gap-3">
        {/* — the floating left rail Fandom pins to the page edge — */}
        <div className="hidden shrink-0 flex-col gap-2 pt-1 md:flex">
          <button
            type="button"
            aria-pressed={fullscreen}
            title={fullscreen ? labels.fullscreenExit : labels.fullscreenEnter}
            aria-label={fullscreen ? labels.fullscreenExit : labels.fullscreenEnter}
            onClick={() => setFullscreen((on) => !on)}
            className={cn(
              "focus-ring inline-flex size-9 items-center justify-center rounded-full border border-hairline transition-colors",
              fullscreen
                ? "bg-primary text-on-primary"
                : "bg-surface text-mute hover:bg-canvas-soft hover:text-ink",
            )}
          >
            <FullscreenIcon />
          </button>
          <button
            type="button"
            aria-pressed={railOpen}
            title={labels.railToggle}
            aria-label={labels.railToggle}
            onClick={toggleRail}
            className={cn(
              "focus-ring inline-flex size-9 items-center justify-center rounded-full border border-hairline transition-colors",
              railOpen
                ? "bg-primary text-on-primary"
                : "bg-surface text-mute hover:bg-canvas-soft hover:text-ink",
            )}
          >
            <BookmarkIcon />
          </button>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {/* — header strip — */}
          <header className="flex flex-wrap items-start justify-between gap-3">
            {headerOpen ? (
              <div className="min-w-0">
                <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-mute">
                  {labels.eyebrow}
                </p>
                <h1 className="min-w-0 truncate text-2xl font-semibold tracking-[-0.03em] text-ink">
                  {labels.title}
                </h1>
              </div>
            ) : (
              <h1 className="min-w-0 truncate text-base font-semibold tracking-[-0.02em] text-ink">
                {labels.title}
              </h1>
            )}

            <div className="flex items-center gap-2">
              {/* Visual mode's one control above the writing area. Source mode
                  has its own toolbar below the header, which already carries
                  `INSERT ▾`; a second one here would be the same menu twice. */}
              {mode === "visual" ? (
                <EditorInsertMenu
                  items={insertMenuItems}
                  disabled={!canEdit}
                  onSelect={onInsertAction}
                  labels={labels.insertMenu}
                />
              ) : null}
              <EditorModeMenu
                mode={mode}
                onModeChange={switchMode}
                onUserGuide={() => setHelpOpen(true)}
                onShortcuts={() => setShortcutsOpen(true)}
                labels={labels.mode}
              />
              <button
                type="button"
                aria-expanded={headerOpen}
                title={headerOpen ? labels.headerCollapse : labels.headerExpand}
                aria-label={headerOpen ? labels.headerCollapse : labels.headerExpand}
                onClick={() => setHeaderOpen((open) => !open)}
                className="focus-ring inline-flex size-8 items-center justify-center rounded-[var(--radius-sm)] text-mute transition-colors hover:bg-canvas-soft hover:text-ink"
              >
                {headerOpen ? <ChevronUpIcon /> : <ChevronDownIcon />}
              </button>
            </div>
          </header>

          {!authLoading && !canEdit ? (
            <StatusBanner tone="info" title={labels.signInRequiredTitle}>
              {labels.signInRequiredDescription}{" "}
              <ButtonLink
                href={localePath(locale, "/login")}
                variant="primary"
                size="sm"
                className="ml-2 align-middle"
              >
                {labels.signInCta}
              </ButtonLink>
            </StatusBanner>
          ) : null}

          {labels.translatingNotice ? (
            <StatusBanner tone="info">{labels.translatingNotice}</StatusBanner>
          ) : null}

          {conflict ? (
            <ConflictNotice
              yourText={content}
              currentText={conflict.currentText}
              labels={labels.conflict}
            />
          ) : null}

          {/* §8.2: a draft this browser is holding. A stale one — written
              against a revision this page has moved past — is drawn as a
              warning and says so, because restoring it writes over whoever
              published in between. */}
          {draft !== null && draft.kind === "offer" ? (
            <StatusBanner
              tone={draft.stale ? "warning" : "info"}
              title={labels.draftTitle}
            >
              {formatMessage(labels.draftFound, {
                when: formatDraftTime(locale, draft.draft.savedAt),
              })}
              {draft.stale
                ? ` ${
                    draft.draft.parentRevId === null
                      ? labels.draftStaleNew
                      : formatMessage(labels.draftStale, {
                          revision: String(draft.draft.parentRevId),
                        })
                  }`
                : null}
              <span className="mt-2 flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={restoreDraft}>
                  {labels.draftRestore}
                </Button>
                <Button variant="ghost" size="sm" onClick={discardDraft}>
                  {labels.draftDiscard}
                </Button>
              </span>
            </StatusBanner>
          ) : null}

          <div
            className={cn(
              "grid min-w-0 gap-4",
              railOpen ? "lg:grid-cols-[minmax(0,1fr)_18rem]" : "grid-cols-1",
            )}
          >
            <div className="flex min-w-0 flex-col gap-3">
              {/* Source mode keeps its toolbar: it is a code editor, and the
                  Notion model this editor adopted on 2026-09-04 has no opinion
                  about those. Visual mode has none at all — the writing area is
                  bare, and what replaces the row's discoverability is the hint
                  in an empty focused paragraph and the slash menu it names
                  (visual-editor.md §1). */}
              {mode === "source" ? (
                <SourceToolbar
                  labels={labels.sourceToolbar}
                  disabled={!canEdit}
                  namedRefs={namedRefs}
                  onAction={onSourceAction}
                />
              ) : null}

              {/* §6: the author gets the reader's control, above the editing
                  surface, in BOTH modes — one strip that picks the branch the
                  visual surface repaints at and the preview pane renders, and
                  the only place a version's writing is added or dropped. Both
                  edits go through `editContent` like the rail's: it reads the
                  base off the live surface, so neither can revert keystrokes
                  the debounce has not published. */}
              <EditorVersionBar
                content={content}
                registry={registry}
                selected={previewVersion}
                onSelect={selectPreviewVersion}
                onContentChange={editContent}
                onAddVersion={addVersionBranch}
                onRegistered={addRegisteredVersion}
                getIdToken={getIdToken}
                disabled={!canEdit}
                labels={labels.versionBar}
              />

              {/* §9: one strip for both modes, because it searches the buffer
                  rather than a surface. It sits directly above the thing it
                  acts on, and it is not modal — the article stays editable
                  while it is open, which is what makes "replace, look, replace"
                  one motion. */}
              {findOpen ? (
                <EditorFindPanel
                  text={content}
                  initialQuery={findSeed}
                  inputId={FIND_INPUT_ID}
                  readOnly={!canEdit}
                  onClose={closeFind}
                  onReveal={requestReveal}
                  onApply={applyFind}
                  labels={labels.find}
                />
              ) : null}

              {mode === "visual" ? (
                // `input` bubbles out of the contenteditable, which is the only
                // signal that arrives before the surface's debounce — see
                // `visualTouched`.
                <div className="contents" onInput={() => setVisualTouched(true)}>
                <VisualEditor
                  ref={visualRef}
                  content={content}
                  docKey={docKey}
                  onContentChange={setContent}
                  onEditAtomic={openAtomicEditor}
                  onContextChange={({ blockIndex }) => setVisualBlock(blockIndex)}
                  onChromeAction={onVisualChrome}
                  namedRefs={namedRefs}
                  dialogOpen={modalOpen}
                  readOnly={!canEdit}
                  locale={locale}
                  previewTitle={previewTitle}
                  version={previewVersion}
                  labels={labels.visual}
                  className={fullscreen ? "min-h-[60vh]" : "min-h-[28rem]"}
                />
                </div>
              ) : (
                <div className="grid min-w-0 gap-4 xl:grid-cols-2">
                  <div className="min-w-0">
                    <Label htmlFor={CONTENT_ID} className="sr-only">
                      {labels.contentLabel}
                    </Label>
                    <EditorSource
                      id={CONTENT_ID}
                      value={content}
                      onChange={setContent}
                      textareaRef={textareaRef}
                      readOnly={!canEdit}
                      ariaLabel={labels.contentLabel}
                      lineNumbersLabel={labels.lineNumbers}
                      onKeyDown={onSourceKeyDown}
                      onCaretChange={onSourceCaret}
                      className="h-[26rem] lg:h-[34rem]"
                    />
                  </div>

                  <PreviewPane
                    // The preview scrolls on its own so the page does not grow
                    // past the source surface next to it.
                    surfaceClassName="h-[26rem] overflow-y-auto lg:h-[34rem]"
                    html={canEdit ? previewHtml : null}
                    warnings={previewWarnings}
                    loading={previewLoading}
                    error={previewError}
                    labels={labels.preview}
                  />
                </div>
              )}

              {/* — publish bar — */}
              <div className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-hairline bg-canvas-soft p-3">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <Label htmlFor="editor-summary">{labels.summaryLabel}</Label>
                    <Input
                      id="editor-summary"
                      value={summary}
                      disabled={!canEdit}
                      maxLength={500}
                      placeholder={labels.summaryPlaceholder}
                      onChange={(event) => setSummary(event.target.value)}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    {/* Still a link — a middle click or Ctrl+click opens the
                        article beside the editor and loses nothing — but a
                        plain click on a dirty buffer asks first (§8.1). */}
                    <ButtonLink
                      href={articleHref}
                      variant="secondary"
                      size="md"
                      onClick={onCancelClick}
                    >
                      {labels.cancel}
                    </ButtonLink>
                    <Button disabled={!canSave} onClick={() => void publish()}>
                      {saving ? labels.saving : labels.publish}
                    </Button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <label className="flex items-center gap-2 text-sm text-body">
                    <input
                      type="checkbox"
                      checked={minor}
                      disabled={!canEdit}
                      onChange={(event) => setMinor(event.target.checked)}
                      className="focus-ring size-4 accent-[var(--link)]"
                    />
                    {labels.minorEdit}
                  </label>

                  {/* §10.2: how long the page is, live. Not a live region —
                      a figure re-announced on every keystroke would talk over
                      the article being written. In visual mode it follows the
                      surface's serialize debounce, which is what makes it free:
                      it is derived from the buffer, never from a keystroke. */}
                  <p className="text-xs tabular-nums text-mute">
                    {formatMessage(labels.countWords, {
                      count: groupNumber.format(counts.words),
                    })}
                    <span aria-hidden className="px-1.5 text-faint">
                      ·
                    </span>
                    {formatMessage(labels.countCharacters, {
                      count: groupNumber.format(counts.characters),
                    })}
                  </p>
                </div>

                {/* hidden parentRevId — the optimistic-lock token (routes.md) */}
                <input type="hidden" name="parentRevId" value={parentRevId ?? ""} />

                {saveError ? <FieldMessage tone="error">{saveError}</FieldMessage> : null}

                <p className="text-xs text-faint">{labels.licenseNotice}</p>
              </div>
            </div>

            {railOpen ? (
              <div className="flex min-w-0 flex-col gap-4">
                {/* §10.1: the map lives in the page-tools column, as its first
                    card — the column the layout already gives to facts about
                    the page, so the writing column loses none of its width to
                    it. Above the rail's own card rather than inside it, because
                    the rail folds its sections away and an author who folds
                    them wants the map more, not less. */}
                <EditorOutlinePanel
                  headings={outline.headings}
                  current={currentSection}
                  readOnly={!canEdit}
                  onSelect={goToSection}
                  onMove={moveSectionBy}
                  labels={labels.outline}
                />
                <EditorRail
                  locale={locale}
                  content={content}
                  onContentChange={editContent}
                  onCommand={runCommand}
                  disabled={!canEdit}
                  commandsDisabled={mode === "visual"}
                  version={previewVersion}
                  parentRevId={parentRevId}
                  labels={labels.rail}
                  quickActionLabels={labels.railQuickActions}
                />
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <Dialog
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        title={labels.discardTitle}
        closeLabel={labels.close}
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-body">{labels.discardBody}</p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setConfirmLeave(false)}>
              {labels.discardKeep}
            </Button>
            <Button variant="danger" size="sm" onClick={leaveWithoutPublishing}>
              {labels.discardConfirm}
            </Button>
          </div>
        </div>
      </Dialog>

      <SyntaxHelp open={helpOpen} onClose={() => setHelpOpen(false)} labels={labels.syntaxHelp} />

      <ShortcutsDialog
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        labels={labels.shortcuts}
      />

      <LinkDialog
        open={linkDialog.open}
        initial={linkDialog.initial}
        locale={locale}
        onClose={closeLinkDialog}
        onApply={(value) => {
          visualRef.current?.applyLink(value);
          closeLinkDialog();
        }}
        onRemove={() => {
          if (linkDialog.editing) visualRef.current?.applyLink(null);
          closeLinkDialog();
        }}
        labels={labels.linkDialog}
      />

      <MediaDialog
        open={mediaOpen}
        initialFile={mediaFile}
        onClose={() => {
          setMediaOpen(false);
          setMediaFile(null);
        }}
        onApply={(source) => {
          placeWikitext(source, "insert");
          setMediaOpen(false);
          setMediaFile(null);
        }}
        getIdToken={getIdToken}
        labels={labels.media}
      />

      <VersionDialog
        open={versionDialog.open}
        initialDraft={versionDialog.draft}
        // A new block starts at the version on screen: "this changed at the
        // patch I am looking at" is what an author opens this dialog to say.
        initialVersion={previewVersion}
        initialBody={versionDialog.body}
        onClose={closeVersionDialog}
        onApply={(source) => {
          placeWikitext(source, versionDialog.target);
          closeVersionDialog();
        }}
        getIdToken={getIdToken}
        labels={labels.versions}
      />

      <AtomicDialog
        open={atomicDialog.open}
        label={atomicLabel}
        source={atomicDialog.selection?.source ?? ""}
        onClose={closeAtomicDialog}
        onApply={(next) => {
          placeWikitext(next, atomicDialog.target);
          closeAtomicDialog();
        }}
        labels={{
          ...labels.atomicDialog,
          title: formatMessage(labels.atomicDialogTitle, { label: atomicLabel }),
        }}
      />

      <TemplateDialog
        open={templateDialog.open}
        initialSource={templateDialog.source}
        locale={locale}
        previewTitle={previewTitle}
        version={previewVersion}
        onClose={closeTemplateDialog}
        onApply={(next) => {
          placeWikitext(next, templateDialog.target);
          closeTemplateDialog();
        }}
        onEditSource={(next) => {
          // The form's escape hatch: keep the destination, swap the editor.
          const target = templateDialog.target;
          closeTemplateDialog();
          setAtomicDialog({
            open: true,
            target,
            selection: {
              source: next,
              atomic: "template",
              label: labels.visual.kinds.template,
            },
          });
        }}
        labels={labels.template}
      />
    </div>
  );
}
