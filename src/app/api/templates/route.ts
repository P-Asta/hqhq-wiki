/**
 * GET /api/templates — the template picker's search, for the editor's
 * "Insert → Template" flow (docs/engine/visual-editor.md §5.1).
 *
 * Title substring match over the `Template:` namespace, in the editor's locale
 * with an EN fallback, redirects excluded. Anonymous, like every other read
 * (decisions-v2 O15.1): it returns page titles that are already public.
 */

import { jsonOk, mapError } from "@/lib/api-response";
import { getDb } from "@/lib/db/client";
import { listTemplates } from "@/lib/db/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The picker shows a short list; a longer one is a sign to keep typing. */
const MAX_RESULTS = 30;

export function GET(request: Request): Response {
  try {
    const url = new URL(request.url);
    const query = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
    const locale = (url.searchParams.get("locale") ?? "en").trim().toLowerCase() || "en";
    const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    const limit =
      Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_RESULTS) : MAX_RESULTS;

    const templates = listTemplates(getDb(), { locale, query, limit });
    return jsonOk({ query, locale, templates });
  } catch (err) {
    return mapError(err);
  }
}
