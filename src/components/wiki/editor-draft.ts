/**
 * The decisions behind "never lose an edit" — docs/engine/visual-editor.md §8.
 *
 * The editor writes its buffer to `localStorage` on a debounce and offers it
 * back the next time the page is opened. Everything about *which* draft that
 * is, and *whether* it may be offered, is here rather than in the island,
 * because none of it needs a browser and all of it is the kind of question
 * that is answered wrong by accident:
 *
 * - **Which key.** A draft belongs to one page, in one locale, written against
 *   one parent revision (§8.2). Leaving any of the three out of the key means
 *   an edit to the EN article is offered back on the KO one, or a draft from
 *   before somebody else's publish is offered as if nothing had happened.
 * - **Whether to offer it at all.** A draft identical to the server's text is
 *   not an edit, it is a page that was opened and closed — offering it is
 *   noise, and noise is how a banner stops being read.
 * - **Whether to warn.** A draft found under *another* revision of the same
 *   page is still the author's work and must not be thrown away silently; but
 *   it was written against text that has since changed, so restoring it can
 *   undo whoever published in between. It is offered, and it says so.
 *
 * Nothing here touches `localStorage`. The caller reads the entries (guarded —
 * private mode throws on the first property access) and hands them in, which
 * is also what makes every rule below testable in vitest's node environment.
 */

/** Namespace for every key this module owns, so a scan can find them all. */
export const DRAFT_KEY_PREFIX = "hqhq-wiki:draft";

/** Which page, in which locale — the part of a draft's identity that is fixed. */
export interface DraftPage {
  /** The `nsPrefix+slug` catch-all value, e.g. `"template:infobox-moon"`. */
  titlePath: string;
  locale: string;
}

/** A page, and the head its buffer was loaded from (null while creating it). */
export interface DraftIdentity extends DraftPage {
  parentRevId: number | null;
}

/** One `localStorage` row, as the caller read it out. */
export interface DraftEntry {
  key: string;
  value: string;
}

/** What a draft row holds. `savedAt` is epoch milliseconds. */
export interface StoredDraft {
  content: string;
  savedAt: number;
  parentRevId: number | null;
}

/**
 * Every key for this page in this locale starts with this, whatever revision
 * it was written against — which is what lets §8.2's "somebody has edited
 * since" case be *found* rather than merely missed.
 *
 * Both parts are percent-encoded, so the separator cannot appear inside them.
 * A title path may legitimately contain a colon (`template:infobox-moon`), and
 * an unencoded one would make the prefix of page `moon` also the prefix of
 * page `moon:artifice` — one page silently offering another page's draft.
 */
export function draftPagePrefix(page: DraftPage): string {
  return `${DRAFT_KEY_PREFIX}:${encodeURIComponent(page.locale)}:${encodeURIComponent(page.titlePath)}:`;
}

/** The exact key a draft written against this revision is stored under. */
export function draftKey(id: DraftIdentity): string {
  const revision = id.parentRevId === null ? "new" : `r${id.parentRevId}`;
  return `${draftPagePrefix(id)}${revision}`;
}

export function serializeDraft(draft: StoredDraft): string {
  return JSON.stringify(draft);
}

/**
 * A stored row back into a draft, or null for anything that is not one.
 *
 * Storage is shared with every other tab, every past version of this code and
 * anything else on the origin, so the row may be a truncated write, a value
 * from an older shape, or somebody else's key that happens to collide. None of
 * that may throw and none of it may be offered: a draft this cannot vouch for
 * is a draft that could overwrite an article with garbage.
 */
export function parseDraft(raw: string | null): StoredDraft | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  if (!("content" in value) || !("savedAt" in value)) return null;
  const content: unknown = value.content;
  const savedAt: unknown = value.savedAt;
  const parentRevId: unknown = "parentRevId" in value ? value.parentRevId : null;
  if (typeof content !== "string") return null;
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) return null;
  if (parentRevId !== null && (typeof parentRevId !== "number" || !Number.isFinite(parentRevId))) {
    return null;
  }
  return { content, savedAt, parentRevId };
}

/**
 * What the editor should offer on opening: nothing, or one draft — and whether
 * that draft was written against text the page has since moved past.
 */
export type DraftOffer =
  | { kind: "none" }
  | {
      kind: "offer";
      /** The row it came from, so discarding removes exactly that one. */
      key: string;
      draft: StoredDraft;
      /**
       * True when the draft was written against another revision of this page:
       * somebody has published since, and restoring would write over them.
       * §8.2 — such a draft is still offered, but never silently.
       */
      stale: boolean;
    };

/**
 * The draft to offer for `id`, given every row storage holds and the text the
 * server just sent.
 *
 * The order is the whole rule:
 *
 * 1. Only rows for this page in this locale are candidates.
 * 2. A candidate whose content already equals the server's text is dropped —
 *    it is not an edit, and a banner for it is a banner nobody reads.
 * 3. The row under this revision's own key wins, and is not stale: it was
 *    written against exactly the text on screen.
 * 4. Otherwise the newest remaining candidate is offered as stale.
 */
export function draftOffer(
  entries: readonly DraftEntry[],
  id: DraftIdentity,
  serverText: string,
): DraftOffer {
  const prefix = draftPagePrefix(id);
  const exact = draftKey(id);
  let best: { key: string; draft: StoredDraft } | null = null;

  for (const entry of entries) {
    if (!entry.key.startsWith(prefix)) continue;
    const draft = parseDraft(entry.value);
    if (draft === null || draft.content === serverText) continue;
    if (entry.key === exact) return { kind: "offer", key: entry.key, draft, stale: false };
    if (best === null || draft.savedAt > best.draft.savedAt) best = { key: entry.key, draft };
  }

  if (best === null) return { kind: "none" };
  return { kind: "offer", key: best.key, draft: best.draft, stale: true };
}

/**
 * Every key holding a draft of this page in this locale — what publishing and
 * an explicit discard clear.
 *
 * All revisions, not only the current one: after a publish, a draft written
 * against any earlier head is text the author has already superseded, and
 * leaving it behind means the banner offers it again on the next edit.
 */
export function draftKeysForPage(entries: readonly DraftEntry[], page: DraftPage): string[] {
  const prefix = draftPagePrefix(page);
  return entries.filter((entry) => entry.key.startsWith(prefix)).map((entry) => entry.key);
}
