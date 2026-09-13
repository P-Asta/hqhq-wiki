/**
 * What the sign-in box was given: an email address, or an account name
 * (reuse-audit §2, "identifier may be email or username").
 *
 * Firebase signs in with an email and nothing else, so a name has to be turned
 * into one first — a `usernameLower` query against `users`, which is the only
 * thing the client Firestore handle is there for (firebase/client.ts). This
 * module is the two decisions in that walk, and it holds no Firebase: the form
 * runs the query, this says what the query was for and what its answer means.
 *
 * Isomorphic on purpose (no "server-only", no SDK imports), like `types.ts`
 * next door — the rule is asserted in node, where there is no browser.
 */

/**
 * Is this an email address rather than an account name?
 *
 * The `@` is the whole test, and it is enough for both directions: no email
 * address is without one, and no account name may carry one — names come from
 * the register form, whose alphabet is letters, digits and `_ . -`. So a
 * reading is never ambiguous, and the one thing this must never do is send a
 * name to Firebase as an address, which fails as `auth/invalid-email` and tells
 * the author their password was wrong.
 */
export function isEmailIdentifier(identifier: string): boolean {
  return identifier.includes("@");
}

/**
 * The alphabet the paragraph above depends on: letters, digits, `_ . -`, at
 * least 3 characters and at most 32. Tested against the LOWER-CASED name, as
 * the reference site does — so `Asta` passes and is stored display-cased while
 * `usernameLower` holds `asta`.
 *
 * This is what keeps `isEmailIdentifier`'s "@ is the whole test" true, and it
 * is also why a name cannot be dressed up to look like somebody else's.
 */
const USERNAME_PATTERN = /^[a-z0-9_.-]{3,32}$/;

/** Why a proposed account name was refused, or null when it is fine. */
export type UsernameRefusal = "too-short" | "too-long" | "bad-characters";

export function checkUsername(username: string): UsernameRefusal | null {
  const name = username.trim().toLowerCase();
  if (name.length < 3) return "too-short";
  if (name.length > 32) return "too-long";
  return USERNAME_PATTERN.test(name) ? null : "bad-characters";
}

/**
 * The address to sign in with, read off the profiles a name matched — or null,
 * which the form shows as "those details are not valid" and nothing more.
 *
 * **Exactly one match, or none of them.** Two accounts answering to one name is
 * a state this wiki does not promise against (a username is not a Firestore
 * key), and signing into whichever the query happened to return first would be
 * signing somebody into an account they did not name. The password still opens
 * only one of the two, but which account the attempt is even *against* would be
 * arbitrary — so an ambiguous name is refused, and the address on it still
 * works.
 *
 * A profile with no address on it is the other refusal: accounts created before
 * the field was written down carry only `{username, usernameLower, …}`, and a
 * name that resolves to nothing is a name that cannot sign in yet.
 */
export function signInEmailOf(profiles: readonly { readonly email?: unknown }[]): string | null {
  if (profiles.length !== 1) return null;
  const email = profiles[0].email;
  if (typeof email !== "string") return null;
  const trimmed = email.trim();
  return trimmed === "" ? null : trimmed;
}
