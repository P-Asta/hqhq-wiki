"use client";

/**
 * Profile island (/[locale]/profile): the server-resolved principal from
 * useAuth (name, roles, ban state), a sign-out action, and the caller's
 * contribution history from GET /api/profile/contributions (keyset-paged).
 */

/* eslint-disable @next/next/no-img-element -- avatar URLs are external Firebase photo URLs */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAuth } from "@/components/auth-provider";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBanner } from "@/components/ui/status-banner";
import { formatMessage } from "@/lib/i18n";
import { articleHref, homeHref, localePath } from "@/lib/locale-path";
import { ROLE_META, roleLabel, sortRoles, type RoleId } from "@/lib/roles";
import type { StorableNamespace } from "@/lib/title";

export interface ProfileViewLabels {
  title: string;
  loading: string;
  signInToViewProfile: string;
  signIn: string;
  signOut: string;
  accountIdLabel: string;
  rolesLabel: string;
  /** Role display names from the dictionary, keyed by stored identifier. */
  roleNames: Partial<Record<RoleId, string>>;
  bannedBadge: string;
  bannedNotice: string;
  contributionsTitle: string;
  contributionsEmpty: string;
  loadMore: string;
  /** "{message}" interpolated. */
  loadFailed: string;
  columnDate: string;
  columnSummary: string;
  minorBadge: string;
}

interface ContributionRow {
  revId: number;
  locale: string;
  title: string;
  comment: string | null;
  isMinor: boolean;
  createdAt: string;
  namespace: string;
  slug: string;
  pageId: number;
}

interface ContributionsResponse {
  rows: ContributionRow[];
  nextCursor: number | null;
}

export interface ProfileViewProps {
  locale: string;
  labels: ProfileViewLabels;
}

export function ProfileView({ locale, labels }: ProfileViewProps) {
  const { loading, user, profile, display, signOut, getIdToken } = useAuth();
  const router = useRouter();

  const [rows, setRows] = useState<ContributionRow[] | null>(null);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const uid = user?.uid ?? null;

  const load = useCallback(
    async (cursor?: number) => {
      if (!uid) return;
      const token = await getIdToken();
      if (!token) return;
      setBusy(true);
      setError(null);
      try {
        const query = cursor === undefined ? "" : `?cursor=${cursor}`;
        const res = await fetch(`/api/profile/contributions${query}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        const body = (await res.json()) as
          | ContributionsResponse
          | { error: { code: string; message: string } };
        if (!res.ok || "error" in body) {
          throw new Error("error" in body ? body.error.message : `Request failed (${res.status}).`);
        }
        setRows((prev) => (cursor === undefined || !prev ? body.rows : [...prev, ...body.rows]));
        setNextCursor(body.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [uid, getIdToken],
  );

  // load(undefined) replaces rows wholesale, so a uid change (sign-in or
  // account switch) refreshes the list; the ref keeps this to one fetch per uid.
  const loadedForUidRef = useRef<string | null>(null);

  useEffect(() => {
    if (!uid || loadedForUidRef.current === uid) return;
    loadedForUidRef.current = uid;
    void load();
  }, [uid, load]);

  if (loading) {
    return (
      <div aria-busy="true" className="space-y-3 py-8">
        <span className="sr-only">{labels.loading}</span>
        <div className="h-24 animate-pulse rounded-[var(--radius-lg)] bg-canvas-soft" />
        <div className="h-40 animate-pulse rounded-[var(--radius-lg)] bg-canvas-soft" />
      </div>
    );
  }

  if (!user) {
    return (
      <EmptyState
        title={labels.title}
        description={labels.signInToViewProfile}
        action={<ButtonLink href={localePath(locale, "/login")}>{labels.signIn}</ButtonLink>}
      />
    );
  }

  // `display` resolves even when the server could not verify the session, so
  // your own profile page still names you rather than falling back to a uid.
  const displayName = display?.name ?? user.uid;
  const avatar = display?.picture ?? null;
  const roles = display?.roles ?? [];
  const banned = profile?.banned === true;

  // Contributions come back as JSON, so the namespace arrives as a plain
  // string; every row is a storable page (queries.ts joins `pages`).
  const pagePath = (row: ContributionRow) =>
    articleHref(row.locale, row.namespace as StorableNamespace, row.slug);

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-wrap items-center gap-4">
          {avatar ? (
            <img
              src={avatar}
              alt=""
              className="size-14 rounded-full border border-hairline object-cover"
            />
          ) : (
            <span className="flex size-14 items-center justify-center rounded-full bg-canvas-soft-2 font-mono text-lg text-mute">
              {displayName.slice(0, 1).toUpperCase()}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <CardTitle className="flex items-center gap-2">
              <span className="truncate">{displayName}</span>
              {banned ? (
                <span className="rounded-full border border-error/40 bg-error-soft px-2 py-0.5 text-[11px] font-normal text-error">
                  {labels.bannedBadge}
                </span>
              ) : null}
            </CardTitle>
            <p className="mt-1 text-[13px] text-mute">
              {labels.accountIdLabel}: <span className="font-mono">{user.uid}</span>
            </p>
            <p className="mt-0.5 text-[13px] text-mute">
              {labels.rolesLabel}:{" "}
              {sortRoles(roles).length ? (
                sortRoles(roles).map((role) => (
                  <span
                    key={role}
                    style={{ color: `var(${ROLE_META[role].colorVar})` }}
                    className="mr-1 rounded-full border border-hairline px-2 py-0.5 text-[11px] font-medium"
                  >
                    {roleLabel(role, labels.roleNames)}
                  </span>
                ))
              ) : (
                <span className="text-faint">—</span>
              )}
            </p>
          </div>
          <Button
            variant="secondary"
            onClick={() => {
              void signOut().then(() => router.push(homeHref(locale)));
            }}
          >
            {labels.signOut}
          </Button>
        </div>
        {banned ? (
          <StatusBanner tone="error" className="mt-4">
            {labels.bannedNotice}
          </StatusBanner>
        ) : null}
      </Card>

      <section>
        <h2 className="mb-3 text-lg font-semibold tracking-[-0.02em] text-ink">
          {labels.contributionsTitle}
        </h2>

        {error ? (
          <StatusBanner tone="error" className="mb-3">
            {formatMessage(labels.loadFailed, { message: error })}
          </StatusBanner>
        ) : null}

        {rows && rows.length === 0 ? (
          <EmptyState title={labels.contributionsEmpty} />
        ) : rows ? (
          <div className="space-y-3">
            <div className="overflow-x-auto rounded-[var(--radius-md)] border border-hairline">
              <table className="w-full text-sm">
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.revId} className="border-b border-hairline last:border-b-0">
                      <td className="px-3 py-2">
                        <Link href={pagePath(row)} className="text-link hover:underline">
                          {row.title}
                        </Link>{" "}
                        <span className="font-mono text-[11px] text-faint">{row.locale}</span>
                        {row.isMinor ? (
                          <span className="ml-2 rounded-full border border-hairline px-1.5 py-0.5 font-mono text-[10px] text-mute">
                            {labels.minorBadge}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-mute">{row.comment || ""}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-[12px] text-mute">
                        {new Date(row.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {nextCursor !== null ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => void load(nextCursor)}
              >
                {labels.loadMore}
              </Button>
            ) : null}
          </div>
        ) : !error ? (
          <div className="h-32 animate-pulse rounded-[var(--radius-md)] bg-canvas-soft" />
        ) : null}
      </section>
    </div>
  );
}
