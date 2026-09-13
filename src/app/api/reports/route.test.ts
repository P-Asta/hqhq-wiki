/**
 * POST /api/reports — the one moderation action an ordinary editor has.
 *
 * What matters here is the boundary rather than the wording: any signed-in
 * account may file one (that is the point — reporting is everyone's), the
 * report is attributed to the caller and never to whoever the body claims,
 * and the target's own name is not the reporter's to write.
 */

import { describe, expect, it, vi } from "vitest";

import type { WikiDb } from "@/lib/db/client";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  const db = actual.createDb(":memory:");
  return { ...actual, getDb: () => db, __testDb: db };
});

// Stand in for the Firebase round trip: these tests are about what the route
// does with a resolved principal, not about verifying a token.
vi.mock("@/lib/auth/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return {
    ...actual,
    requirePrincipal: async () => ({
      user: {
        uid: "u-alice",
        email: "alice@example.com",
        emailVerified: true,
        displayName: "Alice",
        photoURL: null,
      },
      profile: {
        uid: "u-alice",
        username: "Alice",
        usernameLower: "alice",
        roles: [],
        banned: false,
        profilePicture: null,
      },
      roles: [],
      isAdmin: false,
      canAccessAdminPanel: false,
    }),
  };
});

const { POST } = await import("./route");
const { listReports } = await import("@/lib/db/queries");
const { seedLanguages, seedVersions, setUserBanned } = await import("@/lib/db/store");
const { users } = await import("@/lib/db/schema");
const { eq } = await import("drizzle-orm");
const db = ((await import("@/lib/db/client")) as unknown as { __testDb: WikiDb }).__testDb;

seedLanguages(db);
seedVersions(db);
// Bob exists with a name of his own, written by an action he took.
setUserBanned(db, {
  uid: "u-bob",
  banned: false,
  actor: { uid: "u-mgr", displayName: "Manager" },
  displayName: "Bob",
});

interface ErrorBody {
  error: { code: string; message: string };
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/reports", () => {
  it("lets a plain editor — no roles, not a manager — file one", async () => {
    const res = await POST(
      post({ targetUid: "u-bob", reason: "blanked a page", context: "revision:7" }),
    );
    expect(res.status).toBe(201);

    const [row] = listReports(db, { status: "open" }).rows;
    expect(row.targetUid).toBe("u-bob");
    expect(row.reporterUid).toBe("u-alice");
    expect(row.reason).toBe("blanked a page");
    expect(row.context).toBe("revision:7");
  });

  it("refuses a self-report", async () => {
    const res = await POST(post({ targetUid: "u-alice", reason: "test" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.code).toBe("self-report");
  });

  it("refuses a uid no account holds, instead of creating one", async () => {
    // Without this the uid is a write primitive: any signed-in editor could
    // POST an invented uid and have the report conjure a users row to hang
    // itself on, unbounded, naming an account no manager can then ban.
    const res = await POST(post({ targetUid: "ZZZFAKE001" }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error.code).toBe("user-not-found");

    expect(db.select().from(users).where(eq(users.uid, "ZZZFAKE001")).get()).toBeUndefined();
    expect(listReports(db, {}).rows.every((r) => r.targetUid !== "ZZZFAKE001")).toBe(true);
  });

  it("ignores a display name in the body — the mirror decides who a uid is", async () => {
    const res = await POST(post({ targetUid: "u-bob", targetDisplayName: "Asta" }));
    expect(res.status).toBe(201);

    const stored = db.select().from(users).where(eq(users.uid, "u-bob")).get();
    expect(stored?.displayName).toBe("Bob");
  });

  it("rejects a body with no target", async () => {
    const res = await POST(post({ reason: "no target" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.code).toBe("validation-error");
  });

  it("caps the reason rather than storing an unbounded blob", async () => {
    const res = await POST(post({ targetUid: "u-bob", reason: "x".repeat(5000) }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.code).toBe("validation-error");
  });
});
