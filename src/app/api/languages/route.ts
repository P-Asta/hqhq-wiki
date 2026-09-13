/**
 * /api/languages — content-language registry (routes.md).
 *
 * GET   anon    → full registry (active + proposed).
 * POST  editor  → propose a new language (lands as status "proposed").
 * PATCH admin   → activate / deactivate (status flips, audit-logged in
 *                 store.setLanguageStatus).
 *
 * Every authenticated write upserts the SQLite users mirror via
 * `authenticate*Request({ forWrite: true })` (routes.md preamble).
 */

import { z } from "zod";

import { jsonError, jsonOk, mapError, readJsonBody } from "@/lib/api-response";
import {
  actorOf,
  authenticateAdminRequest,
  authenticateRequest,
  AuthRequiredError,
} from "@/lib/auth/server";
import { getDb } from "@/lib/db/client";
import { createLanguage, getLanguage, listLanguages, setLanguageStatus } from "@/lib/db/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** BCP-47-ish primary subtag + optional subtags, lowercased ("ko", "zh-hans"). */
const LANGUAGE_CODE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/;

const proposeSchema = z.object({
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(LANGUAGE_CODE, "Not a valid language code (e.g. `ko`, `zh-hans`)."),
  label: z.string().trim().min(1).max(64),
  nativeName: z.string().trim().min(1).max(64),
  direction: z.enum(["ltr", "rtl"]).optional(),
});

const statusSchema = z.object({
  code: z.string().trim().toLowerCase().regex(LANGUAGE_CODE),
  status: z.enum(["active", "proposed"]),
});

export function GET(): Response {
  try {
    return jsonOk({ languages: listLanguages(getDb()) });
  } catch (err) {
    return mapError(err);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const principal = await authenticateRequest(request, { forWrite: true });
    if (!principal) throw new AuthRequiredError();

    const body = await readJsonBody(request, proposeSchema);
    const db = getDb();
    if (getLanguage(db, body.code)) {
      return jsonError(409, "language-exists", `Language "${body.code}" is already registered.`);
    }
    const language = createLanguage(db, {
      code: body.code,
      label: body.label,
      nativeName: body.nativeName,
      direction: body.direction,
      status: "proposed",
      createdBy: principal.user.uid,
    }, actorOf(principal));
    return jsonOk({ language }, { status: 201 });
  } catch (err) {
    return mapError(err);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    const principal = await authenticateAdminRequest(request, { forWrite: true });
    const body = await readJsonBody(request, statusSchema);
    const language = setLanguageStatus(getDb(), body.code, body.status, actorOf(principal));
    return jsonOk({ language });
  } catch (err) {
    return mapError(err);
  }
}
