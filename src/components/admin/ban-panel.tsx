"use client";

/**
 * Bans tab — ban or unban a user BY USERNAME via POST /api/admin/ban (O5: the
 * route writes the authoritative Firestore flag and the SQLite mirror in the
 * same action). The name is picked from a live autocomplete over real
 * accounts; the server still resolves it and refuses anything ambiguous.
 * Success and failure both surface as banners.
 */

import { useState } from "react";

import {
  adminFetch,
  errorMessage,
  type AdminConsoleLabels,
  type GetIdToken,
} from "@/components/admin/admin-tabs";
import { UsernamePicker } from "@/components/admin/username-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBanner } from "@/components/ui/status-banner";
import { formatMessage } from "@/lib/i18n";

export interface BanPanelProps {
  labels: AdminConsoleLabels;
  getIdToken: GetIdToken;
}

export function BanPanel({ labels, getIdToken }: BanPanelProps) {
  const [username, setUsername] = useState("");
  // The account the picker actually offered. A username is not a key — two
  // accounts can claim one — so the uid decides whenever we have it, and a
  // name typed by hand (uid null) falls back to the server's exactly-one rule.
  const [uid, setUid] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (banned: boolean) => {
    const target = username.trim();
    if (!target || busy) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const result = await adminFetch<{ username: string }>(getIdToken, "/api/admin/ban", {
        method: "POST",
        body: {
          username: target,
          uid: uid ?? undefined,
          banned,
          reason: reason.trim() || undefined,
        },
      });
      setNotice(
        formatMessage(banned ? labels.banApplied : labels.banLifted, { name: result.username }),
      );
      setUsername("");
      setUid(null);
      setReason("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-xl space-y-6">
      <p className="text-sm text-mute">{labels.bansDescription}</p>

      <div className="space-y-4">
        <div>
          <Label htmlFor="ban-username">{labels.userLabel}</Label>
          <UsernamePicker
            id="ban-username"
            value={username}
            // Typing by hand invalidates the picked account: the name in the
            // box is no longer the one that uid belongs to.
            onValueChange={(next) => {
              setUsername(next);
              setUid(null);
            }}
            onSelect={(row) => setUid(row.uid)}
            getIdToken={getIdToken}
            disabled={busy}
            labels={{
              placeholder: labels.usernamePlaceholder,
              listLabel: labels.usernameSuggestions,
              empty: labels.usernameEmpty,
              loading: labels.loading,
              bannedHint: labels.bannedBadge,
            }}
          />
        </div>
        <div>
          <Label htmlFor="ban-reason">{labels.banReasonLabel}</Label>
          <Input
            id="ban-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
          />
        </div>
        <div className="flex gap-3">
          <Button
            variant="danger"
            disabled={busy || !username.trim()}
            onClick={() => void submit(true)}
          >
            {labels.banUser}
          </Button>
          <Button
            variant="secondary"
            disabled={busy || !username.trim()}
            onClick={() => void submit(false)}
          >
            {labels.unbanUser}
          </Button>
        </div>
      </div>

      {notice ? <StatusBanner tone="info">{notice}</StatusBanner> : null}
      {error ? (
        <StatusBanner tone="error">
          {formatMessage(labels.actionFailed, { message: error })}
        </StatusBanner>
      ) : null}
    </div>
  );
}
