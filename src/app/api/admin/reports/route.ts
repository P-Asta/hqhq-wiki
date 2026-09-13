/**
 * /api/admin/reports — the moderation queue (manager-only).
 *
 * GET   → newest-first keyset page of reports, `?status=open` by default
 *         because an open report is the only kind that needs anybody, plus a
 *         uid → { displayName, banned } map so the console can render whoever
 *         is named without a second round trip (the same shape
 *         /api/admin/grants and /api/admin/audit return).
 * PATCH → close one: `{ id, status: "resolved" | "dismissed" }`.
 */

import { inArray } from "drizzle-orm";
import { z } from "zod";

import { jsonError, jsonOk, mapError, readJsonBody } from "@/lib/api-response";
import { actorOf, authenticateManagerRequest } from "@/lib/auth/server";
import { getDb } from "@/lib/db/client";
import { listReports, openReportCount } from "@/lib/db/queries";
import { users } from "@/lib/db/schema";
import { resolveReport } from "@/lib/db/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LIMIT = 200;

export async function GET(request: Request): Promise<Response> {
  try {
    await authenticateManagerRequest(request);
    const url = new URL(request.url);

    const statusParam = url.searchParams.get("status");
    // "all" is the only way to see closed reports; anything else narrows.
    const status =
      statusParam === "all"
        ? undefined
        : statusParam === "resolved" || statusParam === "dismissed"
          ? statusParam
          : ("open" as const);

    // Validated, not coerced. A bad cursor silently meaning "page one" is
    // worse than an error here: the console APPENDS each page, so it would
    // quietly duplicate the first page into the list. /api/admin/audit
    // answers 400 for the same input; these two should not disagree.
    const rawLimit = url.searchParams.get("limit");
    let limit = 50;
    if (rawLimit !== null) {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
        return jsonError(400, "validation-error", `limit must be an integer between 1 and ${MAX_LIMIT}.`);
      }
      limit = parsed;
    }
    const rawCursor = url.searchParams.get("cursor");
    let cursor: number | undefined;
    if (rawCursor !== null) {
      const parsed = Number(rawCursor);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return jsonError(400, "validation-error", "cursor must be a positive integer.");
      }
      cursor = parsed;
    }

    const db = getDb();
    const { rows, nextCursor } = listReports(db, { status, limit, cursor });

    // Everyone a row names: the reported account, the reporter, the closer.
    const uids = [
      ...new Set(
        rows.flatMap((row) =>
          [row.targetUid, row.reporterUid, row.resolvedBy].filter((v): v is string => !!v),
        ),
      ),
    ];
    const nameRows = uids.length
      ? db
          .select({ uid: users.uid, displayName: users.displayName, banned: users.banned })
          .from(users)
          .where(inArray(users.uid, uids))
          .all()
      : [];
    const userMap = Object.fromEntries(
      nameRows.map((row) => [row.uid, { displayName: row.displayName, banned: row.banned }]),
    );

    // The open count regardless of the active filter — the console badges
    // the tab with it, so a manager sees a waiting queue without opening it.
    return jsonOk({ rows, nextCursor, users: userMap, openCount: openReportCount(db) });
  } catch (err) {
    return mapError(err);
  }
}

const resolveSchema = z.object({
  id: z.number().int().positive(),
  status: z.enum(["resolved", "dismissed"]),
});

export async function PATCH(request: Request): Promise<Response> {
  try {
    const principal = await authenticateManagerRequest(request, { forWrite: true });
    const body = await readJsonBody(request, resolveSchema);

    resolveReport(getDb(), {
      id: body.id,
      status: body.status,
      actor: actorOf(principal),
    });

    return jsonOk({ ok: true, id: body.id, status: body.status });
  } catch (err) {
    return mapError(err);
  }
}
