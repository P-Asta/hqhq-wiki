/**
 * Textarea with the shared control skin. Callers opt into monospace for
 * wikitext sources via `className="font-mono"`.
 */

import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/utils";

import { CONTROL_CLASSES } from "./input";

export type TextareaProps = ComponentPropsWithoutRef<"textarea">;

export function Textarea({ className, ...props }: TextareaProps) {
  return (
    <textarea
      className={cn(CONTROL_CLASSES, "min-h-24 resize-y px-3 py-2 leading-relaxed", className)}
      {...props}
    />
  );
}
