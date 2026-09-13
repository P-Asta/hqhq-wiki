/**
 * GET /api/auth/me — resolve the caller's principal (routes.md).
 *
 * Token optional: anonymous requests get { authenticated: false }; a valid
 * Bearer token gets { authenticated: true, principal }. Auth failures use the
 * unified error body (mapError), including the 403 "profile-not-found"
 * registration-race code the auth provider retries on.
 */

import { jsonOk, mapError } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth/server";
import type { MeResponse } from "@/lib/auth/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESPONSE_HEADERS: Record<string, string> = {
  "Cache-Control": "private, no-store",
  Vary: "Authorization",
};

function withResponseHeaders(res: Response): Response {
  for (const [key, value] of Object.entries(RESPONSE_HEADERS)) {
    res.headers.set(key, value);
  }
  return res;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const principal = await authenticateRequest(request);
    const body: MeResponse = principal
      ? { authenticated: true, principal }
      : { authenticated: false };
    return withResponseHeaders(jsonOk(body));
  } catch (err) {
    return withResponseHeaders(mapError(err));
  }
}
