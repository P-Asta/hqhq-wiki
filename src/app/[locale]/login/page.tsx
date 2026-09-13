/**
 * /[locale]/login — sign in / register / reset password.
 * Server component: resolves dictionary strings and hands them to the
 * client form island.
 */

import type { Metadata } from "next";

import { LoginForm, type LoginFormLabels } from "@/components/login-form";
import { getDictionary } from "@/lib/i18n";

export interface LoginPageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: LoginPageProps): Promise<Metadata> {
  const { locale } = await params;
  return { title: getDictionary(locale).auth.signInTitle };
}

export default async function LoginPage({ params }: LoginPageProps) {
  const { locale: rawLocale } = await params;
  const locale = decodeURIComponent(rawLocale).toLowerCase();
  const dict = getDictionary(locale);

  const labels: LoginFormLabels = {
    signInTitle: dict.auth.signInTitle,
    signInDescription: dict.auth.signInDescription,
    registerTitle: dict.auth.registerTitle,
    registerDescription: dict.auth.registerDescription,
    resetTitle: dict.auth.resetTitle,
    resetDescription: dict.auth.resetDescription,
    emailLabel: dict.auth.emailLabel,
    identifierLabel: dict.auth.identifierLabel,
    passwordLabel: dict.auth.passwordLabel,
    usernameLabel: dict.auth.usernameLabel,
    signInAction: dict.auth.signInAction,
    registerAction: dict.auth.registerAction,
    resetAction: dict.auth.resetAction,
    resetSent: dict.auth.resetSent,
    forgotPassword: dict.auth.forgotPassword,
    needAccount: dict.auth.needAccount,
    alreadyHaveAccount: dict.auth.alreadyHaveAccount,
    backToSignIn: dict.auth.backToSignIn,
    invalidCredentials: dict.auth.invalidCredentials,
    usernameTaken: dict.auth.usernameTaken,
    usernameLength: dict.auth.usernameLength,
    usernameCharacters: dict.auth.usernameCharacters,
    emailInUse: dict.auth.emailInUse,
    weakPassword: dict.auth.weakPassword,
    bannedNotice: dict.auth.bannedNotice,
    genericError: dict.auth.genericError,
    alreadySignedIn: dict.auth.alreadySignedIn,
    goHome: dict.errors.goHome,
    loading: dict.common.loading,
  };

  return (
    <div className="mx-auto w-full max-w-sm py-10">
      <LoginForm locale={locale} labels={labels} />
    </div>
  );
}
