/**
 * The image viewer's two decisions, both of them pure: *may* this click be
 * claimed, and *what* would the viewer show if it were.
 *
 * They are tested apart from the overlay for the reason the rest of this
 * directory splits its logic out — the panel exists only while it is open, and
 * `renderToStaticMarkup` renders it closed. What matters here is the part that
 * can silently regress into a hijacked browser: a Ctrl-click that stops opening
 * a new tab, or a red link for a missing file that stops reaching the editor.
 *
 * The anchors are plain objects, because vitest runs under node and there is no
 * DOM (the same bargain `lib/visual-editor/dom.test.ts` makes).
 */

import { describe, expect, it } from "vitest";

import { isPlainLeftClick, zoomTargetOf, type ZoomAnchor, type ZoomNode } from "./image-zoom";

/* ------------------------------------------------------------------ */
/* isPlainLeftClick                                                    */
/* ------------------------------------------------------------------ */

const PLAIN = {
  button: 0,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
};

describe("isPlainLeftClick", () => {
  it("claims the ordinary left click", () => {
    expect(isPlainLeftClick(PLAIN)).toBe(true);
  });

  it("leaves every 'open it elsewhere' modifier alone", () => {
    for (const key of ["ctrlKey", "metaKey", "shiftKey", "altKey"] as const) {
      expect(isPlainLeftClick({ ...PLAIN, [key]: true }), key).toBe(false);
    }
  });

  it("leaves the middle and right buttons alone", () => {
    expect(isPlainLeftClick({ ...PLAIN, button: 1 })).toBe(false);
    expect(isPlainLeftClick({ ...PLAIN, button: 2 })).toBe(false);
  });

  it("does not answer a click something else already handled", () => {
    expect(isPlainLeftClick({ ...PLAIN, defaultPrevented: true })).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* zoomTargetOf                                                        */
/* ------------------------------------------------------------------ */

function node(attrs: Record<string, string>, text = ""): ZoomNode {
  return { getAttribute: (name) => attrs[name] ?? null, textContent: text };
}

/** An anchor as the engine writes it: classes, href, and what it wraps. */
function anchor(input: {
  classes?: string[];
  href?: string;
  img?: ZoomNode | null;
  figcaption?: ZoomNode | null;
}): ZoomAnchor {
  const classes = new Set(input.classes ?? []);
  const inFigure = input.figcaption !== undefined && input.figcaption !== null;
  return {
    getAttribute: (name) => (name === "href" ? (input.href ?? null) : null),
    textContent: "",
    classList: { contains: (token) => classes.has(token) },
    querySelector: (selectors) => (selectors === "img" ? (input.img ?? null) : null),
    closest: (selectors) =>
      selectors === "figure.mw-thumb" && inFigure
        ? { querySelector: (s) => (s === "figcaption" ? input.figcaption! : null) }
        : null,
  };
}

describe("zoomTargetOf", () => {
  it("reads a bare linked image", () => {
    expect(
      zoomTargetOf(
        anchor({
          classes: ["mw-file"],
          href: "/wiki/file:moon-titan.png?redlink=1",
          img: node({ src: "/api/media/moon-titan.png", alt: "8-Titan" }),
        }),
      ),
    ).toEqual({
      src: "/api/media/moon-titan.png",
      alt: "8-Titan",
      href: "/wiki/file:moon-titan.png?redlink=1",
      caption: "",
    });
  });

  it("picks up the caption of a thumb", () => {
    const target = zoomTargetOf(
      anchor({
        classes: ["mw-file"],
        href: "/wiki/file:titan.png",
        img: node({ src: "/api/media/titan.png", alt: "" }),
        figcaption: node({}, "  The main entrance stairs  "),
      }),
    );
    expect(target?.caption).toBe("The main entrance stairs");
    expect(target?.alt).toBe("");
  });

  it("declines an author's own link= destination (a.external)", () => {
    // `[[File:x|link=https://…]]` — they named where it goes, so it goes there.
    expect(
      zoomTargetOf(
        anchor({
          classes: ["external"],
          href: "https://lethal.wiki",
          img: node({ src: "/api/media/x.png", alt: "x" }),
        }),
      ),
    ).toBeNull();
  });

  it("declines a red link with no image in it (§5.9 missing file)", () => {
    expect(
      zoomTargetOf(
        anchor({ classes: ["new", "red-link"], href: "/wiki/file:gone.png?redlink=1" }),
      ),
    ).toBeNull();
  });

  it("declines an ordinary article link", () => {
    expect(zoomTargetOf(anchor({ href: "/wiki/titan" }))).toBeNull();
  });

  it("declines an image whose src is empty", () => {
    expect(
      zoomTargetOf(
        anchor({ classes: ["mw-file"], href: "/wiki/file:x", img: node({ src: "", alt: "x" }) }),
      ),
    ).toBeNull();
  });

  it("reports a missing href as null rather than an empty string", () => {
    // `link=` with an empty value renders the image unlinked; if such an anchor
    // ever reaches here, the viewer must not offer a link to nowhere.
    const target = zoomTargetOf(
      anchor({ classes: ["mw-file"], img: node({ src: "/api/media/x.png", alt: "" }) }),
    );
    expect(target?.href).toBeNull();
  });
});
