"use client";

/**
 * Admin console shell (routes.md `/admin`): the auth gate plus the
 * reports / grants / bans / versions / audit tab bar. Every string arrives
 * resolved from the server page (getDictionary); every panel calls the
 * /api/admin/* routes with the caller's Bearer token via `adminFetch`.
 *
 * Reports come first and carry a count badge, because they are the only tab
 * holding work somebody is waiting on. Banning is hoisted up here rather than
 * living in each panel: the same action is reachable from a name in the audit
 * log and from a name in the report queue, and one handler means one place
 * where the outcome is reported and one `refreshKey` that re-reads both.
 *
 * Gate — the authenticateManagerRequest-equivalent client check on the
 * server-resolved principal (/api/auth/me via useAuth):
 * - resolving   → pulse placeholder
 * - anonymous   → redirect to /{locale}/login
 * - non-manager → forbidden banner
 * - manager     → tabs
 * The APIs themselves re-run authenticateManagerRequest on every request; this
 * gate is UX, not the security boundary.
 */

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { AuditLog } from "@/components/admin/audit-log";
import { BanPanel } from "@/components/admin/ban-panel";
import { GrantManager } from "@/components/admin/grant-manager";
import { ReportQueue } from "@/components/admin/report-queue";
import { VersionRegistryEditor } from "@/components/admin/version-registry-editor";
import { useAuth } from "@/components/auth-provider";
import { StatusBanner } from "@/components/ui/status-banner";
import type { ChipUser, UserChipLabels } from "@/components/user-chip";
import { formatMessage } from "@/lib/i18n";
import { localePath } from "@/lib/locale-path";

/* ------------------------------------------------------------------ */
/* Shared API plumbing for the panels                                  */
/* ------------------------------------------------------------------ */

/** Unified error body shape from src/lib/api-response.ts. */
export interface AdminApiErrorBody {
  code: string;
  message: string;
  [key: string]: unknown;
}

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: AdminApiErrorBody,
  ) {
    super(body.message);
    this.name = "AdminApiError";
  }
}

export type GetIdToken = (forceRefresh?: boolean) => Promise<string | null>;

/**
 * Call an API route with the caller's Bearer token; JSON in, JSON out.
 * Non-2xx responses throw AdminApiError carrying the unified error body.
 */
export async function adminFetch<T>(
  getIdToken: GetIdToken,
  url: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const token = await getIdToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  });

  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // fall through — treated as an unshaped failure below
  }
  if (!res.ok) {
    const error = (parsed as { error?: AdminApiErrorBody } | null)?.error;
    throw new AdminApiError(
      res.status,
      error ?? { code: "unknown", message: `Request failed (${res.status}).` },
    );
  }
  return parsed as T;
}

/** The thrown value → a message string for {message} interpolation. */
export function errorMessage(err: unknown): string {
  if (err instanceof AdminApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/* ------------------------------------------------------------------ */
/* Labels                                                              */
/* ------------------------------------------------------------------ */

export interface AdminConsoleLabels {
  // gate
  loading: string;
  signInRedirect: string;
  forbiddenTitle: string;
  forbiddenDescription: string;
  // tab bar
  tabGrants: string;
  tabBans: string;
  tabVersions: string;
  tabAudit: string;
  // shared
  loadFailed: string;
  actionFailed: string;
  loadMore: string;
  save: string;
  cancel: string;
  close: string;
  delete: string;
  edit: string;
  actions: string;
  anonymous: string;
  statusColumn: string;
  // grants
  grantsDescription: string;
  uidLabel: string;
  displayNameLabel: string;
  userLabel: string;
  grantRole: string;
  revokeRole: string;
  grantColumnGrantedBy: string;
  grantColumnGrantedAt: string;
  grantStatusActive: string;
  grantStatusRevoked: string;
  grantsEmpty: string;
  bannedBadge: string;
  // bans
  bansDescription: string;
  banUser: string;
  unbanUser: string;
  banReasonLabel: string;
  banApplied: string;
  banLifted: string;
  usernamePlaceholder: string;
  usernameSuggestions: string;
  usernameEmpty: string;
  rowActions: string;
  /** Strings for the user chip embedded in the audit and report tables. */
  userChip: UserChipLabels;
  // reports
  tabReports: string;
  reportsEmpty: string;
  reportFilterLabel: string;
  reportStatus: Record<"open" | "resolved" | "dismissed" | "all", string>;
  reportColumnTarget: string;
  reportColumnReporter: string;
  reportColumnReason: string;
  reportResolve: string;
  reportDismiss: string;
  // versions
  versionIdLabel: string;
  versionLabelLabel: string;
  addVersion: string;
  setDefaultVersion: string;
  defaultVersionLine: string;
  versionDefaultBadge: string;
  versionsEmpty: string;
  versionEditTitle: string;
  versionDeleteBlockedTitle: string;
  versionDeleteBlockedBody: string;
  // audit
  auditColumnAction: string;
  auditColumnActor: string;
  auditColumnTarget: string;
  auditColumnDate: string;
  auditEmpty: string;
  /** Stored action id → the sentence it reads as. */
  auditActions: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

type AdminTab = "reports" | "grants" | "bans" | "versions" | "audit";

// Reports lead: they are the only tab with a queue somebody is waiting on.
const TAB_ORDER: AdminTab[] = ["reports", "grants", "bans", "versions", "audit"];

export interface AdminTabsProps {
  locale: string;
  labels: AdminConsoleLabels;
}

export function AdminTabs({ locale, labels }: AdminTabsProps) {
  const { loading, user, canAccessAdminPanel, getIdToken } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<AdminTab>("reports");
  // Bumped after a ban so every tab showing that person re-reads.
  const [refreshKey, setRefreshKey] = useState(0);
  // Open reports, badged on the tab so the queue is visible from any tab.
  const [openReports, setOpenReports] = useState(0);

  // The outcome of a ban fired from a chip, shown above the tabs — the chip
  // itself is a table cell that may scroll away before the request lands.
  const [notice, setNotice] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [banning, setBanning] = useState(false);

  const anonymous = !loading && !user;
  const viewerUid = user?.uid ?? null;

  useEffect(() => {
    if (anonymous) router.replace(localePath(locale, "/login"));
  }, [anonymous, locale, router]);

  /**
   * Ban straight from a name, wherever one is shown. The route identifies by
   * username but accepts the uid the caller actually meant, so a duplicate name
   * cannot redirect the ban onto the wrong account (api/admin/ban/route.ts).
   */
  const banUser = (target: ChipUser, banned: boolean) => {
    if (banning) return;
    setBanning(true);
    setNotice(null);
    void (async () => {
      try {
        await adminFetch(getIdToken, "/api/admin/ban", {
          method: "POST",
          body: {
            username: target.displayName ?? target.uid,
            uid: target.uid,
            banned,
          },
        });
        setNotice({
          tone: "info",
          text: formatMessage(banned ? labels.banApplied : labels.banLifted, {
            name: target.displayName ?? target.uid,
          }),
        });
        setRefreshKey((n) => n + 1);
      } catch (err) {
        setNotice({
          tone: "error",
          text: formatMessage(labels.actionFailed, { message: errorMessage(err) }),
        });
      } finally {
        setBanning(false);
      }
    })();
  };

  if (loading) {
    return (
      <div aria-busy="true" className="space-y-3 py-8">
        <span className="sr-only">{labels.loading}</span>
        <div className="h-8 w-48 animate-pulse rounded-[var(--radius-sm)] bg-canvas-soft-2" />
        <div className="h-40 animate-pulse rounded-[var(--radius-lg)] bg-canvas-soft" />
      </div>
    );
  }

  if (anonymous) {
    return <p className="py-8 text-sm text-mute">{labels.signInRedirect}</p>;
  }

  if (!canAccessAdminPanel) {
    return (
      <StatusBanner tone="error" title={labels.forbiddenTitle} className="my-8">
        {labels.forbiddenDescription}
      </StatusBanner>
    );
  }

  const tabLabels: Record<AdminTab, string> = {
    reports: labels.tabReports,
    grants: labels.tabGrants,
    bans: labels.tabBans,
    versions: labels.tabVersions,
    audit: labels.tabAudit,
  };

  return (
    <div>
      {notice ? (
        <StatusBanner tone={notice.tone} className="mb-4">
          {notice.text}
        </StatusBanner>
      ) : null}

      <div role="tablist" className="flex gap-1 border-b border-hairline">
        {TAB_ORDER.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={
              "focus-ring -mb-px border-b-2 px-3 py-2 text-sm transition-colors " +
              (tab === key
                ? "border-ink font-medium text-ink"
                : "border-transparent text-mute hover:text-ink")
            }
          >
            {tabLabels[key]}
            {key === "reports" && openReports > 0 ? (
              <span className="ml-1.5 rounded-full bg-error px-1.5 py-0.5 text-[11px] font-medium text-on-primary">
                {openReports}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="py-6">
        {tab === "reports" && (
          <ReportQueue
            labels={labels}
            getIdToken={getIdToken}
            viewerUid={viewerUid}
            onBan={banUser}
            refreshKey={refreshKey}
            onOpenCount={setOpenReports}
          />
        )}
        {tab === "grants" && <GrantManager labels={labels} getIdToken={getIdToken} />}
        {tab === "bans" && <BanPanel labels={labels} getIdToken={getIdToken} />}
        {tab === "versions" && <VersionRegistryEditor labels={labels} getIdToken={getIdToken} />}
        {tab === "audit" && (
          <AuditLog
            key={refreshKey}
            labels={labels}
            getIdToken={getIdToken}
            viewerUid={viewerUid}
            onBan={banUser}
          />
        )}
      </div>
    </div>
  );
}
