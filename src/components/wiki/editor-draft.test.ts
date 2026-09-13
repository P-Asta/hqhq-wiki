/**
 * The local-draft decisions — docs/engine/visual-editor.md §8.2.
 *
 * Every one of these is a question about somebody's unpublished writing, and
 * each has one answer that loses it and one that publishes it over the wrong
 * page. They are pure functions for exactly that reason: `localStorage` is not
 * needed to ask "does this row belong to this page?", and a rule that can only
 * be exercised by opening two browser tabs is a rule nobody exercises.
 *
 * The four this file pins:
 *
 * 1. A key names the page, the locale AND the parent revision. Drop any one
 *    and a draft is offered on a page it was not written for.
 * 2. A draft equal to the server's text is not an edit and is not offered.
 * 3. A draft written against another revision is still offered — it is the
 *    author's work — but never silently: §8.2 requires it to say so, because
 *    somebody else published in between.
 * 4. A row that cannot be vouched for is not a draft. Storage is shared with
 *    every other tab and every past version of this code.
 */

import { describe, expect, it } from "vitest";

import {
  DRAFT_KEY_PREFIX,
  draftKey,
  draftKeysForPage,
  draftOffer,
  draftPagePrefix,
  parseDraft,
  serializeDraft,
  type DraftEntry,
  type DraftIdentity,
  type StoredDraft,
} from "./editor-draft";

const PAGE = { titlePath: "artifice", locale: "en" };
const AT_R53: DraftIdentity = { ...PAGE, parentRevId: 53 };
const SERVER = "68-Artifice is a moon.\n";
const MINE = "68-Artifice is a moon with a difficulty rating of S.\n";

function entry(id: DraftIdentity, draft: Partial<StoredDraft> & { content: string }): DraftEntry {
  return {
    key: draftKey(id),
    value: serializeDraft({
      savedAt: 1_700_000_000_000,
      parentRevId: id.parentRevId,
      ...draft,
    }),
  };
}

/* ---------------------------------------------------------------- */
/* draftKey — which draft belongs to which page                     */
/* ---------------------------------------------------------------- */

describe("draftKey", () => {
  it("names the page, the locale and the parent revision", () => {
    const key = draftKey(AT_R53);
    expect(key.startsWith(DRAFT_KEY_PREFIX)).toBe(true);
    expect(key).toContain("en");
    expect(key).toContain("artifice");
    expect(key).toContain("r53");
  });

  it("gives two locales of one article two different drafts", () => {
    // Translating is a separate buffer over the same title (decisions O4); one
    // key for both would offer the English draft back on the Korean page.
    expect(draftKey({ ...AT_R53, locale: "ko" })).not.toBe(draftKey(AT_R53));
  });

  it("gives two revisions of one page two different drafts", () => {
    // The distinction §8.2 is about: a draft written against r53 is not a
    // draft of the page as it stands at r60.
    expect(draftKey({ ...AT_R53, parentRevId: 60 })).not.toBe(draftKey(AT_R53));
  });

  it("has a key for a page that does not exist yet", () => {
    // Creating is `parentRevId === null` (edit-view.ts), and the work put into
    // a page before its first save is exactly the work worth not losing.
    const creating = draftKey({ ...PAGE, parentRevId: null });
    expect(creating).not.toBe(draftKey(AT_R53));
    expect(creating.endsWith("new")).toBe(true);
  });

  it("keeps one page's prefix out of another's, colons and all", () => {
    // A title path carries the namespace (`template:infobox-moon`), so an
    // unencoded separator would make page `moon` a prefix of page
    // `moon:artifice` — and the prefix scan below is how a stale draft is
    // found at all.
    const shorter = draftPagePrefix({ titlePath: "moon", locale: "en" });
    const longer = draftPagePrefix({ titlePath: "moon:artifice", locale: "en" });
    expect(longer.startsWith(shorter)).toBe(false);
    expect(shorter.startsWith(longer)).toBe(false);
  });

  it("starts every key with the namespace a scan looks for", () => {
    for (const id of [AT_R53, { ...AT_R53, locale: "ko" }, { ...PAGE, parentRevId: null }]) {
      expect(draftKey(id).startsWith(`${DRAFT_KEY_PREFIX}:`)).toBe(true);
    }
  });
});

/* ---------------------------------------------------------------- */
/* parseDraft — a row that cannot be vouched for is not a draft      */
/* ---------------------------------------------------------------- */

describe("parseDraft", () => {
  it("reads back what it wrote", () => {
    const draft: StoredDraft = { content: MINE, savedAt: 1_700_000_000_000, parentRevId: 53 };
    expect(parseDraft(serializeDraft(draft))).toEqual(draft);
  });

  it("keeps an empty draft, which is an edit like any other", () => {
    // Selecting the article and pressing Delete is a change worth warning
    // about; treating "" as "nothing stored" would drop it silently.
    expect(parseDraft(serializeDraft({ content: "", savedAt: 1, parentRevId: 53 }))?.content).toBe(
      "",
    );
  });

  it("refuses a row it cannot make sense of, rather than throwing", () => {
    // Storage is shared with every other tab and every past shape of this
    // code, and a half-written row is what a killed tab leaves behind. None of
    // it may reach a buffer that Publish will post over an article.
    for (const raw of [
      null,
      "",
      "{",
      '{"content":"x"}',
      '{"savedAt":1}',
      '{"content":42,"savedAt":1}',
      '{"content":"x","savedAt":"yesterday"}',
      '{"content":"x","savedAt":null}',
      '{"content":"x","savedAt":1,"parentRevId":"53"}',
      '"a string"',
      "null",
      "[]",
    ]) {
      expect(parseDraft(raw), `parsed ${String(raw)}`).toBeNull();
    }
  });

  it("refuses a timestamp that is not a moment in time", () => {
    // `JSON.stringify(NaN)` is `null`, but a row written by hand or by another
    // build can carry anything.
    expect(parseDraft('{"content":"x","savedAt":1e999}')).toBeNull();
  });

  it("takes a draft with no recorded revision as one written on a new page", () => {
    expect(parseDraft('{"content":"x","savedAt":1}')).toEqual({
      content: "x",
      savedAt: 1,
      parentRevId: null,
    });
  });
});

/* ---------------------------------------------------------------- */
/* draftOffer — whether to offer it, and whether to warn             */
/* ---------------------------------------------------------------- */

describe("draftOffer", () => {
  it("offers nothing when storage holds nothing", () => {
    expect(draftOffer([], AT_R53, SERVER)).toEqual({ kind: "none" });
  });

  it("offers the draft written against the revision on screen, without a warning", () => {
    const offer = draftOffer([entry(AT_R53, { content: MINE })], AT_R53, SERVER);
    expect(offer.kind).toBe("offer");
    if (offer.kind !== "offer") return;
    expect(offer.draft.content).toBe(MINE);
    expect(offer.stale).toBe(false);
    expect(offer.key).toBe(draftKey(AT_R53));
  });

  it("offers nothing for a page that was opened and closed", () => {
    // The buffer never diverged from the article, so there is no edit to
    // restore — and a banner that appears for everyone is a banner that stops
    // being read by the one person who needed it.
    expect(draftOffer([entry(AT_R53, { content: SERVER })], AT_R53, SERVER)).toEqual({
      kind: "none",
    });
  });

  it("offers a draft from another page's row to nobody", () => {
    const elsewhere = entry({ titlePath: "titan", locale: "en", parentRevId: 53 }, {
      content: MINE,
    });
    const otherLocale = entry({ ...AT_R53, locale: "ko" }, { content: MINE });
    expect(draftOffer([elsewhere, otherLocale], AT_R53, SERVER)).toEqual({ kind: "none" });
  });

  it("still offers a draft written against an older revision — and says so", () => {
    // §8.2's whole point: r53's draft must not be handed to an author editing
    // r60 as though nothing had happened, because restoring it writes over
    // whoever published in between. Withholding it silently is the other way
    // to lose an edit, so it is offered, flagged.
    const at60: DraftIdentity = { ...PAGE, parentRevId: 60 };
    const offer = draftOffer([entry(AT_R53, { content: MINE })], at60, SERVER);
    expect(offer.kind).toBe("offer");
    if (offer.kind !== "offer") return;
    expect(offer.stale).toBe(true);
    expect(offer.draft.parentRevId).toBe(53);
    expect(offer.key).toBe(draftKey(AT_R53));
  });

  it("prefers this revision's own draft over an older one", () => {
    // Even when the older row is the newer *write*: the draft written against
    // the text on screen is the one that can be restored without undoing
    // anybody, so recency does not get to outrank it.
    const at60: DraftIdentity = { ...PAGE, parentRevId: 60 };
    const offer = draftOffer(
      [
        entry(AT_R53, { content: `${MINE}old`, savedAt: 9_000 }),
        entry(at60, { content: MINE, savedAt: 1_000 }),
      ],
      at60,
      SERVER,
    );
    expect(offer.kind).toBe("offer");
    if (offer.kind !== "offer") return;
    expect(offer.stale).toBe(false);
    expect(offer.draft.content).toBe(MINE);
  });

  it("offers the newest of several older drafts", () => {
    const at70: DraftIdentity = { ...PAGE, parentRevId: 70 };
    const offer = draftOffer(
      [
        entry({ ...PAGE, parentRevId: 53 }, { content: "older", savedAt: 1_000 }),
        entry({ ...PAGE, parentRevId: 60 }, { content: "newer", savedAt: 5_000 }),
      ],
      at70,
      SERVER,
    );
    expect(offer.kind).toBe("offer");
    if (offer.kind !== "offer") return;
    expect(offer.draft.content).toBe("newer");
    expect(offer.stale).toBe(true);
  });

  it("warns about a draft written before the page existed", () => {
    // Two people created the same page: this one's draft is filed under `new`,
    // and the page they now have in front of them has a revision.
    const offer = draftOffer(
      [entry({ ...PAGE, parentRevId: null }, { content: MINE })],
      AT_R53,
      SERVER,
    );
    expect(offer.kind).toBe("offer");
    if (offer.kind !== "offer") return;
    expect(offer.stale).toBe(true);
    expect(offer.draft.parentRevId).toBeNull();
  });

  it("steps over a row it cannot read and offers the one it can", () => {
    const broken: DraftEntry = { key: draftKey({ ...PAGE, parentRevId: 40 }), value: "{oops" };
    const offer = draftOffer([broken, entry(AT_R53, { content: MINE })], AT_R53, SERVER);
    expect(offer.kind).toBe("offer");
    if (offer.kind !== "offer") return;
    expect(offer.draft.content).toBe(MINE);
  });

  it("offers nothing when every candidate matches the server", () => {
    const at60: DraftIdentity = { ...PAGE, parentRevId: 60 };
    expect(
      draftOffer(
        [entry(AT_R53, { content: SERVER }), entry(at60, { content: SERVER })],
        at60,
        SERVER,
      ),
    ).toEqual({ kind: "none" });
  });
});

/* ---------------------------------------------------------------- */
/* draftKeysForPage — what publish and discard clear                 */
/* ---------------------------------------------------------------- */

describe("draftKeysForPage", () => {
  it("clears every revision's draft of this page, not only the current one", () => {
    // After a publish, a draft written against any earlier head is text the
    // author has already superseded; leaving it behind means the banner offers
    // it back on the next edit, flagged as somebody else's work being undone.
    const entries = [
      entry({ ...PAGE, parentRevId: 40 }, { content: "a" }),
      entry(AT_R53, { content: "b" }),
      entry({ ...PAGE, parentRevId: null }, { content: "c" }),
    ];
    expect(draftKeysForPage(entries, PAGE).sort()).toEqual(
      entries.map((row) => row.key).sort(),
    );
  });

  it("leaves other pages and other locales alone", () => {
    const entries = [
      entry(AT_R53, { content: "mine" }),
      entry({ titlePath: "titan", locale: "en", parentRevId: 1 }, { content: "theirs" }),
      entry({ ...AT_R53, locale: "ko" }, { content: "translated" }),
      { key: "hqhq-wiki:editor-mode", value: "source" },
    ];
    expect(draftKeysForPage(entries, PAGE)).toEqual([draftKey(AT_R53)]);
  });

  it("has an answer for a page with nothing stored", () => {
    expect(draftKeysForPage([], PAGE)).toEqual([]);
  });
});
