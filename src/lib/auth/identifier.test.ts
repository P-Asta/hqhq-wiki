/**
 * The two decisions behind signing in with an account name
 * (user direction, 2026-09-07: "email말고 계정 이름으로도 로그인이 되게").
 */

import { describe, expect, it } from "vitest";

import { checkUsername, isEmailIdentifier, signInEmailOf } from "./identifier";

describe("isEmailIdentifier", () => {
  it("reads an address as an address and a name as a name", () => {
    expect(isEmailIdentifier("astra@example.com")).toBe(true);
    expect(isEmailIdentifier("astra")).toBe(false);
    // The alphabet the register form allows, none of which is an address.
    expect(isEmailIdentifier("astra.moon_1-2")).toBe(false);
  });

  it("does not care about case or the shape of the address", () => {
    // Whether the address is well formed is Firebase's answer, not this one:
    // reading it as an address is what gets the author that answer instead of
    // "no account by that name".
    expect(isEmailIdentifier("ASTRA@Example.COM")).toBe(true);
    expect(isEmailIdentifier("@")).toBe(true);
  });
});

describe("signInEmailOf", () => {
  it("takes the address off the one profile the name matched", () => {
    expect(signInEmailOf([{ email: "astra@example.com" }])).toBe("astra@example.com");
    expect(signInEmailOf([{ email: "  astra@example.com  " }])).toBe("astra@example.com");
  });

  it("refuses a name no account answers to", () => {
    expect(signInEmailOf([])).toBeNull();
  });

  it("refuses a name two accounts answer to", () => {
    // Whichever the query returned first is not the account the author named,
    // and signing into it because it was first is the one outcome to avoid.
    expect(signInEmailOf([{ email: "one@example.com" }, { email: "two@example.com" }])).toBeNull();
  });

  it("refuses a profile with no address written down", () => {
    // Accounts made before the field was written carry a username and nothing
    // to sign in with; the address on the account still works.
    expect(signInEmailOf([{}])).toBeNull();
    expect(signInEmailOf([{ email: null }])).toBeNull();
    expect(signInEmailOf([{ email: "" }])).toBeNull();
    expect(signInEmailOf([{ email: "   " }])).toBeNull();
  });
});

describe("checkUsername", () => {
  it("accepts an ordinary name, any case", () => {
    expect(checkUsername("asta")).toBeNull();
    expect(checkUsername("Asta")).toBeNull();
    expect(checkUsername("gold_bar-1.0")).toBeNull();
  });

  it("refuses a name shorter than 3 or longer than 32", () => {
    expect(checkUsername("ab")).toBe("too-short");
    expect(checkUsername("  a  ")).toBe("too-short");
    expect(checkUsername("x".repeat(33))).toBe("too-long");
    expect(checkUsername("x".repeat(32))).toBeNull();
  });

  it("refuses anything outside a-z 0-9 _ . -", () => {
    expect(checkUsername("has space")).toBe("bad-characters");
    expect(checkUsername("타이탄")).toBe("bad-characters");
    expect(checkUsername("a/b")).toBe("bad-characters");
  });

  it("refuses a name containing @, which keeps isEmailIdentifier's rule true", () => {
    // The whole reason isEmailIdentifier can treat "@" as the entire test.
    expect(checkUsername("someone@example.com")).toBe("bad-characters");
    expect(isEmailIdentifier("someone@example.com")).toBe(true);
  });
});
