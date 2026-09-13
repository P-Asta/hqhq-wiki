/**
 * /api/pages/[...title] — page source + write APIs (routes.md).
 *
 * - GET    (anon)   `?locale=&rev=` → source + head metadata for the editor.
 * - PUT    (editor) save/create: `{locale, content, comment?, minor?,
 *                   parentRevId, displayTitle?, translatedFromRevId?}`;
 *                   409 → `{error:{code:"edit-conflict", currentRevId}}`.
 * - POST   (editor) `{action:"rollback", toRevId, locale, comment?}` — lives
 *                   here because Next forbids segments after a catch-all.
 * - DELETE (admin)  `?reason=` — db-schema Addendum A6 ordering + audit row.
 *
 * The catch-all carries `nsPrefix+slug` (decisions O1), e.g.
 * `template:infobox-moon`. All writes authenticate per request (stateless
 * Bearer) with `forWrite: true`, which upserts the SQLite users mirror.
 */

import { z } from "zod";

import { jsonError, jsonOk, mapError, readJsonBody } from "@/lib/api-response";
import {
  actorOf,
  authenticateAdminRequest,
  authenticateRequest,
  AuthRequiredError,
} from "@/lib/auth/server";
import type { AuthPrincipal } from "@/lib/auth/types";
import { getDb } from "@/lib/db/client";
import { getPageSource } from "@/lib/db/queries";
import type { Namespace } from "@/lib/db/schema";
import { deletePage } from "@/lib/db/store";
import { humanizeSlug, pathToTitle, slugifyTitle } from "@/lib/title";
import {
  createPageWithParse,
  rollbackWithParse,
  saveEditWithParse,
} from "@/lib/wiki/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ title: string[] }>;
}

interface ResolvedTitle {
  namespace: Namespace;
  slug: string;
}

/** Catch-all segments → storable (namespace, slug); null = invalid title. */
async function resolveTitle(context: RouteContext): Promise<ResolvedTitle | null> {
  const { title } = await context.params;
  const parsed = pathToTitle(title);
  if (!parsed) return null;
  // Slugs are stored lowercase (decisions O1); normalize whatever arrived.
  const slug = slugifyTitle(parsed.slug) || parsed.slug.toLowerCase();
  return { namespace: parsed.nsName as Namespace, slug };
}

/** Editor-level guard: any authenticated, non-banned account (routes.md). */
async function requireEditor(request: Request): Promise<AuthPrincipal> {
  const principal = await authenticateRequest(request, { forWrite: true });
  if (!principal) throw new AuthRequiredError();
  return principal;
}

function invalidTitle(): Response {
  return jsonError(400, "invalid-title", "The request path is not a valid page title.");
}

function pageNotFound(): Response {
  return jsonError(404, "page-not-found", "No page exists at this title.");
}

/* ------------------------------------------------------------------ */
/* GET — source + head info (anon)                                     */
/* ------------------------------------------------------------------ */

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const title = await resolveTitle(context);
    if (!title) return invalidTitle();

    const url = new URL(request.url);
    const locale = url.searchParams.get("locale") ?? "en";
    const revParam = url.searchParams.get("rev");
    const revId = revParam === null ? undefined : Number.parseInt(revParam, 10);
    if (revId !== undefined && !Number.isInteger(revId)) {
      return jsonError(400, "invalid-revision", "The rev parameter must be an integer.");
    }

    const source = getPageSource(getDb(), { ...title, locale, revId });
    if (!source) return pageNotFound();

    const { page, pageLocale, revision, isCurrent } = source;
    return jsonOk({
      page: {
        id: page.id,
        namespace: page.namespace,
        slug: page.slug,
        createdAt: page.createdAt,
      },
      locale,
      pageLocale: pageLocale
        ? {
            id: pageLocale.id,
            locale: pageLocale.locale,
            title: pageLocale.title,
            currentRevId: pageLocale.currentRevId,
            updatedAt: pageLocale.updatedAt,
          }
        : null,
      revision: revision
        ? {
            id: revision.id,
            locale: revision.locale,
            title: revision.title,
            content: revision.content,
            comment: revision.comment,
            isMinor: revision.isMinor,
            authorUid: revision.authorUid,
            authorName: revision.authorName,
            parentRevId: revision.parentRevId,
            translatedFromRevId: revision.translatedFromRevId,
            createdAt: revision.createdAt,
          }
        : null,
      isCurrent,
    });
  } catch (err) {
    return mapError(err);
  }
}

/* ------------------------------------------------------------------ */
/* PUT — save or create (editor)                                       */
/* ------------------------------------------------------------------ */

const putSchema = z.object({
  locale: z.string().min(1).max(20),
  content: z.string().max(400_000),
  comment: z.string().max(500).optional(),
  minor: z.boolean().optional(),
  /** Head the editor loaded; null = creating this locale (or the page). */
  parentRevId: z.number().int().positive().nullable(),
  displayTitle: z.string().min(1).max(255).optional(),
  /** EN basis for a translation; omitted ⇒ derived from the EN head (O4). */
  translatedFromRevId: z.number().int().positive().nullable().optional(),
});

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  try {
    const title = await resolveTitle(context);
    if (!title) return invalidTitle();

    const principal = await requireEditor(request);
    const body = await readJsonBody(request, putSchema);
    const db = getDb();
    const author = actorOf(principal);

    const existing = getPageSource(db, { ...title, locale: body.locale });

    if (!existing) {
      // Red-link target: PUT creates the page (routes.md).
      const result = createPageWithParse({
        db,
        namespace: title.namespace,
        slug: title.slug,
        locale: body.locale,
        title: body.displayTitle ?? humanizeSlug(title.slug),
        content: body.content,
        comment: body.comment,
        isMinor: body.minor,
        translatedFromRevId: body.translatedFromRevId,
        author,
      });
      return jsonOk(
        {
          created: true,
          revId: result.revId,
          pageId: result.pageId,
          locale: result.locale,
          pageLocaleId: result.pageLocaleId,
          versionScoped: result.meta.versionScoped,
          warnings: result.meta.warnings,
        },
        { status: 201 },
      );
    }

    const result = saveEditWithParse({
      db,
      pageId: existing.page.id,
      namespace: title.namespace,
      locale: body.locale,
      title: body.displayTitle ?? existing.pageLocale?.title ?? humanizeSlug(title.slug),
      content: body.content,
      comment: body.comment,
      isMinor: body.minor,
      parentRevId: body.parentRevId,
      translatedFromRevId: body.translatedFromRevId,
      author,
    });
    return jsonOk({
      created: false,
      revId: result.revId,
      pageId: result.pageId,
      locale: result.locale,
      pageLocaleId: result.pageLocaleId,
      versionScoped: result.meta.versionScoped,
      warnings: result.meta.warnings,
    });
  } catch (err) {
    return mapError(err);
  }
}

/* ------------------------------------------------------------------ */
/* POST — rollback action (editor; routes.md catch-all constraint)     */
/* ------------------------------------------------------------------ */

const postSchema = z.object({
  action: z.literal("rollback"),
  toRevId: z.number().int().positive(),
  locale: z.string().min(1).max(20),
  comment: z.string().max(500).optional(),
});

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const title = await resolveTitle(context);
    if (!title) return invalidTitle();

    const principal = await requireEditor(request);
    const body = await readJsonBody(request, postSchema);
    const db = getDb();

    const source = getPageSource(db, { ...title, locale: body.locale });
    if (!source) return pageNotFound();

    const result = rollbackWithParse({
      db,
      pageId: source.page.id,
      namespace: title.namespace,
      pageName: source.pageLocale?.title ?? humanizeSlug(title.slug),
      locale: body.locale,
      targetRevId: body.toRevId,
      actor: actorOf(principal),
      comment: body.comment,
    });
    return jsonOk({
      revId: result.revId,
      pageId: result.pageId,
      locale: result.locale,
      pageLocaleId: result.pageLocaleId,
    });
  } catch (err) {
    return mapError(err);
  }
}

/* ------------------------------------------------------------------ */
/* DELETE — admin only                                                 */
/* ------------------------------------------------------------------ */

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const title = await resolveTitle(context);
    if (!title) return invalidTitle();

    const principal = await authenticateAdminRequest(request, { forWrite: true });
    const db = getDb();

    const source = getPageSource(db, { ...title, locale: "en" });
    if (!source) return pageNotFound();

    const reason = new URL(request.url).searchParams.get("reason") ?? undefined;
    const deleted = deletePage(db, {
      pageId: source.page.id,
      actor: actorOf(principal),
      reason,
    });
    return jsonOk({ deleted: true, namespace: deleted.namespace, slug: deleted.slug });
  } catch (err) {
    return mapError(err);
  }
}
