"use client";

/**
 * 409 edit-conflict UI (routes.md /edit): a tonal error banner plus a
 * side-by-side diff of the newly-saved current text (theirs, left) against
 * the editor's unsaved text (yours, right), so the author can merge by hand
 * and publish again — the editor has already rebased `parentRevId` onto the
 * new head by the time this renders.
 */

import { useMemo } from "react";

import { StatusBanner } from "@/components/ui/status-banner";
import { DiffView } from "@/components/wiki/diff-view";
import { diffLines } from "@/lib/diff";

export interface ConflictNoticeLabels {
  title: string;
  description: string;
  yourText: string;
  currentText: string;
}

export interface ConflictNoticeProps {
  /** The text the editor is holding (unsaved). */
  yourText: string;
  /** The head content that was saved underneath the editor. */
  currentText: string;
  labels: ConflictNoticeLabels;
}

export function ConflictNotice({ yourText, currentText, labels }: ConflictNoticeProps) {
  const rows = useMemo(() => diffLines(currentText, yourText), [currentText, yourText]);

  return (
    <div className="flex flex-col gap-3">
      <StatusBanner tone="error" title={labels.title}>
        {labels.description}
      </StatusBanner>
      <DiffView rows={rows} leftLabel={labels.currentText} rightLabel={labels.yourText} />
    </div>
  );
}
