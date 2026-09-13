/**
 * Firestore REST client (firestore-rest.ts) — the three encodings that cause
 * most REST bugs: typed values, the non-empty "empty" query result, and the
 * update mask a PATCH must never go without.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  FirestoreRestError,
  decodeFields,
  documentId,
  restGetDocument,
  restPatchDocument,
  restRunQuery,
} from "./firestore-rest";

const PROJECT = "test-project";
const TOKEN = "id-token";

afterEach(() => vi.unstubAllGlobals());

/** Capture the request while answering with `body`. */
function stubFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    }),
  );
  return calls;
}

describe("decodeFields", () => {
  it("decodes every value shape this app reads", () => {
    expect(
      decodeFields({
        username: { stringValue: "Asta" },
        banned: { booleanValue: true },
        profilePicture: { nullValue: null },
        roles: { arrayValue: { values: [{ stringValue: "admin" }] } },
        // int64 arrives as a STRING — decoding it as one is the classic bug.
        editCount: { integerValue: "42" },
      }),
    ).toEqual({
      username: "Asta",
      banned: true,
      profilePicture: null,
      roles: ["admin"],
      editCount: 42,
    });
  });

  it("treats the keys that vanish when empty as empty, not undefined", () => {
    // `values` is absent for [], `fields` for {} — and `fields` itself is
    // absent on a document that has none.
    expect(decodeFields({ roles: { arrayValue: {} } })).toEqual({ roles: [] });
    expect(decodeFields({ meta: { mapValue: {} } })).toEqual({ meta: {} });
    expect(decodeFields(undefined)).toEqual({});
  });
});

describe("documentId", () => {
  it("takes the last path segment — ids can never contain a slash", () => {
    expect(
      documentId("projects/p/databases/(default)/documents/users/AbCd1234"),
    ).toBe("AbCd1234");
  });
});

describe("restGetDocument", () => {
  it("returns decoded fields and sends the caller's bearer token", async () => {
    const calls = stubFetch({
      name: "projects/p/databases/(default)/documents/users/u1",
      fields: { username: { stringValue: "Asta" } },
    });
    const fields = await restGetDocument(PROJECT, "users/u1", TOKEN);
    expect(fields).toEqual({ username: "Asta" });
    expect(calls[0].url).toBe(
      "https://firestore.googleapis.com/v1/projects/test-project/databases/(default)/documents/users/u1",
    );
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      "Bearer id-token",
    );
  });

  it("reads a missing document as null, not as an error", async () => {
    stubFetch({ error: { status: "NOT_FOUND", message: "nope" } }, 404);
    expect(await restGetDocument(PROJECT, "users/ghost", TOKEN)).toBeNull();
  });

  it("throws with Google's status when the rules refuse", async () => {
    stubFetch({ error: { status: "PERMISSION_DENIED", message: "no" } }, 403);
    await expect(restGetDocument(PROJECT, "users/u1", TOKEN)).rejects.toMatchObject({
      status: 403,
      googleStatus: "PERMISSION_DENIED",
    });
  });

  it("still throws usefully when the error body is not JSON", async () => {
    stubFetch("<html>gateway</html>", 502);
    await expect(restGetDocument(PROJECT, "users/u1", TOKEN)).rejects.toBeInstanceOf(
      FirestoreRestError,
    );
  });
});

describe("restRunQuery", () => {
  it("reads an EMPTY result correctly — it is [{readTime}], never []", async () => {
    // The detail that silently breaks naive length checks.
    stubFetch([{ readTime: "2026-09-08T00:00:00Z" }]);
    expect(await restRunQuery(PROJECT, "users", { limit: 2 }, TOKEN)).toEqual([]);
  });

  it("returns id + fields for each document envelope", async () => {
    stubFetch([
      {
        document: {
          name: "projects/p/databases/(default)/documents/users/u1",
          fields: { usernameLower: { stringValue: "asta" } },
        },
        readTime: "2026-09-08T00:00:00Z",
      },
    ]);
    expect(await restRunQuery(PROJECT, "users", {}, TOKEN)).toEqual([
      { id: "u1", fields: { usernameLower: "asta" } },
    ]);
  });

  it("drops non-document envelopes (transaction, skippedResults, done)", async () => {
    stubFetch([
      { transaction: "abc" },
      { skippedResults: 3, readTime: "t" },
      {
        document: { name: "projects/p/databases/(default)/documents/users/u1", fields: {} },
      },
      { done: true, readTime: "t" },
    ]);
    const rows = await restRunQuery(PROJECT, "users", {}, TOKEN);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("u1");
  });

  it("POSTs to the parent path with the collection in the query body", async () => {
    const calls = stubFetch([{ readTime: "t" }]);
    await restRunQuery(PROJECT, "users", { limit: 5 }, TOKEN);
    expect(calls[0].url).toBe(
      "https://firestore.googleapis.com/v1/projects/test-project/databases/(default)/documents:runQuery",
    );
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      structuredQuery: { from: [{ collectionId: "users" }], limit: 5 },
    });
  });
});

describe("restPatchDocument", () => {
  it("sends one repeated updateMask.fieldPaths param per field", async () => {
    const calls = stubFetch({ name: "projects/p/databases/(default)/documents/users/u1" });
    await restPatchDocument(PROJECT, "users/u1", { banned: { booleanValue: true } }, TOKEN);
    const url = new URL(calls[0].url);
    expect(url.searchParams.getAll("updateMask.fieldPaths")).toEqual(["banned"]);
    expect(calls[0].init.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      fields: { banned: { booleanValue: true } },
    });
  });

  it("refuses an empty patch rather than replacing the whole document", async () => {
    // Firestore treats a maskless PATCH as a full replace, which would erase
    // the account's username and roles — so this can never be sent.
    const calls = stubFetch({});
    await expect(restPatchDocument(PROJECT, "users/u1", {}, TOKEN)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
