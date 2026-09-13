/**
 * The pure decisions inside the editor's small dialogs
 * (docs/engine/visual-editor.md §1 link dialog, §6 shortcuts).
 *
 * Each is exported so it can be tested here rather than through the DOM: the
 * suite runs in vitest's `node` environment, and none of these questions — "is
 * this target a URL?", "what should the wiki be searched for?", "does the page
 * an author typed exist?", "which modifier keycap does this platform print?" —
 * needs a browser to answer. The components around them are markup.
 */

import { describe, expect, it } from "vitest";

import { altModifierLabel, modifierLabel } from "./editor-shortcuts";
import {
  isExternalTarget,
  linkSearchQuery,
  linkSuggestionTarget,
  linkTargetStatus,
  type LinkSuggestion,
} from "./editor-link-dialog";

/* ---------------------------------------------------------------- */
/* isExternalTarget — page name or URL?                              */
/* ---------------------------------------------------------------- */

describe("isExternalTarget", () => {
  it("recognises the web protocols an author actually pastes", () => {
    expect(isExternalTarget("https://lethalcompany.wiki/Artifice")).toBe(true);
    expect(isExternalTarget("http://example.com")).toBe(true);
    expect(isExternalTarget("ftp://files.example.com/x.zip")).toBe(true);
  });

  it("accepts the protocol-relative form, which this dialog always brackets", () => {
    // `//host` is external only inside `[...]` (spec §6.1) — and the link this
    // dialog writes is bracketed, so the hint may say so.
    expect(isExternalTarget("//example.com/logo.png")).toBe(true);
  });

  it("accepts the schemes that carry no slashes", () => {
    expect(isExternalTarget("mailto:someone@example.com")).toBe(true);
    expect(isExternalTarget("tel:+15551234")).toBe(true);
    expect(isExternalTarget("magnet:?xt=urn:btih:abc")).toBe(true);
  });

  it("is case-insensitive about the scheme, as URLs are", () => {
    expect(isExternalTarget("HTTPS://example.com")).toBe(true);
    expect(isExternalTarget("MailTo:someone@example.com")).toBe(true);
  });

  it("ignores the padding a paste leaves behind", () => {
    expect(isExternalTarget("  https://example.com  ")).toBe(true);
    expect(isExternalTarget("   ")).toBe(false);
  });

  it("treats a bare page name as internal", () => {
    expect(isExternalTarget("Artifice")).toBe(false);
    expect(isExternalTarget("68-Artifice")).toBe(false);
    expect(isExternalTarget("")).toBe(false);
  });

  it("treats a namespaced page as internal: a colon is not a protocol", () => {
    // The case that makes a naive `includes(":")` test wrong.
    expect(isExternalTarget("Template:Infobox moon")).toBe(false);
    expect(isExternalTarget("Category:Mechanics")).toBe(false);
    expect(isExternalTarget("File:Artifice.png")).toBe(false);
    expect(isExternalTarget("Moons#Titan")).toBe(false);
  });
});

/* ---------------------------------------------------------------- */
/* modifierLabel — which keycap to print                             */
/* ---------------------------------------------------------------- */

describe("modifierLabel", () => {
  it("prints Cmd on Apple platforms", () => {
    expect(modifierLabel("MacIntel")).toBe("Cmd");
    expect(modifierLabel("iPhone")).toBe("Cmd");
    expect(modifierLabel("iPad")).toBe("Cmd");
    expect(modifierLabel("MacPPC")).toBe("Cmd");
  });

  it("prints Ctrl everywhere else", () => {
    expect(modifierLabel("Win32")).toBe("Ctrl");
    expect(modifierLabel("Linux x86_64")).toBe("Ctrl");
    expect(modifierLabel("Linux armv8l")).toBe("Ctrl");
    expect(modifierLabel("")).toBe("Ctrl");
  });

  it("does not mistake a platform that merely contains the word", () => {
    // A `.includes("mac")` test would call this Apple hardware.
    expect(modifierLabel("Linux mac-emulator")).toBe("Ctrl");
  });
});

/* ---------------------------------------------------------------- */
/* altModifierLabel — the other keycap the table prints              */
/* ---------------------------------------------------------------- */

describe("altModifierLabel", () => {
  it("prints Option on Apple hardware and Alt everywhere else", () => {
    // `Alt+Arrow` moves a block (visual-editor.md §3.1). It is one physical
    // key and one `event.altKey`, but two keycaps — and a table that printed
    // `Alt` to a Mac would be naming a key that is not on the keyboard.
    expect(altModifierLabel("MacIntel")).toBe("Option");
    expect(altModifierLabel("iPad")).toBe("Option");
    expect(altModifierLabel("Win32")).toBe("Alt");
    expect(altModifierLabel("Linux x86_64")).toBe("Alt");
    expect(altModifierLabel("")).toBe("Alt");
  });

  it("agrees with modifierLabel about which platform it is on", () => {
    for (const platform of ["MacIntel", "iPhone", "Win32", "Linux armv8l", "", "  "]) {
      const apple = modifierLabel(platform) === "Cmd";
      expect(altModifierLabel(platform) === "Option", platform).toBe(apple);
    }
  });
});

/* ---------------------------------------------------------------- */
/* linkSearchQuery — what to ask the suggest route for               */
/* ---------------------------------------------------------------- */

describe("linkSearchQuery", () => {
  it("sends a bare page name as it stands", () => {
    expect(linkSearchQuery("Artifice")).toBe("Artifice");
  });

  it("strips the namespace prefix, because the index holds bare names", () => {
    // The whole reason this function exists. `GET /api/search/suggest` indexes
    // a Template: page under "Infobox moon"; sending the prefix with it matches
    // nothing, and the dialog would then call an existing page new — about
    // exactly the pages that are hardest to spell from memory.
    expect(linkSearchQuery("Template:Infobox moon")).toBe("Infobox moon");
    expect(linkSearchQuery("category:Mechanics")).toBe("Mechanics");
  });

  it("drops the plain-link colon and the fragment", () => {
    expect(linkSearchQuery(":Category:Mechanics")).toBe("Mechanics");
    expect(linkSearchQuery("Moons#Titan")).toBe("Moons");
  });

  it("normalizes the way a title is normalized (spec §5.7)", () => {
    expect(linkSearchQuery("gold_bar")).toBe("Gold bar");
    expect(linkSearchQuery("  gold   bar  ")).toBe("Gold bar");
  });

  it("searches for nothing when there is no page name in the target", () => {
    // A URL is not a page: an external target must never trigger a page
    // search, and neither should a target with no title left in it.
    expect(linkSearchQuery("https://example.com/Artifice")).toBeNull();
    expect(linkSearchQuery("//example.com")).toBeNull();
    expect(linkSearchQuery("mailto:someone@example.com")).toBeNull();
    expect(linkSearchQuery("")).toBeNull();
    expect(linkSearchQuery("   ")).toBeNull();
    expect(linkSearchQuery("#Titan")).toBeNull();
  });
});

/* ---------------------------------------------------------------- */
/* linkSuggestionTarget — the target that LINKS to a suggestion      */
/* ---------------------------------------------------------------- */

function suggestion(
  namespace: LinkSuggestion["namespace"],
  slug: string,
  title: string,
): LinkSuggestion {
  return { pageId: 1, namespace, slug, title };
}

describe("linkSuggestionTarget", () => {
  it("is the title itself in the main namespace", () => {
    expect(linkSuggestionTarget(suggestion("main", "gold-bar", "Gold bar"))).toBe("Gold bar");
  });

  it("spells the namespace back canonically", () => {
    expect(linkSuggestionTarget(suggestion("template", "infobox-moon", "Infobox moon"))).toBe(
      "Template:Infobox moon",
    );
    expect(linkSuggestionTarget(suggestion("project", "about", "About"))).toBe("Project:About");
  });

  it("forces the plain-link form for File: and Category:", () => {
    // Without the leading colon `[[Category:Mechanics]]` FILES the page into
    // the category and renders nothing, and `[[File:Ship.png]]` embeds the
    // image (spec §5.8). Confirmed against POST /api/preview. This dialog
    // makes links; the media dialog is where an image is placed.
    expect(linkSuggestionTarget(suggestion("category", "mechanics", "Mechanics"))).toBe(
      ":Category:Mechanics",
    );
    expect(linkSuggestionTarget(suggestion("file", "ship.png", "Ship.png"))).toBe(":File:Ship.png");
  });

  it("writes a target the search finds its way back from", () => {
    // The round trip that keeps the dialog consistent with itself: choosing a
    // row must not leave the field in a state the next keystroke reports as a
    // new page.
    const rows = [
      suggestion("main", "gold-bar", "Gold bar"),
      suggestion("template", "infobox-moon", "Infobox moon"),
      suggestion("category", "mechanics", "Mechanics"),
      suggestion("file", "ship.png", "Ship.png"),
    ];
    for (const row of rows) {
      const target = linkSuggestionTarget(row);
      expect(linkSearchQuery(target), target).toBe(row.title);
      expect(linkTargetStatus(target, [row]), target).toBe("existing");
    }
  });
});

/* ---------------------------------------------------------------- */
/* linkTargetStatus — will this be a red link?                       */
/* ---------------------------------------------------------------- */

describe("linkTargetStatus", () => {
  const goldBar = suggestion("main", "gold-bar", "Gold bar");

  it("says nothing until the search has answered THIS target", () => {
    // A list answering an earlier keystroke is not evidence about this one,
    // and neither is a search that failed — which is why the caller passes
    // null rather than an empty list for both.
    expect(linkTargetStatus("Gold bar", null)).toBe("none");
  });

  it("recognises the page under any spelling of its title (decisions O1)", () => {
    // Identity is (namespace, slug), so the comparison runs on the parsed
    // title: these are one page, not four.
    for (const typed of ["Gold bar", "gold bar", "gold_bar", "  Gold   Bar  "]) {
      expect(linkTargetStatus(typed, [goldBar]), typed).toBe("existing");
    }
  });

  it("ignores a fragment, which is a place on the page and not a page", () => {
    expect(linkTargetStatus("Gold bar#Uses", [goldBar])).toBe("existing");
  });

  it("calls a target nothing answered new — which is allowed, not an error", () => {
    expect(linkTargetStatus("Gold Bra", [goldBar])).toBe("new");
    expect(linkTargetStatus("Artifce", [])).toBe("new");
  });

  it("does not let a page in another namespace vouch for this one", () => {
    // The typo this whole feature is about, one namespace over: a template
    // called "Gold bar" says nothing about the article.
    const template = suggestion("template", "gold-bar", "Gold bar");
    expect(linkTargetStatus("Gold bar", [template])).toBe("new");
    expect(linkTargetStatus("Template:Gold bar", [template])).toBe("existing");
  });

  it("says nothing about a URL", () => {
    // Nothing was searched for, so there is nothing to report — and an
    // external link is never a red link.
    expect(linkTargetStatus("https://example.com", [])).toBe("none");
  });

  it("says nothing about a namespace this wiki cannot store a page in", () => {
    // Talk:/User:/Help: are parseable and permanently red (decisions O2), so
    // "this will be a new page" would be a promise nobody can keep.
    expect(linkTargetStatus("Talk:Gold bar", [])).toBe("none");
    expect(linkTargetStatus("User:Someone", [])).toBe("none");
  });

  it("says nothing about a target with no title in it", () => {
    expect(linkTargetStatus("", [])).toBe("none");
    expect(linkTargetStatus("   ", [])).toBe("none");
  });
});
