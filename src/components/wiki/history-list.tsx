"use client";

/**
 * Revision table for /{locale}/history (routes.md).
 *
 * - radio-pair diff selection submits a plain GET form to the /diff route,
 *   so comparing works without JavaScript;
 * - rollback POSTs `{action:"rollback", toRevId, locale}` to
 *   /api/pages/[...title] with the caller's Bearer token (rollback lives on
 *   POST because Next forbids segments after a catch-all — routes.md), then
 *   refreshes the server-rendered page.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useAuth } from "@/components/auth-provider";
import { ModerationChip, type ModerationChipLabels } from "@/components/moderation-chip";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBanner } from "@/components/ui/status-banner";
import { dateTimeFormat, formatMessage } from "@/lib/i18n";
import { titleRouteHref } from "@/lib/locale-path";

export interface HistoryRowData {
  id: number;
  comment: string;
  isMinor: boolean;
  authorName: string;
  /** Carried so the author chip can act on the account, not just name it. */
  authorUid: string;
  authorBanned?: boolean;
  /** ISO string — serialized across the RSC boundary. */
  createdAt: string;
  bytes: number;
  isCurrent: boolean;
}

export interface HistoryListLabels {
  columnRevision: string;
  columnDate: string;
  columnAuthor: string;
  columnSummary: string;
  columnSize: string;
  compare: string;
  rollback: string;
  currentBadge: string;
  minorBadge: string;
  empty: string;
  /** "{rev}" placeholders. */
  selectFrom: string;
  selectTo: string;
  rollbackConfirmTitle: string;
  rollbackConfirmDescription: string;
  rollbackFailed: string;
  confirm: string;
  cancel: string;
  close: string;
  /** Report / ban strings for the author chip. */
  moderation: ModerationChipLabels;
}

export interface HistoryListProps {
  /** UI locale (route segment) — drives the diff form target and dates. */
  locale: string;
  /** `nsPrefix+slug` catch-all value. */
  titlePath: string;
  /** Content locale of the listed revisions (per-locale tab). */
  contentLocale: string;
  rows: HistoryRowData[];
  labels: HistoryListLabels;
}

function Badge({ children }: { children: string }) {
  return (
    <span className="rounded-full border border-hairline bg-canvas-soft px-1.5 py-0.5 font-mono text-[11px] text-mute">
      {children}
    </span>
  );
}

export function HistoryList({ locale, titlePath, contentLocale, rows, labels }: HistoryListProps) {
  const router = useRouter();
  const { profile, error: authError, getIdToken } = useAuth();
  // The resolved principal, so a banned account is not offered a rollback the
  // server will refuse.
  const canRollback = profile !== null && authError === null;

  const [fromSel, setFromSel] = useState<number | null>(rows[1]?.id ?? null);
  const [toSel, setToSel] = useState<number | null>(rows[0]?.id ?? null);
  const [confirmRev, setConfirmRev] = useState<number | null>(null);
  const [rollingBack, setRollingBack] = useState(false);
  const [rollbackError, setRollbackError] = useState(false);

  if (rows.length === 0) {
    return <EmptyState title={labels.empty} />;
  }

  async function performRollback(toRevId: number) {
    setRollingBack(true);
    setRollbackError(false);
    try {
      // Null token = signed out; send the request with no Authorization
      // header and let the server's guard answer 401.
      const token = await getIdToken();
      const res = await fetch(`/api/pages/${titlePath}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ action: "rollback", toRevId, locale: contentLocale }),
      });
      if (!res.ok) {
        setRollbackError(true);
        return;
      }
      setConfirmRev(null);
      router.refresh();
    } catch {
      setRollbackError(true);
    } finally {
      setRollingBack(false);
    }
  }

  const dateFormat = dateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });

  return (
    <form
      method="get"
      action={titleRouteHref(locale, "diff", titlePath)}
      className="flex flex-col gap-3"
    >
      {rollbackError ? (
        <StatusBanner tone="error">{labels.rollbackFailed}</StatusBanner>
      ) : null}

      <div className="overflow-hidden rounded-[var(--radius-md)] border border-hairline">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-hairline bg-canvas-soft text-left">
                <th className="w-16 px-3 py-2" aria-hidden />
                <th className="px-3 py-2 font-semibold text-ink">{labels.columnRevision}</th>
                <th className="px-3 py-2 font-semibold text-ink">{labels.columnDate}</th>
                <th className="px-3 py-2 font-semibold text-ink">{labels.columnAuthor}</th>
                <th className="px-3 py-2 font-semibold text-ink">{labels.columnSummary}</th>
                <th className="px-3 py-2 text-right font-semibold text-ink">
                  {labels.columnSize}
                </th>
                <th className="px-3 py-2" aria-hidden />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-hairline last:border-b-0">
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="from"
                        value={row.id}
                        checked={fromSel === row.id}
                        onChange={() => setFromSel(row.id)}
                        aria-label={formatMessage(labels.selectFrom, { rev: row.id })}
                        className="focus-ring size-3.5 accent-[var(--link)]"
                      />
                      <input
                        type="radio"
                        name="to"
                        value={row.id}
                        checked={toSel === row.id}
                        onChange={() => setToSel(row.id)}
                        aria-label={formatMessage(labels.selectTo, { rev: row.id })}
                        className="focus-ring size-3.5 accent-[var(--link)]"
                      />
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[13px] text-body">
                    r{row.id}
                    {row.isCurrent ? (
                      <span className="ml-2">
                        <Badge>{labels.currentBadge}</Badge>
                      </span>
                    ) : null}
                    {row.isMinor ? (
                      <span className="ml-1">
                        <Badge>{labels.minorBadge}</Badge>
                      </span>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-body">
                    {dateFormat.format(new Date(row.createdAt))}
                  </td>
                  <td className="px-3 py-2 text-body">
                    <ModerationChip
                      user={{
                        uid: row.authorUid,
                        displayName: row.authorName,
                        banned: row.authorBanned,
                      }}
                      labels={labels.moderation}
                      context={`revision:${row.id}`}
                      compact
                    />
                  </td>
                  <td className="max-w-80 truncate px-3 py-2 text-mute">{row.comment}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-[13px] text-mute">
                    {row.bytes.toLocaleString(locale)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    {canRollback && !row.isCurrent ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setRollbackError(false);
                          setConfirmRev(row.id);
                        }}
                      >
                        {labels.rollback}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <Button type="submit" variant="secondary" size="sm">
          {labels.compare}
        </Button>
      </div>

      <Dialog
        open={confirmRev !== null}
        onClose={() => setConfirmRev(null)}
        title={labels.rollbackConfirmTitle}
        closeLabel={labels.close}
      >
        <p className="mb-4 text-sm text-body">
          {formatMessage(labels.rollbackConfirmDescription, { rev: confirmRev ?? 0 })}
        </p>
        {rollbackError ? (
          <StatusBanner tone="error" className="mb-4">
            {labels.rollbackFailed}
          </StatusBanner>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={() => setConfirmRev(null)}>
            {labels.cancel}
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={rollingBack}
            onClick={() => {
              if (confirmRev !== null) void performRollback(confirmRev);
            }}
          >
            {labels.confirm}
          </Button>
        </div>
      </Dialog>
    </form>
  );
}
