/**
 * Editing the passage **one version tag** holds — the model behind
 * docs/engine/versioning.md §6's "pick a version and change it".
 *
 * A version block is an atomic node in the visual surface: its wikitext is the
 * truth and §4's round-trip guarantee depends on nothing re-serializing it
 * (visual-editor.md §4). That is why the surface may not turn the passage into
 * a nested editable region — but it says nothing about a *form control*
 * standing beside the preview, and this module is the arithmetic behind that
 * control: which passage the version on screen renders, and how to put new
 * words into that one and into no other.
 *
 * Every function here is pure and exported, because the one thing this feature
 * must never do — write one version's words under another version's id — is
 * decided here rather than in the DOM, where it could only be tested by hand.
 *
 * **A block holds one passage per tag, and may hold several tags.** Since §2.1
 * made the name the range there is no group wrapper, so a page that says one
 * thing from v45 and another from v56 writes two tags back to back with nothing
 * between them — a newline there would be text belonging to *every* version.
 * The block scan takes that whole run as one atomic node, so "which passage
 * does v56 render here" is a question about the run: `versionTagSpans`
 * (version-edit.ts) reads it, and §6 rule 1 picks the answer — the greatest
 * lower bound at or below the selection, never one whose id merely equals it.
 *
 * **An edit here is a splice, not a rebuild.** Only the governing passage's
 * body is replaced; every other byte of the block — the other tags, the ids'
 * own spelling, whatever whitespace padded the construct — comes back exactly
 * as it was. That is why this can serve blocks the version dialog refuses: the
 * dialog has to be able to *spell the whole construct back* (a run is not one
 * tag, so it falls to the raw-wikitext dialog), while this only has to find one
 * body. What it refuses is what it cannot find one body in: prose beside the
 * tags, a tag that never closes or whose closer does not repeat its name, an
 * attribute the name does not carry.
 *
 * Ordinals come from the ids themselves, not from the registry, for the same
 * reason the rest of the editor's version arithmetic does: this is a question
 * about one block, and the block was written in derived order. The one case the
 * two can disagree is an ordinal an admin hand-edited away from its id's
 * natural value (versioning.md §1, /api/admin/versions), where the chip row —
 * which reads registry ordinals — could mark v56 active while the field names
 * v50. Both still name the passage they hold, so nothing is written into the
 * wrong one, and re-ordering the registry reconciles them.
 */

import { buildVersionBlock } from "@/components/wiki/version-dialog";
import { deriveVersionOrdinal, versionTagCovers } from "@/lib/version-branches";
import { versionTagSpans, type VersionTagSpan } from "@/lib/visual-editor/version-edit";
import { versionsUsed } from "@/lib/wikitext-highlight";

/** Ids compare trimmed and case-insensitively, as the rest of §6 has them. */
function foldId(raw: string): string {
  return raw.trim().toLowerCase();
}

/** The passage a block holds, named by the version its tag starts at. */
export interface VersionBranchDraft {
  /** The tag's lower bound, spelled as the page wrote it. */
  id: string;
  body: string;
}

/**
 * The tag in a run that `selected` renders, or null when none of them does.
 *
 * §6 rule 1, applied to a block: `<v56+v72>` read at v70 is what a reader on
 * v70 is looking at, so v70 is where the author types v56's text. Where two
 * tags both cover the selection — a page may write `<v45+>` and `<v56+>` side
 * by side — the later boundary wins, exactly as the greatest boundary at or
 * below the selection wins in the chip row.
 *
 * A tag whose lower bound cannot be ordered (a typo, an id spelled some other
 * way) is skipped rather than guessed at: it might govern and might not, and
 * the honest answer to "might" is not to let anyone type into it.
 */
function governingSpan(
  spans: readonly VersionTagSpan[],
  selected: string,
): VersionTagSpan | null {
  let winner: VersionTagSpan | null = null;
  let best = Number.NEGATIVE_INFINITY;
  for (const span of spans) {
    if (!versionTagCovers({ from: span.from, to: span.to }, selected)) continue;
    const ordinal = deriveVersionOrdinal(span.from);
    if (ordinal === null || ordinal < best) continue;
    winner = span;
    best = ordinal;
  }
  return winner;
}

/**
 * The passage to fall back on when **none** of the block's tags reaches the
 * previewed version.
 *
 * The last thing the block said before that version, if it said anything —
 * previewing v70 over a `<v69>` gives the v69 passage, which is the reading a
 * reader coming from v69 has just left. Where every tag starts *above* the
 * selection there is no such thing, so it is the first thing the block will
 * say instead. Either way it is a real passage with its own id, which is what
 * keeps the head row honest.
 *
 * A tag whose lower bound cannot be ordered is skipped for `governingSpan`'s
 * reason: it might be the nearest and might not, and the honest answer to
 * "might" is not to let anyone type into it.
 */
function nearestSpan(
  spans: readonly VersionTagSpan[],
  selected: string,
): VersionTagSpan | null {
  const target = deriveVersionOrdinal(selected);
  if (target === null) return null;
  let below: { span: VersionTagSpan; ordinal: number } | null = null;
  let above: { span: VersionTagSpan; ordinal: number } | null = null;
  for (const span of spans) {
    const ordinal = deriveVersionOrdinal(span.from);
    if (ordinal === null) continue;
    if (ordinal <= target) {
      if (below === null || ordinal > below.ordinal) below = { span, ordinal };
    } else if (above === null || ordinal < above.ordinal) {
      above = { span, ordinal };
    }
  }
  return below?.span ?? above?.span ?? null;
}

/**
 * What the in-place field should hold for one block at one version — the whole
 * decision, in one place, so the head row and the words under it can never
 * disagree about which passage is on screen.
 */
export type VersionFieldState =
  /**
   * A passage of this block, open for editing.
   *
   * `covers` says whether it is the passage the previewed version actually
   * *renders*. It is false whenever no tag in the block reaches that version —
   * previewing v70 with only a `<v69>` here — and the field is drawn anyway
   * (amended 2026-09-05 by user: "let version blocks be editable at every
   * version"). What made that safe was already in the rules: **the head row
   * names the branch, never the chip**, so the words on screen sit under their
   * own version's id and nothing is written under a version it was not typed
   * for. Refusing was one reading of that rule; naming it is the better one,
   * because it is the same answer the in-range case already gives when the
   * selection is not itself a boundary.
   */
  | { kind: "branch"; branch: VersionBranchDraft; covers: boolean }
  /** No passage at all — a block with no tag this can find. */
  | { kind: "missing" }
  /**
   * Not a block this may edit in place: prose beside the tags, an unclosed or
   * mismatched tag, an attribute the name does not carry. It keeps the preview
   * and the raw-wikitext dialog.
   */
  | { kind: "unsupported" };

export function versionFieldState(source: string, selected: string): VersionFieldState {
  const spans = versionTagSpans(source);
  if (spans === null) return { kind: "unsupported" };
  const governing = governingSpan(spans, selected);
  const span = governing ?? nearestSpan(spans, selected);
  if (span === null) return { kind: "missing" };
  return {
    kind: "branch",
    covers: governing !== null,
    branch: { id: span.from.trim(), body: source.slice(span.bodyStart, span.bodyEnd) },
  };
}

/**
 * One block, with the passage starting at `id` holding `body` instead.
 *
 * Null when the block no longer has exactly one passage starting there. That is
 * not a formality: keystrokes reach here on a debounce, and a block whose tags
 * changed while a word was in flight must drop it rather than land it under a
 * version it was not typed for. Two tags starting at one version are the same
 * refusal — a boundary that shadows itself (§2.1) is not a body this may pick
 * between.
 */
export function replaceBranchBody(source: string, id: string, body: string): string | null {
  const spans = versionTagSpans(source);
  if (spans === null) return null;
  const key = foldId(id);
  const found = spans.filter((span) => foldId(span.from) === key);
  if (found.length !== 1) return null;
  const span = found[0];
  return source.slice(0, span.bodyStart) + body + source.slice(span.bodyEnd);
}

/* ------------------------------------------------------------------ */
/* The page                                                            */
/* ------------------------------------------------------------------ */

/**
 * The buffer with an empty passage for `id` — the strip's `+`, in one function.
 *
 * **Open-ended, and appended.** A chip in the strip means "what this page says
 * from here until the next chip" (§6, `pageVersionBranches`), so the tag the
 * `+` writes is the one that means the same thing: `<v72+>`. It goes at the end
 * of the buffer rather than into an existing run, because narrowing somebody
 * else's window to make room would be this function editing writing the author
 * did not ask it to touch.
 *
 * Empty on purpose. The version-scope dialog refuses to *insert* a block whose
 * passage is blank, because such a block is finished and renders nothing; this
 * one is made in order to be typed into, and the field that holds it is on
 * screen — focused — the moment it exists.
 *
 * A version the page already writes for is left alone: a second boundary for
 * one version is a boundary that shadows itself (§2.1). "Writes for" is
 * `versionsUsed`, which is exactly the list the chips are drawn from, so the
 * menu can never offer one this would refuse.
 */
export function addVersionToPage(source: string, id: string): string {
  const wanted = id.trim();
  if (wanted === "") return source;
  const key = foldId(wanted);
  if (versionsUsed(source).some((used) => foldId(used) === key)) return source;

  // Exactly the version the menu named, not a range from it: `<v70>` is "v70
  // and nothing else" (§2.1), which is what the author chose and what the chip
  // will say. Writing `<v70+>` here would silently make the passage cover every
  // later patch too — the same words under an id that does not claim them, and
  // the chip would still read "v70". A range is a deliberate choice, so it
  // belongs to Insert → Version block, where all three forms are on offer.
  const block = buildVersionBlock({ from: wanted, to: wanted, body: "" });
  const base = source.replace(/\s+$/, "");
  return base === "" ? `${block}\n` : `${base}\n\n${block}\n`;
}
