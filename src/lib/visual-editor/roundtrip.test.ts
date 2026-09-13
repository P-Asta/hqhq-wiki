/**
 * The round-trip guarantee, on real articles — docs/engine/visual-editor.md
 * §4: "Opening an article in visual mode and publishing without an edit must
 * produce a byte-identical revision."
 *
 * parse.test.ts and serialize.test.ts test hand-written fixtures, which is
 * exactly the problem: fixtures are written by the same person who wrote the
 * parser and inherit their blind spots. This file runs the same two functions
 * over every wikitext string the wiki actually ships — the seeded templates,
 * articles, their translations, the help pages and the redirects — and asserts
 * byte equality with the LF-normalized original. {@link ADVERSARIAL} adds the
 * inputs a review caught the parser on, which are text nobody chose either.
 *
 * Five properties, in increasing strength:
 *
 * 1. **Byte equality.** `serializeDocument(parseDocument(w)) === w`.
 * 2. **Idempotence.** Parsing and serializing again changes nothing further.
 * 3. **A canonical fixed point.** Rebuild the whole page from the model —
 *    every block marked as edited, every gap defaulted, so nothing is
 *    preserved through `source` — and the result re-parses to itself. That is
 *    the property which catches a parse and a serialize that disagree while
 *    happening to cancel out, and it is also what the surface produces once an
 *    author has touched every paragraph on a page.
 * 4. **Locality.** Editing one block rewrites that block and not one byte
 *    more, for every block of every article.
 * 5. **The same through the surface.** The three functions above are only half
 *    the path an author's edit takes: the model is written to HTML, the
 *    browser hands it back, and `domToDocument` rebuilds it. Properties 1 and
 *    4 hold there too — and *only* there do the writer and the reader have to
 *    agree about markup neither wikitext nor the model can distinguish.
 * 6. **Tables specifically**, because they are the newest block and the one
 *    the wiki has most of. The five properties above already run over every
 *    table in the corpus; the last section adds what is particular to them —
 *    that the corpus writes them in a style the serializer would not have
 *    chosen and keeps it, that a cell's templates survive the cell splitting,
 *    and that editing one cell reflows that table and nothing else.
 *
 * A failure here is a parser bug, never a reason to relax the assertion.
 */

import { describe, expect, it } from "vitest";

import { ENTITY_ARTICLES } from "@/lib/db/seed-content/entities";
import { EQUIPMENT_SCRAP_ARTICLES } from "@/lib/db/seed-content/equipment-scrap";
import { MECHANICS_STRATEGY_ARTICLES } from "@/lib/db/seed-content/mechanics-strategies";
import { MOON_ARTICLES } from "@/lib/db/seed-content/moons";
import { ARTICLES, HELP_PAGES, REDIRECTS, TEMPLATES } from "@/lib/db/seed-data";
import type { SeedArticle } from "@/lib/db/seed-data";

import { documentToHtml, domToDocument, type VeDomNode } from "./dom";
import { createIdFactory, type VeBlock, type VeDocument } from "./model";
import { parseDocument } from "./parse";
import { serializeBlock, serializeDocument } from "./serialize";

/* ---------------------------------------------------------------- */
/* The corpus                                                        */
/* ---------------------------------------------------------------- */

interface Fixture {
  name: string;
  wikitext: string;
}

function buildCorpus(): Fixture[] {
  const out: Fixture[] = [];
  const seen = new Set<string>();
  const add = (name: string, wikitext: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push({ name, wikitext });
  };

  for (const template of TEMPLATES) add(`Template:${template.title}`, template.wikitext);

  // ARTICLES is core + extra, but the four seed-content modules are listed
  // explicitly so a new batch that forgets to join `EXTRA_ARTICLES` is still
  // covered here.
  const articles: readonly SeedArticle[] = [
    ...ARTICLES,
    ...MOON_ARTICLES,
    ...ENTITY_ARTICLES,
    ...EQUIPMENT_SCRAP_ARTICLES,
    ...MECHANICS_STRATEGY_ARTICLES,
  ];
  for (const article of articles) {
    add(article.title, article.wikitext);
    for (const translation of article.translations) {
      add(`${article.title} [${translation.locale}]`, translation.wikitext);
    }
  }

  for (const help of HELP_PAGES) {
    add(`Help:${help.title}`, help.wikitext);
    for (const translation of help.translations) {
      add(`Help:${help.title} [${translation.locale}]`, translation.wikitext);
    }
  }

  for (const redirect of REDIRECTS) add(`Redirect:${redirect.title}`, redirect.wikitext);

  return out;
}

const CORPUS = buildCorpus();

/**
 * The inputs a review caught this parser on. Nobody writes them on purpose,
 * but one keystroke makes the first five, and every one of them broke a
 * property below: the paragraph that swallowed the rest of the article failed
 * 4, and the one that ate the document's last newline failed 3. They belong
 * beside the corpus for the reason the corpus exists — to be text no fixture
 * author chose.
 *
 * Markup nested deeper than the parser's cap is in parse.test.ts instead:
 * rebuilding it canonically rewrites its outer `<b>` as `'''` (§4's mark
 * trade), so the *canonical* form of a 4000-deep nest is not a fixed point.
 * Its source form is, which is what publishing an untouched page needs.
 */
const ADVERSARIAL: Fixture[] = [
  {
    name: "typo: one missing brace, mid-article",
    wikitext:
      "Artifice is a moon with a difficulty rating of S.\n\n" +
      "The weather is {{Verify|storm}.\n\n" +
      "== Layout ==\n\n" +
      "* Main entrance\n* Fire exit\n\n" +
      '{| class="wikitable"\n! Item !! Value\n|-\n| Ship || 1\n|}\n\n' +
      "[[Category:Moons]]\n",
  },
  { name: "typo: an unclosed `{{` on the last line", wikitext: "Intro.\n\nHello {{Foo\n" },
  {
    name: "prose that mentions `<div>`",
    wikitext: "Wrap it in a <div> to float it.\n\n== H ==\n\nMore.\n",
  },
  {
    name: "prose that mentions `<div>` and closes it three blocks later",
    wikitext: "See the <div> element.\n\n== H ==\n\nThen </div> closes it.\n",
  },
  { name: "an unclosed `[[` before a heading", wikitext: "Intro [[Titan\n\n== H ==\n\nTail.\n" },
  { name: "a template that closes after a blank line", wikitext: "Text {{Foo|\n\nbar}} more\n" },
  {
    name: "a ref that closes after a blank line",
    wikitext:
      'Artifice pays best.<ref name="wiki">Cross-checked\n\nagainst the wiki.</ref> Next.\n\n== H ==\n',
  },
  { name: "6000 nested links", wikitext: `${"[[".repeat(6000)}x${"]]".repeat(6000)}\n` },
  { name: "10000 openers that never close", wikitext: `${"<b>".repeat(10000)}\n` },
  { name: "10000 openers and one closer", wikitext: `${"<b>".repeat(10000)}</b>\n` },
  { name: "20000 unclosed braces", wikitext: `${"{{".repeat(20000)}\n` },
  { name: "20000 unclosed refs", wikitext: `${"<ref>".repeat(20000)}\n` },
];

/**
 * Tables, which are the one construct with two possible parses — a first-class
 * block when every cell holds inline content that survives being written back,
 * and the atomic chip they have always been when one does not (parse.ts,
 * `readTable`).
 *
 * The seed corpus writes every one of its tables the same way — an implicit
 * first row, cells joined with `||` — so the other spellings are here, where
 * the four properties above reach them. The last few are refusals, and they
 * belong in this list precisely because a refusal has to round-trip too: it is
 * the fallback the whole design leans on.
 */
const TABLES: Fixture[] = [
  {
    name: "table: the corpus style, an implicit first row",
    wikitext: '{| class="wikitable"\n! Item !! Value\n|-\n| Gold bar || 210\n|}\n',
  },
  {
    name: "table: one cell per line, every row opened with `|-`",
    wikitext: "{|\n|-\n! Item\n! Value\n|-\n| Gold bar\n| 210\n|}\n",
  },
  {
    name: "table: a caption, and attributes on the table, a row and a cell",
    wikitext:
      '{| class="wikitable" style="width:20em"\n' +
      "|+ Scrap values\n" +
      "|-\n" +
      "! Item !! Value\n" +
      '|- bgcolor="#eee"\n' +
      '| style="color:red" | Flask || 30\n' +
      "|}\n",
  },
  {
    name: "table: a header row below the body, and a row mixing both kinds",
    wikitext: "{|\n| 1 || 2\n|-\n! A\n| b\n! C\n|-\n! Totals !! 3\n|}\n",
  },
  {
    name: "table: rows of three, one and two cells",
    wikitext: "{|\n|-\n| a || b || c\n|-\n| d\n|-\n| e || f\n|}\n",
  },
  {
    name: "table: cells holding templates, links, marks and a ref",
    wikitext:
      "{|\n" +
      "|-\n" +
      "| [[Gold bar]] || ~155 average{{Verify|gold bar average value}}\n" +
      "|-\n" +
      "| '''Stalking''' || Trails its target.<ref name=\"wiki\">Checked.</ref>\n" +
      "|}\n",
  },
  {
    name: "table: an empty cell, an empty caption and `|----` for a row",
    wikitext: "{|\n|+\n|----\n| a ||\n|}\n",
  },
  {
    name: "table: two of them with a single newline between",
    wikitext: "{|\n| a\n|}\n{|\n| b\n|}\n",
  },
  {
    name: "table: one opening on the line after a paragraph",
    wikitext: "Intro.\n{|\n| a\n|}\nOutro.\n",
  },
  {
    name: "table: refused — a nested table",
    wikitext: "{|\n| outer\n{|\n| inner\n|}\n|}\n",
  },
  {
    name: "table: refused — a cell continued over three lines, with a list in it",
    wikitext: "{|\n| Monsters:\n* [[Bracken]]\n* [[Thumper]]\n| Safe\n|}\n",
  },
  {
    name: "table: refused — fostered text, an indent, and trailing text after `|}`",
    wikitext: "{|\nstray\n| a\n|}\n\n:{|\n| x\n|} tail\n",
  },
];

/** What the four properties run over: the real pages, then the hostile ones. */
const FIXTURES: Fixture[] = [...CORPUS, ...ADVERSARIAL, ...TABLES];

function normalize(wikitext: string): string {
  return wikitext.replace(/\r\n?/g, "\n");
}

/* ---------------------------------------------------------------- */
/* The surface                                                       */
/* ---------------------------------------------------------------- */

/**
 * `documentToHtml`'s output as the nodes `domToDocument` walks.
 *
 * vitest runs in node, so there is no DOM to hand the markup to — and one
 * would only prove what the browser does with it. This reads back exactly the
 * subset the writer emits: elements with double-quoted attributes, void `<br>`
 * and `<hr>`, and the four entities `escapeHtml` writes. Anything else is a
 * writer the reader was never told about, so it throws instead of guessing.
 */
const TAG = /<(\/?)([a-z][a-z0-9]*)((?:\s+[a-z-]+="[^"]*")*)\s*>/gi;
const ATTRIBUTE = /([a-z-]+)="([^"]*)"/gi;
const VOID_TAGS = new Set(["BR", "HR"]);

interface SurfaceNode extends VeDomNode {
  /** Narrower than `VeDomNode`'s: a test edits the tree the browser would. */
  childNodes: SurfaceNode[];
}

function unescapeHtml(value: string): string {
  // `&amp;` last, or an escaped `&lt;` comes back as a tag.
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function element(tag: string, attributes: string): SurfaceNode {
  const attrs = new Map<string, string>();
  ATTRIBUTE.lastIndex = 0;
  let found = ATTRIBUTE.exec(attributes);
  while (found !== null) {
    attrs.set(found[1], unescapeHtml(found[2]));
    found = ATTRIBUTE.exec(attributes);
  }
  return {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    nodeValue: null,
    childNodes: [],
    getAttribute: (wanted: string): string | null => attrs.get(wanted) ?? null,
  };
}

function surface(html: string): SurfaceNode {
  const root = element("div", "");
  const stack: SurfaceNode[] = [root];
  const pushText = (raw: string): void => {
    if (raw === "") return;
    const parent = stack[stack.length - 1];
    parent.childNodes.push({
      nodeType: 3,
      nodeName: "#text",
      nodeValue: unescapeHtml(raw),
      childNodes: [],
    });
  };

  let at = 0;
  TAG.lastIndex = 0;
  let match = TAG.exec(html);
  while (match !== null) {
    pushText(html.slice(at, match.index));
    at = TAG.lastIndex;
    const [, closing, tag, attributes] = match;
    if (closing === "/") {
      const open = stack.pop();
      if (open === undefined || open.nodeName !== tag.toUpperCase() || stack.length === 0) {
        throw new Error(`unbalanced </${tag}> in ${html}`);
      }
    } else {
      const node = element(tag, attributes);
      stack[stack.length - 1].childNodes.push(node);
      if (!VOID_TAGS.has(node.nodeName)) stack.push(node);
    }
    match = TAG.exec(html);
  }
  pushText(html.slice(at));
  if (stack.length !== 1) throw new Error(`unclosed element in ${html}`);
  return root;
}

/** One element of surface markup, the way a browser adds one to the page. */
function node(html: string): SurfaceNode {
  const built = surface(html).childNodes;
  expect(built).toHaveLength(1);
  return built[0];
}

/**
 * The whole path an edit takes: open the article in visual mode, let `edit`
 * do to the surface what the browser would, then publish.
 */
function throughSurface(wikitext: string, edit?: (root: SurfaceNode) => void): string {
  const doc = parseDocument(wikitext);
  const root = surface(documentToHtml(doc));
  if (edit !== undefined) edit(root);
  return serializeDocument(domToDocument(root, doc, createIdFactory("n")));
}

/* ---------------------------------------------------------------- */
/* Editing helpers                                                   */
/* ---------------------------------------------------------------- */

/**
 * Rewrite a parsed document as if the author had created every block in the
 * editor: no `source` to fall back on, no `canonical` fingerprint to match,
 * and no remembered gaps (§4). An atomic is exempt because its model *is* its
 * source — the type says as much, and there is nothing to canonicalize away.
 */
function canonicalized(doc: VeDocument): VeDocument {
  for (const block of doc.blocks) {
    if (block.kind !== "atomic") block.source = null;
    block.canonical = null;
    block.gapAfter = null;
  }
  return doc;
}

/**
 * Change one block in the smallest way that is guaranteed to change what it
 * serializes to — the stand-in for an author typing into it.
 */
function editBlock(block: VeBlock): void {
  switch (block.kind) {
    case "paragraph":
    case "heading":
      block.children = [{ kind: "text", text: "EDITED" }];
      return;
    case "list":
      block.items = [{ marker: "*", children: [{ kind: "text", text: "EDITED" }] }];
      return;
    case "table":
      // Retyping one cell is the smallest edit a table takes, and the model's
      // invariant (model.ts) guarantees there is a first cell to retype.
      block.rows[0].cells[0] = {
        ...block.rows[0].cells[0],
        children: [{ kind: "text", text: "EDITED" }],
      };
      return;
    case "rule":
      block.dashes = block.dashes === 4 ? 5 : 4;
      return;
    case "atomic":
      // §5: an atomic is only ever edited as raw wikitext, through the dialog.
      block.source = "<!-- EDITED -->";
      return;
  }
}

/* ---------------------------------------------------------------- */
/* The corpus is real                                                */
/* ---------------------------------------------------------------- */

describe("seed corpus", () => {
  it("is large enough and varied enough to mean something", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(30);
    // The constructs most likely to break a naive scanner all appear in it.
    const all = CORPUS.map((fixture) => fixture.wikitext).join("\n");
    expect(all).toContain("{|");
    expect(all).toContain("{{Infobox");
    expect(all).toContain("<v62+>");
    expect(all).toContain("<ref");
    expect(all).toContain("[[Category:");
    expect(all).toContain("#REDIRECT");
    expect(all).toContain("<pre>");
  });

  it("parses to at least one block per page", () => {
    for (const fixture of CORPUS) {
      expect(parseDocument(fixture.wikitext).blocks.length).toBeGreaterThan(0);
    }
  });

  it("is not preserved by accident — the canonical rewrite really does differ", () => {
    // Otherwise the fixed-point test below would be a restatement of the
    // identity test: it only means something where re-serializing from the
    // model changes bytes, which is the case a multi-line paragraph or a
    // single-newline gap creates.
    const rewritten = CORPUS.filter(
      (fixture) =>
        serializeDocument(canonicalized(parseDocument(fixture.wikitext))) !==
        normalize(fixture.wikitext),
    );
    expect(rewritten.length).toBeGreaterThan(0);
  });
});

/* ---------------------------------------------------------------- */
/* 1 — byte equality                                                 */
/* ---------------------------------------------------------------- */

describe("parse → serialize is the identity", () => {
  it.each(FIXTURES)("$name comes back byte for byte", ({ wikitext }) => {
    expect(serializeDocument(parseDocument(wikitext))).toBe(normalize(wikitext));
  });
});

/* ---------------------------------------------------------------- */
/* 2 — idempotence                                                   */
/* ---------------------------------------------------------------- */

describe("the round trip is idempotent", () => {
  it.each(FIXTURES)("$name is unchanged by a second pass", ({ wikitext }) => {
    const once = serializeDocument(parseDocument(wikitext));
    expect(serializeDocument(parseDocument(once))).toBe(once);
  });
});

/* ---------------------------------------------------------------- */
/* 3 — the canonical form is a fixed point                           */
/* ---------------------------------------------------------------- */

describe("the canonical form re-parses to itself", () => {
  it.each(FIXTURES)("$name is stable once the whole page is rebuilt", ({ wikitext }) => {
    const canonical = serializeDocument(canonicalized(parseDocument(wikitext)));
    expect(serializeDocument(canonicalized(parseDocument(canonical)))).toBe(canonical);
  });
});

/* ---------------------------------------------------------------- */
/* 4 — one edit touches one block                                    */
/* ---------------------------------------------------------------- */

describe("an edit is confined to the block it was made in", () => {
  it.each(FIXTURES)("$name rewrites only the block that changed", ({ wikitext }) => {
    const normalized = normalize(wikitext);
    const original = parseDocument(wikitext);

    // Where each block's `source` sits in the normalized text — the §4
    // accounting says the slices are consecutive and cover everything.
    const offsets: number[] = [];
    let at = original.leading.length;
    for (const block of original.blocks) {
      offsets.push(at);
      at += (block.source ?? "").length + (block.gapAfter ?? "").length;
    }
    expect(at).toBe(normalized.length);

    for (let index = 0; index < original.blocks.length; index += 1) {
      const doc = parseDocument(wikitext);
      const block = doc.blocks[index];
      const start = offsets[index];
      const stop = start + (block.source ?? "").length;

      editBlock(block);
      const expected = normalized.slice(0, start) + serializeBlock(block) + normalized.slice(stop);
      expect(serializeDocument(doc)).toBe(expected);
    }
  });
});

/* ---------------------------------------------------------------- */
/* 5 — the same, through the editing surface                         */
/* ---------------------------------------------------------------- */

describe("an untouched surface publishes what it was opened with", () => {
  // The tables ride along here as well as through the four properties above:
  // a table is the one block whose markup the writer and the reader can
  // disagree about in ways wikitext alone would never show (§3).
  it.each([...CORPUS, ...TABLES])(
    "$name comes back byte for byte through the DOM",
    ({ wikitext }) => {
      expect(throughSurface(wikitext)).toBe(normalize(wikitext));
    },
  );

  it("keeps constructs no seed article has, where the two halves must agree", () => {
    // A `<br>` on a line of its own is the standard vertical spacer, and it
    // is the same markup as the filler an empty paragraph is written with.
    expect(throughSurface("Intro.\n\n<br>\n\nOutro.\n")).toBe("Intro.\n\n<br>\n\nOutro.\n");
    expect(throughSurface("Intro.<br />\nstill one paragraph.\n")).toBe(
      "Intro.<br />\nstill one paragraph.\n",
    );
    // An item the author left empty is the same markup as the item a marker
    // jump opens to hold the deeper list under it.
    const list = "* Main entrance\n*\n** through the fire exit\n* Ladder\n";
    expect(throughSurface(list)).toBe(list);
    expect(throughSurface("*# straight to the second level\n")).toBe(
      "*# straight to the second level\n",
    );
  });
});

describe("an edit made in the surface lands where the author made it", () => {
  it("gives a paragraph typed at the end of the page a block of its own", () => {
    // The commonest edit on the wiki: caret at the end, Enter, type. Every
    // seeded article ends in a lone "\n", so the block above kept a gap that
    // used to end the document and now has to separate two paragraphs.
    expect(
      throughSurface("Alpha.\n\nBravo.\n", (root) => {
        root.childNodes.push(node(`<p data-ve="p">Charlie.</p>`));
      }),
    ).toBe("Alpha.\n\nBravo.\n\nCharlie.\n");
  });

  it("keeps a paragraph split with Enter split", () => {
    // Enter mid-sentence clones the element, `data-ve-id` and all: the first
    // half keeps the id and the gap that used to lead to the heading.
    expect(
      throughSurface("Alpha beta.\n== H ==\nBody.\n", (root) => {
        root.childNodes.splice(
          0,
          1,
          node(`<p data-ve="p" data-ve-id="b0">Alpha</p>`),
          node(`<p data-ve="p" data-ve-id="b0">beta.</p>`),
        );
      }),
    ).toBe("Alpha\n\nbeta.\n\n== H ==\nBody.\n");
  });

  it("rewrites only the block the author typed in, for every block of every article", () => {
    // Property 4 through the surface: one paragraph is retyped and nothing
    // else on the page may move, gaps included.
    for (const { wikitext } of CORPUS) {
      const doc = parseDocument(wikitext);
      const index = doc.blocks.findIndex((block) => block.kind === "paragraph");
      if (index < 0) continue;

      const edited = throughSurface(wikitext, (root) => {
        const blocks = root.childNodes.filter(
          (child) => child.nodeType === 1 && child.getAttribute?.("data-ve-id") !== null,
        );
        const target = blocks[index];
        target.childNodes.splice(0, target.childNodes.length, {
          nodeType: 3,
          nodeName: "#text",
          nodeValue: "EDITED",
          childNodes: [],
        });
      });

      const expected = parseDocument(wikitext);
      const block = expected.blocks[index];
      if (block.kind !== "paragraph") throw new Error("expected a paragraph");
      block.children = [{ kind: "text", text: "EDITED" }];
      expect(edited).toBe(serializeDocument(expected));
    }
  });
});

/* ---------------------------------------------------------------- */
/* 6 — the tables the wiki actually ships                            */
/* ---------------------------------------------------------------- */

/** Every table block in the corpus, with the page it came from. */
function corpusTables(): { name: string; block: VeBlock }[] {
  const out: { name: string; block: VeBlock }[] = [];
  for (const fixture of CORPUS) {
    for (const block of parseDocument(fixture.wikitext).blocks) {
      const isTable = block.kind === "table" || (block.kind === "atomic" && block.atomic === "table");
      if (isTable) out.push({ name: fixture.name, block });
    }
  }
  return out;
}

const CORPUS_TABLES = corpusTables();

describe("the tables in the corpus", () => {
  it("is a real sample: dozens of them, and they are the editable kind", () => {
    // If this ever drops, the section below has stopped testing tables and
    // started testing whatever the parser now calls them.
    expect(CORPUS_TABLES.length).toBeGreaterThanOrEqual(30);
    const editable = CORPUS_TABLES.filter(({ block }) => block.kind === "table");
    expect(editable.length).toBe(CORPUS_TABLES.length);
  });

  it("keeps every cell's templates and links whole", () => {
    // The split that has to be brace-aware: the engine splits cells after
    // template expansion (§7 preamble), so `{{Verify|x}}` holds a pipe that is
    // not table markup. Splitting on it would show two cells where the article
    // renders one — and write two back the moment the author typed.
    let verified = 0;
    for (const { block } of CORPUS_TABLES) {
      if (block.kind !== "table") continue;
      for (const row of block.rows) {
        for (const cell of row.cells) {
          for (const child of cell.children) {
            if (child.kind !== "atomic" || child.atomic !== "template") continue;
            expect(child.source.startsWith("{{")).toBe(true);
            expect(child.source.endsWith("}}")).toBe(true);
            verified += 1;
          }
        }
      }
    }
    expect(verified).toBeGreaterThan(10);
  });

  it("round-trips byte for byte on its own, and through the surface", () => {
    for (const { name, block } of CORPUS_TABLES) {
      const wikitext = `${block.source ?? ""}\n`;
      expect(`${name}: ${serializeDocument(parseDocument(wikitext))}`).toBe(`${name}: ${wikitext}`);
      expect(`${name}: ${throughSurface(wikitext)}`).toBe(`${name}: ${wikitext}`);
    }
  });

  it("is written in a style the serializer would not have chosen, and keeps it", () => {
    // §4's whole point, on the construct that shows it best. Every seeded
    // table leaves its first row implicit; the canonical form opens every row
    // with `|-`. An author who has not touched the table must not be handed a
    // diff for it.
    const reflowed = CORPUS_TABLES.filter(
      ({ block }) => block.source !== null && block.canonical !== block.source,
    );
    expect(reflowed.length).toBeGreaterThan(20);
    for (const { block } of reflowed) {
      expect(block.canonical).toContain("|-\n!");
      expect(block.source).not.toContain("|-\n!");
    }
  });

  it("adopts the canonical form only for the table the author edited", () => {
    for (const { wikitext } of CORPUS) {
      const doc = parseDocument(wikitext);
      const index = doc.blocks.findIndex((block) => block.kind === "table");
      if (index < 0) continue;

      const edited = parseDocument(wikitext);
      const block = edited.blocks[index];
      if (block.kind !== "table") throw new Error("expected a table");
      editBlock(block);

      const original = doc.blocks[index];
      const before = serializeDocument(doc);
      const after = serializeDocument(edited);
      // Exactly one span of the page moved: the table's own source, replaced
      // by its canonical form with one cell retyped.
      expect(after).toBe(before.replace(original.source ?? "", serializeBlock(block)));
      // The retyped cell is the first on its line, and the line's marker says
      // which kind of cell it was — a header row keeps its `!`.
      expect(after).toMatch(/^[!|] EDITED/m);
    }
  });
});

describe("a table edited in the surface", () => {
  it("takes a cell's new words and rewrites that table and nothing else", () => {
    const wikitext = "Intro.\n\n" + '{| class="wikitable"\n! A !! B\n|-\n| 1 || 2\n|}\n\nOutro.\n';
    const edited = throughSurface(wikitext, (root) => {
      const table = root.childNodes.filter((child) => child.nodeName === "TABLE")[0];
      const cell = table.childNodes[1].childNodes[0];
      cell.childNodes.splice(0, cell.childNodes.length, {
        nodeType: 3,
        nodeName: "#text",
        nodeValue: "EDITED",
        childNodes: [],
      });
    });
    expect(edited).toBe(
      "Intro.\n\n" + '{| class="wikitable"\n|-\n! A !! B\n|-\n| EDITED || 2\n|}\n\nOutro.\n',
    );
  });

  it("survives the tbody a browser inserts and the block wrapper it leaves in a cell", () => {
    const wikitext = "{|\n|-\n| a || b\n|}\n";
    const edited = throughSurface(wikitext, (root) => {
      const table = root.childNodes.filter((child) => child.nodeName === "TABLE")[0];
      const rows = table.childNodes.splice(0, table.childNodes.length);
      const tbody = node("<tbody></tbody>");
      tbody.childNodes.push(...rows);
      table.childNodes.push(tbody);
      // Enter inside the first cell: the browser wraps what was there.
      const cell = rows[0].childNodes[0];
      const wrapper = node("<div></div>");
      wrapper.childNodes.push(...cell.childNodes.splice(0, cell.childNodes.length));
      cell.childNodes.push(wrapper);
    });
    expect(edited).toBe(wikitext);
  });
});
