/**
 * POST /api/media — multipart upload (routes.md; decisions O6).
 *
 * Auth: editor (valid Bearer token, not banned); the SQLite users mirror is
 * upserted as part of authentication (forWrite). Body: multipart/form-data
 * with a `file` field and an optional `name` field overriding the filename.
 *
 * The binary is written to WIKI_UPLOAD_ROOT under its canonical name and a
 * `files` row is upserted (same-name re-upload replaces the file). Response:
 * `{ file: { …row, src: "/api/media/<canonical>" } }`.
 *
 * GET /api/media — list uploads, newest first, for the editor's media dialog
 * (visual-editor.md §5.2). Anonymous, because every file it names is already
 * served anonymously by `/api/media/[...name]`; listing them reveals nothing
 * the articles do not.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { jsonOk, mapError } from "@/lib/api-response";
import { actorOf, AuthRequiredError, authenticateRequest } from "@/lib/auth/server";
import { getDb } from "@/lib/db/client";
import { listFiles } from "@/lib/db/queries";
import { upsertFile } from "@/lib/db/store";
import { getWikiEnv } from "@/lib/env";
import {
  MEDIA_MAX_BYTES,
  MediaError,
  resolveMediaPath,
  validateUpload,
} from "@/lib/media";
import { MEDIA_PATH } from "@/lib/wiki/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The dialog shows a grid; a longer list is a sign to type a filter. */
const MAX_LISTED = 40;

export function GET(request: Request): Response {
  try {
    const url = new URL(request.url);
    const query = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
    const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    const limit =
      Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_LISTED) : MAX_LISTED;

    const files = listFiles(getDb(), { query, limit }).map((file) => ({
      ...file,
      src: `${MEDIA_PATH}${encodeURIComponent(file.filename)}`,
    }));
    return jsonOk({ query, files });
  } catch (err) {
    return mapError(err);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const principal = await authenticateRequest(request, { forWrite: true });
    if (!principal) throw new AuthRequiredError();

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new MediaError(
        400,
        "invalid-form",
        'Expected multipart/form-data with a "file" field.',
      );
    }

    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new MediaError(400, "missing-file", 'The "file" form field is required.');
    }
    if (file.size > MEDIA_MAX_BYTES) {
      throw new MediaError(413, "payload-too-large", `Uploads are limited to ${MEDIA_MAX_BYTES} bytes.`);
    }

    const nameField = form.get("name");
    const rawName = typeof nameField === "string" && nameField.trim() ? nameField : file.name;

    const bytes = new Uint8Array(await file.arrayBuffer());
    const upload = validateUpload({ filename: rawName, bytes });

    const { uploadRoot } = getWikiEnv();
    const target = resolveMediaPath(uploadRoot, upload.filename);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);

    const record = upsertFile(getDb(), {
      filename: upload.filename,
      storedPath: upload.filename,
      mime: upload.mime,
      size: upload.size,
      sha1: upload.sha1,
      // Without these the row is 0x0 and every "Full size" placement renders
      // an invisible `width="0"` image (visual-editor.md §5.2).
      width: upload.width,
      height: upload.height,
      uploaderUid: principal.user.uid,
    }, actorOf(principal));

    return jsonOk(
      { file: { ...record, src: `${MEDIA_PATH}${encodeURIComponent(record.filename)}` } },
      { status: 201 },
    );
  } catch (err) {
    return mapError(err);
  }
}
