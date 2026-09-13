import "server-only";

/**
 * Media upload/serving rules — decisions.md O6.
 *
 * - Canonical filename: NFC, lowercase, whitespace/underscore runs → `-`
 *   (canonicalFilename in src/lib/title.ts), extension included.
 * - Type allowlist: png / jpg / jpeg / webp / gif — verified by magic bytes,
 *   never by the client-declared MIME. SVG (or anything else) is rejected.
 * - Path traversal: names carrying separators, `..` segments, or resolving
 *   outside WIKI_UPLOAD_ROOT are rejected.
 * - ETag = sha1 hex digest; served with an immutable cache header.
 *
 * Errors carry `status` + `code` (the WikiStoreError shape) so
 * src/lib/api-response.ts#mapError translates them directly.
 */

import { createHash } from "node:crypto";
import path from "node:path";

import {
  MEDIA_ALLOWED_EXTENSIONS,
  MEDIA_FORBIDDEN_NAME_CHARS,
  MEDIA_MAX_BYTES,
  MEDIA_MIME_BY_EXTENSION,
  hasForbiddenMediaNameChar,
  isAllowedMediaExtension,
  type MediaExtension,
} from "@/lib/media-rules";
import { canonicalFilename } from "@/lib/title";

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class MediaError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MediaError";
  }
}

/* ------------------------------------------------------------------ */
/* Allowlist                                                           */
/* ------------------------------------------------------------------ */

/**
 * The size cap and the type allowlist are defined in the universal
 * ./media-rules.ts and re-exported here: the editor's media dialog is a client
 * component and cannot import this `server-only` module, but it must reject an
 * oversized or wrong-typed file against the very numbers this gate enforces.
 */
export {
  MEDIA_ALLOWED_EXTENSIONS,
  MEDIA_FORBIDDEN_NAME_CHARS,
  MEDIA_MAX_BYTES,
  MEDIA_MIME_BY_EXTENSION,
  hasForbiddenMediaNameChar,
  isAllowedMediaExtension,
  type MediaExtension,
};

/** O6 cache policy for GET /api/media/[...name]. */
export const MEDIA_CACHE_CONTROL = "public, max-age=31536000, immutable";

/* ------------------------------------------------------------------ */
/* Canonical names                                                     */
/* ------------------------------------------------------------------ */

// Path separators — either direction, so Windows-style names are rejected too.
const SEPARATORS = /[\\/]/;

/** C0 control characters or DEL anywhere in the name. */
function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/**
 * Canonicalize an upload/lookup name (O6) and reject anything unsafe.
 *
 * Throws MediaError:
 * - 400 `invalid-filename` — empty, separators, control chars, dot segments,
 *   or a character `[[File:…]]` cannot name (MEDIA_FORBIDDEN_NAME_CHARS)
 * - 415 `unsupported-media-type` — no extension or one outside the allowlist
 */
export function canonicalMediaName(raw: string): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new MediaError(400, "invalid-filename", "A filename is required.");
  }
  const name = canonicalFilename(raw);
  if (
    !name ||
    SEPARATORS.test(name) ||
    hasControlChars(name) ||
    hasForbiddenMediaNameChar(name) ||
    name.startsWith(".") ||
    name.includes("..")
  ) {
    throw new MediaError(400, "invalid-filename", `Invalid media filename: ${raw}`);
  }
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  if (!isAllowedMediaExtension(ext)) {
    throw new MediaError(
      415,
      "unsupported-media-type",
      `Only ${MEDIA_ALLOWED_EXTENSIONS.join(", ")} uploads are allowed (SVG is rejected).`,
    );
  }
  return name;
}

/**
 * Resolve a stored name inside the upload root, refusing any path that would
 * escape it (O6 traversal rejection). Throws 400 `invalid-path`.
 */
export function resolveMediaPath(uploadRoot: string, storedName: string): string {
  if (!storedName || path.isAbsolute(storedName)) {
    throw new MediaError(400, "invalid-path", "Invalid media path.");
  }
  const root = path.resolve(uploadRoot);
  const target = path.resolve(root, storedName);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new MediaError(400, "invalid-path", "Invalid media path.");
  }
  if (target === root) {
    throw new MediaError(400, "invalid-path", "Invalid media path.");
  }
  return target;
}

/* ------------------------------------------------------------------ */
/* Content sniffing                                                    */
/* ------------------------------------------------------------------ */

function startsWith(bytes: Uint8Array, prefix: number[], offset = 0): boolean {
  if (bytes.byteLength < offset + prefix.length) return false;
  return prefix.every((b, i) => bytes[offset + i] === b);
}

/**
 * Identify the real image type from magic bytes; null when the payload is
 * none of the allowed formats (which is how an SVG renamed to .png dies).
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // JPEG: FF D8 FF
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  // GIF: "GIF87a" | "GIF89a"
  if (
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  // WEBP: "RIFF" .... "WEBP"
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Intrinsic size                                                      */
/* ------------------------------------------------------------------ */

export interface ImageSize {
  width: number;
  height: number;
}

/**
 * Little/big-endian readers that answer null past the end of the buffer, so a
 * truncated header can never be read as a zero dimension.
 */
function u16be(b: Uint8Array, at: number): number | null {
  return b.byteLength < at + 2 ? null : (b[at] << 8) | b[at + 1];
}

function u32be(b: Uint8Array, at: number): number | null {
  if (b.byteLength < at + 4) return null;
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
}

function u16le(b: Uint8Array, at: number): number | null {
  return b.byteLength < at + 2 ? null : b[at] | (b[at + 1] << 8);
}

function u24le(b: Uint8Array, at: number): number | null {
  return b.byteLength < at + 3 ? null : b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
}

function u32le(b: Uint8Array, at: number): number | null {
  if (b.byteLength < at + 4) return null;
  return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
}

/** A dimension pair is only usable when both sides are real pixels. */
function box(width: number, height: number): ImageSize | null {
  return width > 0 && height > 0 ? { width, height } : null;
}

function pngSize(b: Uint8Array): ImageSize | null {
  // IHDR is mandatory and must be the first chunk: 8-byte signature, a 4-byte
  // length, the tag, then width and height as big-endian u32.
  if (!startsWith(b, [0x49, 0x48, 0x44, 0x52], 12)) return null;
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  return width === null || height === null ? null : box(width, height);
}

function gifSize(b: Uint8Array): ImageSize | null {
  // The logical screen descriptor follows the 6-byte signature: two
  // little-endian u16 that are the canvas, which is the image's own size for
  // every GIF a browser will draw whole.
  const width = u16le(b, 6);
  const height = u16le(b, 8);
  return width === null || height === null ? null : box(width, height);
}

// 0xC4/0xC8/0xCC sit inside the SOFn range but are DHT/JPG/DAC, not frames.
const JPEG_NOT_A_FRAME = new Set([0xc4, 0xc8, 0xcc]);

function jpegSize(b: Uint8Array): ImageSize | null {
  // Walk the marker segments to the first SOFn, which is where the size lives
  // in baseline, progressive and every other JPEG flavour alike.
  let at = 2;
  while (at + 1 < b.byteLength) {
    if (b[at] !== 0xff) return null;
    // Any number of 0xFF fill bytes may precede a marker id.
    let marker = b[at + 1];
    while (marker === 0xff && at + 2 < b.byteLength) {
      at += 1;
      marker = b[at + 1];
    }
    // Standalone markers (SOI, TEM, RSTn) carry no length word.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    // SOS starts entropy-coded data and EOI ends the file: no frame header
    // is coming, so give up rather than parse compressed bytes as markers.
    if (marker === 0xda || marker === 0xd9) return null;
    const length = u16be(b, at + 2);
    if (length === null || length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && !JPEG_NOT_A_FRAME.has(marker)) {
      // SOFn payload: precision, height, width — height first.
      const height = u16be(b, at + 5);
      const width = u16be(b, at + 7);
      return width === null || height === null ? null : box(width, height);
    }
    at += 2 + length;
  }
  return null;
}

function webpSize(b: Uint8Array): ImageSize | null {
  // The first chunk after the 12-byte RIFF/WEBP header names the flavour; its
  // payload starts at 20.
  if (startsWith(b, [0x56, 0x50, 0x38, 0x20], 12)) {
    // "VP8 " — a lossy key frame: 3-byte frame tag, the 3-byte sync code, then
    // the two dimensions as 14-bit fields (the top bits are a scaling hint).
    if (!startsWith(b, [0x9d, 0x01, 0x2a], 23)) return null;
    const width = u16le(b, 26);
    const height = u16le(b, 28);
    return width === null || height === null ? null : box(width & 0x3fff, height & 0x3fff);
  }
  if (startsWith(b, [0x56, 0x50, 0x38, 0x4c], 12)) {
    // "VP8L" — lossless: a 0x2F signature byte, then width-1 and height-1 as
    // 14-bit fields of one little-endian u32.
    if (b[20] !== 0x2f) return null;
    const bits = u32le(b, 21);
    if (bits === null) return null;
    return box((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (startsWith(b, [0x56, 0x50, 0x38, 0x58], 12)) {
    // "VP8X" — extended (animation, alpha, ICC): a flags word, then the canvas
    // width-1 and height-1 as 24-bit little-endian.
    const width = u24le(b, 24);
    const height = u24le(b, 27);
    return width === null || height === null ? null : box(width + 1, height + 1);
  }
  return null;
}

/**
 * The intrinsic pixel size, read from the very header bytes `sniffImageMime`
 * has already vouched for — this repo ships no image library and needs none for
 * a field every format states in its first few dozen bytes.
 *
 * Null when the header is truncated or carries a shape this reader does not
 * know. That is not a reason to refuse the upload: the row simply records no
 * dimensions, and `renderImage` omits the attributes rather than inventing a
 * box — a picture at natural size beats a picture at `width="0"`.
 */
export function measureImageSize(bytes: Uint8Array): ImageSize | null {
  switch (sniffImageMime(bytes)) {
    case "image/png":
      return pngSize(bytes);
    case "image/jpeg":
      return jpegSize(bytes);
    case "image/gif":
      return gifSize(bytes);
    case "image/webp":
      return webpSize(bytes);
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Upload validation                                                   */
/* ------------------------------------------------------------------ */

export function sha1Hex(data: Uint8Array): string {
  return createHash("sha1").update(data).digest("hex");
}

export interface ValidatedUpload {
  /** Canonical stored filename (O6). */
  filename: string;
  /** MIME determined from magic bytes. */
  mime: string;
  size: number;
  sha1: string;
  /** Intrinsic pixels, or null when the header does not disclose them. */
  width: number | null;
  height: number | null;
}

/**
 * Full upload gate: canonical name, size cap, magic-byte type check,
 * extension↔content agreement, and the intrinsic size. Returns the row values
 * for `files`.
 *
 * Throws MediaError:
 * - everything canonicalMediaName throws
 * - 400 `empty-file`, 413 `payload-too-large`
 * - 415 `unsupported-media-type` (unknown content, e.g. SVG)
 * - 415 `media-type-mismatch` (e.g. a GIF named .png)
 */
export function validateUpload(input: {
  filename: string;
  bytes: Uint8Array;
  maxBytes?: number;
}): ValidatedUpload {
  const filename = canonicalMediaName(input.filename);
  const size = input.bytes.byteLength;
  if (size === 0) throw new MediaError(400, "empty-file", "The uploaded file is empty.");
  const maxBytes = input.maxBytes ?? MEDIA_MAX_BYTES;
  if (size > maxBytes) {
    throw new MediaError(413, "payload-too-large", `Uploads are limited to ${maxBytes} bytes.`);
  }
  const mime = sniffImageMime(input.bytes);
  if (!mime) {
    throw new MediaError(
      415,
      "unsupported-media-type",
      "The file content is not an allowed image type (png, jpg, webp, gif; SVG is rejected).",
    );
  }
  const ext = filename.slice(filename.lastIndexOf(".") + 1) as MediaExtension;
  if (MEDIA_MIME_BY_EXTENSION[ext] !== mime) {
    throw new MediaError(
      415,
      "media-type-mismatch",
      `The file content (${mime}) does not match the .${ext} extension.`,
    );
  }
  const pixels = measureImageSize(input.bytes);
  return {
    filename,
    mime,
    size,
    sha1: sha1Hex(input.bytes),
    width: pixels?.width ?? null,
    height: pixels?.height ?? null,
  };
}
