/**
 * Client-side helper for GET /api/auth/me. Isomorphic (plain fetch, no
 * Firebase imports) so the auth provider and tests can both use it.
 */

import type { MeResponse } from "./types";

/** The /api/auth/me error code for the registration race (retry once). */
export const PROFILE_NOT_FOUND_CODE = "profile-not-found";

export type MeFetchResult =
  | { ok: true; me: MeResponse }
  | { ok: false; status: number; code: string; message: string };

export interface FetchAuthMeOptions {
  signal?: AbortSignal;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Fetch the current principal. Pass null for an anonymous probe (the server
 * answers { authenticated: false }). Network failures and aborts reject; HTTP
 * error responses resolve to the discriminated failure shape.
 */
export async function fetchAuthMe(
  idToken: string | null,
  options: FetchAuthMeOptions = {},
): Promise<MeFetchResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const res = await doFetch("/api/auth/me", {
    method: "GET",
    headers: idToken ? { Authorization: `Bearer ${idToken}` } : undefined,
    cache: "no-store",
    signal: options.signal,
  });

  if (res.ok) {
    return { ok: true, me: (await res.json()) as MeResponse };
  }

  let code = "unknown";
  let message = `Request failed with status ${res.status}.`;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.code) code = body.error.code;
    if (body.error?.message) message = body.error.message;
  } catch {
    // Non-JSON error body; keep the generic message.
  }
  return { ok: false, status: res.status, code, message };
}
