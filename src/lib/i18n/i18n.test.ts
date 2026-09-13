import { describe, expect, it } from "vitest";

import { en } from "./dictionaries/en";
import { ko } from "./dictionaries/ko";
import {
  DEFAULT_LOCALE,
  UI_LOCALES,
  dateTimeFormat,
  formatMessage,
  getDictionary,
  isUiLocale,
  resolveLocale,
} from "./index";

/** Flatten a nested dictionary into dot-path → leaf entries. */
function flatten(node: unknown, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value !== null && typeof value === "object") {
        for (const [p, v] of flatten(value, path)) out.set(p, v);
      } else {
        out.set(path, value);
      }
    }
  }
  return out;
}

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{([A-Za-z_$][\w$]*)\}/g)].map((m) => m[1]).sort();
}

describe("dictionary key parity", () => {
  it("en and ko carry recursively identical key sets", () => {
    const enKeys = [...flatten(en).keys()].sort();
    const koKeys = [...flatten(ko).keys()].sort();
    expect(koKeys).toEqual(enKeys);
  });

  it("every leaf is a non-empty string", () => {
    for (const dict of [en, ko]) {
      for (const [path, value] of flatten(dict)) {
        expect(typeof value, path).toBe("string");
        expect((value as string).length, path).toBeGreaterThan(0);
      }
    }
  });

  it("ko translates: parameterized messages keep the same placeholders", () => {
    const enFlat = flatten(en);
    const koFlat = flatten(ko);
    for (const [path, enValue] of enFlat) {
      expect(
        placeholders(koFlat.get(path) as string),
        `placeholders of ${path}`,
      ).toEqual(placeholders(enValue as string));
    }
  });

  it("spot check: ko is actually translated, not copied", () => {
    expect(ko.wikitext.tocTitle).toBe("목차");
    expect(ko.wikitext.tocTitle).not.toBe(en.wikitext.tocTitle);
    expect(ko.wiki.edit).not.toBe(en.wiki.edit);
  });
});

describe("wikitext section (engine contract — WikiMessages)", () => {
  it("provides every key context.ts maps, with expected en values", () => {
    expect(en.wikitext.tocTitle).toBe("Contents");
    expect(en.wikitext.redLinkTitleSuffix).toBe("(page does not exist)");
    expect(en.wikitext.redirectTo).toBe("Redirect to:");
    expect(en.wikitext.templateLoop).toBe("Template loop detected");
    expect(en.wikitext.templateDepthExceeded).toBe(
      "Template recursion depth limit exceeded",
    );
  });

  it("parameterized engine messages carry their placeholders in both locales", () => {
    for (const dict of [en, ko]) {
      expect(dict.wikitext.citeErrorNoText).toContain("{name}");
      expect(dict.wikitext.unknownVersion).toContain("{id}");
    }
    expect(formatMessage(en.wikitext.unknownVersion, { id: "v99" })).toContain("v99");
    expect(formatMessage(ko.wikitext.citeErrorNoText, { name: "note" })).toContain(
      "note",
    );
  });
});

describe("getDictionary / locale resolution", () => {
  it("returns the matching dictionary for known UI locales", () => {
    expect(getDictionary("en")).toBe(en);
    expect(getDictionary("ko")).toBe(ko);
  });

  it("falls back to en for unknown content locales", () => {
    expect(getDictionary("ja")).toBe(en);
    expect(getDictionary("fr")).toBe(en);
    expect(getDictionary("")).toBe(en);
  });

  it("isUiLocale narrows exactly the shipped UI locales", () => {
    expect(UI_LOCALES).toEqual(["en", "ko"]);
    expect(isUiLocale("en")).toBe(true);
    expect(isUiLocale("ko")).toBe(true);
    expect(isUiLocale("ja")).toBe(false);
    expect(isUiLocale(undefined)).toBe(false);
    expect(isUiLocale(null)).toBe(false);
  });

  it("resolveLocale handles region subtags, case, and unknowns", () => {
    expect(resolveLocale("ko-KR")).toBe("ko");
    expect(resolveLocale("KO")).toBe("ko");
    expect(resolveLocale("en-US")).toBe("en");
    expect(resolveLocale("ja")).toBe(DEFAULT_LOCALE);
    expect(resolveLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(resolveLocale(null)).toBe(DEFAULT_LOCALE);
  });
});

describe("formatMessage interpolation", () => {
  it("replaces {name} placeholders with string and number params", () => {
    expect(formatMessage("Showing {version} — this page's {branch} text", {
      version: "v65",
      branch: "v56",
    })).toBe("Showing v65 — this page's v56 text");
    expect(formatMessage("{count} results", { count: 3 })).toBe("3 results");
  });

  it("replaces repeated occurrences of the same placeholder", () => {
    expect(formatMessage("{a} and {a}", { a: "x" })).toBe("x and x");
  });

  it("leaves unmatched placeholders verbatim and ignores extra params", () => {
    expect(formatMessage("Hello {who}", {})).toBe("Hello {who}");
    expect(formatMessage("Hello {who}", { other: "y" })).toBe("Hello {who}");
    expect(formatMessage("no params")).toBe("no params");
  });
});

describe("dateTimeFormat (locales arrive as data — never throw)", () => {
  const when = new Date("2026-08-31T16:48:54Z");
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  };

  it("formats with the requested locale", () => {
    expect(dateTimeFormat("en", options).format(when)).toBe(
      new Intl.DateTimeFormat("en", options).format(when),
    );
    expect(dateTimeFormat("ko", options).format(when)).toBe(
      new Intl.DateTimeFormat("ko", options).format(when),
    );
  });

  it("falls back to English instead of throwing on an unusable tag", () => {
    // A '/robots.txt' request once reached the [locale] tree and this threw
    // RangeError, taking the whole render down.
    const expected = new Intl.DateTimeFormat(DEFAULT_LOCALE, options).format(when);
    expect(dateTimeFormat("robots.txt", options).format(when)).toBe(expected);
    expect(dateTimeFormat("ko_KR", options).format(when)).toBe(expected);
    expect(dateTimeFormat("", options).format(when)).toBe(expected);
  });

  it("memoizes per locale + options", () => {
    expect(dateTimeFormat("en", options)).toBe(dateTimeFormat("en", options));
    expect(dateTimeFormat("en", options)).not.toBe(dateTimeFormat("ko", options));
    expect(dateTimeFormat("en", options)).not.toBe(dateTimeFormat("en", { dateStyle: "medium" }));
  });
});
