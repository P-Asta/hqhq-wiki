/**
 * Shared table shell for the /special/* reports — theme.md ".wikitable"
 * treatment: hairline grid inside an overflow-x wrapper with radius-md,
 * header row on --canvas-soft. Server-safe.
 */

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Standard body-cell classes; pages compose their own <td>s with these. */
export const CELL_CLASSES = "border-t border-hairline px-3 py-2 align-top text-sm text-body";

/** Variant for mono/technical cells (slugs, codes, revision ids). */
export const CELL_MONO_CLASSES = cn(CELL_CLASSES, "font-mono text-[13px]");

export interface SpecialTableProps {
  /** Column headers, in order. */
  head: ReactNode[];
  /** `<tr>` rows. */
  children: ReactNode;
  /** Accessible summary of the table. */
  ariaLabel?: string;
  className?: string;
}

export function SpecialTable({ head, children, ariaLabel, className }: SpecialTableProps) {
  return (
    <div
      className={cn(
        "overflow-x-auto rounded-[var(--radius-md)] border border-hairline",
        className,
      )}
    >
      <table aria-label={ariaLabel} className="w-full border-collapse text-left">
        <thead>
          <tr className="bg-canvas-soft">
            {head.map((label, index) => (
              <th
                key={index}
                scope="col"
                className="whitespace-nowrap px-3 py-2 text-[13px] font-semibold text-ink"
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** Small mono chip (locale codes, version ids, "minor"/"original" badges). */
export function Chip({
  children,
  title,
  className,
}: {
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center rounded-full border border-hairline bg-canvas-soft px-1.5 py-px font-mono text-[11px] leading-4 text-mute",
        className,
      )}
    >
      {children}
    </span>
  );
}
