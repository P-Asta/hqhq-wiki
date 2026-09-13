/**
 * POST /api/preview/fragments is the batch preview the visual surface leans on
 * (visual-editor.md §5), so the properties that matter are positional: one html
 * per input index, in order, whatever the deduplication does behind it. Like
 * its sibling it is PUBLIC (decisions-v2 O15.1) — it must render with no Bearer
 * token and no Firebase Admin credentials — and its caps are the only thing
 * bounding the CPU a caller can spend.
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

// Real rendering, counted: deduplication is invisible in the response body, so
// the only honest way to assert "rendered once" is at the call boundary.
const renderCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/wiki/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/wiki/service")>();
  return {
    ...actual,
    renderPreview: (input: Parameters<typeof actual.renderPreview>[0]) => {
      renderCalls.count += 1;
      return actual.renderPreview(input);
    },
  };
});

const { POST } = await import("./route");
const routeDb = ((await import("@/lib/db/client")) as unknown as { __testDb: WikiDb }).__testDb;

interface FragmentsBody {
  htmls: string[];
  /** Indices whose render THREW — never an index that merely rendered "". */
  failed: number[];
  warnings: string[];
}

function fragmentsRequest(body: unknown): Request {
  return new Request("http://localhost/api/preview/fragments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function post(body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await POST(fragmentsRequest(body));
  return { status: res.status, json: (await res.json()) as unknown };
}

function base(fragments: string[]): Record<string, unknown> {
  return { fragments, title: "Sandbox", locale: "en" };
}

describe("POST /api/preview/fragments", () => {
  it("returns one html per fragment, in input order", async () => {
    const { status, json } = await post(base(["'''bold'''", "''italic''", "== Heading =="]));
    expect(status).toBe(200);

    const body = json as FragmentsBody;
    expect(body.htmls).toHaveLength(3);
    expect(body.htmls[0]).toContain("bold");
    expect(body.htmls[1]).toContain("italic");
    expect(body.htmls[2]).toContain("Heading");
  });

  it("renders a repeated fragment once but answers every index with it", async () => {
    renderCalls.count = 0;
    const { status, json } = await post(base(["'''one'''", "''two''", "'''one'''", "'''one'''"]));
    expect(status).toBe(200);

    const body = json as FragmentsBody;
    expect(renderCalls.count).toBe(2);
    expect(body.htmls).toHaveLength(4);
    expect(body.htmls[0]).toBe(body.htmls[2]);
    expect(body.htmls[2]).toBe(body.htmls[3]);
    expect(body.htmls[1]).not.toBe(body.htmls[0]);
  });

  it("accepts an empty batch and renders nothing", async () => {
    renderCalls.count = 0;
    const { status, json } = await post(base([]));
    expect(status).toBe(200);
    expect(json).toEqual({ htmls: [], failed: [], warnings: [] });
    expect(renderCalls.count).toBe(0);
  });

  it("collects parse warnings into one deduplicated flat array", async () => {
    const twoCaptions = "{|\n|+ first\n|+ second\n| cell\n|}";
    const { status, json } = await post(base([twoCaptions, "plain", twoCaptions]));
    expect(status).toBe(200);

    const body = json as FragmentsBody;
    expect(body.htmls).toHaveLength(3);
    expect(body.warnings.length).toBeGreaterThan(0);
    expect(new Set(body.warnings).size).toBe(body.warnings.length);
    expect(body.warnings.some((warning) => warning.includes("caption"))).toBe(true);
  });

  // The visual surface draws a failure as raw wikitext and an empty render as
  // an empty node (visual-editor.md §5), so "" alone cannot tell it which it
  // has. A version tag is the case that made this bite: outside its range it
  // renders nothing, correctly, and authors were shown `<v69>aaa</v69>` in a
  // table cell at every version but v69 (versioning.md §2.1).
  it("does not report a fragment that legitimately renders nothing as failed", async () => {
    const { status, json } = await post({
      ...base(["<v69>aaa</v69>", "'''bold'''"]),
      version: "v70",
    });
    expect(status).toBe(200);

    const body = json as FragmentsBody;
    expect(body.htmls[0]).toBe("");
    expect(body.htmls[1]).toContain("bold");
    expect(body.failed).toEqual([]);
  });

  it("rejects more than 64 fragments", async () => {
    const { status, json } = await post(base(Array.from({ length: 65 }, () => "x")));
    expect(status).toBe(400);
    expect((json as { error: { code: string } }).error.code).toBe("validation-error");
  });

  it("rejects a single fragment over 20000 characters", async () => {
    const { status, json } = await post(base(["x".repeat(20_001)]));
    expect(status).toBe(400);
    expect((json as { error: { code: string } }).error.code).toBe("validation-error");
  });

  it("rejects a batch whose total size blows the cap even when each fragment fits", async () => {
    const { status, json } = await post(base(Array.from({ length: 16 }, () => "x".repeat(15_000))));
    expect(status).toBe(400);
    expect((json as { error: { code: string } }).error.code).toBe("validation-error");
  });

  it("rejects a body that fails the schema", async () => {
    const { status } = await post({ fragments: ["hi"], locale: "en" });
    expect(status).toBe(400);
  });

  it("writes nothing — parsed_cache stays empty", async () => {
    await post(base(["== Heading ==", "'''bold'''"]));
    expect(routeDb.select().from(parsedCache).all()).toEqual([]);
  });
});
