import "server-only";

/**
 * Account lookup against the authoritative Firestore `users` collection
 * (SQLite only mirrors people who have already acted, so it cannot answer
 * "who is there?").
 *
 * The name lookups key on `usernameLower` — the field the sign-in form and the
 * High Quota HQ site already search — never on the display-cased `username`.
 * The reference admin panel searches lowercase but then ACTS on an exact-case
 * `username`, so a correct-but-wrong-cased entry fails with a confusing "user
 * not found"; here one field answers both questions.
 *
 * **Two backends.** With service-account credentials these run through the
 * Admin SDK and bypass Security Rules. Without them they run over REST as the
 * CALLER (`idToken`), so the rules decide — and unlike the caller's own
 * profile, these read OTHER people's documents, which rules may well refuse.
 * A refusal surfaces as an error rather than an empty result, so the console
 * says "unavailable" instead of quietly claiming nobody matched.
 */

import { isManagerUsername } from "@/lib/roles";

import { normalizeProfile } from "./server";
import type { AuthProfile } from "./types";

/** One row of the admin username picker. */
export interface UserSuggestion {
  uid: string;
  username: string;
  banned: boolean;
}

/** Suggestions per query — matches /api/search/suggest's ceiling. */
export const USER_SUGGEST_LIMIT = 8;

/**
 * Upper sentinel of a Firestore prefix range. U+F8FF sits in a private-use
 * area above every character a username may contain, so `[term, term+F8FF]`
 * is exactly the set of strings starting with `term`.
 */
const PREFIX_END = "\uf8ff";

function profilesOf(
  docs: readonly { id: string; data: () => Record<string, unknown> }[],
): AuthProfile[] {
  return docs.map((doc) => normalizeProfile(doc.id, doc.data()));
}

/** REST rows carry decoded fields already; normalize them the same way. */
function profilesOfRows(
  rows: readonly { id: string; fields: Record<string, unknown> }[],
): AuthProfile[] {
  return rows.map((row) => normalizeProfile(row.id, row.fields));
}

/**
 * Accounts whose name starts with `query`, case-insensitively.
 *
 * Firestore has no prefix operator, so this is the standard range scan:
 * everything at or after the term, up to the term plus the highest code point.
 * An empty query yields nothing rather than the whole collection.
 */
export async function suggestUsers(
  query: string,
  limit: number = USER_SUGGEST_LIMIT,
  idToken?: string,
): Promise<UserSuggestion[]> {
  const term = query.trim().toLowerCase();
  if (!term) return [];

  const { usingAdminSdk, firebaseProjectId } = await import("@/lib/firebase/backend");

  if (!usingAdminSdk()) {
    if (!idToken) return [];
    const { restRunQuery, stringValue } = await import("@/lib/firebase/firestore-rest");
    const rows = await restRunQuery(
      firebaseProjectId(),
      "users",
      {
        orderBy: [{ field: { fieldPath: "usernameLower" }, direction: "ASCENDING" }],
        // `before: true` on startAt is inclusive; `before: false` on endAt is
        // inclusive too — the polarity differs between the two, deliberately.
        startAt: { values: [stringValue(term)], before: true },
        endAt: { values: [stringValue(`${term}${PREFIX_END}`)], before: false },
        limit,
      },
      idToken,
    );
    return profilesOfRows(rows).map((profile) => ({
      uid: profile.uid,
      username: profile.username,
      banned: profile.banned,
    }));
  }

  const { getFirebaseAdminFirestore } = await import("@/lib/firebase/admin");
  const snap = await getFirebaseAdminFirestore()
    .collection("users")
    .orderBy("usernameLower")
    .startAt(term)
    .endAt(`${term}${PREFIX_END}`)
    .limit(limit)
    .get();

  return profilesOf(snap.docs).map((profile) => ({
    uid: profile.uid,
    username: profile.username,
    banned: profile.banned,
  }));
}

/**
 * The one account named `username`, or null when the name names nobody — or,
 * deliberately, more than one. `limit(2)` rather than `limit(1)`: one document
 * is the answer and two is the refusal, the same rule sign-in uses
 * (src/lib/auth/identifier.ts). Banning whichever duplicate came back first is
 * exactly the failure that rule exists to prevent.
 */
export async function findUserByUsername(
  username: string,
  idToken?: string,
): Promise<AuthProfile | null> {
  const term = username.trim().toLowerCase();
  if (!term) return null;

  const { usingAdminSdk, firebaseProjectId } = await import("@/lib/firebase/backend");

  if (!usingAdminSdk()) {
    if (!idToken) return null;
    const { restRunQuery, stringValue } = await import("@/lib/firebase/firestore-rest");
    const rows = await restRunQuery(
      firebaseProjectId(),
      "users",
      {
        where: {
          fieldFilter: {
            field: { fieldPath: "usernameLower" },
            op: "EQUAL",
            value: stringValue(term),
          },
        },
        limit: 2,
      },
      idToken,
    );
    const profiles = profilesOfRows(rows);
    return profiles.length === 1 ? profiles[0] : null;
  }

  const { getFirebaseAdminFirestore } = await import("@/lib/firebase/admin");
  const snap = await getFirebaseAdminFirestore()
    .collection("users")
    .where("usernameLower", "==", term)
    .limit(2)
    .get();

  const profiles = profilesOf(snap.docs);
  return profiles.length === 1 ? profiles[0] : null;
}

/**
 * The account with this uid, or null when there is none. The uid IS the
 * document key, so this is the unambiguous lookup a username can never be —
 * which is why the ban route prefers it whenever the picker supplies one.
 */
export async function findUserByUid(
  uid: string,
  idToken?: string,
): Promise<AuthProfile | null> {
  const id = uid.trim();
  if (!id) return null;

  const { usingAdminSdk, firebaseProjectId } = await import("@/lib/firebase/backend");

  if (!usingAdminSdk()) {
    if (!idToken) return null;
    const { restGetDocument } = await import("@/lib/firebase/firestore-rest");
    const fields = await restGetDocument(firebaseProjectId(), `users/${id}`, idToken);
    return fields === null ? null : normalizeProfile(id, fields);
  }

  const { getFirebaseAdminFirestore } = await import("@/lib/firebase/admin");
  const snap = await getFirebaseAdminFirestore().doc(`users/${id}`).get();
  if (!snap.exists) return null;
  return normalizeProfile(snap.id, snap.data() ?? {});
}

/** Set the authoritative Firestore ban flag, leaving every other field alone. */
export async function setFirestoreBanned(
  uid: string,
  banned: boolean,
  idToken?: string,
): Promise<void> {
  const { usingAdminSdk, firebaseProjectId } = await import("@/lib/firebase/backend");

  if (!usingAdminSdk()) {
    if (!idToken) {
      throw new Error("A caller token is required to write the ban flag without credentials.");
    }
    const { restPatchDocument, booleanValue } = await import("@/lib/firebase/firestore-rest");
    // An update mask is mandatory: without one Firestore REPLACES the whole
    // document, which would erase the account's username and roles.
    await restPatchDocument(
      firebaseProjectId(),
      `users/${uid}`,
      { banned: booleanValue(banned) },
      idToken,
    );
    return;
  }

  const { getFirebaseAdminFirestore } = await import("@/lib/firebase/admin");
  await getFirebaseAdminFirestore().doc(`users/${uid}`).set({ banned }, { merge: true });
}

/**
 * The other half of the bootstrap-owner hatch (src/lib/roles.ts
 * MANAGER_USERNAMES): does `profile` actually OWN a manager username?
 *
 * A name alone proves nothing — the register form writes `usernameLower` from
 * the browser, so anyone could claim one. This asks Firestore whether exactly
 * one account holds the name and whether that account is this one. Two
 * claimants make the name ambiguous and the hatch shuts for both, which is the
 * safe direction: the genuine owner still reaches the console through the
 * Manager role, while an impostor gains nothing by registering the name.
 *
 * Returns false — never throws — when the lookup itself fails: a backend
 * hiccup, or Security Rules refusing the collection query on the
 * credential-free path, must not hand out manager rights.
 */
export async function resolvesManagerUsername(
  profile: AuthProfile,
  idToken?: string,
): Promise<boolean> {
  if (!isManagerUsername(profile.usernameLower)) return false;
  try {
    const owner = await findUserByUsername(profile.usernameLower, idToken);
    return owner !== null && owner.uid === profile.uid;
  } catch {
    return false;
  }
}
