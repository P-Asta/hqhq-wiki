/**
 * /{locale}/search?q= — full-text results with FTS snippets and O7 "EN"
 * fallback chips. Server-rendered; the SuggestBox island adds debounced
 * title suggestions on top of the plain GET form.
 *
 * decisions-v2 O14.5: when the query has no exact title match, the page shows
 * a prominent "Create <query>" action pointing at that title's ARTICLE url —
 * visiting it opens the editor (O14.1). The suggest dropdown carries the same
 * action as its last entry.
 */

import type { Metadata } from "next";

import { CreatePageAction, SearchResults } from "@/components/wiki/search-results";
import { SuggestBox } from "@/components/wiki/suggest-box";
import { EmptyState } from "@/components/ui/empty-state";
import { ButtonLink } from "@/components/ui/button";
import { getDb } from "@/lib/db/client";
import { search } from "@/lib/db/queries";
import { formatMessage, getDictionary } from "@/lib/i18n";
import { createTargetHref } from "@/lib/wiki/edit-view";

const RESULT_LIMIT = 50;

interface SearchPageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ q?: string | string[] }>;
}

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export async function generateMetadata({ params, searchParams }: SearchPageProps): Promise<Metadata> {
  const { locale: rawLocale } = await params;
  const locale = decodeURIComponent(rawLocale).toLowerCase();
  const query = firstParam((await searchParams).q).trim();
  const dict = getDictionary(locale);
  return {
    title: query ? formatMessage(dict.search.resultsTitle, { query }) : dict.search.label,
  };
}

export default async function SearchPage({ params, searchParams }: SearchPageProps) {
  const { locale: rawLocale } = await params;
  const locale = decodeURIComponent(rawLocale).toLowerCase();
  const query = firstParam((await searchParams).q).trim();
  const dict = getDictionary(locale);

  const db = getDb();
  const results = query ? search(db, query, { locale, limit: RESULT_LIMIT }) : [];
  const createHref = query ? createTargetHref(db, locale, query) : null;
  const createLabel = formatMessage(dict.search.createTitle, { query });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          {query ? formatMessage(dict.search.resultsTitle, { query }) : dict.search.label}
        </h1>
        <SuggestBox
          locale={locale}
          initialQuery={query}
          labels={{
            label: dict.search.label,
            placeholder: dict.search.placeholder,
            submit: dict.search.submit,
            suggestTitle: dict.search.suggestTitle,
            create: dict.search.createSuggest,
          }}
        />
      </div>

      {query ? (
        results.length > 0 ? (
          <section aria-live="polite" className="flex flex-col gap-4">
            {createHref ? (
              <CreatePageAction
                href={createHref}
                label={createLabel}
                description={dict.search.createDescription}
              />
            ) : null}
            <div className="flex flex-col gap-2">
              <p className="text-[13px] text-mute">
                {formatMessage(dict.search.resultCount, { count: results.length })}
              </p>
              <SearchResults
                locale={locale}
                results={results}
                labels={{ enChip: dict.search.enChip }}
              />
            </div>
          </section>
        ) : (
          <EmptyState
            title={dict.search.noResults}
            description={createHref ? dict.search.createDescription : undefined}
            action={
              createHref ? <ButtonLink href={createHref}>{createLabel}</ButtonLink> : undefined
            }
          />
        )
      ) : null}
    </div>
  );
}
