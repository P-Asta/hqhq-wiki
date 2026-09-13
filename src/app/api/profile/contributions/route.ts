/**
 * GET /api/profile/contributions — the caller's own edit history
 * (supplements routes.md for the /[locale]/profile page; uses
 * queries.contributions keyset pagination).
 *
 * Auth: any signed-in user (Bearer). Query: ?limit= (1–100, default 25) &
 * cursor=<revId>. Response: { rows, nextCursor }.
 */

import { jsonError, jsonOk, mapError } from "@/lib/api-response";
import { AuthRequiredError, authenticateRequest } from "@/lib/auth/server";
import { getDb } from "@/lib/db/client";
import { contributions } from "@/lib/db/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const principal = await authenticateRequest(request);
    if (!principal) throw new AuthRequiredError();

    const url = new URL(request.url);
    const rawLimit = url.searchParams.get("limit");
    const rawCursor = url.searchParams.get("cursor");

    let limit = 25;
    if (rawLimit !== null) {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
        return jsonError(400, "validation-error", "limit must be an integer between 1 and 100.");
      }
      limit = parsed;
    }
    let cursor: number | undefined;
    if (rawCursor !== null) {
      const parsed = Number(rawCursor);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return jsonError(400, "validation-error", "cursor must be a positive integer.");
      }
      cursor = parsed;
    }

    const result = contributions(getDb(), principal.user.uid, { limit, cursor });
    return jsonOk(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return mapError(err);
  }
}
