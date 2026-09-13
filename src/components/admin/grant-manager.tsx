"use client";

/**
 * Grants tab — list every admin grant, add one by uid, revoke active ones.
 * Talks to /api/admin/grants (GET/POST/DELETE). Self-revoke comes back as a
 * 400 `self-revoke` from the store and is surfaced in the error banner.
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RowAction, RowActions } from "@/components/ui/row-actions";
import { StatusBanner } from "@/components/ui/status-banner";
import { formatMessage } from "@/lib/i18n";

interface GrantRow {
  id: number;
  uid: string;
  grantedBy: string;
  grantedAt: string;
  revokedBy: string | null;
  revokedAt: string | null;
}

interface GrantsResponse {
  grants: GrantRow[];
  users: Record<string, { displayName: string; banned: boolean }>;
}

export interface GrantManagerProps {
  labels: AdminConsoleLabels;
  getIdToken: GetIdToken;
}

export function GrantManager({ labels, getIdToken }: GrantManagerProps) {
  const [data, setData] = useState<GrantsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uid, setUid] = useState("");
  const [displayName, setDisplayName] = useState("");

  const load = useCallback(async () => {
    try {
      const next = await adminFetch<GrantsResponse>(getIdToken, "/api/admin/grants");
      setData(next);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [getIdToken]);

  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    void load();
  }, [load]);

  const grant = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!uid.trim() || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await adminFetch(getIdToken, "/api/admin/grants", {
        method: "POST",
        body: { uid: uid.trim(), displayName: displayName.trim() || undefined },
      });
      setUid("");
      setDisplayName("");
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (targetUid: string) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await adminFetch(getIdToken, "/api/admin/grants", {
        method: "DELETE",
        body: { uid: targetUid },
      });
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const nameOf = (targetUid: string): string =>
    data?.users[targetUid]?.displayName ?? labels.anonymous;

  return (
    <div className="space-y-6">
      <p className="text-sm text-mute">{labels.grantsDescription}</p>

      <form onSubmit={grant} className="flex flex-wrap items-end gap-3">
        <div className="w-full max-w-64">
          <Label htmlFor="grant-uid">{labels.uidLabel}</Label>
          <Input
            id="grant-uid"
            value={uid}
            onChange={(e) => setUid(e.target.value)}
            className="font-mono"
            required
          />
        </div>
        <div className="w-full max-w-64">
          <Label htmlFor="grant-name">{labels.displayNameLabel}</Label>
          <Input
            id="grant-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={busy || !uid.trim()}>
          {labels.grantRole}
        </Button>
      </form>

      {actionError ? (
        <StatusBanner tone="error">
          {formatMessage(labels.actionFailed, { message: actionError })}
        </StatusBanner>
      ) : null}
      {loadError ? (
        <StatusBanner tone="error">
          {formatMessage(labels.loadFailed, { message: loadError })}
        </StatusBanner>
      ) : null}

      {data && data.grants.length === 0 ? (
        <EmptyState title={labels.grantsEmpty} />
      ) : data ? (
        <div className="overflow-x-auto rounded-[var(--radius-md)] border border-hairline">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-hairline bg-canvas-soft text-left">
                <th className="px-3 py-2 font-semibold text-ink">{labels.userLabel}</th>
                <th className="px-3 py-2 font-semibold text-ink">{labels.grantColumnGrantedBy}</th>
                <th className="px-3 py-2 font-semibold text-ink">{labels.grantColumnGrantedAt}</th>
                <th className="px-3 py-2 font-semibold text-ink">{labels.statusColumn}</th>
                <th className="px-3 py-2 font-semibold text-ink">{labels.actions}</th>
              </tr>
            </thead>
            <tbody>
              {data.grants.map((row) => {
                const active = row.revokedAt === null;
                const banned = data.users[row.uid]?.banned === true;
                return (
                  <tr key={row.id} className="border-b border-hairline last:border-b-0">
                    <td className="px-3 py-2">
                      <span className="text-body">{nameOf(row.uid)}</span>{" "}
                      <span className="font-mono text-[12px] text-mute">{row.uid}</span>
                      {banned ? (
                        <span className="ml-2 rounded-full border border-error/40 bg-error-soft px-2 py-0.5 text-[11px] text-error">
                          {labels.bannedBadge}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-body">{nameOf(row.grantedBy)}</td>
                    <td className="px-3 py-2 font-mono text-[12px] text-mute">
                      {new Date(row.grantedAt).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-2">
                      {active ? (
                        <span className="text-success">{labels.grantStatusActive}</span>
                      ) : (
                        <span className="text-mute">{labels.grantStatusRevoked}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {active ? (
                        <RowActions
                          label={formatMessage(labels.rowActions, { name: nameOf(row.uid) })}
                          disabled={busy}
                        >
                          <RowAction
                            label={labels.revokeRole}
                            danger
                            onSelect={() => void revoke(row.uid)}
                          />
                        </RowActions>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : !loadError ? (
        <div className="h-32 animate-pulse rounded-[var(--radius-md)] bg-canvas-soft" />
      ) : null}
    </div>
  );
}
