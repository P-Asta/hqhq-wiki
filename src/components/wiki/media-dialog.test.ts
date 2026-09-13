/**
 * `buildFileWikitext` and `localProblem` — the two pure decisions inside the
 * media dialog (docs/engine/visual-editor.md §5.2).
 *
 * They are exported so they can be tested here rather than through the DOM:
 * the suite runs in vitest's `node` environment, and "which options does this
 * placement emit, in which order, what does it do to a caption that would
 * break the construct, and which files never leave the browser?" needs no
 * browser to answer. The component around them is markup.
 *
 * The cases below are the ones the engine actually distinguishes: `links.ts`
 * splits a file link on top-level pipes and balances `[[`/`]]` to find the
 * closing brackets, so a caption carrying either character is not a cosmetic
 * problem — it silently rewrites which parameters the page has.
 */

import { describe, expect, it } from "vitest";

import { buildFileWikitext, localProblem, type MediaDialogLabels } from "./media-dialog";

describe("buildFileWikitext", () => {
  it("emits every option in MediaWiki's order when all of them are on", () => {
    expect(
      buildFileWikitext({
        filename: "ship.png",
        layout: "thumb",
        align: "right",
        width: 300,
        caption: "Caption",
      }),
    ).toBe("[[File:ship.png|thumb|right|300px|Caption]]");
  });

  it("emits nothing but the name when every option is off", () => {
    // "full" is the absence of a format keyword, "none" the absence of an
    // alignment, and a null width the absence of a px term — so the bare form
    // is the correct output, with no trailing pipe to show for it.
    expect(
      buildFileWikitext({
        filename: "ship.png",
        layout: "full",
        align: "none",
        width: null,
        caption: "",
      }),
    ).toBe("[[File:ship.png]]");
  });

  it("drops only the options that are off, keeping the rest in order", () => {
    expect(
      buildFileWikitext({
        filename: "ship.png",
        layout: "frameless",
        align: "none",
        width: 220,
        caption: "",
      }),
    ).toBe("[[File:ship.png|frameless|220px]]");

    expect(
      buildFileWikitext({
        filename: "ship.png",
        layout: "full",
        align: "center",
        width: null,
        caption: "A caption",
      }),
    ).toBe("[[File:ship.png|center|A caption]]");
  });

  it("treats a whitespace-only caption as no caption", () => {
    expect(
      buildFileWikitext({
        filename: "ship.png",
        layout: "thumb",
        align: "left",
        width: null,
        caption: "   ",
      }),
    ).toBe("[[File:ship.png|thumb|left]]");
  });

  it("ignores a width that is not a positive number of pixels", () => {
    for (const width of [0, -40, Number.NaN]) {
      expect(
        buildFileWikitext({
          filename: "ship.png",
          layout: "full",
          align: "none",
          width,
          caption: "",
        }),
      ).toBe("[[File:ship.png]]");
    }
  });

  it("escapes a pipe in the caption, which would otherwise start a parameter", () => {
    // Left raw, the engine would keep "after" as the caption and warn about
    // "before" — the front of the author's sentence would just vanish.
    expect(
      buildFileWikitext({
        filename: "ship.png",
        layout: "thumb",
        align: "right",
        width: null,
        caption: "before | after",
      }),
    ).toBe("[[File:ship.png|thumb|right|before &#124; after]]");
  });

  it("escapes brackets, which move the depth counter that closes the link", () => {
    expect(
      buildFileWikitext({
        filename: "ship.png",
        layout: "thumb",
        align: "none",
        width: null,
        caption: "see [[Artifice]] and ]] alone",
      }),
    ).toBe(
      "[[File:ship.png|thumb|see &#91;&#91;Artifice&#93;&#93; and &#93;&#93; alone]]",
    );
  });

  it("folds a caption's newlines, which would end the block", () => {
    expect(
      buildFileWikitext({
        filename: "ship.png",
        layout: "full",
        align: "none",
        width: null,
        caption: "first\r\nsecond",
      }),
    ).toBe("[[File:ship.png|first second]]");
  });

  it("canonicalises the filename, so the source names the file the wiki stores", () => {
    // canonicalFilename (decisions O6): NFC, lowercase, whitespace/underscore
    // runs collapsed to "-" — the same rule canonicalMediaName applies on
    // upload, so a name typed any other way still resolves.
    expect(
      buildFileWikitext({
        filename: "Moon  Map_v2.PNG",
        layout: "thumb",
        align: "right",
        width: 300,
        caption: "Artifice",
      }),
    ).toBe("[[File:moon-map-v2.png|thumb|right|300px|Artifice]]");
  });

  it("rounds a fractional width rather than writing one into the source", () => {
    expect(
      buildFileWikitext({
        filename: "ship.png",
        layout: "full",
        align: "none",
        width: 199.6,
        caption: "",
      }),
    ).toBe("[[File:ship.png|200px]]");
  });

  it("hides a caption that is an alignment keyword, which would eat it and move the picture", () => {
    // Raw, `[[File:ship.png|thumb|right|Center]]` has no caption at all and is
    // centered: §5.9 matches the horizontal-alignment group before it settles
    // for a caption, so "Center" is consumed as an option and silently flips
    // the alignment the author chose.
    expect(
      buildFileWikitext({
        filename: "ship.png",
        layout: "thumb",
        align: "right",
        width: null,
        caption: "Center",
      }),
    ).toBe("[[File:ship.png|thumb|right|&#67;enter]]");
  });

  it("hides every other reserved option word a caption might happen to be", () => {
    const cases: Array<[string, string]> = [
      ["thumb", "&#116;humb"],
      ["Frameless", "&#70;rameless"],
      ["none", "&#110;one"],
      ["border", "&#98;order"],
      ["text-top", "&#116;ext-top"],
      ["middle", "&#109;iddle"],
    ];
    for (const [caption, expected] of cases) {
      expect(
        buildFileWikitext({
          filename: "ship.png",
          layout: "full",
          align: "none",
          width: null,
          caption,
        }),
      ).toBe(`[[File:ship.png|${expected}]]`);
    }
  });

  it("hides a caption shaped like a size or an upright factor", () => {
    for (const [caption, expected] of [
      ["200px", "&#50;00px"],
      ["100x80px", "&#49;00x80px"],
      ["x120px", "&#120;120px"],
      ["upright", "&#117;pright"],
      ["upright=1.5", "&#117;pright=1.5"],
    ]) {
      expect(
        buildFileWikitext({
          filename: "ship.png",
          layout: "full",
          align: "none",
          width: null,
          caption,
        }),
      ).toBe(`[[File:ship.png|${expected}]]`);
    }
  });

  it("hides a caption that reads as a key=value parameter", () => {
    // The worst of the set: left raw, `link = Bracken` drops the caption AND
    // turns the picture into a link to the Bracken article.
    expect(
      buildFileWikitext({
        filename: "ship.png",
        layout: "thumb",
        align: "right",
        width: null,
        caption: "Link = Bracken",
      }),
    ).toBe("[[File:ship.png|thumb|right|&#76;ink = Bracken]]");
    expect(
      buildFileWikitext({
        filename: "ship.png",
        layout: "full",
        align: "none",
        width: null,
        caption: "alt=A ship",
      }),
    ).toBe("[[File:ship.png|&#97;lt=A ship]]");
  });

  it("leaves a caption that merely contains a keyword alone", () => {
    // The rule is equality with an option, not a substring of one: escaping
    // more than that would litter ordinary prose with references.
    for (const caption of ["Center of the map", "A 200px wide plate", "Bordered in gold", "="]) {
      expect(
        buildFileWikitext({
          filename: "ship.png",
          layout: "full",
          align: "none",
          width: null,
          caption,
        }),
      ).toBe(`[[File:ship.png|${caption}]]`);
    }
  });
});

/* ------------------------------------------------------------------ */
/* The pre-upload gate                                                 */
/* ------------------------------------------------------------------ */

/** Only the three lines `localProblem` can return, in a shape it can read. */
const LABELS: Pick<MediaDialogLabels, "badName" | "badType" | "tooLarge"> = {
  badName: "no {chars} please",
  badType: "only {types}",
  tooLarge: "max {max}",
};

describe("localProblem", () => {
  it("refuses a filename carrying a character no [[File:…]] can name", () => {
    // "Screenshot #1.png" uploads, stores and lists fine, and then parseTitle
    // reads everything from the `#` as a fragment — the picture is on the wiki
    // and unreferenceable. Catching it here costs the author a rename, not a
    // round trip that ends in a file they cannot use.
    expect(localProblem({ name: "Screenshot #1.png", size: 1000 }, LABELS)).toBe(
      "no # | [ ] { } < > please",
    );
    for (const name of ["a|b.png", "a[b.png", "a]b.png", "a{b.png", "a}b.png", "a<b>.png"]) {
      expect(localProblem({ name, size: 1000 }, LABELS)).toBe("no # | [ ] { } < > please");
    }
  });

  it("still passes an ordinary file, and still catches type and size", () => {
    expect(localProblem({ name: "Moon Map.PNG", size: 1000 }, LABELS)).toBeNull();
    expect(localProblem({ name: "vector.svg", size: 1000 }, LABELS)).toBe(
      "only png, jpg, jpeg, webp, gif",
    );
    expect(localProblem({ name: "huge.png", size: 40 * 1024 * 1024 }, LABELS)).toBe("max 10 MB");
  });
});
