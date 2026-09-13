/**
 * Account roles — the single definition of what a role IS in this project.
 *
 * The identifiers, display names, ordering and colors mirror the High Quota HQ
 * site (github.com/lengeddev/highquotahq, js/profile.js) because both apps read
 * the SAME Firestore `users/{uid}.roles` array in the SAME Firebase project.
 * The stored value is what matters: the reference stores `"admin"` and merely
 * PRINTS it as "Manager", so this module does the same — writing "Manager" into
 * Firestore would lock out every existing manager over there.
 *
 * The reference recomputes ad-hoc `roles.includes(...)` chains in two files
 * with two different notions of "admin"; here every question about a role is
 * answered by one of the named predicates below.
 *
 * Universal module: no "server-only", no database, no Firebase — the server
 * guards, the API routes and the client islands all import these.
 */

/** Every role identifier, in the reference's display precedence order. */
export const ROLE_IDS = [
  "admin",
  "site-developer",
  "moderator",
  "verifier",
  "modded-verifier",
] as const;

export type RoleId = (typeof ROLE_IDS)[number];

export interface RoleMeta {
  /** Human-readable name — `admin` prints as "Manager" (reference parity). */
  label: string;
  /** CSS custom property holding this role's badge color (globals.css). */
  colorVar: string;
}

/** Display metadata per role. Keep in sync with globals.css `--role-*`. */
export const ROLE_META: Readonly<Record<RoleId, RoleMeta>> = {
  admin: { label: "Manager", colorVar: "--role-manager" },
  "site-developer": { label: "Site Developer", colorVar: "--role-site-developer" },
  moderator: { label: "Community Moderator", colorVar: "--role-moderator" },
  verifier: { label: "Verifier", colorVar: "--role-verifier" },
  "modded-verifier": { label: "Modded Verifier", colorVar: "--role-modded-verifier" },
};

/**
 * The role that governs this wiki's admin console. Stored as `"admin"`,
 * shown as "Manager" — see the module docblock.
 */
export const MANAGER_ROLE: RoleId = "admin";

/**
 * Usernames that reach the admin console without holding {@link MANAGER_ROLE}.
 * A bootstrap hatch, deliberately tiny: it is how the wiki's owner keeps access
 * if the role array is ever emptied by mistake.
 *
 * A name is NOT proof of identity on its own — the register form writes
 * `usernameLower` from the browser — so this list is only half the rule. The
 * server pairs it with a uniqueness check (`resolvesManagerUsername`,
 * src/lib/auth/users.ts): the hatch opens only when exactly one account in the
 * whole project claims the name AND it is the caller's. A second account
 * registering the same name makes it ambiguous and shuts the hatch for
 * everyone, which is the safe direction — the real owner still has the role.
 */
export const MANAGER_USERNAMES: readonly string[] = ["asta"];

/** Is `value` one of the known role identifiers? */
export function isRoleId(value: unknown): value is RoleId {
  return typeof value === "string" && (ROLE_IDS as readonly string[]).includes(value);
}

/** Keep only known roles, deduped, in {@link ROLE_IDS} order. */
export function sortRoles(roles: readonly string[]): RoleId[] {
  return ROLE_IDS.filter((id) => roles.includes(id));
}

/**
 * A role's display name. Pass the dictionary's `roles` section to get it in
 * the reader's language; without one the English name in {@link ROLE_META} is
 * used. An unknown identifier prints as itself.
 */
export function roleLabel(role: string, labels?: Partial<Record<RoleId, string>>): string {
  if (!isRoleId(role)) return role;
  return labels?.[role] ?? ROLE_META[role].label;
}

/* ------------------------------------------------------------------ */
/* Capability predicates — the only way to ask "may they?"             */
/* ------------------------------------------------------------------ */

/** The identity facts a permission question is answered from. */
export interface RoleIdentity {
  roles: readonly string[];
  /** Firestore profile `usernameLower` (already lower-cased). */
  usernameLower: string;
}

/**
 * Does this account hold the Manager role outright?
 *
 * Deliberately independent of the legacy `admin_grants` table: a grant makes
 * someone an admin for the wiki's own moderation, not a manager. This is the
 * whole rule for anyone but the bootstrap owner.
 */
export function hasManagerRole(identity: RoleIdentity): boolean {
  return identity.roles.includes(MANAGER_ROLE);
}

/**
 * Is this the name of the bootstrap owner? NOT sufficient on its own — the
 * caller must also prove the name is unambiguous and theirs (see
 * {@link MANAGER_USERNAMES}). Never use this as an authorization decision.
 */
export function isManagerUsername(usernameLower: string): boolean {
  return MANAGER_USERNAMES.includes(usernameLower.trim().toLowerCase());
}
