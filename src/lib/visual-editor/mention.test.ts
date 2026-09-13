/**
 * What opens the page and template search at the caret (mention.ts,
 * visual-editor.md §13).
 *
 * Two properties are worth more than the rest of this file put together, and
 * both are about *not* firing: a trigger that appeared inside an email address
 * or inside a finished link would put a panel over the sentence somebody is
 * writing, once per keystroke, and there is no way to spell your way out of a
 * panel that keeps coming back.
 */

import { describe, expect, it } from "vitest";

import { mentionContext, mentionWikitext } from "./mention";

describe("the page trigger", () => {
  it("opens on the two brackets a wiki author already types", () => {
    expect(mentionContext("See [[")).toEqual({ kind: "page", query: "", consumed: 2 });
    expect(mentionContext("See [[art")).toEqual({ kind: "page", query: "art", consumed: 5 });
  });

  it("keeps the whole run it would have to delete", () => {
    // `consumed` is the contract: take a row and exactly this many characters
    // are replaced by the link.
    const found = mentionContext("The [[gold ba");
    expect(found?.consumed).toBe("[[gold ba".length);
  });

  it("closes as soon as the author closes the link themselves", () => {
    // Ignoring the panel and finishing the brackets by hand has to write the
    // very same wikitext — that is what makes the panel a help and not a mode.
    expect(mentionContext("See [[Artifice]]")).toBeNull();
  });

  it("closes at the pipe, where a page name stops and a label starts", () => {
    // `[[target|label]]` (spec §5.3): from the pipe on, what is being typed is
    // not a page name and no index can answer it.
    expect(mentionContext("See [[Artifice|the ")).toBeNull();
  });

  it("never crosses a line", () => {
    expect(mentionContext("[[art\nmore")).toBeNull();
  });

  it("gives up on a query the length of a paragraph", () => {
    expect(mentionContext(`[[${"a".repeat(200)}`)).toBeNull();
  });
});

describe("the @ trigger", () => {
  it("opens the page search where it begins a word", () => {
    expect(mentionContext("Ask @art")).toEqual({ kind: "page", query: "art", consumed: 4 });
    expect(mentionContext("@")).toEqual({ kind: "page", query: "", consumed: 1 });
  });

  it("stays shut inside an email address", () => {
    // The one false positive that would matter, because an address is exactly
    // the thing somebody types into a wiki page and cannot escape from.
    expect(mentionContext("crew@company")).toBeNull();
    expect(mentionContext("im.azta.rs@gmail.com")).toBeNull();
  });

  it("stays shut after a word character of any script", () => {
    expect(mentionContext("타이탄@문의")).toBeNull();
  });
});

describe("the template trigger", () => {
  it("opens on two braces", () => {
    expect(mentionContext("{{inf")).toEqual({ kind: "template", query: "inf", consumed: 5 });
  });

  it("closes once the call is closed", () => {
    expect(mentionContext("{{Verify}}")).toBeNull();
  });

  it("closes at the pipe, where the parameters start", () => {
    expect(mentionContext("{{Verify|unc")).toBeNull();
  });
});

describe("two triggers at once", () => {
  it("answers the one nearest the caret, which is the one being typed", () => {
    // In `[[Ship {{` the author has moved on; a page search would be answering
    // a question they finished asking.
    expect(mentionContext("[[Ship {{inf")?.kind).toBe("template");
    expect(mentionContext("{{Verify}} and [[art")?.kind).toBe("page");
  });

  it("prefers the brackets to an @ inside them", () => {
    expect(mentionContext("[[crew@")?.kind).toBe("page");
  });
});

describe("what a row writes", () => {
  it("writes the link an author was already spelling", () => {
    expect(mentionWikitext("page", "Gold bar")).toBe("[[Gold bar]]");
  });

  it("writes a template call with no parameters, which the form then fills", () => {
    // Not what gets inserted: it is the `initialSource` §5.1's dialog opens
    // on, so an infobox arrives with its parameter form rather than as a pair
    // of braces that renders nothing.
    expect(mentionWikitext("template", "Infobox moon")).toBe("{{Infobox moon}}");
  });
});

describe("no trigger at all", () => {
  it("is the answer for ordinary prose", () => {
    for (const text of ["", "Artifice is a moon", "a [ b ] c", "2 { 3", "]] and }}"]) {
      expect(mentionContext(text)).toBeNull();
    }
  });
});
