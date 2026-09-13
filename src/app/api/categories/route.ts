/**
 * GET /api/categories — the tag picker's search (visual-editor.md §5.3).
 *
 * Categories are this wiki's tags: membership is the `[[Category:X]]` tags in
 * the body and nothing else (decisions-v2 O13), so "which tags exist" is
 * exactly `listCategoriesWithCounts` — every slug anyone has ever filed under,
 * plus every written `Category:` page, with live counts. The picker shows the
 * counts because "Moons (14)" is what tells an author they are about to reuse
 * an existing tag rather than invent a near-duplicate.
 *
 * Anonymous: the same list is already public at `/special/categories`.
 */

import { jsonOk, mapError } from "@/lib/api-response";
import { getDb } from "@/lib/db/client";
import { listCategoriesWithCounts } from "@/lib/db/queries";
import { humanizeSlug } from "@/lib/title";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A picker is for recognising a name, not for browsing the whole wiki. */
const MAX_RESULTS = 30;

export function GET(request: Request): Response {
  try {
    const url = new URL(request.url);
    const query = (url.searchParams.get("q") ?? "").trim().slice(0, 120).toLowerCase();
    const locale = (url.searchParams.get("locale") ?? "en").trim().toLowerCase() || "en";

    const all = listCategoriesWithCounts(getDb(), locale);
    const categories = all
      .map((row) => ({
        slug: row.slug,
        // The name an author types is the page title when one exists, and the
        // humanized slug otherwise — the same name the chip will show.
        name: row.pageTitle ?? humanizeSlug(row.slug),
        total: row.total,
        hasPage: row.hasPage,
      }))
      .filter(
        (row) =>
          query === "" ||
          row.name.toLowerCase().includes(query) ||
          row.slug.includes(query),
      )
      .slice(0, MAX_RESULTS);

    return jsonOk({ query, locale, categories });
  } catch (err) {
    return mapError(err);
  }
}
