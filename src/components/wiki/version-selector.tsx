/**
 * Version selector — the article header's copy of the §6 control
 * (docs/engine/versioning.md), styled per theme.md "Version selector".
 *
 * **Amended 2026-09-03 (by user): the versions this page is written for, as
 * chips, and nothing else.** A page that records `[v56, v70]` shows two chips.
 * A page that records none shows *nothing* — no compact row, no registry
 * dropdown, no "this page reads the same on every version" line. The reader of
 * a page with one telling of the story is not being asked a question, so this
 * stops asking it.
 *
 * **Amended again 2026-09-03 (by user): no version here is the real one.** The
 * site default decides what a URL with no `?v=` renders, and that is the whole
 * of its job — it is where a reader without an opinion starts, not a place
 * every other reading is away from. So this control no longer names a latest
 * version and no longer offers to send anybody back to it: a page covering v56
 * and v70 is equally about both, and "reset to latest" told a v56 player they
 * were somewhere they should not be. The component is not even told which
 * version is the default any more, which is the surest way for it not to
 * privilege one.
 *
 * What that removed, and why each was worth removing:
 *
 * - **The whole-registry dropdown.** Thirteen versions, eleven of which render
 *   this page identically — a list whose length was a property of the wiki
 *   rather than of the page in front of you.
 * - **The status words** (Current / Supported / Legacy). Registry facts, not
 *   facts about this article, and they made every chip look like a taxonomy.
 * - **The compact row on a page with no branches**, which is now simply
 *   nothing at all.
 * - **The "latest is {version}" clause and the reset link**, and with them the
 *   banner that carried them.
 *
 * What stays, because chips cannot say it:
 *
 * - the line naming which *branch* is on screen whenever the selection is not
 *   itself a boundary — "Showing v65 — this page's v56 text". That is the
 *   answer to "which of these chips am I reading", not a remark about the
 *   default, and §6 rule 1 exists for it. It is a quiet caption under the
 *   chips now rather than an info banner: an alert frame was right while it
 *   carried a way back out, and overstates a plain identification.
 *
 * The unknown-`?v=` warning is a different condition — the page really is not
 * showing what was asked for — and lives in <PageBanners>, untouched.
 *
 * Every choice is a plain `?v=` link: server render, no JS. The chips
 * themselves live in `VersionChips`, shared with the editor; the article
 * passes no action handlers, so the row it gets is links and nothing else.
 */

import type { ReactElement } from "react";

import { VersionChips, type VersionChipsLabels } from "@/components/wiki/version-chips";
import { formatMessage } from "@/lib/i18n";
import { withQuery } from "@/lib/locale-path";
import { pageVersionBranches } from "@/lib/version-branches";
import type { ArticleViewLabels } from "@/lib/wiki/read-view";
import type { VersionEntry } from "@/lib/wikitext/types";

export interface VersionSelectorProps {
  /** `meta.versionBoundaries` of the page (ids; may be unregistered, may be empty). */
  boundaries: string[];
  /**
   * Whole registry, ordinal-ascending (`availableVersions`). Not a menu any
   * more: it is what turns a boundary id into its label and its ordinal, so
   * the chips sort and read the way the registry says they should.
   */
  versions: VersionEntry[];
  selected: string;
  /** Base article path; `?v=` (and `carryQuery`) are appended here. */
  articlePath: string;
  /** Params the links must keep (`rev`, `redirect`) — read-view `carryQuery`. */
  carryQuery: Record<string, string>;
  labels: ArticleViewLabels;
}

function sameVersion(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function VersionSelector({
  boundaries,
  versions,
  selected,
  articlePath,
  carryQuery,
  labels,
}: VersionSelectorProps): ReactElement | null {
  // The model does the §6 work: ordinal sorting, and — the rule that matters —
  // marking the branch that *governs* the selection rather than one whose id
  // equals it.
  const branches = pageVersionBranches({ boundaries, registry: versions, selected });

  // Nothing on this page is written per version, so there is nothing to
  // choose between and nothing to say about the choice.
  if (branches.length === 0) return null;

  const byId = new Map(versions.map((entry) => [entry.id, entry]));
  const href = (id: string) => withQuery(articlePath, { ...carryQuery, v: id });
  const selectedLabel = byId.get(selected)?.label ?? selected;
  const governing = branches.find((branch) => branch.active) ?? null;

  const chipLabels: VersionChipsLabels = {
    heading: labels.versionBoundariesTitle,
    unregistered: labels.versionUnregistered,
  };

  // Reading v65 on a page that branches at v56 shows the v56 text, and the
  // reader cannot deduce that from the id they picked. Say it — wherever it is
  // true, the site default included, because the default is a reading like any
  // other and gets the same sentence rather than a different frame.
  const branchLine =
    governing !== null && !sameVersion(governing.id, selected)
      ? formatMessage(labels.versionShowingBranch, {
          version: selectedLabel,
          branch: governing.label,
        })
      : null;

  return (
    <div className="sticky top-16 z-20 -my-1 bg-canvas py-2">
      <VersionChips branches={branches} labels={chipLabels} hrefFor={href} />

      {branchLine === null ? null : <p className="mt-1.5 text-xs text-mute">{branchLine}</p>}
    </div>
  );
}
