/**
 * Credential-free ID token verification (verify-token.ts).
 *
 * Every case here is an authentication bypass that `jwtVerify` alone lets
 * through — a token with no `exp`, a future `iat`, a future `auth_time`, an
 * empty `sub`, an array `aud`. Tokens are minted with a locally generated RSA
 * key and the module's JWKS fetch is stubbed to serve that key, so these
 * exercise the real jose code path with no network and no Firebase project.
 */

import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const PROJECT_ID = "test-project";
const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;
const KID = "test-key";

let privateKey: CryptoKey;
let jwks: { keys: unknown[] };

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  jwks = { keys: [{ ...publicJwk, kid: KID, alg: "RS256", use: "sig" }] };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** Serve our generated key wherever jose asks for Google's JWKS. */
function stubJwks(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(jwks), { status: 200 })),
  );
}

const now = () => Math.floor(Date.now() / 1000);

/** Mint a token, defaulting every claim to a valid one. */
async function mintToken(claims: Record<string, unknown> = {}): Promise<string> {
  const payload: Record<string, unknown> = {
    auth_time: now() - 60,
    email: "someone@example.com",
    email_verified: true,
    ...claims,
  };
  let jwt = new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: KID });
  // A key absent from `claims` gets the valid default; an explicit
  // `undefined` omits the claim entirely, which is what the bypasses need.
  if (!("iss" in claims)) jwt = jwt.setIssuer(ISSUER);
  else if (claims.iss !== undefined) jwt = jwt.setIssuer(String(claims.iss));
  if (!("aud" in claims)) jwt = jwt.setAudience(PROJECT_ID);
  if (!("sub" in claims)) jwt = jwt.setSubject("uid-1");
  if (!("iat" in claims)) jwt = jwt.setIssuedAt(now() - 60);
  if (!("exp" in claims)) jwt = jwt.setExpirationTime(now() + 3600);
  return jwt.sign(privateKey);
}

async function verify(token: string) {
  stubJwks();
  const { verifyFirebaseIdTokenOffline } = await import("./verify-token");
  return verifyFirebaseIdTokenOffline(token, PROJECT_ID);
}

async function expectRejected(token: string): Promise<string> {
  try {
    await verify(token);
  } catch (err) {
    return (err as { code: string }).code;
  }
  throw new Error("expected verification to be refused, but it succeeded");
}

describe("verifyFirebaseIdTokenOffline — the happy path", () => {
  it("accepts a well-formed token and returns its claims", async () => {
    const claims = await verify(await mintToken());
    expect(claims.sub).toBe("uid-1");
    expect(claims.email).toBe("someone@example.com");
    expect(claims.email_verified).toBe(true);
  });
});

describe("the five bypasses jwtVerify alone would allow", () => {
  it("refuses a token with NO exp — it would otherwise never expire", async () => {
    expect(await expectRejected(await mintToken({ exp: undefined }))).toBe("auth/argument-error");
  });

  it("refuses a token whose iat is in the future", async () => {
    expect(await expectRejected(await mintToken({ iat: now() + 99_999 }))).toBe(
      "auth/argument-error",
    );
  });

  it("refuses a token whose auth_time is in the future", async () => {
    expect(await expectRejected(await mintToken({ auth_time: now() + 99_999 }))).toBe(
      "auth/argument-error",
    );
  });

  it("refuses an empty sub — the uid must actually name somebody", async () => {
    expect(await expectRejected(await mintToken({ sub: "" }))).toBe("auth/argument-error");
  });

  it("refuses an ARRAY aud, even one containing the project id", async () => {
    // jose's audience check passes on any overlap; a real Firebase token
    // always carries a bare string.
    expect(await expectRejected(await mintToken({ aud: [PROJECT_ID, "evil"] }))).toBe(
      "auth/argument-error",
    );
  });
});

describe("the checks jose does make", () => {
  it("refuses an expired token with the expiry code", async () => {
    expect(await expectRejected(await mintToken({ exp: now() - 10 }))).toBe(
      "auth/id-token-expired",
    );
  });

  it("refuses a token minted for another Firebase project", async () => {
    expect(await expectRejected(await mintToken({ aud: "other-project" }))).toBe(
      "auth/argument-error",
    );
  });

  it("refuses a token from another issuer", async () => {
    expect(
      await expectRejected(await mintToken({ iss: "https://securetoken.google.com/other" })),
    ).toBe("auth/argument-error");
  });

  it("refuses a token signed by a key that is not Google's", async () => {
    const stranger = await generateKeyPair("RS256", { extractable: true });
    const forged = await new SignJWT({ auth_time: now() - 60 })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(ISSUER)
      .setAudience(PROJECT_ID)
      .setSubject("uid-1")
      .setIssuedAt(now() - 60)
      .setExpirationTime(now() + 3600)
      .sign(stranger.privateKey);
    expect(await expectRejected(forged)).toBe("auth/argument-error");
  });

  it("refuses garbage that is not a JWT at all", async () => {
    expect(await expectRejected("not-a-token")).toBe("auth/argument-error");
  });
});

describe("backend failures are not the caller's fault", () => {
  it("reports a key-fetch failure as unavailable, not as a bad token", async () => {
    const token = await mintToken();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    const { verifyFirebaseIdTokenOffline, KEY_UNAVAILABLE_CODE } = await import("./verify-token");
    await expect(verifyFirebaseIdTokenOffline(token, PROJECT_ID)).rejects.toMatchObject({
      code: KEY_UNAVAILABLE_CODE,
    });
  });
});
