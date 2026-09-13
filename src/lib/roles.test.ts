/** Role definitions and the admin-panel predicate (roles.ts). */

import { describe, expect, it } from "vitest";

import {
  MANAGER_ROLE,
  MANAGER_USERNAMES,
  ROLE_IDS,
  ROLE_META,
  hasManagerRole,
  isManagerUsername,
  isRoleId,
  roleLabel,
  sortRoles,
} from "./roles";

describe("role definitions", () => {
  it("stores `admin` and displays it as Manager — the reference's contract", () => {
    // Writing "Manager" into Firestore would lock out every manager on the
    // High Quota HQ site, which reads the same users collection.
    expect(MANAGER_ROLE).toBe("admin");
    expect(ROLE_META.admin.label).toBe("Manager");
  });

  it("carries display metadata for every role id", () => {
    for (const id of ROLE_IDS) {
      expect(ROLE_META[id].label).toBeTruthy();
      expect(ROLE_META[id].colorVar).toMatch(/^--role-/);
    }
  });

  it("mirrors the reference's role set and precedence order", () => {
    expect([...ROLE_IDS]).toEqual([
      "admin",
      "site-developer",
      "moderator",
      "verifier",
      "modded-verifier",
    ]);
  });
});

describe("isRoleId", () => {
  it("accepts known ids and rejects everything else", () => {
    expect(isRoleId("admin")).toBe(true);
    expect(isRoleId("modded-verifier")).toBe(true);
    expect(isRoleId("Manager")).toBe(false);
    expect(isRoleId("editor")).toBe(false);
    expect(isRoleId(undefined)).toBe(false);
  });
});

describe("sortRoles", () => {
  it("orders by precedence and drops unknown roles", () => {
    expect(sortRoles(["verifier", "editor", "admin"])).toEqual(["admin", "verifier"]);
  });

  it("dedupes and returns an empty list for no known roles", () => {
    expect(sortRoles(["admin", "admin"])).toEqual(["admin"]);
    expect(sortRoles([])).toEqual([]);
    expect(sortRoles(["nonsense"])).toEqual([]);
  });
});

describe("roleLabel", () => {
  it("prints the English display name by default", () => {
    expect(roleLabel("admin")).toBe("Manager");
    expect(roleLabel("site-developer")).toBe("Site Developer");
  });

  it("prefers a dictionary-supplied name when given one", () => {
    expect(roleLabel("admin", { admin: "매니저" })).toBe("매니저");
    // A map missing this role falls back rather than printing nothing.
    expect(roleLabel("verifier", { admin: "매니저" })).toBe("Verifier");
  });

  it("prints an unknown role as itself", () => {
    expect(roleLabel("editor")).toBe("editor");
    expect(roleLabel("editor", { admin: "매니저" })).toBe("editor");
  });
});

describe("hasManagerRole", () => {
  it("admits the Manager role", () => {
    expect(hasManagerRole({ roles: ["admin"], usernameLower: "someone" })).toBe(true);
  });

  it("refuses every other role", () => {
    for (const role of ["site-developer", "moderator", "verifier", "modded-verifier"]) {
      expect(hasManagerRole({ roles: [role], usernameLower: "someone" })).toBe(false);
    }
    expect(hasManagerRole({ roles: [], usernameLower: "someone" })).toBe(false);
  });

  it("is not fooled by the display label as a stored value", () => {
    expect(hasManagerRole({ roles: ["Manager"], usernameLower: "someone" })).toBe(false);
  });

  it("ignores the username entirely — that hatch needs a uniqueness check", () => {
    for (const name of MANAGER_USERNAMES) {
      expect(hasManagerRole({ roles: [], usernameLower: name })).toBe(false);
    }
  });
});

describe("isManagerUsername", () => {
  it("matches case- and whitespace-insensitively", () => {
    for (const name of MANAGER_USERNAMES) {
      expect(isManagerUsername(name)).toBe(true);
      expect(isManagerUsername(name.toUpperCase())).toBe(true);
      expect(isManagerUsername(` ${name} `)).toBe(true);
    }
  });

  it("refuses any other name", () => {
    expect(isManagerUsername("someone")).toBe(false);
    expect(isManagerUsername("")).toBe(false);
    expect(isManagerUsername("asta2")).toBe(false);
  });
});
