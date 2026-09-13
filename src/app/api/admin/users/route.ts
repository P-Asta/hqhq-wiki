/**
 * GET /api/admin/users?q= — username autocomplete for the admin console.
 *
 * Manager-only, like every other `/api/admin/*` route. Answers a case-
 * insensitive PREFIX search over the authoritative Firestore `usernameLower`
 * field (src/lib/auth/users.ts), capped at USER_SUGGEST_LIMIT rows. A blank
 * query returns an empty list rather than the whole user collection.
 */

import { jsonOk, mapError } from "@/lib/api-response";
import { authenticateManagerRequest, bearerToken } from "@/lib/auth/server";
import { suggestUsers, USER_SUGGEST_LIMIT } from "@/lib/auth/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    await authenticateManagerRequest(request);
    const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
    // Without service-account credentials the search runs as the caller,
    // so it needs their token (Security Rules then decide).
    const users = q ? await suggestUsers(q, USER_SUGGEST_LIMIT, bearerToken(request) ?? undefined) : [];
    return jsonOk({ query: q, users });
  } catch (err) {
    return mapError(err);
  }
}
