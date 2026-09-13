/**
 * Shared auth types — used by both the server guards (src/lib/auth/server.ts)
 * and the client provider (src/components/auth-provider.tsx). Keep this module
 * isomorphic: no "server-only", no Firebase imports.
 *
 * The Firestore `users/{uid}` profile shape ({username, usernameLower, roles,
 * banned, profilePicture}) is an externally-imposed contract (reuse-audit §2);
 * everything else here is defined fresh (decisions O11).
 */

/** Identity facts taken from the verified Firebase ID token. */
export interface AuthUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  photoURL: string | null;
}

/** Normalized Firestore `users/{uid}` profile document. */
export interface AuthProfile {
  uid: string;
  username: string;
  usernameLower: string;
  roles: string[];
  banned: boolean;
  profilePicture: string | null;
}

/** The server-computed principal returned by the auth guards and /api/auth/me. */
export interface AuthPrincipal {
  user: AuthUser;
  profile: AuthProfile;
  /** Convenience copy of profile.roles. */
  roles: string[];
  /** Server-computed; never client-supplied. */
  isAdmin: boolean;
  /**
   * Server-computed: may this account open the admin console and call
   * `/api/admin/*`? The Manager role or a manager username (src/lib/roles.ts).
   */
  canAccessAdminPanel: boolean;
}

/** GET /api/auth/me success body. */
export type MeResponse =
  | { authenticated: false }
  | { authenticated: true; principal: AuthPrincipal };
