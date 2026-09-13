/**
 * Derives the wiki page context to hand the Q&A agent from the browser's
 * current pathname — "the page the reader is looking at". Only the article
 * read view counts (`/wiki/...`, in any locale); edit/history/diff and every
 * non-article route carry no page context. Universal (no React/Next import),
 * so it is a plain function to unit test.
 */

import { parseLocalePath } from "@/lib/locale-path";
import { pathToTitle } from "@/lib/title";

import type { PageContext } from "./protocol";

const ARTICLE_PREFIX = "/wiki/";

export function currentPageFromPathname(pathname: string): PageContext | null {
  const { path } = parseLocalePath(pathname);
  if (!path.startsWith(ARTICLE_PREFIX)) return null;
  const parsed = pathToTitle(path.slice(ARTICLE_PREFIX.length));
  if (!parsed) return null;
  return { namespace: parsed.nsName, slug: parsed.slug };
}
