/**
 * Wiki Q&A agent — standalone WebSocket server.
 *
 *   node ./node_modules/tsx/dist/cli.mjs scripts/agent-server.ts   (yarn agent)
 *
 * Next.js 16 route handlers cannot upgrade to WebSocket (backend-for-frontend
 * guide), so the agent runs as its own process beside `next dev`: it loads
 * the same .env* files via @next/env, opens its own read-only-in-practice
 * connection to wiki-data/wiki.db (WAL — cross-process readers never block
 * the `next dev` writer), and serves the protocol in src/lib/agent/protocol.ts
 * to the AskView island inside the AskDock side panel (site header).
 * Answers come from GLM (Z.ai / Zhipu) over streaming
 * HTTP with function calling; GLM has no text-chat WebSocket API, so the WS
 * leg is ours and the GLM leg is SSE.
 *
 * Every accepted question is logged to the agent_questions table — content
 * only, no asker identity (src/lib/agent/log.ts) — and, when the asker's
 * browser was on an article, the wiki page they were viewing (protocol.ts
 * PageContext) rides along and nudges the model to read that page first.
 *
 * Env (see .env.example): GLM_API_KEY (required), GLM_BASE_URL, GLM_MODEL,
 * WIKI_AGENT_PORT (default 8788), WIKI_AGENT_HOST (default 127.0.0.1),
 * WIKI_AGENT_ALLOWED_ORIGINS (browser origins allowed to connect).
 */

import { loadEnvConfig } from "@next/env";

// Same .env* resolution as `next dev` (dev mode loads .env.development*).
// Imports are hoisted above this call, which is safe because every imported
// module reads env lazily (getGlmConfig / getDb are called inside main).
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

import { WebSocketServer, type WebSocket, type RawData } from "ws";

import { createChatFn, getGlmConfig, GlmApiError, GlmConfigError } from "@/lib/agent/glm";
import { logQuestion } from "@/lib/agent/log";
import { runAgent } from "@/lib/agent/loop";
import { clientMessageSchema } from "@/lib/agent/protocol-schema";
import type { ServerEvent } from "@/lib/agent/protocol";
import { createWikiToolset } from "@/lib/agent/tools";
import { getDb } from "@/lib/db/client";
import { getDictionary } from "@/lib/i18n";

const HEARTBEAT_MS = 30_000;
/**
 * Above the worst-case protocol frame: MAX_QUESTION_CHARS +
 * MAX_HISTORY_TOTAL_CHARS ≈ 28K chars ≈ 84KB in 3-byte UTF-8 plus JSON
 * overhead. ws kills the socket (1009) for larger frames BELOW the JSON
 * layer, so this must never undercut what the zod schema calls legal.
 */
const MAX_PAYLOAD_BYTES = 256 * 1024;

/**
 * Browser origins allowed to open the socket. Without this check any website
 * the user visits could drive the agent and spend the GLM key (CSWSH) — the
 * Origin header is the one thing a browser page cannot forge. Non-browser
 * clients send no Origin and are allowed (they are not confused deputies).
 */
function allowedOrigins(): Set<string> {
  const raw = process.env.WIKI_AGENT_ALLOWED_ORIGINS?.trim();
  const defaults = ["http://localhost:3000", "http://127.0.0.1:3000"];
  const list = raw ? raw.split(",").map((o) => o.trim().replace(/\/+$/, "")) : defaults;
  return new Set(list.filter(Boolean));
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** ws hands text frames over as Buffer | ArrayBuffer | Buffer[]. */
function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function main(): void {
  const port = Number(process.env.WIKI_AGENT_PORT) || 8788;
  const host = process.env.WIKI_AGENT_HOST?.trim() || "127.0.0.1";

  // Fail fast: a missing key or unreadable db should stop the boot, not the
  // first question.
  let glmConfig;
  try {
    glmConfig = getGlmConfig();
  } catch (err) {
    if (err instanceof GlmConfigError) {
      console.error(`[agent] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const db = getDb();
  const chat = createChatFn(glmConfig);
  const siteName = getDictionary("en").common.siteName;
  const origins = allowedOrigins();

  if (!isLoopback(host)) {
    console.warn(
      `[agent] WARNING: listening on ${host} — this endpoint has no auth and spends the ` +
        `GLM API key. Expose it beyond localhost only behind your own access control.`,
    );
  }

  const wss = new WebSocketServer({
    port,
    host,
    maxPayload: MAX_PAYLOAD_BYTES,
    verifyClient: ({ origin }: { origin?: string }) => {
      // No Origin header = not a browser; the CSWSH risk is browser-only.
      if (!origin) return true;
      const ok = origins.has(origin.replace(/\/+$/, ""));
      if (!ok) console.warn(`[agent] rejected connection from origin ${origin}`);
      return ok;
    },
  });
  const alive = new WeakMap<WebSocket, boolean>();
  const running = new WeakMap<WebSocket, AbortController>();

  const send = (socket: WebSocket, event: ServerEvent): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
  };

  wss.on("connection", (socket) => {
    alive.set(socket, true);
    socket.on("pong", () => alive.set(socket, true));

    socket.on("message", (data) => {
      let frame: unknown;
      try {
        frame = JSON.parse(rawDataToText(data));
      } catch {
        send(socket, { type: "error", code: "invalid-json", message: "Frames must be JSON." });
        return;
      }
      const parsed = clientMessageSchema.safeParse(frame);
      if (!parsed.success) {
        send(socket, {
          type: "error",
          code: "invalid-message",
          message: parsed.error.issues[0]?.message ?? "Malformed message.",
        });
        return;
      }
      if (running.has(socket)) {
        send(socket, {
          type: "error",
          code: "busy",
          message: "A question is already being answered on this connection.",
        });
        return;
      }

      const { question, locale, history, page } = parsed.data;
      const controller = new AbortController();
      running.set(socket, controller);

      // Logging must never block answering: a DB hiccup here is swallowed.
      try {
        logQuestion(db, { question, locale, page });
      } catch (err) {
        console.error("[agent] failed to log question:", err);
      }

      send(socket, { type: "ack" });

      void runAgent({
        question,
        history,
        locale,
        siteName,
        page,
        chat,
        tools: createWikiToolset(db, locale),
        emit: (event) => send(socket, event),
        signal: controller.signal,
      })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return; // socket closed mid-run
          if (err instanceof GlmApiError) {
            console.error(`[agent] GLM error ${err.status} ${err.code}: ${err.message}`);
            send(socket, { type: "error", code: "glm-error", message: err.message });
            return;
          }
          console.error("[agent] run failed:", err);
          send(socket, {
            type: "error",
            code: "internal",
            message: "The agent hit an unexpected error. Please try again.",
          });
        })
        .finally(() => {
          running.delete(socket);
        });
    });

    socket.on("close", () => {
      running.get(socket)?.abort();
      running.delete(socket);
    });
    socket.on("error", (err) => {
      console.error("[agent] socket error:", err.message);
    });
  });

  // Reap dead connections (browser gone without a close frame).
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (alive.get(socket) === false) {
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      socket.ping();
    }
  }, HEARTBEAT_MS);

  wss.on("close", () => clearInterval(heartbeat));
  wss.on("listening", () => {
    console.log(
      `[agent] wiki Q&A agent listening on ws://${host}:${port} ` +
        `(model ${glmConfig.model} @ ${glmConfig.baseUrl})`,
    );
  });
  wss.on("error", (err) => {
    console.error(`[agent] server error: ${err.message}`);
    process.exit(1);
  });

  const shutdown = (): void => {
    console.log("[agent] shutting down");
    for (const socket of wss.clients) socket.terminate();
    wss.close(() => process.exit(0));
    // Fallback if close callbacks hang.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
