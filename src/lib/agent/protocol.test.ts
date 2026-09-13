/** Wire-protocol validation (protocol.ts + protocol-schema.ts). */

import { describe, expect, it } from "vitest";

import { NAMESPACES } from "@/lib/db/schema";

import {
  MAX_HISTORY_CHARS,
  MAX_HISTORY_TOTAL_CHARS,
  MAX_HISTORY_TURNS,
  MAX_QUESTION_CHARS,
  WIRE_NAMESPACES,
  isServerEvent,
} from "./protocol";
import { askMessageSchema, clientMessageSchema } from "./protocol-schema";

describe("askMessageSchema", () => {
  const valid = {
    type: "ask",
    question: "  What is a Titan?  ",
    locale: "ko",
    history: [],
    page: null,
  };

  it("accepts a minimal ask and trims the question", () => {
    const parsed = askMessageSchema.parse(valid);
    expect(parsed.question).toBe("What is a Titan?");
    expect(parsed.history).toEqual([]);
    expect(parsed.page).toBeNull();
  });

  it("defaults history when omitted", () => {
    const parsed = askMessageSchema.parse({ type: "ask", question: "q", locale: "en", page: null });
    expect(parsed.history).toEqual([]);
  });

  it("rejects a frame with no page key (required, nullable)", () => {
    const withoutPage: Record<string, unknown> = { ...valid };
    delete withoutPage.page;
    expect(askMessageSchema.safeParse(withoutPage).success).toBe(false);
  });

  it("accepts a page context and rejects a bad one", () => {
    const withPage = { ...valid, page: { namespace: "main", slug: "titan" } };
    expect(askMessageSchema.parse(withPage).page).toEqual({ namespace: "main", slug: "titan" });

    expect(
      askMessageSchema.safeParse({ ...valid, page: { namespace: "talk", slug: "titan" } }).success,
    ).toBe(false);
    expect(
      askMessageSchema.safeParse({ ...valid, page: { namespace: "main", slug: "" } }).success,
    ).toBe(false);
  });

  it("rejects an empty or whitespace-only question", () => {
    expect(askMessageSchema.safeParse({ ...valid, question: "   " }).success).toBe(false);
  });

  it("rejects an over-long question", () => {
    const question = "x".repeat(MAX_QUESTION_CHARS + 1);
    expect(askMessageSchema.safeParse({ ...valid, question }).success).toBe(false);
  });

  it("rejects too many history turns and bad roles", () => {
    const turn = { role: "user", content: "hi" };
    const history = Array.from({ length: MAX_HISTORY_TURNS + 1 }, () => turn);
    expect(askMessageSchema.safeParse({ ...valid, history }).success).toBe(false);
    expect(
      askMessageSchema.safeParse({ ...valid, history: [{ role: "system", content: "x" }] }).success,
    ).toBe(false);
  });

  it("rejects a history whose TOTAL length exceeds the cap", () => {
    // Each turn is legal on its own; together they cross the total budget.
    const turn = { role: "assistant", content: "y".repeat(MAX_HISTORY_CHARS) };
    const turns = Math.floor(MAX_HISTORY_TOTAL_CHARS / MAX_HISTORY_CHARS) + 1;
    const history = Array.from({ length: turns }, () => turn);
    expect(history.length).toBeLessThanOrEqual(MAX_HISTORY_TURNS);
    expect(askMessageSchema.safeParse({ ...valid, history }).success).toBe(false);
    expect(
      askMessageSchema.safeParse({ ...valid, history: history.slice(0, -1) }).success,
    ).toBe(true);
  });

  it("rejects unknown frame types at the union", () => {
    expect(clientMessageSchema.safeParse({ type: "cancel" }).success).toBe(false);
  });
});

describe("isServerEvent", () => {
  it("accepts every event tag and rejects the rest", () => {
    expect(isServerEvent({ type: "ack" })).toBe(true);
    expect(isServerEvent({ type: "delta", text: "x" })).toBe(true);
    expect(isServerEvent({ type: "done", sources: [] })).toBe(true);
    expect(isServerEvent({ type: "nope" })).toBe(false);
    expect(isServerEvent(null)).toBe(false);
    expect(isServerEvent("delta")).toBe(false);
  });
});

describe("WIRE_NAMESPACES", () => {
  it("mirrors schema.ts NAMESPACES exactly (both directions)", () => {
    expect([...WIRE_NAMESPACES].sort()).toEqual([...NAMESPACES].sort());
  });
});
