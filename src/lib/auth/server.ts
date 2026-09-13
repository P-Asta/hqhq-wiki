import "server-only";

/**
 * Server-side auth guards (stateless Bearer flow — reuse-audit §2 contract).
 *
 * Every mutation API verifies the Firebase ID token per request; there is no
 * session cookie and no anonymous write path — reading is public, but every
 * edit, upload and admin action requires a signed-in account.
 * `authenticateRequest` resolves a full AuthPrincipal (token facts + Firestore
 * `users/{uid}` profile + server-computed isAdmin); `requirePrincipal` is the
 * "must be signed in" guard every write route uses; `authenticateAdminRequest`
 * enforces admin, and `authenticateManagerRequest` the admin console's own,
 * stricter manager rule (src/lib/roles.ts).
 *
 * isAdmin = not banned AND (Firestore bootstrap role in WIKI_ADMIN_ROLES OR
 * an active SQLite admin grant). Empty/missing WIKI_ADMIN_ROLES fails closed.
 *
 * Firebase round-trips are injectable via `options.deps` so tests can run the
 * guard matrix against fakes and an in-memory database.
 */

import { getDb, type WikiDb } from "@/lib/db/client";
import { hasActiveGrant, upsertUser, type Actor } from "@/lib/db/store";
import { getWikiEnv } from "@/lib/env";
import { hasManagerRole, isManagerUsername } from "@/lib/roles";

import type { AuthPrincipal, AuthProfile } from "./types";

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/**
 * Base class for auth failures. Carries `status` + `code` in the same shape
 * as WikiStoreError so src/lib/api-response.ts maps both identically.
 */
export class AuthApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** A Bearer token was presented but could not be verified. */
export class InvalidTokenError extends AuthApiError {
  constructor(message = "The provided credentials are invalid or expired.") {
    super(401, "invalid-token", message);
  }
}

/** The route requires authentication and none was presented. */
export class AuthRequiredError extends AuthApiError {
  constructor() {
    super(401, "auth-required", "Authentication is required.");
  }
}

/**
 * Valid token but no Firestore `users/{uid}` profile yet — the registration
 * race. auth-provider.tsx retries once on this code.
 */
export class ProfileNotFoundError extends AuthApiError {
  constructor(readonly uid: string) {
    super(403, "profile-not-found", "No account profile exists for this user.");
  }
}

export class BannedError extends AuthApiError {
  constructor() {
    super(403, "banned", "This account is banned.");
  }
}

export class AdminRequiredError extends AuthApiError {
  constructor() {
    super(403, "admin-required", "Administrator access is required.");
  }
}

/** The admin console's own rule: the Manager role, or a manager username. */
export class ManagerRequiredError extends AuthApiError {
  constructor() {
    super(403, "manager-required", "Manager access is required.");
  }
}

/** Admin credentials missing/misconfigured, or the auth backend unreachable. */
export class AuthBackendUnavailableError extends AuthApiError {
  constructor(message = "The authentication service is currently unavailable.") {
    super(503, "auth-unavailable", message);
  }
}

/* ------------------------------------------------------------------ */
/* Dependencies (injectable for tests)                                 */
/* ------------------------------------------------------------------ */

/** Identity facts extracted from a verified ID token. */
export interface VerifiedToken {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  photoURL: string | null;
}

export interface AuthDeps {
  /**
   * Verify a raw Bearer token; reject on any failure. Defaults to the Admin
   * SDK when credentials exist, otherwise offline signature verification.
   */
  verifyIdToken?: (token: string) => Promise<VerifiedToken>;
  /**
   * Load the Firestore `users/{uid}` profile; null when absent. The caller's
   * own ID token is passed so the credential-free path can read the document
   * as that caller (Security Rules apply); the Admin path ignores it.
   */
  loadProfile?: (uid: string, idToken?: string) => Promise<AuthProfile | null>;
  /** Database for grant lookups + the users mirror. Defaults to getDb(). */
  db?: WikiDb;
  /** Raw comma-separated bootstrap role list; defaults to WIKI_ADMIN_ROLES. */
  adminRoles?: string;
  /**
   * Does this profile solely own a bootstrap manager username? Defaults to a
   * Firestore uniqueness check (src/lib/auth/users.ts resolvesManagerUsername).
   */
  ownsManagerUsername?: (profile: AuthProfile, idToken?: string) => Promise<boolean>;
}

export interface AuthenticateOptions {
  /**
   * Set on WRITE paths: upserts the SQLite users mirror for the principal
   * (db-schema §D pattern 15) as part of authentication.
   */
  forWrite?: boolean;
  deps?: AuthDeps;
}

/**
 * Verify a token the strongest way this server can.
 *
 * With credentials: the Admin SDK, which also asks Google whether the session
 * was revoked. Without them: offline signature verification against Google's
 * published keys — no secret needed, but no revocation check either (see
 * src/lib/firebase/backend.ts for exactly what that costs).
 */
async function defaultVerifyIdToken(token: string): Promise<VerifiedToken> {
  // Lazy imports so neither backend is loaded unless it actually runs.
  const { usingAdminSdk, firebaseProjectId } = await import("@/lib/firebase/backend");

  if (!usingAdminSdk()) {
    const { verifyFirebaseIdTokenOffline } = await import("@/lib/firebase/verify-token");
    const claims = await verifyFirebaseIdTokenOffline(token, firebaseProjectId());
    return {
      uid: claims.sub,
      email: claims.email ?? null,
      emailVerified: claims.email_verified ?? false,
      displayName: typeof claims.name === "string" ? claims.name : null,
      photoURL: claims.picture ?? null,
    };
  }

  const { verifyFirebaseIdToken } = await import("@/lib/firebase/admin");
  const decoded = await verifyFirebaseIdToken(token);
  return {
    uid: decoded.uid,
    email: decoded.email ?? null,
    emailVerified: decoded.email_verified ?? false,
    displayName: typeof decoded.name === "string" ? decoded.name : null,
    photoURL: decoded.picture ?? null,
  };
}

/** Normalize a raw Firestore document into the AuthProfile contract shape. */
export function normalizeProfile(uid: string, data: Record<string, unknown>): AuthProfile {
  const username = typeof data.username === "string" && data.username ? data.username : uid;
  const usernameLower =
    typeof data.usernameLower === "string" && data.usernameLower
      ? data.usernameLower
      : username.toLowerCase();
  const roles = Array.isArray(data.roles)
    ? data.roles.filter((role): role is string => typeof role === "string")
    : [];
  return {
    uid,
    username,
    usernameLower,
    roles,
    banned: data.banned === true,
    profilePicture: typeof data.profilePicture === "string" ? data.profilePicture : null,
  };
}

/**
 * The caller's own `users/{uid}` document. Without credentials it is read over
 * REST with the caller's own token — their own document, which the browser can
 * already read, so nothing new is exposed.
 */
async function defaultLoadProfile(uid: string, idToken?: string): Promise<AuthProfile | null> {
  const { usingAdminSdk, firebaseProjectId } = await import("@/lib/firebase/backend");

  if (!usingAdminSdk()) {
    if (!idToken) return null;
    const { restGetDocument } = await import("@/lib/firebase/firestore-rest");
    const fields = await restGetDocument(firebaseProjectId(), `users/${uid}`, idToken);
    return fields === null ? null : normalizeProfile(uid, fields);
  }

  const { getFirebaseAdminFirestore } = await import("@/lib/firebase/admin");
  const snap = await getFirebaseAdminFirestore().doc(`users/${uid}`).get();
  if (!snap.exists) return null;
  return normalizeProfile(uid, snap.data() ?? {});
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Extract the Bearer token from a request. Returns null when the request is
 * anonymous (no Authorization header, or a non-Bearer scheme); throws
 * InvalidTokenError for a Bearer header with an empty token.
 */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization")?.trim();
  if (!header) return null;
  if (/^Bearer$/i.test(header)) throw new InvalidTokenError("Empty Bearer token.");
  const match = /^Bearer\s+(.*)$/i.exec(header);
  if (!match) return null;
  const token = match[1].trim();
  if (!token) throw new InvalidTokenError("Empty Bearer token.");
  return token;
}

/** Parse WIKI_ADMIN_ROLES; empty/missing yields the empty set (fails closed). */
export function parseAdminRoles(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((role) => role.trim())
      .filter(Boolean),
  );
}

function errorCode(err: unknown): unknown {
  return err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
}

function classifyVerifyError(err: unknown): AuthApiError {
  if (err instanceof AuthApiError) return err;
  const code = errorCode(err);
  if (code === "FIREBASE_ADMIN_NOT_CONFIGURED") {
    return new AuthBackendUnavailableError(
      "Firebase Admin credentials are not configured on this server.",
    );
  }
  // Google's signing keys were unreachable — nobody's token is at fault.
  if (code === "firebase-keys-unavailable") {
    return new AuthBackendUnavailableError(
      "Could not reach Google to verify the sign-in. Please try again.",
    );
  }
  // firebase-admin verification failures carry codes like
  // "auth/id-token-expired", "auth/id-token-revoked", "auth/argument-error".
  if (typeof code === "string" && code.startsWith("auth/")) {
    return new InvalidTokenError();
  }
  return new AuthBackendUnavailableError();
}

function classifyProfileError(err: unknown): AuthApiError {
  if (err instanceof AuthApiError) return err;
  if (errorCode(err) === "FIREBASE_ADMIN_NOT_CONFIGURED") {
    return new AuthBackendUnavailableError(
      "Firebase Admin credentials are not configured on this server.",
    );
  }
  return new AuthBackendUnavailableError("Failed to load the account profile.");
}

/**
 * The principal as the store names people: uid plus the best display name we
 * have. Every audited write needs one, so it lives here rather than being
 * re-derived per route.
 */
export function actorOf(principal: AuthPrincipal): Actor {
  return {
    uid: principal.user.uid,
    displayName:
      principal.profile.username || principal.user.displayName || principal.user.uid,
  };
}

/* ------------------------------------------------------------------ */
/* Guards                                                              */
/* ------------------------------------------------------------------ */

/**
 * Resolve the principal for a request.
 *
 * - Anonymous request (no Bearer token) → null. Reading is public; every
 *   write path turns this null into a 401 via {@link requirePrincipal}.
 * - Unverifiable token → InvalidTokenError (401).
 * - Missing profile → ProfileNotFoundError (403, registration race).
 * - Banned → BannedError (403); a banned user is never a principal and
 *   therefore never an admin.
 * - Backend trouble → AuthBackendUnavailableError (503).
 *
 * With `options.forWrite` the SQLite users mirror is upserted for the
 * authenticated user before returning (db-schema §D pattern 15).
 */
export async function authenticateRequest(
  req: Request,
  options: AuthenticateOptions = {},
): Promise<AuthPrincipal | null> {
  return authenticateFirebaseRequest(req, options, options.deps ?? {});
}

async function authenticateFirebaseRequest(
  req: Request,
  options: AuthenticateOptions,
  deps: AuthDeps,
): Promise<AuthPrincipal | null> {
  const token = bearerToken(req);
  if (token === null) return null;

  const verify = deps.verifyIdToken ?? defaultVerifyIdToken;
  let verified: VerifiedToken;
  try {
    verified = await verify(token);
  } catch (err) {
    throw classifyVerifyError(err);
  }

  const loadProfile = deps.loadProfile ?? defaultLoadProfile;
  let profile: AuthProfile | null;
  try {
    profile = await loadProfile(verified.uid, token);
  } catch (err) {
    throw classifyProfileError(err);
  }
  if (!profile) throw new ProfileNotFoundError(verified.uid);
  if (profile.banned) throw new BannedError();

  const db = deps.db ?? getDb();
  const adminRoles = parseAdminRoles(deps.adminRoles ?? getWikiEnv().adminRoles);
  const hasBootstrapRole = profile.roles.some((role) => adminRoles.has(role));
  // hasActiveGrant also re-checks the SQLite ban flag (O5 dual-write).
  const isAdmin = hasBootstrapRole || hasActiveGrant(db, verified.uid);

  if (options.forWrite) {
    upsertUser(db, {
      uid: verified.uid,
      displayName: profile.username || verified.displayName || verified.uid,
    });
  }

  return {
    user: {
      uid: verified.uid,
      email: verified.email,
      emailVerified: verified.emailVerified,
      displayName: verified.displayName,
      photoURL: verified.photoURL,
    },
    profile,
    roles: profile.roles,
    isAdmin,
    canAccessAdminPanel: await resolveAdminPanelAccess(profile, deps, token),
  };
}

/**
 * The console rule, both halves: the Manager role, or sole ownership of a
 * bootstrap manager username.
 *
 * The role answers most calls with no I/O. The username hatch costs one
 * Firestore read, but only for a caller whose name is on that very short list
 * — a name alone is not proof, because the register form writes it from the
 * browser (see MANAGER_USERNAMES in src/lib/roles.ts).
 */
async function resolveAdminPanelAccess(
  profile: AuthProfile,
  deps: AuthDeps,
  idToken?: string,
): Promise<boolean> {
  if (hasManagerRole(profile)) return true;
  if (!isManagerUsername(profile.usernameLower)) return false;
  const owns = deps.ownsManagerUsername ?? defaultOwnsManagerUsername;
  return owns(profile, idToken);
}

async function defaultOwnsManagerUsername(
  profile: AuthProfile,
  idToken?: string,
): Promise<boolean> {
  const { resolvesManagerUsername } = await import("@/lib/auth/users");
  return resolvesManagerUsername(profile, idToken);
}

/**
 * Like authenticateRequest, but the request MUST carry a signed-in account:
 * anonymous → AuthRequiredError (401). This is the guard every write path
 * uses — there is no anonymous editing.
 */
export async function requirePrincipal(
  req: Request,
  options: AuthenticateOptions = {},
): Promise<AuthPrincipal> {
  const principal = await authenticateRequest(req, options);
  if (!principal) throw new AuthRequiredError();
  return principal;
}

/**
 * Like requirePrincipal, but the caller must also be an admin:
 * authenticated non-admin → AdminRequiredError (403).
 */
export async function authenticateAdminRequest(
  req: Request,
  options: AuthenticateOptions = {},
): Promise<AuthPrincipal> {
  const principal = await requirePrincipal(req, options);
  if (!principal.isAdmin) throw new AdminRequiredError();
  return principal;
}

/**
 * The admin console's own gate (`/api/admin/*`): the caller must hold the
 * Manager role or be one of the manager usernames (src/lib/roles.ts).
 * Stricter than {@link authenticateAdminRequest} on purpose — an
 * `admin_grants` row makes someone an admin, not a manager.
 */
export async function authenticateManagerRequest(
  req: Request,
  options: AuthenticateOptions = {},
): Promise<AuthPrincipal> {
  const principal = await requirePrincipal(req, options);
  if (!principal.canAccessAdminPanel) throw new ManagerRequiredError();
  return principal;
}
