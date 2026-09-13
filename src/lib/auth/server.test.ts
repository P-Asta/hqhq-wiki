import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDb, type WikiDb } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { grantAdmin, setUserBanned } from "@/lib/db/store";

import type { AuthProfile } from "./types";
import {
  AdminRequiredError,
  AuthBackendUnavailableError,
  AuthRequiredError,
  BannedError,
  InvalidTokenError,
  ProfileNotFoundError,
  authenticateAdminRequest,
  authenticateManagerRequest,
  authenticateRequest,
  ManagerRequiredError,
  requirePrincipal,
  bearerToken,
  normalizeProfile,
  parseAdminRoles,
  type AuthDeps,
  type VerifiedToken,
} from "./server";

vi.mock("server-only", () => ({}));

const admin = { uid: "u-admin", displayName: "Admin" };

function makeRequest(authorization?: string): Request {
  return new Request("http://localhost/api/test", {
    headers: authorization ? { authorization } : undefined,
  });
}

function makeVerified(uid: string, overrides: Partial<VerifiedToken> = {}): VerifiedToken {
  return {
    uid,
    email: `${uid}@example.com`,
    emailVerified: true,
    displayName: `Name of ${uid}`,
    photoURL: null,
    ...overrides,
  };
}

function makeProfile(uid: string, overrides: Partial<AuthProfile> = {}): AuthProfile {
  return {
    uid,
    username: `User-${uid}`,
    usernameLower: `user-${uid}`,
    roles: [],
    banned: false,
    profilePicture: null,
    ...overrides,
  };
}

describe("bearerToken", () => {
  it("returns null without an Authorization header", () => {
    expect(bearerToken(makeRequest())).toBeNull();
  });

  it("returns null for a non-Bearer scheme", () => {
    expect(bearerToken(makeRequest("Basic dXNlcjpwdw=="))).toBeNull();
  });

  it("extracts the token case-insensitively", () => {
    expect(bearerToken(makeRequest("bearer abc.def"))).toBe("abc.def");
    expect(bearerToken(makeRequest("Bearer abc.def"))).toBe("abc.def");
  });

  it("throws InvalidTokenError for an empty Bearer token", () => {
    // Note: the Headers API trims trailing whitespace, so "Bearer   "
    // arrives as a bare "Bearer" scheme with no token.
    expect(() => bearerToken(makeRequest("Bearer   "))).toThrow(InvalidTokenError);
    expect(() => bearerToken(makeRequest("Bearer"))).toThrow(InvalidTokenError);
  });
});

describe("parseAdminRoles", () => {
  it("splits, trims and drops empties", () => {
    expect(parseAdminRoles(" admin , wiki-admin ,, ")).toEqual(
      new Set(["admin", "wiki-admin"]),
    );
  });

  it("fails closed on missing or empty input", () => {
    expect(parseAdminRoles(undefined).size).toBe(0);
    expect(parseAdminRoles("").size).toBe(0);
  });
});

describe("normalizeProfile", () => {
  it("normalizes the Firestore contract shape", () => {
    expect(
      normalizeProfile("u1", {
        username: "Alice",
        usernameLower: "alice",
        roles: ["editor", 42, "admin"],
        banned: false,
        profilePicture: "https://img.example/a.png",
      }),
    ).toEqual({
      uid: "u1",
      username: "Alice",
      usernameLower: "alice",
      roles: ["editor", "admin"],
      banned: false,
      profilePicture: "https://img.example/a.png",
    });
  });

  it("defaults missing fields safely", () => {
    expect(normalizeProfile("u1", {})).toEqual({
      uid: "u1",
      username: "u1",
      usernameLower: "u1",
      roles: [],
      banned: false,
      profilePicture: null,
    });
  });
});

describe("authenticateRequest", () => {
  let db: WikiDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  function deps(overrides: Partial<AuthDeps> = {}): AuthDeps {
    return {
      verifyIdToken: async () => makeVerified("u1"),
      loadProfile: async (uid) => makeProfile(uid),
      db,
      adminRoles: "admin,wiki-admin",
      ...overrides,
    };
  }

  it("returns null for anonymous requests without calling verify", async () => {
    const verifyIdToken = vi.fn();
    const principal = await authenticateRequest(makeRequest(), {
      deps: deps({ verifyIdToken }),
    });
    expect(principal).toBeNull();
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it("maps auth/* verification failures to 401 invalid-token", async () => {
    const err = Object.assign(new Error("expired"), { code: "auth/id-token-expired" });
    await expect(
      authenticateRequest(makeRequest("Bearer bad"), {
        deps: deps({ verifyIdToken: async () => Promise.reject(err) }),
      }),
    ).rejects.toMatchObject({ status: 401, code: "invalid-token" });
  });

  it("maps missing admin credentials to 503 auth-unavailable", async () => {
    const err = Object.assign(new Error("no creds"), { code: "FIREBASE_ADMIN_NOT_CONFIGURED" });
    await expect(
      authenticateRequest(makeRequest("Bearer tok"), {
        deps: deps({ verifyIdToken: async () => Promise.reject(err) }),
      }),
    ).rejects.toBeInstanceOf(AuthBackendUnavailableError);
  });

  it("maps unknown verification failures to 503 auth-unavailable", async () => {
    await expect(
      authenticateRequest(makeRequest("Bearer tok"), {
        deps: deps({ verifyIdToken: async () => Promise.reject(new Error("boom")) }),
      }),
    ).rejects.toBeInstanceOf(AuthBackendUnavailableError);
  });

  it("throws 403 profile-not-found when the profile is missing (registration race)", async () => {
    await expect(
      authenticateRequest(makeRequest("Bearer tok"), {
        deps: deps({ loadProfile: async () => null }),
      }),
    ).rejects.toMatchObject({ status: 403, code: "profile-not-found" });
  });

  it("wraps profile load failures as 503", async () => {
    await expect(
      authenticateRequest(makeRequest("Bearer tok"), {
        deps: deps({ loadProfile: async () => Promise.reject(new Error("firestore down")) }),
      }),
    ).rejects.toBeInstanceOf(AuthBackendUnavailableError);
  });

  it("rejects banned users", async () => {
    await expect(
      authenticateRequest(makeRequest("Bearer tok"), {
        deps: deps({ loadProfile: async (uid) => makeProfile(uid, { banned: true }) }),
      }),
    ).rejects.toBeInstanceOf(BannedError);
  });

  it("resolves a plain editor principal with isAdmin false", async () => {
    const principal = await authenticateRequest(makeRequest("Bearer tok"), { deps: deps() });
    expect(principal).toEqual({
      user: {
        uid: "u1",
        email: "u1@example.com",
        emailVerified: true,
        displayName: "Name of u1",
        photoURL: null,
      },
      profile: makeProfile("u1"),
      roles: [],
      isAdmin: false,
      canAccessAdminPanel: false,
    });
  });

  it("grants admin via a bootstrap Firestore role", async () => {
    const principal = await authenticateRequest(makeRequest("Bearer tok"), {
      deps: deps({ loadProfile: async (uid) => makeProfile(uid, { roles: ["wiki-admin"] }) }),
    });
    expect(principal?.isAdmin).toBe(true);
    expect(principal?.roles).toEqual(["wiki-admin"]);
  });

  it("fails closed when WIKI_ADMIN_ROLES is empty", async () => {
    const principal = await authenticateRequest(makeRequest("Bearer tok"), {
      deps: deps({
        adminRoles: "",
        loadProfile: async (uid) => makeProfile(uid, { roles: ["admin"] }),
      }),
    });
    expect(principal?.isAdmin).toBe(false);
  });

  it("grants admin via an active SQLite grant", async () => {
    grantAdmin(db, { uid: "u1", grantedBy: admin });
    const principal = await authenticateRequest(makeRequest("Bearer tok"), { deps: deps() });
    expect(principal?.isAdmin).toBe(true);
  });

  it("a SQLite ban voids an active grant", async () => {
    grantAdmin(db, { uid: "u1", grantedBy: admin });
    setUserBanned(db, { uid: "u1", banned: true, actor: admin });
    const principal = await authenticateRequest(makeRequest("Bearer tok"), { deps: deps() });
    expect(principal?.isAdmin).toBe(false);
  });

  it("upserts the users mirror only on forWrite", async () => {
    await authenticateRequest(makeRequest("Bearer tok"), { deps: deps() });
    expect(db.select().from(users).where(eq(users.uid, "u1")).get()).toBeUndefined();

    await authenticateRequest(makeRequest("Bearer tok"), { deps: deps(), forWrite: true });
    const row = db.select().from(users).where(eq(users.uid, "u1")).get();
    expect(row?.displayName).toBe("User-u1");
  });
});

describe("authenticateAdminRequest", () => {
  let db: WikiDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  function deps(overrides: Partial<AuthDeps> = {}): AuthDeps {
    return {
      verifyIdToken: async () => makeVerified("u1"),
      loadProfile: async (uid) => makeProfile(uid),
      db,
      adminRoles: "admin",
      ...overrides,
    };
  }

  it("rejects anonymous requests with 401 auth-required", async () => {
    await expect(
      authenticateAdminRequest(makeRequest(), { deps: deps() }),
    ).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it("rejects authenticated non-admins with 403 admin-required", async () => {
    await expect(
      authenticateAdminRequest(makeRequest("Bearer tok"), { deps: deps() }),
    ).rejects.toBeInstanceOf(AdminRequiredError);
  });

  it("returns the principal for an admin", async () => {
    grantAdmin(db, { uid: "u1", grantedBy: admin });
    const principal = await authenticateAdminRequest(makeRequest("Bearer tok"), {
      deps: deps(),
    });
    expect(principal.isAdmin).toBe(true);
    expect(principal.user.uid).toBe("u1");
  });

  it("banned users are rejected before any admin evaluation", async () => {
    grantAdmin(db, { uid: "u1", grantedBy: admin });
    await expect(
      authenticateAdminRequest(makeRequest("Bearer tok"), {
        deps: deps({ loadProfile: async (uid) => makeProfile(uid, { banned: true }) }),
      }),
    ).rejects.toBeInstanceOf(BannedError);
  });

  it("propagates profile-not-found", async () => {
    await expect(
      authenticateAdminRequest(makeRequest("Bearer tok"), {
        deps: deps({ loadProfile: async () => null }),
      }),
    ).rejects.toBeInstanceOf(ProfileNotFoundError);
  });
});


/* ------------------------------------------------------------------ */
/* requirePrincipal + the manager gate                                 */
/* ------------------------------------------------------------------ */

describe("requirePrincipal", () => {
  let db: WikiDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  function deps(overrides: Partial<AuthDeps> = {}): AuthDeps {
    return {
      verifyIdToken: async () => makeVerified("u1"),
      loadProfile: async (uid) => makeProfile(uid),
      db,
      adminRoles: "admin",
      ...overrides,
    };
  }

  it("refuses an anonymous request — there is no anonymous editing", async () => {
    await expect(
      requirePrincipal(makeRequest(), { deps: deps() }),
    ).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it("returns the principal for a signed-in account", async () => {
    const principal = await requirePrincipal(makeRequest("Bearer tok"), { deps: deps() });
    expect(principal.user.uid).toBe("u1");
  });

  it("still refuses a banned account", async () => {
    await expect(
      requirePrincipal(makeRequest("Bearer tok"), {
        deps: deps({ loadProfile: async (uid) => makeProfile(uid, { banned: true }) }),
      }),
    ).rejects.toBeInstanceOf(BannedError);
  });
});

describe("authenticateManagerRequest", () => {
  let db: WikiDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  function deps(profile: Partial<AuthProfile>, overrides: Partial<AuthDeps> = {}): AuthDeps {
    return {
      verifyIdToken: async () => makeVerified("u1"),
      loadProfile: async (uid) => makeProfile(uid, profile),
      db,
      adminRoles: "admin",
      // Fails closed by default, so a test that does not opt in never reaches
      // the real Firestore — and never passes by accident.
      ownsManagerUsername: async () => false,
      ...overrides,
    };
  }

  it("accepts the Manager role (stored as `admin`)", async () => {
    const principal = await authenticateManagerRequest(makeRequest("Bearer tok"), {
      deps: deps({ roles: ["admin"] }),
    });
    expect(principal.canAccessAdminPanel).toBe(true);
  });

  it("accepts a manager username only when the account solely owns it", async () => {
    const principal = await authenticateManagerRequest(makeRequest("Bearer tok"), {
      deps: deps(
        { username: "Asta", usernameLower: "asta" },
        { ownsManagerUsername: async () => true },
      ),
    });
    expect(principal.canAccessAdminPanel).toBe(true);
  });

  it("refuses an impostor who merely registered the manager name", async () => {
    // The register form writes usernameLower from the browser, so claiming the
    // name proves nothing; sole ownership is what the server checks, and a
    // second claimant makes the name ambiguous for everyone.
    await expect(
      authenticateManagerRequest(makeRequest("Bearer tok"), {
        deps: deps(
          { username: "Asta", usernameLower: "asta" },
          { ownsManagerUsername: async () => false },
        ),
      }),
    ).rejects.toBeInstanceOf(ManagerRequiredError);
  });

  it("never asks about ownership for a name that is not on the list", async () => {
    let asked = false;
    await expect(
      authenticateManagerRequest(makeRequest("Bearer tok"), {
        deps: deps(
          { username: "Someone", usernameLower: "someone" },
          {
            ownsManagerUsername: async () => {
              asked = true;
              return true;
            },
          },
        ),
      }),
    ).rejects.toBeInstanceOf(ManagerRequiredError);
    expect(asked).toBe(false);
  });

  it("takes the role path without any ownership lookup", async () => {
    let asked = false;
    const principal = await authenticateManagerRequest(makeRequest("Bearer tok"), {
      deps: deps(
        { roles: ["admin"], username: "Asta", usernameLower: "asta" },
        {
          ownsManagerUsername: async () => {
            asked = true;
            return true;
          },
        },
      ),
    });
    expect(principal.canAccessAdminPanel).toBe(true);
    expect(asked).toBe(false);
  });

  it("refuses an ordinary account", async () => {
    await expect(
      authenticateManagerRequest(makeRequest("Bearer tok"), {
        deps: deps({ roles: ["verifier"] }),
      }),
    ).rejects.toBeInstanceOf(ManagerRequiredError);
  });

  it("refuses an admin who is not a manager — a grant is not the Manager role", async () => {
    grantAdmin(db, { uid: "u1", grantedBy: admin, displayName: "User" });
    const request = makeRequest("Bearer tok");
    // The same principal passes the looser admin guard...
    const asAdmin = await authenticateAdminRequest(request, { deps: deps({ roles: [] }) });
    expect(asAdmin.isAdmin).toBe(true);
    // ...but not the console's manager gate.
    await expect(
      authenticateManagerRequest(request, { deps: deps({ roles: [] }) }),
    ).rejects.toBeInstanceOf(ManagerRequiredError);
  });

  it("refuses an anonymous request with 401 before the role check", async () => {
    await expect(
      authenticateManagerRequest(makeRequest(), { deps: deps({ roles: ["admin"] }) }),
    ).rejects.toBeInstanceOf(AuthRequiredError);
  });
});
