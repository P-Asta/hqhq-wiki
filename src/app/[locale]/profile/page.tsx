/**
 * /[locale]/profile — the signed-in user's profile (routes.md).
 *
 * Server component: resolves dictionary strings and mounts the ProfileView
 * client island (principal + sign-out via useAuth; contributions via
 * GET /api/profile/contributions).
 */

import type { Metadata } from "next";

import { ProfileView, type ProfileViewLabels } from "@/components/profile-view";
import { getDictionary } from "@/lib/i18n";

export interface ProfilePageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: ProfilePageProps): Promise<Metadata> {
  const { locale } = await params;
  return { title: getDictionary(decodeURIComponent(locale).toLowerCase()).auth.profileTitle };
}

export default async function ProfilePage({ params }: ProfilePageProps) {
  const { locale: rawLocale } = await params;
  const locale = decodeURIComponent(rawLocale).toLowerCase();
  const dict = getDictionary(locale);

  const labels: ProfileViewLabels = {
    title: dict.auth.profileTitle,
    loading: dict.common.loading,
    signInToViewProfile: dict.auth.signInToViewProfile,
    signIn: dict.common.signIn,
    signOut: dict.common.signOut,
    accountIdLabel: dict.auth.accountIdLabel,
    rolesLabel: dict.auth.rolesLabel,
    roleNames: dict.roles,
    bannedBadge: dict.admin.bannedBadge,
    bannedNotice: dict.auth.bannedNotice,
    contributionsTitle: dict.auth.contributionsTitle,
    contributionsEmpty: dict.auth.contributionsEmpty,
    loadMore: dict.special.loadMore,
    loadFailed: dict.admin.loadFailed,
    columnDate: dict.special.columnDate,
    columnSummary: dict.special.columnSummary,
    minorBadge: dict.special.minorBadge,
  };

  return (
    <div className="mx-auto w-full max-w-3xl py-8">
      <h1 className="mb-6 text-2xl font-semibold tracking-[-0.04em] text-ink">
        {dict.auth.profileTitle}
      </h1>
      <ProfileView locale={locale} labels={labels} />
    </div>
  );
}
