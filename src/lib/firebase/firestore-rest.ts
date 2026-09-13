import "server-only";

/**
 * Firestore over its REST API, authenticated with the CALLER'S OWN ID token.
 *
 * The credential-free counterpart to the Admin SDK: same documents, but every
 * request is authorized by Firestore Security Rules instead of bypassing them,
 * exactly as the browser SDK is. That difference is the whole point — without
 * a service account there is nothing to bypass rules with — and it is also the
 * limitation to keep in mind: a call here can be refused (403) where the same
 * call through the Admin SDK would have succeeded.
 *
 * Three encoding details cause most REST bugs, so they live in one place here:
 *   - values are type-tagged (`{stringValue}`, and `integerValue` is a STRING);
 *   - an empty `runQuery` result is `[{readTime}]`, NOT `[]` — every query
 *     therefore filters on the presence of `document`;
 *   - a PATCH without `updateMask.fieldPaths` REPLACES the whole document.
 */

const FIRESTORE_ROOT = "https://firestore.googleapis.com/v1";

/** Failure from the REST API, carrying Google's own status string. */
export class FirestoreRestError extends Error {
  constructor(
    readonly status: number,
    /** Google's `error.status`, e.g. "PERMISSION_DENIED" / "UNAUTHENTICATED". */
    readonly googleStatus: string,
    message: string,
  ) {
    super(message);
    this.name = "FirestoreRestError";
  }
}

/* ------------------------------------------------------------------ */
/* Typed values                                                        */
/* ------------------------------------------------------------------ */

type FirestoreValue = Record<string, unknown>;

interface FirestoreDocument {
  name: string;
  fields?: Record<string, FirestoreValue>;
}

/** One Firestore value → the plain JS one. */
function decodeValue(value: FirestoreValue): unknown {
  // `nullValue` is detected by key presence: its value is literally null.
  if ("nullValue" in value) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  // int64 arrives as a STRING — the classic decode bug.
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("timestampValue" in value) return new Date(String(value.timestampValue));
  if ("arrayValue" in value) {
    const inner = value.arrayValue as { values?: FirestoreValue[] } | undefined;
    // `values` is ABSENT for an empty array, not [].
    return (inner?.values ?? []).map(decodeValue);
  }
  if ("mapValue" in value) {
    const inner = value.mapValue as { fields?: Record<string, FirestoreValue> } | undefined;
    return decodeFields(inner?.fields);
  }
  return undefined;
}

/** A document's `fields` → a plain object. Absent `fields` is an empty doc. */
export function decodeFields(
  fields?: Record<string, FirestoreValue>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields ?? {})) out[key] = decodeValue(value);
  return out;
}

/** `projects/…/documents/users/abc` → `abc`. Ids can never contain a slash. */
export function documentId(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

function documentsRoot(projectId: string): string {
  return `${FIRESTORE_ROOT}/projects/${projectId}/databases/(default)/documents`;
}

async function firestoreFetch(
  url: string,
  idToken: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });
}

async function failureOf(res: Response): Promise<FirestoreRestError> {
  let googleStatus = "UNKNOWN";
  let message = `Firestore request failed (${res.status}).`;
  try {
    const body: unknown = await res.json();
    const error = (body as { error?: { status?: unknown; message?: unknown } }).error;
    if (typeof error?.status === "string") googleStatus = error.status;
    if (typeof error?.message === "string") message = error.message;
  } catch {
    // Non-JSON body; the defaults above already say enough.
  }
  return new FirestoreRestError(res.status, googleStatus, message);
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

/** One document's fields, or null when it does not exist. */
export async function restGetDocument(
  projectId: string,
  path: string,
  idToken: string,
): Promise<Record<string, unknown> | null> {
  const res = await firestoreFetch(`${documentsRoot(projectId)}/${path}`, idToken);
  if (res.status === 404) return null;
  if (!res.ok) throw await failureOf(res);
  const doc = (await res.json()) as FirestoreDocument;
  return decodeFields(doc.fields);
}

/** One row of a query result: the document id plus its decoded fields. */
export interface RestQueryRow {
  id: string;
  fields: Record<string, unknown>;
}

/**
 * Run a structured query against a top-level collection.
 *
 * `structuredQuery` is passed through as given (minus `from`, which is set
 * here) so callers express filters in Firestore's own vocabulary.
 */
export async function restRunQuery(
  projectId: string,
  collectionId: string,
  structuredQuery: Record<string, unknown>,
  idToken: string,
): Promise<RestQueryRow[]> {
  const res = await firestoreFetch(`${documentsRoot(projectId)}:runQuery`, idToken, {
    method: "POST",
    body: JSON.stringify({
      structuredQuery: { from: [{ collectionId }], ...structuredQuery },
    }),
  });
  if (!res.ok) throw await failureOf(res);

  const envelopes = (await res.json()) as Array<{ document?: FirestoreDocument }>;
  // An empty result is `[{readTime}]` — one envelope carrying no document —
  // so emptiness is "no envelope has a document", never `length === 0`.
  return envelopes
    .filter((envelope): envelope is { document: FirestoreDocument } => !!envelope.document)
    .map((envelope) => ({
      id: documentId(envelope.document.name),
      fields: decodeFields(envelope.document.fields),
    }));
}

/**
 * Merge `fields` into a document, leaving everything else alone.
 *
 * `updateMask.fieldPaths` is repeated once per path and is NOT optional:
 * without it Firestore replaces the entire document.
 */
export async function restPatchDocument(
  projectId: string,
  path: string,
  fields: Record<string, FirestoreValue>,
  idToken: string,
): Promise<void> {
  const paths = Object.keys(fields);
  if (paths.length === 0) {
    throw new Error("restPatchDocument requires at least one field to update.");
  }
  const params = new URLSearchParams();
  for (const field of paths) params.append("updateMask.fieldPaths", field);

  const res = await firestoreFetch(
    `${documentsRoot(projectId)}/${path}?${params.toString()}`,
    idToken,
    { method: "PATCH", body: JSON.stringify({ fields }) },
  );
  if (!res.ok) throw await failureOf(res);
}

/** `{booleanValue}` — the only value shape this app currently writes. */
export function booleanValue(value: boolean): FirestoreValue {
  return { booleanValue: value };
}

/** `{stringValue}` — for query filters and cursors. */
export function stringValue(value: string): FirestoreValue {
  return { stringValue: value };
}
