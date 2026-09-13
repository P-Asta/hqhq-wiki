import "server-only";

/**
 * Firebase Admin SDK init — server side only.
 *
 * Uses a named secondary app so it can never collide with the client
 * [DEFAULT] app in shared module graphs. Credentials come from
 * FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY (set both or neither), with
 * Application Default Credentials as the fallback. Everything is lazy: a dev
 * machine without admin credentials can load this module (and boot the app)
 * fine — the typed FirebaseAdminConfigurationError only surfaces when a
 * request actually needs token verification.
 */

import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
  type App,
  type Credential,
} from "firebase-admin/app";
import { getAuth, type Auth, type DecodedIdToken } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

export const FIREBASE_ADMIN_APP_NAME = "hqhq-wiki-admin";
export const FIREBASE_ADMIN_NOT_CONFIGURED = "FIREBASE_ADMIN_NOT_CONFIGURED";

/** Thrown at call time (never module load) when admin credentials are unusable. */
export class FirebaseAdminConfigurationError extends Error {
  readonly code = FIREBASE_ADMIN_NOT_CONFIGURED;

  constructor(message: string) {
    super(message);
    this.name = "FirebaseAdminConfigurationError";
  }
}

const DEFAULT_PROJECT_ID = "highquotahq214";

function resolveProjectId(): string {
  const serverId = process.env.FIREBASE_PROJECT_ID;
  const clientId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const projectId = serverId || clientId || DEFAULT_PROJECT_ID;
  if (serverId && clientId && serverId !== clientId) {
    throw new FirebaseAdminConfigurationError(
      `FIREBASE_PROJECT_ID (${serverId}) does not match NEXT_PUBLIC_FIREBASE_PROJECT_ID (${clientId}).`,
    );
  }
  return projectId;
}

function buildCredential(projectId: string): Credential {
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;
  if (Boolean(clientEmail) !== Boolean(privateKeyRaw)) {
    throw new FirebaseAdminConfigurationError(
      "Set both FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY, or neither (to use Application Default Credentials).",
    );
  }
  if (clientEmail && privateKeyRaw) {
    // .env files store the PEM with literal \n sequences.
    const privateKey = privateKeyRaw.replace(/\n/g, "\n");
    return cert({ projectId, clientEmail, privateKey });
  }
  try {
    return applicationDefault();
  } catch (err) {
    throw new FirebaseAdminConfigurationError(
      `Application Default Credentials unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** The named admin app; initializes lazily on first use. */
export function getFirebaseAdminApp(): App {
  const existing = getApps().find((app) => app.name === FIREBASE_ADMIN_APP_NAME);
  if (existing) return existing;
  const projectId = resolveProjectId();
  try {
    return initializeApp(
      { credential: buildCredential(projectId), projectId },
      FIREBASE_ADMIN_APP_NAME,
    );
  } catch (err) {
    if (err instanceof FirebaseAdminConfigurationError) throw err;
    throw new FirebaseAdminConfigurationError(
      `Firebase Admin initialization failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function getFirebaseAdminAuth(): Auth {
  return getAuth(getFirebaseAdminApp());
}

export function getFirebaseAdminFirestore(): Firestore {
  return getFirestore(getFirebaseAdminApp());
}

/** Verify a Firebase ID token with the revocation check enabled. */
export async function verifyFirebaseIdToken(token: string): Promise<DecodedIdToken> {
  return getFirebaseAdminAuth().verifyIdToken(token, true);
}
