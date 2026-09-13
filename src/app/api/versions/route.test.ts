/**
 * /api/versions — the editor-facing half of the registry (versioning.md §1,
 * visual-editor.md §5.3). POST is open to any SIGNED-IN editor (see the
 * route's own note), which makes the id the remaining gate: every row it
 * writes lands in the table `loadVersionTable` reads on every page render, and
 * its `ordinal` is what all of §1's range math and every selector sorts on.
 */

import { describe, expect, it, vi } from "vitest";

import type { WikiDb } from "@/lib/db/client";

vi.mock("server-only", () => ({}));

// The route calls getDb(); give it a throwaway in-memory database.
vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  const db = actual.createDb(":memory:");
  return { ...actual, getDb: () => db, __testDb: db };
});

// Editing requires a signed-in account; stand in for the Firebase round trip
// so these tests are about the id rules, not about token verification.
vi.mock("@/lib/auth/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return {
    ...actual,
    requirePrincipal: async () => ({
      user: {
        uid: "u-editor",
        email: "editor@example.com",
        emailVerified: true,
        displayName: "Editor",
        photoURL: null,
      },
      profile: {
        uid: "u-editor",
        username: "Editor",
        usernameLower: "editor",
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

const { GET, POST } = await import("./route");
const { loadVersionTable, seedLanguages, seedVersions } = await import("@/lib/db/store");
const db = ((await import("@/lib/db/client")) as unknown as { __testDb: WikiDb }).__testDb;

seedLanguages(db);
seedVersions(db);

interface ErrorBody {
  error: { code: string; message: string };
}
interface CreatedBody {
  version: { id: string; ordinal: number; status: string };
  created: boolean;
}

function createRequest(body: unknown): Request {
  return new Request("http://localhost/api/versions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/versions", () => {
  it("registers a version the registry has not caught up to", async () => {
    const res = await POST(createRequest({ id: "V71" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreatedBody;
    expect(body.created).toBe(true);
    expect(body.version.id).toBe("v71");
    expect(body.version.ordinal).toBe(71000);
    expect(body.version.status).toBe("legacy");
  });

  it("refuses an id whose ordinal would not be a sort key", async () => {
    // `v` + 400 digits matches `^v\d+$`, and `Number(major) * 1000` is then
    // Infinity — which better-sqlite3 stores in the INTEGER column and which
    // sorts above every real version in every article's selector.
    const res = await POST(createRequest({ id: `v${"9".repeat(400)}` }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.code).toBe("validation-error");

    const table = loadVersionTable(db);
    expect(table.ordered.every((entry) => Number.isSafeInteger(entry.ordinal))).toBe(true);
    expect(table.ordered[table.ordered.length - 1]?.id).toBe("v71");
  });

  it("still accepts the widest id a patch could plausibly need", async () => {
    const res = await POST(createRequest({ id: "v64.1" }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as CreatedBody).version.ordinal).toBe(64001);
  });

  it("lists what it wrote, and nothing with a bogus ordinal", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { versions: { id: string; ordinal: number }[] };
    expect(body.versions.map((v) => v.id)).toContain("v71");
    expect(body.versions.every((v) => Number.isSafeInteger(v.ordinal))).toBe(true);
  });
});
