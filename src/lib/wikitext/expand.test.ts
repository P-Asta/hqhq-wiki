import { describe, expect, it } from "vitest";

import { DEFAULT_NAMESPACES } from "@/lib/title";

import { decodeExtPayload, expand, rootFrame } from "./expand";
import { titleKeyOf } from "./magic-words";
import { preprocess } from "./preprocessor";
import type {
  ExpandHooks,
  PageStore,
  ParseContext,
  VersionTable,
  WikiConfig,
} from "./types";

/* ---------------------------------------------------------------- */
/* Fixtures (spec §15 corpus templates)                              */
/* ---------------------------------------------------------------- */

const PAGES: Record<string, string> = {
  "10:1x": "{{{1}}}",
  "10:N": "[{{{k}}}]",
  "10:Echo": "[{{{1}}}][{{{k}}}]",
  "10:Hello": "Hi {{{1}}}, welcome to {{{site|the wiki}}}!",
  "10:Bullet": "* {{{1}}}",
  "10:Boxtop": '{| class="box"',
  "10:Boxend": "|}",
  "10:Loop": "{{Loop}}",
  "10:T": "V",
  "10:Braces4": "{{{{a}}}}",
  "10:Braces5": "{{{{{a}}}}}",
  "10:Outer": "outer:{{Inner}}",
  "10:Inner": "inner:{{Missing}}",
  "10:A": "{{B}}",
  "10:B": "{{C}}",
  "10:C": "end",
  "10:Doc": "A<noinclude>N</noinclude><includeonly>I</includeonly>",
  "10:Quota": "<v50+v55>{{1x|130}}</v50+v55><v62+>180</v62+>",
  "0:Bestiary": "intro<onlyinclude>CORE</onlyinclude>outro",
  "0:Bracken": "bracken",
};

const store: PageStore = {
  getSource: (key) => PAGES[key] ?? null,
  exists: (key) => key in PAGES,
  getFile: () => null,
};

const VERSION_IDS: [string, number][] = [
  ["v45", 45000],
  ["v50", 50000],
  ["v55", 55000],
  ["v62", 62000],
  ["v64", 64000],
  ["v70", 70000],
];

function versionTable(defaultId = "v70"): VersionTable {
  const ordered = VERSION_IDS.map(([id, ordinal]) => ({
    id,
    label: id,
    ordinal,
    status: (id === defaultId ? "current" : "legacy") as "current" | "legacy",
  }));
  return {
    byId: Object.fromEntries(ordered.map((e) => [e.id, e])),
    ordered,
    defaultId,
  };
}

function makeConfig(over: Partial<WikiConfig> = {}): WikiConfig {
  return {
    siteName: "HQHQ Wiki",
    articlePath: "/wiki/$1",
    redLinkPath: "/wiki/$1?redlink=1",
    externalLinkRel: "nofollow noopener",
    caseSensitive: false,
    maxTemplateDepth: 40,
    maxIncludeSize: 2_097_152,
    maxExpensiveCalls: 100,
    thumbDefaultWidth: 220,
    uprightDefaultFactor: 0.75,
    timezone: "UTC",
    fragmentMode: "html5",
    namespaces: DEFAULT_NAMESPACES,
    messages: {
      tocTitle: "Contents",
      redLinkTitleSuffix: "(page does not exist)",
      redirectTo: "Redirect to:",
      citeErrorNoText: (name) => 'Cite error: no text provided for ref "' + name + '"',
      templateLoop: "Template loop detected",
      templateDepthExceeded: "Template recursion depth limit exceeded (40)",
      unknownVersion: (id) => "Unknown version: " + id,
    },
    ...over,
  };
}

interface RunOptions {
  version?: string | null;
  preview?: boolean;
  config?: Partial<WikiConfig>;
  hooks?: ExpandHooks;
}

function makeCtx(options: RunOptions = {}): ParseContext {
  return {
    config: makeConfig(options.config),
    store,
    page: { namespace: 0, pageName: "Test" },
    version: options.version ?? null,
    versions: versionTable(),
    preview: options.preview,
  };
}

function run(source: string, options: RunOptions = {}) {
  const ctx = makeCtx(options);
  return options.hooks === undefined
    ? expand(preprocess(source, ctx, false), ctx, rootFrame(ctx.page))
    : expand(preprocess(source, ctx, false), ctx, rootFrame(ctx.page), options.hooks);
}

/** Expanded text with every strip marker replaced by its stored value. */
function restored(result: ReturnType<typeof run>): string {
  let text = result.text;
  for (const [marker, value] of result.strips) text = text.split(marker).join(value);
  return text;
}

/* ---------------------------------------------------------------- */
/* §8.3 argument semantics                                           */
/* ---------------------------------------------------------------- */

describe("template arguments (§8.3)", () => {
  it("C-46: positional arguments are NOT trimmed", () => {
    expect(run("{{1x| a }}").text).toBe(" a ");
  });

  it("C-47: named arguments are trimmed", () => {
    expect(run("{{N|k= v }}").text).toBe("[v]");
  });

  it("§8.9-2: both rules at once", () => {
    expect(run("{{Echo| a |k= b }}").text).toBe("[ a ][b]");
  });

  it("C-48: the later duplicate wins", () => {
    expect(run("{{1x|1=a|b}}").text).toBe("b");
    expect(run("{{Echo|1=first|second|k=x}}").text).toBe("[second][x]");
  });

  it("§8.9-1: defaults apply only to absent arguments", () => {
    expect(run("{{Hello|Pasta}}").text).toBe("Hi Pasta, welcome to the wiki!");
    expect(run("{{Hello|Pasta|site=HQHQ}}").text).toBe("Hi Pasta, welcome to HQHQ!");
    expect(run("{{Hello}}").text).toBe("Hi {{{1}}}, welcome to the wiki!");
  });

  it("§8.4: top-level parameters render literally, defaults still apply", () => {
    expect(run("{{{x}}}/{{{x|d}}}").text).toBe("{{{x}}}/d");
  });

  it("§8.5: unused arguments are never expanded (lazy frames)", () => {
    const result = run("{{1x|a|{{Loop}}}}");
    expect(result.text).toBe("a");
    expect(result.meta.templatesUsed).not.toContain("10:Loop");
  });
});

/* ---------------------------------------------------------------- */
/* §8.1 brace puzzles through expansion                              */
/* ---------------------------------------------------------------- */

describe("brace puzzles (§8.9-5)", () => {
  it("C-50: {{{{a}}}} at top level renders literally", () => {
    expect(run("{{{{a}}}}").text).toBe("{{{{a}}}}");
  });

  it("inside a frame with a=T: {{{{{a}}}}} → V and {{{{a}}}} → {T}", () => {
    expect(run("{{Braces5|a=T}}").text).toBe("V");
    expect(run("{{Braces4|a=T}}").text).toBe("{T}");
  });
});

/* ---------------------------------------------------------------- */
/* §8.2 name resolution                                              */
/* ---------------------------------------------------------------- */

describe("name resolution (§8.2)", () => {
  it("C-53: subst:/safesubst: are stripped (D-8)", () => {
    expect(run("{{subst:1x|y}}").text).toBe("y");
    expect(run("{{safesubst:1x|y}}").text).toBe("y");
  });

  it("first-letter case folding lands on the Template namespace", () => {
    expect(run("{{1x|z}}").text).toBe("z");
    expect(run("{{echo|q}}").text).toBe("[q][{{{k}}}]");
  });

  it("§8.9-7: {{:Page}} transcludes from the main namespace with onlyinclude", () => {
    expect(run("{{:Bestiary}}").text).toBe("CORE");
  });

  it("§8.6: transclusion keeps includeonly and drops noinclude", () => {
    expect(run("{{Doc}}").text).toBe("AI");
    // Rendering the page itself is the other half of the matrix.
    const ctx = makeCtx();
    expect(
      expand(preprocess(PAGES["10:Doc"], ctx, false), ctx, rootFrame(ctx.page)).text,
    ).toBe("AN");
  });

  it("rule 6: a missing target becomes a red link and is still recorded (A4)", () => {
    // §11 forbids raw `<a>`, so parser-generated links travel behind a strip
    // marker (§14.8) and stage 6 restores them verbatim.
    const result = run("{{Missing thing}}");
    expect(restored(result)).toBe(
      '<a href="/wiki/template:missing-thing?redlink=1" class="new red-link" ' +
        'title="Template:Missing thing (page does not exist)">Template:Missing thing</a>',
    );
    expect(result.meta.templatesUsed).toEqual(["10:Missing_thing"]);
  });

  it("Addendum A4: templatesUsed is transitive and includes missing targets", () => {
    const result = run("{{Outer}}");
    expect(result.meta.templatesUsed).toEqual(["10:Outer", "10:Inner", "10:Missing"]);
  });

  it("rule 7: a name with illegal title characters renders literally", () => {
    expect(run("{{ {{Missing}} }}").text).toBe("{{ {{Missing}} }}");
  });
});

/* ---------------------------------------------------------------- */
/* §8.5 limits                                                       */
/* ---------------------------------------------------------------- */

describe("expansion limits (§8.5)", () => {
  it("C-49: a template loop reports an error span", () => {
    const result = run("{{Loop}}");
    expect(restored(result)).toBe(
      '<span class="error">Template loop detected: ' +
        '<a href="/wiki/template:loop" title="Template:Loop">Template:Loop</a></span>',
    );
  });

  it("depth beyond maxTemplateDepth errors out", () => {
    const result = run("{{A}}", { config: { maxTemplateDepth: 2 } });
    expect(restored(result)).toBe(
      '<span class="error">Template recursion depth limit exceeded (40)</span>',
    );
  });

  it("past maxIncludeSize further calls render like missing targets", () => {
    const result = run("{{1x|hello}}{{1x|again}}", { config: { maxIncludeSize: 1 } });
    expect(restored(result).startsWith("hello<a ")).toBe(true);
    expect(result.meta.warnings).toContain("include-size-limit-exceeded");
  });
});

/* ---------------------------------------------------------------- */
/* §7.10 / §8.7                                                      */
/* ---------------------------------------------------------------- */

describe("built-ins and splicing", () => {
  it("§7.10: {{!}} and {{=}} expand to real markup characters", () => {
    expect(run("a{{!}}b{{=}}c").text).toBe("a|b=c");
  });

  it("C-52: the T2529 auto-newline precedes block markup", () => {
    expect(run("Loot: {{Bullet|Gold bar}}").text).toBe("Loot: \n* Gold bar");
  });

  it("C-39: a template-produced `{|` still starts at line start", () => {
    expect(run("{{Boxtop}}\n| cell\n{{Boxend}}").text).toBe('{| class="box"\n| cell\n|}');
  });

  it("no newline is added when the call already sits at line start", () => {
    expect(run("{{Bullet|x}}").text).toBe("* x");
  });
});

/* ---------------------------------------------------------------- */
/* §10 extension tags → strip markers                                */
/* ---------------------------------------------------------------- */

describe("extension tags (§10, §14.8)", () => {
  it("C-61: nowiki content is protected from every later stage", () => {
    const result = run("<nowiki>[[x]] {{1x|y}} ''z''</nowiki>");
    expect(result.strips.size).toBe(1);
    expect([...result.strips.values()][0]).toBe("[[x]] {{1x|y}} ''z''");
    expect(result.text).not.toContain("[[x]]");
  });

  it("C-54: a protected pipe is not an argument separator", () => {
    const result = run("{{1x|a<nowiki>|</nowiki>b}}");
    expect(restored(result)).toBe("a|b");
  });

  it("C-62: <pre> keeps its content literal", () => {
    const result = run("<pre>''not italic'' {{NotATemplate}}</pre>");
    expect(restored(result)).toBe("<pre>''not italic'' {{NotATemplate}}</pre>");
  });

  it("C-69: <syntaxhighlight> escapes and wraps its content", () => {
    const result = run('<syntaxhighlight lang="ts">a < b</syntaxhighlight>');
    expect(restored(result)).toBe(
      '<pre class="mw-highlight"><code class="language-ts">a &lt; b</code></pre>',
    );
  });

  it("<nowiki /> produces an empty marker that still splits constructs", () => {
    const result = run("[[moon]]<nowiki/>s");
    expect(result.strips.size).toBe(1);
    expect([...result.strips.values()][0]).toBe("");
  });

  it("C-51: a <ref> produced by a template carries expanded wikitext to the renderer", () => {
    const result = run("{{1x|<ref name=a>R {{1x|X}}</ref>}}");
    const [marker, value] = [...result.strips.entries()][0];
    expect(marker).toMatch(/UNIQ--ref-[0-9a-f]{8}-QINU/);
    expect(decodeExtPayload(value)).toEqual({
      tag: "ref",
      attrs: { name: "a" },
      inner: "R X",
    });
  });

  it("markers are deterministic across identical runs (§14.11)", () => {
    const a = run("<ref>x</ref> <nowiki>y</nowiki>");
    const b = run("<ref>x</ref> <nowiki>y</nowiki>");
    expect(a.text).toBe(b.text);
    expect([...a.strips.entries()]).toEqual([...b.strips.entries()]);
  });
});

/* ---------------------------------------------------------------- */
/* versioning.md §2 — version tags, resolved in stage 2               */
/* ---------------------------------------------------------------- */

describe("version tags (versioning.md §2)", () => {
  it("the three forms window content and re-expand the chosen body", () => {
    // Quota's v50 branch holds a template call: the body is wikitext, and it
    // is expanded in the frame the tag was written in.
    const source = PAGES["10:Quota"];
    expect(run(source, { version: "v45" }).text).toBe("");
    expect(run(source, { version: "v50" }).text).toBe("130");
    expect(run(source, { version: "v55" }).text).toBe("130");
    expect(run(source, { version: "v62" }).text).toBe("180");
    expect(run(source, { version: "v70" }).text).toBe("180");
  });

  it("<v62> applies to that one version and to nothing else", () => {
    const source = "<v62>only here</v62>";
    expect(run(source, { version: "v55" }).text).toBe("");
    expect(run(source, { version: "v62" }).text).toBe("only here");
    expect(run(source, { version: "v64" }).text).toBe("");
  });

  it("untagged prose belongs to every version", () => {
    // This is what replaces the old since=\"*\" fallback.
    const source = "base<v62+> plus</v62+>";
    expect(run(source, { version: "v50" }).text).toBe("base");
    expect(run(source, { version: "v62" }).text).toBe("base plus");
  });

  it("a nested tag resolves inside the branch that shows it", () => {
    const source = "<v50+><v62+>late</v62+>early</v50+>";
    expect(run(source, { version: "v45" }).text).toBe("");
    expect(run(source, { version: "v50" }).text).toBe("early");
    expect(run(source, { version: "v62" }).text).toBe("lateearly");
  });

  it("a tag inside a template argument reaches the argument intact", () => {
    expect(run("{{1x|<v62+>new</v62+>}}", { version: "v50" }).text).toBe("");
    expect(run("{{1x|<v62+>new</v62+>}}", { version: "v62" }).text).toBe("new");
  });

  it("works through a template call and records boundaries before selection", () => {
    const result = run("Quota: {{Quota}}", { version: "v50" });
    expect(result.text).toBe("Quota: 130");
    expect(result.meta.versionScoped).toBe(true);
    expect(result.meta.versionBoundaries).toEqual(["v50", "v55", "v62"]);
  });

  it("a null version resolves as the site default (versioning.md §5)", () => {
    expect(run(PAGES["10:Quota"], { version: null }).text).toBe("180");
  });

  it("an unregistered id is ordered by its derived ordinal, without warning", () => {
    expect(run("<v99+>future</v99+>", { version: "v70" }).text).toBe("");
    const out = run("<v99+>future</v99+>", { version: "v99" });
    expect(out.text).toBe("future");
    expect(out.meta.warnings).toEqual([]);
    // Still offered to the selector, so somebody can see it is unregistered.
    expect(out.meta.versionBoundaries).toEqual(["v99"]);
  });

  it("preview mode renders the branch, with no error span to add", () => {
    const out = run("<v62+>x</v62+>", { version: "v70", preview: true });
    expect(out.text).toBe("x");
    expect(out.text).not.toContain("wiki-error");
  });

  it("<versions>/<variant>/<version> are no longer extension tags", () => {
    // They fall to §10.7's unknown-tag rule — which is exactly what makes the
    // seed conversion necessary. Stage 2 hands them on untouched.
    const single = '<version since="v62">x</version>';
    expect(run(single, { version: "v62" }).text).toBe(single);
    expect(run(single, { version: "v62" }).meta.versionScoped).toBe(false);

    const group = '<versions><variant since="v50">a</variant></versions>';
    expect(run(group, { version: "v50" }).text).toBe(group);
    expect(run(group, { version: "v50" }).meta.versionBoundaries).toEqual([]);
  });

  it("{{VERSION}} magic words resolve without the parser-function module", () => {
    expect(run("{{VERSION}}/{{ISLATESTVERSION}}", { version: "v50" }).text).toBe("v50/");
    expect(run("{{VERSION}}/{{ISLATESTVERSION}}", { version: "v70" }).text).toBe("v70/1");
  });

  it("#ifversion and #vswitch fall back to versions.ts", () => {
    expect(run("{{#ifversion: >=v62 | new | old }}", { version: "v50" }).text).toBe("old");
    expect(run("{{#ifversion: >=v62 | new | old }}", { version: "v64" }).text).toBe("new");
    expect(run("{{#vswitch: v50=1400 | v62=1500 }}", { version: "v55" }).text).toBe("1400");
    expect(run("{{#vswitch: v50=1400 | v62=1500 }}", { version: "v64" }).text).toBe("1500");
    expect(run("{{#vswitch: v50=1400 | v62={{1x|1500}} }}", { version: "v64" }).text).toBe("1500");
  });
});

/* ---------------------------------------------------------------- */
/* §9 dispatch to the parser-function module                         */
/* ---------------------------------------------------------------- */

describe("parser-function dispatch (§9.1)", () => {
  /** A stand-in for the §9 module, proving stage 2 only talks to the seam. */
  const hooks: ExpandHooks = {
    isParserFunction: (name) => ["#if", "lc"].includes(name.toLowerCase()),
    evaluateParserFunction(name, args) {
      const key = name.toLowerCase();
      if (key === "#if") {
        const taken = args[0].value() !== "" ? args[1] : args[2];
        return taken === undefined ? "" : taken.value();
      }
      if (key === "lc") return args[0].value().toLowerCase();
      return null;
    },
    evaluateMagicWord(name, api) {
      return name === "PAGENAME" ? api.ctx.page.pageName : null;
    },
  };

  it("routes #-functions and colon functions to the handler", () => {
    expect(run("{{#if: x |y|n}}{{#if:   |y|n}}", { hooks }).text).toBe("yn");
    expect(run("{{lc: LOOT }}", { hooks }).text).toBe("loot");
  });

  it("only the taken branch is expanded (§8.5 laziness)", () => {
    const result = run("{{#if: x | ok | {{Loop}} }}", { hooks });
    expect(result.text).toBe("ok");
    expect(result.meta.templatesUsed).toEqual([]);
  });

  it("magic words shadow templates of the same name", () => {
    expect(run("{{PAGENAME}}", { hooks }).text).toBe("Test");
  });

  it("C-55: the real module is wired in by default", () => {
    expect(run("{{#if: |y|n}}{{#if: 0 |y|n}}").text).toBe("ny");
    expect(run("{{ucfirst:{{lc:LOOT}}}}").text).toBe("Loot");
  });

  it("D-11: an unknown #function reports the standard error span", () => {
    expect(run("{{#nope: x}}").text).toBe(
      '<span class="error">Unknown parser function: #nope</span>',
    );
  });

  it("a colon prefix that is not a function stays a transclusion", () => {
    const result = run("{{Help:Box}}");
    expect(result.meta.templatesUsed).toEqual(["12:Box"]);
    expect(restored(result)).toContain('class="new red-link"');
  });
});

/* ---------------------------------------------------------------- */

describe("PageStore keys", () => {
  it("stage 2 looks templates up by titleKeyOf (spec §14.10)", () => {
    expect(titleKeyOf({ namespace: 10, pageName: "Infobox moon" })).toBe("10:Infobox_moon");
    expect(run("{{Infobox moon}}").meta.templatesUsed).toEqual(["10:Infobox_moon"]);
  });
});
