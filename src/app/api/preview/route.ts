/**
 * POST /api/preview — render unsaved wikitext for the editor's live preview
 * (versioning.md §6: body carries the preview version). Nothing touches
 * parsed_cache; volatile output is fine here, and `preview: true` surfaces
 * version warnings inline (versioning.md §2.6).
 *
 * PUBLIC — no auth guard (decisions-v2 O15.1, superseding routes.md's
 * "editor-only"). renderPreview() only reads (version table + parse context)
 * and writes nothing, so the only exposure is CPU; the 400 KB zod cap on the
 * wikitext field bounds that, exactly as before. Requiring a verified token
 * here is what made the live preview fail with "The preview could not be
 * rendered" on every install without Firebase Admin credentials.
 */

import { z } from "zod";

import { jsonOk, mapError, readJsonBody } from "@/lib/api-response";
import { getDb } from "@/lib/db/client";
import { renderPreview } from "@/lib/wiki/service";
import type { PageMeta } from "@/lib/wikitext/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const previewSchema = z.object({
  wikitext: z.string().max(400_000),
  title: z.string().min(1).max(255),
  locale: z.string().min(1).max(20),
  version: z.string().max(32).optional(),
});

/** The JSON-safe subset of PageMeta the editor consumes. */
function serializeMeta(meta: PageMeta) {
  return {
    displayTitle: meta.displayTitle ?? null,
    categories: meta.categories,
    warnings: meta.warnings,
    versionScoped: meta.versionScoped,
    versionBoundaries: meta.versionBoundaries,
    volatile: meta.volatile,
  };
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJsonBody(request, previewSchema);
    const { html, meta } = renderPreview({
      db: getDb(),
      wikitext: body.wikitext,
      locale: body.locale,
      title: body.title,
      version: body.version ?? null,
    });
    return jsonOk({ html, meta: serializeMeta(meta) });
  } catch (err) {
    return mapError(err);
  }
}
