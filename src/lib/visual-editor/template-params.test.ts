/**
 * Template introspection — src/lib/visual-editor/template-params.ts.
 *
 * The seed templates are the fixture on purpose: the dialog's whole promise is
 * that opening `{{Infobox_moon}}` shows the rows the infobox actually renders,
 * in the order it renders them, so the test asserts against the real bodies
 * rather than a hand-written stand-in.
 */

import { describe, expect, it } from "vitest";

import { TEMPLATES } from "@/lib/db/seed-data";
import { MAGIC_WORDS } from "@/lib/wikitext/magic-words";
import { PARSER_FUNCTIONS } from "@/lib/wikitext/parser-functions";
import {
  NON_TEMPLATE_HEADS,
  buildTemplateCall,
  humanizeParamName,
  newTemplateCall,
  parseTemplateCall,
  parseTemplateData,
  templateSpec,
  unusedParams,
} from "./template-params";

function seed(title: string): string {
  const found = TEMPLATES.find((template) => template.title === title);
  if (!found) throw new Error(`seed template ${title} is missing`);
  return found.wikitext;
}

describe("templateSpec — auto-detection", () => {
  it("lists a template's parameters in body order", () => {
    const spec = templateSpec(seed("Infobox moon"));
    expect(spec.documented).toBe(false);
    expect(spec.params.map((param) => param.name)).toEqual([
      "name",
      "image",
      "cost",
      "tier",
      "risk",
      "layout_size",
      "map_multiplier",
      "min_scrap",
      "max_scrap",
      "weather",
      "interior",
      "indoor_power",
      "outdoor_power",
    ]);
  });

  it("reads the default written in the body and marks the parameter optional", () => {
    const spec = templateSpec(seed("Infobox moon"));
    const name = spec.params.find((param) => param.name === "name");
    expect(name?.required).toBe(false);
    expect(name?.defaultValue).toBe("Unnamed moon");
    expect(name?.label).toBe("Name");
  });

  it("treats a parameter with no default anywhere as required (spec §8.4)", () => {
    // `{{{a}}}` renders its own braces when unset, so the form must demand it.
    const spec = templateSpec("Hello {{{a}}} and {{{b|}}}");
    expect(spec.params.map((p) => [p.name, p.required])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });

  it("lets one defaulted occurrence make a parameter optional", () => {
    // Infobox moon writes {{{image|}}} in the #if guard and {{{image}}} inside it.
    const spec = templateSpec(seed("Infobox moon"));
    expect(spec.params.find((param) => param.name === "image")?.required).toBe(false);
  });

  it("finds positional parameters", () => {
    const spec = templateSpec(seed("Verify"));
    const first = spec.params.find((param) => param.name === "1");
    expect(first?.positional).toBe(true);
    expect(first?.label).toBe("1");
  });

  it("ignores computed parameter names", () => {
    expect(templateSpec("{{{ {{{a|}}} |x}}}").params.map((p) => p.name)).toEqual(["a"]);
  });

  it("stays fast on a body that is one long unclosed brace run", () => {
    // templateSpec answers the anonymous GET /api/templates/{slug} on Node's
    // only thread, so the cost of a planted template is everyone's: 200 000
    // bare braces used to hold that thread for 73 seconds.
    const source = `{{{name|x}}}<nowiki>${"{".repeat(200000)}</nowiki>`;
    const started = performance.now();
    const spec = templateSpec(source);
    expect(performance.now() - started).toBeLessThan(5000);
    // Bounding the scan must not cost the parameters that precede the run.
    expect(spec.params.map((param) => param.name)).toEqual(["name"]);
  }, 30000);

  it("pulls a description out of the template's prose", () => {
    const spec = templateSpec(
      "<noinclude>\n== Usage ==\nAdds a moon infobox.\n[[Category:Templates]]\n</noinclude>{{{a|}}}",
    );
    expect(spec.description).toBe("Adds a moon infobox.");
  });
});

describe("templateSpec — TemplateData", () => {
  const documented = `{{{name|}}}{{{era|}}}
<noinclude><templatedata>
{
  "description": "A moon infobox.",
  "paramOrder": ["era", "name"],
  "params": {
    "name": { "label": "Moon name", "description": "As the terminal spells it", "required": true },
    "era": { "label": "Era", "type": "number", "suggested": true },
    "extra": { "label": "Extra", "type": "wiki-page-name" }
  }
}
</templatedata></noinclude>`;

  it("overrides labels, types and requiredness", () => {
    const spec = templateSpec(documented);
    expect(spec.documented).toBe(true);
    expect(spec.description).toBe("A moon infobox.");
    const name = spec.params.find((param) => param.name === "name");
    expect(name?.label).toBe("Moon name");
    expect(name?.description).toBe("As the terminal spells it");
    expect(name?.required).toBe(true);
  });

  it("honours paramOrder and appends anything it omits", () => {
    expect(templateSpec(documented).params.map((param) => param.name)).toEqual([
      "era",
      "name",
      "extra",
    ]);
  });

  it("adds parameters the body never mentions", () => {
    expect(
      templateSpec(documented)
        .params.find((param) => param.name === "extra")
        ?.type,
    ).toBe("wiki-page-name");
  });

  it("keeps the auto-detected list when the JSON is malformed", () => {
    const spec = templateSpec("{{{a|}}}<templatedata>{ not json </templatedata>");
    expect(spec.documented).toBe(false);
    expect(spec.params.map((param) => param.name)).toEqual(["a"]);
  });

  it("accepts a localized description map", () => {
    expect(parseTemplateData('<templatedata>{"description":{"en":"Hi"}}</templatedata>')).toEqual({
      description: { en: "Hi" },
    });
    expect(templateSpec('{{{a|}}}<templatedata>{"description":{"en":"Hi"}}</templatedata>').description).toBe(
      "Hi",
    );
  });
});

describe("parseTemplateCall", () => {
  it("reads a multi-line infobox call", () => {
    const call = parseTemplateCall("{{Infobox_moon\n| name = 68-Artifice\n| cost = 1500\n}}");
    expect(call?.name).toBe("Infobox_moon");
    expect(call?.multiline).toBe(true);
    expect(call?.args).toEqual([
      { name: "name", positionalIndex: 0, value: "68-Artifice" },
      { name: "cost", positionalIndex: 0, value: "1500" },
    ]);
  });

  it("numbers positional arguments", () => {
    const call = parseTemplateCall("{{Verify|scrap count range}}");
    expect(call?.args).toEqual([{ name: null, positionalIndex: 1, value: "scrap count range" }]);
    expect(call?.multiline).toBe(false);
  });

  it("does not split on pipes inside a nested template or link", () => {
    const call = parseTemplateCall("{{Box|a={{#if:x|y}}|b=[[Titan|the moon]]}}");
    expect(call?.args.map((arg) => arg.value)).toEqual(["{{#if:x|y}}", "[[Titan|the moon]]"]);
  });

  it("does not split on an equals sign inside a nested construct", () => {
    const call = parseTemplateCall("{{Box|{{X|a=b}}}}");
    expect(call?.args).toEqual([{ name: null, positionalIndex: 1, value: "{{X|a=b}}" }]);
  });

  it("keeps a namespaced template name", () => {
    expect(parseTemplateCall("{{Map:Artifice}}")?.name).toBe("Map:Artifice");
  });

  it("rejects what is not an editable template call", () => {
    expect(parseTemplateCall("{{#if:a|b}}")).toBeNull();
    expect(parseTemplateCall("{{ns:0}}")).toBeNull();
    expect(parseTemplateCall("{{DEFAULTSORT:Titan}}")).toBeNull();
    expect(parseTemplateCall("{{PAGENAME}}")).toBeNull();
    expect(parseTemplateCall("{{{param|}}}")).toBeNull();
    expect(parseTemplateCall("{{A}} {{B}}")).toBeNull();
    expect(parseTemplateCall("not a call")).toBeNull();
  });

  it("still accepts a no-argument template whose name is not a magic word", () => {
    expect(parseTemplateCall("{{Reflist}}")?.name).toBe("Reflist");
    expect(parseTemplateCall("{{Stub}}")?.args).toEqual([]);
  });
});

describe("buildTemplateCall", () => {
  it("round-trips a multi-line call in the shape the seed content uses", () => {
    const source = "{{Infobox_moon\n| name = 68-Artifice\n| cost = 1500\n}}";
    const call = parseTemplateCall(source);
    expect(call).not.toBeNull();
    if (call) expect(buildTemplateCall(call)).toBe(source);
  });

  it("round-trips a single-line call tightly", () => {
    const source = "{{Verify|scrap count range}}";
    const call = parseTemplateCall(source);
    expect(call).not.toBeNull();
    if (call) expect(buildTemplateCall(call)).toBe(source);
  });

  it("writes an argument-less call without a pipe", () => {
    expect(buildTemplateCall({ name: "Reflist", args: [], multiline: false })).toBe("{{Reflist}}");
  });
});

describe("newTemplateCall / unusedParams", () => {
  const spec = templateSpec("{{{a}}}{{{b|}}}{{{c|}}}");

  it("seeds a new call with the required parameters only", () => {
    const call = newTemplateCall("Box", spec);
    expect(call.args).toEqual([{ name: "a", positionalIndex: 0, value: "" }]);
    expect(call.multiline).toBe(false);
  });

  it("offers everything the call does not already pass", () => {
    const call = newTemplateCall("Box", spec);
    expect(unusedParams(call, spec).map((param) => param.name)).toEqual(["b", "c"]);
  });

  it("goes multi-line once a call carries more than two rows", () => {
    const wide = templateSpec("{{{a}}}{{{b}}}{{{c}}}");
    expect(newTemplateCall("Box", wide).multiline).toBe(true);
  });
});

describe("humanizeParamName", () => {
  it("reads underscored names as prose and leaves numbers alone", () => {
    expect(humanizeParamName("map_multiplier")).toBe("Map multiplier");
    expect(humanizeParamName("indoor-power")).toBe("Indoor power");
    expect(humanizeParamName("1")).toBe("1");
  });
});

describe("NON_TEMPLATE_HEADS", () => {
  it("covers every colon-form parser function the engine knows", () => {
    // The list is copied rather than imported (see the module comment); this is
    // the guard that keeps the copy honest.
    const colonForms = [...PARSER_FUNCTIONS].filter((name) => !name.startsWith("#"));
    expect(colonForms.filter((name) => !NON_TEMPLATE_HEADS.has(name))).toEqual([]);
  });

  it("rejects every magic word through the all-caps rule", () => {
    for (const word of MAGIC_WORDS) {
      expect(parseTemplateCall(`{{${word}}}`)).toBeNull();
    }
  });
});
