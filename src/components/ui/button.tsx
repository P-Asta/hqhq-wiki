/**
 * Button + ButtonLink — theme.md "Buttons & forms".
 *
 * Primary: `--primary` bg / `--on-primary` text (black in light, inverted in
 * dark). Secondary: surface + hairline. Danger: `--error`. Ghost: chrome-only.
 * Server-safe (no client hooks); pair with `buttonClasses` when a third
 * element (e.g. a `<summary>`) needs the same look.
 */

import Link from "next/link";
import type { ComponentPropsWithRef, ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

const BASE =
  "focus-ring inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-sm)] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-primary text-on-primary hover:bg-primary-hover",
  secondary: "border border-hairline bg-surface text-ink hover:bg-canvas-soft",
  danger: "bg-error text-on-primary hover:opacity-90",
  ghost: "text-mute hover:bg-canvas-soft hover:text-ink",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-10 px-4 text-sm",
  lg: "h-11 px-5 text-sm",
};

/** The composed class string for a given variant/size. */
export function buttonClasses(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  className?: string,
): string {
  return cn(BASE, VARIANT_CLASSES[variant], SIZE_CLASSES[size], className);
}

/**
 * `ComponentPropsWithRef` rather than `WithoutRef`: React 19 passes `ref`
 * through as an ordinary prop, and callers that need the element — a menu
 * restoring focus to its trigger — should not have to reach for a wrapper.
 */
export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  variant = "primary",
  size = "md",
  type = "button",
  className,
  ...props
}: ButtonProps) {
  return <button type={type} className={buttonClasses(variant, size, className)} {...props} />;
}

export interface ButtonLinkProps extends ComponentPropsWithoutRef<typeof Link> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/** A next/link styled as a button (e.g. the header "Sign in"). */
export function ButtonLink({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonLinkProps) {
  return <Link className={buttonClasses(variant, size, className)} {...props} />;
}
