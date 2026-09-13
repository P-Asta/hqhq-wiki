/**
 * /{locale}/edit/[...title] — create-or-edit view (routes.md).
 *
 * Server component: everything it needs comes from `loadEditorView`
 * (src/lib/wiki/edit-view.ts) — the source for the route locale (prefilling
 * from the EN head for a new translation, decisions O4) and the version
 * registry for the preview dropdown. The missing-article branch of
 * `/{locale}/wiki/[...title]` calls the *same* loader (decisions-v2 O14.6), so
 * a title nobody has written yet renders identical editor state either way,
 * and `/edit` stays the canonical edit URL (O14.3).
 *
 * The interactive editor itself is the <Editor> client island (anon =
 * read-only source + sign-in CTA, since auth is a stateless Bearer flow the
 * server never sees).
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import { Editor } from "@/components/wiki/editor";
import { getDb } from "@/lib/db/client";
import { getDictionary } from "@/lib/i18n";
import { editorHeading, editorLabels, loadEditorView } from "@/lib/wiki/edit-view";
import { firstParam, type RawSearchParams } from "@/lib/wiki/read-view";

interface EditPageProps {
  params: Promise<{ locale: string; title: string[] }>;
  /** `?v=` rides along from the article into the editor (versioning.md §6). */
  searchParams: Promise<RawSearchParams>;
}

/** One load shared by generateMetadata and the page body within a request. */
const getView = cache((locale: string, titlePath: string, version: string | null) =>
  loadEditorView({ db: getDb(), locale, segments: titlePath, version }),
);

async function resolve({ params, searchParams }: EditPageProps) {
  const [{ locale: rawLocale, title }, rawSearch] = await Promise.all([params, searchParams]);
  const locale = decodeURIComponent(rawLocale).toLowerCase();
  const view = getView(locale, title.join("/"), firstParam(rawSearch, "v") ?? null);
  return { locale, view };
}

export async function generateMetadata(props: EditPageProps): Promise<Metadata> {
  const { locale, view } = await resolve(props);
  const dict = getDictionary(locale);
  if (!view) return { title: dict.errors.notFoundTitle };
  return { title: editorHeading(dict, view) };
}

export default async function EditPage(props: EditPageProps) {
  const { locale, view } = await resolve(props);
  if (!view) notFound();

  return (
    // Wider than an article page: the editor carries a right rail, and in
    // Split view the source and the preview sit side by side.
    <div className="mx-auto w-full max-w-[96rem] px-4 py-8">
      <Editor
        locale={locale}
        titlePath={view.title.titlePath}
        displayTitle={view.displayTitle}
        previewTitle={view.previewTitle}
        initialContent={view.initialContent}
        initialParentRevId={view.parentRevId}
        translatedFromRevId={view.translatedFromRevId}
        versions={view.versions}
        defaultVersion={view.defaultVersion}
        selectedVersion={view.selectedVersion}
        labels={editorLabels(getDictionary(locale), view)}
      />
    </div>
  );
}
