/**
 * `/[locale]/wiki/[...title]` — the article view (routes.md), version-aware
 * per versioning.md §6. The catch-all carries `nsPrefix+slug` (decisions O1).
 *
 * Query contract: `?v=` selects a game version (unknown ⇒ default + warning
 * banner), `?rev=` renders an old revision (never cached), `?redirect=no`
 * stops the one-hop redirect-follow. All of it is parsed and resolved by the
 * frozen loader `loadArticleView` (src/lib/wiki/read-view.ts), which also
 * rewrites `?v=` into the article HTML's internal links — this page only
 * turns the view model into JSX. Chrome links (categories, category members)
 * get the same `?v=` treatment here via `carryHref`. Both hold on ANY page:
 * a version choice is a reading preference for the whole wiki (§6), so an
 * article with no version markup passes it on instead of swallowing it — even
 * though it shows no selector at all. <VersionSelector> draws the versions the
 * page is *written* for, so a page written for none draws nothing; carrying
 * `?v=` onward is a separate job, and it holds everywhere.
 *
 * A `category:` page appends its auto member listing (decisions-v2 O13.5).
 * When the page exists its own wikitext renders ABOVE that listing as the
 * category description; when it does not, the listing rides along under the
 * inline editor below, so the category is browsable before anyone describes it.
 *
 * A title nobody has written yet is NOT a dead end (decisions-v2 O14): the
 * route mounts the very same <Editor> the /edit route mounts, seeded by the
 * shared loader `loadEditorView`, inline in the article chrome. <CreatePageView>
 * swaps in the classic "no text in this page" notice for a visitor who may not
 * edit — that half is a client fact (stateless Bearer auth), except local mode
 * (O15), which the server knows and passes down.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import { WikiHtml } from "@/components/wiki-html";
import { ArticleFooter } from "@/components/wiki/article-footer";
import { ArticleHeader } from "@/components/wiki/article-header";
import { CategoryListing } from "@/components/wiki/category-listing";
import { CreatePageView } from "@/components/wiki/create-page-view";
import { Editor } from "@/components/wiki/editor";
import { PageBanners } from "@/components/wiki/page-banners";
import { VersionSelector } from "@/components/wiki/version-selector";
import { getDb } from "@/lib/db/client";
import { formatMessage, getDictionary } from "@/lib/i18n";
import { editorLabels, loadEditorView } from "@/lib/wiki/edit-view";
import {
  articleViewLabels,
  carriedVersion,
  loadArticleView,
  parseArticleQuery,
  titlePathSegment,
  withQuery,
  type PageRefView,
  type RawSearchParams,
} from "@/lib/wiki/read-view";

export const dynamic = "force-dynamic";

export interface ArticlePageProps {
  params: Promise<{ locale: string; title: string[] }>;
  searchParams: Promise<RawSearchParams>;
}

/**
 * One load shared by generateMetadata and the page body within a request
 * (React per-request cache; keyed on primitives so identity is stable).
 */
const getView = cache(
  (
    locale: string,
    titlePath: string,
    version: string | null,
    revId: number | undefined,
    followRedirect: boolean,
  ) =>
    loadArticleView({
      db: getDb(),
      locale,
      segments: titlePath,
      version,
      revId,
      followRedirect,
    }),
);

async function resolveView({ params, searchParams }: ArticlePageProps) {
  const [{ locale: rawLocale, title }, rawSearch] = await Promise.all([params, searchParams]);
  const locale = decodeURIComponent(rawLocale).toLowerCase();
  const query = parseArticleQuery(rawSearch);
  const view = getView(locale, title.join("/"), query.version, query.revId, query.followRedirect);
  return { locale, view, query };
}

export async function generateMetadata(props: ArticlePageProps): Promise<Metadata> {
  const { locale, view } = await resolveView(props);
  const dict = getDictionary(locale);
  if (view.kind === "invalid") return { title: dict.wiki.pageNotFoundTitle };
  if (view.kind === "missing") {
    // The page IS the editor for this title now (O14.1), so the tab reads as
    // creation — exactly what /edit/<title> shows.
    return {
      title: formatMessage(dict.editor.creatingTitle, { title: view.title }),
      description: dict.wiki.pageNotFoundDescription,
    };
  }
  return {
    title: view.title,
    description: view.description !== "" ? view.description : undefined,
  };
}

export default async function ArticlePage(props: ArticlePageProps) {
  const { locale, view, query } = await resolveView(props);
  const dict = getDictionary(locale);
  const labels = articleViewLabels(locale, dict);

  if (view.kind === "invalid") notFound();

  if (view.kind === "missing") {
    // O14.1 — creating a page IS visiting its URL. Same loader, same editor
    // component, same state as /edit/<title>; the title comes from the URL and
    // the source starts empty, so Save creates the page and lands on it.
    const editorView = loadEditorView({
      db: getDb(),
      locale,
      segments: titlePathSegment(view.namespace, view.slug),
      version: query.version,
    });
    if (!editorView) notFound();

    return (
      // Wider than a read view: the editor carries a right rail and a split
      // preview, exactly as it does on /edit.
      <article className="mx-auto flex w-full max-w-[96rem] flex-col gap-4 py-2">
        <CreatePageView
          editor={
            <Editor
              locale={locale}
              titlePath={editorView.title.titlePath}
              displayTitle={editorView.displayTitle}
              previewTitle={editorView.previewTitle}
              initialContent={editorView.initialContent}
              initialParentRevId={editorView.parentRevId}
              translatedFromRevId={editorView.translatedFromRevId}
              versions={editorView.versions}
              defaultVersion={editorView.defaultVersion}
              selectedVersion={editorView.selectedVersion}
              labels={editorLabels(dict, editorView)}
            />
          }
          notice={{
            labels: {
              title: labels.noTextTitle,
              description: labels.noTextDescription,
              signIn: labels.signIn,
              edit: labels.createAction,
            },
            signInHref: view.signInHref,
            editHref: view.paths.edit,
            slug: view.slug,
          }}
        />

        {/* Unwritten category page with members: still list them (routes.md).
            The member links carry the reader's version like every other link
            out of an article — a category page is the most-travelled hop in
            the wiki, and dropping `?v=` here reset the whole session
            (versioning.md §6). */}
        {view.categoryListing ? (
          <CategoryListing
            subcategories={view.categoryListing.subcategories}
            members={view.categoryListing.members}
            hrefFor={(ref) =>
              withQuery(ref.href, {
                v: carriedVersion(
                  editorView.selectedVersion ?? editorView.defaultVersion,
                  editorView.defaultVersion,
                ),
              })
            }
            labels={labels}
          />
        ) : null}
      </article>
    );
  }

  // versioning.md §6: a non-default selection must survive navigation — the
  // loader already rewrote the article HTML with the same rule; chrome links
  // (categories, category members) go through this. It is deliberately blind
  // to `versionScoped`: the choice is a reading preference for the whole wiki,
  // so a page with nothing version-specific to show still has to hand it on
  // rather than dropping the reader back to the site default.
  const carryVersion = carriedVersion(view.selectedVersion, view.defaultVersion);
  const carryHref = (ref: PageRefView) => withQuery(ref.href, { v: carryVersion });

  return (
    <article className="mx-auto flex w-full max-w-4xl flex-col gap-4 py-2">
      <ArticleHeader
        title={view.title}
        displayTitleHtml={view.displayTitleHtml}
        editHref={withQuery(view.paths.edit, { v: carryVersion })}
        historyHref={view.paths.history}
        labels={labels}
      />

      {/* The versions this page is written for, and nothing else (§6): a page
          that records no boundary renders nothing here, because there is no
          question to put to its reader. The `?v=` it was read at still travels
          on through `carryHref` below — a page that says the same thing at
          every version is a stop on the way, never where a selection dies. */}
      <VersionSelector
        boundaries={view.versionBoundaries}
        versions={view.availableVersions}
        selected={view.selectedVersion}
        articlePath={view.paths.article}
        carryQuery={view.carryQuery}
        labels={labels}
      />

      <PageBanners view={view} carryVersion={carryVersion} labels={labels} />

      <WikiHtml
        html={view.html}
        labels={{
          viewer: labels.imageViewer,
          close: labels.close,
          filePage: labels.imageViewerFilePage,
        }}
      />

      {view.categoryListing ? (
        <CategoryListing
          subcategories={view.categoryListing.subcategories}
          members={view.categoryListing.members}
          hrefFor={carryHref}
          labels={labels}
        />
      ) : null}

      <ArticleFooter
        locale={locale}
        categories={view.categories}
        hrefFor={carryHref}
        revision={view.revision}
        updatedAt={view.updatedAt}
        whatLinksHereHref={view.paths.whatLinksHere}
        labels={labels}
      />
    </article>
  );
}
