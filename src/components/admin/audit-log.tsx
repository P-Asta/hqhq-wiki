"use client";

/**
 * Audit tab — keyset-paginated read of /api/admin/audit. Actions and targets
 * render in mono per theme.md typography.
 *
 * The actor is a {@link UserChip}, not a name: a moderator reading this log is
 * usually reading it ABOUT somebody, so the ban lives on the person rather
 * than on a separate screen they have to carry a uid to. Right-click or the
 * ⋯ button, same rows either way.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  adminFetch,
  errorMessage,
  type AdminConsoleLabels,
  type GetIdToken,
} from "@/components/admin/admin-tabs";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBanner } from "@/components/ui/status-banner";
import { UserChip, type ChipUser } from "@/components/user-chip";
import { formatMessage } from "@/lib/i18n";

interface AuditRow {
  id: number;
  action: string;
  actorUid: string;
  target: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface AuditUser {
  displayName: string;
  banned: boolean;
}

interface AuditResponse {
  rows: AuditRow[];
  nextCursor: number | null;
  users: Record<string, AuditUser>;
}

export interface AuditLogProps {
  labels: AdminConsoleLabels;
  getIdToken: GetIdToken;
  /** The signed-in manager, so the chip refuses to act on itself. */
  viewerUid: string | null;
  /** Ban or unban somebody named in a row; refreshes the page on success. */
  onBan: (user: ChipUser, banned: boolean) => void;
}

/**
 * A `target` that names an account, or null. Targets are written by
 * `writeAudit` as `"<kind>:<id>"` — `user:abc123`, `page:main/titan`,
 * `version:v70` — so only the `user:` ones can carry a chip.
 */
function targetUid(target: string): string | null {
  const uid = target.startsWith("user:") ? target.slice("user:".length) : "";
  return uid === "" ? null : uid;
}

export function AuditLog({ labels, getIdToken, viewerUid, onBan }: AuditLogProps) {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [users, setUsers] = useState<Record<string, AuditUser>>({});
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loadedRef = useRef(false);

  /** A uid → what the chip needs to name and act on that account. */
  const chipUser = (uid: string): ChipUser => ({
    uid,
    displayName: users[uid]?.displayName ?? null,
    banned: users[uid]?.banned,
  });

  const load = useCallback(
    async (cursor?: number) => {
      setBusy(true);
      setError(null);
      try {
        const query = cursor === undefined ? "" : `?cursor=${cursor}`;
        const page = await adminFetch<AuditResponse>(getIdToken, `/api/admin/audit${query}`);
        setRows((prev) => (cursor === undefined || !prev ? page.rows : [...prev, ...page.rows]));
        setUsers((prev) => ({ ...prev, ...page.users }));
        setNextCursor(page.nextCursor);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [getIdToken],
  );

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      {error ? (
        <StatusBanner tone="error">
          {formatMessage(labels.loadFailed, { message: error })}
        </StatusBanner>
      ) : null}

      {rows && rows.length === 0 ? (
        <EmptyState title={labels.auditEmpty} />
      ) : rows ? (
        <>
          <div className="overflow-x-auto rounded-[var(--radius-md)] border border-hairline">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-hairline bg-canvas-soft text-left">
                  <th className="px-3 py-2 font-semibold text-ink">{labels.auditColumnAction}</th>
                  <th className="px-3 py-2 font-semibold text-ink">{labels.auditColumnActor}</th>
                  <th className="px-3 py-2 font-semibold text-ink">{labels.auditColumnTarget}</th>
                  <th className="px-3 py-2 font-semibold text-ink">{labels.auditColumnDate}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-hairline last:border-b-0">
                    <td className="px-3 py-2 text-ink">
                      {/* The sentence, with the stored id under it: one is
                          what a manager reads, the other is what they grep. */}
                      {labels.auditActions[row.action as keyof typeof labels.auditActions] ??
                        row.action}
                      <span className="block font-mono text-[11px] text-faint">{row.action}</span>
                    </td>
                    <td className="px-3 py-2">
                      <UserChip
                        user={chipUser(row.actorUid)}
                        labels={labels.userChip}
                        actions={{ onBan }}
                        viewerUid={viewerUid}
                        compact
                      />
                    </td>
                    <td className="px-3 py-2 text-body">
                      {/* A target naming an account gets a chip of its own.
                          Without it the actor is the only clickable name on
                          the row, and on a "Reported an account" row that is
                          the REPORTER — a manager reaching for the offender
                          would ban the person who spoke up. */}
                      {targetUid(row.target) ? (
                        <UserChip
                          user={chipUser(targetUid(row.target)!)}
                          labels={labels.userChip}
                          actions={{ onBan }}
                          viewerUid={viewerUid}
                          compact
                        />
                      ) : (
                        <span className="font-mono text-[12px]">{row.target}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-[12px] text-mute">
                      {new Date(row.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {nextCursor !== null ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void load(nextCursor)}
            >
              {labels.loadMore}
            </Button>
          ) : null}
        </>
      ) : !error ? (
        <div className="h-32 animate-pulse rounded-[var(--radius-md)] bg-canvas-soft" />
      ) : null}
    </div>
  );
}
