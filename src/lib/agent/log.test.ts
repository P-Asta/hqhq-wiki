/** Question log (log.ts): content-only persistence, no asker identity. */

import { beforeEach, describe, expect, it } from "vitest";

import { createDb, type WikiDb } from "@/lib/db/client";
import { agentQuestions } from "@/lib/db/schema";

import { logQuestion } from "./log";

let db: WikiDb;

beforeEach(() => {
  db = createDb(":memory:");
});

describe("logQuestion", () => {
  it("stores the question, locale, and page context", () => {
    logQuestion(db, {
      question: "타이탄이 뭐야?",
      locale: "ko",
      page: { namespace: "main", slug: "titan" },
    });

    const rows = db.select().from(agentQuestions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      question: "타이탄이 뭐야?",
      locale: "ko",
      pageNamespace: "main",
      pageSlug: "titan",
    });
    expect(rows[0].askedAt).toBeInstanceOf(Date);
  });

  it("stores null page columns when there is no page context", () => {
    logQuestion(db, { question: "hello", locale: "en", page: null });
    const [row] = db.select().from(agentQuestions).all();
    expect(row.pageNamespace).toBeNull();
    expect(row.pageSlug).toBeNull();
  });

  it("appends rather than overwriting across multiple questions", () => {
    logQuestion(db, { question: "one", locale: "en", page: null });
    logQuestion(db, { question: "two", locale: "en", page: null });
    const rows = db.select().from(agentQuestions).all();
    expect(rows.map((r) => r.question)).toEqual(["one", "two"]);
  });

  it("never stores any asker-identity field", () => {
    logQuestion(db, { question: "q", locale: "en", page: null });
    const [row] = db.select().from(agentQuestions).all();
    const keys = Object.keys(row);
    expect(keys.sort()).toEqual(
      ["askedAt", "id", "locale", "pageNamespace", "pageSlug", "question"].sort(),
    );
    for (const forbidden of ["uid", "userId", "ip", "ipAddress", "userAgent", "session"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
