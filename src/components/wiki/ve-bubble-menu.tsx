"use client";

/**
 * The formatting bar that comes to the selection — the Notion interaction model
 * the user chose on 2026-09-04, in place of the fixed Fandom toolbar's trip to
 * the top of the page. Select text, and B / I / U / S / code, the link, clear
 * formatting and "turn into" appear over the words they will act on.
 *
 * Three things decide the shape of this file.
 *
 * **It must not steal the selection.** Every control cancels the default of
 * `mousedown`, and the bar cancels it again for the whole panel, because the
 * browser's default for a press inside chrome is to move focus and collapse the
 * document's selection — the very selection the button is about to format.
 * Without those two lines the bar formats nothing at all, and it is the single
 * most important behaviour in this module. `click` still fires: only the
 * focus-and-collapse default is suppressed.
 *
 * **It owns no document.** Like the fixed toolbar (editor-toolbar-visual.tsx)
 * it emits one `VisualAction` per press and reads back only *reports* —
 * `activeMarks` and `currentFormat` — so the surface that holds the caret stays
 * the single source of truth. The vocabulary is the toolbar's, unchanged, so
 * the two controls offer the same edits and write the same wikitext.
 *
 * **Where it sits is a pure function.** `bubblePosition` takes plain rectangles
 * and returns a point; the component only measures and draws. That keeps the
 * flipping and clamping — the part with the arithmetic and the edge cases —
 * testable under vitest's node environment, where there is no layout at all.
 *
 * Deliberately small: the marks, the link, clear formatting, and turn-into. Not
 * a second toolbar. Anything rarer belongs to the slash menu, which is where an
 * author reaches for a construct rather than for emphasis.
 */

import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";

import { Button } from "@/components/ui/button";
import {
  BoldIcon,
  ClearFormattingIcon,
  CodeIcon,
  HeadingIcon,
  ItalicIcon,
  LinkIcon,
  ParagraphIcon,
  StrikethroughIcon,
  UnderlineIcon,
} from "@/components/wiki/editor-icons";
import { MenuItem, ToolbarMenu } from "@/components/wiki/editor-menu";
import { cn } from "@/lib/utils";
import type { VeBlockFormat, VisualAction } from "@/lib/visual-editor/actions";
import type { VeMark } from "@/lib/visual-editor/model";

/* ------------------------------------------------------------------ */
/* Placement                                                           */
/* ------------------------------------------------------------------ */

/** A rectangle in viewport coordinates — a selection's box, or a window. */
export interface BubbleRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

/** The air between the bar and the text it belongs to. */
const BUBBLE_GAP = 8;

/** …and between the bar and the edge of the window. */
const BUBBLE_MARGIN = 8;

/**
 * Where the bar sits for a given selection: centred over it, above it when
 * there is room and below it when there is not, and never off screen.
 *
 * Pure on purpose — every interesting case here is an edge of the viewport, and
 * a real one is expensive to arrange in a browser and impossible to arrange in
 * a node test.
 *
 * Both clamps are written `max(margin, min(wanted, limit))` rather than the
 * other way round, and the order is what decides the cases where the bar simply
 * does not fit: a bar wider than the window is pinned to the left edge and
 * overflows right, a bar taller than the window to the top edge. Those are the
 * readable halves. The same order answers a selection taller than the viewport
 * — no room above it, none below it — by keeping the bar on screen instead of
 * following the selection out of sight.
 */
export function bubblePosition(
  rect: BubbleRect,
  bar: { width: number; height: number },
  viewport: { width: number; height: number },
): { top: number; left: number } {
  const centre = (rect.left + rect.right) / 2;
  const leftLimit = viewport.width - BUBBLE_MARGIN - bar.width;
  const left = Math.max(BUBBLE_MARGIN, Math.min(centre - bar.width / 2, leftLimit));

  // Above is the preference: there the bar covers the line the author has just
  // finished with rather than the ones they are still reading.
  const above = rect.top - BUBBLE_GAP - bar.height;
  const topLimit = viewport.height - BUBBLE_MARGIN - bar.height;
  const wanted = above >= BUBBLE_MARGIN ? above : rect.bottom + BUBBLE_GAP;
  const top = Math.max(BUBBLE_MARGIN, Math.min(wanted, topLimit));

  return { top, left };
}

/* ------------------------------------------------------------------ */
/* Labels                                                              */
/* ------------------------------------------------------------------ */

export interface BubbleMenuLabels {
  toolbarLabel: string;
  bold: string;
  italic: string;
  underline: string;
  strikethrough: string;
  code: string;
  link: string;
  clearFormatting: string;
  turnInto: string;
  /** One per format offered, keyed by VeBlockFormat. */
  formats: Record<string, string>;
}

export interface BubbleMenuProps {
  /** The selection's bounding box in viewport coordinates; null hides the bar. */
  rect: BubbleRect | null;
  activeMarks: readonly VeMark[];
  currentFormat: VeBlockFormat;
  /** Formats the "turn into" control offers here. */
  formats: readonly VeBlockFormat[];
  onAction: (action: VisualAction) => void;
  labels: BubbleMenuLabels;
}

/**
 * `formats` is keyed by string so a dictionary can fill it without importing
 * the model's union. Read it through a partial record rather than indexing the
 * bag directly: a key the integrator has not wired yet is simply missing at
 * runtime, and only this type admits that.
 */
function formatLabel(labels: BubbleMenuLabels, format: VeBlockFormat): string | undefined {
  const bag: Partial<Record<VeBlockFormat, string>> = labels.formats;
  return bag[format];
}

function formatIcon(format: VeBlockFormat): ReactNode {
  switch (format) {
    case "paragraph":
      return <ParagraphIcon />;
    case "h2":
    case "h3":
    case "h4":
    case "h5":
      return <HeadingIcon />;
    case "pre":
      return <CodeIcon />;
  }
}

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */

/**
 * The names in the label bag that are strings — `formats` is the one entry that
 * is a bag of its own, so "a key of the labels" stopped meaning "a label".
 */
type BubbleTextKey = {
  [K in keyof BubbleMenuLabels]: BubbleMenuLabels[K] extends string ? K : never;
}[keyof BubbleMenuLabels];

/** The five marks that earn a place beside a selection. */
const BUBBLE_MARKS: readonly { mark: VeMark; key: BubbleTextKey; icon: ReactNode }[] = [
  { mark: "bold", key: "bold", icon: <BoldIcon /> },
  { mark: "italic", key: "italic", icon: <ItalicIcon /> },
  { mark: "underline", key: "underline", icon: <UnderlineIcon /> },
  { mark: "strike", key: "strikethrough", icon: <StrikethroughIcon /> },
  { mark: "code", key: "code", icon: <CodeIcon /> },
];

function BubbleButton({
  label,
  pressed,
  onPress,
  children,
}: {
  label: string;
  /** Absent for the controls that are an act rather than a state. */
  pressed?: boolean;
  onPress: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <Button
      variant="ghost"
      size="sm"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      // THE line of this file: a press inside the bar must not collapse the
      // selection the press is about to format. `click` still fires; only the
      // browser's focus-and-collapse default is cancelled.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onPress}
      className={cn("h-8 min-w-8 px-2", pressed === true && "bg-canvas-soft-2 text-ink")}
    >
      {children}
    </Button>
  );
}

/** The hairline between two runs of controls. */
function BubbleDivider(): ReactElement {
  return <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-hairline" />;
}

/* ------------------------------------------------------------------ */
/* The bar                                                             */
/* ------------------------------------------------------------------ */

interface BubbleMetrics {
  bar: { width: number; height: number };
  viewport: { width: number; height: number };
}

function sameMetrics(a: BubbleMetrics | null, b: BubbleMetrics): boolean {
  return (
    a !== null &&
    a.bar.width === b.bar.width &&
    a.bar.height === b.bar.height &&
    a.viewport.width === b.viewport.width &&
    a.viewport.height === b.viewport.height
  );
}

export function VeBubbleMenu({
  rect,
  activeMarks,
  currentFormat,
  formats,
  onAction,
  labels,
}: BubbleMenuProps): ReactElement | null {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [metrics, setMetrics] = useState<BubbleMetrics | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  /**
   * The bar's own size is layout: it can only be read once the bar is drawn,
   * and it changes when the format name in the trigger does. A ResizeObserver
   * answers both, and its first callback — delivered after mount, before paint
   * — is also the initial measurement, so nothing is set from an effect body.
   */
  useEffect(() => {
    if (node === null) return;
    const remeasure = () => {
      const box = node.getBoundingClientRect();
      const next: BubbleMetrics = {
        bar: { width: box.width, height: box.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
      setMetrics((prev) => (sameMetrics(prev, next) ? prev : next));
    };
    const observer = new ResizeObserver(remeasure);
    observer.observe(node);
    window.addEventListener("resize", remeasure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", remeasure);
    };
  }, [node]);

  const emit = useCallback(
    (action: VisualAction) => {
      setMenuOpen(false);
      onAction(action);
    },
    [onAction],
  );

  if (rect === null) return null;

  const placed = metrics === null ? null : bubblePosition(rect, metrics.bar, metrics.viewport);
  // Before the first measurement there is no width to centre on, so the bar is
  // parked at the selection's corner and held invisible for that one frame
  // rather than drawn in the wrong place and snapped into the right one.
  const style: CSSProperties =
    placed === null ? { top: rect.top, left: rect.left } : { top: placed.top, left: placed.left };

  const face = formatLabel(labels, currentFormat) ?? labels.turnInto;
  // A format the dictionary has not named is not offered: an unlabelled row is
  // worse than a missing one, and inventing a name here is how a user-visible
  // string escapes the dictionary.
  const offered = formats.filter((format) => formatLabel(labels, format) !== undefined);

  return (
    <div
      ref={setNode}
      role="toolbar"
      aria-orientation="horizontal"
      aria-label={labels.toolbarLabel}
      style={style}
      // The same cancellation as every button, for the gaps between them and
      // for any child that forgets: one stray press is a lost selection.
      onMouseDown={(event) => event.preventDefault()}
      className={cn(
        "fixed z-40 flex items-center gap-0.5 rounded-[var(--radius-md)] border border-hairline bg-surface px-1 py-1 shadow-[var(--shadow-md)]",
        placed === null && "pointer-events-none opacity-0",
      )}
    >
      {offered.length > 0 ? (
        <>
          <ToolbarMenu
            label={labels.turnInto}
            trigger={<span className="max-w-32 truncate">{face}</span>}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            triggerClassName="h-8"
            panelClassName="min-w-48"
          >
            {offered.map((format) => (
              <MenuItem
                key={format}
                label={formatLabel(labels, format) ?? format}
                icon={formatIcon(format)}
                selected={format === currentFormat}
                onSelect={() => emit({ kind: "format", format })}
              />
            ))}
          </ToolbarMenu>
          <BubbleDivider />
        </>
      ) : null}

      {BUBBLE_MARKS.map((item) => (
        <BubbleButton
          key={item.mark}
          label={labels[item.key]}
          pressed={activeMarks.includes(item.mark)}
          onPress={() => emit({ kind: "mark", mark: item.mark })}
        >
          {item.icon}
        </BubbleButton>
      ))}

      <BubbleDivider />

      <BubbleButton label={labels.link} onPress={() => emit({ kind: "link" })}>
        <LinkIcon />
      </BubbleButton>
      <BubbleButton label={labels.clearFormatting} onPress={() => emit({ kind: "clearFormatting" })}>
        <ClearFormattingIcon />
      </BubbleButton>
    </div>
  );
}
