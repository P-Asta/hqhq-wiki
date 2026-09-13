/**
 * POST /api/reports — file a report about another account.
 *
 * **The one moderation action an ordinary editor has.** Banning is a
 * manager's; reporting is everyone's, so this route is guarded by
 * `requirePrincipal` and nothing stricter. The report lands in its own queue
 * (`/api/admin/reports`) and, because filing one is itself an action, also in
 * the audit timeline.
 *
 * The target is named by uid, and **must already be an account this wiki has
 * seen act** — it is looked up in the `users` mirror and refused if absent.
 * That check is what keeps the uid from being a write primitive: without it,
 * any signed-in editor could POST an invented uid and a display name of their
 * choosing, and the report would conjure a `users` row to hang it on. Repeated,
 * that is unbounded rows naming a phantom "asta" that no manager can ban,
 * because no such account exists in Firestore to ban.
 *
 * The name is deliberately NOT taken from the request. Whoever the mirror
 * already says this uid is, is who the queue names.
 *
 * Body: { targetUid, reason?, context? } → { ok, id }.
 */

import { eq } from "drizzle-orm";
import { z } from "zod";

import { jsonError, jsonOk, mapError, readJsonBody } from "@/lib/api-response";
import { actorOf, requirePrincipal } from "@/lib/auth/server";
import { getDb } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { fileReport } from "@/lib/db/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const reportSchema = z.object({
  targetUid: z.string().trim().min(1).max(128),
  reason: z.string().trim().max(1000).optional(),
  /** Where it happened, e.g. "revision:1841" or "page:main/titan". */
  context: z.string().trim().max(200).optional(),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const principal = await requirePrincipal(request, { forWrite: true });
    const body = await readJsonBody(request, reportSchema);

    // Reporting yourself is not a moderation request, it is a mistake.
    if (body.targetUid === principal.user.uid) {
      return jsonError(400, "self-report", "You cannot report your own account.");
    }

    const db = getDb();
    const target = db.select().from(users).where(eq(users.uid, body.targetUid)).get();
    if (!target) {
      return jsonError(404, "user-not-found", "That account is not one this wiki knows.", {
        uid: body.targetUid,
      });
    }

    const created = fileReport(db, {
      targetUid: target.uid,
      reporter: actorOf(principal),
      reason: body.reason,
      context: body.context,
    });

    return jsonOk({ ok: true, id: created.id }, { status: 201 });
  } catch (err) {
    return mapError(err);
  }
}
