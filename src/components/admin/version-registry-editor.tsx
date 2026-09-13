"use client";

/**
 * Versions tab — registry CRUD per versioning.md §1/§6 against
 * /api/admin/versions.
 *
 * A version is its **id and its label**, and nothing else is editable here.
 * The ordinal derives from the id (store.ts `versionOrdinal`: major*1000 +
 * minor) and every range window, #ifversion and selector reads that derived
 * value — letting an admin hand-edit it only ever created drift (the case
 * src/lib/visual-editor/version-branch.ts documents, where a hand-set ordinal
 * makes the chip row disagree with the field). Status, release date and notes
 * had no reader at all: the article selector deliberately dropped the status
 * words (versioning.md §6), and nothing renders the other two.
 *
 * The columns still exist in the database and still ride the API — the
 * editor's version-block picker filters on their presence — they are simply
 * no longer an admin's to set.
 *
 * Set-default (site_settings.default_version) and delete stay. A refused
 * delete (409 `version-in-use`) renders the referencing page list the store
 * puts in the error body.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  AdminApiError,
  adminFetch,
  errorMessage,
  type AdminConsoleLabels,
  type GetIdToken,
} from "@/components/admin/admin-tabs";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RowAction, RowActions, RowActionSeparator } from "@/components/ui/row-actions";
import { StatusBanner } from "@/components/ui/status-banner";
import { formatMessage } from "@/lib/i18n";

type VersionStatus = "current" | "supported" | "legacy";

interface VersionRow {
  id: string;
  label: string;
  ordinal: number;
  releasedAt: string | null;
  notes: string | null;
  status: VersionStatus;
  createdAt: string;
}

interface VersionsResponse {
  versions: VersionRow[];
  defaultId: string;
}

interface VersionReferenceRow {
  pageId: number;
  namespace: string;
  slug: string;
  locale: string;
}

interface DeleteRefusal {
  versionId: string;
  referencedBy: VersionReferenceRow[];
}

export interface VersionRegistryEditorProps {
  labels: AdminConsoleLabels;
  getIdToken: GetIdToken;
}

export function VersionRegistryEditor({ labels, getIdToken }: VersionRegistryEditorProps) {
  const [data, setData] = useState<VersionsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<DeleteRefusal | null>(null);
  const [busy, setBusy] = useState(false);

  // add form
  const [newId, setNewId] = useState("");
  const [newLabel, setNewLabel] = useState("");

  // edit dialog
  const [editing, setEditing] = useState<VersionRow | null>(null);
  const [editLabel, setEditLabel] = useState("");

  const load = useCallback(async () => {
    try {
      const next = await adminFetch<VersionsResponse>(getIdToken, "/api/admin/versions");
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

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    setRefusal(null);
    try {
      await fn();
      await load();
    } catch (err) {
      if (
        err instanceof AdminApiError &&
        err.body.code === "version-in-use" &&
        Array.isArray(err.body.referencedBy)
      ) {
        setRefusal({
          versionId: String(err.body.versionId ?? ""),
          referencedBy: err.body.referencedBy as VersionReferenceRow[],
        });
      } else {
        setActionError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const add = (event: React.FormEvent) => {
    event.preventDefault();
    const id = newId.trim().toLowerCase();
    if (!id) return;
    void run(async () => {
      await adminFetch(getIdToken, "/api/admin/versions", {
        method: "POST",
        // Nothing but the identity: the ordinal derives from the id
        // (store.ts versionOrdinal), and status/released/notes are registry
        // trivia no reader ever sees.
        body: { id, label: newLabel.trim() || undefined },
      });
      setNewId("");
      setNewLabel("");
    });
  };

  const openEdit = (row: VersionRow) => {
    setEditing(row);
    setEditLabel(row.label);
  };

  const saveEdit = (event: React.FormEvent) => {
    event.preventDefault();
    const row = editing;
    if (!row) return;
    void run(async () => {
      await adminFetch(getIdToken, "/api/admin/versions", {
        method: "PATCH",
        body: { id: row.id, label: editLabel.trim() || undefined },
      });
      setEditing(null);
    });
  };

  const setDefault = (id: string) =>
    void run(async () => {
      await adminFetch(getIdToken, "/api/admin/versions", {
        method: "PATCH",
        body: { id, default: true },
      });
    });

  const remove = (id: string) =>
    void run(async () => {
      await adminFetch(getIdToken, "/api/admin/versions", {
        method: "DELETE",
        body: { id },
      });
    });

  const sorted = data ? [...data.versions].sort((a, b) => a.ordinal - b.ordinal) : null;

  return (
    <div className="space-y-6">
      {data ? (
        <p className="text-sm text-mute">
          {formatMessage(labels.defaultVersionLine, { version: data.defaultId })}
        </p>
      ) : null}

      <form onSubmit={add} className="flex flex-wrap items-end gap-3">
        <div className="w-28">
          <Label htmlFor="version-id">{labels.versionIdLabel}</Label>
          <Input
            id="version-id"
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            placeholder="v71"
            className="font-mono"
            required
          />
        </div>
        <div className="w-40">
          <Label htmlFor="version-label">{labels.versionLabelLabel}</Label>
          <Input id="version-label" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
        </div>
        <Button type="submit" disabled={busy || !newId.trim()}>
          {labels.addVersion}
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

      {refusal ? (
        <StatusBanner
          tone="warning"
          title={formatMessage(labels.versionDeleteBlockedTitle, { version: refusal.versionId })}
        >
          <span className="block">
            {formatMessage(labels.versionDeleteBlockedBody, {
              count: refusal.referencedBy.length,
            })}
          </span>
          <ul className="mt-1 list-inside list-disc font-mono text-[12px]">
            {refusal.referencedBy.slice(0, 20).map((ref) => (
              <li key={`${ref.pageId}-${ref.locale}`}>
                {ref.namespace === "main" ? ref.slug : `${ref.namespace}:${ref.slug}`} ({ref.locale})
              </li>
            ))}
            {refusal.referencedBy.length > 20 ? <li>…</li> : null}
          </ul>
        </StatusBanner>
      ) : null}

      {sorted && sorted.length === 0 ? (
        <EmptyState title={labels.versionsEmpty} />
      ) : sorted && data ? (
        <div className="overflow-x-auto rounded-[var(--radius-md)] border border-hairline">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-hairline bg-canvas-soft text-left">
                <th className="px-3 py-2 font-semibold text-ink">{labels.versionIdLabel}</th>
                <th className="px-3 py-2 font-semibold text-ink">{labels.actions}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr key={row.id} className="border-b border-hairline last:border-b-0">
                  <td className="px-3 py-2">
                    <span className="rounded-full border border-hairline px-2 py-0.5 font-mono text-[12px] text-ink">
                      {row.id}
                    </span>
                    {row.label && row.label !== row.id ? (
                      <span className="ml-2 text-body">{row.label}</span>
                    ) : null}
                    {row.id === data.defaultId ? (
                      <span className="ml-2 rounded-full bg-primary px-2 py-0.5 text-[11px] text-on-primary">
                        {labels.versionDefaultBadge}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <RowActions
                      label={formatMessage(labels.rowActions, { name: row.id })}
                      disabled={busy}
                    >
                      <RowAction label={labels.edit} onSelect={() => openEdit(row)} />
                      {row.id !== data.defaultId ? (
                        <>
                          <RowAction
                            label={labels.setDefaultVersion}
                            onSelect={() => setDefault(row.id)}
                          />
                          <RowActionSeparator />
                          <RowAction label={labels.delete} danger onSelect={() => remove(row.id)} />
                        </>
                      ) : null}
                    </RowActions>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !loadError ? (
        <div className="h-32 animate-pulse rounded-[var(--radius-md)] bg-canvas-soft" />
      ) : null}

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={formatMessage(labels.versionEditTitle, { version: editing?.id ?? "" })}
        closeLabel={labels.close}
      >
        <form onSubmit={saveEdit} className="space-y-4">
          <div>
            <Label htmlFor="edit-label">{labels.versionLabelLabel}</Label>
            <Input id="edit-label" value={editLabel} onChange={(e) => setEditLabel(e.target.value)} />
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setEditing(null)}>
              {labels.cancel}
            </Button>
            <Button type="submit" disabled={busy}>
              {labels.save}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
