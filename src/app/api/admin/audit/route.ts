/**
 * GET /api/admin/audit — keyset-paginated audit log (routes.md).
 *
 * Query: ?limit= (1–200, default 50) & cursor=<last id from prior page>.
 * Response: { rows, nextCursor, users } — `users` maps every uid a row names
 * (its actor, and its target when that is an account) to display
 * names so the client renders names without another round trip.
 */

import { inArray } from "drizzle-orm";

import { jsonError, jsonOk, mapError } from "@/lib/api-response";
import { authenticateManagerRequest } from "@/lib/auth/server";
import { getDb } from "@/lib/db/client";
import { listAuditLog } from "@/lib/db/queries";
import { users } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    await authenticateManagerRequest(request);

    const url = new URL(request.url);
    const rawLimit = url.searchParams.get("limit");
    const rawCursor = url.searchParams.get("cursor");

    let limit = 50;
    if (rawLimit !== null) {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
        return jsonError(400, "validation-error", "limit must be an integer between 1 and 200.");
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

    const db = getDb();
    const { rows, nextCursor } = listAuditLog(db, { limit, cursor });

    // Actors AND the accounts rows are about: a "user:<uid>" target gets an
    // actionable chip in the console, so it needs a name here too. Without
    // it the only clickable name on a "reported an account" row would be the
    // reporter.
    const uids = [
      ...new Set(
        rows.flatMap((row) => [
          row.actorUid,
          row.target.startsWith("user:") ? row.target.slice(5) : "",
        ]),
      ),
    ].filter((uid) => uid !== "");
    const nameRows = uids.length
      ? db
          .select({ uid: users.uid, displayName: users.displayName, banned: users.banned })
          .from(users)
          .where(inArray(users.uid, uids))
          .all()
      : [];
    // Same shape as /api/admin/grants and /api/admin/reports so one actor
    // cell component can serve every tab.
    const userMap = Object.fromEntries(
      nameRows.map((row) => [row.uid, { displayName: row.displayName, banned: row.banned }]),
    );

    return jsonOk({ rows, nextCursor, users: userMap });
  } catch (err) {
    return mapError(err);
  }
}
