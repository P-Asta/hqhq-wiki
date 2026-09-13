/**
 * renderAnswer (ask-view.tsx): turns `[[Title]]` mentions in the agent's
 * answer into links for resolved titles, plain text for everything else.
 */

import Link from "next/link";
import { describe, expect, it } from "vitest";

import { renderAnswer } from "./ask-view";

import type { SourceRef } from "@/lib/agent/protocol";

const ZAP_GUN: SourceRef = { namespace: "main", slug: "zap-gun", title: "Zap Gun", locale: "en" };

/** Flatten a renderAnswer() result into plain strings for easy assertions. */
function textOf(nodes: ReturnType<typeof renderAnswer>): string {
  return nodes
    .map((n) => (typeof n === "string" ? n : (n as { props: { children: string } }).props.children))
    .join("");
}

describe("renderAnswer", () => {
  it("returns the content verbatim as plain text when there is no bracket markup", () => {
    const nodes = renderAnswer("No links here.", {}, "en");
    expect(nodes).toEqual(["No links here."]);
  });

  it("turns a resolved [[Title]] into a Link with the right href and label", () => {
    const nodes = renderAnswer("Use the [[Zap Gun]] to stun it.", { "Zap Gun": ZAP_GUN }, "en");
    expect(nodes).toHaveLength(3);
    expect(nodes[0]).toBe("Use the ");
    expect(nodes[2]).toBe(" to stun it.");
    const link = nodes[1] as { type: unknown; props: { href: string; children: string } };
    expect(link.type).toBe(Link);
    expect(link.props.href).toBe("/wiki/zap-gun");
    expect(link.props.children).toBe("Zap Gun");
  });

  it("strips the brackets around an unresolved mention instead of linking or showing markup", () => {
    const nodes = renderAnswer("See [[Nonexistent Page]] for details.", {}, "en");
    expect(nodes).toEqual(["See ", "Nonexistent Page", " for details."]);
  });

  it("resolves multiple distinct mentions independently", () => {
    const jester: SourceRef = { namespace: "main", slug: "jester", title: "Jester", locale: "en" };
    const nodes = renderAnswer("[[Jester]] fears the [[Zap Gun]].", {
      Jester: jester,
      "Zap Gun": ZAP_GUN,
    }, "en");
    expect(textOf(nodes)).toBe("Jester fears the Zap Gun.");
    expect((nodes[0] as { type: unknown }).type).toBe(Link);
    expect((nodes[2] as { type: unknown }).type).toBe(Link);
  });

  it("hides an in-progress, not-yet-closed [[ instead of flashing raw markup mid-stream", () => {
    const nodes = renderAnswer("Use the [[Zap G", {}, "en");
    expect(nodes.join("")).toBe("Use the ");
  });

  it("still resolves a fully closed link even while a later [[ is left open", () => {
    const nodes = renderAnswer("[[Zap Gun]] and the [[Something", { "Zap Gun": ZAP_GUN }, "en");
    expect((nodes[0] as { type: unknown }).type).toBe(Link);
    expect(nodes.at(-1)).toBe(" and the ");
  });

  it("builds the href through the locale-aware article route", () => {
    const template: SourceRef = {
      namespace: "template",
      slug: "infobox-moon",
      title: "Infobox moon",
      locale: "ko",
    };
    const nodes = renderAnswer("[[Infobox moon]]", { "Infobox moon": template }, "ko");
    const link = nodes[0] as { props: { href: string } };
    expect(link.props.href).toBe("/ko/wiki/template:infobox-moon");
  });
});
