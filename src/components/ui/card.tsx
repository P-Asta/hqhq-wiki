/**
 * Card — `--surface` on hairline, radius-lg. `interactive` adds the hero-grid
 * hover treatment (shadow-md + translateY(-1px), theme.md "Hero").
 */

import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/utils";

export interface CardProps extends ComponentPropsWithoutRef<"div"> {
  interactive?: boolean;
}

export function Card({ interactive = false, className, ...props }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-lg)] border border-hairline bg-surface p-5",
        interactive &&
          "transition-[box-shadow,transform] duration-150 hover:-translate-y-px hover:shadow-[var(--shadow-md)]",
        className,
      )}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: ComponentPropsWithoutRef<"h3">) {
  return (
    <h3 className={cn("text-base font-semibold tracking-tight text-ink", className)} {...props} />
  );
}

export function CardDescription({ className, ...props }: ComponentPropsWithoutRef<"p">) {
  return <p className={cn("mt-1 text-sm text-mute", className)} {...props} />;
}
