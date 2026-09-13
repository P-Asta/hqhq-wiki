"use client";

/**
 * "Report this account" — the moderation action an ordinary editor has.
 *
 * Deliberately small: a name, an optional reason, send. There is no category
 * picker and no severity, because a report is not a verdict — it is a request
 * that a manager look, and every extra field is a chance to make the reporter
 * feel they have to justify themselves before asking.
 *
 * `context` rides along unshown: the page or revision the reporter was looking
 * at when they clicked, so the manager reading the queue does not have to ask
 * "about what?".
 *
 * The body is a div rather than a form on purpose. The chip that opens this
 * can sit inside a form — a history row lives inside the diff-comparison
 * form — and a form nested in a form is invalid HTML whose submit button's
 * owner is left to the browser. Nothing is lost by dropping it: the only field
 * is a textarea, where Enter should start a line rather than send.
 */

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { StatusBanner } from "@/components/ui/status-banner";
import { Textarea } from "@/components/ui/textarea";
import { formatMessage } from "@/lib/i18n";

export interface ReportDialogLabels {
  /** Dialog title — "{name}". */
  title: string;
  /** One line saying what a report is for. */
  description: string;
  reasonLabel: string;
  reasonPlaceholder: string;
  submit: string;
  cancel: string;
  close: string;
  /** Confirmation — "{name}". */
  sent: string;
  /** Failure — "{message}". */
  failed: string;
}

export interface ReportTarget {
  uid: string;
  displayName: string;
  /** e.g. "revision:1841" or "page:main/titan". */
  context?: string;
}

export interface ReportDialogProps {
  target: ReportTarget | null;
  onClose: () => void;
  labels: ReportDialogLabels;
  /** Sends the report; resolves on success, rejects with a message. */
  onSubmit: (input: { target: ReportTarget; reason: string }) => Promise<void>;
}

export function ReportDialog({ target, onClose, labels, onSubmit }: ReportDialogProps) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const close = () => {
    setReason("");
    setError(null);
    setSent(null);
    onClose();
  };

  const submit = async () => {
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ target, reason: reason.trim() });
      setSent(formatMessage(labels.sent, { name: target.displayName }));
      setReason("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={target !== null}
      onClose={close}
      title={formatMessage(labels.title, { name: target?.displayName ?? "" })}
      closeLabel={labels.close}
    >
      {sent ? (
        <div className="space-y-4">
          <StatusBanner tone="info">{sent}</StatusBanner>
          <div className="flex justify-end">
            <Button onClick={close}>{labels.close}</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-mute">{labels.description}</p>
          <div>
            <Label htmlFor="report-reason">{labels.reasonLabel}</Label>
            <Textarea
              id="report-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={labels.reasonPlaceholder}
              maxLength={1000}
              rows={4}
              disabled={busy}
            />
          </div>
          {error ? (
            <StatusBanner tone="error">
              {formatMessage(labels.failed, { message: error })}
            </StatusBanner>
          ) : null}
          <div className="flex justify-end gap-3">
            <Button variant="secondary" type="button" onClick={close} disabled={busy}>
              {labels.cancel}
            </Button>
            <Button type="button" disabled={busy} onClick={() => void submit()}>
              {labels.submit}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
