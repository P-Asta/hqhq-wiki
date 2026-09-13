/**
 * displayIdentityOf (auth-provider.tsx): who the chrome names when the server
 * could not verify the session.
 *
 * The bug this pins: an account made on the High Quota HQ site has no Firebase
 * Auth display name, so with no Admin credentials the server returns no
 * profile and the header printed "Unknown user" at a signed-in reader.
 */

import type { User } from "firebase/auth";
import { describe, expect, it } from "vitest";

import { displayIdentityOf } from "./auth-provider";

import type { AuthProfile } from "@/lib/auth/types";

function makeUser(overrides: Partial<User> = {}): User {
  return {
    uid: "u1",
    email: "someone@example.com",
    displayName: null,
    photoURL: null,
    ...overrides,
  } as User;
}

function makeProfile(overrides: Partial<AuthProfile> = {}): AuthProfile {
  return {
    uid: "u1",
    username: "Asta",
    usernameLower: "asta",
    roles: ["admin"],
    banned: false,
    profilePicture: "https://img.example/a.png",
    ...overrides,
  };
}

describe("displayIdentityOf", () => {
  it("prefers the profile's username, picture and roles", () => {
    expect(displayIdentityOf(makeUser({ displayName: "Token Name" }), makeProfile())).toEqual({
      name: "Asta",
      picture: "https://img.example/a.png",
      roles: ["admin"],
    });
  });

  it("falls back to the Firebase display name when there is no profile", () => {
    const identity = displayIdentityOf(makeUser({ displayName: "Token Name" }), null);
    expect(identity.name).toBe("Token Name");
    expect(identity.roles).toEqual([]);
  });

  it("falls back to the address's local part — the reference-account case", () => {
    // No profile (server could not verify) and no Firebase display name
    // (never set by the reference site): the email still names this person.
    expect(displayIdentityOf(makeUser(), null).name).toBe("someone");
  });

  it("reports null rather than a wrong name when nothing names the account", () => {
    // The caller prints its own "Unknown user" label for this, and only this.
    expect(displayIdentityOf(makeUser({ email: null }), null).name).toBeNull();
  });

  it("ignores a blank email local part", () => {
    expect(displayIdentityOf(makeUser({ email: "@example.com" }), null).name).toBeNull();
  });

  it("uses the Firebase photo when the profile carries none", () => {
    const identity = displayIdentityOf(
      makeUser({ photoURL: "https://img.example/token.png" }),
      makeProfile({ profilePicture: null }),
    );
    expect(identity.picture).toBe("https://img.example/token.png");
  });

  it("never reports roles it did not get from a profile", () => {
    // Roles drive badges only, but they must not appear from thin air.
    expect(displayIdentityOf(makeUser({ displayName: "Someone" }), null).roles).toEqual([]);
  });
});
