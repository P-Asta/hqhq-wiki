/**
 * POST /api/preview/fragments — the batch sibling of POST /api/preview
 * (visual-editor.md §5). The visual surface draws atomic nodes — templates,
 * infoboxes, tables, galleries — as their real HTML, so a document load needs
 * dozens of tiny renders at once; one round trip beats one request per node.
 *
 * Each fragment goes through the same renderPreview() the live preview uses,
 * and the answer is positional: exactly one html per input index, in order.
 * A fragment that throws yields "" plus a warning instead of failing the batch
 * — §5 renders that node as a labelled chip, and one bad template must not
 * blank an otherwise good page. Its index is also listed in `failed`, because
 * "" is otherwise ambiguous: a version tag outside the previewed version, or a
 * false `{{#if:}}`, renders nothing *correctly*, and the surface must draw
 * those as an empty node rather than as raw wikitext. Identical fragments are
 * rendered once (a page repeating {{Infobox moon}} is the common case) and the
 * result fanned back out to every index that asked for it.
 *
 * PUBLIC — no auth guard, for the same reason as the sibling route
 * (decisions-v2 O15.1): renderPreview() only reads (version table + parse
 * context) and writes nothing, so the only exposure is CPU, and the zod caps
 * below — 64 fragments, 20 KB each, 200 KB in total — are what bound it. The
 * total stays well under the sibling's single-field 400 KB allowance, since a
 * batch fans out into many parses rather than one.
 */

import { z } from "zod";

import { jsonOk, mapError, readJsonBody } from "@/lib/api-response";
import { getDb } from "@/lib/db/client";
import { renderPreview } from "@/lib/wiki/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FRAGMENTS = 64;
const MAX_FRAGMENT_CHARS = 20_000;
const MAX_TOTAL_CHARS = 200_000;

const fragmentsSchema = z.object({
  fragments: z
    .array(z.string().max(MAX_FRAGMENT_CHARS))
    .max(MAX_FRAGMENTS)
    .refine(
      (fragments) =>
        fragments.reduce((total, fragment) => total + fragment.length, 0) <= MAX_TOTAL_CHARS,
      { message: `Fragments exceed ${MAX_TOTAL_CHARS} characters in total.` },
    ),
  title: z.string().min(1).max(255),
  locale: z.string().min(1).max(20),
  version: z.string().max(32).optional(),
});

interface RenderedFragment {
  html: string;
  warnings: readonly string[];
  /**
   * The render threw. Distinct from `html === ""`, which is a perfectly good
   * answer: a version tag outside the version being previewed renders NOTHING
   * (versioning.md §2.1), and so does a `{{#if:}}` whose test is false. The
   * surface draws a failure as the raw wikitext and an empty render as an
   * empty node, so conflating the two showed authors `<v69>aaa</v69>` in a
   * table cell wherever their tag did not apply.
   */
  failed: boolean;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJsonBody(request, fragmentsSchema);
    const db = getDb();

    // Keyed by the fragment source itself: two nodes with byte-identical
    // wikitext render identically, because the parse context is fixed for the
    // whole batch.
    const rendered = new Map<string, RenderedFragment>();
    const htmls: string[] = [];
    // Positional like `htmls`, but sparse by nature — most batches have none —
    // so it travels as the indices that failed rather than a parallel array of
    // booleans the client would have to line up itself.
    const failed: number[] = [];
    const warnings: string[] = [];
    const seenWarnings = new Set<string>();

    for (const fragment of body.fragments) {
      let result = rendered.get(fragment);
      if (!result) {
        result = renderFragment(fragment, body, db);
        rendered.set(fragment, result);
        for (const warning of result.warnings) {
          if (seenWarnings.has(warning)) continue;
          seenWarnings.add(warning);
          warnings.push(warning);
        }
      }
      if (result.failed) failed.push(htmls.length);
      htmls.push(result.html);
    }

    return jsonOk({ htmls, failed, warnings });
  } catch (err) {
    return mapError(err);
  }
}

/** One fragment's render, with a thrown parse contained to that fragment. */
function renderFragment(
  fragment: string,
  body: z.infer<typeof fragmentsSchema>,
  db: ReturnType<typeof getDb>,
): RenderedFragment {
  try {
    const { html, meta } = renderPreview({
      db,
      wikitext: fragment,
      locale: body.locale,
      title: body.title,
      version: body.version ?? null,
    });
    return { html, warnings: meta.warnings, failed: false };
  } catch (err) {
    // Deliberately not rethrown: §5 wants the surviving fragments drawn and
    // this one shown as a chip. The message is diagnostic text for the editor,
    // not chrome copy.
    const reason = err instanceof Error ? err.message : String(err);
    return { html: "", warnings: [`Fragment could not be rendered: ${reason}`], failed: true };
  }
}
