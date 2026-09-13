/**
 * The one icon set the editor draws from — both toolbars, the mode pill, the
 * left rail and every dropdown (docs/engine/visual-editor.md §1).
 *
 * Fandom's editor chrome is icon-first, so the alternative to this file was a
 * few dozen inline `<svg>` blocks scattered through the toolbars, which is how
 * icon sets drift. Everything here is deliberately dumb: no state, no props
 * beyond `className`, and no runtime lookup except the `EDITOR_ICONS` registry
 * the data-driven menus need. Server-safe.
 *
 * The drawing rules match the glyphs already in the repo (ui/dialog.tsx,
 * ui/select.tsx, header-search.tsx): a 16×16 box, `currentColor` only, no
 * width/height so the size comes from a caller's `size-*` class, and
 * `aria-hidden`, because an icon button carries its accessible name from the
 * dictionary — never from the icon.
 *
 * Lettering icons (B, I, U, S, T, Ω, and the sup/sub pairs) are `<text>` with
 * `fill="currentColor"` rather than traced outlines: at 16px a hinted system
 * face is crisper than any path we would hand-roll, and the glyphs stay legible
 * when a caller scales them up. They are typographic marks inside a decorative,
 * `aria-hidden` graphic, so they are not user-visible copy and do not belong in
 * a `labels` prop. No font is loaded — the stack is whatever the platform has.
 */

import type { ReactElement, ReactNode } from "react";

import { cn } from "@/lib/utils";
import type { VeTableOp } from "@/lib/visual-editor/actions";

export interface EditorIconProps {
  className?: string;
}

/** System stack only, so an icon can never wait on a network round-trip. */
const GLYPH_SANS = "ui-sans-serif, system-ui, 'Segoe UI', Helvetica, Arial, sans-serif";
const GLYPH_SERIF = "ui-serif, Georgia, 'Times New Roman', serif";

/** Outline icons — the repo default: 1.5 stroke, round joins, nothing filled. */
function Outline({ className, children }: { className?: string; children: ReactNode }): ReactElement {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={cn("size-4", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/** Solid icons — letterforms and the few shapes that read better as mass. */
function Solid({ className, children }: { className?: string; children: ReactNode }): ReactElement {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={cn("size-4", className)} fill="currentColor" stroke="none">
      {children}
    </svg>
  );
}

interface LetterProps {
  /** A single typographic mark, centred on (x, y). */
  glyph: string;
  x?: number;
  y?: number;
  size?: number;
  weight?: number;
  italic?: boolean;
  serif?: boolean;
}

function Letter({
  glyph,
  x = 8,
  y = 8.4,
  size = 12,
  weight = 700,
  italic = false,
  serif = false,
}: LetterProps): ReactElement {
  return (
    <text
      x={x}
      y={y}
      fontFamily={serif ? GLYPH_SERIF : GLYPH_SANS}
      fontSize={size}
      fontWeight={weight}
      fontStyle={italic ? "italic" : "normal"}
      textAnchor="middle"
      dominantBaseline="central"
    >
      {glyph}
    </text>
  );
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

export function UndoIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M5.5 3.5L2.5 6.5l3 3" />
      <path d="M2.5 6.5h6a3.5 3.5 0 010 7H6" />
    </Outline>
  );
}

export function RedoIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M10.5 3.5l3 3-3 3" />
      <path d="M13.5 6.5h-6a3.5 3.5 0 000 7H10" />
    </Outline>
  );
}

/* ------------------------------------------------------------------ */
/* Emphasis                                                            */
/* ------------------------------------------------------------------ */

export function BoldIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Solid className={className}>
      <Letter glyph="B" weight={800} />
    </Solid>
  );
}

export function ItalicIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Solid className={className}>
      <Letter glyph="I" size={13} weight={600} italic serif />
    </Solid>
  );
}

export function UnderlineIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Solid className={className}>
      <Letter glyph="U" y={7} size={11} />
      <rect x="3.5" y="12.4" width="9" height="1.4" rx="0.7" />
    </Solid>
  );
}

export function StrikethroughIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Solid className={className}>
      <Letter glyph="S" size={11} />
      <rect x="2.5" y="7.4" width="11" height="1.4" rx="0.7" />
    </Solid>
  );
}

/** The `T ▾` group button; the chevron beside it is the caller's own icon. */
export function TextStyleIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Solid className={className}>
      <Letter glyph="T" />
    </Solid>
  );
}

export function SuperscriptIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Solid className={className}>
      <Letter glyph="A" x={5.5} y={9.5} size={11} />
      <Letter glyph="2" x={12} y={4.5} size={7} />
    </Solid>
  );
}

export function SubscriptIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Solid className={className}>
      <Letter glyph="A" x={5.5} y={6.5} size={11} />
      <Letter glyph="2" x={12} y={11.5} size={7} />
    </Solid>
  );
}

export function CodeIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M5.5 4L2 8l3.5 4" />
      <path d="M10.5 4L14 8l-3.5 4" />
    </Outline>
  );
}

export function ClearFormattingIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M2.5 5V3.5h8V5" />
      <path d="M6.5 3.5v8" />
      <path d="M10.5 10.5l3.5 3.5m0-3.5l-3.5 3.5" />
    </Outline>
  );
}

/* ------------------------------------------------------------------ */
/* Lists and indentation                                               */
/* ------------------------------------------------------------------ */

export function BulletListIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <circle cx="3" cy="4" r="1" fill="currentColor" stroke="none" />
      <circle cx="3" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="3" cy="12" r="1" fill="currentColor" stroke="none" />
      <path d="M6.5 4h7M6.5 8h7M6.5 12h7" />
    </Outline>
  );
}

/** Numerals are glyphs, not strokes — 1.5px paths blob together at this size. */
export function NumberListIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <Letter glyph="1" x={2.9} y={4} size={6} weight={600} />
      <Letter glyph="2" x={2.9} y={8} size={6} weight={600} />
      <Letter glyph="3" x={2.9} y={12} size={6} weight={600} />
      <path d="M6.5 4h7M6.5 8h7M6.5 12h7" />
    </Outline>
  );
}

export function IndentIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M6 3.5h8M6 8h8M6 12.5h8" />
      <path d="M2 5.5L4.5 8 2 10.5" />
    </Outline>
  );
}

export function OutdentIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M6 3.5h8M6 8h8M6 12.5h8" />
      <path d="M4.5 5.5L2 8l2.5 2.5" />
    </Outline>
  );
}

/* ------------------------------------------------------------------ */
/* Links                                                               */
/* ------------------------------------------------------------------ */

export function LinkIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M6.8 9.2a2.6 2.6 0 010-3.7l1.7-1.7a2.6 2.6 0 013.7 3.7l-1 1" />
      <path d="M9.2 6.8a2.6 2.6 0 010 3.7l-1.7 1.7a2.6 2.6 0 01-3.7-3.7l1-1" />
    </Outline>
  );
}

export function UnlinkIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M6.6 4.7l1.6-1.6a2.6 2.6 0 013.7 3.7l-1.6 1.6" />
      <path d="M9.4 11.3l-1.6 1.6a2.6 2.6 0 01-3.7-3.7l1.6-1.6" />
      <path d="M13 3L3 13" />
    </Outline>
  );
}

/* ------------------------------------------------------------------ */
/* Insert                                                              */
/* ------------------------------------------------------------------ */

export function MediaIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <circle cx="5.8" cy="6.3" r="1" />
      <path d="M2.4 11.2l3.3-3.2 2.4 2.3 2-1.9 3.5 3.4" />
    </Outline>
  );
}

export function GalleryIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M11 4.5V3a1 1 0 00-1-1H3a1 1 0 00-1 1v7a1 1 0 001 1h1.5" />
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M5.4 12.4l2.4-2.3 1.8 1.7 1.4-1.3 2.6 2.5" />
    </Outline>
  );
}

export function UploadIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M8 10.5V2.5" />
      <path d="M5 5.5l3-3 3 3" />
      <path d="M2.5 10.5v2a1 1 0 001 1h9a1 1 0 001-1v-2" />
    </Outline>
  );
}

export function TableIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 6.5h12" />
      <path d="M6.5 6.5V13M10 6.5V13" />
    </Outline>
  );
}

/* -- the table controls (visual-editor.md §3.2) ---------------------- */
/* Each is the grid above with the row or column the operation acts on   */
/* drawn apart from it: a `+` outside the edge it inserts at, an `×`     */
/* inside the band it removes, a rule inside the row it makes a header.  */
/* The four moves borrow the chevrons — a row that moves up is the same  */
/* gesture as a block that does, and a second vocabulary for it would    */
/* only be one more thing to learn.                                      */

export function TableRowAboveIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M8 1.75v3.5M6.25 3.5h3.5" />
      <rect x="2" y="7" width="12" height="6.75" rx="1.5" />
      <path d="M2 10.4h12" />
    </Outline>
  );
}

export function TableRowBelowIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <rect x="2" y="2.25" width="12" height="6.75" rx="1.5" />
      <path d="M2 5.65h12" />
      <path d="M8 10.75v3.5M6.25 12.5h3.5" />
    </Outline>
  );
}

export function TableColumnLeftIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M1.75 8h3.5M3.5 6.25v3.5" />
      <rect x="7" y="2" width="6.75" height="12" rx="1.5" />
      <path d="M10.4 2v12" />
    </Outline>
  );
}

export function TableColumnRightIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <rect x="2.25" y="2" width="6.75" height="12" rx="1.5" />
      <path d="M5.65 2v12" />
      <path d="M10.75 8h3.5M12.5 6.25v3.5" />
    </Outline>
  );
}

export function TableRowDeleteIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 6.5h12M2 9.5h12" />
      <path d="M6.2 7.3l3.6 1.9M9.8 7.3L6.2 9.2" />
    </Outline>
  );
}

export function TableColumnDeleteIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M6.2 3v10M9.8 3v10" />
      <path d="M7.1 6.6l1.8 2.8M8.9 6.6l-1.8 2.8" />
    </Outline>
  );
}

export function TableHeaderRowIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 6.5h12" />
      <path d="M4 4.75h8" />
      <path d="M6.5 6.5V13M10 6.5V13" />
    </Outline>
  );
}

export function TemplateIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M6.5 2.5c-1.6 0-1.6 1.3-1.6 2.7S4.4 8 3.2 8c1.2 0 1.7.4 1.7 2.8s0 2.7 1.6 2.7" />
      <path d="M9.5 2.5c1.6 0 1.6 1.3 1.6 2.7s.5 2.8 1.7 2.8c-1.2 0-1.7.4-1.7 2.8s0 2.7-1.6 2.7" />
    </Outline>
  );
}

export function QuoteIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M6.5 11.5H3.5V9c0-2.2 1-3.7 3-4.5" />
      <path d="M13 11.5h-3V9c0-2.2 1-3.7 3-4.5" />
    </Outline>
  );
}

/** Special characters — Fandom's Ω. */
export function OmegaIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Solid className={className}>
      <Letter glyph="Ω" size={13} weight={600} />
    </Solid>
  );
}

/** The source toolbar's `T ADVANCED ▾`: the letterform carries its own caret. */
export function AdvancedIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Solid className={className}>
      <Letter glyph="T" x={5.5} size={11} />
      <path
        d="M10.5 9l2 2 2-2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Solid>
  );
}

export function ParagraphIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M12.5 3H8.5a2.75 2.75 0 000 5.5H10" />
      <path d="M10 3v10M12.5 3v10" />
    </Outline>
  );
}

export function HeadingIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M4 3.5v9M12 3.5v9M4 8h8" />
    </Outline>
  );
}

export function RuleIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M2 8h12" />
      <path d="M3.5 4.5h4M9 4.5h3.5M3.5 11.5h4M9 11.5h3.5" />
    </Outline>
  );
}

export function InfoboxIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <rect x="3" y="2" width="10" height="12" rx="1.5" />
      <path d="M3 6h10" />
      <path d="M5.5 8.5h5M5.5 11h3" />
    </Outline>
  );
}

export function TabsIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M2 6.5V4a1 1 0 011-1h3.5a1 1 0 011 1v2.5" />
      <path d="M2 6.5h12V12a1 1 0 01-1 1H3a1 1 0 01-1-1z" />
    </Outline>
  );
}

export function VersionsIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M8 2.5l5.5 2.8L8 8.1 2.5 5.3z" />
      <path d="M2.5 8.2L8 11l5.5-2.8" />
      <path d="M2.5 11.1L8 13.9l5.5-2.8" />
    </Outline>
  );
}

export function CalendarIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <rect x="2" y="3.5" width="12" height="10" rx="1.5" />
      <path d="M2 6.5h12" />
      <path d="M5.5 2.2v2.6M10.5 2.2v2.6" />
    </Outline>
  );
}

export function CategoryIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M8.6 2H13a1 1 0 011 1v4.4a1 1 0 01-.3.7l-5.6 5.6a1 1 0 01-1.4 0L2.3 9.3a1 1 0 010-1.4l5.6-5.6a1 1 0 01.7-.3z" />
      <circle cx="11" cy="5" r="1" />
    </Outline>
  );
}

export function CommentIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M2 4a1.5 1.5 0 011.5-1.5h9A1.5 1.5 0 0114 4v5.5a1.5 1.5 0 01-1.5 1.5H7l-3.5 3V11a1.5 1.5 0 01-1.5-1.5z" />
    </Outline>
  );
}

export function RedirectIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M2.5 4.5h6.5a3 3 0 013 3v4" />
      <path d="M9.5 9l2.5 2.5L14.5 9" />
    </Outline>
  );
}

export function NowikiIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M5 4.5L2.5 8 5 11.5" />
      <path d="M11 4.5L13.5 8 11 11.5" />
      <path d="M9.3 3.5l-2.6 9" />
    </Outline>
  );
}

/* ------------------------------------------------------------------ */
/* Chrome                                                              */
/* ------------------------------------------------------------------ */

export function MenuIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
    </Outline>
  );
}

export function ChevronDownIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M4 6l4 4 4-4" />
    </Outline>
  );
}

export function ChevronUpIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M4 10l4-4 4 4" />
    </Outline>
  );
}

/** The sideways pair: a column moves left and right, not up and down. */
export function ChevronLeftIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M10 4l-4 4 4 4" />
    </Outline>
  );
}

export function ChevronRightIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M6 4l4 4-4 4" />
    </Outline>
  );
}

/** The visual half of the mode pill. */
export function EyeIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M1.5 8S4 4 8 4s6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4z" />
      <circle cx="8" cy="8" r="1.75" />
    </Outline>
  );
}

/** The source half: Fandom draws it as the bracket pair of a wiki link. */
export function SourceIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M6 3H3.5v10H6" />
      <path d="M10 3h2.5v10H10" />
    </Outline>
  );
}

export function HelpIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M6.3 6.3a1.75 1.75 0 113 1.4c-.6.4-1 .9-1 1.6" />
      <path d="M8 11.6h.01" />
    </Outline>
  );
}

export function KeyboardIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <rect x="1.5" y="4" width="13" height="8" rx="1.5" />
      <path d="M4.2 6.8h1M7.5 6.8h1M10.8 6.8h1" />
      <path d="M5 9.6h6" />
    </Outline>
  );
}

export function FullscreenIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M6 2.5H2.5V6" />
      <path d="M10 2.5h3.5V6" />
      <path d="M6 13.5H2.5V10" />
      <path d="M10 13.5h3.5V10" />
    </Outline>
  );
}

/** The left rail's page-tools button. */
export function BookmarkIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M4 3a1 1 0 011-1h6a1 1 0 011 1v10.5L8 10.8l-4 2.7z" />
    </Outline>
  );
}

export function TrashIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M2.5 4.5h11" />
      <path d="M6.3 4.5V3a1 1 0 011-1h1.4a1 1 0 011 1v1.5" />
      <path d="M4.3 4.5l.6 8.6a1 1 0 001 .9h4.2a1 1 0 001-.9l.6-8.6" />
    </Outline>
  );
}

export function PencilIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M11.4 2.3l2.3 2.3-8 8-3 .7.7-3z" />
      <path d="M9.9 3.8l2.3 2.3" />
    </Outline>
  );
}

/* ------------------------------------------------------------------ */
/* Block commands (visual-editor.md §3.1, §14)                         */
/* ------------------------------------------------------------------ */

/** A line, and a new one under it — "insert below". */
export function InsertBelowIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M2.5 4.5h11" />
      <path d="M8 8.5v5" />
      <path d="M5.5 11h5" />
    </Outline>
  );
}

/** Two stacked sheets — the same block, twice. */
export function DuplicateIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <rect x="2.5" y="2.5" width="8" height="8" rx="1" />
      <path d="M5.5 13.5h7a1 1 0 001-1v-7" />
    </Outline>
  );
}

/* ------------------------------------------------------------------ */
/* Find and replace (visual-editor.md §9)                              */
/* ------------------------------------------------------------------ */

/** The panel's own mark, and what its shortcut row is illustrated with. */
export function SearchIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.2 10.2l3.3 3.3" />
    </Outline>
  );
}

/** Dismisses the panel — the same cross ui/dialog.tsx draws on its own close. */
export function CloseIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Outline className={className}>
      <path d="M3.5 3.5l9 9m0-9l-9 9" />
    </Outline>
  );
}

/**
 * The case toggle, drawn the way every editor draws it: the same letter in both
 * cases. Lettering rather than an outline, per this file's opening note — the
 * button's accessible name is the dictionary's.
 */
export function MatchCaseIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Solid className={className}>
      <Letter glyph="A" x={4.6} y={8.6} size={11} weight={700} />
      <Letter glyph="a" x={11.4} y={9.2} size={9} weight={600} />
    </Solid>
  );
}

/**
 * The whole-word toggle: a word with both its edges marked, which is exactly
 * what the option tests (`editor-find.ts`).
 */
export function WholeWordIcon({ className }: EditorIconProps): ReactElement {
  return (
    <Solid className={className}>
      <Letter glyph="ab" x={8} y={7.4} size={9} weight={600} />
      <rect x="1.5" y="11.5" width="13" height="1.4" rx="0.7" />
      <rect x="1.5" y="9" width="1.4" height="4" rx="0.7" />
      <rect x="13.1" y="9" width="1.4" height="4" rx="0.7" />
    </Solid>
  );
}

/* ------------------------------------------------------------------ */
/* The table controls (visual-editor.md §3.2)                          */
/* ------------------------------------------------------------------ */

/**
 * The glyph each table operation is drawn with — named here, once, because the
 * floating control beside a table and the toolbar's table menu are two ways
 * into the same twelve edits and an icon that differed between them would be
 * two things to learn (`ve-table.ts` says the same about their names and their
 * order).
 *
 * A typed switch rather than a `Record` lookup for the reason the registry
 * below is not one: a thirteenth operation must be a compile error, not a hole
 * a menu renders around.
 */
export function tableOpIcon(op: VeTableOp): ReactElement {
  switch (op) {
    case "insertRowAbove":
      return <TableRowAboveIcon />;
    case "insertRowBelow":
      return <TableRowBelowIcon />;
    case "moveRowUp":
      return <ChevronUpIcon />;
    case "moveRowDown":
      return <ChevronDownIcon />;
    case "deleteRow":
      return <TableRowDeleteIcon />;
    case "insertColumnLeft":
      return <TableColumnLeftIcon />;
    case "insertColumnRight":
      return <TableColumnRightIcon />;
    case "moveColumnLeft":
      return <ChevronLeftIcon />;
    case "moveColumnRight":
      return <ChevronRightIcon />;
    case "deleteColumn":
      return <TableColumnDeleteIcon />;
    case "toggleHeaderRow":
      return <TableHeaderRowIcon />;
    case "deleteTable":
      return <TrashIcon />;
  }
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

/**
 * The `INSERT ▾` and `T ADVANCED ▾` menus are built from item lists, so they
 * name an icon instead of importing one. Keys are the kebab-case of the export.
 * A missing key is the caller's problem: substituting a fallback glyph here
 * would ship a wrong icon rather than an obvious hole.
 */
export const EDITOR_ICONS: Record<string, (props: EditorIconProps) => ReactElement> = {
  undo: UndoIcon,
  redo: RedoIcon,
  bold: BoldIcon,
  italic: ItalicIcon,
  underline: UnderlineIcon,
  strikethrough: StrikethroughIcon,
  "text-style": TextStyleIcon,
  superscript: SuperscriptIcon,
  subscript: SubscriptIcon,
  code: CodeIcon,
  "clear-formatting": ClearFormattingIcon,
  "bullet-list": BulletListIcon,
  "number-list": NumberListIcon,
  indent: IndentIcon,
  outdent: OutdentIcon,
  link: LinkIcon,
  unlink: UnlinkIcon,
  media: MediaIcon,
  gallery: GalleryIcon,
  upload: UploadIcon,
  table: TableIcon,
  template: TemplateIcon,
  quote: QuoteIcon,
  omega: OmegaIcon,
  advanced: AdvancedIcon,
  menu: MenuIcon,
  "chevron-down": ChevronDownIcon,
  "chevron-up": ChevronUpIcon,
  "chevron-left": ChevronLeftIcon,
  "chevron-right": ChevronRightIcon,
  "table-row-above": TableRowAboveIcon,
  "table-row-below": TableRowBelowIcon,
  "table-row-delete": TableRowDeleteIcon,
  "table-column-left": TableColumnLeftIcon,
  "table-column-right": TableColumnRightIcon,
  "table-column-delete": TableColumnDeleteIcon,
  "table-header-row": TableHeaderRowIcon,
  eye: EyeIcon,
  source: SourceIcon,
  help: HelpIcon,
  keyboard: KeyboardIcon,
  fullscreen: FullscreenIcon,
  bookmark: BookmarkIcon,
  paragraph: ParagraphIcon,
  heading: HeadingIcon,
  rule: RuleIcon,
  infobox: InfoboxIcon,
  tabs: TabsIcon,
  versions: VersionsIcon,
  calendar: CalendarIcon,
  category: CategoryIcon,
  comment: CommentIcon,
  redirect: RedirectIcon,
  nowiki: NowikiIcon,
  trash: TrashIcon,
  pencil: PencilIcon,
  "insert-below": InsertBelowIcon,
  duplicate: DuplicateIcon,
};
