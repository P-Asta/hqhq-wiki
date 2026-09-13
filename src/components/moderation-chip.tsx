"use client";

/**
 * A name on a reader-facing page — a history row's author, a recent change —
 * carrying whatever moderation the *viewer* is entitled to.
 *
 * This is the piece that decides which. `UserChip` renders whatever actions it
 * is handed and asks no questions; the admin console hands it `onBan` because
 * every viewer there is already a manager. Out here the viewer is whoever
 * happened to open the page, so the entitlement has to be read per-render:
 *
 *   signed out       → no menu at all; a name is just a name
 *   signed in        → report (`POST /api/reports`)
 *   manager          → ban outright (`POST /api/admin/ban`), no queue in between
 *
 * Both routes re-check this server-side — `requirePrincipal` and
 * `authenticateManagerRequest` respectively — so what happens here only decides
 * what is worth offering, never what is permitted.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useAuth } from "@/components/auth-provider";
import { ReportDialog, type ReportDialogLabels, type ReportTarget } from "@/components/report-dialog";
import { UserChip, type ChipUser, type UserChipLabels } from "@/components/user-chip";
import { formatMessage } from "@/lib/i18n";

export interface ModerationChipLabels {
  chip: UserChipLabels;
  report: ReportDialogLabels;
  /** Ban confirmation — "{name}". */
  banApplied: string;
  /** Unban confirmation — "{name}". */
  banLifted: string;
  /** Ban failure — "{message}". */
  banFailed: string;
}

export interface ModerationChipProps {
  user: ChipUser;
  labels: ModerationChipLabels;
  /**
   * What the viewer was looking at — "revision:1841", "page:main/titan". Rides
   * along on the report so the manager reading the queue has the "about what?".
   */
  context?: string;
  compact?: boolean;
  className?: string;
}

async function postJson(url: string, token: string | null, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (res.ok) return;
  let message = `Request failed (${res.status}).`;
  try {
    const parsed = (await res.json()) as { error?: { message?: string } };
    if (parsed?.error?.message) message = parsed.error.message;
  } catch {
    // unshaped failure — the status line above stands
  }
  throw new Error(message);
}

export function ModerationChip({
  user,
  labels,
  context,
  compact,
  className,
}: ModerationChipProps) {
  const router = useRouter();
  const { user: viewer, profile, canAccessAdminPanel, getIdToken } = useAuth();
  const [reporting, setReporting] = useState<ReportTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // `profile` — not `user` — is the server-resolved principal: a signed-in but
  // banned account has the former null, and the report route would refuse it.
  const canReport = profile !== null;

  const submitReport = async ({ target, reason }: { target: ReportTarget; reason: string }) => {
    await postJson("/api/reports", await getIdToken(), {
      targetUid: target.uid,
      reason,
      context: target.context,
    });
  };

  const ban = (target: ChipUser, banned: boolean) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    void (async () => {
      try {
        await postJson("/api/admin/ban", await getIdToken(), {
          username: target.displayName ?? target.uid,
          uid: target.uid,
          banned,
        });
        setNotice(
          formatMessage(banned ? labels.banApplied : labels.banLifted, {
            name: target.displayName ?? target.uid,
          }),
        );
        // The banned badge lives in server-rendered rows.
        router.refresh();
      } catch (err) {
        setNotice(
          formatMessage(labels.banFailed, {
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <>
      <UserChip
        user={user}
        labels={labels.chip}
        viewerUid={viewer?.uid ?? null}
        disabled={busy}
        compact={compact}
        className={className}
        actions={{
          onReport: canReport
            ? (target) =>
                setReporting({
                  uid: target.uid,
                  displayName: target.displayName ?? labels.chip.anonymous,
                  context,
                })
            : undefined,
          onBan: canAccessAdminPanel ? ban : undefined,
        }}
      />

      {notice ? (
        <span role="status" className="mt-0.5 block text-[11px] text-mute">
          {notice}
        </span>
      ) : null}

      <ReportDialog
        target={reporting}
        onClose={() => setReporting(null)}
        labels={labels.report}
        onSubmit={submitReport}
      />
    </>
  );
}

/** Builds the label bundle from a resolved dictionary, for the server pages. */
export function moderationChipLabels(dict: {
  moderation: {
    userActions: string;
    report: string;
    ban: string;
    unban: string;
    copyId: string;
    reportTitle: string;
    reportDescription: string;
    reportReasonLabel: string;
    reportReasonPlaceholder: string;
    reportSubmit: string;
    reportSent: string;
    reportFailed: string;
    banApplied: string;
    banLifted: string;
  };
  admin: { bannedBadge: string; actionFailed: string };
  common: { anonymous: string; cancel: string; close: string };
  roles: Record<string, string>;
}): ModerationChipLabels {
  return {
    chip: {
      rowActions: dict.moderation.userActions,
      report: dict.moderation.report,
      ban: dict.moderation.ban,
      unban: dict.moderation.unban,
      copyId: dict.moderation.copyId,
      bannedBadge: dict.admin.bannedBadge,
      anonymous: dict.common.anonymous,
      roleNames: dict.roles,
    },
    report: {
      title: dict.moderation.reportTitle,
      description: dict.moderation.reportDescription,
      reasonLabel: dict.moderation.reportReasonLabel,
      reasonPlaceholder: dict.moderation.reportReasonPlaceholder,
      submit: dict.moderation.reportSubmit,
      cancel: dict.common.cancel,
      close: dict.common.close,
      sent: dict.moderation.reportSent,
      failed: dict.moderation.reportFailed,
    },
    banApplied: dict.moderation.banApplied,
    banLifted: dict.moderation.banLifted,
    banFailed: dict.admin.actionFailed,
  };
}
