"use client";

/**
 * **Insert ▾, back in the editor header** (user direction, 2026-09-04, after
 * the Notion amendment to docs/engine/visual-editor.md §1).
 *
 * The amendment retired visual mode's fixed toolbar and moved every control to
 * the caret: the bubble menu for a selection, the gutter handle for a block,
 * and "/" for everything that gets *added*. What it also removed, and nobody
 * asked for, was the last place above the writing area that said the editor
 * can insert anything at all. An author who has not been told about "/" has no
 * road to a table, and there is no row of buttons left to find one on.
 *
 * So this is the one control the frame keeps, and it is deliberately small:
 *
 * - **It is the same catalogue.** The rows come from `visualInsertItems`
 *   (editor-toolbar-visual.tsx) — the retired `INSERT ▾` and `CITE ▾`, no more
 *   — and each carries the `VisualAction` the surface applies, so a row here
 *   and the same row in the slash menu cannot mean two different things.
 * - **It is not the whole catalogue.** A dropdown cannot be typed at, so the
 *   forty special characters and the seven marks would bury the ten constructs
 *   somebody opened it for. Those keep the slash menu, the bubble menu and
 *   `Ctrl+B`/`I`/`U`.
 * - **The rows are pulled when it opens, not pushed as the caret moves.** The
 *   surface reports one number per caret move on purpose (`onContextChange`);
 *   asking it for the catalogue at open time is what keeps a shut menu free.
 *   `items()` is therefore called once per opening, and the answer is held for
 *   as long as the panel is up.
 *
 * It draws nothing of its own: `ToolbarMenu` and `MenuItem` (editor-menu.tsx)
 * are the same trigger, panel, roving arrows, Escape and outside-pointer
 * dismissal every other menu in this editor uses.
 */

import { useCallback, useState } from "react";

import { MenuItem, ToolbarMenu } from "@/components/wiki/editor-menu";
import type { SlashItem } from "@/components/wiki/ve-slash-menu";
import type { VisualAction } from "@/lib/visual-editor/actions";

export interface EditorInsertMenuLabels {
  /** The trigger, and the panel's accessible name. */
  title: string;
  /** No row applies where the caret is — a cell takes very few of them. */
  empty: string;
}

export function EditorInsertMenu({
  items,
  disabled,
  onSelect,
  labels,
}: {
  /** The rows for the caret as it stands; asked once, when the menu opens. */
  items: () => SlashItem[];
  disabled?: boolean;
  onSelect: (action: VisualAction) => void;
  labels: EditorInsertMenuLabels;
}) {
  const [rows, setRows] = useState<SlashItem[] | null>(null);

  const onOpenChange = useCallback(
    (open: boolean) => setRows(open ? items() : null),
    [items],
  );

  const choose = useCallback(
    (action: VisualAction) => {
      setRows(null);
      onSelect(action);
    },
    [onSelect],
  );

  return (
    <ToolbarMenu
      label={labels.title}
      trigger={labels.title}
      open={rows !== null}
      onOpenChange={onOpenChange}
      disabled={disabled}
      align="end"
      // Taller than a toolbar dropdown and scrolling past that: a page that
      // already cites six sources adds a "cite again" row per source, and the
      // panel must not run off the bottom of the viewport.
      panelClassName="max-h-[min(28rem,70vh)] w-60 overflow-y-auto overscroll-contain"
    >
      {rows !== null && rows.length === 0 ? (
        <p className="px-3 py-2 text-[13px] text-mute">{labels.empty}</p>
      ) : (
        (rows ?? []).map((item) => (
          <MenuItem
            key={item.key}
            label={item.label}
            hint={item.hint}
            icon={item.icon}
            onSelect={() => choose(item.action)}
          />
        ))
      )}
    </ToolbarMenu>
  );
}
