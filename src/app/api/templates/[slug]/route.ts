/**
 * GET /api/templates/{slug} — what the template dialog needs to draw a form
 * for one template (docs/engine/visual-editor.md §5.1).
 *
 * The parameter list is derived from the template's own wikitext by
 * `templateSpec()` (src/lib/visual-editor/template-params.ts): every
 * `{{{name|default}}}` in body order, enriched by a `<templatedata>` block when
 * the author wrote one. Deriving it here rather than in the browser keeps the
 * template body — which can be several kilobytes of table markup — off the
 * wire; the dialog only ever needs the shape.
 *
 * Anonymous, like the rest of the read side (decisions-v2 O15.1).
 */

import { jsonError, jsonOk, mapError } from "@/lib/api-response";
import { getDb } from "@/lib/db/client";
import { getPageSource } from "@/lib/db/queries";
import { slugifyTitle } from "@/lib/title";
import { templateSpec, type TemplateSpec } from "@/lib/visual-editor/template-params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Bodies larger than this are reported as undocumented instead of being read.
 * A template is markup for a form — the seeded infoboxes are a couple of
 * kilobytes — while a revision may hold 400 000 characters, and this route is
 * anonymous (decisions-v2 O15.1) and synchronous on Node's one thread. Refusing
 * the outsized body keeps a planted template from being a lever anyone can pull
 * to stall the whole wiki.
 */
const MAX_INTROSPECTED_CHARS = 64 * 1024;

interface RouteContext {
  params: Promise<{ slug: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { slug: raw } = await context.params;
    // The dialog addresses a template the way an author writes it — "Infobox
    // moon" or "Infobox_moon" — so the identity rule (decisions O1) is applied
    // here rather than asking the caller to slugify.
    const slug = slugifyTitle(decodeURIComponent(raw));
    if (slug === "") return jsonError(400, "bad-request", "A template name is required.");

    const url = new URL(request.url);
    const locale = (url.searchParams.get("locale") ?? "en").trim().toLowerCase() || "en";

    const db = getDb();
    const localized = getPageSource(db, { namespace: "template", slug, locale });
    // A template usually only has an EN head — the parameter names come from
    // the body, which is shared, so falling back keeps the form usable while a
    // translation is missing (decisions O4).
    const english =
      locale === "en" ? localized : getPageSource(db, { namespace: "template", slug, locale: "en" });

    const revision = localized?.revision ?? english?.revision ?? null;
    if (revision === null) {
      return jsonError(404, "not-found", "That template does not exist.");
    }

    const spec: TemplateSpec =
      revision.content.length > MAX_INTROSPECTED_CHARS
        ? { description: null, params: [], documented: false }
        : templateSpec(revision.content);
    return jsonOk({
      slug,
      title: localized?.pageLocale?.title ?? english?.pageLocale?.title ?? slug,
      description: spec.description,
      documented: spec.documented,
      params: spec.params,
    });
  } catch (err) {
    return mapError(err);
  }
}
