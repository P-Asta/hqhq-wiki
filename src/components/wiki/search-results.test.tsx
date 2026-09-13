/**
 * renderSnippet — the FTS snippet sanitizer: `<mark>` tokens become real
 * elements, everything else stays a text node (never injected as HTML).
 */

import { isValidElement } from "react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { renderSnippet } from "./search-results";

function shape(nodes: ReturnType<typeof renderSnippet>) {
  return nodes.map((node) =>
    isValidElement(node)
      ? { mark: (node as ReactElement<{ children?: string }>).props.children }
      : { text: node },
  );
}

describe("renderSnippet", () => {
  it("turns <mark> tokens into elements around text nodes", () => {
    expect(shape(renderSnippet("The …<mark>quota</mark> is 130"))).toEqual([
      { text: "The …" },
      { mark: "quota" },
      { text: " is 130" },
    ]);
  });

  it("handles multiple marks and a leading mark", () => {
    expect(shape(renderSnippet("<mark>Gold</mark> and <mark>silver</mark>"))).toEqual([
      { mark: "Gold" },
      { text: " and " },
      { mark: "silver" },
    ]);
  });

  it("keeps markup characters in article text as inert text", () => {
    const nodes = renderSnippet('a <script>alert("x")</script> b <mark>hit</mark>');
    const texts = shape(nodes)
      .filter((n) => "text" in n)
      .map((n) => (n as { text: string }).text)
      .join("");
    expect(texts).toBe('a <script>alert("x")</script> b ');
    expect(nodes.some((n) => isValidElement(n))).toBe(true);
  });

  it("renders an unbalanced open token as plain text", () => {
    expect(shape(renderSnippet("broken <mark>tail"))).toEqual([
      { text: "broken " },
      { text: "tail" },
    ]);
  });

  it("drops empty marks and returns the empty snippet as no nodes", () => {
    expect(shape(renderSnippet("a<mark></mark>b"))).toEqual([{ text: "a" }, { text: "b" }]);
    expect(renderSnippet("")).toEqual([]);
  });
});
