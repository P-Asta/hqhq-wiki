/**
 * Native select with the shared control skin and an inline caret glyph
 * (appearance-none hides the platform arrow). Server-safe.
 */

import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/utils";

import { CONTROL_CLASSES } from "./input";

export interface SelectProps extends ComponentPropsWithoutRef<"select"> {
  /** Classes for the relative wrapper (width/positioning live here). */
  wrapperClassName?: string;
}

export function Select({ className, wrapperClassName, children, ...props }: SelectProps) {
  return (
    <span className={cn("relative inline-flex w-full", wrapperClassName)}>
      <select
        className={cn(CONTROL_CLASSES, "h-10 appearance-none pl-3 pr-8", className)}
        {...props}
      >
        {children}
      </select>
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-mute"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 6l4 4 4-4" />
      </svg>
    </span>
  );
}
