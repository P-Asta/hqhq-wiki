import { describe, expect, it } from "vitest";

import {
  applyIncludeFilter,
  buildTree,
  isExtTagName,
  parseAttributes,
  parseRedirect,
  stringifyNodes,
} from "./preprocessor";
import type { PPExtTag, PPNode, PPParameter, PPTemplate } from "./types";

/* ---------------------------------------------------------------- */
/* helpers                                                           */
/* ---------------------------------------------------------------- */

function kinds(nodes: readonly PPNode[]): string[] {
  return nodes.map((n) => n.kind);
}

function text(node: PPNode): string {
  return node.kind === "text" ? node.value : "";
}

function asTemplate(node: PPNode): PPTemplate {
  if (node.kind !== "template") throw new Error("expected template, got " + node.kind);
  return node;
}

function asParameter(node: PPNode): PPParameter {
  if (node.kind !== "parameter") throw new Error("expected parameter, got " + node.kind);
  return node;
}

function asExt(node: PPNode): PPExtTag {
  if (node.kind !== "ext") throw new Error("expected ext, got " + node.kind);
  return node;
}

/* ---------------------------------------------------------------- */
/* §8.1 brace matching                                               */
/* ---------------------------------------------------------------- */

describe("brace matching (§8.1)", () => {
  it("C-50: {{{{a}}}} is `{` + parameter + `}`", () => {
    const nodes = buildTree("{{{{a}}}}");
    expect(kinds(nodes)).toEqual(["text", "parameter", "text"]);
    expect(text(nodes[0])).toBe("{");
    expect(text(nodes[2])).toBe("}");
    expect(stringifyNodes(asParameter(nodes[1]).name)).toBe("a");
  });

  it("{{{{{a}}}}} is a template whose name is the parameter", () => {
    const nodes = buildTree("{{{{{a}}}}}");
    expect(kinds(nodes)).toEqual(["template"]);
    const tpl = asTemplate(nodes[0]);
    expect(kinds(tpl.name)).toEqual(["parameter"]);
    expect(tpl.params).toHaveLength(0);
  });

  it("nests innermost-first: {{a|{{b}}}}", () => {
    const tpl = asTemplate(buildTree("{{a|{{b}}}}")[0]);
    expect(stringifyNodes(tpl.name)).toBe("a");
    expect(tpl.params).toHaveLength(1);
    expect(kinds(tpl.params[0].value)).toEqual(["template"]);
  });

  it("leaves unmatched braces literal ({{a} and unclosed {{a)", () => {
    expect(stringifyNodes(buildTree("{{a}"))).toBe("{{a}");
    expect(kinds(buildTree("{{a}"))).toEqual(["text"]);
    expect(stringifyNodes(buildTree("{{a|b"))).toBe("{{a|b");
    expect(kinds(buildTree("{{a|b"))).toEqual(["text"]);
  });

  it("splits arguments on top-level pipes only", () => {
    const tpl = asTemplate(buildTree("{{T|a|{{U|x}}|c}}")[0]);
    expect(tpl.params).toHaveLength(3);
    expect(stringifyNodes(tpl.params[0].value)).toBe("a");
    expect(stringifyNodes(tpl.params[2].value)).toBe("c");
  });

  it("§8.3: `[[…]]` shields pipes from the argument splitter", () => {
    const tpl = asTemplate(buildTree("{{T|[[a|b]]}}")[0]);
    expect(tpl.params).toHaveLength(1);
    expect(stringifyNodes(tpl.params[0].value)).toBe("[[a|b]]");
  });

  it("§8.3: only the first top-level `=` splits a named argument", () => {
    const tpl = asTemplate(buildTree("{{T|a=b=c}}")[0]);
    expect(tpl.params).toHaveLength(1);
    expect(stringifyNodes(tpl.params[0].name ?? [])).toBe("a");
    expect(stringifyNodes(tpl.params[0].value)).toBe("b=c");
  });

  it("§8.3: `=` in the name part never splits", () => {
    const tpl = asTemplate(buildTree("{{#ifeq: a = b |x}}")[0]);
    expect(stringifyNodes(tpl.name)).toBe("#ifeq: a = b ");
  });

  it("§8.4: further pipes belong to a parameter default", () => {
    const param = asParameter(buildTree("{{{a|b|c}}}")[0]);
    expect(stringifyNodes(param.name)).toBe("a");
    expect(stringifyNodes(param.default ?? [])).toBe("b|c");
  });

  it("§8.4: `=` inside a parameter default stays literal", () => {
    const param = asParameter(buildTree("{{{a|b=c}}}")[0]);
    expect(stringifyNodes(param.default ?? [])).toBe("b=c");
  });
});

/* ---------------------------------------------------------------- */
/* §10.8 comments                                                    */
/* ---------------------------------------------------------------- */

describe("comments (§10.8)", () => {
  it("a comment inside a template name vanishes", () => {
    const tpl = asTemplate(buildTree("{{Temp<!-- x -->late}}")[0]);
    expect(kinds(tpl.name)).toEqual(["text", "comment", "text"]);
    expect(tpl.name.map((n) => (n.kind === "text" ? n.value : "")).join("")).toBe("Template");
  });

  it("§14.2: brace runs must be contiguous — {<!-- -->{Foo}} is not a call", () => {
    const nodes = buildTree("{<!-- -->{Foo}}");
    expect(nodes.some((n) => n.kind === "template")).toBe(false);
  });

  it("C-72: a comment alone on a line eats the whole line", () => {
    const nodes = buildTree("a\n<!-- note -->\nb\n");
    const flat = nodes.map((n) => (n.kind === "text" ? n.value : "")).join("");
    expect(flat).toBe("a\nb\n");
  });

  it("an inline comment does not eat the line", () => {
    const nodes = buildTree("a <!-- c --> b\n");
    const flat = nodes.map((n) => (n.kind === "text" ? n.value : "")).join("");
    expect(flat).toBe("a  b\n");
  });

  it("an unclosed comment swallows the rest of the input", () => {
    const nodes = buildTree("a<!-- b {{T}}");
    expect(kinds(nodes)).toEqual(["text", "comment"]);
  });
});

/* ---------------------------------------------------------------- */
/* §10 extension tags                                                */
/* ---------------------------------------------------------------- */

describe("extension tags (§10)", () => {
  it("§14.2: ext capture beats brace matching", () => {
    const tpl = asTemplate(buildTree("{{x|<nowiki>}}</nowiki>}}")[0]);
    expect(stringifyNodes(tpl.name)).toBe("x");
    expect(tpl.params).toHaveLength(1);
    const ext = asExt(tpl.params[0].value[0]);
    expect(ext.name).toBe("nowiki");
    expect(ext.inner).toBe("}}");
  });

  it("captures attributes and self-closing tags", () => {
    const nodes = buildTree('<ref name="a" group=g/>');
    const ext = asExt(nodes[0]);
    expect(ext.name).toBe("ref");
    expect(ext.attrs).toEqual({ name: "a", group: "g" });
    expect(ext.inner).toBeNull();
  });

  it("capture is non-greedy", () => {
    const nodes = buildTree("<nowiki>a</nowiki>b<nowiki>c</nowiki>");
    expect(kinds(nodes)).toEqual(["ext", "text", "ext"]);
  });

  it("an unclosed ext tag swallows to end of input", () => {
    const ext = asExt(buildTree("<nowiki>a {{T}}")[0]);
    expect(ext.inner).toBe("a {{T}}");
  });

  it("leaves unregistered tags as literal text", () => {
    expect(kinds(buildTree("<div>x</div>"))).toEqual(["text"]);
  });

  it("parses bare attributes as empty strings", () => {
    expect(parseAttributes(' lang="ts" inline')).toEqual({ lang: "ts", inline: "" });
  });
});

/* ---------------------------------------------------------------- */
/* versioning §2.1 — a tag recognised by SHAPE, not by a name list   */
/* ---------------------------------------------------------------- */

describe("version tags (versioning §2.1)", () => {
  it("captures all three forms as ordinary ext nodes", () => {
    for (const [name, body] of [
      ["v70", "a"],
      ["v70+v80", "b"],
      ["v64.1+", "c"],
    ]) {
      const ext = asExt(buildTree(`<${name}>${body}</${name}>`)[0]);
      expect(ext.name).toBe(name);
      expect(ext.inner).toBe(body);
    }
  });

  it("lowercases the name, so the closing tag matches case-insensitively", () => {
    const ext = asExt(buildTree("<V64.1+>x</v64.1+>")[0]);
    expect(ext.name).toBe("v64.1+");
    expect(ext.inner).toBe("x");
  });

  it("only a closing name that repeats the opening one closes the tag", () => {
    // `</v70>` is a different tag, so §10's unclosed rule takes over.
    expect(asExt(buildTree("<v70+v80>x</v70>")[0]).inner).toBe("x</v70>");
    // …and the name is escaped into the search pattern, so `+` is a literal
    // plus rather than "one or more of the previous character".
    expect(asExt(buildTree("<v70+v80>x</v700v80>")[0]).inner).toBe("x</v700v80>");
  });

  it("leaves names that merely look version-ish as literal text", () => {
    for (const name of ["var", "video", "v70x", "v70v80", "version", "versions", "variant"]) {
      expect(kinds(buildTree(`<${name}>x</${name}>`))).toEqual(["text"]);
    }
  });

  it("isExtTagName is the one seam the scanner asks", () => {
    expect(isExtTagName("nowiki")).toBe(true);
    expect(isExtTagName("NOWIKI")).toBe(true);
    expect(isExtTagName("v70+")).toBe(true);
    expect(isExtTagName("V64.1+V70")).toBe(true);
    expect(isExtTagName("versions")).toBe(false);
    expect(isExtTagName("var")).toBe(false);
  });

  it("survives include filtering, so a template can hold one (§8.6)", () => {
    const source = "<noinclude>doc</noinclude><v62+>body</v62+>";
    const ext = asExt(buildTree(applyIncludeFilter(source, true))[0]);
    expect(ext.name).toBe("v62+");
    expect(ext.inner).toBe("body");
  });

  it("round-trips through stringifyNodes", () => {
    const source = "<v50+v61>a</v50+v61>";
    expect(stringifyNodes(buildTree(source))).toBe(source);
  });
});

/* ---------------------------------------------------------------- */
/* §8.6 include filtering                                            */
/* ---------------------------------------------------------------- */

describe("include filtering (§8.6)", () => {
  const source = "A<noinclude>N</noinclude><includeonly>I</includeonly>";

  it("rendering the page keeps noinclude, drops includeonly", () => {
    expect(applyIncludeFilter(source, false)).toBe("AN");
  });

  it("transcluding drops noinclude, keeps includeonly", () => {
    expect(applyIncludeFilter(source, true)).toBe("AI");
  });

  it("onlyinclude wins for transclusion and is transparent otherwise", () => {
    const page = "intro<onlyinclude>CORE</onlyinclude>outro";
    expect(applyIncludeFilter(page, true)).toBe("CORE");
    expect(applyIncludeFilter(page, false)).toBe("introCOREoutro");
  });

  it("concatenates every onlyinclude section", () => {
    const page = "x<onlyinclude>A</onlyinclude>y<onlyinclude>B</onlyinclude>z";
    expect(applyIncludeFilter(page, true)).toBe("AB");
  });

  it("an unclosed tag runs to the end of the page", () => {
    expect(applyIncludeFilter("keep<noinclude>gone", true)).toBe("keep");
    expect(applyIncludeFilter("keep<includeonly>tail", false)).toBe("keep");
  });
});

/* ---------------------------------------------------------------- */
/* §12 redirects                                                     */
/* ---------------------------------------------------------------- */

describe("parseRedirect (§12.1)", () => {
  it("C-70: keeps the fragment on target.fragment (Addendum A2)", () => {
    const redirect = parseRedirect("#REDIRECT [[Target#Frag]]\n");
    expect(redirect?.target.pageName).toBe("Target");
    expect(redirect?.target.namespace).toBe(0);
    expect(redirect?.target.fragment).toBe("Frag");
  });

  it("C-71: `#REDIRECT` below the first line is not a redirect", () => {
    expect(parseRedirect("text\n#REDIRECT [[Target]]\n")).toBeNull();
  });

  it("accepts any case, an optional colon and a piped label", () => {
    expect(parseRedirect("#redirect: [[Moons|the moons]] trail")?.target.pageName).toBe("Moons");
  });

  it("skips leading whitespace and comments", () => {
    const redirect = parseRedirect("\n<!-- c -->\n#REDIRECT [[Template:Box]]");
    expect(redirect?.target.namespace).toBe(10);
    expect(redirect?.target.pageName).toBe("Box");
  });

  it("reports the body offset so the remainder can still render (§12.3)", () => {
    const source = "#REDIRECT [[Target]]\n[[Category:Moons]]";
    const redirect = parseRedirect(source);
    expect(source.slice(redirect?.bodyOffset)).toBe("\n[[Category:Moons]]");
  });

  it("is not a redirect without a valid link target", () => {
    expect(parseRedirect("#REDIRECT Target")).toBeNull();
    expect(parseRedirect("#REDIRECT [[]]")).toBeNull();
  });
});

/* ---------------------------------------------------------------- */
/* round-trip                                                        */
/* ---------------------------------------------------------------- */

describe("stringifyNodes", () => {
  it("reconstructs the source of a call", () => {
    const src = "{{T|a|k=v|{{{p|d}}}}}";
    expect(stringifyNodes(buildTree(src))).toBe(src);
  });
});
