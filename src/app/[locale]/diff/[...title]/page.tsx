/**
 * /{locale}/diff/[...title]?from=<revId>&to=<revId> — revision comparison
 * (routes.md): side-by-side layout with inline word-level highlights from
 * src/lib/diff.ts. `from` may be omitted — it defaults to the parent of `to`
 * (page creation diffs against the empty document).
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ButtonLink } from "@/components/ui/button";
import { StatusBanner } from "@/components/ui/status-banner";
import { DiffView } from "@/components/wiki/diff-view";
import { getDb } from "@/lib/db/client";
import { getDiffPair, getPageSource } from "@/lib/db/queries";
import type { Namespace } from "@/lib/db/schema";
import { diffLines, hasChanges } from "@/lib/diff";
import { dateTimeFormat, formatMessage, getDictionary } from "@/lib/i18n";
import { titlePathSegment, titleRouteHref } from "@/lib/locale-path";
import { pathToTitle, slugifyTitle } from "@/lib/title";

interface DiffPageProps {
  params: Promise<{ locale: string; title: string[] }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}

function resolveTitle(segments: string[]) {
  const parsed = pathToTitle(segments);
  if (!parsed) return null;
  const slug = slugifyTitle(parsed.slug) || parsed.slug.toLowerCase();
  return {
    namespace: parsed.nsName as Namespace,
    slug,
    titlePath: titlePathSegment(parsed.nsName, slug),
  };
}

function parseRevId(value: string | undefined): number | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export async function generateMetadata({ params }: DiffPageProps): Promise<Metadata> {
  const { locale: rawLocale } = await params;
  const dict = getDictionary(decodeURIComponent(rawLocale).toLowerCase());
  return { title: dict.diff.title };
}

interface RevisionMetaProps {
  label: string;
  authorName: string | null;
  createdAt: Date | null;
  comment: string | null;
  isMinor: boolean;
  minorBadge: string;
  locale: string;
}

function RevisionMeta({
  label,
  authorName,
  createdAt,
  comment,
  isMinor,
  minorBadge,
  locale,
}: RevisionMetaProps) {
  const dateFormat = dateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  return (
    <div className="min-w-0 flex-1 rounded-[var(--radius-md)] border border-hairline bg-surface p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-sm font-semibold text-ink">{label}</span>
        {isMinor ? (
          <span className="rounded-full border border-hairline bg-canvas-soft px-1.5 py-0.5 font-mono text-[11px] text-mute">
            {minorBadge}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-[13px] text-mute">
        {authorName ?? "—"}
        {createdAt ? ` · ${dateFormat.format(createdAt)}` : null}
      </p>
      {comment ? <p className="mt-1 truncate text-[13px] text-body">{comment}</p> : null}
    </div>
  );
}

export default async function DiffPage({ params, searchParams }: DiffPageProps) {
  const [{ locale: rawLocale, title }, sp] = await Promise.all([params, searchParams]);
  const locale = decodeURIComponent(rawLocale).toLowerCase();
  const resolved = resolveTitle(title);
  if (!resolved) notFound();

  const db = getDb();
  const dict = getDictionary(locale);

  const source = getPageSource(db, {
    namespace: resolved.namespace,
    slug: resolved.slug,
    locale,
  });
  if (!source) notFound();

  const toId = parseRevId(sp.to);
  const fromId = parseRevId(sp.from);
  if (toId === undefined) notFound();

  const pair = getDiffPair(db, toId, fromId);
  if (!pair) notFound();
  // Guard: both revisions must belong to the page in the path.
  if (pair.rev.pageId !== source.page.id) notFound();
  if (pair.base && pair.base.pageId !== source.page.id) notFound();

  const rows = diffLines(pair.base?.content ?? "", pair.rev.content);
  const fromLabel = pair.base ? `r${pair.base.id}` : "—";
  const toLabel = `r${pair.rev.id}`;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-[-0.04em] text-ink">
          {dict.diff.title}
        </h1>
        <ButtonLink
          href={titleRouteHref(locale, "history", resolved.titlePath)}
          variant="secondary"
          size="sm"
        >
          {dict.diff.backToHistory}
        </ButtonLink>
      </div>
      <p className="mb-6 text-sm text-mute">
        {formatMessage(dict.diff.comparing, { from: fromLabel, to: toLabel })}
      </p>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row">
        <RevisionMeta
          label={fromLabel}
          authorName={pair.base?.authorName ?? null}
          createdAt={pair.base?.createdAt ?? null}
          comment={pair.base?.comment ?? null}
          isMinor={pair.base?.isMinor ?? false}
          minorBadge={dict.history.minorBadge}
          locale={locale}
        />
        <RevisionMeta
          label={toLabel}
          authorName={pair.rev.authorName}
          createdAt={pair.rev.createdAt}
          comment={pair.rev.comment}
          isMinor={pair.rev.isMinor}
          minorBadge={dict.history.minorBadge}
          locale={locale}
        />
      </div>

      {hasChanges(rows) ? (
        <DiffView rows={rows} leftLabel={fromLabel} rightLabel={toLabel} />
      ) : (
        <StatusBanner tone="info">{dict.diff.noChanges}</StatusBanner>
      )}
    </div>
  );
}
