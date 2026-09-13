/**
 * Category page member listing — appended below the rendered article on
 * `category:` pages (routes.md `/wiki/[...title]`): subcategories first,
 * then the member pages, in multi-column link lists.
 */

import Link from "next/link";

import type { ArticleViewLabels, PageRefView } from "@/lib/wiki/read-view";

export interface CategoryListingProps {
  subcategories: PageRefView[];
  members: PageRefView[];
  /** Applied to every member href (e.g. a non-default `?v=`). */
  hrefFor?: (ref: PageRefView) => string;
  labels: ArticleViewLabels;
}

function LinkColumns({
  refs,
  hrefFor,
}: {
  refs: PageRefView[];
  hrefFor: (ref: PageRefView) => string;
}) {
  return (
    <ul className="columns-1 gap-8 sm:columns-2 lg:columns-3">
      {refs.map((ref) => (
        <li key={`${ref.namespace}:${ref.slug}`} className="break-inside-avoid py-0.5">
          <Link className="text-link hover:underline" href={hrefFor(ref)}>
            {ref.title}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function CategoryListing({ subcategories, members, hrefFor, labels }: CategoryListingProps) {
  const href = hrefFor ?? ((ref: PageRefView) => ref.href);

  return (
    <section className="mt-8 flex flex-col gap-6">
      {subcategories.length > 0 ? (
        <div>
          <h2 className="border-b border-hairline pb-1.5 text-lg font-semibold tracking-[-0.02em] text-ink">
            {labels.subcategories}
          </h2>
          <div className="mt-3">
            <LinkColumns refs={subcategories} hrefFor={href} />
          </div>
        </div>
      ) : null}

      <div>
        <h2 className="border-b border-hairline pb-1.5 text-lg font-semibold tracking-[-0.02em] text-ink">
          {labels.members}
        </h2>
        <div className="mt-3">
          {members.length > 0 ? (
            <LinkColumns refs={members} hrefFor={href} />
          ) : (
            <p className="text-sm text-mute">{labels.emptyCategory}</p>
          )}
        </div>
      </div>
    </section>
  );
}
