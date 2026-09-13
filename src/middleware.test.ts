/**
 * The O12 routing decision table, tested on the pure `decideRoute` the
 * middleware handler delegates to. Every row of the table in src/middleware.ts
 * has a case here, plus the traps: static assets, page titles that contain
 * dots, unregistered prefixes, and casing.
 */

import { describe, expect, it } from "vitest";

import { decideRoute } from "./middleware";

describe("decideRoute — prefix-free English is rewritten into /en", () => {
  it("rewrites the site root", () => {
    expect(decideRoute("/")).toEqual({ kind: "rewrite", pathname: "/en" });
  });

  it("rewrites an article path", () => {
    expect(decideRoute("/wiki/x")).toEqual({ kind: "rewrite", pathname: "/en/wiki/x" });
  });

  it("rewrites the other title routes", () => {
    expect(decideRoute("/edit/titan")).toEqual({ kind: "rewrite", pathname: "/en/edit/titan" });
    expect(decideRoute("/history/titan")).toEqual({
      kind: "rewrite",
      pathname: "/en/history/titan",
    });
    expect(decideRoute("/diff/titan")).toEqual({ kind: "rewrite", pathname: "/en/diff/titan" });
  });

  it("rewrites the fixed pages", () => {
    expect(decideRoute("/search")).toEqual({ kind: "rewrite", pathname: "/en/search" });
    expect(decideRoute("/special/recent-changes")).toEqual({
      kind: "rewrite",
      pathname: "/en/special/recent-changes",
    });
    expect(decideRoute("/languages")).toEqual({ kind: "rewrite", pathname: "/en/languages" });
    expect(decideRoute("/admin")).toEqual({ kind: "rewrite", pathname: "/en/admin" });
    expect(decideRoute("/login")).toEqual({ kind: "rewrite", pathname: "/en/login" });
  });

  it("keeps a trailing slash rather than inventing a redirect", () => {
    expect(decideRoute("/wiki/x/")).toEqual({ kind: "rewrite", pathname: "/en/wiki/x/" });
  });

  it("rewrites titles that contain dots — they are page names, not files", () => {
    expect(decideRoute("/wiki/file:cruiser.png")).toEqual({
      kind: "rewrite",
      pathname: "/en/wiki/file:cruiser.png",
    });
    expect(decideRoute("/wiki/v1.2")).toEqual({ kind: "rewrite", pathname: "/en/wiki/v1.2" });
  });
});

describe("decideRoute — /en/… is never canonical (O12 rule 1)", () => {
  it("308-redirects the bare prefix to the site root", () => {
    expect(decideRoute("/en")).toEqual({ kind: "redirect", pathname: "/", status: 308 });
    expect(decideRoute("/en/")).toEqual({ kind: "redirect", pathname: "/", status: 308 });
  });

  it("308-redirects a prefixed article to the prefix-free form", () => {
    expect(decideRoute("/en/wiki/x")).toEqual({
      kind: "redirect",
      pathname: "/wiki/x",
      status: 308,
    });
    expect(decideRoute("/en/special/what-links-here/titan")).toEqual({
      kind: "redirect",
      pathname: "/special/what-links-here/titan",
      status: 308,
    });
  });

  it("redirects an oddly-cased default prefix too", () => {
    expect(decideRoute("/EN/wiki/x")).toEqual({
      kind: "redirect",
      pathname: "/wiki/x",
      status: 308,
    });
  });
});

describe("decideRoute — registered non-default prefixes pass through", () => {
  it("passes /ko and /ko/…", () => {
    expect(decideRoute("/ko")).toEqual({ kind: "pass" });
    expect(decideRoute("/ko/")).toEqual({ kind: "pass" });
    expect(decideRoute("/ko/wiki/x")).toEqual({ kind: "pass" });
    expect(decideRoute("/ko/special/recent-changes")).toEqual({ kind: "pass" });
  });

  it("canonicalizes the casing of a known prefix with one hop", () => {
    expect(decideRoute("/KO/wiki/x")).toEqual({
      kind: "redirect",
      pathname: "/ko/wiki/x",
      status: 308,
    });
  });
});

describe("decideRoute — unknown prefixes fall through as ordinary paths", () => {
  it("treats /xx/… as an English path (it 404s in the app, O12 rule 2)", () => {
    expect(decideRoute("/xx/wiki/x")).toEqual({
      kind: "rewrite",
      pathname: "/en/xx/wiki/x",
    });
  });

  it("does not crash on a malformed percent-escape", () => {
    expect(decideRoute("/%E0%A4%A/wiki/x")).toEqual({
      kind: "rewrite",
      pathname: "/en/%E0%A4%A/wiki/x",
    });
  });

  it("treats a locale-shaped article slug as content, not a prefix", () => {
    expect(decideRoute("/wiki/ko")).toEqual({ kind: "rewrite", pathname: "/en/wiki/ko" });
  });
});

describe("decideRoute — non-route paths are skipped untouched", () => {
  it("skips the API", () => {
    expect(decideRoute("/api/preview")).toEqual({ kind: "skip" });
    expect(decideRoute("/api")).toEqual({ kind: "skip" });
    expect(decideRoute("/api/pages/titan")).toEqual({ kind: "skip" });
  });

  it("skips the framework asset tree", () => {
    expect(decideRoute("/_next/static/x")).toEqual({ kind: "skip" });
    expect(decideRoute("/_next/image")).toEqual({ kind: "skip" });
  });

  it("skips well-known root files", () => {
    expect(decideRoute("/favicon.ico")).toEqual({ kind: "skip" });
    expect(decideRoute("/robots.txt")).toEqual({ kind: "skip" });
    expect(decideRoute("/sitemap.xml")).toEqual({ kind: "skip" });
    expect(decideRoute("/icon.svg")).toEqual({ kind: "skip" });
    expect(decideRoute("/.well-known/security.txt")).toEqual({ kind: "skip" });
  });

  it("skips anything that is not an absolute path", () => {
    expect(decideRoute("wiki/x")).toEqual({ kind: "skip" });
  });

  it("treats an empty pathname as the root", () => {
    expect(decideRoute("")).toEqual({ kind: "rewrite", pathname: "/en" });
  });
});
