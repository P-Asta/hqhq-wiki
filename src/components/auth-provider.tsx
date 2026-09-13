"use client";

/**
 * Client auth context — subscribes to Firebase onIdTokenChanged and resolves
 * the server principal via GET /api/auth/me (stateless Bearer flow).
 *
 * Per token change: aborts any in-flight /api/auth/me request (AbortController
 * + generation counter), then fetches the principal. The 403
 * "profile-not-found" registration race (the Auth user exists before the
 * signup form writes users/{uid}) is retried once after a short delay. The
 * resolved principal is only accepted when its uid still matches the current
 * Firebase user.
 *
 * Signed out there is nothing to resolve: reading is public, and every write
 * path requires a signed-in account, so the context simply reports the
 * anonymous state without a round trip.
 *
 * **`display` vs `profile`.** `profile` is the SERVER-verified principal and is
 * the only thing authorization may read. `display` is just "who is signed in,
 * for the chrome to print": it prefers the verified profile and otherwise
 * reads the account's own `users/{uid}` document with the client SDK. That
 * matters when the server has no Admin credentials — it can then verify
 * nobody, so `profile` is null and editing is refused, but the header should
 * still say your name rather than "Unknown user". Reading your own name to
 * show it back to you decides nothing, so the client is allowed to answer it.
 */

import { onIdTokenChanged, signOut as firebaseSignOut, type User } from "firebase/auth";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { fetchAuthMe, PROFILE_NOT_FOUND_CODE } from "@/lib/auth/client";
import type { AuthPrincipal, AuthProfile } from "@/lib/auth/types";
import { getFirebaseAuth } from "@/lib/firebase/client";

export interface AuthContextValue {
  /** True while the initial subscription or a principal fetch is in flight. */
  loading: boolean;
  /** The Firebase Auth user, or null when signed out. */
  user: User | null;
  /** The server-resolved profile, or null when signed out / unresolved. */
  profile: AuthProfile | null;
  /**
   * Who to show in the chrome — name, picture and roles — resolved even when
   * the server could not verify the token. DISPLAY ONLY: never an
   * authorization input (that is `profile` / `isAdmin` / `canAccessAdminPanel`).
   */
  display: DisplayIdentity | null;
  /** Convenience copy of profile roles ([] when signed out). */
  roles: string[];
  /** Server-computed; false until a principal resolves. */
  isAdmin: boolean;
  /**
   * Server-computed: may this account open the admin console? The Manager
   * role or a manager username (src/lib/roles.ts). False until resolved.
   */
  canAccessAdminPanel: boolean;
  /** Auth error code from the last principal fetch (e.g. "banned"), or null. */
  error: string | null;
  /** Current ID token for Authorization: Bearer headers; null when signed out. */
  getIdToken: (forceRefresh?: boolean) => Promise<string | null>;
  signOut: () => Promise<void>;
}

/** Display-only identity — see the module docblock. */
export interface DisplayIdentity {
  /** Null only when nothing names this account; the caller prints its own label. */
  name: string | null;
  picture: string | null;
  roles: string[];
}

const AuthContext = createContext<AuthContextValue | null>(null);

const PROFILE_RETRY_DELAY_MS = 400;

interface AuthState {
  loading: boolean;
  user: User | null;
  principal: AuthPrincipal | null;
  /** Client-read own profile, used only when the server could not answer. */
  fallback: AuthProfile | null;
  error: string | null;
}

const INITIAL_STATE: AuthState = {
  loading: true,
  user: null,
  principal: null,
  fallback: null,
  error: null,
};

const SIGNED_OUT: AuthState = {
  loading: false,
  user: null,
  principal: null,
  fallback: null,
  error: null,
};

/**
 * The account's own `users/{uid}` document, read with the client SDK.
 *
 * Only ever used to print a name and a picture. It is the same document the
 * server would have returned, read by the one person it describes, so nothing
 * is trusted here that the viewer could not already see.
 */
async function readOwnProfile(uid: string): Promise<AuthProfile | null> {
  try {
    const { doc, getDoc } = await import("firebase/firestore");
    const { getFirebaseFirestore } = await import("@/lib/firebase/client");
    const snap = await getDoc(doc(getFirebaseFirestore(), "users", uid));
    if (!snap.exists()) return null;
    const data = snap.data();
    const username = typeof data.username === "string" && data.username ? data.username : uid;
    return {
      uid,
      username,
      usernameLower:
        typeof data.usernameLower === "string" && data.usernameLower
          ? data.usernameLower
          : username.toLowerCase(),
      roles: Array.isArray(data.roles)
        ? data.roles.filter((role): role is string => typeof role === "string")
        : [],
      banned: data.banned === true,
      profilePicture: typeof data.profilePicture === "string" ? data.profilePicture : null,
    };
  } catch {
    // The chrome falls back to the Firebase user; nothing else depends on it.
    return null;
  }
}

/**
 * The best name we have, in order: the profile's username, the Firebase
 * token's display name, then the address's local part. Accounts made on the
 * High Quota HQ site never set a Firebase display name, so without the last
 * step a signed-in reader would be shown as "Unknown user" whenever the
 * server cannot verify them.
 */
export function displayIdentityOf(user: User, profile: AuthProfile | null): DisplayIdentity {
  const emailName = user.email?.split("@")[0]?.trim() || null;
  return {
    name: profile?.username ?? user.displayName ?? emailName,
    picture: profile?.profilePicture ?? user.photoURL ?? null,
    roles: profile?.roles ?? [],
  };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(INITIAL_STATE);

  useEffect(() => {
    const auth = getFirebaseAuth();
    let generation = 0;
    let controller: AbortController | null = null;

    const unsubscribe = onIdTokenChanged(auth, (nextUser) => {
      generation += 1;
      const gen = generation;
      controller?.abort();

      if (!nextUser) {
        // Signed out: reading is public and writing requires an account, so
        // there is no principal to resolve and no reason to ask the server.
        controller = null;
        setState(SIGNED_OUT);
        return;
      }

      controller = new AbortController();
      const signal = controller.signal;
      setState((prev) => ({ ...prev, loading: true, user: nextUser }));

      void (async () => {
        try {
          const token = await nextUser.getIdToken();
          if (signal.aborted) return;

          let result = await fetchAuthMe(token, { signal });
          if (!result.ok && result.code === PROFILE_NOT_FOUND_CODE) {
            // Registration race: the Firestore profile write can land just
            // after the first token event. Retry once.
            await delay(PROFILE_RETRY_DELAY_MS, signal);
            if (signal.aborted) return;
            result = await fetchAuthMe(await nextUser.getIdToken(), { signal });
          }
          if (gen !== generation || signal.aborted) return;

          if (result.ok && result.me.authenticated && result.me.principal.user.uid === nextUser.uid) {
            setState({
              loading: false,
              user: nextUser,
              principal: result.me.principal,
              fallback: null,
              error: null,
            });
            return;
          }

          // No verified principal: either the server refused (a banned account,
          // a missing profile, no Admin credentials) or it answered about
          // somebody else. Authorization stays refused, but the chrome should
          // still be able to name whoever is signed in.
          const code = result.ok ? "auth-mismatch" : result.code;
          const fallback = await readOwnProfile(nextUser.uid);
          if (gen !== generation || signal.aborted) return;
          setState({ loading: false, user: nextUser, principal: null, fallback, error: code });
        } catch {
          if (gen !== generation || signal.aborted) return;
          setState({
            loading: false,
            user: nextUser,
            principal: null,
            fallback: null,
            error: "network-error",
          });
        }
      })();
    });

    return () => {
      generation += 1;
      controller?.abort();
      unsubscribe();
    };
  }, []);

  const getIdToken = useCallback(async (forceRefresh?: boolean): Promise<string | null> => {
    const current = getFirebaseAuth().currentUser;
    if (!current) return null;
    return current.getIdToken(forceRefresh);
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    await firebaseSignOut(getFirebaseAuth());
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      loading: state.loading,
      user: state.user,
      profile: state.principal?.profile ?? null,
      display: state.user
        ? displayIdentityOf(state.user, state.principal?.profile ?? state.fallback)
        : null,
      roles: state.principal?.roles ?? [],
      isAdmin: state.principal?.isAdmin ?? false,
      canAccessAdminPanel: state.principal?.canAccessAdminPanel ?? false,
      error: state.error,
      getIdToken,
      signOut,
    }),
    [state, getIdToken, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Access the auth context; throws when used outside <AuthProvider>. */
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within <AuthProvider>.");
  return value;
}
