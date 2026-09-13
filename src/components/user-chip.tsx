"use client";

/**
 * A person, wherever the wiki names one — a history row's author, a recent
 * change, an audit entry, a report — with the moderation actions that person
 * affords attached to them rather than to a separate admin screen.
 *
 * **Two roads to the same actions.** Right-click is the gesture people already
 * expect on a name, but it is unreachable by keyboard and invisible until
 * tried, so the same rows are also behind a "⋯" button
 * (src/components/ui/row-actions.tsx). One builder feeds both, which is the
 * only way they cannot drift — the pattern the visual editor's
 * `contextMenuRows` established.
 *
 * **What a viewer may do depends on who they are.** An ordinary signed-in
 * editor can REPORT somebody: that is the whole moderation vocabulary they
 * need, and it costs nothing if they are wrong. A manager can ban outright.
 * Nobody can act on themselves, and a signed-out reader gets no menu at all —
 * a name is still a name, it just does nothing.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { RowAction, RowActions, RowActionSeparator } from "@/components/ui/row-actions";
import { VeContextMenu, type VeContextRow } from "@/components/wiki/ve-context-menu";
import { formatMessage } from "@/lib/i18n";
import { ROLE_META, roleLabel, sortRoles, type RoleId } from "@/lib/roles";
import { cn } from "@/lib/utils";

export interface UserChipLabels {
  /** "Actions for {name}" — names both the ⋯ button and the context menu. */
  rowActions: string;
  /** Menu row: file a report (any signed-in viewer). */
  report: string;
  /** Menu row: ban (managers only). */
  ban: string;
  /** Menu row: lift a ban (managers only). */
  unban: string;
  /** Menu row: copy the account id. */
  copyId: string;
  /** Pill on an account that is already banned. */
  bannedBadge: string;
  /** Stands in for an account whose name did not resolve. */
  anonymous: string;
  /** Role display names, keyed by stored identifier. */
  roleNames: Partial<Record<RoleId, string>>;
}

/** Everything the chip knows about the person it names. */
export interface ChipUser {
  uid: string;
  displayName: string | null;
  banned?: boolean;
  /** Firestore-only; absent wherever only the SQLite mirror was read. */
  roles?: readonly string[];
  profilePicture?: string | null;
}

export interface UserChipActions {
  /** Present when the viewer is a signed-in non-self editor. */
  onReport?: (user: ChipUser) => void;
  /** Present only for a manager. */
  onBan?: (user: ChipUser, banned: boolean) => void;
}

export interface UserChipProps {
  user: ChipUser;
  labels: UserChipLabels;
  actions: UserChipActions;
  /** The viewer, so the chip can refuse to act on itself. */
  viewerUid?: string | null;
  /** Suppresses every action — used while a mutation is in flight. */
  disabled?: boolean;
  /** Hide the uid line where the table is already tight. */
  compact?: boolean;
  className?: string;
}

/**
 * The rows this person affords, in one place so the right-click menu and the
 * ⋯ menu can never offer different things.
 */
export function userMenuRows(
  user: ChipUser,
  labels: UserChipLabels,
  actions: UserChipActions,
  isSelf: boolean,
): VeContextRow[] {
  const rows: VeContextRow[] = [];

  if (actions.onReport && !isSelf) {
    rows.push({
      key: "report",
      label: labels.report,
      onSelect: () => actions.onReport?.(user),
    });
  }
  if (actions.onBan) {
    rows.push({
      key: "ban",
      label: user.banned ? labels.unban : labels.ban,
      // The server refuses a self-ban (400 self-ban); disabling says so first.
      disabled: isSelf && !user.banned,
      startsGroup: rows.length > 0,
      onSelect: () => actions.onBan?.(user, !user.banned),
    });
  }
  // Only alongside something worth doing. On its own it is not a reason to
  // exist: an anonymous reader has no use for a uid, and offering it would
  // mean taking their browser's own right-click menu away on every name.
  if (rows.length > 0) {
    rows.push({
      key: "copy-id",
      label: labels.copyId,
      startsGroup: true,
      onSelect: () => {
        void navigator.clipboard?.writeText(user.uid);
      },
    });
  }
  return rows;
}

export function UserChip({
  user,
  labels,
  actions,
  viewerUid,
  disabled,
  compact,
  className,
}: UserChipProps) {
  const [menuAt, setMenuAt] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLDivElement | null>(null);

  const name = user.displayName ?? labels.anonymous;
  const isSelf = viewerUid != null && viewerUid === user.uid;
  const rows = userMenuRows(user, labels, actions, isSelf);
  // formatMessage, not String.replace: a display name is user-written, and
  // replace() reads a "$" sequence in its REPLACEMENT as a backreference, so a
  // name of "$&" would echo the template back instead of naming anybody.
  const menuLabel = formatMessage(labels.rowActions, { name });
  const hasMenu = rows.length > 0 && !disabled;

  const closeMenu = useCallback((restoreFocus: boolean) => {
    setMenuAt(null);
    if (restoreFocus) triggerRef.current?.querySelector("button")?.focus();
  }, []);

  // The panel is position:fixed off a pointer the page can move away from —
  // the editor's own surface owns this for its menu, so a chip in a scrolling
  // table has to do it here.
  useEffect(() => {
    if (menuAt === null) return;
    const close = () => setMenuAt(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menuAt]);

  const badges = sortRoles(user.roles ?? []);

  return (
    <div
      ref={triggerRef}
      className={cn("flex items-center gap-2", className)}
      onContextMenu={(event) => {
        if (!hasMenu) return; // let the browser's own menu through
        event.preventDefault();
        setMenuAt({ top: event.clientY, left: event.clientX });
      }}
    >
      <span
        aria-hidden
        className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-canvas-soft-2 text-[11px] font-medium text-ink"
      >
        {user.profilePicture ? (
          // Remote avatar hosts are user-provided; next/image would need a
          // domain allowlist, so a plain img is deliberate here.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.profilePicture} alt="" className="size-full object-cover" />
        ) : (
          name.slice(0, 1).toUpperCase()
        )}
      </span>

      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-x-1.5">
          <span className="truncate text-body">{name}</span>
          {badges.map((role) => (
            <span
              key={role}
              style={{ color: `var(${ROLE_META[role].colorVar})` }}
              className="text-[11px] font-medium"
            >
              {roleLabel(role, labels.roleNames)}
            </span>
          ))}
          {user.banned ? (
            <span className="rounded-full border border-error/40 bg-error-soft px-1.5 text-[11px] text-error">
              {labels.bannedBadge}
            </span>
          ) : null}
        </span>
        {compact ? null : (
          <span className="block truncate font-mono text-[11px] text-faint">{user.uid}</span>
        )}
      </span>

      {hasMenu ? (
        <RowActions label={menuLabel} className="ml-auto">
          {rows.map((row) => (
            <RowActionSeparatorOrAction key={row.key} row={row} />
          ))}
        </RowActions>
      ) : null}

      {menuAt === null ? null : (
        <VeContextMenu at={menuAt} rows={rows} label={menuLabel} onClose={closeMenu} />
      )}
    </div>
  );
}

/** Adapts one builder row onto the ⋯ menu's vocabulary. */
function RowActionSeparatorOrAction({ row }: { row: VeContextRow }) {
  return (
    <>
      {row.startsGroup ? <RowActionSeparator /> : null}
      <RowAction
        label={row.label}
        disabled={row.disabled}
        danger={row.key === "ban"}
        onSelect={row.onSelect}
      />
    </>
  );
}
