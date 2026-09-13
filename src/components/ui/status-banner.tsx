/**
 * StatusBanner — theme.md "Banners": tonal soft background + strong tone
 * text + a 1px border of the tone, radius-md, 13px. Errors use role="alert".
 */

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type StatusBannerTone = "info" | "warning" | "error";

const TONE_CLASSES: Record<StatusBannerTone, string> = {
  info: "border-info/40 bg-info-soft text-info",
  warning: "border-warning/40 bg-warning-soft text-warning",
  error: "border-error/40 bg-error-soft text-error",
};

export interface StatusBannerProps {
  tone: StatusBannerTone;
  /** Optional leading strong phrase. */
  title?: string;
  children?: ReactNode;
  className?: string;
}

export function StatusBanner({ tone, title, children, className }: StatusBannerProps) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "rounded-[var(--radius-md)] border px-3 py-2 text-[13px] leading-relaxed",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {title ? <strong className="font-semibold text-current">{title}</strong> : null}
      {title && children ? " " : null}
      {children}
    </div>
  );
}
