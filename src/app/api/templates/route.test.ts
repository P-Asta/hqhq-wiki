/**
 * The template picker's two reads (docs/engine/visual-editor.md §5.1).
 *
 * Both are anonymous, like the rest of the read side (decisions-v2 O15.1), and
 * both are addressed the way an author types a template name — "Infobox moon"
 * and "Infobox_moon" have to reach the same page (decisions O1).
 */

import { describe, expect, it, vi } from "vitest";

import type { WikiDb } from "@/lib/db/client";
import type { TemplateParamSpec } from "@/lib/visual-editor/template-params";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  const db = actual.createDb(":memory:");
  return { ...actual, getDb: () => db, __testDb: db };
});

const { GET: listTemplatesRoute } = await import("./route");
const { GET: templateSpecRoute } = await import("./[slug]/route");
const { createPageWithParse } = await import("@/lib/wiki/service");
const { seedLanguages, seedVersions } = await import("@/lib/db/store");
const db = ((await import("@/lib/db/client")) as unknown as { __testDb: WikiDb }).__testDb;

seedLanguages(db);
seedVersions(db);

const AUTHOR = { uid: "tester", displayName: "Tester" };

const INFOBOX = `<table class="infobox">
<tr><th>{{{name|Unnamed moon}}}</th></tr>
{{#if:{{{cost|}}}|<tr><td>{{{cost}}}</td></tr>}}
<tr><td>{{{risk}}}</td></tr>
</table>`;

createPageWithParse({
  db,
  namespace: "template",
  locale: "en",
  title: "Infobox moon",
  content: INFOBOX,
  author: AUTHOR,
});
createPageWithParse({
  db,
  namespace: "template",
  locale: "en",
  title: "Stub",
  content: "This article is a stub.",
  author: AUTHOR,
});
createPageWithParse({
  db,
  namespace: "main",
  locale: "en",
  title: "Artifice",
  content: "A moon.",
  author: AUTHOR,
});

interface ListBody {
  templates: { slug: string; title: string }[];
}
interface SpecBody {
  slug: string;
  title: string;
  description: string | null;
  documented: boolean;
  params: TemplateParamSpec[];
}

function listRequest(query: string): Request {
  return new Request(`http://localhost/api/templates?${query}`);
}

function specRequest(slug: string, query = ""): Promise<Response> {
  return templateSpecRoute(new Request(`http://localhost/api/templates/${slug}?${query}`), {
    params: Promise.resolve({ slug }),
  });
}

describe("GET /api/templates", () => {
  it("lists the Template namespace and nothing else", async () => {
    const res = listTemplatesRoute(listRequest("locale=en"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.templates.map((template) => template.title)).toEqual(["Infobox moon", "Stub"]);
  });

  it("matches a title substring, case-insensitively", async () => {
    const body = (await listTemplatesRoute(listRequest("q=MOON&locale=en")).json()) as ListBody;
    expect(body.templates).toEqual([{ slug: "infobox-moon", title: "Infobox moon" }]);
  });

  it("returns an empty list rather than an error when nothing matches", async () => {
    const body = (await listTemplatesRoute(listRequest("q=zzz&locale=en")).json()) as ListBody;
    expect(body.templates).toEqual([]);
  });

  it("caps the result count a caller can ask for", async () => {
    const res = listTemplatesRoute(listRequest("limit=9999&locale=en"));
    expect(res.status).toBe(200);
  });
});

describe("GET /api/templates/{slug}", () => {
  it("derives the parameter form from the template body, in body order", async () => {
    const res = await specRequest("infobox-moon", "locale=en");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SpecBody;
    expect(body.title).toBe("Infobox moon");
    expect(body.documented).toBe(false);
    expect(body.params.map((param) => param.name)).toEqual(["name", "cost", "risk"]);
  });

  it("marks a parameter with no default as required (spec §8.4)", async () => {
    const body = (await (await specRequest("infobox-moon", "locale=en")).json()) as SpecBody;
    expect(body.params.map((param) => [param.name, param.required])).toEqual([
      ["name", false],
      ["cost", false],
      ["risk", true],
    ]);
  });

  it("accepts the name as an author writes it", async () => {
    const spaced = (await (await specRequest("Infobox moon")).json()) as SpecBody;
    const underscored = (await (await specRequest("Infobox_moon")).json()) as SpecBody;
    expect(spaced.slug).toBe("infobox-moon");
    expect(underscored.slug).toBe("infobox-moon");
  });

  it("falls back to the EN body for a locale with no translation (O4)", async () => {
    const body = (await (await specRequest("infobox-moon", "locale=ko")).json()) as SpecBody;
    expect(body.params.map((param) => param.name)).toEqual(["name", "cost", "risk"]);
  });

  it("404s for a template that does not exist", async () => {
    const res = await specRequest("no-such-template");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not-found");
  });

  it("does not answer for a page outside the Template namespace", async () => {
    expect((await specRequest("artifice")).status).toBe(404);
  });

  it("reports an oversized body as undocumented instead of reading it", async () => {
    // Created here rather than with the other fixtures because the listing
    // tests above assert the whole Template namespace.
    createPageWithParse({
      db,
      namespace: "template",
      locale: "en",
      title: "Huge",
      content: `{{{name|x}}}\n${"Filler prose.\n".repeat(6000)}`,
      author: AUTHOR,
    });
    const res = await specRequest("huge", "locale=en");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SpecBody;
    // The form is empty rather than derived: reading a body this size is work
    // any anonymous caller could ask for, over and over (decisions-v2 O15.1).
    expect(body.documented).toBe(false);
    expect(body.params).toEqual([]);
  });
});
