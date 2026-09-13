/**
 * What a name affords, given who is looking at it.
 *
 * The builder is the whole rule, and both menus — right-click and "⋯" — read
 * from it, so testing it here is testing both. The rule itself: an ordinary
 * signed-in editor may report somebody, a manager may ban, nobody may act on
 * themselves, and a signed-out reader gets no menu at all.
 */

import { describe, expect, it, vi } from "vitest";

import { formatMessage } from "@/lib/i18n";

import { userMenuRows, type ChipUser, type UserChipLabels } from "./user-chip";

const labels: UserChipLabels = {
  rowActions: "Actions for {name}",
  report: "Report",
  ban: "Ban",
  unban: "Unban",
  copyId: "Copy id",
  bannedBadge: "Banned",
  anonymous: "Anonymous",
  roleNames: {},
};

const bob: ChipUser = { uid: "u-bob", displayName: "Bob" };
const keys = (rows: ReturnType<typeof userMenuRows>) => rows.map((r) => r.key);

describe("what a viewer is offered", () => {
  it("gives a signed-out reader no menu at all", () => {
    // No handlers = no entitlement = no rows. This has to be EMPTY, not just
    // harmless: the chip suppresses the browser's own context menu whenever it
    // has rows to show, so one inert row would cost every anonymous reader
    // their right-click on every author name.
    expect(userMenuRows(bob, labels, {}, false)).toEqual([]);
  });

  it("gives an ordinary editor a report and nothing stronger", () => {
    const rows = userMenuRows(bob, labels, { onReport: vi.fn() }, false);
    expect(keys(rows)).toEqual(["report", "copy-id"]);
    expect(keys(rows)).not.toContain("ban");
  });

  it("gives a manager the ban", () => {
    const rows = userMenuRows(bob, labels, { onReport: vi.fn(), onBan: vi.fn() }, false);
    expect(keys(rows)).toEqual(["report", "ban", "copy-id"]);
  });
});

describe("acting on yourself", () => {
  it("withholds the report — reporting yourself is a mistake, not a request", () => {
    const rows = userMenuRows(bob, labels, { onReport: vi.fn() }, true);
    expect(keys(rows)).not.toContain("report");
  });

  it("shows a manager their own ban row but disabled, rather than hiding it", () => {
    const rows = userMenuRows(bob, labels, { onBan: vi.fn() }, true);
    const ban = rows.find((r) => r.key === "ban")!;
    // The server answers 400 self-ban; saying so up front beats a failed call.
    expect(ban.disabled).toBe(true);
  });

  it("still lets a manager lift a ban on themselves", () => {
    // The one self-action that must work: otherwise a mistaken self-ban, or a
    // ban placed by another manager, has no route back.
    const rows = userMenuRows({ ...bob, banned: true }, labels, { onBan: vi.fn() }, true);
    const ban = rows.find((r) => r.key === "ban")!;
    expect(ban.disabled).toBe(false);
    expect(ban.label).toBe(labels.unban);
  });
});

describe("naming the menu after a person who chose their own name", () => {
  // The chip builds its accessible name from a display name, and a display
  // name is whatever its owner typed. `String.replace` reads "$&", "$`" and
  // "$1" in its REPLACEMENT as backreferences, so building the label that way
  // lets a username rewrite the sentence around it. formatMessage does not.
  it.each(["$&", "$`", "$'", "$1", "$$"])("survives a display name of %j", (name) => {
    expect(formatMessage("Actions for {name}", { name })).toBe(`Actions for ${name}`);
  });

  it("leaves a name with no dollar signs exactly as it is", () => {
    expect(formatMessage("Actions for {name}", { name: "Bob" })).toBe("Actions for Bob");
  });
});

describe("the rows themselves", () => {
  it("reads 'Unban' for an account already banned", () => {
    const rows = userMenuRows({ ...bob, banned: true }, labels, { onBan: vi.fn() }, false);
    expect(rows.find((r) => r.key === "ban")?.label).toBe(labels.unban);
  });

  it("hands the ban handler the state being moved TO", () => {
    const onBan = vi.fn();
    userMenuRows(bob, labels, { onBan }, false)
      .find((r) => r.key === "ban")!
      .onSelect();
    expect(onBan).toHaveBeenCalledWith(bob, true);

    onBan.mockClear();
    userMenuRows({ ...bob, banned: true }, labels, { onBan }, false)
      .find((r) => r.key === "ban")!
      .onSelect();
    expect(onBan).toHaveBeenCalledWith({ ...bob, banned: true }, false);
  });

  it("groups only where a group actually starts", () => {
    // The first row never draws a separator above itself.
    const managerRows = userMenuRows(bob, labels, { onReport: vi.fn(), onBan: vi.fn() }, false);
    expect(managerRows[0].startsGroup).toBeFalsy();
    expect(managerRows.slice(1).every((r) => r.startsGroup)).toBe(true);

    const editorRows = userMenuRows(bob, labels, { onReport: vi.fn() }, false);
    expect(editorRows[0].startsGroup).toBeFalsy();
  });
});
