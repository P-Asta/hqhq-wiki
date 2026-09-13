"use client";

/**
 * The syntax-highlighted mirror that sits behind the editor's transparent
 * textarea (src/components/wiki/editor-source.tsx).
 *
 * Purely presentational and dependency-free: `highlight()`
 * (src/lib/wikitext-highlight.ts) turns the buffer into a lossless token
 * stream, and this component paints each token with a `--syntax-*` token from
 * theme.md. Because the stream is lossless, the painted text is byte-identical
 * to the textarea's, which is what keeps the caret on top of its glyph.
 *
 * Rendered `aria-hidden`: the textarea above it is the accessible control.
 */

import { memo } from "react";

import { highlight, type HighlightTokenType } from "@/lib/wikitext-highlight";

/** Token type → Tailwind classes bridged to the `--syntax-*` tokens. */
const TOKEN_CLASS: Record<HighlightTokenType, string> = {
  text: "",
  comment: "text-syntax-comment italic",
  nowiki: "text-mute",
  tag: "text-syntax-tag",
  template: "text-syntax-template",
  parameter: "text-syntax-param",
  heading: "font-semibold text-syntax-heading",
  bold: "font-semibold text-syntax-emphasis",
  italic: "text-syntax-emphasis italic",
  link: "text-syntax-link",
  "link-label": "text-syntax-label",
  external: "text-syntax-external",
  table: "text-syntax-structure",
  list: "font-semibold text-syntax-structure",
  hr: "text-syntax-structure",
  entity: "text-syntax-tag",
};

export interface EditorHighlightProps {
  source: string;
  /** Forwarded to the `<pre>` so the editor can sync its scroll offsets. */
  mirrorRef?: React.Ref<HTMLPreElement>;
}

function EditorHighlightImpl({ source, mirrorRef }: EditorHighlightProps) {
  // A trailing newline would otherwise collapse and the last (empty) line
  // would have no height, so the mirror would end one row short of the
  // textarea while scrolled to the bottom.
  const tokens = highlight(source.endsWith("\n") ? `${source} ` : source);

  return (
    <pre ref={mirrorRef} aria-hidden className="wiki-source-layer wiki-source-mirror">
      {tokens.map((token, i) => {
        const className = TOKEN_CLASS[token.type];
        return className === "" ? (
          token.text
        ) : (
          <span key={i} className={className}>
            {token.text}
          </span>
        );
      })}
    </pre>
  );
}

/**
 * Memoized on `source`: the editor re-renders on every keystroke, and
 * re-tokenizing a long article is the one thing in this island that could be
 * felt while typing.
 */
export const EditorHighlight = memo(EditorHighlightImpl);
