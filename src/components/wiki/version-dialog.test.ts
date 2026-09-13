/**
 * `buildVersionBlock`, `parseVersionBlock`, `isEmptyVersionBlock` and
 * `isInvertedWindow` — the pure pair the version-scope dialog is built on
 * (docs/engine/visual-editor.md §5.3), asserted against the wikitext
 * versioning.md §2.1 defines.
 *
 * They are exported and pure so the syntax can be pinned here rather than
 * through the DOM: the suite runs in vitest's `node` environment, and "which
 * shape, which ids, in which order" needs no browser to answer. The form
 * around them is markup.
 *
 * These cases are not cosmetic. **The tag's NAME is the range** — `<v70>` is
 * one version, `<v70+v80>` is a closed window and `<v70+>` runs forever — so an
 * id emitted in the wrong half of a name does not look wrong. It silently
 * renders the wrong text at the wrong patch, which is the exact failure this
 * whole feature exists to prevent. The two ends are never sorted for the
 * author either: §2.1 gives an inverted window *no* versions rather than
 * swapping it, so the form refuses to write one.
 *
 * Two failures are pinned by name, because both were reported from a real page:
 *
 * - **A block that renders nothing.** The dialog used to be able to insert a
 *   construct with no text in it, so the page read the same at every version —
 *   the one thing version scoping exists to prevent. `EMPTY_BLOCK` below is
 *   what that leaves behind, and Insert refuses it.
 * - **No way back in.** A version block is an atomic node in the visual
 *   surface, so without `parseVersionBlock` the author who wanted to change the
 *   range they had just written had to hand-write the markup. The law that
 *   makes the way back safe is `build(parse(x)) === x`, asserted here on that
 *   block and on the wikitext the seed actually ships.
 *
 * The form between the two is pinned here as well. `versionFormState` and
 * `composeVersionDraft` are the whole path from "which mode, which versions,
 * what does it say" to the draft, so the three-mode promise can be asserted
 * without a browser. The markup around them is a picker and a textarea.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  buildVersionBlock,
  composeVersionDraft,
  isEmptyVersionBlock,
  isInvertedWindow,
  parseVersionBlock,
  versionBlockMode,
  versionFormState,
  VersionDialog,
  type VersionBlockDraft,
  type VersionDialogLabels,
  type VersionDialogProps,
  type VersionFormState,
} from "./version-dialog";

const BODY = "The base quota is 130 credits.";

/** A block with nothing written in it: it renders nothing at any version. */
const EMPTY_BLOCK = "<v70+></v70+>";

/**
 * The seeded Help page's live demonstration (src/lib/db/seed-data.ts,
 * `HELP_PAGES` → "Version scoping"): three windows back to back, each saying
 * something different. Each is one block; the run of them is the page.
 */
const SEEDED_WINDOWS = [
  `<v45+v55>You are viewing a version between '''v45''' and v55. This sentence lives in the first window.</v45+v55>`,
  `<v56+v60>You are viewing '''v56''' to v60. The second window replaced the first at v56.</v56+v60>`,
  `<v62+>You are viewing '''v62''' or later. The third window replaced the second at v62.</v62+>`,
];

/**
 * The seeded Company Cruiser article (src/lib/db/seed-content/equipment-scrap.ts).
 * The open-ended form, and the one construct on a seeded article rather than on
 * a Help page.
 */
const SEEDED_SPAN = `<v55+>''Added in v55, the vehicle update.''</v55+>`;

/** The Korean twin, which is where the bodies stop being ASCII. */
const SEEDED_WINDOW_KO = `<v45+v55>지금 '''v45'''부터 v55 사이를 보고 있습니다. 이 문장은 첫 번째 구간에 속합니다.</v45+v55>`;

/** `build(parse(x)) === x` — the law that makes reopening a block safe. */
function expectRoundTrip(source: string): void {
  const draft = parseVersionBlock(source);
  expect(draft).not.toBeNull();
  if (draft === null) return;
  expect(buildVersionBlock(draft)).toBe(source);
}

describe("buildVersionBlock", () => {
  describe("the three shapes of a tag name (§2.1)", () => {
    it("writes the version alone when the passage applies to exactly one", () => {
      expect(buildVersionBlock({ from: "v70", to: "v70", body: BODY })).toBe(
        `<v70>${BODY}</v70>`,
      );
    });

    it("writes both ends of a window, in the order it was given them", () => {
      expect(buildVersionBlock({ from: "v50", to: "v61", body: BODY })).toBe(
        `<v50+v61>${BODY}</v50+v61>`,
      );
    });

    it("writes a bare `+` for a passage that runs to every later version", () => {
      expect(buildVersionBlock({ from: "v62", to: null, body: BODY })).toBe(
        `<v62+>${BODY}</v62+>`,
      );
    });

    it("writes a window on itself as the single-version form, which is what it means", () => {
      // `<v70+v70>` and `<v70>` cover the same one version, and only the second
      // reads like what it means.
      expect(buildVersionBlock({ from: "v70", to: "v70", body: "x" })).toBe("<v70>x</v70>");
    });

    it("closes with the name it opened with, character for character", () => {
      const built = buildVersionBlock({ from: "v64.1", to: "v70", body: "x" });
      expect(built).toBe("<v64.1+v70>x</v64.1+v70>");
    });
  });

  describe("ids", () => {
    it("folds the ids, which is the spelling the registry keeps them in", () => {
      // `version_boundaries` has to line up with `versions.id` however the
      // author typed it, and the engine compares tag names case-insensitively.
      expect(buildVersionBlock({ from: "V70", to: null, body: "x" })).toBe("<v70+>x</v70+>");
      expect(buildVersionBlock({ from: " v50 ", to: " V61 ", body: "x" })).toBe(
        "<v50+v61>x</v50+v61>",
      );
    });

    it("keeps a minor version's dot", () => {
      expect(buildVersionBlock({ from: "v64.1", to: "v64.1", body: "x" })).toBe(
        "<v64.1>x</v64.1>",
      );
    });

    it("does NOT swap an inverted window, because the engine does not either", () => {
      // §2.1: a window whose ends are the wrong way round holds for nothing and
      // renders nothing. Swapping it here would put one version's text under
      // another version's id — the failure this feature exists to prevent — so
      // the form refuses it instead (see `isInvertedWindow`).
      expect(buildVersionBlock({ from: "v80", to: "v70", body: "x" })).toBe(
        "<v80+v70>x</v80+v70>",
      );
    });
  });

  describe("the body", () => {
    it("emits markup verbatim — no escaping, no re-serialization", () => {
      const body = "A [[link]], a {{Template|x=1}}, a <ref>note</ref> and '''bold'''.";
      expect(buildVersionBlock({ from: "v62", to: null, body })).toBe(`<v62+>${body}</v62+>`);
    });

    it("keeps a multi-line body's line breaks inside the tag", () => {
      const body = "First line.\n\nSecond paragraph.";
      expect(buildVersionBlock({ from: "v62", to: null, body })).toBe(`<v62+>${body}</v62+>`);
    });

    it("produces a well-formed block for an empty body", () => {
      // The strip's `+` makes exactly this, to be typed into; Insert refuses it.
      expect(buildVersionBlock({ from: "v70", to: null, body: "" })).toBe(EMPTY_BLOCK);
    });
  });

  describe("nothing picked", () => {
    it("produces nothing rather than a nameless tag", () => {
      expect(buildVersionBlock({ from: "", to: null, body: BODY })).toBe("");
      expect(buildVersionBlock({ from: "   ", to: null, body: BODY })).toBe("");
    });

    it("produces nothing while a window is missing its far end", () => {
      // A blank `to` is not "run forever": the author picked the range form and
      // has not finished it, and writing `<v50+>` would answer a question they
      // did not ask.
      expect(buildVersionBlock({ from: "v50", to: "", body: BODY })).toBe("");
    });
  });
});

describe("versionBlockMode", () => {
  it("reads the shape off the ids rather than off a flag beside them", () => {
    expect(versionBlockMode({ from: "v70", to: "v70", body: "" })).toBe("only");
    expect(versionBlockMode({ from: "v70", to: "v80", body: "" })).toBe("window");
    expect(versionBlockMode({ from: "v70", to: null, body: "" })).toBe("since");
    // Folded, so `<V70+v70>` is still the single-version form.
    expect(versionBlockMode({ from: "V70", to: "v70", body: "" })).toBe("only");
  });
});

describe("isEmptyVersionBlock", () => {
  it("is true for the block that renders nothing anywhere", () => {
    expect(isEmptyVersionBlock({ from: "v70", to: null, body: "" })).toBe(true);
  });

  it("is false as soon as the passage says something", () => {
    expect(isEmptyVersionBlock({ from: "v70", to: null, body: BODY })).toBe(false);
  });

  it("counts a whitespace-only passage as empty, because the reader sees nothing", () => {
    expect(isEmptyVersionBlock({ from: "v70", to: null, body: "  \n\t " })).toBe(true);
  });
});

describe("isInvertedWindow", () => {
  it("is true only when the far end sorts below the near one", () => {
    expect(isInvertedWindow({ from: "v80", to: "v70", body: "x" })).toBe(true);
    expect(isInvertedWindow({ from: "v70", to: "v80", body: "x" })).toBe(false);
    expect(isInvertedWindow({ from: "v70", to: "v70", body: "x" })).toBe(false);
    expect(isInvertedWindow({ from: "v70", to: null, body: "x" })).toBe(false);
  });

  it("sorts on the ordinal, so v9 precedes v10 and v64 precedes v64.1", () => {
    expect(isInvertedWindow({ from: "v9", to: "v10", body: "x" })).toBe(false);
    expect(isInvertedWindow({ from: "v10", to: "v9", body: "x" })).toBe(true);
    expect(isInvertedWindow({ from: "v64", to: "v64.1", body: "x" })).toBe(false);
    expect(isInvertedWindow({ from: "v64.1", to: "v64", body: "x" })).toBe(true);
  });

  it("does not call a pair it cannot order inverted", () => {
    // An id with no ordinal might sit either side; refusing to insert over a
    // guess would block a range the engine itself would render.
    expect(isInvertedWindow({ from: "beta", to: "v70", body: "x" })).toBe(false);
    expect(isInvertedWindow({ from: "v70", to: "beta", body: "x" })).toBe(false);
  });
});

describe("parseVersionBlock", () => {
  describe("the three shapes, read back", () => {
    it("reads a single-version tag as a window on itself", () => {
      expect(parseVersionBlock(`<v70>${BODY}</v70>`)).toEqual({
        from: "v70",
        to: "v70",
        body: BODY,
      });
    });

    it("reads both ends of a window", () => {
      expect(parseVersionBlock(`<v50+v61>${BODY}</v50+v61>`)).toEqual({
        from: "v50",
        to: "v61",
        body: BODY,
      });
    });

    it("reads an open-ended tag as one with no far end", () => {
      expect(parseVersionBlock(`<v62+>${BODY}</v62+>`)).toEqual({
        from: "v62",
        to: null,
        body: BODY,
      });
    });

    it("reads minor versions at both ends", () => {
      expect(parseVersionBlock("<v64.1+v70.2>x</v64.1+v70.2>")).toEqual({
        from: "v64.1",
        to: "v70.2",
        body: "x",
      });
    });

    it("reads the empty block the strip's `+` writes", () => {
      expect(parseVersionBlock(EMPTY_BLOCK)).toEqual({ from: "v70", to: null, body: "" });
      expect(isEmptyVersionBlock(parseVersionBlock(EMPTY_BLOCK) ?? { from: "", to: null, body: "x" })).toBe(
        true,
      );
    });
  });

  describe("the spellings real wikitext contains", () => {
    it("accepts an uppercase name, and a closer whose case differs", () => {
      // Tag names compare case-insensitively (spec §10), so this is one block —
      // and the id comes back folded, which is the spelling the registry keeps
      // and the one the build would emit anyway.
      const draft = parseVersionBlock("<V62+>x</v62+>");
      expect(draft).toEqual({ from: "v62", to: null, body: "x" });
      expect(buildVersionBlock(draft ?? { from: "", to: null, body: "" })).toBe("<v62+>x</v62+>");
    });

    it("accepts a window on itself and gives back the short spelling", () => {
      expect(parseVersionBlock("<v70+v70>x</v70+v70>")).toEqual({
        from: "v70",
        to: "v70",
        body: "x",
      });
      expect(buildVersionBlock({ from: "v70", to: "v70", body: "x" })).toBe("<v70>x</v70>");
    });

    it("reads an inverted window rather than hiding it, so the form can say so", () => {
      // Refusing to open it would leave the author with no way to fix it but
      // raw wikitext, which is the dialog's whole reason for existing.
      const draft = parseVersionBlock("<v80+v70>x</v80+v70>");
      expect(draft).toEqual({ from: "v80", to: "v70", body: "x" });
      expect(isInvertedWindow(draft ?? { from: "", to: null, body: "" })).toBe(true);
    });
  });

  describe("bodies with markup in them", () => {
    it("returns a table, a template call and a link verbatim", () => {
      const body = `{| class="wikitable"\n|-\n| {{Icon|x}} || [[Moon|the moon]]\n|}`;
      expect(parseVersionBlock(`<v62+>${body}</v62+>`)?.body).toBe(body);
    });

    it("does not let a closer quoted in <nowiki> end the passage early", () => {
      const body = "a <nowiki></v62+></nowiki> b";
      expect(parseVersionBlock(`<v62+>${body}</v62+>`)?.body).toBe(body);
    });

    it("treats a whole block inside <pre> as the documentation it is", () => {
      // The seeded Help page teaches the grammar in the grammar; a `<pre>` that
      // holds an example is not a construct this may read.
      expect(parseVersionBlock(`<pre>\n<v62+>example</v62+>\n</pre>`)).toBeNull();
    });

    it("does not read an HTML comment's markup", () => {
      const body = "kept <!-- </v62+> --> text";
      expect(parseVersionBlock(`<v62+>${body}</v62+>`)?.body).toBe(body);
    });

    it("keeps a nested version tag in the body it belongs to", () => {
      const body = "outer <v70+>inner</v70+> tail";
      expect(parseVersionBlock(`<v62+>${body}</v62+>`)).toEqual({
        from: "v62",
        to: null,
        body,
      });
    });
  });

  describe("what it refuses, so the caller falls back to raw wikitext", () => {
    it.each([
      ["a construct with a neighbour", "<v70>a</v70><v71>b</v71>"],
      ["text before the construct", `lead <v70+>a</v70+>`],
      ["text after the construct", `<v70+>a</v70+> tail`],
      ["a closing name that does not repeat the opening one", "<v70+>a</v71+>"],
      ["a tag that never closes", "<v70+>a"],
      ["a stray closer", "</v70+>"],
      ["a self-closing tag, which would come back with a closer", "<v70+/>"],
      ["an attribute the name does not carry", '<v70+ class="x">a</v70+>'],
      ["an attribute run of only a slash-like fragment", "<v70+ data-x>a</v70+>"],
      ["a name that is not a version tag", "<var>a</var>"],
      ["a name that only looks like one", "<v70x>a</v70x>"],
      ["a window with no `+` between its ids", "<v70v80>a</v70v80>"],
      ["the retired group", '<versions><variant since="v70">a</variant></versions>'],
      ["the retired span", '<version since="v70">a</version>'],
      ["an empty string", ""],
      ["prose", "just words"],
    ])("refuses %s", (_label, source) => {
      expect(parseVersionBlock(source)).toBeNull();
    });

    it("refuses a construct padded with whitespace, which the caller trims first", () => {
      // `replaceBranchBody` trims before asking and puts the padding back
      // itself (version-branch.ts), so this stays the strict "whole source"
      // rule rather than growing a second one.
      expect(parseVersionBlock(` <v70+>a</v70+> `)).toBeNull();
    });
  });

  describe("the way back is lossless", () => {
    it("round-trips each of the three shapes", () => {
      expectRoundTrip(`<v70>${BODY}</v70>`);
      expectRoundTrip(`<v50+v61>${BODY}</v50+v61>`);
      expectRoundTrip(`<v62+>${BODY}</v62+>`);
    });

    it("round-trips the empty block the strip's `+` writes", () => {
      expectRoundTrip(EMPTY_BLOCK);
    });

    it("round-trips every window the seeded Help page ships", () => {
      for (const source of SEEDED_WINDOWS) expectRoundTrip(source);
      expectRoundTrip(SEEDED_WINDOW_KO);
    });

    it("round-trips the seeded Company Cruiser passage", () => {
      expectRoundTrip(SEEDED_SPAN);
    });

    it("round-trips a body carrying every kind of markup", () => {
      expectRoundTrip(
        `<v62+>{{Infobox|a=1}} [[Link|text]] '''bold''' <ref>note</ref> {{#ifversion: v62 | y}}</v62+>`,
      );
    });
  });
});

/* ------------------------------------------------------------------ */
/* The form                                                            */
/* ------------------------------------------------------------------ */

describe("versionFormState", () => {
  it("opens a new block at the version on screen, running onward", () => {
    // "This changed at the patch I am looking at" is what an author opens the
    // dialog to say, so the form is one keystroke from insertable.
    expect(versionFormState(null, "v70", BODY)).toEqual({
      mode: "since",
      from: "v70",
      to: "",
      body: BODY,
    });
  });

  it("seeds the passage from the author's selection, which is what they scoped", () => {
    expect(versionFormState(null, "v70", "highlighted words").body).toBe("highlighted words");
    expect(versionFormState(null, "v70", "").body).toBe("");
  });

  it("reopens each shape in the mode that wrote it", () => {
    expect(versionFormState({ from: "v70", to: "v70", body: "x" }, "v62", "")).toEqual({
      mode: "only",
      from: "v70",
      to: "",
      body: "x",
    });
    expect(versionFormState({ from: "v50", to: "v61", body: "x" }, "v62", "")).toEqual({
      mode: "window",
      from: "v50",
      to: "v61",
      body: "x",
    });
    expect(versionFormState({ from: "v62", to: null, body: "x" }, "v70", "")).toEqual({
      mode: "since",
      from: "v62",
      to: "",
      body: "x",
    });
  });

  it("reopens the block's own passage, not the selection under it", () => {
    // Reopening is editing what is there; a selection made on the page around
    // an atomic node is not this block's text.
    const draft: VersionBlockDraft = { from: "v55", to: null, body: "Added in v55." };
    expect(versionFormState(draft, "v70", "something else").body).toBe("Added in v55.");
  });

  it("reopens the seeded windows with their own ends and text", () => {
    const draft = parseVersionBlock(SEEDED_WINDOWS[0]);
    expect(draft).not.toBeNull();
    expect(versionFormState(draft, "v70", "")).toEqual({
      mode: "window",
      from: "v45",
      to: "v55",
      body: `You are viewing a version between '''v45''' and v55. This sentence lives in the first window.`,
    });
  });
});

describe("composeVersionDraft", () => {
  const base: VersionFormState = { mode: "since", from: "v70", to: "v80", body: BODY };

  it("gives each mode the range its name will spell", () => {
    expect(composeVersionDraft(base)).toEqual({ from: "v70", to: null, body: BODY });
    expect(composeVersionDraft({ ...base, mode: "only" })).toEqual({
      from: "v70",
      to: "v70",
      body: BODY,
    });
    expect(composeVersionDraft({ ...base, mode: "window" })).toEqual({
      from: "v70",
      to: "v80",
      body: BODY,
    });
  });

  it("keeps the far end while another mode is showing, so switching back does not re-ask", () => {
    // The state carries `to` through every mode; only `window` spends it.
    const since = composeVersionDraft({ ...base, mode: "since" });
    expect(since.to).toBeNull();
    expect(composeVersionDraft({ ...base, mode: "window" }).to).toBe("v80");
  });

  it("trims the ids so a stray space cannot become part of a tag name", () => {
    expect(composeVersionDraft({ mode: "window", from: " v70 ", to: " v80 ", body: "x" })).toEqual({
      from: "v70",
      to: "v80",
      body: "x",
    });
  });

  it("carries the body untouched, whitespace included", () => {
    expect(composeVersionDraft({ ...base, body: "  padded  " }).body).toBe("  padded  ");
  });
});

describe("what Insert refuses", () => {
  /** The confirm's own rule, as the dialog computes it. */
  function insertable(state: VersionFormState): boolean {
    const draft = composeVersionDraft(state);
    return (
      buildVersionBlock(draft) !== "" && !isEmptyVersionBlock(draft) && !isInvertedWindow(draft)
    );
  }

  it("refuses a block with nothing written in it", () => {
    expect(insertable({ mode: "since", from: "v70", to: "", body: "" })).toBe(false);
  });

  it("refuses a whitespace-only fill, which puts nothing on the page either", () => {
    expect(insertable({ mode: "since", from: "v70", to: "", body: "   " })).toBe(false);
  });

  it("refuses a block with no version picked", () => {
    expect(insertable({ mode: "since", from: "", to: "", body: BODY })).toBe(false);
  });

  it("refuses a range whose far end is still empty", () => {
    expect(insertable({ mode: "window", from: "v50", to: "", body: BODY })).toBe(false);
  });

  it("refuses a range that ends before it starts", () => {
    // §2.1 renders it for no version rather than swapping it, so writing it
    // would be writing a passage nobody can read.
    expect(insertable({ mode: "window", from: "v80", to: "v70", body: BODY })).toBe(false);
  });

  it("allows each of the three shapes once it is complete", () => {
    expect(insertable({ mode: "since", from: "v70", to: "", body: BODY })).toBe(true);
    expect(insertable({ mode: "only", from: "v70", to: "", body: BODY })).toBe(true);
    expect(insertable({ mode: "window", from: "v50", to: "v61", body: BODY })).toBe(true);
  });
});

describe("the round trip an author makes", () => {
  it("opens a block, narrows it to a window, and rebuilds it", () => {
    // The gesture the dialog now owns: not filling in a branch — the field
    // inside the block does that — but changing what the block IS.
    const draft = parseVersionBlock(`<v62+>${BODY}</v62+>`);
    expect(draft).not.toBeNull();
    const form = versionFormState(draft, "v70", "");
    const narrowed = composeVersionDraft({ ...form, mode: "window", to: "v70" });
    expect(buildVersionBlock(narrowed)).toBe(`<v62+v70>${BODY}</v62+v70>`);
  });

  it("survives a second trip through the form unchanged", () => {
    const once = `<v50+v61>${BODY}</v50+v61>`;
    const first = parseVersionBlock(once);
    expect(first).not.toBeNull();
    const rebuilt = buildVersionBlock(composeVersionDraft(versionFormState(first, "v70", "")));
    expect(rebuilt).toBe(once);
    const second = parseVersionBlock(rebuilt);
    expect(second).toEqual(first);
  });

  it("keeps a Korean body byte for byte through the whole trip", () => {
    const first = parseVersionBlock(SEEDED_WINDOW_KO);
    expect(first).not.toBeNull();
    expect(buildVersionBlock(composeVersionDraft(versionFormState(first, "v45", "")))).toBe(
      SEEDED_WINDOW_KO,
    );
  });
});

/* ------------------------------------------------------------------ */
/* The form as markup                                                  */
/* ------------------------------------------------------------------ */

/**
 * One render, to catch what a pure-function suite cannot: a label the
 * dictionary no longer has, or a control left behind by a grammar that no
 * longer exists. `createElement` rather than JSX because this file is the
 * node-environment suite for the pair above, and the assertion is about the
 * markup rather than about behaviour — effects (the registry fetch, the
 * preview) do not run under `renderToStaticMarkup`, which is exactly why the
 * render is cheap enough to keep here.
 */
describe("the dialog's markup", () => {
  const labels: VersionDialogLabels = {
    title: "Version-scoped text",
    titleEdit: "Edit version-scoped text",
    intro: "intro",
    versionLabel: "Version",
    fromLabel: "From version",
    toLabel: "Up to version",
    pickPrompt: "none picked",
    modeLabel: "Where it applies",
    modeOnly: "This version only",
    modeWindow: "A range of versions",
    modeSince: "This version onward",
    bodyLabel: "Text",
    bodyPlaceholder: "What these versions say",
    previewLabel: "Preview",
    insert: "Insert",
    apply: "Apply",
    allEmpty: "no text",
    inverted: "ends before it starts",
    close: "Close",
    failed: "failed",
    invalidId: "Version ids look like v62 or v64.1.",
    status: { current: "Current", legacy: "Legacy" },
    picker: {
      placeholder: "Search versions",
      listLabel: "Versions",
      empty: "Nothing found",
      loading: "Loading",
      create: "Add {name}",
      createHint: "new",
    },
  };

  function render(props: Partial<VersionDialogProps> = {}): string {
    return renderToStaticMarkup(
      createElement(VersionDialog, {
        open: true,
        onClose: () => {},
        onApply: () => {},
        getIdToken: async () => null,
        labels,
        ...props,
      }),
    );
  }

  it("offers the three shapes of a tag name, and nothing else", () => {
    const html = render({ initialVersion: "v70" });
    expect(html).toContain(labels.modeOnly);
    expect(html).toContain(labels.modeWindow);
    expect(html).toContain(labels.modeSince);
    // The controls the grammar no longer has are gone, not merely unused: no
    // fallback checkbox, and no chip row of selected versions.
    expect(html).not.toContain('type="checkbox"');
  });

  it("opens a new block at the version on screen, ready to be typed into", () => {
    const html = render({ initialVersion: "v70", initialBody: "Costs 500." });
    expect(html).toContain(">v70<");
    expect(html).toContain("Costs 500.");
    // `since` leads, so there is one picker and no far end to fill in yet.
    expect(html).not.toContain(labels.toLabel);
    expect(html).toContain(labels.insert);
  });

  it("draws the second picker only for the range form, and reopens one there", () => {
    const html = render({ initialDraft: { from: "v50", to: "v61", body: "Old." } });
    expect(html).toContain(labels.fromLabel);
    expect(html).toContain(labels.toLabel);
    expect(html).toContain(">v50<");
    expect(html).toContain(">v61<");
    // Reopened on a block, so the confirm is Apply and the title says edit.
    expect(html).toContain(labels.apply);
    expect(html).toContain(labels.titleEdit);
  });

  it("shows the wikitext it would write, and refuses a passage nobody can read", () => {
    const empty = render({ initialDraft: { from: "v70", to: null, body: "" } });
    expect(empty).toContain("&lt;v70+&gt;&lt;/v70+&gt;");
    expect(empty).toContain(labels.allEmpty);
    expect(empty).toContain('disabled=""');

    const inverted = render({ initialDraft: { from: "v80", to: "v70", body: "x" } });
    expect(inverted).toContain(labels.inverted);
    expect(inverted).toContain('disabled=""');
  });
});
