/**
 * Form label — 13px medium ink, block-level with a small gap to its control.
 */

import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/utils";

export type LabelProps = ComponentPropsWithoutRef<"label">;

export function Label({ className, ...props }: LabelProps) {
  return (
    <label className={cn("mb-1.5 block text-[13px] font-medium text-ink", className)} {...props} />
  );
}
