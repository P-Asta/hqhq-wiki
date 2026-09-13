/**
 * Text input — theme.md "Buttons & forms": hairline border, radius-sm,
 * focus = 2px `--link` ring at 40% + `--link` border.
 */

import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/utils";

/** Shared control skin (input/select/textarea build on this). */
export const CONTROL_CLASSES =
  "w-full rounded-[var(--radius-sm)] border border-hairline bg-surface text-sm text-ink outline-none transition-[border-color,box-shadow] placeholder:text-faint focus:border-link focus:ring-2 focus:ring-link/40 disabled:cursor-not-allowed disabled:bg-canvas-soft disabled:text-faint";

export type InputProps = ComponentPropsWithoutRef<"input">;

export function Input({ className, ...props }: InputProps) {
  return <input className={cn(CONTROL_CLASSES, "h-10 px-3", className)} {...props} />;
}
