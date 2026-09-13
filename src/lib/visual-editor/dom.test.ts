import { describe, expect, it } from "vitest";

import { parseDocument } from "./parse";
import { serializeDocument } from "./serialize";
import {
  CARET_HOLDER,
  blockToHtml,
  documentToHtml,
  domToDocument,
  escapeHtml,
  inlineToHtml,
  withoutCaretHolders,
  type VeDomNode,
} from "./dom";
import {
  createIdFactory,
  emptyDocument,
  newBlockBase,
  type VeBlock,
  type VeDocument,
  type VeInline,
  type VeListItem,
  type VeTable,
  type VeTableCell,
  type VeTableRow,
} from "./model";

/* ------------------------------------------------------------------ */
/* Plain-object DOM (vitest runs in node, so there is no real one)     */
/* ------------------------------------------------------------------ */

function el(
  tag: string,
  attrs: Record<string, string> = {},
  children: VeDomNode[] = []
): VeDomNode {
  return {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    nodeValue: null,
    childNodes: children,
    getAttribute: (name: string): string | null =>
      Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null,
  };
}

function txt(text: string): VeDomNode {
  return { nodeType: 3, nodeName: "#text", nodeValue: text, childNodes: [] };
}

/** The surface root: `domToDocument` only ever walks its children. */
function surface(children: VeDomNode[]): VeDomNode {
  return el("div", { contenteditable: "true" }, children);
}

function read(children: VeDomNode[], prev: VeDocument = emptyDocument()): VeDocument {
  return domToDocument(surface(children), prev, createIdFactory("n"));
}

/** The single block a fragment reads back as. */
function readOne(children: VeDomNode[], prev: VeDocument = emptyDocument()): VeBlock {
  const doc = read(children, prev);
  expect(doc.blocks).toHaveLength(1);
  return doc.blocks[0];
}

function paragraphChildren(block: VeBlock): VeInline[] {
  if (block.kind !== "paragraph") throw new Error(`expected a paragraph, got ${block.kind}`);
  return block.children;
}

function markers(block: VeBlock): string[] {
  if (block.kind !== "list") throw new Error(`expected a list, got ${block.kind}`);
  return block.items.map((item) => item.marker);
}

function text(value: string): VeInline {
  return { kind: "text", text: value };
}

/* ------------------------------------------------------------------ */
/* escapeHtml                                                          */
/* ------------------------------------------------------------------ */

describe("escapeHtml", () => {
  it("escapes the four characters an attribute value can break out with", () => {
    expect(escapeHtml(`& < > "`)).toBe("&amp; &lt; &gt; &quot;");
  });

  it("escapes the ampersand first, so nothing is double-escaped", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("leaves ordinary text alone", () => {
    expect(escapeHtml("68-Artifice")).toBe("68-Artifice");
  });
});

/* ------------------------------------------------------------------ */
/* Model → HTML                                                        */
/* ------------------------------------------------------------------ */

describe("blockToHtml", () => {
  it("writes a paragraph with its id", () => {
    expect(
      blockToHtml({ ...newBlockBase("b1"), kind: "paragraph", children: [text("Hello")] })
    ).toBe(`<p data-ve="p" data-ve-id="b1">Hello</p>`);
  });

  it("gives an empty paragraph a labelled filler br so it still has height", () => {
    // The label is not decoration: an authored `<br>` spacer line is the same
    // markup, and only `data-ve-filler` tells the reader which one is ours.
    expect(blockToHtml({ ...newBlockBase("b1"), kind: "paragraph", children: [] })).toBe(
      `<p data-ve="p" data-ve-id="b1"><br data-ve-filler=""></p>`
    );
    expect(
      blockToHtml({
        ...newBlockBase("b1"),
        kind: "paragraph",
        children: [{ kind: "break", source: "<br>" }],
      })
    ).toBe(`<p data-ve="p" data-ve-id="b1"><br data-ve-break="&lt;br&gt;"></p>`);
  });

  it("writes every heading level", () => {
    for (const level of [1, 2, 3, 4, 5, 6] as const) {
      expect(
        blockToHtml({ ...newBlockBase("h"), kind: "heading", level, children: [text("T")] })
      ).toBe(`<h${level} data-ve="h" data-ve-id="h">T</h${level}>`);
    }
  });

  it("writes a rule as an uneditable wrapper around an hr", () => {
    expect(blockToHtml({ ...newBlockBase("r"), kind: "rule", dashes: 7 })).toBe(
      `<div data-ve="rule" data-ve-id="r" contenteditable="false"><hr></div>`
    );
  });

  it("writes a block atomic with an empty body and the source only in the attribute", () => {
    const html = blockToHtml({
      ...newBlockBase("a1"),
      kind: "atomic",
      atomic: "infobox",
      source: `<infobox><title source="name" /></infobox>`,
      label: "Infobox",
    });
    expect(html).toBe(
      `<div data-ve="atomic" data-ve-id="a1" data-ve-kind="infobox"` +
        ` data-ve-src="&lt;infobox&gt;&lt;title source=&quot;name&quot; /&gt;&lt;/infobox&gt;"` +
        ` contenteditable="false"><div data-ve-body=""></div></div>`
    );
    expect(html).not.toContain("<infobox>");
  });

  it("nests a list inside the item above it", () => {
    const items: VeListItem[] = [
      { marker: "*", children: [text("one")] },
      { marker: "**", children: [text("two")] },
      { marker: "*", children: [text("three")] },
    ];
    expect(blockToHtml({ ...newBlockBase("l"), kind: "list", items })).toBe(
      `<ul data-ve="list" data-ve-id="l"><li>one<ul><li>two</li></ul></li><li>three</li></ul>`
    );
  });

  it("closes and reopens where a marker character changes, marking only the first root", () => {
    const items: VeListItem[] = [
      { marker: "*", children: [text("bullet")] },
      { marker: "#", children: [text("number")] },
      { marker: ":", children: [text("def")] },
      { marker: ";", children: [text("term")] },
    ];
    expect(blockToHtml({ ...newBlockBase("l"), kind: "list", items })).toBe(
      `<ul data-ve="list" data-ve-id="l"><li>bullet</li></ul>` +
        `<ol><li>number</li></ol><dl><dd>def</dd></dl><dl><dt>term</dt></dl>`
    );
  });

  it("opens the intermediate levels a marker jump skips, labelling them as holders", () => {
    const items: VeListItem[] = [{ marker: "*#", children: [text("deep")] }];
    expect(blockToHtml({ ...newBlockBase("l"), kind: "list", items })).toBe(
      `<ul data-ve="list" data-ve-id="l"><li data-ve-hold=""><ol><li>deep</li></ol></li></ul>`
    );
  });

  it("does not label an item the author left empty above a deeper one", () => {
    // Same shape, different meaning: this `<li>` is a bullet the author wrote,
    // and the reader may only drop the ones this writer labelled.
    const items: VeListItem[] = [
      { marker: "*", children: [text("Main entrance")] },
      { marker: "*", children: [] },
      { marker: "**", children: [text("through the fire exit")] },
    ];
    expect(blockToHtml({ ...newBlockBase("l"), kind: "list", items })).toBe(
      `<ul data-ve="list" data-ve-id="l"><li>Main entrance</li>` +
        `<li><ul><li>through the fire exit</li></ul></li></ul>`
    );
  });

  it("still emits an element for a list with no items", () => {
    expect(blockToHtml({ ...newBlockBase("l"), kind: "list", items: [] })).toBe(
      `<ul data-ve="list" data-ve-id="l"></ul>`
    );
  });
});

describe("inlineToHtml", () => {
  it("writes each of the seven marks", () => {
    const tags: Record<string, string> = {
      bold: "b",
      italic: "i",
      underline: "u",
      strike: "s",
      sup: "sup",
      sub: "sub",
      code: "code",
    };
    for (const mark of ["bold", "italic", "underline", "strike", "sup", "sub", "code"] as const) {
      expect(inlineToHtml([{ kind: "mark", mark, children: [text("x")] }])).toBe(
        `<${tags[mark]}>x</${tags[mark]}>`
      );
    }
  });

  it("writes a wiki link with no href, so it cannot navigate", () => {
    const html = inlineToHtml([
      { kind: "link", target: `Weather "systems"`, children: [text("weather")] },
    ]);
    expect(html).toBe(
      `<a data-ve="link" data-ve-target="Weather &quot;systems&quot;">weather</a>`
    );
    expect(html).not.toContain("href");
  });

  it("writes an external link with its href in a data attribute", () => {
    expect(
      inlineToHtml([
        { kind: "extlink", href: "https://example.com/a?b=1&c=2", children: [text("src")] },
      ])
    ).toBe(`<a data-ve="extlink" data-ve-href="https://example.com/a?b=1&amp;c=2">src</a>`);
  });

  it("writes an inline atomic as an uneditable span labelled with its chip text", () => {
    expect(
      inlineToHtml([
        { kind: "atomic", atomic: "ref", source: "<ref>Cited & noted</ref>", label: "ref" },
      ])
    ).toBe(
      `<span data-ve="atomic" data-ve-kind="ref"` +
        ` data-ve-src="&lt;ref&gt;Cited &amp; noted&lt;/ref&gt;" contenteditable="false">ref</span>`
    );
  });

  it("writes a break with the spelling it was written with, and escapes text", () => {
    // The DOM has no room for the spelling, so it rides in the attribute —
    // without it every save reflows an untouched paragraph that used `<br>`.
    expect(inlineToHtml([text("a < b"), { kind: "break", source: "<br>" }])).toBe(
      `a &lt; b<br data-ve-break="&lt;br&gt;">`
    );
    expect(inlineToHtml([{ kind: "break", source: "<br />" }])).toBe(
      `<br data-ve-break="&lt;br /&gt;">`
    );
  });
});

describe("documentToHtml", () => {
  it("concatenates the blocks in order", () => {
    const doc: VeDocument = {
      leading: "",
      blocks: [
        { ...newBlockBase("b0"), kind: "heading", level: 2, children: [text("Moon")] },
        { ...newBlockBase("b1"), kind: "paragraph", children: [text("Text")] },
      ],
    };
    expect(documentToHtml(doc)).toBe(
      `<h2 data-ve="h" data-ve-id="b0">Moon</h2><p data-ve="p" data-ve-id="b1">Text</p>`
    );
  });
});

/* ------------------------------------------------------------------ */
/* HTML → model: block tolerance                                       */
/* ------------------------------------------------------------------ */

describe("domToDocument block tolerance", () => {
  it("reads our own paragraph and a browser-made div as paragraphs", () => {
    const doc = read([
      el("p", { "data-ve": "p", "data-ve-id": "b0" }, [txt("ours")]),
      el("div", {}, [txt("theirs")]),
    ]);
    expect(doc.blocks.map((block) => block.kind)).toEqual(["paragraph", "paragraph"]);
    expect(paragraphChildren(doc.blocks[1])).toEqual([text("theirs")]);
  });

  it("reads a lone filler br back as an empty paragraph", () => {
    expect(
      paragraphChildren(
        readOne([el("p", { "data-ve": "p" }, [el("br", { "data-ve-filler": "" })])])
      )
    ).toEqual([]);
  });

  it("keeps a lone br the writer did not label — it is the author's spacer line", () => {
    // `<br>` on a line of its own is standard wikitext practice, and it parses
    // as a paragraph holding one break. Reading it as an empty paragraph
    // deleted the line on the next keystroke anywhere on the page (§4).
    expect(
      paragraphChildren(readOne([el("p", { "data-ve": "p", "data-ve-id": "b0" }, [el("br")])]))
    ).toEqual([{ kind: "break", source: "<br />" }]);
    expect(
      paragraphChildren(
        readOne([el("p", { "data-ve": "p" }, [el("br", { "data-ve-break": "<br>" })])])
      )
    ).toEqual([{ kind: "break", source: "<br>" }]);
  });

  it("reads every heading tag at its own level", () => {
    for (const level of [1, 2, 3, 4, 5, 6] as const) {
      const block = readOne([el(`h${level}`, {}, [txt("T")])]);
      expect(block.kind === "heading" ? block.level : null).toBe(level);
    }
  });

  it("falls back to a sub-heading when data-ve=h is on something that is not a heading", () => {
    const block = readOne([el("div", { "data-ve": "h" }, [txt("pasted")])]);
    expect(block.kind === "heading" ? block.level : null).toBe(2);
  });

  it("reads a bare hr and a wrapper holding one as the same rule", () => {
    expect(readOne([el("hr")]).kind).toBe("rule");
    expect(
      readOne([el("div", { "data-ve": "rule", contenteditable: "false" }, [el("hr")])]).kind
    ).toBe("rule");
    expect(readOne([el("div", {}, [el("hr")])]).kind).toBe("rule");
  });

  it("defaults a rule to four dashes and keeps the original run when the id matches", () => {
    const block = readOne([el("div", { "data-ve": "rule" }, [el("hr")])]);
    expect(block.kind === "rule" ? block.dashes : null).toBe(4);

    const prev: VeDocument = {
      leading: "",
      blocks: [{ ...newBlockBase("r1"), kind: "rule", dashes: 9 }],
    };
    const kept = readOne(
      [el("div", { "data-ve": "rule", "data-ve-id": "r1" }, [el("hr")])],
      prev
    );
    expect(kept.kind === "rule" ? kept.dashes : null).toBe(9);
  });

  it("collects loose text and inline elements into a paragraph of their own", () => {
    const doc = read([
      txt("loose "),
      el("b", {}, [txt("text")]),
      el("p", { "data-ve": "p" }, [txt("then a block")]),
    ]);
    expect(doc.blocks).toHaveLength(2);
    expect(paragraphChildren(doc.blocks[0])).toEqual([
      text("loose "),
      { kind: "mark", mark: "bold", children: [text("text")] },
    ]);
  });

  it("keeps the previous document's leading text, which the DOM cannot hold", () => {
    const prev: VeDocument = { leading: "\n", blocks: [] };
    expect(read([el("p", {}, [txt("x")])], prev).leading).toBe("\n");
  });

  it("degrades to a paragraph instead of throwing when a node is hostile", () => {
    const hostile: VeDomNode = {
      nodeType: 1,
      nodeName: "P",
      nodeValue: null,
      childNodes: [],
      getAttribute: (): string | null => {
        throw new Error("detached node");
      },
    };
    const doc = read([hostile, el("p", {}, [txt("after")])]);
    expect(doc.blocks.map((block) => block.kind)).toEqual(["paragraph", "paragraph"]);
    expect(paragraphChildren(doc.blocks[1])).toEqual([text("after")]);
  });
});

/* ------------------------------------------------------------------ */
/* HTML → model: inline tolerance                                      */
/* ------------------------------------------------------------------ */

describe("domToDocument inline tolerance", () => {
  it("maps every spelling execCommand produces onto a mark", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["strong", "bold"],
      ["b", "bold"],
      ["em", "italic"],
      ["i", "italic"],
      ["ins", "underline"],
      ["u", "underline"],
      ["del", "strike"],
      ["s", "strike"],
      ["strike", "strike"],
      ["sup", "sup"],
      ["sub", "sub"],
      ["code", "code"],
      ["tt", "code"],
    ];
    for (const [tag, mark] of cases) {
      expect(paragraphChildren(readOne([el("p", {}, [el(tag, {}, [txt("x")])])]))).toEqual([
        { kind: "mark", mark, children: [text("x")] },
      ]);
    }
  });

  it("drops font and bare span wrappers and merges the text they split", () => {
    const block = readOne([
      el("p", {}, [
        txt("a"),
        el("font", { color: "#ff0000" }, [txt("b"), el("span", { style: "x" }, [txt("c")])]),
        txt("d"),
      ]),
    ]);
    expect(paragraphChildren(block)).toEqual([text("abcd")]);
  });

  it("keeps a mark that a transparent wrapper contains", () => {
    const block = readOne([el("p", {}, [el("span", {}, [el("strong", {}, [txt("bold")])])])]);
    expect(paragraphChildren(block)).toEqual([
      { kind: "mark", mark: "bold", children: [text("bold")] },
    ]);
  });

  it("reduces an unknown element to its text", () => {
    const block = readOne([
      el("p", {}, [el("blockquote", {}, [el("small", {}, [txt("quoted")])])]),
    ]);
    expect(paragraphChildren(block)).toEqual([text("quoted")]);
  });

  it("reads a br as a self-closing break", () => {
    const block = readOne([el("p", {}, [txt("a"), el("br"), txt("b")])]);
    expect(paragraphChildren(block)).toEqual([
      text("a"),
      { kind: "break", source: "<br />" },
      text("b"),
    ]);
  });

  it("reads our own anchors back", () => {
    const block = readOne([
      el("p", {}, [
        el("a", { "data-ve": "link", "data-ve-target": "Eclipsed" }, [txt("eclipses")]),
        el("a", { "data-ve": "extlink", "data-ve-href": "https://example.com" }, [txt("src")]),
      ]),
    ]);
    expect(paragraphChildren(block)).toEqual([
      { kind: "link", target: "Eclipsed", children: [text("eclipses")] },
      { kind: "extlink", href: "https://example.com", children: [text("src")] },
    ]);
  });

  it("treats an anchor with a scheme as external and a bare one as a wiki link", () => {
    const block = readOne([
      el("p", {}, [
        el("a", { href: "https://example.com/x" }, [txt("out")]),
        el("a", { href: "//cdn.example.com/y" }, [txt("proto")]),
        el("a", {}, [txt("Artifice")]),
      ]),
    ]);
    expect(paragraphChildren(block)).toEqual([
      { kind: "extlink", href: "https://example.com/x", children: [text("out")] },
      { kind: "extlink", href: "//cdn.example.com/y", children: [text("proto")] },
      { kind: "link", target: "Artifice", children: [text("Artifice")] },
    ]);
  });

  it("reads an inline atomic from its attribute and labels it with its chip text", () => {
    const block = readOne([
      el("p", {}, [
        el(
          "span",
          {
            "data-ve": "atomic",
            "data-ve-kind": "ref",
            "data-ve-src": "<ref>note</ref>",
            contenteditable: "false",
          },
          [txt("ref")]
        ),
      ]),
    ]);
    expect(paragraphChildren(block)).toEqual([
      { kind: "atomic", atomic: "ref", source: "<ref>note</ref>", label: "ref" },
    ]);
  });

  it("degrades an unrecognised data-ve-kind rather than trusting it", () => {
    const block = readOne([
      el("p", {}, [el("span", { "data-ve-kind": "wat", "data-ve-src": "{{x}}" }, [txt("x")])]),
    ]);
    expect(paragraphChildren(block)).toEqual([
      { kind: "atomic", atomic: "unknown", source: "{{x}}", label: "x" },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Atomics never re-read their body                                    */
/* ------------------------------------------------------------------ */

describe("atomic blocks", () => {
  it("serializes from data-ve-src even when the rendered body was tampered with", () => {
    const block = readOne([
      el(
        "div",
        {
          "data-ve": "atomic",
          "data-ve-id": "a1",
          "data-ve-kind": "template",
          "data-ve-src": "{{Map|Artifice}}",
          contenteditable: "false",
        },
        [
          el("div", { "data-ve-body": "" }, [
            txt("typed into the preview"),
            el("p", { "data-ve": "p", "data-ve-id": "b9" }, [txt("and a whole block")]),
          ]),
        ]
      ),
    ]);
    expect(block).toEqual({
      ...newBlockBase("a1"),
      kind: "atomic",
      atomic: "template",
      source: "{{Map|Artifice}}",
      label: "{{Map|Artifice}}",
    });
    expect(blockToHtml(block)).toContain(`data-ve-src="{{Map|Artifice}}"`);
  });

  it("keeps an edited source but still inherits the parse-time bookkeeping", () => {
    const prev: VeDocument = {
      leading: "",
      blocks: [
        {
          id: "a1",
          source: "{{Map|Old}}",
          canonical: "{{Map|Old}}",
          gapAfter: "\n\n",
          kind: "atomic",
          atomic: "template",
          label: "Map",
        },
      ],
    };
    const block = readOne(
      [
        el("div", {
          "data-ve": "atomic",
          "data-ve-id": "a1",
          "data-ve-kind": "template",
          "data-ve-src": "{{Map|New}}",
        }),
      ],
      prev
    );
    expect(block).toEqual({
      id: "a1",
      source: "{{Map|New}}",
      canonical: "{{Map|Old}}",
      gapAfter: "\n\n",
      kind: "atomic",
      atomic: "template",
      label: "{{Map|New}}",
    });
  });

  it("keeps the parser's label while the source is untouched", () => {
    const prev: VeDocument = {
      leading: "",
      blocks: [
        {
          id: "a1",
          source: "{{Map|Artifice}}",
          canonical: "{{Map|Artifice}}",
          gapAfter: "\n\n",
          kind: "atomic",
          atomic: "template",
          label: "Map",
        },
      ],
    };
    const block = readOne(
      [
        el("div", {
          "data-ve": "atomic",
          "data-ve-id": "a1",
          "data-ve-kind": "template",
          "data-ve-src": "{{Map|Artifice}}",
        }),
      ],
      prev
    );
    expect(block.kind === "atomic" ? block.label : null).toBe("Map");
  });
});

/* ------------------------------------------------------------------ */
/* Lists, both ways                                                    */
/* ------------------------------------------------------------------ */

describe("lists", () => {
  it("flattens a nested tree back to markers, skipping the holders it labelled", () => {
    const block = readOne([
      el("ul", { "data-ve": "list", "data-ve-id": "l1" }, [
        el("li", { "data-ve-hold": "" }, [el("ol", {}, [el("li", {}, [txt("deep")])])]),
      ]),
    ]);
    expect(markers(block)).toEqual(["*#"]);
  });

  it("keeps an unlabelled empty item that holds a deeper list", () => {
    // The markup a marker jump writes and the markup an authored empty bullet
    // writes are byte-identical, so only the label may decide. Inferring
    // "holder" from "empty" deleted the blank bullet of a list nobody touched.
    const block = readOne([
      el("ul", { "data-ve": "list", "data-ve-id": "l1" }, [
        el("li", {}, [txt("Main entrance")]),
        el("li", {}, [el("ul", {}, [el("li", {}, [txt("through the fire exit")])])]),
        el("li", {}, [txt("Ladder")]),
      ]),
    ]);
    expect(markers(block)).toEqual(["*", "*", "**", "*"]);
    if (block.kind !== "list") throw new Error("expected a list");
    expect(block.items[1].children).toEqual([]);
  });

  it("reads a dl's terms and definitions as their own markers", () => {
    const block = readOne([
      el("dl", {}, [el("dt", {}, [txt("term")]), el("dd", {}, [txt("def")])]),
    ]);
    expect(markers(block)).toEqual([";", ":"]);
  });

  it("rejoins the sibling roots one list block writes, but not a second block", () => {
    const merged = read([
      el("ul", { "data-ve": "list", "data-ve-id": "l1" }, [el("li", {}, [txt("a")])]),
      el("ol", {}, [el("li", {}, [txt("b")])]),
    ]);
    expect(merged.blocks).toHaveLength(1);
    expect(markers(merged.blocks[0])).toEqual(["*", "#"]);

    const split = read([
      el("ul", { "data-ve": "list", "data-ve-id": "l1" }, [el("li", {}, [txt("a")])]),
      el("ol", { "data-ve": "list", "data-ve-id": "l2" }, [el("li", {}, [txt("b")])]),
    ]);
    expect(split.blocks).toHaveLength(2);
  });

  it("round-trips a mixed marker run flat → nested → flat", () => {
    const items: VeListItem[] = [
      { marker: "*", children: [text("A")] },
      { marker: "**", children: [text("B")] },
      { marker: "**", children: [text("C")] },
      { marker: "#", children: [text("D")] },
      { marker: ":", children: [text("E")] },
      { marker: ";", children: [text("F")] },
    ];
    const block: VeBlock = { ...newBlockBase("l1"), kind: "list", items };

    // The tree the builder writes …
    expect(blockToHtml(block)).toBe(
      `<ul data-ve="list" data-ve-id="l1"><li>A<ul><li>B</li><li>C</li></ul></li></ul>` +
        `<ol><li>D</li></ol><dl><dd>E</dd></dl><dl><dt>F</dt></dl>`
    );

    // … expressed as nodes, reads back as the same flat items.
    const back = readOne([
      el("ul", { "data-ve": "list", "data-ve-id": "l1" }, [
        el("li", {}, [
          txt("A"),
          el("ul", {}, [el("li", {}, [txt("B")]), el("li", {}, [txt("C")])]),
        ]),
      ]),
      el("ol", {}, [el("li", {}, [txt("D")])]),
      el("dl", {}, [el("dd", {}, [txt("E")])]),
      el("dl", {}, [el("dt", {}, [txt("F")])]),
    ]);
    expect(back).toEqual(block);
  });
});

/* ------------------------------------------------------------------ */
/* Identity (§4)                                                       */
/* ------------------------------------------------------------------ */

describe("domToDocument identity", () => {
  const prev: VeDocument = {
    leading: "",
    blocks: [
      {
        id: "b0",
        source: "The  original   text",
        canonical: "The original text",
        gapAfter: "\n\n",
        kind: "paragraph",
        children: [text("The original text")],
      },
    ],
  };

  it("inherits source, canonical and gapAfter from the block whose id it carries", () => {
    const block = readOne([el("p", { "data-ve": "p", "data-ve-id": "b0" }, [txt("edited")])], prev);
    expect(block).toEqual({
      id: "b0",
      source: "The  original   text",
      canonical: "The original text",
      gapAfter: "\n\n",
      kind: "paragraph",
      children: [text("edited")],
    });
  });

  it("mints an id with no history for a block the browser created", () => {
    const doc = read([el("p", { "data-ve": "p" }, [txt("new")])], prev);
    expect(doc.blocks[0]).toEqual({
      ...newBlockBase("n1"),
      kind: "paragraph",
      children: [text("new")],
    });
  });

  it("gives the id to the first claimant when Enter duplicates a node", () => {
    const doc = read(
      [
        el("p", { "data-ve": "p", "data-ve-id": "b0" }, [txt("The original")]),
        el("p", { "data-ve": "p", "data-ve-id": "b0" }, [txt(" text")]),
      ],
      prev
    );
    expect(doc.blocks.map((block) => block.id)).toEqual(["b0", "n1"]);
    expect(doc.blocks[0].source).toBe("The  original   text");
    expect(doc.blocks[1]).toEqual({
      ...newBlockBase("n1"),
      kind: "paragraph",
      children: [text(" text")],
    });
  });

  it("keeps a gap while the same block still follows, and drops it when one moves in", () => {
    // A gap belongs to a PAIR. `b0`'s "\n\n" is what separated it from `b1`,
    // and reusing it once a block the author just typed sits there instead
    // republishes the two merged into one (§4).
    const two: VeDocument = {
      leading: "",
      blocks: [
        { ...prev.blocks[0], gapAfter: "\n" },
        {
          id: "b1",
          source: "== H ==",
          canonical: "== H ==",
          gapAfter: "\n",
          kind: "heading",
          level: 2,
          children: [text("H")],
        },
      ],
    };

    const untouched = read(
      [
        el("p", { "data-ve": "p", "data-ve-id": "b0" }, [txt("The original text")]),
        el("h2", { "data-ve": "h", "data-ve-id": "b1" }, [txt("H")]),
      ],
      two
    );
    expect(untouched.blocks.map((block) => block.gapAfter)).toEqual(["\n", "\n"]);

    const typed = read(
      [
        el("p", { "data-ve": "p", "data-ve-id": "b0" }, [txt("The original text")]),
        el("p", { "data-ve": "p" }, [txt("Typed.")]),
        el("h2", { "data-ve": "h", "data-ve-id": "b1" }, [txt("H")]),
      ],
      two
    );
    expect(typed.blocks.map((block) => block.gapAfter)).toEqual([null, null, "\n"]);
    // The block behind `b0` changed, but its own §4 bookkeeping did not.
    expect(typed.blocks[0].source).toBe("The  original   text");
  });

  it("drops the last block's gap once the author appends behind it", () => {
    const last: VeDocument = { leading: "", blocks: [{ ...prev.blocks[0], gapAfter: "\n" }] };
    const doc = read(
      [
        el("p", { "data-ve": "p", "data-ve-id": "b0" }, [txt("The original text")]),
        el("p", { "data-ve": "p" }, [txt("Charlie.")]),
      ],
      last
    );
    expect(doc.blocks.map((block) => block.gapAfter)).toEqual([null, null]);
  });

  it("does not hand a minted id to a block that already claimed it", () => {
    const doc = read([
      el("p", { "data-ve": "p", "data-ve-id": "n1" }, [txt("squatter")]),
      el("p", { "data-ve": "p" }, [txt("minted")]),
    ]);
    expect(doc.blocks.map((block) => block.id)).toEqual(["n1", "n2"]);
  });
});

/* ------------------------------------------------------------------ */
/* Whole-document round trip                                           */
/* ------------------------------------------------------------------ */

describe("documentToHtml → domToDocument", () => {
  it("returns an equal model for a document using every block kind", () => {
    const doc: VeDocument = {
      leading: "",
      blocks: [
        { ...newBlockBase("b0"), kind: "heading", level: 2, children: [text("Artifice")] },
        {
          ...newBlockBase("b1"),
          kind: "paragraph",
          children: [
            text("A moon with "),
            { kind: "mark", mark: "bold", children: [text("weather")] },
            text(" & "),
            { kind: "link", target: "Eclipsed", children: [text("eclipses")] },
            { kind: "break", source: "<br />" },
            { kind: "extlink", href: "https://example.com", children: [text("source")] },
            { kind: "atomic", atomic: "ref", source: "<ref>note</ref>", label: "ref" },
          ],
        },
        {
          ...newBlockBase("b2"),
          kind: "list",
          items: [
            { marker: "*", children: [text("one")] },
            { marker: "**", children: [text("two")] },
          ],
        },
        { ...newBlockBase("b3"), kind: "rule", dashes: 4 },
        {
          ...newBlockBase("b4"),
          kind: "table",
          attrs: 'class="wikitable"',
          caption: null,
          rows: [{ attrs: "", cells: [{ header: true, attrs: "", children: [text("A")] }] }],
        },
        {
          ...newBlockBase("b5"),
          kind: "atomic",
          atomic: "infobox",
          source: "{{Infobox moon}}",
          label: "{{Infobox moon}}",
        },
        { ...newBlockBase("b6"), kind: "paragraph", children: [] },
      ],
    };

    // The markup the writer produces, node for node.
    expect(documentToHtml(doc)).toBe(
      `<h2 data-ve="h" data-ve-id="b0">Artifice</h2>` +
        `<p data-ve="p" data-ve-id="b1">A moon with <b>weather</b> &amp; ` +
        `<a data-ve="link" data-ve-target="Eclipsed">eclipses</a>` +
        `<br data-ve-break="&lt;br /&gt;">` +
        `<a data-ve="extlink" data-ve-href="https://example.com">source</a>` +
        `<span data-ve="atomic" data-ve-kind="ref" data-ve-src="&lt;ref&gt;note&lt;/ref&gt;"` +
        ` contenteditable="false">ref</span></p>` +
        `<ul data-ve="list" data-ve-id="b2"><li>one<ul><li>two</li></ul></li></ul>` +
        `<div data-ve="rule" data-ve-id="b3" contenteditable="false"><hr></div>` +
        `<table data-ve="table" data-ve-id="b4" data-ve-attrs="class=&quot;wikitable&quot;">` +
        `<tr data-ve-attrs=""><th data-ve="cell" data-ve-attrs="">A</th></tr></table>` +
        `<div data-ve="atomic" data-ve-id="b5" data-ve-kind="infobox"` +
        ` data-ve-src="{{Infobox moon}}" contenteditable="false">` +
        `<div data-ve-body=""></div></div>` +
        `<p data-ve="p" data-ve-id="b6"><br data-ve-filler=""></p>`
    );

    const nodes: VeDomNode[] = [
      el("h2", { "data-ve": "h", "data-ve-id": "b0" }, [txt("Artifice")]),
      el("p", { "data-ve": "p", "data-ve-id": "b1" }, [
        txt("A moon with "),
        el("b", {}, [txt("weather")]),
        txt(" & "),
        el("a", { "data-ve": "link", "data-ve-target": "Eclipsed" }, [txt("eclipses")]),
        el("br", { "data-ve-break": "<br />" }),
        el("a", { "data-ve": "extlink", "data-ve-href": "https://example.com" }, [txt("source")]),
        el(
          "span",
          {
            "data-ve": "atomic",
            "data-ve-kind": "ref",
            "data-ve-src": "<ref>note</ref>",
            contenteditable: "false",
          },
          [txt("ref")]
        ),
      ]),
      el("ul", { "data-ve": "list", "data-ve-id": "b2" }, [
        el("li", {}, [txt("one"), el("ul", {}, [el("li", {}, [txt("two")])])]),
      ]),
      el("div", { "data-ve": "rule", "data-ve-id": "b3", contenteditable: "false" }, [el("hr")]),
      el(
        "table",
        { "data-ve": "table", "data-ve-id": "b4", "data-ve-attrs": 'class="wikitable"' },
        [
          el("tr", { "data-ve-attrs": "" }, [
            el("th", { "data-ve": "cell", "data-ve-attrs": "" }, [txt("A")]),
          ]),
        ]
      ),
      el(
        "div",
        {
          "data-ve": "atomic",
          "data-ve-id": "b5",
          "data-ve-kind": "infobox",
          "data-ve-src": "{{Infobox moon}}",
          contenteditable: "false",
        },
        [el("div", { "data-ve-body": "" })]
      ),
      el("p", { "data-ve": "p", "data-ve-id": "b6" }, [el("br", { "data-ve-filler": "" })]),
    ];

    expect(read(nodes)).toEqual(doc);
  });
});

/* ------------------------------------------------------------------ */
/* Tables (§3)                                                         */
/* ------------------------------------------------------------------ */

function cell(value: string, header = false, attrs = ""): VeTableCell {
  return { header, attrs, children: value === "" ? [] : [text(value)] };
}

function tableBlock(rows: VeTableRow[], attrs = "", caption: VeInline[] | null = null): VeTable {
  return { ...newBlockBase("b0"), kind: "table", attrs, caption, rows };
}

/** The two-row table most of this wiki's articles are made of. */
const SCRAP = tableBlock(
  [
    { attrs: "", cells: [cell("Item", true), cell("Value", true)] },
    { attrs: 'bgcolor="#eee"', cells: [cell("Gold bar"), cell("210", false, 'style="width:3em"')] },
  ],
  'class="wikitable"',
  [text("Scrap values")],
);

/** The caption and the two rows of {@link SCRAP}, as the writer emits them. */
function scrapChildren(): VeDomNode[] {
  return [
    el("caption", { "data-ve": "caption" }, [txt("Scrap values")]),
    el("tr", { "data-ve-attrs": "" }, [
      el("th", { "data-ve": "cell", "data-ve-attrs": "" }, [txt("Item")]),
      el("th", { "data-ve": "cell", "data-ve-attrs": "" }, [txt("Value")]),
    ]),
    el("tr", { "data-ve-attrs": 'bgcolor="#eee"' }, [
      el("td", { "data-ve": "cell", "data-ve-attrs": "" }, [txt("Gold bar")]),
      el("td", { "data-ve": "cell", "data-ve-attrs": 'style="width:3em"' }, [txt("210")]),
    ]),
  ];
}

/** `blockToHtml(SCRAP)`, as the nodes a browser would hand back unchanged. */
function scrapNodes(children: VeDomNode[] = scrapChildren()): VeDomNode[] {
  return [
    el(
      "table",
      { "data-ve": "table", "data-ve-id": "b0", "data-ve-attrs": 'class="wikitable"' },
      children,
    ),
  ];
}

describe("tables", () => {
  it("writes §3's mapping, with every attribute string in a data attribute", () => {
    // Not as real HTML attributes: which of them an article may keep is the
    // engine's sanitizer's decision (spec §7.2), and the surface is not a
    // renderer. Cells carry no `contenteditable="false"` — being ordinary
    // editable regions is the whole point of the block.
    expect(blockToHtml(SCRAP)).toBe(
      `<table data-ve="table" data-ve-id="b0" data-ve-attrs="class=&quot;wikitable&quot;">` +
        `<caption data-ve="caption">Scrap values</caption>` +
        `<tr data-ve-attrs=""><th data-ve="cell" data-ve-attrs="">Item</th>` +
        `<th data-ve="cell" data-ve-attrs="">Value</th></tr>` +
        `<tr data-ve-attrs="bgcolor=&quot;#eee&quot;">` +
        `<td data-ve="cell" data-ve-attrs="">Gold bar</td>` +
        `<td data-ve="cell" data-ve-attrs="style=&quot;width:3em&quot;">210</td></tr>` +
        `</table>`,
    );
  });

  it("writes no caption element at all when the table has none", () => {
    expect(blockToHtml(tableBlock([{ attrs: "", cells: [cell("a")] }]))).toBe(
      `<table data-ve="table" data-ve-id="b0" data-ve-attrs="">` +
        `<tr data-ve-attrs=""><td data-ve="cell" data-ve-attrs="">a</td></tr></table>`,
    );
  });

  it("gives an empty cell and an empty caption a paragraph's labelled filler", () => {
    const empty = tableBlock([{ attrs: "", cells: [cell("")] }], "", []);
    expect(blockToHtml(empty)).toBe(
      `<table data-ve="table" data-ve-id="b0" data-ve-attrs="">` +
        `<caption data-ve="caption"><br data-ve-filler=""></caption>` +
        `<tr data-ve-attrs=""><td data-ve="cell" data-ve-attrs=""><br data-ve-filler=""></td></tr>` +
        `</table>`,
    );
    // And the filler comes back off again, so an empty cell stays empty.
    expect(
      readOne([
        el("table", { "data-ve": "table", "data-ve-id": "b0", "data-ve-attrs": "" }, [
          el("caption", { "data-ve": "caption" }, [el("br", { "data-ve-filler": "" })]),
          el("tr", { "data-ve-attrs": "" }, [
            el("td", { "data-ve": "cell", "data-ve-attrs": "" }, [
              el("br", { "data-ve-filler": "" }),
            ]),
          ]),
        ]),
      ]),
    ).toEqual(empty);
  });

  it("reads the table it wrote back into the same model", () => {
    expect(readOne(scrapNodes())).toEqual(SCRAP);
  });

  it("walks through the tbody a browser inserts", () => {
    const [caption, header, body] = scrapChildren();
    expect(readOne(scrapNodes([caption, el("tbody", {}, [header, body])]))).toEqual(SCRAP);
  });

  it("adopts a cell the browser left outside a row", () => {
    const block = readOne([
      el("table", { "data-ve": "table", "data-ve-id": "b0", "data-ve-attrs": "" }, [
        el("td", { "data-ve": "cell", "data-ve-attrs": "" }, [txt("loose")]),
        el("tr", { "data-ve-attrs": "" }, [
          el("td", { "data-ve": "cell", "data-ve-attrs": "" }, [txt("in a row")]),
        ]),
      ]),
    ]);
    expect(block).toEqual(
      tableBlock([
        { attrs: "", cells: [cell("loose")] },
        { attrs: "", cells: [cell("in a row")] },
      ]),
    );
  });

  it("drops a row the author emptied, because §7.5 renders nothing for one", () => {
    const block = readOne([
      el("table", { "data-ve": "table", "data-ve-id": "b0", "data-ve-attrs": "" }, [
        el("tr", { "data-ve-attrs": "" }, []),
        el("tr", { "data-ve-attrs": "" }, [
          el("td", { "data-ve": "cell", "data-ve-attrs": "" }, [txt("a")]),
        ]),
      ]),
    ]);
    expect(block).toEqual(tableBlock([{ attrs: "", cells: [cell("a")] }]));
  });

  it("sees through the block wrapper a browser leaves in a cell, joining the pieces", () => {
    // Enter inside a cell wraps its content. A cell has no block level (§7.3),
    // so the pieces join into one run — separated the way a wikitext newline
    // reads, as a space.
    const block = readOne([
      el("table", { "data-ve": "table", "data-ve-id": "b0", "data-ve-attrs": "" }, [
        el("tr", { "data-ve-attrs": "" }, [
          el("td", { "data-ve": "cell", "data-ve-attrs": "" }, [
            el("div", {}, [txt("first")]),
            el("div", {}, [txt("second")]),
          ]),
        ]),
      ]),
    ]);
    expect(block).toEqual(tableBlock([{ attrs: "", cells: [cell("first second")] }]));
  });

  it("folds a newline inside a cell to a space", () => {
    // Every table marker sits at the start of a line (§7.1), so a newline in a
    // cell is not something the wikitext can hold: the next line would read as
    // another cell, another row, or the end of the table.
    const block = readOne([
      el("table", { "data-ve": "table", "data-ve-id": "b0", "data-ve-attrs": "" }, [
        el("tr", { "data-ve-attrs": "" }, [
          el("td", { "data-ve": "cell", "data-ve-attrs": "" }, [
            txt("pasted\nover two lines"),
            el("b", {}, [txt("and\nbold")]),
          ]),
        ]),
      ]),
    ]);
    expect(block).toEqual(
      tableBlock([
        {
          attrs: "",
          cells: [
            {
              header: false,
              attrs: "",
              children: [
                text("pasted over two lines"),
                { kind: "mark", mark: "bold", children: [text("and bold")] },
              ],
            },
          ],
        },
      ]),
    );
  });

  it("reads a pasted table that wears none of our labels", () => {
    const block = readOne([
      el("table", {}, [
        el("tbody", {}, [
          el("tr", {}, [el("th", {}, [txt("A")]), el("th", {}, [txt("B")])]),
          el("tr", {}, [el("td", {}, [txt("1")]), el("td", {}, [txt("2")])]),
        ]),
      ]),
    ]);
    if (block.kind !== "table") throw new Error("expected a table");
    expect(block.attrs).toBe("");
    expect(block.rows.map((row) => row.cells.map((one) => one.header))).toEqual([
      [true, true],
      [false, false],
    ]);
  });

  it("degrades a table with nothing left in it to a paragraph", () => {
    // model.ts's invariant is that a table has a row and a row has a cell; a
    // `<table>` with neither is what an author looking at an empty paragraph
    // should get back.
    const block = readOne([
      el("table", { "data-ve": "table", "data-ve-id": "b0", "data-ve-attrs": "" }, []),
    ]);
    expect(block.kind).toBe("paragraph");
  });

  it("carries §4's bookkeeping across from the block it was written from", () => {
    const prev: VeDocument = {
      leading: "",
      blocks: [
        {
          ...SCRAP,
          source: "{|\n! Item !! Value\n|-\n| Gold bar || 210\n|}",
          canonical: "{|\n|-\n! Item !! Value\n|-\n| Gold bar || 210\n|}",
          gapAfter: "\n\n",
        },
      ],
    };
    const block = readOne(scrapNodes(), prev);
    expect(block.id).toBe("b0");
    expect(block.source).toBe("{|\n! Item !! Value\n|-\n| Gold bar || 210\n|}");
    expect(block.canonical).toBe("{|\n|-\n! Item !! Value\n|-\n| Gold bar || 210\n|}");
    expect(block.gapAfter).toBe("\n\n");
  });
});

/* ---------------------------------------------------------------- */
/* Caret holders — the one character the surface writes (section 3)  */
/* ---------------------------------------------------------------- */

/**
 * An inline chip is `contenteditable="false"`, and a cell holding nothing else
 * has no text position beside it for a browser to put a caret in — naming one
 * in a Range is not enough, engines normalize it away (that is how clicking to
 * the right of such a chip landed in the *next* cell). So the surface parks a
 * zero-width space there.
 *
 * Which makes exactly one promise worth testing: **it can never be published.**
 */
describe("caret holders", () => {
  it("is taken out of a text node before anything reads it", () => {
    const block = readOne([
      el("p", { "data-ve": "p", "data-ve-id": "b0" }, [txt(`a${CARET_HOLDER}b`)]),
    ]);
    expect(block.kind).toBe("paragraph");
    if (block.kind !== "paragraph") return;
    expect(block.children).toEqual([{ kind: "text", text: "ab" }]);
  });

  it("leaves a cell holding one exactly as empty as it looks", () => {
    // The shape the report was about: a cell whose only content is a chip, with
    // a holder parked beside it so the caret has somewhere to stand.
    const doc = read([
      el("table", { "data-ve": "table", "data-ve-id": "b0", "data-ve-attrs": "" }, [
        el("tr", { "data-ve-attrs": "" }, [
          el("td", { "data-ve": "cell", "data-ve-attrs": "" }, [txt("Cell1")]),
          el("td", { "data-ve": "cell", "data-ve-attrs": "" }, [
            el(
              "span",
              { "data-ve": "atomic", "data-ve-kind": "versions", "data-ve-src": "<v69>a</v69>" },
              [txt("v69")],
            ),
            txt(CARET_HOLDER),
          ]),
        ]),
      ]),
    ]);
    expect(serializeDocument(doc)).toBe('{|\n|-\n| Cell1 || <v69>a</v69>\n|}\n');
  });

  it("survives a whole round trip without leaving a trace", () => {
    // Section 4's promise, with the one character the surface is allowed to add:
    // a document read back through a holder republishes byte for byte.
    const source = "A paragraph.\n\nAnother one.\n";
    const doc = parseDocument(source);
    const withHolder = read([
      el("p", { "data-ve": "p", "data-ve-id": doc.blocks[0].id }, [
        txt("A paragraph."),
        txt(CARET_HOLDER),
      ]),
      el("p", { "data-ve": "p", "data-ve-id": doc.blocks[1].id }, [txt("Another one.")]),
    ], doc);
    expect(serializeDocument(withHolder)).toBe(source);
  });

  it("strips every one of them, wherever they landed", () => {
    // Unconditional, which also cleans up after a paste from a word processor.
    expect(withoutCaretHolders(`${CARET_HOLDER}a${CARET_HOLDER}${CARET_HOLDER}b`)).toBe("ab");
    expect(withoutCaretHolders("nothing to do")).toBe("nothing to do");
    expect(withoutCaretHolders("")).toBe("");
  });
});
