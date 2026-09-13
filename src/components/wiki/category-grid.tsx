/**
 * Home category grid — the real `[[Category:…]]` categories of the wiki
 * (decisions-v2 O13.3) as hairline cards with the theme.md "Hero" hover
 * treatment (shadow-md + translateY(-1px)), each card one link to its
 * `category:` page and each carrying its live member count.
 *
 * A card is a browsing affordance, not a registry: the label falls back from
 * the optional `categories` metadata row to the `Category:` page title to the
 * humanized slug, and a category whose description page is unwritten is still
 * a perfectly good card (its link lands on the listing).
 */

import Link from "next/link";

import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { formatMessage } from "@/lib/i18n";
import type { HomeCategoryView } from "@/lib/wiki/read-view";

export interface CategoryGridProps {
  categories: HomeCategoryView[];
  emptyLabel: string;
  /** `home.categoryPageCount` — "{count} pages". */
  countLabel: string;
}

export function CategoryGrid({ categories, emptyLabel, countLabel }: CategoryGridProps) {
  if (categories.length === 0) {
    return <p className="text-sm text-mute">{emptyLabel}</p>;
  }

  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {categories.map((category) => (
        <li key={category.slug}>
          <Link href={category.href} className="focus-ring block rounded-[var(--radius-lg)]">
            <Card interactive className="h-full">
              <CardTitle>{category.label}</CardTitle>
              {category.description ? (
                <CardDescription>{category.description}</CardDescription>
              ) : null}
              <p className="mt-3 font-mono text-xs text-faint">
                {formatMessage(countLabel, { count: category.count })}
              </p>
            </Card>
          </Link>
        </li>
      ))}
    </ul>
  );
}
