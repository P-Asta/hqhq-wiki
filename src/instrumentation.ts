/**
 * Server startup hook (Next 16 `instrumentation.ts`, run once before the
 * server takes requests).
 *
 * One job: name the auth backend in use. Without service-account credentials
 * the wiki still works — tokens are verified against Google's published keys
 * and Firestore is read as the caller (src/lib/firebase/backend.ts) — but two
 * things are weaker, and a log line at boot is where that belongs rather than
 * in a surprise at the first ban.
 */

import { hasFirebaseAdminCredentials } from "@/lib/env";

export function register(): void {
  // Only the Node runtime has the credentials to look for.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (hasFirebaseAdminCredentials()) return;
  console.warn(
    "[auth] No Firebase Admin credentials: verifying ID tokens against Google's public keys " +
      "and reading Firestore as the caller. Sign-in and editing work. Two caveats — a revoked " +
      "or disabled session stays valid until its token expires (max 1 hour), and the admin " +
      "console's user search and ban write are subject to Firestore security rules. Set " +
      "FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY to lift both.",
  );
}
