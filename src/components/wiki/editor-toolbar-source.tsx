"use client";

/**
 * The source surface's toolbar — docs/engine/visual-editor.md §1 ("Toolbars"),
 * in Fandom's group order:
 *
 *   undo · redo ‖ B · I · U · S · link · media · gallery · template ‖
 *   INSERT ▾ ‖ CITE ▾ ‖ Ω ▾ ‖ T ADVANCED ▾ ‖ ☰
 *
 * Selection work is still the `EditorCommand` language the textarea has always
 * understood (src/lib/editor-selection.ts, unit-tested there): the toolbar
 * emits a command, the editor island runs it over the live selection and
 * restores the caret. `SourceAction` only wraps that so the four things which
 * are *not* selection surgery — undo/redo, the link and media dialogs, the
 * syntax help, the rail — can ride the same channel.
 *
 * The wikitext snippets are imported from the visual toolbar rather than
 * copied: both modes must insert the byte-identical construct, and the split
 * `before | placeholder | after` shape exists precisely so this mode can leave
 * the caret on the word an author will overwrite. `CITE ▾`'s re-use rows come
 * across the same way — the buffer's named references arrive as a report from
 * the editor island, and `citeReuseRows` turns them into the same rows the
 * visual toolbar draws, so switching modes changes neither which sources are
 * offered nor the tag that gets written.
 *
 * Grammar references are to docs/engine/wikitext-spec.md: §1.1 emphasis,
 * §2 headings, §4 lists, §5 links/files, §7 tables, §8 templates, §10 extension
 * tags; the version tag is versioning.md §2.1.
 */

import { useCallback, useState, type ReactNode } from "react";

import {
  AdvancedIcon,
  BoldIcon,
  BulletListIcon,
  CalendarIcon,
  CommentIcon,
  GalleryIcon,
  HelpIcon,
  IndentIcon,
  InfoboxIcon,
  ItalicIcon,
  LinkIcon,
  MediaIcon,
  MenuIcon,
  NowikiIcon,
  NumberListIcon,
  OmegaIcon,
  ParagraphIcon,
  QuoteIcon,
  RedirectIcon,
  RedoIcon,
  RuleIcon,
  StrikethroughIcon,
  TableIcon,
  TabsIcon,
  TemplateIcon,
  UnderlineIcon,
  UndoIcon,
  UnlinkIcon,
  VersionsIcon,
} from "@/components/wiki/editor-icons";
import {
  MenuItem,
  MenuSeparator,
  ToolButton,
  ToolbarDivider,
  ToolbarGroup,
  ToolbarMenu,
  ToolbarRow,
} from "@/components/wiki/editor-menu";
import {
  citeReuseRows,
  GALLERY_SNIPPET,
  INFOBOX_SNIPPET,
  REFERENCES_SNIPPET,
  REF_NAMED_SNIPPET,
  REF_SNIPPET,
  RULE_SNIPPET,
  SPECIAL_CHARACTERS,
  TABBER_SNIPPET,
  TABLE_SNIPPET,
  todayStamp,
} from "@/components/wiki/editor-toolbar-visual";
import type { EditorCommand, HeadingLevel } from "@/lib/editor-selection";
import { formatMessage } from "@/lib/i18n";
import type { SourceAction } from "@/lib/visual-editor/actions";
import type { NamedRef } from "@/lib/wikitext-refs";

/* ------------------------------------------------------------------ */
/* Labels                                                              */
/* ------------------------------------------------------------------ */

export interface SourceToolbarLabels {
  /** Accessible name of the `role="toolbar"` row. */
  toolbarLabel: string;
  undo: string;
  redo: string;
  bold: string;
  italic: string;
  underline: string;
  strikethrough: string;
  link: string;
  /** Strips the brackets around the selection — lives in `ADVANCED ▾`. */
  unlink: string;
  media: string;
  gallery: string;
  template: string;
  insert: string;
  insertGallery: string;
  insertTable: string;
  insertTemplate: string;
  insertInfobox: string;
  insertVersions: string;
  insertTabber: string;
  insertRule: string;
  insertDate: string;
  cite: string;
  citeBasic: string;
  citeNamed: string;
  citeList: string;
  /** Heading over the rows that cite a source the page already cites. */
  citeReuse: string;
  specialCharacters: string;
  advanced: string;
  /** Group heading over the heading levels inside `ADVANCED ▾`. */
  heading: string;
  headingParagraph: string;
  /** "{level}" = 2…5. */
  headingLevel: string;
  bulletList: string;
  numberedList: string;
  indent: string;
  nowiki: string;
  comment: string;
  redirect: string;
  help: string;
  /** The trailing `☰`, which toggles the page-tools rail. */
  more: string;
}

export interface SourceToolbarProps {
  labels: SourceToolbarLabels;
  disabled?: boolean;
  /**
   * The named references the buffer already carries, so `CITE ▾` can offer to
   * cite one again — the same list, from the same scan, that the visual
   * toolbar is given, because switching modes must not change which sources
   * an author can reach.
   */
  namedRefs?: readonly NamedRef[];
  onAction: (action: SourceAction) => void;
}

/* ------------------------------------------------------------------ */
/* Menu contents (wikitext — never localized)                          */
/* ------------------------------------------------------------------ */

/** The UI offers h2…h5; `0` is the "no heading" row (spec §2). */
const HEADING_LEVELS: HeadingLevel[] = [2, 3, 4, 5];

/** A factory when the snippet depends on the moment it is inserted. */
type CommandItem =
  | {
      key: keyof SourceToolbarLabels;
      icon: ReactNode;
      command: EditorCommand | (() => EditorCommand);
    }
  /**
   * Template opens the dialog rather than dropping braces at the caret, so the
   * source editor gets Fandom's parameter form too (visual-editor.md §5.1).
   */
  | { key: keyof SourceToolbarLabels; icon: ReactNode; action: SourceAction };

/**
 * `INSERT ▾` carries the same constructs as the visual toolbar's, so an author
 * who switches modes finds the same menu. Gallery and template appear twice —
 * here and as buttons in the emphasis run — which is Fandom's own duplication:
 * the buttons are the shortcut, the menu is the inventory.
 */
const INSERT_ITEMS: CommandItem[] = [
  {
    key: "insertGallery",
    icon: <GalleryIcon />,
    command: { kind: "wrap", before: GALLERY_SNIPPET, block: true },
  },
  {
    key: "insertTable",
    icon: <TableIcon />,
    command: { kind: "wrap", ...TABLE_SNIPPET, block: true },
  },
  { key: "insertTemplate", icon: <TemplateIcon />, action: { kind: "template" } },
  {
    key: "insertInfobox",
    icon: <InfoboxIcon />,
    command: { kind: "wrap", before: INFOBOX_SNIPPET, block: true },
  },
  { key: "insertVersions", icon: <VersionsIcon />, action: { kind: "versions" } },
  {
    key: "insertTabber",
    icon: <TabsIcon />,
    command: { kind: "wrap", before: TABBER_SNIPPET, block: true },
  },
  {
    key: "insertRule",
    icon: <RuleIcon />,
    command: { kind: "wrap", before: RULE_SNIPPET, block: true },
  },
  {
    key: "insertDate",
    icon: <CalendarIcon />,
    command: () => ({ kind: "insert", text: todayStamp() }),
  },
];

const CITE_ITEMS: CommandItem[] = [
  { key: "citeBasic", icon: <QuoteIcon />, command: { kind: "wrap", ...REF_SNIPPET } },
  { key: "citeNamed", icon: <QuoteIcon />, command: { kind: "wrap", ...REF_NAMED_SNIPPET } },
  {
    key: "citeList",
    icon: <NumberListIcon />,
    command: { kind: "wrap", before: REFERENCES_SNIPPET, block: true },
  },
];

/** `T ADVANCED ▾`, below the heading rows: structure, then escapes. */
const LIST_ITEMS: CommandItem[] = [
  { key: "bulletList", icon: <BulletListIcon />, command: { kind: "prefix", marker: "* " } },
  { key: "numberedList", icon: <NumberListIcon />, command: { kind: "prefix", marker: "# " } },
  { key: "indent", icon: <IndentIcon />, command: { kind: "prefix", marker: ":" } },
];

const ESCAPE_ITEMS: CommandItem[] = [
  { key: "unlink", icon: <UnlinkIcon />, command: { kind: "unlink" } },
  {
    key: "nowiki",
    icon: <NowikiIcon />,
    command: { kind: "wrap", before: "<nowiki>", after: "</nowiki>", placeholder: "text" },
  },
  {
    key: "comment",
    icon: <CommentIcon />,
    command: { kind: "wrap", before: "<!-- ", after: " -->", placeholder: "note" },
  },
  {
    key: "redirect",
    icon: <RedirectIcon />,
    command: {
      kind: "wrap",
      before: "#REDIRECT [[",
      after: "]]",
      placeholder: "Page name",
      block: true,
    },
  },
];

type MenuName = "insert" | "cite" | "characters" | "advanced";

/* ------------------------------------------------------------------ */
/* Toolbar                                                             */
/* ------------------------------------------------------------------ */

export function SourceToolbar({ labels, disabled, namedRefs, onAction }: SourceToolbarProps) {
  const [openMenu, setOpenMenu] = useState<MenuName | null>(null);
  const reuse = citeReuseRows(namedRefs ?? []);

  const emit = useCallback(
    (action: SourceAction) => {
      setOpenMenu(null);
      onAction(action);
    },
    [onAction],
  );

  const run = useCallback(
    (command: EditorCommand) => emit({ kind: "command", command }),
    [emit],
  );

  const runItem = useCallback(
    (item: CommandItem) => {
      if ("action" in item) {
        emit(item.action);
        return;
      }
      run(typeof item.command === "function" ? item.command() : item.command);
    },
    [emit, run],
  );

  const setOpen = useCallback(
    (menu: MenuName) => (next: boolean) => setOpenMenu(next ? menu : null),
    [],
  );

  return (
    <ToolbarRow label={labels.toolbarLabel}>
      <ToolbarGroup>
        <ToolButton label={labels.undo} disabled={disabled} onClick={() => emit({ kind: "undo" })}>
          <UndoIcon />
        </ToolButton>
        <ToolButton label={labels.redo} disabled={disabled} onClick={() => emit({ kind: "redo" })}>
          <RedoIcon />
        </ToolButton>
      </ToolbarGroup>

      <ToolbarDivider />

      {/* — emphasis (spec §1.1; <u> and <s> are plain HTML the sanitizer keeps) — */}
      <ToolbarGroup>
        <ToolButton
          label={labels.bold}
          disabled={disabled}
          onClick={() =>
            run({ kind: "wrap", before: "'''", after: "'''", placeholder: "bold", toggle: true })
          }
        >
          <BoldIcon />
        </ToolButton>
        <ToolButton
          label={labels.italic}
          disabled={disabled}
          onClick={() =>
            run({ kind: "wrap", before: "''", after: "''", placeholder: "italic", toggle: true })
          }
        >
          <ItalicIcon />
        </ToolButton>
        <ToolButton
          label={labels.underline}
          disabled={disabled}
          onClick={() =>
            run({
              kind: "wrap",
              before: "<u>",
              after: "</u>",
              placeholder: "underline",
              toggle: true,
            })
          }
        >
          <UnderlineIcon />
        </ToolButton>
        <ToolButton
          label={labels.strikethrough}
          disabled={disabled}
          onClick={() =>
            run({
              kind: "wrap",
              before: "<s>",
              after: "</s>",
              placeholder: "strikethrough",
              toggle: true,
            })
          }
        >
          <StrikethroughIcon />
        </ToolButton>

        {/* Link and media are dialogs the island owns in both modes. */}
        <ToolButton label={labels.link} disabled={disabled} onClick={() => emit({ kind: "link" })}>
          <LinkIcon />
        </ToolButton>
        <ToolButton
          label={labels.media}
          disabled={disabled}
          onClick={() => emit({ kind: "media" })}
        >
          <MediaIcon />
        </ToolButton>
        <ToolButton
          label={labels.gallery}
          disabled={disabled}
          onClick={() => run({ kind: "wrap", before: GALLERY_SNIPPET, block: true })}
        >
          <GalleryIcon />
        </ToolButton>
        <ToolButton
          label={labels.template}
          disabled={disabled}
          onClick={() => emit({ kind: "template" })}
        >
          <TemplateIcon />
        </ToolButton>
      </ToolbarGroup>

      <ToolbarDivider />

      {/* — insert (spec §7, §8, §10; versioning.md §2) — */}
      <ToolbarGroup>
        <ToolbarMenu
          label={labels.insert}
          trigger={<span className="max-w-32 truncate">{labels.insert}</span>}
          open={openMenu === "insert"}
          onOpenChange={setOpen("insert")}
          disabled={disabled}
          panelClassName="min-w-56"
        >
          {INSERT_ITEMS.map((item) => (
            <MenuItem
              key={item.key}
              label={labels[item.key]}
              icon={item.icon}
              onSelect={() => runItem(item)}
            />
          ))}
        </ToolbarMenu>
      </ToolbarGroup>

      <ToolbarDivider />

      {/* — citations (spec §10: <ref>, <references>) — */}
      <ToolbarGroup>
        <ToolbarMenu
          label={labels.cite}
          trigger={<QuoteIcon />}
          open={openMenu === "cite"}
          onOpenChange={setOpen("cite")}
          disabled={disabled}
          panelClassName="max-h-96 min-w-64 overflow-y-auto"
        >
          {CITE_ITEMS.map((item) => (
            <MenuItem
              key={item.key}
              label={labels[item.key]}
              icon={item.icon}
              onSelect={() => runItem(item)}
            />
          ))}

          {/* Citing a source the page already cites (spec §10.3's reuse form).
              The self-closing tag wraps nothing, so it is inserted at the caret
              rather than around the selection. Nothing is drawn at all when the
              buffer has no named refs. */}
          {reuse.length > 0 ? (
            <>
              <MenuSeparator />
              {/* Presentational: the rows under it are the menu's own items. */}
              <div
                role="presentation"
                className="px-2 py-1 font-mono text-[11px] uppercase tracking-[0.08em] text-faint"
              >
                {labels.citeReuse}
              </div>
              {reuse.map((row) => (
                <MenuItem
                  key={row.source}
                  label={row.label}
                  hint={row.hint}
                  icon={<QuoteIcon />}
                  onSelect={() => run({ kind: "insert", text: row.source })}
                />
              ))}
            </>
          ) : null}
        </ToolbarMenu>
      </ToolbarGroup>

      <ToolbarDivider />

      <ToolbarGroup>
        <ToolbarMenu
          label={labels.specialCharacters}
          trigger={<OmegaIcon />}
          open={openMenu === "characters"}
          onOpenChange={setOpen("characters")}
          disabled={disabled}
          panelClassName="grid w-64 grid-cols-8 gap-0.5"
        >
          {SPECIAL_CHARACTERS.map((char) => (
            <button
              key={char}
              type="button"
              role="menuitem"
              title={char}
              aria-label={char}
              onClick={() => run({ kind: "insert", text: char })}
              className="focus-ring flex h-7 items-center justify-center rounded-[var(--radius-sm)] font-mono text-[13px] text-body transition-colors hover:bg-canvas-soft hover:text-ink"
            >
              {char}
            </button>
          ))}
        </ToolbarMenu>
      </ToolbarGroup>

      <ToolbarDivider />

      {/* — advanced (spec §2 headings, §4 lists, then the escapes) — */}
      <ToolbarGroup>
        <ToolbarMenu
          label={labels.advanced}
          trigger={<AdvancedIcon />}
          open={openMenu === "advanced"}
          onOpenChange={setOpen("advanced")}
          disabled={disabled}
          align="end"
          panelClassName="min-w-56"
        >
          {/* Presentational: the rows below it are the menu's own items. */}
          <div
            role="presentation"
            className="px-2 py-1 font-mono text-[11px] uppercase tracking-[0.08em] text-faint"
          >
            {labels.heading}
          </div>
          {HEADING_LEVELS.map((level) => (
            <MenuItem
              key={level}
              label={formatMessage(labels.headingLevel, { level })}
              icon={"=".repeat(level)}
              onSelect={() => run({ kind: "heading", level })}
            />
          ))}
          <MenuItem
            label={labels.headingParagraph}
            icon={<ParagraphIcon />}
            onSelect={() => run({ kind: "heading", level: 0 })}
          />

          <MenuSeparator />

          {LIST_ITEMS.map((item) => (
            <MenuItem
              key={item.key}
              label={labels[item.key]}
              icon={item.icon}
              onSelect={() => runItem(item)}
            />
          ))}

          <MenuSeparator />

          {ESCAPE_ITEMS.map((item) => (
            <MenuItem
              key={item.key}
              label={labels[item.key]}
              icon={item.icon}
              onSelect={() => runItem(item)}
            />
          ))}

          <MenuSeparator />

          <MenuItem
            label={labels.help}
            icon={<HelpIcon />}
            onSelect={() => emit({ kind: "help" })}
          />
        </ToolbarMenu>
      </ToolbarGroup>

      {/* Fandom parks the rail toggle alone at the far end of the bar. */}
      <ToolButton
        label={labels.more}
        disabled={disabled}
        onClick={() => emit({ kind: "toggleRail" })}
        className="ms-auto"
      >
        <MenuIcon />
      </ToolButton>
    </ToolbarRow>
  );
}
