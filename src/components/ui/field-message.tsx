/**
 * Small helper line under a form control: neutral hint, error, or success.
 * Errors announce via role="alert".
 */

import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/utils";

export type FieldMessageTone = "hint" | "warning" | "error" | "success";

const TONE_CLASSES: Record<FieldMessageTone, string> = {
  hint: "text-mute",
  warning: "text-warning",
  error: "text-error",
  success: "text-success",
};

export interface FieldMessageProps extends ComponentPropsWithoutRef<"p"> {
  tone?: FieldMessageTone;
}

export function FieldMessage({ tone = "hint", className, ...props }: FieldMessageProps) {
  return (
    <p
      // Only `error` is an alert. A warning here is a standing observation
      // about what is on screen — the version strip redraws one on every
      // keystroke that leaves a tag unclosed — and announcing that as an alert
      // would interrupt the sentence being typed.
      role={tone === "error" ? "alert" : undefined}
      className={cn("mt-1.5 text-[13px]", TONE_CLASSES[tone], className)}
      {...props}
    />
  );
}
