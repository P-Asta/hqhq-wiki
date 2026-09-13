/**
 * GET /api/media/[...name] — stream a stored upload (routes.md; decisions O6).
 *
 * Anonymous. The single path segment is canonicalized and looked up in the
 * `files` table; the binary streams from WIKI_UPLOAD_ROOT with
 * `Cache-Control: public, max-age=31536000, immutable` and `ETag: "<sha1>"`
 * (If-None-Match → 304). Multi-segment paths, traversal attempts, and
 * unknown names all land on 404 — the route never reveals which shape of
 * bad name was tried.
 */

import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { Readable } from "node:stream";

import { jsonError, mapError } from "@/lib/api-response";
import { getDb } from "@/lib/db/client";
import { getFileRecord } from "@/lib/db/store";
import { getWikiEnv } from "@/lib/env";
import { MEDIA_CACHE_CONTROL, canonicalMediaName, resolveMediaPath } from "@/lib/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface MediaRouteContext {
  params: Promise<{ name: string[] }>;
}

function notFound(): Response {
  return jsonError(404, "file-not-found", "No such media file.");
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export async function GET(request: Request, context: MediaRouteContext): Promise<Response> {
  try {
    const { name } = await context.params;
    // Canonical names never contain a separator: any multi-segment path is a
    // traversal attempt by construction.
    if (!Array.isArray(name) || name.length !== 1) return notFound();

    let canonical: string;
    try {
      canonical = canonicalMediaName(decodeSegment(name[0]));
    } catch {
      return notFound();
    }

    const record = getFileRecord(getDb(), canonical);
    if (!record) return notFound();

    const etag = `"${record.sha1}"`;
    const headers = new Headers({
      "Cache-Control": MEDIA_CACHE_CONTROL,
      ETag: etag,
      "Content-Type": record.mime,
    });

    const ifNoneMatch = request.headers.get("if-none-match");
    if (ifNoneMatch && ifNoneMatch.split(",").some((tag) => tag.trim() === etag)) {
      return new Response(null, { status: 304, headers });
    }

    let target: string;
    try {
      target = resolveMediaPath(getWikiEnv().uploadRoot, record.storedPath);
      await fs.access(target);
    } catch {
      // Stale row or a bad stored path — treat both as missing.
      return notFound();
    }

    headers.set("Content-Length", String(record.size));
    const stream = Readable.toWeb(createReadStream(target)) as ReadableStream;
    return new Response(stream, { status: 200, headers });
  } catch (err) {
    return mapError(err);
  }
}
