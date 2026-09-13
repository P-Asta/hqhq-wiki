/**
 * Audit rows and the report queue.
 *
 * The load-bearing claims here: a mutation and its audit row are written in
 * ONE transaction (so they cannot disagree), and a report names its target
 * without letting the reporter rename them.
 */

import { desc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { PageMeta, ParseResult } from "@/lib/wikitext/types";

import { getHistory, listReports, openReportCount, recentChanges } from "./queries";
import { createDb, type WikiDb } from "./client";
import { auditLog, reports, users } from "./schema";
import {
  ReportClosedError,
  ReportMissingError,
  createPage,
  createVersion,
  fileReport,
  resolveReport,
  rollback,
  saveEdit,
  seedLanguages,
  seedVersions,
  setUserBanned,
} from "./store";

const alice = { uid: "u-alice", displayName: "Alice" };
const bob = { uid: "u-bob", displayName: "Bob" };
const manager = { uid: "u-mgr", displayName: "Manager" };

function makeMeta(partial: Partial<PageMeta> = {}): PageMeta {
  return {
    categories: [],
    behaviorSwitches: new Set<string>(),
    toc: [],
    templatesUsed: [],
    linksTo: [],
    ifexistTargets: [],
    volatile: false,
    versionBoundaries: [],
    versionScoped: false,
    warnings: [],
    ...partial,
  };
}

function parsed(html: string): ParseResult {
  const meta = makeMeta();
  return { doc: { type: "document", children: [], meta }, html, meta, toc: meta.toc, refs: {} };
}

function auditRows(db: WikiDb) {
  return db.select().from(auditLog).orderBy(desc(auditLog.id)).all();
}

let db: WikiDb;
beforeEach(() => {
  db = createDb(":memory:");
  seedLanguages(db);
  seedVersions(db);
  // Bob has a row of his own, from an action taken about him. A report can
  // only name an account that already exists, so the tests below need this.
  setUserBanned(db, { uid: bob.uid, banned: false, actor: manager, displayName: "Bob" });
});

function seedPage() {
  return createPage(db, {
    namespace: "main",
    locale: "en",
    title: "Gold bar",
    content: "A gold bar.",
    author: alice,
    parse: parsed("<p>A gold bar.</p>"),
  });
}

/* ------------------------------------------------------------------ */

describe("audit rows", () => {
  it("records a page creation against its author", () => {
    seedPage();
    const rows = auditRows(db);
    expect(rows.map((r) => r.action)).toContain("page.create");
    const created = rows.find((r) => r.action === "page.create")!;
    expect(created.actorUid).toBe(alice.uid);
  });

  it("records an edit and a rollback separately, naming who did each", () => {
    const page = seedPage();
    const second = saveEdit(db, {
      pageId: page.pageId,
      locale: "en",
      title: "Gold bar",
      content: "A gold bar is scrap.",
      comment: "expand",
      isMinor: false,
      author: bob,
      parentRevId: page.revId,
      parse: parsed("<p>A gold bar is scrap.</p>"),
    });

    rollback(db, {
      pageId: page.pageId,
      locale: "en",
      targetRevId: page.revId,
      actor: manager,
      parse: parsed("<p>A gold bar.</p>"),
    });

    const rows = auditRows(db);
    const edit = rows.find((r) => r.action === "page.edit")!;
    const back = rows.find((r) => r.action === "page.rollback")!;
    expect(edit.actorUid).toBe(bob.uid);
    expect(back.actorUid).toBe(manager.uid);
    // The rollback names the revision it restored, which is the whole reason
    // a rollback is worth distinguishing from an ordinary edit.
    expect(JSON.stringify(back.payload)).toContain(String(page.revId));
    expect(second.revId).not.toBe(page.revId);
  });

  it("records a ban", () => {
    setUserBanned(db, { uid: bob.uid, banned: true, actor: manager, displayName: "Bob" });
    const row = auditRows(db).find((r) => r.action === "user.ban");
    expect(row?.actorUid).toBe(manager.uid);
  });

  it("records a version being registered when an actor is given", () => {
    createVersion(db, { id: "v99", label: "v99" }, manager);
    expect(auditRows(db).some((r) => r.action === "version.create")).toBe(true);
  });

  it("writes nothing when the mutation itself fails", () => {
    const before = auditRows(db).length;
    expect(() => createVersion(db, { id: "", label: "" }, manager)).toThrow();
    expect(auditRows(db).length).toBe(before);
  });
});

/* ------------------------------------------------------------------ */

describe("reports", () => {
  it("files an open report and audits the filing", () => {
    const created = fileReport(db, {
      targetUid: bob.uid,
      reporter: alice,
      reason: "blanked the page",
      context: "revision:12",
    });

    expect(created.status).toBe("open");
    expect(openReportCount(db)).toBe(1);
    const row = auditRows(db).find((r) => r.action === "user.report")!;
    expect(row.actorUid).toBe(alice.uid);
    expect(row.target).toBe(`user:${bob.uid}`);
  });

  it("leaves the reported account's own name untouched", () => {
    // Nothing about the target comes from the reporter, so being reported
    // cannot relabel you in the audit log or anywhere else the console reads.
    fileReport(db, { targetUid: bob.uid, reporter: alice });
    const stored = db.select().from(users).where(eq(users.uid, bob.uid)).get();
    expect(stored?.displayName).toBe("Bob");
  });

  it("refuses a target that is not an account, rather than conjuring one", () => {
    // The route checks this first and answers 404; the foreign key is the
    // backstop that keeps an invented uid from becoming a write primitive.
    expect(() => fileReport(db, { targetUid: "u-ghost", reporter: alice })).toThrow();
    expect(db.select().from(users).where(eq(users.uid, "u-ghost")).get()).toBeUndefined();
  });

  it("resolving closes the row, stamps the closer, and leaves an audit row", () => {
    const created = fileReport(db, {
      targetUid: bob.uid,
      reporter: alice,
    });

    resolveReport(db, { id: created.id, status: "resolved", actor: manager });

    const stored = db.select().from(reports).where(eq(reports.id, created.id)).get();
    expect(stored?.status).toBe("resolved");
    expect(stored?.resolvedBy).toBe(manager.uid);
    expect(stored?.resolvedAt).toBeInstanceOf(Date);
    expect(openReportCount(db)).toBe(0);
    expect(auditRows(db).some((r) => r.action === "report.resolve")).toBe(true);
  });

  it("dismissing is a distinct outcome, not a deletion", () => {
    const created = fileReport(db, { targetUid: bob.uid, reporter: alice });
    resolveReport(db, { id: created.id, status: "dismissed", actor: manager });

    expect(listReports(db, { status: "dismissed" }).rows).toHaveLength(1);
    expect(listReports(db, { status: "open" }).rows).toHaveLength(0);
  });

  it("refuses to close a report that is not there", () => {
    expect(() => resolveReport(db, { id: 9999, status: "resolved", actor: manager })).toThrow(
      ReportMissingError,
    );
  });

  it("refuses to close a report somebody else already closed", () => {
    // Two managers working the same queue is ordinary, and the second one
    // must not overwrite the record of who actually dealt with it.
    const created = fileReport(db, { targetUid: bob.uid, reporter: alice });
    resolveReport(db, { id: created.id, status: "resolved", actor: manager });

    const other = { uid: "u-mgr2", displayName: "Other manager" };
    expect(() => resolveReport(db, { id: created.id, status: "dismissed", actor: other })).toThrow(
      ReportClosedError,
    );

    const stored = db.select().from(reports).where(eq(reports.id, created.id)).get();
    expect(stored?.status).toBe("resolved");
    expect(stored?.resolvedBy).toBe(manager.uid);
    // And no second audit row claiming it was closed twice.
    expect(auditRows(db).filter((r) => r.action === "report.resolve")).toHaveLength(1);
  });

  it("lists newest first and pages by keyset", () => {
    for (let i = 0; i < 5; i += 1) {
      fileReport(db, {
        targetUid: bob.uid,
        reporter: alice,
        reason: `r${i}`,
      });
    }

    const first = listReports(db, { status: "open", limit: 2 });
    expect(first.rows.map((r) => r.reason)).toEqual(["r4", "r3"]);
    expect(first.nextCursor).not.toBeNull();

    const second = listReports(db, { status: "open", limit: 2, cursor: first.nextCursor! });
    expect(second.rows.map((r) => r.reason)).toEqual(["r2", "r1"]);
  });

  it("an unfiltered listing spans every status", () => {
    const a = fileReport(db, { targetUid: bob.uid, reporter: alice });
    fileReport(db, { targetUid: bob.uid, reporter: alice });
    resolveReport(db, { id: a.id, status: "resolved", actor: manager });

    expect(listReports(db, {}).rows).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */

describe("what the reader-facing listings carry about an author", () => {
  it("reports the author's CURRENT ban state, so a chip can offer the right action", () => {
    const page = seedPage();
    setUserBanned(db, { uid: alice.uid, banned: true, actor: manager, displayName: "Alice" });

    const { rows } = getHistory(db, page.pageId, "en");
    expect(rows[0].authorBanned).toBe(true);
    expect(recentChanges(db, {}).rows[0].authorBanned).toBe(true);
  });

  it("cannot lose a revision to the join it added", () => {
    // `revisions.author_uid` references `users.uid`, so an author row always
    // exists and the join can never drop a change — the delete below is
    // REFUSED, which is what proves it. The join is still LEFT rather than
    // inner: losing edits from a listing would be far worse than not knowing
    // whether their author is banned, and nothing should rest on the FK alone.
    const page = seedPage();
    expect(() => db.delete(users).where(eq(users.uid, alice.uid)).run()).toThrow();

    const { rows } = getHistory(db, page.pageId, "en");
    expect(rows).toHaveLength(1);
    expect(rows[0].authorUid).toBe(alice.uid);
    expect(recentChanges(db, {}).rows).toHaveLength(1);
  });
});
