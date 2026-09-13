"use client";

/**
 * Reports tab — the moderation queue, kept apart from the audit log on
 * purpose. The audit log says what HAPPENED; a report says what somebody
 * THINKS should happen, and only reports have a state a manager has to move
 * (open → resolved / dismissed). Mixing them would bury the handful of rows
 * that need a decision under every edit the wiki has ever recorded.
 *
 * Open reports come first because they are the only kind that needs anybody;
 * the filter is how you go looking for what was already dealt with.
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
import { RowAction, RowActions, RowActionSeparator } from "@/components/ui/row-actions";
import { Select } from "@/components/ui/select";
import { StatusBanner } from "@/components/ui/status-banner";
import { UserChip, type ChipUser } from "@/components/user-chip";
import { formatMessage } from "@/lib/i18n";

type ReportStatus = "open" | "resolved" | "dismissed";

interface ReportRow {
  id: number;
  targetUid: string;
  reporterUid: string;
  reason: string;
  context: string;
  status: ReportStatus;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

interface ReportUser {
  displayName: string;
  banned: boolean;
}

interface ReportsResponse {
  rows: ReportRow[];
  nextCursor: number | null;
  users: Record<string, ReportUser>;
  /** Open reports overall, not just in this page or filter. */
  openCount: number;
}

const FILTERS: Array<ReportStatus | "all"> = ["open", "resolved", "dismissed", "all"];

export interface ReportQueueProps {
  labels: AdminConsoleLabels;
  getIdToken: GetIdToken;
  viewerUid: string | null;
  onBan: (user: ChipUser, banned: boolean) => void;
  /** Bumped by the console when a ban lands, so the queue re-reads. */
  refreshKey?: number;
  /** Reports the tab badge with the open count each load reveals. */
  onOpenCount?: (count: number) => void;
}

export function ReportQueue({
  labels,
  getIdToken,
  viewerUid,
  onBan,
  refreshKey = 0,
  onOpenCount,
}: ReportQueueProps) {
  const [filter, setFilter] = useState<ReportStatus | "all">("open");
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [users, setUsers] = useState<Record<string, ReportUser>>({});
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Changing the filter must replace the list, not append to it. */
  const loadedKey = useRef<string>("");

  const load = useCallback(
    async (status: ReportStatus | "all", cursor?: number) => {
      setBusy(true);
      setError(null);
      try {
        const params = new URLSearchParams({ status });
        if (cursor !== undefined) params.set("cursor", String(cursor));
        const page = await adminFetch<ReportsResponse>(
          getIdToken,
          `/api/admin/reports?${params.toString()}`,
        );
        setRows((prev) => (cursor === undefined || !prev ? page.rows : [...prev, ...page.rows]));
        setUsers((prev) => ({ ...prev, ...page.users }));
        setNextCursor(page.nextCursor);
        onOpenCount?.(page.openCount);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [getIdToken, onOpenCount],
  );

  useEffect(() => {
    const key = `${filter}:${refreshKey}`;
    if (loadedKey.current === key) return;
    loadedKey.current = key;
    setRows(null);
    void load(filter);
  }, [filter, refreshKey, load]);

  const close = (id: number, status: "resolved" | "dismissed") => {
    if (busy) return;
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        await adminFetch(getIdToken, "/api/admin/reports", {
          method: "PATCH",
          body: { id, status },
        });
        loadedKey.current = "";
        await load(filter);
      } catch (err) {
        setError(errorMessage(err));
        setBusy(false);
      }
    })();
  };

  const chip = (uid: string, actions: { onBan?: typeof onBan }) => (
    <UserChip
      user={{
        uid,
        displayName: users[uid]?.displayName ?? null,
        banned: users[uid]?.banned,
      }}
      labels={labels.userChip}
      actions={actions}
      viewerUid={viewerUid}
      compact
    />
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Select
          aria-label={labels.reportFilterLabel}
          value={filter}
          onChange={(e) => setFilter(e.target.value as ReportStatus | "all")}
          wrapperClassName="w-44"
        >
          {FILTERS.map((value) => (
            <option key={value} value={value}>
              {labels.reportStatus[value]}
            </option>
          ))}
        </Select>
      </div>

      {error ? (
        <StatusBanner tone="error">
          {formatMessage(labels.loadFailed, { message: error })}
        </StatusBanner>
      ) : null}

      {rows && rows.length === 0 ? (
        <EmptyState title={labels.reportsEmpty} />
      ) : rows ? (
        <>
          <div className="overflow-x-auto rounded-[var(--radius-md)] border border-hairline">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-hairline bg-canvas-soft text-left">
                  <th className="px-3 py-2 font-semibold text-ink">{labels.reportColumnTarget}</th>
                  <th className="px-3 py-2 font-semibold text-ink">
                    {labels.reportColumnReporter}
                  </th>
                  <th className="px-3 py-2 font-semibold text-ink">{labels.reportColumnReason}</th>
                  <th className="px-3 py-2 font-semibold text-ink">{labels.statusColumn}</th>
                  <th className="px-3 py-2 font-semibold text-ink">{labels.auditColumnDate}</th>
                  <th className="px-3 py-2 font-semibold text-ink">{labels.actions}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-hairline last:border-b-0">
                    {/* The reported account is the one a manager acts on. */}
                    <td className="px-3 py-2">{chip(row.targetUid, { onBan })}</td>
                    <td className="px-3 py-2">{chip(row.reporterUid, {})}</td>
                    <td className="max-w-md px-3 py-2 text-body">
                      <span className="block whitespace-pre-wrap">{row.reason || "—"}</span>
                      {row.context ? (
                        <span className="mt-0.5 block font-mono text-[11px] text-faint">
                          {row.context}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          row.status === "open" ? "text-warning" : "text-mute"
                        }
                      >
                        {labels.reportStatus[row.status]}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-[12px] text-mute">
                      {new Date(row.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {row.status === "open" ? (
                        <RowActions
                          label={formatMessage(labels.rowActions, { name: `#${row.id}` })}
                          disabled={busy}
                        >
                          <RowAction
                            label={labels.reportResolve}
                            onSelect={() => close(row.id, "resolved")}
                          />
                          <RowActionSeparator />
                          <RowAction
                            label={labels.reportDismiss}
                            onSelect={() => close(row.id, "dismissed")}
                          />
                        </RowActions>
                      ) : null}
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
              onClick={() => void load(filter, nextCursor)}
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
