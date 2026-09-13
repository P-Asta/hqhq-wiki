/**
 * POST /api/preview is PUBLIC (decisions-v2 O15.1): it must render for a
 * caller with no Bearer token on a server with no Firebase Admin credentials
 * — the exact fresh-install case that used to answer 401 and surface as
 * "The preview could not be rendered." It must also stay read-only and keep
 * the 400 KB wikitext cap.
 */

import { describe, expect, it, vi } from "vitest";

import type { WikiDb } from "@/lib/db/client";
import { parsedCache } from "@/lib/db/schema";

vi.mock("server-only", () => ({}));

// The route calls getDb(); give it a throwaway in-memory database. No Firebase
// credentials are set in the test environment, which is the point of O15.
vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  const db = actual.createDb(":memory:");
  return { ...actual, getDb: () => db, __testDb: db };
});

const { POST } = await import("./route");
const routeDb = ((await import("@/lib/db/client")) as unknown as { __testDb: WikiDb }).__testDb;

function previewRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/preview", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/preview", () => {
  it("renders for an anonymous caller with no credentials configured", async () => {
    expect(process.env.FIREBASE_CLIENT_EMAIL ?? "").toBe("");

    const res = await POST(
      previewRequest({ wikitext: "'''bold'''", title: "Sandbox", locale: "en" }),
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { html: string; meta: { warnings: string[] } };
    expect(body.html).toContain("bold");
    expect(Array.isArray(body.meta.warnings)).toBe(true);
  });

  it("ignores a bogus Authorization header rather than rejecting it", async () => {
    const res = await POST(
      previewRequest(
        { wikitext: "plain text", title: "Sandbox", locale: "en" },
        { authorization: "Bearer not-a-real-token" },
      ),
    );
    expect(res.status).toBe(200);
  });

  it("writes nothing — parsed_cache stays empty", async () => {
    await POST(previewRequest({ wikitext: "== Heading ==", title: "Sandbox", locale: "en" }));
    expect(routeDb.select().from(parsedCache).all()).toEqual([]);
  });

  it("still enforces the 400 KB wikitext cap", async () => {
    const res = await POST(
      previewRequest({ wikitext: "x".repeat(400_001), title: "Sandbox", locale: "en" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation-error");
  });

  it("rejects a body that fails the schema", async () => {
    const res = await POST(previewRequest({ wikitext: "hi", locale: "en" }));
    expect(res.status).toBe(400);
  });
});
