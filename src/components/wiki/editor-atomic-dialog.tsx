"use client";

/**
 * Raw-wikitext editor for one atomic node — a table, a gallery, a version
 * block, a parser function nobody wants to retype (docs/engine/visual-editor.md
 * §5). It is the **only** way an atomic node's source changes: the surface
 * draws those nodes `contenteditable="false"` precisely so the browser can
 * never touch them, and §4's guarantee rests on that — a node the author does
 * not open here is emitted byte for byte.
 *
 * Fandom's template dialog is the model, and template-dialog.tsx is the
 * parameter-form half of it. This is the fallback for everything that has no
 * form to offer.
 *
 * The textarea repeats the source editor's metrics (`--font-mono`, 13px on a
 * 20px line) rather than inventing its own, so wikitext an author moves
 * between the two keeps its shape. As in the link dialog, the draft lives in a
 * component that only exists while the dialog is open, so each opening starts
 * from the node actually selected rather than from the last one.
 */

import { useState, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FieldMessage } from "@/components/ui/field-message";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export interface AtomicDialogLabels {
  title: string;
  hint: string;
  apply: string;
  close: string;
}

export interface AtomicDialogProps {
  open: boolean;
  /** Localised kind name; the caller has already folded it into `labels.title`. */
  label: string;
  source: string;
  onClose: () => void;
  onApply: (source: string) => void;
  labels: AtomicDialogLabels;
}

export function AtomicDialog({
  open,
  label,
  source,
  onClose,
  onApply,
  labels,
}: AtomicDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={labels.title}
      closeLabel={labels.close}
      // Wider than the default panel: the caller can hand this an infobox call
      // twenty lines long, and wrapping one would hide its shape.
      className="max-w-3xl"
    >
      <AtomicField
        label={label}
        source={source}
        onClose={onClose}
        onApply={onApply}
        labels={labels}
      />
    </Dialog>
  );
}

function AtomicField({ label, source, onClose, onApply, labels }: Omit<AtomicDialogProps, "open">) {
  const [draft, setDraft] = useState(source);

  // Nothing to apply until the author has actually changed something — and an
  // unchanged block must keep its original bytes, not be rewritten (§4).
  const changed = draft !== source;

  const apply = () => {
    if (!changed) return;
    onApply(draft);
  };

  // Enter belongs to the wikitext here, so the keyboard commit is the
  // Ctrl/Cmd+Enter the publish bar already answers to (§6).
  const onDraftKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    apply();
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Label htmlFor="atomic-dialog-source">{label}</Label>
        <Textarea
          id="atomic-dialog-source"
          autoFocus
          rows={16}
          value={draft}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="min-h-[20rem] font-mono text-[13px] leading-5"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onDraftKeyDown}
        />
        <FieldMessage>{labels.hint}</FieldMessage>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-hairline pt-3">
        <Button variant="secondary" onClick={onClose}>
          {labels.close}
        </Button>
        <Button disabled={!changed} onClick={apply}>
          {labels.apply}
        </Button>
      </div>
    </div>
  );
}
