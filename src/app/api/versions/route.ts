/**
 * /api/versions — the game-version registry as the *editor* needs it
 * (versioning.md §1; docs/engine/visual-editor.md §5.3).
 *
 * GET  → `{ versions, defaultId }`, anonymous. The registry is already public
 *        knowledge — every article renders a selector listing it — so the
 *        editor's version picker reads it without a token, exactly like
 *        `/api/preview` (decisions-v2 O15.1).
 * POST → create one, for any signed-in editor.
 *
 * **Why POST is not admin-only.** High-quota players run every patch, and a
 * page's facts routinely need a boundary at a version the registry has not
 * caught up to yet. Making an editor wait for an admin to register `v71` before
 * they can write "changed in v71" is the wrong trade: the id is validated
 * (`v62`, `v64.1`), it lands as `legacy`, and it is additive — nothing existing
 * changes meaning. Renaming, re-ordering, changing the site default and
 * deleting all stay admin-only in `/api/admin/versions`, which is where the
 * destructive half lives.
 */

import { z } from "zod";

import { jsonError, jsonOk, mapError, readJsonBody } from "@/lib/api-response";
import { actorOf, requirePrincipal } from "@/lib/auth/server";
import { getDb } from "@/lib/db/client";
import { createVersion, listVersions, loadVersionTable } from "@/lib/db/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  try {
    const db = getDb();
    return jsonOk({ versions: listVersions(db), defaultId: loadVersionTable(db).defaultId });
  } catch (err) {
    return mapError(err);
  }
}

// Digit-bounded, not merely shaped: `v` plus 400 digits is still `v\d+`, and
// its ordinal (`major * 1000`) overflows to Infinity — a sort key that outranks
// every real version in a registry every page render reads (versioning.md §1).
// Six major digits is already far past any patch this game will ship.
const VERSION_ID = z
  .string()
  .trim()
  .max(16)
  .regex(/^v\d{1,6}(\.\d{1,4})?$/i, 'Version ids look like "v62" or "v64.1".')
  .transform((value) => value.toLowerCase());

const createSchema = z.object({
  id: VERSION_ID,
  label: z.string().trim().min(1).max(60).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

function isSqliteConstraint(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: unknown }).code;
  return (
    (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) ||
    err.message.includes("UNIQUE constraint failed")
  );
}

export async function POST(request: Request): Promise<Response> {
  try {
    const principal = await requirePrincipal(request, { forWrite: true });

    const body = await readJsonBody(request, createSchema);
    const db = getDb();

    // Idempotent from the picker's point of view: someone typing a version that
    // another editor registered a second ago should get it, not an error.
    const existing = loadVersionTable(db).byId[body.id];
    if (existing) return jsonOk({ version: existing, created: false });

    try {
      // `ordinal` is derived from the id (versioning.md §1: all range math runs
      // on ordinals), and a new id is always `legacy` — promoting it to the
      // site's current version is an admin decision.
      const created = createVersion(db, {
        id: body.id,
        label: body.label,
        notes: body.notes ?? null,
        status: "legacy",
      }, actorOf(principal));
      return jsonOk({ version: created, created: true }, { status: 201 });
    } catch (err) {
      if (isSqliteConstraint(err)) {
        return jsonError(409, "ordinal-conflict", "Another version already has that ordinal.");
      }
      throw err;
    }
  } catch (err) {
    return mapError(err);
  }
}
