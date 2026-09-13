/**
 * The arithmetic behind "pick a version and change it" (versioning.md §6,
 * amended 2026-09-03).
 *
 * The DOM half of that feature — a textarea inside a `contenteditable="false"`
 * node — cannot be exercised in vitest's node environment, which is exactly
 * why the decisions live here instead of in the surface: *whether* a block
 * writes for the version on screen, and *what* replacing its passage does to
 * the block. One failure mode dominates the suite, and it is the reason the
 * feature exists at all: an edit that lands under a version other than the one
 * named on screen.
 *
 * The examples are §6's own — a page that says one thing from v56 and another
 * from v73, read at the site default v70 — plus the v70/v71 pair the report was
 * filed about. Since §2.1 made the tag name the range, those are two tags side
 * by side rather than two branches of one group.
 */

import { describe, expect, it } from "vitest";

import { buildVersionBlock, parseVersionBlock } from "@/components/wiki/version-dialog";
import {
  addVersionToPage,
  replaceBranchBody,
  versionFieldState,
} from "@/lib/visual-editor/version-branch";

/** §6's own example, as one block: what the page says from v56 until v72. */
const WINDOW = "<v56+v72>The base quota is 130 credits.</v56+v72>";

/** The same passage, open-ended — what the strip's `+` writes. */
const OPEN = "<v73+>The base quota is 180 credits.</v73+>";

/** The pair from the report: two adjacent patches, two different sentences. */
const SEVENTY = "<v70>Seventy.</v70>";
const SEVENTY_ONE = "<v71+>Seventy-one.</v71+>";

/**
 * §6's own example as a whole page writes it: two windows back to back, with
 * nothing between them — a newline there would belong to every version. The
 * block scan takes the run as ONE atomic node, which is why the field has to
 * answer about a run and not only about a tag.
 */
const RUN = `${WINDOW}${OPEN}`;

/** The branch the field would hold, or the state that says why there is none. */
function fieldAt(source: string, version: string): string | null {
  const state = versionFieldState(source, version);
  return state.kind === "branch" ? state.branch.id : state.kind;
}

/* ---------------------------------------------------------------- */
/* replaceBranchBody — the substitution                               */
/* ---------------------------------------------------------------- */

describe("replaceBranchBody", () => {
  it("changes the passage it was given and leaves the range alone", () => {
    // The report, in one assertion: type into v70, and the tag still says v70.
    const next = replaceBranchBody(SEVENTY, "v70", "Seventy, revised.");
    expect(next).toBe("<v70>Seventy, revised.</v70>");
    expect(parseVersionBlock(next ?? "")).toEqual({
      from: "v70",
      to: "v70",
      body: "Seventy, revised.",
    });
  });

  it("changes one passage of a run and leaves every other byte of it alone", () => {
    // The whole point of splicing rather than rebuilding: the neighbouring
    // window, its ids' own spelling and the absence of whitespace between them
    // all survive untouched.
    expect(replaceBranchBody(RUN, "v56", "The base quota is 140 credits.")).toBe(
      `<v56+v72>The base quota is 140 credits.</v56+v72>${OPEN}`,
    );
    expect(replaceBranchBody(RUN, "v73", "Now 200.")).toBe(
      `${WINDOW}<v73+>Now 200.</v73+>`,
    );
  });

  it("keeps an id's own spelling, however the author cased it", () => {
    expect(replaceBranchBody("<V70+V80>a</v70+v80>", "v70", "b")).toBe("<V70+V80>b</v70+v80>");
  });

  it("keeps a window's two ends exactly as the page had them", () => {
    expect(replaceBranchBody(WINDOW, "v56", "")).toBe("<v56+v72></v56+v72>");
    expect(replaceBranchBody(OPEN, "v73", "Now 200.")).toBe("<v73+>Now 200.</v73+>");
  });

  it("edits the covering passage when the selection is not the tag's own version", () => {
    // Previewing v70 on a `<v56+v72>` block edits v56 — the passage v70 renders.
    const state = versionFieldState(WINDOW, "v70");
    expect(state.kind === "branch" ? state.branch.id : null).toBe("v56");
    expect(replaceBranchBody(WINDOW, "v56", "The base quota is 140 credits.")).toBe(
      "<v56+v72>The base quota is 140 credits.</v56+v72>",
    );
  });

  it("refuses a run in which two tags start at one version", () => {
    // A boundary that shadows itself (§2.1) is not a body this may pick
    // between, and picking the wrong one is writing into the wrong passage.
    const twice = "<v70>one</v70><v70+>two</v70+>";
    expect(replaceBranchBody(twice, "v70", "x")).toBeNull();
  });

  it("drops keystrokes rather than land them under another version", () => {
    // The debounce is why: a block whose range changed while a word was in
    // flight must take that word with it. Writing it in anyway is the one
    // outcome worse than losing it.
    expect(replaceBranchBody(SEVENTY, "v62", "Sixty-two.")).toBeNull();
    // The far end of a window is not whose passage this is, either.
    expect(replaceBranchBody(WINDOW, "v72", "?")).toBeNull();
  });

  it("matches the id trimmed and case-insensitively", () => {
    expect(replaceBranchBody(SEVENTY, " V70 ", "x")).toBe("<v70>x</v70>");
  });

  it("refuses a block it cannot find one body in", () => {
    // Each of these is a block where "which bytes are v70's passage" has no
    // answer: an attribute a caller might drop, a tag with no body at all, a
    // closer that closes nothing (§10.7), prose beside the tags, and the
    // retired grammar the engine no longer reads.
    const attributed = '<v70+ class="x">Seventy.</v70+>';
    const selfClosing = "<v70+/>";
    const mismatched = "<v70+>Seventy.</v71+>";
    const unclosed = "<v70+>Seventy.";
    const prose = "Lead. <v70+>Seventy.</v70+>";
    const retired = '<version since="v70">Seventy.</version>';
    for (const source of [attributed, selfClosing, mismatched, unclosed, prose, retired]) {
      expect(replaceBranchBody(source, "v70", "x")).toBeNull();
      expect(versionFieldState(source, "v70").kind).toBe("unsupported");
    }
  });

  it("serves a run the version dialog itself refuses", () => {
    // The two are asked different questions. The dialog has to spell the whole
    // construct back, and a run is not one tag — so it falls to the raw
    // wikitext dialog. This only has to find one body, and splicing it changes
    // nothing else.
    expect(parseVersionBlock(RUN)).toBeNull();
    expect(fieldAt(RUN, "v70")).toBe("v56");
    expect(replaceBranchBody(RUN, "v56", "x")).toBe(`<v56+v72>x</v56+v72>${OPEN}`);
  });

  it("keeps the whitespace that padded the construct", () => {
    // `data-ve-src` is emitted byte for byte (§4), and an inline construct can
    // arrive with a space either side; rebuilding without them would shove a
    // word against its neighbour.
    const padded = ` ${SEVENTY} `;
    const next = replaceBranchBody(padded, "v70", "Seventy!");
    expect(next?.startsWith(" ")).toBe(true);
    expect(next?.endsWith(" ")).toBe(true);
    expect(next?.trim()).toBe(replaceBranchBody(SEVENTY, "v70", "Seventy!"));
  });

  it("reads back what it wrote, so a second edit starts from the first", () => {
    let source: string | null = SEVENTY_ONE;
    source = replaceBranchBody(source, "v71", "One.");
    source = replaceBranchBody(source ?? "", "v71", "Two.");
    expect(parseVersionBlock(source ?? "")).toEqual({ from: "v71", to: null, body: "Two." });
  });

  it("carries a body the wikitext is allowed to contain, verbatim", () => {
    const body = "A [[link]], a {{Template|x=1}} and a <ref>note</ref>.";
    const next = replaceBranchBody(SEVENTY_ONE, "v71", body);
    expect(versionFieldState(next ?? "", "v71")).toEqual({
      kind: "branch",
      covers: true,
      branch: { id: "v71", body },
    });
  });

  it("does not let a closer quoted inside <nowiki> end the passage early", () => {
    const body = "a <nowiki></v71+></nowiki> b";
    const source = `<v71+>${body}</v71+>`;
    expect(versionFieldState(source, "v71")).toEqual({
      kind: "branch",
      covers: true,
      branch: { id: "v71", body },
    });
    expect(replaceBranchBody(source, "v71", "x")).toBe("<v71+>x</v71+>");
  });
});

/* ---------------------------------------------------------------- */
/* versionFieldState — what the field shows                          */
/* ---------------------------------------------------------------- */

describe("versionFieldState", () => {
  it("hands the covering passage to the field, and names it", () => {
    const state = versionFieldState(WINDOW, "v70");
    expect(state).toEqual({
      kind: "branch",
      covers: true,
      branch: { id: "v56", body: "The base quota is 130 credits." },
    });
  });

  it("swaps passages across a run as the previewed version moves", () => {
    // Which is the swap the strip promises, on the shape a converted page
    // actually has: below the first window nothing is written, inside it the
    // first passage, and from v73 the second.
    // v50 is below every tag, so nothing *renders* there — but the field still
    // opens on the nearest passage (amended 2026-09-05), which going upwards is
    // the first thing the block will say.
    expect(fieldAt(RUN, "v50")).toBe("v56");
    expect(fieldAt(RUN, "v56")).toBe("v56");
    expect(fieldAt(RUN, "v70")).toBe("v56");
    expect(fieldAt(RUN, "v72")).toBe("v56");
    expect(fieldAt(RUN, "v73")).toBe("v73");
    expect(fieldAt(RUN, "v99")).toBe("v73");
  });

  it("gives an overlap to the later boundary, as the chip row does", () => {
    // Two open-ended tags side by side both cover v70; §6 rule 1 is the
    // greatest boundary at or below the selection, so v56 is the one on screen.
    const overlap = "<v45+>Early.</v45+><v56+>Later.</v56+>";
    expect(fieldAt(overlap, "v50")).toBe("v45");
    expect(fieldAt(overlap, "v70")).toBe("v56");
  });

  it("opens on the nearest passage where nothing covers the selection", () => {
    // Amended 2026-09-05 by user: a version block is editable at EVERY version.
    // What made that safe was already the rule — the head row names the branch,
    // never the chip — so the words sit under their own id and `covers: false`
    // is what the surface draws the "the preview above is empty" note from.
    expect(versionFieldState(WINDOW, "v50")).toEqual({
      kind: "branch",
      covers: false,
      branch: { id: "v56", body: "The base quota is 130 credits." },
    });
    expect(versionFieldState(SEVENTY, "v71")).toEqual({
      kind: "branch",
      covers: false,
      branch: { id: "v70", body: "Seventy." },
    });
  });

  it("looks back before it looks forward", () => {
    // Below the selection is the reading a reader has just left; above it is
    // one they have not reached. Both are real passages with their own ids.
    const run = "<v45>Early.</v45><v80>Late.</v80>";
    expect(fieldAt(run, "v60")).toBe("v45");
    // Below both: there is nothing behind, so the nearest ahead is the answer.
    expect(fieldAt(run, "v40")).toBe("v45");
  });

  it("holds for nothing when the window is inverted, exactly as the engine has it", () => {
    // §2.1: `<v80+v70>` is never silently swapped — it renders for no version,
    // so there is no passage here for any of them either.
    // It covers no version, so `covers` is false at every one of them — and the
    // passage is still the author's to fix, which is the point of the amendment.
    for (const id of ["v70", "v75", "v80"]) {
      expect(versionFieldState("<v80+v70>?</v80+v70>", id)).toEqual({
        kind: "branch",
        covers: false,
        branch: { id: "v80", body: "?" },
      });
    }
  });

  it("refuses a selection it cannot order", () => {
    // Ordinals are what every range decision in §2 runs on; an id that has
    // none cannot be placed, and "might cover" is not a licence to edit.
    expect(versionFieldState(WINDOW, "latest")).toEqual({ kind: "missing" });
  });

  it("keeps the whitespace a padded construct arrived with", () => {
    expect(versionFieldState(` ${SEVENTY} `, "v70")).toEqual({
      kind: "branch",
      covers: true,
      branch: { id: "v70", body: "Seventy." },
    });
  });

  it("hands nothing to a block that keeps its dialog", () => {
    expect(versionFieldState('<v70+ label="x">a</v70+>', "v70").kind).toBe("unsupported");
    expect(versionFieldState('<version since="v62">Added.</version>', "v70").kind).toBe(
      "unsupported",
    );
    expect(versionFieldState("<var>x</var>", "v70").kind).toBe("unsupported");
    expect(versionFieldState("", "v70").kind).toBe("unsupported");
  });
});

/* ---------------------------------------------------------------- */
/* addVersionToPage — the strip's "+"                                */
/* ---------------------------------------------------------------- */

const PAGE = ["68-Artifice is a moon.", "", SEVENTY, "", "== Interior ==", "Mostly the factory.", ""].join(
  "\n",
);

describe("addVersionToPage", () => {
  it("appends a passage for exactly the version named, rewriting nothing else", () => {
    // The menu names one version and the chip will read that version, so the
    // tag says the same (§2.1: `<v62>` is v62 and nothing else). Writing
    // `<v62+>` here would quietly cover every later patch under a chip that
    // still says "v62" — a range is a deliberate choice and belongs to
    // Insert → Version block, where all three forms are offered. The block goes
    // at the end rather than into somebody else's construct.
    expect(addVersionToPage(PAGE, "v62")).toBe(`${PAGE.trimEnd()}\n\n<v62></v62>\n`);
  });

  it("makes the passage the field will then hold", () => {
    // The two halves of the same gesture: the page gains v62, and the field for
    // v62 is what the author is now typing into.
    expect(versionFieldState("<v62></v62>", "v62")).toEqual({
      kind: "branch",
      covers: true,
      branch: { id: "v62", body: "" },
    });
    expect(replaceBranchBody("<v62></v62>", "v62", "Typed.")).toBe("<v62>Typed.</v62>");
  });

  it("creates the page's first passage when it has none", () => {
    expect(addVersionToPage("68-Artifice is a moon.\n", "v71")).toBe(
      "68-Artifice is a moon.\n\n<v71></v71>\n",
    );
    expect(addVersionToPage("", "v71")).toBe("<v71></v71>\n");
    expect(addVersionToPage("   \n\n", "v71")).toBe("<v71></v71>\n");
  });

  it("writes nothing when the page already covers that version", () => {
    // A second boundary for one version is a boundary that shadows itself
    // (§2.1), so an id the author types by hand — the menu never offers a
    // covered one — leaves the buffer exactly as it was. Coverage is
    // `versionsUsed`, the list the chips themselves are drawn from.
    expect(addVersionToPage(PAGE, "v70")).toBe(PAGE);
    expect(addVersionToPage(PAGE, "V70")).toBe(PAGE);
    const window = `Prose.\n\n<v56+v72>Added in v56.</v56+v72>\n`;
    expect(addVersionToPage(window, "v56")).toBe(window);
    // Both ends of a window are boundaries, and both have chips already.
    expect(addVersionToPage(window, "v72")).toBe(window);
    // So is a version only a parser function names.
    const call = "Cost: {{#ifversion: >=v64 | 1500 | 1400}}.\n";
    expect(addVersionToPage(call, "v64")).toBe(call);
  });

  it("does not count a version that is only being quoted", () => {
    // The help page's `<pre>` examples are documentation, not passages — the
    // chips leave them out, so the `+` may still offer them.
    const quoted = "<pre>\n<v62+>example</v62+>\n</pre>\n";
    expect(addVersionToPage(quoted, "v62")).toBe(`${quoted.trimEnd()}\n\n<v62></v62>\n`);
  });

  it("refuses an empty id rather than writing a nameless tag", () => {
    expect(addVersionToPage(PAGE, "   ")).toBe(PAGE);
  });

  it("writes a tag the whole editor can read back", () => {
    const next = addVersionToPage(PAGE, "v62");
    expect(next).toContain(buildVersionBlock({ from: "v62", to: "v62", body: "" }));
    expect(parseVersionBlock("<v62></v62>")).toEqual({ from: "v62", to: "v62", body: "" });
  });
});
