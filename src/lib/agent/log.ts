/**
 * Persists wiki Q&A agent questions — content only. Deliberately takes no
 * asker identity (no uid, no IP, no session, no user agent): the agent
 * answers signed-in and signed-out visitors alike, and this log exists to
 * see what people ask, never who asked it.
 */

import type { WikiDb } from "@/lib/db/client";
import { agentQuestions } from "@/lib/db/schema";

import type { PageContext } from "./protocol";

export interface LogQuestionInput {
  question: string;
  locale: string;
  /** The page open in the asker's browser when they asked, if any. */
  page: PageContext | null;
}

/** Insert one row. Synchronous (better-sqlite3); callers should not await it. */
export function logQuestion(db: WikiDb, input: LogQuestionInput): void {
  db.insert(agentQuestions)
    .values({
      locale: input.locale,
      question: input.question,
      pageNamespace: input.page?.namespace,
      pageSlug: input.page?.slug,
    })
    .run();
}
