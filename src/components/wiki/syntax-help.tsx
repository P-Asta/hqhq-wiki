"use client";

/**
 * Syntax-help drawer for the editor (routes.md /edit; versioning.md §6:
 * documents the §2 version constructs with copy buttons). Slides in from the
 * right over a `--backdrop` scrim; Escape and scrim-click close it.
 */

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

export interface SyntaxHelpLabels {
  title: string;
  formatting: string;
  links: string;
  templates: string;
  versions: string;
  copy: string;
  close: string;
}

interface Example {
  /** Wikitext examples are syntax, not copy — identical across locales. */
  code: string;
}

interface Section {
  key: "formatting" | "links" | "templates" | "versions";
  examples: Example[];
}

const SECTIONS: Section[] = [
  {
    key: "formatting",
    examples: [
      { code: "'''bold''' and ''italic''" },
      { code: "== Section ==\n=== Subsection ===" },
      { code: "* bullet item\n# numbered item" },
      { code: '{| class="wikitable"\n! Header 1 !! Header 2\n|-\n| Cell || Cell\n|}' },
      { code: "A statement.<ref>Source here</ref>\n\n== References ==\n<references />" },
    ],
  },
  {
    key: "links",
    examples: [
      { code: "[[Moons]] · [[Moons|the moon list]]" },
      { code: "[[Moons#Titan]] (section link)" },
      { code: "[https://example.com external link]" },
      { code: "[[Category:Mechanics]] (adds the page to a category)" },
      { code: "#REDIRECT [[Moons]]" },
    ],
  },
  {
    key: "templates",
    examples: [
      { code: "{{Stub}}" },
      { code: "{{Infobox\n| title = Name\n| image = file.png\n}}" },
      { code: "{{#ifexist: Moons | exists | missing }}" },
    ],
  },
  {
    key: "versions",
    examples: [
      {
        code: "The base quota is <v50+v61>'''130'''</v50+v61><v62+>'''180'''</v62+>.",
      },
      { code: "<v62+>Added in v62.</v62+>" },
      { code: "<v50+v61>Removed in v62.</v50+v61>" },
      { code: "<v64.1>Only in v64.1.</v64.1>" },
      { code: "{{#ifversion: >=v62 | new text | old text }}" },
      { code: "{{#vswitch: v50=1400 | v62=1500 }}" },
      { code: "{{VERSION}} · {{VERSIONLABEL}} · {{LATESTVERSION}}" },
    ],
  },
];

function CopyButton({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={label}
      title={label}
      className="absolute right-1 top-1 h-6 px-2 text-[11px]"
      onClick={() => {
        void navigator.clipboard?.writeText(code).then(() => setCopied(true));
      }}
    >
      {copied ? "✓" : label}
    </Button>
  );
}

export interface SyntaxHelpProps {
  open: boolean;
  onClose: () => void;
  labels: SyntaxHelpLabels;
}

export function SyntaxHelp({ open, onClose, labels }: SyntaxHelpProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-backdrop" aria-hidden onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={labels.title}
        className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l border-hairline bg-surface shadow-[var(--shadow-md)]"
      >
        <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
          <h2 className="text-sm font-semibold tracking-tight text-ink">{labels.title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={labels.close}
            className="focus-ring inline-flex size-7 items-center justify-center rounded-[var(--radius-sm)] text-mute transition-colors hover:bg-canvas-soft hover:text-ink"
          >
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              className="size-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <path d="M3.5 3.5l9 9m0-9l-9 9" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {SECTIONS.map((section) => (
            <section key={section.key} className="mb-6">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-mute">
                {labels[section.key]}
              </h3>
              <div className="flex flex-col gap-2">
                {section.examples.map((example, i) => (
                  <div key={i} className="relative">
                    <pre className="overflow-x-auto rounded-[var(--radius-sm)] border border-hairline bg-code-bg p-2 pr-16 font-mono text-xs leading-relaxed text-code-ink">
                      {example.code}
                    </pre>
                    <CopyButton code={example.code} label={labels.copy} />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </aside>
    </div>
  );
}
