import "server-only";

/**
 * The two ways this server can talk to Firebase, and how it chooses.
 *
 * WITH service-account credentials it uses the Admin SDK: token verification
 * includes the revocation check, and Firestore reads and writes bypass
 * Security Rules. WITHOUT them it verifies tokens against Google's published
 * signing keys (src/lib/firebase/verify-token.ts) and reaches Firestore over
 * REST with the CALLER'S own ID token (src/lib/firebase/firestore-rest.ts).
 *
 * The credential-free path is a real fallback, not a pretend one — it is how
 * the wiki runs with nothing secret configured — but it is weaker in two
 * honest ways, and callers should know which:
 *
 *   1. **No revocation check.** A signed-out or password-reset session, and a
 *      Firebase-disabled account, stay accepted until the ID token expires on
 *      its own (≤ 1 hour). The wiki's own ban is NOT affected: that is the
 *      Firestore `banned` flag, re-read on every request.
 *   2. **Security Rules apply.** Reads and writes are only as permitted as the
 *      caller is. Reading your own `users/{uid}` is fine everywhere; touching
 *      OTHER users' documents — the admin console's username search and its ban
 *      write — depends on rules this repository does not contain.
 *
 * Adding credentials later strictly upgrades every one of these, with no code
 * change: `hasFirebaseAdminCredentials()` is consulted per call, never cached.
 */

import { hasFirebaseAdminCredentials } from "@/lib/env";

/** Project the tokens must be minted for; public, and shared with the client. */
export function firebaseProjectId(): string {
  return (
    process.env.FIREBASE_PROJECT_ID?.trim() ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim() ||
    "highquotahq214"
  );
}

/** True when the Admin SDK can be used; false selects the REST fallback. */
export function usingAdminSdk(): boolean {
  return hasFirebaseAdminCredentials();
}
