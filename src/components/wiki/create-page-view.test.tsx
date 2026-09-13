/**
 * decisions-v2 O14.1/O14.2 — the missing-page create view.
 *
 * Renders the real thing: an in-memory database, the shared `loadEditorView`
 * seed the /edit route uses, and the same <Editor> island, gated by
 * <CreatePageView>. The assertions are the two branches of O14 — the editor
 * for a visitor who may edit (titled from the URL), and the classic notice
 * with its sign-in CTA and edit link for one who may not.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const auth = vi.hoisted(() => ({
  loading: false,
  user: null as { uid: string } | null,
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    loading: auth.loading,
    user: auth.user,
    profile: null,
    roles: [],
    isAdmin: false,
    canAccessAdminPanel: false,
    error: null,
    getIdToken: async () => null,
    signOut: async () => {},
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { createDb } from "@/lib/db/client";
import { seedLanguages, seedVersions } from "@/lib/db/store";
import { getDictionary } from "@/lib/i18n";
import { editorLabels, loadEditorView } from "@/lib/wiki/edit-view";

import { CreatePageView, mayEditInline } from "./create-page-view";
import { Editor } from "./editor";

function db() {
  const database = createDb(":memory:");
  seedLanguages(database);
  seedVersions(database);
  return database;
}

/** Exactly what the article route renders for a title nobody has written. */
function renderCreateView(
  segments: string,
  options: { locale?: string; version?: string | null } = {},
) {
  const locale = options.locale ?? "en";
  const dict = getDictionary(locale);
  const view = loadEditorView({
    db: db(),
    locale,
    segments,
    version: options.version ?? null,
  });
  if (!view) throw new Error("unresolvable title");
  return renderToStaticMarkup(
    <CreatePageView
      editor={
        <Editor
          locale={locale}
          titlePath={view.title.titlePath}
          displayTitle={view.displayTitle}
          previewTitle={view.previewTitle}
          initialContent={view.initialContent}
          initialParentRevId={view.parentRevId}
          translatedFromRevId={view.translatedFromRevId}
          versions={view.versions}
          defaultVersion={view.defaultVersion}
          selectedVersion={view.selectedVersion}
          labels={editorLabels(dict, view)}
        />
      }
      notice={{
        labels: {
          title: dict.wiki.noTextTitle,
          description: dict.wiki.noTextDescription,
          signIn: dict.common.signIn,
          edit: dict.wiki.createPage,
        },
        signInHref: locale === "en" ? "/login" : `/${locale}/login`,
        editHref: locale === "en" ? `/edit/${segments}` : `/${locale}/edit/${segments}`,
        slug: segments,
      }}
    />,
  );
}

beforeEach(() => {
  auth.loading = false;
  auth.user = null;
});

describe("CreatePageView — visitor may edit (O14.1)", () => {
  it("renders the editor for the URL's title, empty, with a creation heading", () => {
    auth.user = { uid: "u-alice" };
    const html = renderCreateView("gold-bar");
    const dict = getDictionary("en");
    // The Fandom-shaped header reads as creation through its eyebrow
    // (visual-editor.md §1), with the page name as the heading proper.
    expect(html).toContain(dict.editor.eyebrowCreate);
    expect(html).not.toContain(dict.editor.eyebrowEdit);
    expect(html).toContain(">Gold bar</h1>");
    expect(html).toContain(dict.editor.visualLabel);
    // No intermediate CTA: the notice must not be what greets an editor.
    expect(html).not.toContain(getDictionary("en").wiki.noTextTitle);
    // Cancel/Save land on the article this editor was reached from.
    expect(html).toContain('href="/wiki/gold-bar"');
  });

  it("derives the namespace and display title from the catch-all", () => {
    auth.user = { uid: "u-alice" };
    const html = renderCreateView("template:infobox-moon");
    expect(html).toContain(getDictionary("en").editor.eyebrowCreate);
    expect(html).toContain(">Infobox moon</h1>");
    expect(html).toContain('href="/wiki/template:infobox-moon"');
  });

  it("offers categories only through the rail's chip input (O14.4)", () => {
    auth.user = { uid: "u-alice" };
    const html = renderCreateView("gold-bar");
    const dict = getDictionary("en");
    // The rail edits [[Category:…]] in the buffer — that is the whole
    // categorization UI. O16.1 turned its input into a combobox that searches
    // what exists and offers to create what does not, but the wikitext it
    // writes, and the fact that nothing else files a page, are unchanged.
    expect(html).toContain(dict.editor.railCategories);
    expect(html).toContain(dict.editor.tagPickerPlaceholder);
    expect(html).toContain(dict.editor.railCategoryAdd);
    expect(html).not.toContain("<select name=\"category\"");
  });

  it("shows the editor while the principal is still resolving", () => {
    auth.loading = true;
    expect(renderCreateView("gold-bar")).toContain(getDictionary("en").editor.eyebrowCreate);
  });

  it("carries the locale and `?v=` into the create flow (O12 / versioning §6)", () => {
    auth.user = { uid: "u-alice" };
    const html = renderCreateView("gold-bar", { locale: "ko", version: "v50" });
    expect(html).toContain(getDictionary("ko").editor.eyebrowCreate);
    expect(html).toContain(">Gold bar</h1>");
    // The reader's version selection survives the create round trip.
    expect(html).toContain('href="/ko/wiki/gold-bar?v=v50"');
  });
});

describe("CreatePageView — visitor may NOT edit (O14.2)", () => {
  it("shows the classic notice with a sign-in CTA and the edit URL", () => {
    const html = renderCreateView("gold-bar");
    const dict = getDictionary("en");
    expect(html).toContain(dict.wiki.noTextTitle);
    expect(html).toContain(dict.wiki.noTextDescription);
    expect(html).toContain('href="/login"');
    expect(html).toContain('href="/edit/gold-bar"');
    expect(html).toContain(dict.wiki.createPage);
    // Never the editor, and never a dead end.
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain(dict.editor.visualLabel);
    expect(html).not.toContain(dict.editor.eyebrowCreate);
  });

  it("keeps the notice's links locale-prefixed (O12)", () => {
    const html = renderCreateView("gold-bar", { locale: "ko" });
    expect(html).toContain(getDictionary("ko").wiki.noTextTitle);
    expect(html).toContain('href="/ko/login"');
    expect(html).toContain('href="/ko/edit/gold-bar"');
  });
});

describe("mayEditInline", () => {
  it("defaults to the editor unless the visitor is known to be a reader", () => {
    expect(mayEditInline({ user: true, loading: false })).toBe(true);
    expect(mayEditInline({ user: false, loading: true })).toBe(true);
    expect(mayEditInline({ user: false, loading: false })).toBe(false);
  });
});
