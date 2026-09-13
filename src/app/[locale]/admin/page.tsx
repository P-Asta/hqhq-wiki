/**
 * /[locale]/admin — admin console (routes.md).
 *
 * Server component: resolves every dictionary string and hands them to the
 * AdminTabs client island. Access control is authenticateManagerRequest — the
 * Manager role, or sole ownership of a bootstrap manager username
 * (src/lib/roles.ts). The island gates the UI on the server-resolved principal
 * (redirect to /login when anonymous, forbidden view for a non-manager), and
 * every /api/admin/* call re-runs the same guard server-side, which is where
 * the boundary actually is.
 */

import type { Metadata } from "next";

import { AdminTabs, type AdminConsoleLabels } from "@/components/admin/admin-tabs";
import { getDictionary } from "@/lib/i18n";

export interface AdminPageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: AdminPageProps): Promise<Metadata> {
  const { locale } = await params;
  return { title: getDictionary(decodeURIComponent(locale).toLowerCase()).admin.title };
}

export default async function AdminPage({ params }: AdminPageProps) {
  const { locale: rawLocale } = await params;
  const locale = decodeURIComponent(rawLocale).toLowerCase();
  const dict = getDictionary(locale);

  const labels: AdminConsoleLabels = {
    loading: dict.common.loading,
    signInRedirect: dict.admin.signInRedirect,
    forbiddenTitle: dict.errors.forbiddenTitle,
    forbiddenDescription: dict.errors.forbiddenDescription,
    tabReports: dict.admin.tabReports,
    reportsEmpty: dict.admin.reportsEmpty,
    reportFilterLabel: dict.admin.reportFilterLabel,
    reportStatus: {
      open: dict.admin.reportStatusOpen,
      resolved: dict.admin.reportStatusResolved,
      dismissed: dict.admin.reportStatusDismissed,
      all: dict.admin.reportStatusAll,
    },
    reportColumnTarget: dict.admin.reportColumnTarget,
    reportColumnReporter: dict.admin.reportColumnReporter,
    reportColumnReason: dict.admin.reportColumnReason,
    reportResolve: dict.admin.reportResolve,
    reportDismiss: dict.admin.reportDismiss,
    tabGrants: dict.admin.tabGrants,
    tabBans: dict.admin.tabBans,
    tabVersions: dict.admin.tabVersions,
    tabAudit: dict.admin.tabAudit,
    loadFailed: dict.admin.loadFailed,
    actionFailed: dict.admin.actionFailed,
    loadMore: dict.special.loadMore,
    save: dict.common.save,
    cancel: dict.common.cancel,
    close: dict.common.close,
    delete: dict.common.delete,
    edit: dict.wiki.edit,
    actions: dict.common.actions,
    anonymous: dict.common.anonymous,
    statusColumn: dict.languages.columnStatus,
    grantsDescription: dict.admin.grantsDescription,
    uidLabel: dict.admin.uidLabel,
    displayNameLabel: dict.admin.displayNameLabel,
    userLabel: dict.admin.userLabel,
    grantRole: dict.admin.grantRole,
    revokeRole: dict.admin.revokeRole,
    grantColumnGrantedBy: dict.admin.grantColumnGrantedBy,
    grantColumnGrantedAt: dict.admin.grantColumnGrantedAt,
    grantStatusActive: dict.admin.grantStatusActive,
    grantStatusRevoked: dict.admin.grantStatusRevoked,
    grantsEmpty: dict.admin.grantsEmpty,
    bannedBadge: dict.admin.bannedBadge,
    bansDescription: dict.admin.bansDescription,
    banUser: dict.admin.banUser,
    unbanUser: dict.admin.unbanUser,
    banReasonLabel: dict.admin.banReasonLabel,
    banApplied: dict.moderation.banApplied,
    banLifted: dict.moderation.banLifted,
    usernamePlaceholder: dict.admin.usernamePlaceholder,
    usernameSuggestions: dict.admin.usernameSuggestions,
    usernameEmpty: dict.admin.usernameEmpty,
    rowActions: dict.admin.rowActions,
    userChip: {
      rowActions: dict.moderation.userActions,
      report: dict.moderation.report,
      ban: dict.moderation.ban,
      unban: dict.moderation.unban,
      copyId: dict.moderation.copyId,
      bannedBadge: dict.admin.bannedBadge,
      anonymous: dict.common.anonymous,
      roleNames: dict.roles,
    },
    versionIdLabel: dict.admin.versionIdLabel,
    versionLabelLabel: dict.admin.versionLabelLabel,
    addVersion: dict.admin.addVersion,
    setDefaultVersion: dict.admin.setDefaultVersion,
    defaultVersionLine: dict.admin.defaultVersionLine,
    versionDefaultBadge: dict.admin.versionDefaultBadge,
    versionsEmpty: dict.admin.versionsEmpty,
    versionEditTitle: dict.admin.versionEditTitle,
    versionDeleteBlockedTitle: dict.admin.versionDeleteBlockedTitle,
    versionDeleteBlockedBody: dict.admin.versionDeleteBlockedBody,
    auditColumnAction: dict.admin.auditColumnAction,
    auditColumnActor: dict.admin.auditColumnActor,
    auditColumnTarget: dict.admin.auditColumnTarget,
    auditColumnDate: dict.admin.auditColumnDate,
    auditEmpty: dict.admin.auditEmpty,
    auditActions: dict.admin.auditActions,
  };

  return (
    <div className="mx-auto w-full max-w-4xl py-8">
      <h1 className="mb-6 text-2xl font-semibold tracking-[-0.04em] text-ink">
        {dict.admin.title}
      </h1>
      <AdminTabs locale={locale} labels={labels} />
    </div>
  );
}
