import "server-only";

/**
 * Firebase ID token verification WITHOUT service-account credentials.
 *
 * Firebase ID tokens are ordinary RS256 JWTs signed by Google, and the keys
 * that verify them are published. The project id is public too (it is in
 * `NEXT_PUBLIC_FIREBASE_PROJECT_ID`), so a server can authenticate its callers
 * with nothing secret at all — which is what makes this wiki usable without a
 * service account.
 *
 * **`jwtVerify` alone is not enough**, and the gaps are not theoretical: each
 * of these was reproduced against jose 6.2.12 before this module was written.
 * Bare `jwtVerify` with `algorithms`/`issuer`/`audience` set will happily
 * accept a token that
 *   - carries no `exp` at all (so it never expires),
 *   - carries an `iat` far in the future,
 *   - carries an `auth_time` in the future (jose never reads that claim),
 *   - carries an empty-string `sub`,
 *   - carries `aud: [projectId, "…"]` as an ARRAY (jose accepts any overlap).
 * Every one of those is an authentication bypass, so `requiredClaims` closes
 * the first and the explicit assertions below close the rest.
 *
 * **What credentials would still buy.** `verifyIdToken(token, true)` in the
 * Admin SDK additionally asks Google whether the session was revoked and
 * whether the Firebase account is disabled. Signature verification cannot know
 * either, so a revoked refresh token or a disabled account stays accepted
 * until the ID token expires on its own — at most one hour. The wiki's OWN ban
 * is unaffected: it is the Firestore `banned` flag, read on every request.
 */

import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from "jose";

/**
 * Google's signing keys in JWKS form. NOT the x509 URL the Firebase docs link
 * to — that one is a flat `{ kid: "-----BEGIN CERTIFICATE-----…" }` map and
 * cannot be handed to `createRemoteJWKSet`.
 */
const FIREBASE_JWKS_URL = new URL(
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
);

/**
 * Module scope on purpose: this object IS the key cache. Building it per
 * request would re-fetch from Google every time. jose ignores Google's
 * `Cache-Control` and uses its own 10-minute cache with a 30-second cooldown,
 * which is stricter than the ~6 hours Google allows — wasteful, never stale.
 */
const JWKS = createRemoteJWKSet(FIREBASE_JWKS_URL, { timeoutDuration: 5_000 });

/** Absorbs ordinary clock drift between this server and Google. */
const CLOCK_TOLERANCE_SECONDS = 5;

/** The claims this module guarantees once it returns. */
export interface FirebaseIdTokenClaims extends JWTPayload {
  sub: string;
  iat: number;
  exp: number;
  auth_time: number;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

/**
 * Verification failure. `code` mirrors the Firebase Admin SDK's `auth/*`
 * vocabulary because `classifyVerifyError` (src/lib/auth/server.ts) keys off
 * that prefix to answer 401 rather than 503 — everything here is the caller's
 * problem except `key-unavailable`, which is Google's.
 */
export class FirebaseTokenError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "FirebaseTokenError";
  }
}

/** Google could not be reached for its keys — a 503, not a bad token. */
export const KEY_UNAVAILABLE_CODE = "firebase-keys-unavailable";

function claimError(message: string): FirebaseTokenError {
  return new FirebaseTokenError("auth/argument-error", message);
}

/** A bare `JOSEError` — jose raises it only when the JWKS fetch itself fails. */
function isGenericJoseError(err: unknown): boolean {
  return (
    err instanceof errors.JOSEError &&
    (err as { code?: unknown }).code === "ERR_JOSE_GENERIC"
  );
}

/**
 * Verify `idToken` for `projectId` and return its claims.
 *
 * Throws {@link FirebaseTokenError} — never resolves for a token this cannot
 * fully vouch for.
 */
export async function verifyFirebaseIdTokenOffline(
  idToken: string,
  projectId: string,
): Promise<FirebaseIdTokenClaims> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, JWKS, {
      // Google signs with RS256; jose never accepts alg:"none" regardless.
      algorithms: ["RS256"],
      // `iss` is a URL, `aud` is the bare project id — they differ on purpose.
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      // Presence only. jose checks exp/iat/sub when they exist and skips them
      // silently when they do not, so absence has to be an error here.
      requiredClaims: ["exp", "iat", "sub", "auth_time"],
    }));
  } catch (err) {
    if (err instanceof errors.JWTExpired) {
      throw new FirebaseTokenError("auth/id-token-expired", "The ID token has expired.", {
        cause: err,
      });
    }
    if (
      err instanceof errors.JWKSNoMatchingKey ||
      err instanceof errors.JWKSMultipleMatchingKeys ||
      err instanceof errors.JWKSTimeout ||
      err instanceof errors.JWKSInvalid ||
      // A non-200 or unparseable JWKS response raises the BASE class, and jose
      // raises it bare from nowhere else — every token-level failure has its
      // own subclass. So a generic code here means Google, not the caller.
      isGenericJoseError(err)
    ) {
      // Google is unreachable or rotating; the caller is not at fault.
      throw new FirebaseTokenError(
        KEY_UNAVAILABLE_CODE,
        "Could not reach Google for the Firebase signing keys.",
        { cause: err },
      );
    }
    throw new FirebaseTokenError("auth/argument-error", "The ID token is not valid.", {
      cause: err,
    });
  }

  // --- the checks jose does not make -------------------------------------

  const now = Math.floor(Date.now() / 1000) + CLOCK_TOLERANCE_SECONDS;

  // `aud` as an ARRAY containing the project id passes jose's overlap test;
  // a genuine Firebase token always carries a bare string.
  if (typeof payload.aud !== "string") {
    throw claimError('The ID token\'s "aud" claim must be a single project id.');
  }
  // `sub` is the uid. jose's `subject` option is an equality check against a
  // value we do not know yet, and `requiredClaims` only proves presence.
  if (typeof payload.sub !== "string" || payload.sub === "") {
    throw claimError('The ID token\'s "sub" claim must be a non-empty uid.');
  }
  // jose ignores `iat` entirely unless `maxTokenAge` is set.
  if (typeof payload.iat !== "number" || payload.iat > now) {
    throw claimError('The ID token\'s "iat" claim must be in the past.');
  }
  // jose never reads `auth_time`; Firebase requires it in the past.
  const authTime = payload.auth_time;
  if (typeof authTime !== "number" || authTime > now) {
    throw claimError('The ID token\'s "auth_time" claim must be in the past.');
  }
  if (typeof payload.exp !== "number") {
    throw claimError('The ID token\'s "exp" claim must be a number.');
  }

  return payload as FirebaseIdTokenClaims;
}
