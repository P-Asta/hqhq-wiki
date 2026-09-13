/**
 * Read-view component smoke tests — render the server components to static
 * markup and assert the versioning.md §6 / routes.md behaviors this layer
 * owns: chip sorting and active state, `?v=`/carry-query link building, the
 * compact selector a page with no branches gets, the branch caption,
 * banner selection in PageBanners, and the empty states.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getDictionary } from "@/lib/i18n";
import {
  articleViewLabels,
  carriedVersion,
  withQuery,
  type ArticleView,
} from "@/lib/wiki/read-view";
import type { VersionEntry } from "@/lib/wikitext/types";

import { ArticleFooter } from "./article-footer";
import { CategoryGrid } from "./category-grid";
import { CategoryListing } from "./category-listing";
import { PageBanners } from "./page-banners";
import { RecentChangesTeaser } from "./recent-changes-teaser";
import { VersionSelector } from "./version-selector";

const labels = articleViewLabels("en", getDictionary("en"));

const VERSIONS: VersionEntry[] = [
  { id: "v50", label: "v50", ordinal: 50000, status: "legacy" },
  { id: "v62", label: "v62", ordinal: 62000, status: "supported" },
  { id: "v70", label: "v70", ordinal: 70000, status: "current" },
];

function revision(overrides: Partial<ArticleView["revision"]> = {}): ArticleView["revision"] {
  return {
    id: 7,
    isCurrent: true,
    title: "Titan",
    comment: "seed",
    isMinor: false,
    authorUid: "system",
    authorName: "HQHQ Wiki",
    createdAt: new Date("2026-08-30T12:00:00Z"),
    parentRevId: null,
    translatedFromRevId: null,
    ...overrides,
  };
}

function articleView(overrides: Partial<ArticleView> = {}): ArticleView {
  return {
    kind: "article",
    locale: "en",
    usedLocale: "en",
    fallbackFromEn: false,
    namespace: "main",
    slug: "titan",
    title: "Titan",
    displayTitleHtml: null,
    html: "<p>x</p>",
    toc: [],
    meta: null,
    cached: false,
    revision: revision(),
    updatedAt: new Date("2026-08-30T12:00:00Z"),
    redirectedFrom: null,
    categories: [],
    translations: [],
    translationStatus: null,
    versionScoped: false,
    versionBoundaries: [],
    availableVersions: VERSIONS,
    selectedVersion: "v70",
    defaultVersion: "v70",
    unknownVersionRequested: null,
    categoryListing: null,
    paths: {
      article: "/wiki/titan",
      edit: "/edit/titan",
      history: "/history/titan",
      whatLinksHere: "/special/what-links-here/titan",
    },
    carryQuery: {},
    description: "",
    ...overrides,
  };
}

describe("VersionSelector", () => {
  const base = {
    versions: VERSIONS,
    articlePath: "/wiki/titan",
    carryQuery: {},
    labels,
  };

  it("renders one chip per boundary, ordinal-sorted, active chip highlighted", () => {
    const html = renderToStaticMarkup(
      <VersionSelector {...base} boundaries={["v62", "v50"]} selected="v50" />,
    );
    // v50 chip precedes v62 despite input order.
    expect(html.indexOf("href=\"/wiki/titan?v=v50\"")).toBeGreaterThan(-1);
    expect(html.indexOf("href=\"/wiki/titan?v=v50\"")).toBeLessThan(
      html.indexOf("href=\"/wiki/titan?v=v62\""),
    );
    expect(html).toContain("aria-current=\"true\"");
    expect(html).toContain("bg-primary");
  });

  // The 2026-09-03 amendment: the versions this page writes for, as chips,
  // and nothing else. The registry is what turns a boundary into a label and
  // an ordinal — it is not an offer of its own any more.
  it("offers the page's own boundaries only — no registry, no status words", () => {
    const html = renderToStaticMarkup(
      <VersionSelector {...base} boundaries={["v62"]} selected="v70" />,
    );
    expect(html).toContain("href=\"/wiki/titan?v=v62\"");
    // v50 is in the registry and not on this page: it must not be reachable
    // from a control that claims to list what this page says.
    expect(html).not.toContain("?v=v50");
    expect(html).not.toContain("Current");
    expect(html).not.toContain("Legacy");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("<summary");
  });

  // The 2026-09-03 amendment: no version here is privileged. The site default
  // still decides what a URL with no `?v=` renders, and that is all it does —
  // the article never names it as the version a reader has strayed from.
  it("never names a latest version nor offers a way back to it", () => {
    for (const selected of ["v50", "v62", "v70"]) {
      const html = renderToStaticMarkup(
        <VersionSelector {...base} boundaries={["v62"]} selected={selected} />,
      );
      expect(html).not.toContain("latest");
      expect(html).not.toContain("Latest");
      // The only `?v=`-less link would be the reset: every href here picks a
      // version rather than abandoning the reader's choice.
      expect(html).not.toContain("href=\"/wiki/titan\"");
    }
  });

  it("names the branch on screen when the selection is not itself a boundary", () => {
    // Reading v70 on a page that branches at v62 shows the v62 text, and no
    // chip can spell that out — which is why this line survived the strip.
    // It is a plain caption now, not a banner: nothing is being warned about.
    const html = renderToStaticMarkup(
      <VersionSelector {...base} boundaries={["v62"]} selected="v70" />,
    );
    expect(html).toContain("this page&#x27;s v62 text");
    // Below the default too — the sentence is about the branch, not about
    // being off some canonical version.
    const below = renderToStaticMarkup(
      <VersionSelector {...base} boundaries={["v50"]} selected="v62" />,
    );
    expect(below).toContain("this page&#x27;s v50 text");
  });

  it("says nothing beside the chips when the selection is itself a boundary", () => {
    // The filled chip has already answered "which of these am I reading".
    const html = renderToStaticMarkup(
      <VersionSelector {...base} boundaries={["v50", "v62"]} selected="v62" />,
    );
    expect(html).not.toContain("Showing");
  });

  it("keeps carryQuery params on every version link", () => {
    const html = renderToStaticMarkup(
      <VersionSelector
        {...base}
        boundaries={["v62"]}
        selected="v50"
        carryQuery={{ redirect: "no" }}
      />,
    );
    // Every chip link carries `redirect=no` alongside its own `?v=`.
    expect(html).toContain("href=\"/wiki/titan?redirect=no&amp;v=v62\"");
  });

  // §6: a page with nothing written per version is not being asked a
  // question, so it is not shown a control — not a compact row, not a note.
  it("renders nothing at all on a page with no boundaries", () => {
    expect(renderToStaticMarkup(<VersionSelector {...base} boundaries={[]} selected="v70" />)).toBe(
      "",
    );
    // Away from the default too: the caption belongs to the chips, and there
    // are none.
    expect(renderToStaticMarkup(<VersionSelector {...base} boundaries={[]} selected="v50" />)).toBe(
      "",
    );
  });
});

describe("PageBanners", () => {
  it("renders nothing notable for a plain current view", () => {
    const html = renderToStaticMarkup(<PageBanners view={articleView()} labels={labels} />);
    expect(html).not.toContain(labels.oldRevisionTitle);
    expect(html).not.toContain(labels.fallbackTitle);
  });

  it("old revision: warning with revision id and a link to the current page", () => {
    const html = renderToStaticMarkup(
      <PageBanners
        view={articleView({ revision: revision({ isCurrent: false }) })}
        labels={labels}
      />,
    );
    expect(html).toContain(labels.oldRevisionTitle);
    expect(html).toContain(`${labels.revisionLabel} 7`);
    expect(html).toContain("href=\"/wiki/titan\"");
  });

  it("EN fallback: info banner with a translate CTA to the edit page", () => {
    const html = renderToStaticMarkup(
      <PageBanners view={articleView({ fallbackFromEn: true })} labels={labels} />,
    );
    expect(html).toContain(labels.fallbackTitle);
    expect(html).toContain("href=\"/edit/titan\"");
  });

  it("unknown version, outdated and original translation banners", () => {
    const outdated = renderToStaticMarkup(
      <PageBanners
        view={articleView({
          unknownVersionRequested: "v99",
          translationStatus: { outdated: true, original: false },
        })}
        labels={labels}
      />,
    );
    expect(outdated).toContain(labels.unknownVersionTitle);
    expect(outdated).toContain(labels.outdatedTitle);
    const original = renderToStaticMarkup(
      <PageBanners
        view={articleView({ translationStatus: { outdated: false, original: true } })}
        labels={labels}
      />,
    );
    expect(original).toContain(labels.originalTitle);
    expect(original).not.toContain(labels.outdatedTitle);
  });

  // "?v= changes nothing on this page" is not said anywhere any more: a page
  // with nothing version-specific to show simply shows no version control, so
  // there is no absence left to explain (§6, amended 2026-09-03).
  it("says nothing about a version that changed nothing", () => {
    const html = renderToStaticMarkup(
      <PageBanners view={articleView({ selectedVersion: "v50" })} labels={labels} />,
    );
    expect(html).not.toContain("version-specific");
    expect(html).not.toContain("reads the same");
  });

  // An unknown id is a different condition — the registry has no such version,
  // so the page is NOT showing what was asked for — and still needs saying.
  it("an unknown ?v= keeps its warning banner", () => {
    const html = renderToStaticMarkup(
      <PageBanners view={articleView({ unknownVersionRequested: "v99" })} labels={labels} />,
    );
    expect(html).toContain(labels.unknownVersionTitle);
    expect(html).toContain(labels.unknownVersionDescription);
  });

  it("redirected-from renders as a quiet note with the ?redirect=no link", () => {
    const html = renderToStaticMarkup(
      <PageBanners
        view={articleView({
          redirectedFrom: { title: "8-Titan", href: "/wiki/8-titan?redirect=no" },
        })}
        labels={labels}
      />,
    );
    expect(html).toContain(labels.redirectedFrom);
    expect(html).toContain("/wiki/8-titan?redirect=no");
  });
});

/**
 * The bug behind the report: a reader browsing at v56 passed through one
 * ordinary article and came out on the site default, because the carry rule
 * asked whether *that page* was version-scoped. A version choice is a reading
 * preference for the whole wiki (§6), so it rides along from every page.
 */
describe("carriedVersion — the choice survives a page with no version markup", () => {
  const moons = {
    namespace: "category" as const,
    slug: "moons",
    title: "Moons",
    href: "/wiki/category:moons",
  };

  function footer(view: ArticleView) {
    const carry = carriedVersion(view.selectedVersion, view.defaultVersion);
    return {
      carry,
      html: renderToStaticMarkup(
        <ArticleFooter
          locale="en"
          categories={view.categories}
          hrefFor={(candidate) => withQuery(candidate.href, { v: carry })}
          revision={view.revision}
          updatedAt={view.updatedAt}
          whatLinksHereHref={view.paths.whatLinksHere}
          labels={labels}
        />,
      ),
    };
  }

  it("hands v50 on from an unscoped page — the reader stays at v50", () => {
    const { carry, html } = footer(
      articleView({
        versionScoped: false,
        versionBoundaries: [],
        selectedVersion: "v50",
        categories: [moons],
      }),
    );
    expect(carry).toBe("v50");
    expect(html).toContain("/wiki/category:moons?v=v50");
  });

  it("hands it on from a scoped page exactly as before", () => {
    const { carry, html } = footer(
      articleView({
        versionScoped: true,
        versionBoundaries: ["v62"],
        selectedVersion: "v50",
        categories: [moons],
      }),
    );
    expect(carry).toBe("v50");
    expect(html).toContain("/wiki/category:moons?v=v50");
  });

  it("carries nothing on the site default, so default URLs stay clean", () => {
    const { carry, html } = footer(articleView({ selectedVersion: "v70", categories: [moons] }));
    expect(carry).toBeUndefined();
    expect(html).toContain("href=\"/wiki/category:moons\"");
    expect(html).not.toContain("?v=");
  });
});

describe("ArticleFooter / CategoryListing", () => {
  const ref = {
    namespace: "category" as const,
    slug: "moons",
    title: "Moons",
    href: "/wiki/category:moons",
  };

  it("footer lists category chips through hrefFor and the last-edited line", () => {
    const html = renderToStaticMarkup(
      <ArticleFooter
        locale="en"
        categories={[ref]}
        hrefFor={(r) => `${r.href}?v=v50`}
        revision={revision()}
        updatedAt={new Date("2026-08-30T12:00:00Z")}
        whatLinksHereHref="/special/what-links-here/titan"
        labels={labels}
      />,
    );
    expect(html).toContain("/wiki/category:moons?v=v50");
    expect(html).toContain(labels.lastEdited);
    expect(html).toContain("HQHQ Wiki");
  });

  it("footer shows the no-categories note when empty", () => {
    const html = renderToStaticMarkup(
      <ArticleFooter
        locale="en"
        categories={[]}
        revision={revision()}
        updatedAt={new Date("2026-08-30T12:00:00Z")}
        whatLinksHereHref="/special/what-links-here/titan"
        labels={labels}
      />,
    );
    expect(html).toContain(labels.noCategories);
  });

  it("category listing renders sections and the empty-category note", () => {
    const withMembers = renderToStaticMarkup(
      <CategoryListing subcategories={[ref]} members={[ref]} labels={labels} />,
    );
    expect(withMembers).toContain(labels.subcategories);
    expect(withMembers).toContain(labels.members);
    const empty = renderToStaticMarkup(
      <CategoryListing subcategories={[]} members={[]} labels={labels} />,
    );
    expect(empty).toContain(labels.emptyCategory);
    expect(empty).not.toContain(labels.subcategories);
  });
});

describe("home components", () => {
  it("category grid renders cards with their live count, or the empty label", () => {
    const grid = renderToStaticMarkup(
      <CategoryGrid
        categories={[
          {
            slug: "moons",
            label: "Moons",
            description: "All moons",
            href: "/wiki/category:moons",
            count: 7,
            hasPage: true,
          },
        ]}
        emptyLabel="none"
        countLabel="{count} pages"
      />,
    );
    expect(grid).toContain("Moons");
    expect(grid).toContain("href=\"/wiki/category:moons\"");
    // decisions-v2 O13.3: the card shows real membership, not a registry slug.
    expect(grid).toContain("7 pages");
    expect(
      renderToStaticMarkup(
        <CategoryGrid categories={[]} emptyLabel="none" countLabel="{count} pages" />,
      ),
    ).toContain("none");
  });

  it("recent-changes teaser renders rows and the view-all link", () => {
    const teaserLabels = {
      recentTitle: "Recent changes",
      recentAll: "Recent changes",
      emptyChanges: "No edits yet.",
      minor: "minor",
    } as Parameters<typeof RecentChangesTeaser>[0]["labels"];
    const html = renderToStaticMarkup(
      <RecentChangesTeaser
        locale="en"
        changes={[
          {
            revId: 3,
            title: "Titan",
            href: "/wiki/titan",
            historyHref: "/history/titan",
            locale: "en",
            authorName: "HQHQ Wiki",
            comment: "seeded",
            isMinor: true,
            createdAt: new Date("2026-08-30T12:00:00Z"),
          },
        ]}
        viewAllHref="/special/recent-changes"
        labels={teaserLabels}
      />,
    );
    expect(html).toContain("href=\"/wiki/titan\"");
    expect(html).toContain("seeded");
    expect(html).toContain("minor");
    expect(html).toContain("href=\"/special/recent-changes\"");
    expect(
      renderToStaticMarkup(
        <RecentChangesTeaser
          locale="en"
          changes={[]}
          viewAllHref="/special/recent-changes"
          labels={teaserLabels}
        />,
      ),
    ).toContain("No edits yet.");
  });
});
