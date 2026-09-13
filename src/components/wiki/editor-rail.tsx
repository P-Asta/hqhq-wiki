"use client";

/**
 * The editor's right rail — Fandom's "page tools" column, drawn as hairline
 * cards (theme.md).
 *
 * Almost everything here is derived from the buffer on the client:
 * `templatesUsed` and `categoriesUsed` (src/lib/wikitext-highlight.ts) read the
 * same lossless token stream the highlighter uses, so the lists track what the
 * author is typing with no extra API round-trip. `addCategory` /
 * `removeCategory` edit the buffer in place.
 *
 * One section is worth explaining, because it is a consequence of a decision
 * rather than of layout: **tags** are categories, and a category is nothing but
 * a `[[Category:X]]` in the body (decisions-v2 O13). There is no registry row
 * to create, so picking an existing tag and inventing one are the same gesture:
 * both end at `addCategory()`. The only thing the network adds is recognition —
 * the live member counts from `GET /api/categories` are what stop a wiki
 * growing `Moons`, `moon` and `Moon pages` (visual-editor.md §5.3).
 *
 * The rail deliberately carries **no version list**. versioning.md §6 gives the
 * author the reader's control, `EditorVersionBar`, which sits above the editing
 * surface in both modes; a second list here was the two-controls-for-one-job
 * confusion §6 was rewritten to remove, and the rail is the wrong home for it
 * because the rail collapses and the bar does not. What survives is the
 * read-only "which version is the preview rendering" row under Page settings.
 *
 * Stacks under the editor below `lg`; collapsible everywhere so the source
 * can take the full width.
 */

import Link from "next/link";
import { useCallback, useId, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  TokenPicker,
  type TokenOption,
  type TokenPickerLabels,
} from "@/components/wiki/token-picker";
import type { EditorCommand } from "@/lib/editor-selection";
import { formatMessage } from "@/lib/i18n";
import { articleHref } from "@/lib/locale-path";
import { slugifyTitle } from "@/lib/title";
import { cn } from "@/lib/utils";
import { addCategory, categoriesUsed, removeCategory, templatesUsed } from "@/lib/wikitext-highlight";

export interface EditorRailLabels {
  title: string;
  collapse: string;
  expand: string;
  insertSection: string;
  templatesSection: string;
  templatesEmpty: string;
  categoriesSection: string;
  categoriesEmpty: string;
  /**
   * Kept for callers wired before the picker landed; the picker's own
   * placeholder is `tagsPicker.placeholder`, which the combobox owns along
   * with its list, loading and "create" copy.
   */
  categoryPlaceholder: string;
  /** Doubles as the accessible name of the tag combobox. */
  categoryAdd: string;
  /** "{name}" = the category being removed. */
  categoryRemove: string;
  settingsSection: string;
  settingsLocale: string;
  settingsVersion: string;
  settingsParentRev: string;
  settingsNewPage: string;
  tagsPicker: TokenPickerLabels;
}

/** The rail's quick-action buttons — the constructs authors reach for most. */
const QUICK_ACTIONS: Array<{ id: string; glyph: string; command: EditorCommand }> = [
  {
    id: "file",
    glyph: "▣",
    command: {
      kind: "wrap",
      before: "[[File:",
      after: "|thumb|right|300px|Caption]]",
      placeholder: "Example.png",
    },
  },
  {
    id: "ref",
    glyph: "[1]",
    command: { kind: "wrap", before: "<ref>", after: "</ref>", placeholder: "Source" },
  },
  {
    id: "template",
    glyph: "{{}}",
    command: { kind: "wrap", before: "{{", after: "}}", placeholder: "Template name" },
  },
  {
    id: "table",
    glyph: "⊞",
    command: {
      kind: "wrap",
      before: '{| class="wikitable"\n! Header 1 !! Header 2\n|-\n| ',
      after: " || Cell\n|}",
      placeholder: "Cell",
      block: true,
    },
  },
];

export interface EditorRailProps {
  locale: string;
  content: string;
  /**
   * Edits the buffer. It takes a function rather than a string because the
   * rail's copy of `content` can lag the visual surface by one debounce, and
   * applying a tag to a stale buffer would silently revert whatever was typed
   * in between — the island resolves `current` from the live surface first.
   */
  onContentChange: (edit: (current: string) => string) => void;
  onCommand: (command: EditorCommand) => void;
  /** No principal may edit: everything in the rail is inert. */
  disabled?: boolean;
  /**
   * The snippet buttons alone are unavailable — they run selection commands
   * against the source textarea, which the visual surface does not have.
   * Tagging is *not* gated by this: categories are the rail's only home
   * (decisions-v2 O14.4), so disabling them in visual mode would leave the
   * default mode unable to file a page at all.
   */
  commandsDisabled?: boolean;
  /**
   * The version the preview is rendering at — shown, not chosen, here: the
   * choosing belongs to `EditorVersionBar` above the editing surface (§6).
   */
  version: string;
  parentRevId: number | null;
  labels: EditorRailLabels;
  /** Accessible names for the quick-action buttons, keyed by action id. */
  quickActionLabels: Record<string, string>;
}

/**
 * `GET /api/categories` rows as picker options: the slug identifies the tag
 * (it is what `category_links` stores), the name is what the author types, and
 * the member count is the hint that makes reuse obvious. Parsed defensively
 * rather than trusted — this is a network payload, and a row missing either
 * string is simply not offerable.
 */
function toTagOptions(payload: unknown): TokenOption[] {
  if (typeof payload !== "object" || payload === null || !("categories" in payload)) return [];
  const rows: readonly unknown[] = Array.isArray(payload.categories) ? payload.categories : [];
  const options: TokenOption[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    if (!("slug" in row) || !("name" in row)) continue;
    const { slug, name } = row;
    if (typeof slug !== "string" || typeof name !== "string") continue;
    const total = "total" in row ? row.total : undefined;
    options.push({
      id: slug,
      label: name,
      // A bare numeral needs no translation, which is why the count is the
      // hint and not a sentence.
      hint: typeof total === "number" ? String(total) : undefined,
    });
  }
  return options;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-hairline px-3 py-3 last:border-b-0">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-mute">{title}</h3>
      {children}
    </section>
  );
}

/** The "the preview is rendering this version" pill under Page settings. */
const CURRENT_VERSION_CLASSES = "border-hairline-strong bg-canvas-soft-2 text-ink";

export function EditorRail({
  locale,
  content,
  onContentChange,
  onCommand,
  disabled = false,
  commandsDisabled = false,
  version,
  parentRevId,
  labels,
  quickActionLabels,
}: EditorRailProps) {
  const [open, setOpen] = useState(true);
  const [tagQuery, setTagQuery] = useState("");
  const tagInputId = useId();

  const templates = useMemo(() => templatesUsed(content), [content]);
  const categories = useMemo(() => categoriesUsed(content), [content]);

  // The picker marks what the page already carries, and it keys rows by slug,
  // so the buffer's names have to be slugified the same way the engine does.
  const selectedSlugs = useMemo(
    () => categories.map((category) => slugifyTitle(category.name)),
    [categories],
  );

  const searchTags = useCallback(
    async (query: string): Promise<TokenOption[]> => {
      const params = new URLSearchParams({ q: query, locale });
      const response = await fetch(`/api/categories?${params.toString()}`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`categories: ${response.status}`);
      const payload: unknown = await response.json();
      return toTagOptions(payload);
    },
    [locale],
  );

  // Choosing an existing tag and creating one are deliberately the same call:
  // O13 leaves no registry row to write, so the label is the whole act.
  const commitTag = (option: TokenOption) => {
    onContentChange((current) => addCategory(current, option.label));
    setTagQuery("");
  };

  return (
    <aside className="flex min-w-0 flex-col rounded-[var(--radius-lg)] border border-hairline bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-hairline px-3 py-2">
        <h2 className="text-xs font-semibold tracking-tight text-ink">{labels.title}</h2>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-label={open ? labels.collapse : labels.expand}
          title={open ? labels.collapse : labels.expand}
          onClick={() => setOpen(!open)}
          className="h-7 min-w-7 px-1.5 font-mono text-[13px]"
        >
          {open ? "−" : "+"}
        </Button>
      </div>

      {open ? (
        <div className="flex flex-col">
          <Section title={labels.insertSection}>
            <div className="flex flex-wrap gap-1">
              {QUICK_ACTIONS.map((action) => (
                <Button
                  key={action.id}
                  variant="secondary"
                  size="sm"
                  disabled={disabled || commandsDisabled}
                  title={quickActionLabels[action.id]}
                  aria-label={quickActionLabels[action.id]}
                  onClick={() => onCommand(action.command)}
                  className="h-8 min-w-8 px-2 font-mono text-[13px]"
                >
                  {action.glyph}
                </Button>
              ))}
            </div>
          </Section>

          <Section title={labels.templatesSection}>
            {templates.length === 0 ? (
              <p className="text-xs text-faint">{labels.templatesEmpty}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {templates.map((name) => (
                  <li key={name}>
                    <Link
                      href={articleHref(locale, "template", slugifyTitle(name))}
                      className="focus-ring font-mono text-xs text-link hover:underline"
                    >
                      {`{{${name}}}`}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={labels.categoriesSection}>
            {categories.length === 0 ? (
              <p className="mb-2 text-xs text-faint">{labels.categoriesEmpty}</p>
            ) : (
              <ul className="mb-2 flex flex-wrap gap-1">
                {categories.map((category) => (
                  <li
                    key={category.name}
                    className="inline-flex items-center gap-1 rounded-full border border-hairline bg-canvas-soft py-0.5 pl-2 pr-1 text-xs text-body"
                  >
                    <Link
                      href={articleHref(locale, "category", slugifyTitle(category.name))}
                      className="focus-ring hover:text-link hover:underline"
                    >
                      {category.name}
                    </Link>
                    <button
                      type="button"
                      disabled={disabled}
                      aria-label={formatMessage(labels.categoryRemove, { name: category.name })}
                      title={formatMessage(labels.categoryRemove, { name: category.name })}
                      onClick={() =>
                        onContentChange((current) => removeCategory(current, category.name))
                      }
                      className="focus-ring inline-flex size-4 items-center justify-center rounded-full text-mute transition-colors hover:bg-canvas-soft-2 hover:text-ink disabled:opacity-50"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {/* The combobox has a placeholder but no visible label; the rail's
                section heading names the group, not the field. */}
            <label htmlFor={tagInputId} className="sr-only">
              {labels.categoryAdd}
            </label>
            <TokenPicker
              id={tagInputId}
              value={tagQuery}
              onValueChange={setTagQuery}
              search={searchTags}
              onSelect={commitTag}
              // A tag is its slug (O13.2), and the search answers with the
              // page title or the humanized slug — so "tier-3-moons" must not
              // read as free just because the row above spells it "Tier 3
              // moons".
              identify={slugifyTitle}
              selected={selectedSlugs}
              disabled={disabled}
              labels={labels.tagsPicker}
            />
          </Section>

          <Section title={labels.settingsSection}>
            <dl className="flex flex-col gap-1 text-xs">
              <div className="flex justify-between gap-2">
                <dt className="text-mute">{labels.settingsLocale}</dt>
                <dd className="font-mono text-body">{locale}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-mute">{labels.settingsVersion}</dt>
                {/* Not a property of the page: one buffer holds every branch
                    and they all save together. This states which version the
                    preview is rendering; changing it is the version bar's job
                    (§6), which is why this is a pill and not a control. */}
                <dd>
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 font-mono text-[11px]",
                      CURRENT_VERSION_CLASSES,
                    )}
                  >
                    {version}
                  </span>
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-mute">{labels.settingsParentRev}</dt>
                <dd className="font-mono text-body">
                  {parentRevId === null ? labels.settingsNewPage : `r${parentRevId}`}
                </dd>
              </div>
            </dl>
          </Section>
        </div>
      ) : null}
    </aside>
  );
}
