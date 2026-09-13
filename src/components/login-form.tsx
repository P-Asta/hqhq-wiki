"use client";

/**
 * Login / register / reset-password form (Firebase email+password).
 *
 * **Sign-in takes an account name as well as an address** (user direction,
 * 2026-09-07: "email말고 계정 이름으로도 로그인이 되게"), which is the flow
 * reuse-audit §2 describes: an identifier with an `@` in it is an address and
 * goes to Firebase as one, and anything else is a name, looked up against
 * `usernameLower` in `users` for the address it belongs to. Both readings are
 * `identifier.ts`; the query is here because the Firestore handle is. Register
 * and reset still ask for an address — the first is what the account is made
 * with, the second is where the mail goes.
 *
 * Register writes the users/{uid} Firestore profile in the externally-imposed
 * shape {email, username, usernameLower, roles, banned, profilePicture}
 * (reuse-audit §2); the auth provider's /api/auth/me retry absorbs the
 * write-vs-first-token race. All strings arrive via `labels` from the
 * dictionary. Styled per theme.md "Buttons & forms".
 */

import { FirebaseError } from "firebase/app";
import {
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  updateProfile,
} from "firebase/auth";
import { collection, doc, getDocs, limit, query, setDoc, where } from "firebase/firestore";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { FieldMessage } from "@/components/ui/field-message";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBanner } from "@/components/ui/status-banner";
import { checkUsername, isEmailIdentifier, signInEmailOf } from "@/lib/auth/identifier";
import { getFirebaseAuth, getFirebaseFirestore } from "@/lib/firebase/client";
import { formatMessage } from "@/lib/i18n";
import { homeHref } from "@/lib/locale-path";

export interface LoginFormLabels {
  signInTitle: string;
  signInDescription: string;
  registerTitle: string;
  registerDescription: string;
  resetTitle: string;
  resetDescription: string;
  emailLabel: string;
  /** Sign-in field: an address or an account name (auth.identifierLabel). */
  identifierLabel: string;
  passwordLabel: string;
  usernameLabel: string;
  signInAction: string;
  registerAction: string;
  resetAction: string;
  resetSent: string;
  forgotPassword: string;
  needAccount: string;
  alreadyHaveAccount: string;
  backToSignIn: string;
  invalidCredentials: string;
  usernameTaken: string;
  usernameLength: string;
  usernameCharacters: string;
  emailInUse: string;
  weakPassword: string;
  bannedNotice: string;
  genericError: string;
  /** Template with {name} (auth.alreadySignedIn). */
  alreadySignedIn: string;
  goHome: string;
  loading: string;
}

export interface LoginFormProps {
  locale: string;
  labels: LoginFormLabels;
}

type Mode = "signIn" | "register" | "reset";

/**
 * The address an account name signs in with, or null where the name names no
 * one this can be sure of ({@link signInEmailOf}).
 *
 * `limit(2)` rather than `limit(1)`: one document is the answer and two is the
 * refusal, so the second one has to be asked for — and nothing beyond it is
 * read, since three profiles are as ambiguous as two.
 */
async function emailForUsername(username: string): Promise<string | null> {
  const profiles = await getDocs(
    query(
      collection(getFirebaseFirestore(), "users"),
      where("usernameLower", "==", username.toLowerCase()),
      limit(2),
    ),
  );
  return signInEmailOf(profiles.docs.map((profile) => profile.data()));
}

/** Is any account already using this name? (Case-insensitive, like sign-in.) */
async function usernameTaken(username: string): Promise<boolean> {
  const profiles = await getDocs(
    query(
      collection(getFirebaseFirestore(), "users"),
      where("usernameLower", "==", username.trim().toLowerCase()),
      limit(1),
    ),
  );
  return !profiles.empty;
}

function errorMessage(error: unknown, labels: LoginFormLabels): string {
  if (error instanceof FirebaseError) {
    switch (error.code) {
      case "auth/invalid-credential":
      case "auth/invalid-email":
      case "auth/user-not-found":
      case "auth/wrong-password":
        return labels.invalidCredentials;
      case "auth/email-already-in-use":
        return labels.emailInUse;
      case "auth/weak-password":
      case "auth/password-does-not-meet-requirements":
        return labels.weakPassword;
      case "auth/user-disabled":
        return labels.bannedNotice;
      default:
        return labels.genericError;
    }
  }
  return labels.genericError;
}

const LINK_CLASSES =
  "focus-ring rounded-[var(--radius-sm)] text-[13px] text-link transition-colors hover:text-link-hover";

export function LoginForm({ locale, labels }: LoginFormProps) {
  const router = useRouter();
  const { loading, user, profile, error: authError } = useAuth();

  const [mode, setMode] = useState<Mode>("signIn");
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const switchMode = (next: Mode) => {
    setMode(next);
    setFormError(null);
    setNotice(null);
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    const identifier = String(data.get("identifier") ?? "").trim();
    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");
    const username = String(data.get("username") ?? "").trim();

    setPending(true);
    setFormError(null);
    setNotice(null);
    try {
      const auth = getFirebaseAuth();
      if (mode === "signIn") {
        const address = isEmailIdentifier(identifier)
          ? identifier
          : await emailForUsername(identifier);
        // A name nobody answers to says exactly what a wrong password says.
        // Which of the two it was is not the visitor's to learn: the reply
        // would tell anyone who asked whether an account by that name exists.
        if (address === null) {
          setFormError(labels.invalidCredentials);
          return;
        }
        await signInWithEmailAndPassword(auth, address, password);
        router.push(homeHref(locale));
      } else if (mode === "register") {
        // The name has to be a name: `identifier.ts` reads an "@" as "this is
        // an address", and a name that looks like one could never sign in.
        const refusal = checkUsername(username);
        if (refusal !== null) {
          setFormError(
            refusal === "bad-characters" ? labels.usernameCharacters : labels.usernameLength,
          );
          return;
        }
        // Check-then-act, like the reference site: Firestore cannot express
        // cross-document uniqueness, so this closes the ordinary case and a
        // simultaneous double-registration stays possible. Nothing downstream
        // trusts a name for identity because of exactly that — see
        // MANAGER_USERNAMES (src/lib/roles.ts).
        if (await usernameTaken(username)) {
          setFormError(labels.usernameTaken);
          return;
        }
        const credential = await createUserWithEmailAndPassword(auth, email, password);
        await updateProfile(credential.user, { displayName: username });
        // External contract: users/{uid} profile shape (reuse-audit §2). The
        // address is part of it because signing in by name needs it: the name
        // is looked up here and the address is what Firebase is handed.
        await setDoc(doc(getFirebaseFirestore(), "users", credential.user.uid), {
          email,
          username,
          usernameLower: username.toLowerCase(),
          roles: [],
          banned: false,
          profilePicture: null,
        });
        router.push(homeHref(locale));
      } else {
        await sendPasswordResetEmail(auth, email);
        setNotice(labels.resetSent);
      }
    } catch (error) {
      setFormError(errorMessage(error, labels));
    } finally {
      setPending(false);
    }
  };

  if (loading) {
    return (
      <p role="status" className="py-10 text-center text-sm text-mute">
        {labels.loading}
      </p>
    );
  }

  if (user) {
    const name = profile?.username ?? user.displayName ?? user.email ?? "";
    return (
      <div className="space-y-4">
        <StatusBanner tone="info">{formatMessage(labels.alreadySignedIn, { name })}</StatusBanner>
        <Link href={homeHref(locale)} className={LINK_CLASSES}>
          {labels.goHome}
        </Link>
      </div>
    );
  }

  const title =
    mode === "signIn"
      ? labels.signInTitle
      : mode === "register"
        ? labels.registerTitle
        : labels.resetTitle;
  const description =
    mode === "signIn"
      ? labels.signInDescription
      : mode === "register"
        ? labels.registerDescription
        : labels.resetDescription;
  const action =
    mode === "signIn"
      ? labels.signInAction
      : mode === "register"
        ? labels.registerAction
        : labels.resetAction;

  return (
    <div className="rounded-[var(--radius-lg)] border border-hairline bg-surface p-6">
      <h1 className="text-lg font-semibold tracking-tight text-ink">{title}</h1>
      <p className="mt-1 text-sm text-mute">{description}</p>

      {authError === "banned" ? (
        <StatusBanner tone="error" className="mt-4">
          {labels.bannedNotice}
        </StatusBanner>
      ) : null}
      {notice ? (
        <StatusBanner tone="info" className="mt-4">
          {notice}
        </StatusBanner>
      ) : null}

      <form onSubmit={onSubmit} className="mt-5 space-y-4" noValidate={false}>
        {mode === "register" ? (
          <div>
            <Label htmlFor="login-username">{labels.usernameLabel}</Label>
            <Input
              id="login-username"
              name="username"
              required
              maxLength={32}
              autoComplete="username"
            />
          </div>
        ) : null}

        {mode === "signIn" ? (
          /*
            Not `type="email"` and not named `email`: the browser's own
            validation refuses a name in an address field, and the author who
            typed theirs would be told to include an "@" by the form itself.
          */
          <div>
            <Label htmlFor="login-identifier">{labels.identifierLabel}</Label>
            <Input
              id="login-identifier"
              name="identifier"
              type="text"
              required
              autoComplete="username"
            />
          </div>
        ) : (
          <div>
            <Label htmlFor="login-email">{labels.emailLabel}</Label>
            <Input id="login-email" name="email" type="email" required autoComplete="email" />
          </div>
        )}

        {mode !== "reset" ? (
          <div>
            <Label htmlFor="login-password">{labels.passwordLabel}</Label>
            <Input
              id="login-password"
              name="password"
              type="password"
              required
              minLength={6}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
            />
          </div>
        ) : null}

        {formError ? <FieldMessage tone="error">{formError}</FieldMessage> : null}

        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? labels.loading : action}
        </Button>
      </form>

      <div className="mt-5 flex flex-col items-start gap-2 border-t border-hairline pt-4">
        {mode === "signIn" ? (
          <>
            <button type="button" className={LINK_CLASSES} onClick={() => switchMode("register")}>
              {labels.needAccount}
            </button>
            <button type="button" className={LINK_CLASSES} onClick={() => switchMode("reset")}>
              {labels.forgotPassword}
            </button>
          </>
        ) : (
          <>
            {mode === "register" ? (
              <button type="button" className={LINK_CLASSES} onClick={() => switchMode("signIn")}>
                {labels.alreadyHaveAccount}
              </button>
            ) : null}
            <button type="button" className={LINK_CLASSES} onClick={() => switchMode("signIn")}>
              {labels.backToSignIn}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
