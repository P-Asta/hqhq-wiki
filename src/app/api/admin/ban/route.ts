/**
 * POST /api/admin/ban — ban / unban a user (routes.md; decisions O5).
 *
 * Identified BY USERNAME: the console's picker autocompletes real accounts
 * (GET /api/admin/users), and the name is resolved here against the
 * authoritative Firestore `usernameLower` field. A name matching no account —
 * or, deliberately, more than one — is refused rather than guessed at
 * (src/lib/auth/users.ts). Resolving server-side also means the resolved
 * display name is what lands in the SQLite mirror, instead of the uid.
 *
 * O5 dual-write, in this order:
 *   1. Firestore `users/{uid}.banned` — the AUTHORITATIVE flag the auth
 *      pipeline reads on every request;
 *   2. the SQLite `users.banned` moderation-view mirror + audit row, written
 *      by `setUserBanned` in the same admin action.
 *
 * Body: { username, banned, reason? } → { ok, uid, username, banned }.
 */

import { z } from "zod";

import { jsonError, jsonOk, mapError, readJsonBody } from "@/lib/api-response";
import {
  AuthBackendUnavailableError,
  actorOf,
  authenticateManagerRequest,
  bearerToken,
} from "@/lib/auth/server";
import { findUserByUid, findUserByUsername, setFirestoreBanned } from "@/lib/auth/users";
import { getDb } from "@/lib/db/client";
import { setUserBanned } from "@/lib/db/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const banSchema = z.object({
  username: z.string().trim().min(1).max(200),
  banned: z.boolean(),
  reason: z.string().trim().max(500).optional(),
  /**
   * The account the picker actually chose. A username is not a key — two
   * accounts may claim one — so when the picker knows which document it
   * offered, that uid decides and the name is only what gets displayed.
   * Without it an ambiguous name would be unbannable, which is a state a user
   * can arrange for themselves by registering a duplicate.
   */
  uid: z.string().trim().min(1).max(128).optional(),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const principal = await authenticateManagerRequest(request, { forWrite: true });
    const body = await readJsonBody(request, banSchema);
    // Reused for every Firebase call below: without credentials they run as
    // this manager, subject to Security Rules.
    const callerToken = bearerToken(request) ?? undefined;

    let target;
    try {
      target = body.uid
        ? await findUserByUid(body.uid, callerToken)
        : await findUserByUsername(body.username, callerToken);
    } catch (err) {
      const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
      if (code === "FIREBASE_ADMIN_NOT_CONFIGURED") {
        throw new AuthBackendUnavailableError(
          "Firebase Admin credentials are not configured on this server.",
        );
      }
      throw new AuthBackendUnavailableError("Failed to look up that account.");
    }
    if (!target) {
      return jsonError(404, "user-not-found", `No single account is named "${body.username}".`, {
        username: body.username,
      });
    }

    // Mirrors the no-self-revoke rule (store.ts SelfRevokeError): a ban takes
    // effect before every guard, so banning yourself would lock you — and,
    // where you are the only manager, the console — out with no way back.
    if (body.banned && target.uid === principal.user.uid) {
      return jsonError(400, "self-ban", "You cannot ban your own account.", {
        username: target.username,
      });
    }

    // 1. Firestore is authoritative (O5): write it first so a failure never
    //    leaves the mirror claiming a ban the auth pipeline does not enforce.
    try {
      await setFirestoreBanned(target.uid, body.banned, callerToken);
    } catch (err) {
      const code =
        err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
      if (code === "FIREBASE_ADMIN_NOT_CONFIGURED") {
        throw new AuthBackendUnavailableError(
          "Firebase Admin credentials are not configured on this server.",
        );
      }
      // Without credentials this write runs as the manager, so Security Rules
      // can refuse it — say which failure it was rather than "unavailable".
      const status =
        err && typeof err === "object" ? (err as { googleStatus?: unknown }).googleStatus : undefined;
      if (status === "PERMISSION_DENIED") {
        throw new AuthBackendUnavailableError(
          "Firestore rules refused the ban write. Configure Firebase Admin credentials, or " +
            "allow managers to write users/*.banned.",
        );
      }
      throw new AuthBackendUnavailableError("Failed to update the authoritative ban flag.");
    }

    // 2. SQLite mirror + audit row, same action (setUserBanned is one txn).
    setUserBanned(getDb(), {
      uid: target.uid,
      banned: body.banned,
      actor: actorOf(principal),
      reason: body.reason,
      displayName: target.username,
    });

    return jsonOk({ ok: true, uid: target.uid, username: target.username, banned: body.banned });
  } catch (err) {
    return mapError(err);
  }
}
