/**
 * /api/admin/grants — admin-grant registry (routes.md; db-schema Addendum A1).
 *
 * GET    → { grants, users } — every grant row plus a uid→display-name map.
 * POST   → { uid, displayName? } grants admin (idempotent; audit row in-txn).
 * DELETE → { uid } revokes every active grant (no self-revoke → 400).
 *
 * All admin-only (authenticateManagerRequest). Mutations authenticate forWrite
 * so the actor's users-mirror row exists before the store writes audit rows.
 */

import { inArray } from "drizzle-orm";
import { z } from "zod";

import { jsonOk, mapError, readJsonBody } from "@/lib/api-response";
import { actorOf, authenticateManagerRequest } from "@/lib/auth/server";
import { getDb } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { grantAdmin, listGrants, revokeAdmin } from "@/lib/db/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    await authenticateManagerRequest(request);
    const db = getDb();
    const grants = listGrants(db);

    const uids = [
      ...new Set(
        grants.flatMap((g) => [g.uid, g.grantedBy, g.revokedBy].filter((v): v is string => !!v)),
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

    return jsonOk({ grants, users: userMap });
  } catch (err) {
    return mapError(err);
  }
}

const grantSchema = z.object({
  uid: z.string().trim().min(1).max(128),
  displayName: z.string().trim().min(1).max(200).optional(),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const principal = await authenticateManagerRequest(request, { forWrite: true });
    const body = await readJsonBody(request, grantSchema);
    const grant = grantAdmin(getDb(), {
      uid: body.uid,
      grantedBy: actorOf(principal),
      displayName: body.displayName,
    });
    return jsonOk({ grant }, { status: 201 });
  } catch (err) {
    return mapError(err);
  }
}

const revokeSchema = z.object({ uid: z.string().trim().min(1).max(128) });

export async function DELETE(request: Request): Promise<Response> {
  try {
    const principal = await authenticateManagerRequest(request, { forWrite: true });
    const body = await readJsonBody(request, revokeSchema);
    revokeAdmin(getDb(), { uid: body.uid, revokedBy: actorOf(principal) });
    return jsonOk({ ok: true, uid: body.uid });
  } catch (err) {
    return mapError(err);
  }
}
