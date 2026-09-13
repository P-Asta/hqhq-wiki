/**
 * Server-side zod validation for the agent wire protocol. Split from
 * ./protocol.ts so the AskView client island (which imports the protocol
 * types and constants) never pulls zod into the browser bundle — the schemas
 * are only ever evaluated by scripts/agent-server.ts and tests.
 */

import { z } from "zod";

import {
  MAX_HISTORY_CHARS,
  MAX_HISTORY_TOTAL_CHARS,
  MAX_HISTORY_TURNS,
  MAX_QUESTION_CHARS,
  WIRE_NAMESPACES,
} from "./protocol";

export const historyTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(MAX_HISTORY_CHARS),
});

/** Mirrors PageContext (protocol.ts) — the slug cap matches tools.ts's read_page. */
export const pageContextSchema = z.object({
  namespace: z.enum(WIRE_NAMESPACES),
  slug: z.string().trim().min(1).max(300),
});

export const askMessageSchema = z.object({
  type: z.literal("ask"),
  question: z.string().trim().min(1).max(MAX_QUESTION_CHARS),
  /** UI locale of the asker; drives search locale and EN fallback. */
  locale: z.string().trim().min(2).max(16),
  history: z
    .array(historyTurnSchema)
    .max(MAX_HISTORY_TURNS)
    .default([])
    .refine(
      (turns) => turns.reduce((sum, t) => sum + t.content.length, 0) <= MAX_HISTORY_TOTAL_CHARS,
      { message: `History exceeds ${MAX_HISTORY_TOTAL_CHARS} total characters.` },
    ),
  /** The page open in the asker's browser, if any — required key, nullable value. */
  page: pageContextSchema.nullable(),
});

export const clientMessageSchema = z.discriminatedUnion("type", [askMessageSchema]);
