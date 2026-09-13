/**
 * Centered empty state: soft well, hairline, radius-lg. Decorative gradient
 * phrases (grad-text-*) belong in the title the CALLER passes — hero scale
 * only, per theme.md.
 */

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  /** Usually a Button / ButtonLink. */
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, action, icon, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-[var(--radius-lg)] border border-hairline bg-canvas-soft px-6 py-16 text-center",
        className,
      )}
    >
      {icon ? <div className="text-faint">{icon}</div> : null}
      <h2 className="text-lg font-semibold tracking-tight text-ink">{title}</h2>
      {description ? <p className="max-w-md text-sm text-mute">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
