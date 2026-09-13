/**
 * GET /api/search/suggest — title-only prefix suggestions for the search
 * box dropdown (routes.md: ≤8 items). Anonymous.
 */

import { jsonOk, mapError } from "@/lib/api-response";
import { getDb } from "@/lib/db/client";
import { searchSuggest } from "@/lib/db/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  try {
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") ?? "").trim();
    const locale = (url.searchParams.get("locale") ?? "en").trim().toLowerCase() || "en";
    const suggestions = q ? searchSuggest(getDb(), q, { locale, limit: 8 }) : [];
    return jsonOk({ query: q, locale, suggestions });
  } catch (err) {
    return mapError(err);
  }
}
