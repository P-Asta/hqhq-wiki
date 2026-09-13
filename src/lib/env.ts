/**
 * Typed access to wiki server environment variables (see .env.example).
 * Read lazily so tests can set process.env before first use.
 */

/**
 * Any environment-shaped bag of strings. Wider than NodeJS.ProcessEnv (which
 * demands NODE_ENV) so tests can pass literal fixtures.
 */
export type EnvSource = Record<string, string | undefined>;

export interface WikiEnv {
  /** SQLite database file; relative paths resolve from the project root. */
  dbPath: string;
  /** Upload root for [[File:]] binaries (decisions O6). */
  uploadRoot: string;
  /** Default UI/content locale. */
  defaultLocale: string;
  /**
   * Comma-separated Firestore bootstrap admin roles, passed through verbatim
   * to the auth layer (routes.md admin auth); undefined when unset.
   */
  adminRoles: string | undefined;
}

export function getWikiEnv(env: EnvSource = process.env): WikiEnv {
  return {
    dbPath: env.WIKI_DB_PATH || "./wiki-data/wiki.db",
    uploadRoot: env.WIKI_UPLOAD_ROOT || "./wiki-data/uploads",
    defaultLocale: env.WIKI_DEFAULT_LOCALE || "en",
    adminRoles: env.WIKI_ADMIN_ROLES,
  };
}

/**
 * Whether Firebase Admin can plausibly obtain credentials, mirroring
 * src/lib/firebase/admin.ts `buildCredential` WITHOUT importing firebase-admin
 * (that module only reports FIREBASE_ADMIN_NOT_CONFIGURED at call time). Used
 * to warn at boot that nobody will be able to edit until they are configured.
 *
 * - both FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY → service account;
 * - exactly one of them → admin.ts throws, so treat as unavailable;
 * - neither → Application Default Credentials, which are only detectable
 *   here through GOOGLE_APPLICATION_CREDENTIALS. A host that supplies ADC by
 *   another route (a metadata server) reads as false here and still works.
 */
export function hasFirebaseAdminCredentials(env: EnvSource = process.env): boolean {
  const clientEmail = Boolean(env.FIREBASE_CLIENT_EMAIL?.trim());
  const privateKey = Boolean(env.FIREBASE_PRIVATE_KEY?.trim());
  if (clientEmail && privateKey) return true;
  if (clientEmail !== privateKey) return false;
  return Boolean(env.GOOGLE_APPLICATION_CREDENTIALS?.trim());
}
