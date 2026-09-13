/**
 * The editor's §6 strip, asserted where it is static (vitest runs in a node
 * environment, so `renderToStaticMarkup` is the whole surface — the same shape
 * version-chips.test.tsx uses) plus the two pieces of it that are pure
 * functions, `removalConfirmation` and `uncoveredVersions`.
 *
 * What docs/engine/versioning.md §6 claims here, after the 2026-09-03
 * amendment:
 *
 * 1. **Boundaries come from the buffer.** The bar is handed wikitext, not a
 *    saved page's `version_boundaries`, so typing `<v73+>` has to put v73 on
 *    the row immediately.
 * 2. **The active chip is the branch that governs the selection**, not one
 *    whose id equals it: a `[v56, v73]` buffer read at the default v70 fills
 *    the *v56* chip, and exactly that one.
 * 3. **The registry is no longer an offer.** A buffer naming no version draws
 *    nothing, however many versions the wiki has — the dropdown that used to
 *    keep the whole registry reachable is gone.
 * 4. **Every chip can be deleted, and the confirmation cannot lie.** The
 *    sentence the author reads is built from the same `previewVersionRemoval`
 *    result the confirmed edit recomputes, and it says three different things
 *    for the three genuinely different outcomes.
 * 5. **Adding a version is a menu, not a modal** (amended 2026-09-03 by user).
 *    The `+` lists the registry versions this page does not write for yet,
 *    newest first, and nothing it already covers — one choice, at the weight
 *    of one choice. The full version-scope dialog stays behind Insert →
 *    Version block, for the questions only it asks.
 *
 * Plus the register offer (decisions-v2 O16.2), which moved onto the chip it
 * is about: an unregistered boundary previews the site default instead of its
 * own branch, so it is broken until registered.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { formatMessage, getDictionary } from "@/lib/i18n";
import { deriveVersionOrdinal, type VersionRegistryEntry } from "@/lib/version-branches";
import { previewVersionRemoval } from "@/lib/visual-editor/version-edit";
import { versionsUsed } from "@/lib/wikitext-highlight";

import {
  EditorVersionBar,
  removalConfirmation,
  uncoveredVersions,
  type EditorVersionBarLabels,
} from "./editor-version-bar";

const dict = getDictionary("en");

const LABELS: EditorVersionBarLabels = {
  chips: {
    heading: dict.version.boundaries,
    unregistered: dict.version.unregistered,
    remove: dict.version.remove,
    register: dict.version.registerVersion,
    busy: dict.common.loading,
  },
  registerFailed: dict.version.registerFailed,
  strayCloser: dict.version.strayCloser,
  unclosedTag: dict.version.unclosedTag,
  fixCloser: dict.version.fixCloser,
  add: dict.version.addVersion,
  addMenuEmpty: dict.version.addMenuEmpty,
  addOther: dict.version.addOther,
  addOtherPlaceholder: dict.version.addOtherPlaceholder,
  addOtherSubmit: dict.version.addOtherSubmit,
  addOtherInvalid: dict.editor.versionInvalidId,
  empty: dict.version.noVersions,
  removeTitle: dict.version.removeTitle,
  removeBody: dict.version.removeBody,
  removeEmpty: dict.version.removeEmpty,
  removeNothing: dict.version.removeNothing,
  removeLeftBehind: dict.version.removeLeftBehind,
  removeConfirm: dict.common.delete,
  cancel: dict.common.cancel,
  close: dict.common.close,
};

/** The seeded registry (versioning.md §1), plus v73 so a branch can close. */
const REGISTRY: VersionRegistryEntry[] = [
  "v45", "v47", "v49", "v50", "v55", "v56", "v60",
  "v62", "v64", "v66", "v68", "v69", "v70", "v73",
].map((id) => ({ id, label: id, ordinal: deriveVersionOrdinal(id) ?? 0 }));

/**
 * A page that changes at v56 and again at v73 — §6's own example, written in
 * §2.1's grammar: two windows back to back, the first closing on the newest
 * registered version below the second (v70).
 */
const BUFFER =
  "<v56+v70>The base quota is 130 credits.</v56+v70>" +
  "<v73+>The base quota is 180 credits.</v73+>";

function render(props: {
  content: string;
  registry?: readonly VersionRegistryEntry[];
  selected?: string;
  disabled?: boolean;
  onAddVersion?: (id: string) => void;
}): string {
  return renderToStaticMarkup(
    <EditorVersionBar
      content={props.content}
      registry={props.registry ?? REGISTRY}
      selected={props.selected ?? "v70"}
      onSelect={() => {}}
      onContentChange={() => {}}
      onAddVersion={props.onAddVersion}
      getIdToken={async () => null}
      disabled={props.disabled}
      labels={LABELS}
    />,
  );
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("EditorVersionBar", () => {
  it("takes its boundaries from the buffer and marks the branch that governs the selection", () => {
    // Read at v65 — a version this page names nowhere — the `<v56+v70>` window
    // is what renders, so v56 is the filled chip and it is the only one. That
    // is rule 1: the active chip is the branch that GOVERNS the selection, not
    // one whose id equals it, which is what an equality test gets wrong.
    const html = render({ content: BUFFER, selected: "v65" });

    expect(occurrences(html, 'aria-current="true"')).toBe(1);
    const active = /<button[^>]*aria-current="true"[^>]*>([\s\S]*?)<\/button>/.exec(html);
    expect(active).not.toBeNull();
    expect(active?.[1]).toContain(">v56<");

    // Every id the buffer names has a chip — a window names both of its ends,
    // because the page does say something at each of them (§3) — and nothing
    // else does: no status word, and no version the buffer never writes for.
    expect(occurrences(html, ">v56<")).toBe(1);
    expect(occurrences(html, ">v70<")).toBe(1);
    expect(occurrences(html, ">v73<")).toBe(1);
    expect(html).not.toContain("v69");
    expect(html).not.toContain(dict.version.current);
  });

  it("carries an X per chip, each naming its own version", () => {
    const html = render({ content: BUFFER });

    expect(html).toContain(`aria-label="${formatMessage(dict.version.remove, { id: "v56" })}"`);
    expect(html).toContain(`aria-label="${formatMessage(dict.version.remove, { id: "v73" })}"`);
    // The confirmation is not on screen until one of them is clicked.
    expect(html).not.toContain(dict.common.delete);
  });

  it("offers a version the buffer names before it is saved, and before it is registered", () => {
    // v72 is in no registry: this is the author writing a boundary for a patch
    // nobody has registered yet (O16.2).
    const html = render({ content: "<v72+>New in v72.</v72+>" });

    expect(html).toContain(">v72<");
    expect(html).toContain(dict.version.unregistered);
    expect(html).toContain(
      `aria-label="${formatMessage(dict.version.registerVersion, { id: "v72" })}"`,
    );
  });

  it("draws nothing when the buffer names no version and there is nothing to offer", () => {
    // The whole-registry dropdown is gone: a page that writes for no version
    // has nothing to show, and thirteen identical renders were never an offer.
    expect(render({ content: "Plain wikitext with no version markup." })).toBe("");
    expect(render({ content: "Plain wikitext.", registry: [] })).toBe("");
  });

  it("still offers the way IN on a page that covers no version", () => {
    // Deleting a version was reachable from the chip while adding one was
    // three levels inside the INSERT menu — and on a page with no versions
    // the row that should hold it was not drawn at all. The + is the
    // counterpart of the X and lives beside it.
    const html = render({
      content: "Plain wikitext with no version markup.",
      onAddVersion: () => {},
    });

    expect(html).toContain(dict.version.addVersion);
    expect(html).toContain(dict.version.noVersions);
  });

  it("offers it beside the chips once the page does cover one", () => {
    const html = render({ content: BUFFER, onAddVersion: () => {} });
    expect(html).toContain(">v56<");
    expect(html).toContain(dict.version.addVersion);
  });

  it("opens a menu rather than a modal (amended 2026-09-03)", () => {
    // Adding a version to a page is ONE choice — which version — and the
    // dialog was the weight of a form for it.
    // The panel's contents cannot be asserted here (it is closed until a
    // pointer opens it, and this suite has none), but what the `+` IS can be:
    // a menu trigger, named by the same label, collapsed.
    const html = render({ content: BUFFER, onAddVersion: () => {} });
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(`aria-label="${dict.version.addVersion}"`);
  });

  it("does not offer to add for a principal who may not edit", () => {
    const html = render({ content: BUFFER, disabled: true, onAddVersion: () => {} });
    expect(html).not.toContain(dict.version.addVersion);
  });

  it("lets anyone choose a version but nobody who may not edit change one", () => {
    const html = render({ content: BUFFER, disabled: true });

    expect(html).toContain(">v56<");
    // Choosing a version is reading, not writing: it renders the page as it
    // stands at that patch and touches nothing. It therefore stays available
    // to a signed-out visitor — and, more to the point, during the moment
    // before /api/auth/me answers, which is most of what anyone ever sees of
    // this row.
    expect(html).toContain('type="button"');
    // The two actions that write are gone: deleting takes prose out of the
    // page, registering edits the site-wide registry.
    expect(html).not.toContain(formatMessage(dict.version.remove, { id: "v56" }));
    expect(html).not.toContain(formatMessage(dict.version.registerVersion, { id: "v73" }));
  });
});

describe("uncoveredVersions", () => {
  it("lists the versions this page does not write for, newest first", () => {
    // The `+` menu's whole content. Newest first because the version an author
    // is adding is almost always the patch that just shipped, and registry
    // order would bury it under twelve older ones.
    const listed = uncoveredVersions(REGISTRY, versionsUsed(BUFFER)).map((entry) => entry.id);

    expect(listed[0]).toBe("v69");
    expect(listed[1]).toBe("v68");
    // The three ids the page already names are not on offer: a second boundary
    // for one version is a boundary that shadows itself (§2.1). v70 is one of
    // them — it is the far end of the first window, which is a boundary too.
    expect(listed).not.toContain("v56");
    expect(listed).not.toContain("v70");
    expect(listed).not.toContain("v73");
    expect(listed).toHaveLength(REGISTRY.length - 3);
  });

  it("counts a version covered however the page named it", () => {
    // `versionsUsed` reads the buffer, not the saved page, so both ends of a
    // window and an `#ifversion` range count as coverage exactly as an
    // open-ended tag does.
    const buffer = "<v56+v60>Both.</v56+v60>\n{{#ifversion:v62|then|else}}";
    const listed = uncoveredVersions(REGISTRY, versionsUsed(buffer)).map((entry) => entry.id);

    expect(listed).not.toContain("v56");
    expect(listed).not.toContain("v60");
    expect(listed).not.toContain("v62");
    expect(listed).toContain("v70");
  });

  it("offers the whole registry to a page that writes for no version", () => {
    expect(uncoveredVersions(REGISTRY, versionsUsed("Plain wikitext."))).toHaveLength(
      REGISTRY.length,
    );
  });

  it("keeps a version whose id has no ordinal, at the end", () => {
    // The registry has it, so it is a version somebody can be running; it just
    // cannot be placed among the others.
    const odd: VersionRegistryEntry[] = [...REGISTRY, { id: "beta", label: "beta" }];
    const listed = uncoveredVersions(odd, []).map((entry) => entry.id);
    expect(listed[0]).toBe("v73");
    expect(listed[listed.length - 1]).toBe("beta");
  });
});

describe("removalConfirmation", () => {
  it("quotes the characters the transform would actually take", () => {
    const source = "<v56+>The base quota is 130 credits.</v56+>";
    const confirmation = removalConfirmation(source, "v56", LABELS);

    // 30 characters of prose, and the same 30 the transform reports — the
    // sentence and the edit are one computation, so they cannot drift.
    expect(previewVersionRemoval(source, "v56").removedChars).toBe(30);
    expect(confirmation.body).toBe(
      formatMessage(dict.version.removeBody, { id: "v56", chars: 30 }),
    );
    expect(confirmation.leftBehind).toBeNull();
    expect(confirmation.removable).toBe(true);
  });

  it("names the version the way its chip does, while matching on the id", () => {
    // The transform keys on `v64`; the author is reading a chip that says
    // "v64 Patch 1", and a dialog naming something else is one they have to
    // stop and decode.
    const source = "<v64+>Patched.</v64+>";
    const confirmation = removalConfirmation(source, "v64", LABELS, "v64 Patch 1");

    expect(confirmation.body).toBe(
      formatMessage(dict.version.removeBody, { id: "v64 Patch 1", chars: 8 }),
    );
    expect(confirmation.removable).toBe(true);
  });

  it("says no text goes when the version has nothing written for it yet", () => {
    // Exactly what the `+` menu makes: an empty passage waiting to be typed
    // into. Removing it is a real edit that deletes no prose, and quoting
    // "0 characters" over it would be the drift this exists to prevent.
    const source = "Prose.\n\n<v56+></v56+>\n";
    const confirmation = removalConfirmation(source, "v56", LABELS);

    expect(previewVersionRemoval(source, "v56").removedChars).toBe(0);
    expect(previewVersionRemoval(source, "v56").text).not.toBe(source);
    expect(confirmation.body).toBe(formatMessage(dict.version.removeEmpty, { id: "v56" }));
    expect(confirmation.removable).toBe(true);
  });

  it("offers nothing to confirm when the buffer would not change", () => {
    // Quoted markup is documentation, not a branch (the seeded Version
    // scoping help page is made of it), so there is no delete to offer.
    const source = "<nowiki><v56+>Documented, not written.</v56+></nowiki>";
    const confirmation = removalConfirmation(source, "v56", LABELS);

    expect(confirmation.body).toBe(formatMessage(dict.version.removeNothing, { id: "v56" }));
    expect(confirmation.leftBehind).toBeNull();
    expect(confirmation.removable).toBe(false);
  });

  it("counts what it refuses to touch, and still offers the part it can take", () => {
    const source = ["<v56+>Written for v56.</v56+>", "{{#ifversion:v56|then|else}}"].join("\n");
    const removal = previewVersionRemoval(source, "v56");
    const confirmation = removalConfirmation(source, "v56", LABELS);

    expect(removal.leftBehind).toBe(1);
    expect(confirmation.body).toBe(
      formatMessage(dict.version.removeBody, { id: "v56", chars: removal.removedChars }),
    );
    expect(confirmation.leftBehind).toBe(
      formatMessage(dict.version.removeLeftBehind, { id: "v56", count: 1 }),
    );
    expect(confirmation.removable).toBe(true);
  });

  it("reports the untouchable occurrence even when nothing at all can be removed", () => {
    // The chip exists *because* of this mention: without counting it, clicking
    // X on a v61 that is only the far end of somebody else's window would look
    // identical to "that version is not on this page" and leave the chip up.
    const source = "<v56+v61>Bounded.</v56+v61>";
    const confirmation = removalConfirmation(source, "v61", LABELS);

    expect(confirmation.body).toBe(formatMessage(dict.version.removeNothing, { id: "v61" }));
    expect(confirmation.leftBehind).toBe(
      formatMessage(dict.version.removeLeftBehind, { id: "v61", count: 1 }),
    );
    expect(confirmation.removable).toBe(false);
  });
});
