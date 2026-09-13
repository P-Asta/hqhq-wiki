/**
 * GET /api/search — full-text search (routes.md, decisions O7).
 *
 * Query params: `q` (required), `locale` (default "en"), `limit` (1–50,
 * default 20), `offset` (bm25 rank order is not keyset-able, so paging is
 * offset-based; the query layer over-fetches and slices).
 *
 * For locale ≠ en the EN index is unioned in, deduped by page preferring the
 * locale's own hit; EN-only hits carry `fallbackFromEn: true` (O7 "EN" chip).
 */

import { jsonError, jsonOk, mapError } from "@/lib/api-response";
import { getDb } from "@/lib/db/client";
import { search } from "@/lib/db/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LIMIT = 50;
const MAX_OFFSET = 1000;

function intParam(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

export function GET(request: Request): Response {
  try {
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") ?? "").trim();
    if (!q) {
      return jsonError(400, "missing-query", "The `q` query parameter is required.");
    }
    const locale = (url.searchParams.get("locale") ?? "en").trim().toLowerCase() || "en";
    const limit = Math.max(1, intParam(url.searchParams.get("limit"), 20, MAX_LIMIT));
    const offset = intParam(url.searchParams.get("offset"), 0, MAX_OFFSET);

    const results = search(getDb(), q, { locale, limit, offset });
    return jsonOk({ query: q, locale, offset, results });
  } catch (err) {
    return mapError(err);
  }
}
