/**
 * The chip row, tested where it is static — docs/engine/versioning.md §6.
 *
 * Rendered with `renderToStaticMarkup` the way wiki-components.test.tsx does
 * (vitest runs in a node environment, so static HTML is the whole surface).
 * Four claims, all of them things the 2026-09-03 amendment either kept or
 * created:
 *
 * 1. **A chip is the version, and nothing else.** The row prints the versions
 *    the page writes for; it must not print a registry version the page never
 *    wrote — the span line ("v56 – v70") did exactly that, and it is gone.
 * 2. **The active chip is the branch that GOVERNS the selection**, not one
 *    whose id equals it: a `[v56, v73]` page read at the default v70 fills the
 *    *v56* chip, and a selection below every boundary fills none, because a
 *    fallback highlight would be a lie.
 * 3. **A page with no branches draws nothing.** Not an empty frame, not a
 *    hint line: nothing.
 * 4. **The actions are siblings of the face, never children of it.** The
 *    article side passes `hrefFor`, and a `<button>` inside an `<a>` is markup
 *    no browser agrees how to activate — so the structure has to hold even
 *    when both are handed in.
 *
 * Branches come from `pageVersionBranches` rather than from hand-written
 * fixtures: the row and the model have to agree about what "active" means, and
 * a fixture cannot catch them drifting apart.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { formatMessage, getDictionary } from "@/lib/i18n";
import {
  deriveVersionOrdinal,
  pageVersionBranches,
  type VersionRegistryEntry,
} from "@/lib/version-branches";

import { VersionChips, type VersionChipsLabels } from "./version-chips";

const version = getDictionary("en").version;

/** What the article hands the row: a name for it, and the §1 note. */
const LABELS: VersionChipsLabels = {
  heading: version.boundaries,
  unregistered: version.unregistered,
};

/** What the editor hands it: the same, plus the wording of its actions. */
const EDIT_LABELS: VersionChipsLabels = {
  ...LABELS,
  remove: version.remove,
  register: version.registerVersion,
  busy: getDictionary("en").common.loading,
};

/** The seeded registry (versioning.md §1). */
const REGISTRY: VersionRegistryEntry[] = [
  "v45", "v47", "v49", "v50", "v55", "v56", "v60",
  "v62", "v64", "v66", "v68", "v69", "v70",
].map((id) => ({ id, label: id, ordinal: deriveVersionOrdinal(id) ?? 0 }));

const WITH_73: VersionRegistryEntry[] = [...REGISTRY, { id: "v73", label: "v73", ordinal: 73000 }];

const href = (id: string) => `/wiki/titan?v=${id}`;

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function branches(boundaries: string[], selected: string, registry = WITH_73) {
  return pageVersionBranches({ boundaries, registry, selected });
}

describe("VersionChips", () => {
  it("fills the branch that governs the selection — exactly one chip", () => {
    const html = renderToStaticMarkup(
      <VersionChips branches={branches(["v56", "v73"], "v70")} labels={LABELS} hrefFor={href} />,
    );
    expect(occurrences(html, 'aria-current="true"')).toBe(1);
    // …and it is v56, whose chip is rendered before the v73 one.
    expect(html.slice(0, html.indexOf("?v=v73"))).toContain('aria-current="true"');
    expect(html).toContain("bg-primary");
    // Both branches stay reachable, and the row is named.
    expect(html).toContain("?v=v56");
    expect(html).toContain(`aria-label="${version.boundaries}"`);
  });

  it("names the versions the page writes for and no others", () => {
    const html = renderToStaticMarkup(
      <VersionChips branches={branches(["v56", "v73"], "v70")} labels={LABELS} hrefFor={href} />,
    );
    // v70 is the newest registered version inside the v56 branch — the old
    // span line printed it ("v56 – v70") on a page that never wrote a word of
    // v70. Nothing in the row may name it now, not even in a title attribute.
    expect(html).not.toContain("v70");
    expect(html).not.toContain("v60");
    // Two chips, and no third element pretending to be one.
    expect(occurrences(html, "<a ")).toBe(2);
  });

  it("fills nothing when the selection sits below every boundary", () => {
    const html = renderToStaticMarkup(
      <VersionChips
        branches={branches(["v62", "v70"], "v50", REGISTRY)}
        labels={LABELS}
        hrefFor={href}
      />,
    );
    expect(html).not.toContain("aria-current");
    expect(html).not.toContain("bg-primary");
    // The chips are still offered — there is simply no branch to highlight.
    expect(occurrences(html, "<a ")).toBe(2);
  });

  it("draws nothing at all for a page that writes for no version", () => {
    expect(renderToStaticMarkup(<VersionChips branches={[]} labels={LABELS} hrefFor={href} />)).toBe(
      "",
    );
    // Not even a named-but-empty group for a screen reader to announce.
    expect(renderToStaticMarkup(<VersionChips branches={[]} labels={EDIT_LABELS} />)).toBe("");
  });

  it("marks an unregistered boundary and keeps it selectable", () => {
    const html = renderToStaticMarkup(
      <VersionChips
        branches={branches(["v62", "v73"], "v70", REGISTRY)}
        labels={LABELS}
        hrefFor={href}
      />,
    );
    expect(html).toContain(version.unregistered);
    expect(html).toContain("?v=v73");
    // v62 governs v70, so the note sits on an idle chip, not the active one.
    expect(occurrences(html, 'aria-current="true"')).toBe(1);
  });

  it("renders buttons for the editor form, inert chips with neither prop", () => {
    const model = branches(["v56", "v73"], "v70");
    const buttons = renderToStaticMarkup(
      <VersionChips branches={model} labels={LABELS} onSelect={() => {}} />,
    );
    expect(occurrences(buttons, 'type="button"')).toBe(2);
    expect(buttons).toContain('role="group"');

    const inert = renderToStaticMarkup(<VersionChips branches={model} labels={LABELS} />);
    expect(inert).not.toContain("<a ");
    expect(inert).not.toContain("<button");
    expect(inert).toContain(">v56<");
  });
});

describe("VersionChips actions", () => {
  it("gives each chip an X whose accessible name is that version", () => {
    const html = renderToStaticMarkup(
      <VersionChips
        branches={branches(["v56", "v73"], "v70")}
        labels={EDIT_LABELS}
        onSelect={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(html).toContain(`aria-label="${formatMessage(version.remove, { id: "v56" })}"`);
    expect(html).toContain(`aria-label="${formatMessage(version.remove, { id: "v73" })}"`);
    // Two faces + two X's, each a real button rather than a link or a div.
    expect(occurrences(html, 'type="button"')).toBe(4);
  });

  it("names the X with the registry's label, which is what the reader sees", () => {
    const html = renderToStaticMarkup(
      <VersionChips
        branches={pageVersionBranches({
          boundaries: ["v64"],
          registry: [{ id: "v64", label: "v64 Patch 1", ordinal: 64000 }],
          selected: "v64",
        })}
        labels={EDIT_LABELS}
        onSelect={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(html).toContain(`aria-label="${formatMessage(version.remove, { id: "v64 Patch 1" })}"`);
  });

  it("keeps the X out of the link — a button inside an anchor activates nothing", () => {
    const html = renderToStaticMarkup(
      <VersionChips
        branches={branches(["v56"], "v56")}
        labels={EDIT_LABELS}
        hrefFor={href}
        onRemove={() => {}}
      />,
    );
    // The anchor closes before the button opens: siblings, not nested.
    expect(html.indexOf("</a>")).toBeGreaterThan(-1);
    expect(html.indexOf("</a>")).toBeLessThan(html.indexOf("<button"));
  });

  it("renders no action button when the dictionary did not name it", () => {
    // An unlabelled icon button is worse than an absent one, and inventing a
    // name in code is how a user-visible string escapes the dictionary.
    const html = renderToStaticMarkup(
      <VersionChips
        branches={branches(["v56"], "v56")}
        labels={LABELS}
        onSelect={() => {}}
        onRemove={() => {}}
        onRegister={() => {}}
      />,
    );
    expect(occurrences(html, 'type="button"')).toBe(1);
  });

  it("offers registration on the unregistered chip only", () => {
    const html = renderToStaticMarkup(
      <VersionChips
        branches={branches(["v62", "v73"], "v70", REGISTRY)}
        labels={EDIT_LABELS}
        onSelect={() => {}}
        onRemove={() => {}}
        onRegister={() => {}}
      />,
    );
    const offer = formatMessage(version.registerVersion, { id: "v73" });
    expect(occurrences(html, `aria-label="${offer}"`)).toBe(1);
    expect(html).not.toContain(`aria-label="${formatMessage(version.registerVersion, { id: "v62" })}"`);
  });

  it("puts only the busy chip's actions out of reach, and says which", () => {
    const html = renderToStaticMarkup(
      <VersionChips
        branches={branches(["v62", "v73"], "v70", REGISTRY)}
        labels={EDIT_LABELS}
        onSelect={() => {}}
        onRemove={() => {}}
        onRegister={() => {}}
        busyId="v73"
      />,
    );
    // v73 is mid-registration: both of its actions are disabled and the one
    // in flight renames itself, while v62's X stays live.
    expect(occurrences(html, "disabled=")).toBe(2);
    expect(html).toContain(`aria-label="${getDictionary("en").common.loading}"`);
    expect(html).toContain(`aria-label="${formatMessage(version.remove, { id: "v62" })}"`);
  });
});
