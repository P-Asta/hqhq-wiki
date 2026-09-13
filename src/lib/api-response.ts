/**
 * Unified JSON API response helpers (routes.md: one error body shape
 * everywhere).
 *
 * Success: any JSON body via jsonOk.
 * Error:   { error: { code, message, ...extra } } via jsonError/mapError.
 *
 * mapError translates the two typed error hierarchies — WikiStoreError
 * (src/lib/db/store.ts) and AuthApiError (src/lib/auth/server.ts), both of
 * which carry `status` + `code` — plus zod validation errors and this
 * module's own RequestBodyError. Extra own-enumerable fields on typed errors
 * (e.g. EditConflictError.currentRevId) are spread into the error body, which
 * is how PUT /api/pages returns `{ code: "edit-conflict", currentRevId }`.
 */

import { z } from "zod";

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    [key: string]: unknown;
  };
}

/** Default JSON body cap for readJsonBody (wikitext pages are text; 1 MiB is generous). */
export const MAX_JSON_BODY_BYTES = 1024 * 1024;

/** Thrown by readJsonBody; mapError turns it into the unified error body. */
export class RequestBodyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RequestBodyError";
  }
}

/** 200 (or init.status) JSON response. */
export function jsonOk<T>(data: T, init: ResponseInit = {}): Response {
  return Response.json(data, init);
}

/** Unified error response: { error: { code, message, ...extra } }. */
export function jsonError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  const body: ApiErrorBody = { error: { code, message, ...extra } };
  return Response.json(body, { status });
}

function isStatusCoded(err: unknown): err is Error & { status: number; code: string } {
  return (
    err instanceof Error &&
    typeof (err as { status?: unknown }).status === "number" &&
    typeof (err as { code?: unknown }).code === "string"
  );
}

const RESERVED_ERROR_KEYS = new Set(["status", "code", "name", "message", "stack"]);

/** Map any thrown value onto the unified error response. */
export function mapError(err: unknown): Response {
  if (isStatusCoded(err)) {
    const extra = Object.fromEntries(
      Object.entries(err).filter(([key]) => !RESERVED_ERROR_KEYS.has(key)),
    );
    return jsonError(err.status, err.code, err.message, extra);
  }
  if (err instanceof z.ZodError) {
    return jsonError(400, "validation-error", "The request body failed validation.", {
      issues: err.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  console.error("Unhandled API error:", err);
  return jsonError(500, "internal", "Internal server error.");
}

/**
 * Read, size-guard, parse and validate a JSON request body.
 *
 * Throws RequestBodyError (413 payload-too-large / 400 invalid-json) or
 * z.ZodError — hand either to mapError.
 */
export async function readJsonBody<S extends z.ZodType>(
  req: Request,
  schema: S,
  opts: { maxBytes?: number } = {},
): Promise<z.infer<S>> {
  const maxBytes = opts.maxBytes ?? MAX_JSON_BODY_BYTES;

  const contentLength = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RequestBodyError(413, "payload-too-large", `Request body exceeds ${maxBytes} bytes.`);
  }

  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new RequestBodyError(413, "payload-too-large", `Request body exceeds ${maxBytes} bytes.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RequestBodyError(400, "invalid-json", "The request body is not valid JSON.");
  }

  return schema.parse(parsed);
}
