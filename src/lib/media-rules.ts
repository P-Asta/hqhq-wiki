/**
 * The two upload rules a browser can apply *before* spending a round-trip on a
 * file the server is going to reject: the size cap and the type allowlist
 * (decisions.md O6).
 *
 * They sit apart from `src/lib/media.ts` for exactly the reason `wiki/config.ts`
 * sits apart from `wiki/context.ts`: media.ts carries `import "server-only"`
 * (it hashes with node:crypto and resolves upload paths with node:path), and
 * the editor's media dialog is a client component. Restating "10 MB" and
 * "png, jpg, …" in the dialog is how a client-side guard silently drifts from
 * the server that actually enforces it — the drift class decisions-v2 O14.6
 * already cost this repo once. Defined once here, re-exported by media.ts, so
 * both sides read the same numbers.
 *
 * Universal module: no node builtins, no `server-only`.
 */

/** Upload size cap (bytes). */
export const MEDIA_MAX_BYTES = 10 * 1024 * 1024;

/** Extension → served MIME. The ONLY storable types (SVG is rejected). */
export const MEDIA_MIME_BY_EXTENSION = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
} as const;

export type MediaExtension = keyof typeof MEDIA_MIME_BY_EXTENSION;

export const MEDIA_ALLOWED_EXTENSIONS = Object.keys(
  MEDIA_MIME_BY_EXTENSION,
) as readonly MediaExtension[];

export function isAllowedMediaExtension(ext: string): ext is MediaExtension {
  return Object.prototype.hasOwnProperty.call(MEDIA_MIME_BY_EXTENSION, ext);
}

/**
 * Characters a stored filename may not carry, because no `[[File:…]]` could
 * ever name it: `#` opens a fragment (parseTitle drops the name after it), `|`
 * opens another file parameter, `[`/`]` move the depth counter that finds the
 * closing brackets, `{`/`}` would open a template call, and `<`/`>` an HTML
 * tag. Such a file uploads, stores and serves perfectly — and is unreferenceable
 * from any page, which is worse than a refusal at the door (decisions O6).
 */
export const MEDIA_FORBIDDEN_NAME_CHARS = "#|[]{}<>";

const FORBIDDEN_NAME_CHAR = /[#|[\]{}<>]/;

export function hasForbiddenMediaNameChar(name: string): boolean {
  return FORBIDDEN_NAME_CHAR.test(name);
}
