"use client";

/**
 * Account menu island. Anonymous: the primary "Sign in" button (theme.md
 * site chrome). Authenticated: avatar button opening a small dropdown with
 * the account's name, its role badges, and profile / admin / sign-out. Uses a
 * <details> element (works pre-hydration) plus listeners that close it on
 * outside click and Escape.
 *
 * Identity comes from the SERVER-resolved principal (`profile`) first and the
 * Firebase user only as a fallback: the Firestore `users/{uid}` document is
 * what the rest of the site calls this account, and it is the only place a
 * profile picture lives.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { useAuth } from "@/components/auth-provider";
import { ButtonLink } from "@/components/ui/button";
import { homeHref, localePath } from "@/lib/locale-path";
import { ROLE_META, roleLabel, sortRoles, type RoleId } from "@/lib/roles";

export interface AccountMenuLabels {
  /** Role display names from the dictionary, keyed by stored identifier. */
  roleNames: Partial<Record<RoleId, string>>;
  signIn: string;
  signOut: string;
  profile: string;
  admin: string;
  loading: string;
  anonymous: string;
  /** Shown when the server could not verify this session (common.unverified). */
  unverified: string;
}

export interface AccountMenuProps {
  locale: string;
  labels: AccountMenuLabels;
}

const ITEM_CLASSES =
  "focus-ring block w-full rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left text-[13px] text-body transition-colors hover:bg-canvas-soft hover:text-ink";

export function AccountMenu({ locale, labels }: AccountMenuProps) {
  const { loading, user, display, error, canAccessAdminPanel, signOut } = useAuth();
  const router = useRouter();
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const close = () => {
      if (detailsRef.current?.open) detailsRef.current.open = false;
    };
    const onPointerDown = (event: PointerEvent) => {
      if (detailsRef.current && !detailsRef.current.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  if (loading) {
    return (
      <span
        role="status"
        aria-label={labels.loading}
        className="inline-block size-8 animate-pulse rounded-full bg-canvas-soft-2"
      />
    );
  }

  if (!user) {
    return (
      <ButtonLink href={localePath(locale, "/login")} variant="primary" size="sm">
        {labels.signIn}
      </ButtonLink>
    );
  }

  const displayName = display?.name ?? labels.anonymous;
  const picture = display?.picture ?? null;
  const badges = sortRoles(display?.roles ?? []);
  const closeMenu = () => {
    if (detailsRef.current) detailsRef.current.open = false;
  };

  return (
    <details ref={detailsRef} className="relative">
      <summary
        aria-label={displayName}
        className="focus-ring flex size-8 cursor-pointer list-none items-center justify-center rounded-full border border-hairline bg-canvas-soft text-[13px] font-medium text-ink transition-colors hover:bg-canvas-soft-2 [&::-webkit-details-marker]:hidden"
      >
        {picture ? (
          // Remote avatar hosts are user-provided; next/image would need a
          // domain allowlist, so a plain img is deliberate here.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={picture} alt="" className="size-full rounded-full object-cover" />
        ) : (
          <span aria-hidden>{displayName.slice(0, 1).toUpperCase()}</span>
        )}
      </summary>
      <div className="absolute right-0 top-full z-40 mt-2 w-52 rounded-[var(--radius-md)] border border-hairline bg-surface p-1 shadow-[var(--shadow-md)]">
        <div className="px-2.5 py-1.5">
          <p className="truncate text-[13px] font-medium text-ink">{displayName}</p>
          {badges.length > 0 ? (
            <p className="mt-0.5 flex flex-wrap gap-x-1.5 gap-y-0.5 text-[11px] font-medium">
              {badges.map((role) => (
                <span key={role} style={{ color: `var(${ROLE_META[role].colorVar})` }}>
                  {roleLabel(role, labels.roleNames)}
                </span>
              ))}
            </p>
          ) : null}
          {error !== null ? (
            // Signed in, but the server could not confirm it — editing and the
            // console will refuse. Saying so beats a header that looks normal
            // until the first save fails.
            <p className="mt-1 text-[11px] leading-snug text-warning">{labels.unverified}</p>
          ) : null}
        </div>
        <div className="my-1 border-t border-hairline" />
        <Link href={localePath(locale, "/profile")} className={ITEM_CLASSES} onClick={closeMenu}>
          {labels.profile}
        </Link>
        {canAccessAdminPanel ? (
          <Link href={localePath(locale, "/admin")} className={ITEM_CLASSES} onClick={closeMenu}>
            {labels.admin}
          </Link>
        ) : null}
        <button
          type="button"
          className={ITEM_CLASSES}
          onClick={() => {
            closeMenu();
            void signOut().then(() => {
              router.push(homeHref(locale));
              router.refresh();
            });
          }}
        >
          {labels.signOut}
        </button>
      </div>
    </details>
  );
}
