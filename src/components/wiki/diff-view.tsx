/**
 * Side-by-side revision diff with inline word highlights (routes.md /diff).
 *
 * Isomorphic on purpose: the server diff page and the client-side 409
 * conflict UI both render it from `diffLines()` rows (src/lib/diff.ts).
 *
 * Styling per theme.md tokens only: whole added/removed lines tint the cell
 * (`--link-soft` / `--error-soft`); changed lines keep the cell neutral and
 * mark only the differing words via <ins>/<del>.
 */

import type { DiffRow, DiffSegment, DiffSide } from "@/lib/diff";
import { cn } from "@/lib/utils";

export interface DiffViewProps {
  rows: DiffRow[];
  /** Column headers (e.g. "r41" / "r42", or your-text / current-text). */
  leftLabel: string;
  rightLabel: string;
  className?: string;
}

function Segments({ segments }: { segments: DiffSegment[] }) {
  return (
    <>
      {segments.map((segment, i) => {
        if (segment.kind === "added") {
          return (
            <ins key={i} className="rounded-[2px] bg-link-soft font-medium text-ink no-underline">
              {segment.text}
            </ins>
          );
        }
        if (segment.kind === "removed") {
          return (
            <del key={i} className="rounded-[2px] bg-error-soft font-medium text-ink no-underline">
              {segment.text}
            </del>
          );
        }
        return <span key={i}>{segment.text}</span>;
      })}
    </>
  );
}

function cellTint(kind: DiffRow["kind"], side: "left" | "right"): string | null {
  if (kind === "removed" && side === "left") return "bg-error-soft";
  if (kind === "added" && side === "right") return "bg-link-soft";
  return null;
}

function SideCells({
  row,
  side,
}: {
  row: DiffRow;
  side: "left" | "right";
}) {
  const data: DiffSide | null = row[side];
  const tint = data ? cellTint(row.kind, side) : null;
  return (
    <>
      <td
        className={cn(
          "w-10 select-none border-r border-hairline bg-canvas-soft px-2 py-0.5 text-right align-top text-faint",
          side === "right" && "border-l",
        )}
      >
        {data ? data.lineNo : " "}
      </td>
      <td
        className={cn(
          "w-[calc(50%-2.5rem)] whitespace-pre-wrap break-words px-3 py-0.5 align-top text-body",
          tint,
        )}
      >
        {data ? <Segments segments={data.segments} /> : null}
      </td>
    </>
  );
}

export function DiffView({ rows, leftLabel, rightLabel, className }: DiffViewProps) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-[var(--radius-md)] border border-hairline",
        className,
      )}
    >
      <div className="overflow-x-auto">
        <table className="w-full table-fixed border-collapse font-mono text-[13px] leading-relaxed">
          <thead>
            <tr className="border-b border-hairline bg-canvas-soft text-left">
              <th
                colSpan={2}
                className="px-3 py-2 text-xs font-semibold tracking-tight text-ink"
              >
                {leftLabel}
              </th>
              <th
                colSpan={2}
                className="border-l border-hairline px-3 py-2 text-xs font-semibold tracking-tight text-ink"
              >
                {rightLabel}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                <SideCells row={row} side="left" />
                <SideCells row={row} side="right" />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
