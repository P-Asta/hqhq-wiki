/**
 * /api/admin/versions — game-version registry CRUD (versioning.md §1/§6).
 *
 * GET    → { versions, defaultId }
 * POST   → create { id, label?, ordinal?, releasedAt?, notes?, status? };
 *          duplicate id → 409 version-exists, ordinal collision → 409
 *          ordinal-conflict. Registry changes flush the render cache (§4).
 * PATCH  → update { id, …patch, default?: true }; `default: true` also sets
 *          site_settings.default_version (which flushes the cache).
 * DELETE → { id }; refused with 409 `version-in-use` + the referencing page
 *          list while any page_locales.version_boundaries still names the id
 *          (deleteVersion in the store performs the check).
 */

import { z } from "zod";

import { jsonError, jsonOk, mapError, readJsonBody } from "@/lib/api-response";
import { actorOf, authenticateManagerRequest } from "@/lib/auth/server";
import { getDb } from "@/lib/db/client";
import {
  DEFAULT_VERSION_KEY,
  VersionMissingError,
  createVersion,
  deleteVersion,
  listVersions,
  loadVersionTable,
  setSetting,
  updateVersion,
} from "@/lib/db/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    await authenticateManagerRequest(request);
    const db = getDb();
    return jsonOk({ versions: listVersions(db), defaultId: loadVersionTable(db).defaultId });
  } catch (err) {
    return mapError(err);
  }
}

const VERSION_ID = z
  .string()
  .trim()
  .regex(/^v\d+(\.\d+)?$/i, 'Version ids look like "v62" or "v64.1".')
  .transform((value) => value.toLowerCase());

const createSchema = z.object({
  id: VERSION_ID,
  label: z.string().trim().min(1).max(60).optional(),
  ordinal: z.number().int().min(0).optional(),
  releasedAt: z.number().int().min(0).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  status: z.enum(["current", "supported", "legacy"]).optional(),
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
    const principal = await authenticateManagerRequest(request, { forWrite: true });
    const body = await readJsonBody(request, createSchema);
    const db = getDb();

    if (loadVersionTable(db).byId[body.id]) {
      return jsonError(409, "version-exists", `Version ${body.id} already exists.`);
    }

    try {
      const created = createVersion(db, {
        id: body.id,
        label: body.label,
        ordinal: body.ordinal,
        releasedAt: body.releasedAt != null ? new Date(body.releasedAt) : null,
        notes: body.notes ?? null,
        status: body.status,
      }, actorOf(principal));
      return jsonOk({ version: created }, { status: 201 });
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

const patchSchema = z.object({
  id: VERSION_ID,
  label: z.string().trim().min(1).max(60).optional(),
  ordinal: z.number().int().min(0).optional(),
  releasedAt: z.number().int().min(0).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  status: z.enum(["current", "supported", "legacy"]).optional(),
  /** true → also make this the site default (versioning.md §6). */
  default: z.boolean().optional(),
});

export async function PATCH(request: Request): Promise<Response> {
  try {
    const principal = await authenticateManagerRequest(request, { forWrite: true });
    const body = await readJsonBody(request, patchSchema);
    const db = getDb();

    const hasFieldPatch =
      body.label !== undefined ||
      body.ordinal !== undefined ||
      body.releasedAt !== undefined ||
      body.notes !== undefined ||
      body.status !== undefined;

    let version;
    if (hasFieldPatch) {
      try {
        version = updateVersion(db, body.id, {
          label: body.label,
          ordinal: body.ordinal,
          releasedAt:
            body.releasedAt === undefined
              ? undefined
              : body.releasedAt === null
                ? null
                : new Date(body.releasedAt),
          notes: body.notes,
          status: body.status,
        }, actorOf(principal));
      } catch (err) {
        if (isSqliteConstraint(err)) {
          return jsonError(409, "ordinal-conflict", "Another version already has that ordinal.");
        }
        throw err;
      }
    } else {
      const existing = loadVersionTable(db).byId[body.id];
      if (!existing) throw new VersionMissingError(body.id);
      version = listVersions(db).find((row) => row.id === body.id);
    }

    if (body.default === true) {
      // setSetting(default_version) flushes the render cache (§4).
      setSetting(db, DEFAULT_VERSION_KEY, body.id, principal.user.uid, actorOf(principal));
    }

    return jsonOk({ version, defaultId: loadVersionTable(db).defaultId });
  } catch (err) {
    return mapError(err);
  }
}

const deleteSchema = z.object({ id: VERSION_ID });

export async function DELETE(request: Request): Promise<Response> {
  try {
    const principal = await authenticateManagerRequest(request, { forWrite: true });
    const body = await readJsonBody(request, deleteSchema);
    // VersionInUseError (409 version-in-use) carries `referencedBy`, which
    // mapError spreads into the error body for the client to render.
    deleteVersion(getDb(), body.id, actorOf(principal));
    return jsonOk({ ok: true, id: body.id });
  } catch (err) {
    return mapError(err);
  }
}
