import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  MEDIA_MAX_BYTES,
  MediaError,
  canonicalMediaName,
  measureImageSize,
  resolveMediaPath,
  sha1Hex,
  sniffImageMime,
  validateUpload,
} from "./media";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38,
]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

/* ---------------------------------------------------------------- */
/* Hand-built headers                                                */
/* ---------------------------------------------------------------- */

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function be32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function be16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function le16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function le24(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
}

/** Signature + a complete IHDR chunk header. */
function png(width: number, height: number): Uint8Array {
  return bytes(
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(13),
    0x49, 0x48, 0x44, 0x52,
    ...be32(width),
    ...be32(height),
    8, 6, 0, 0, 0,
  );
}

/** "GIF89a" + the logical screen descriptor. */
function gif(width: number, height: number): Uint8Array {
  return bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...le16(width), ...le16(height), 0xf7, 0, 0);
}

/** SOI, a JFIF APP0 the reader must skip, then the given SOFn. */
function jpeg(marker: number, width: number, height: number): Uint8Array {
  return bytes(
    0xff, 0xd8,
    0xff, 0xe0, ...be16(16), 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, marker, ...be16(17), 8, ...be16(height), ...be16(width), 3,
  );
}

function riff(fourcc: number[], payload: number[]): Uint8Array {
  return bytes(
    0x52, 0x49, 0x46, 0x46,
    ...le16(payload.length + 12), 0, 0,
    0x57, 0x45, 0x42, 0x50,
    ...fourcc,
    ...le16(payload.length), 0, 0,
    ...payload,
  );
}

/** "VP8 ": a lossy key frame — frame tag, sync code, two 14-bit dimensions. */
function webpVp8(width: number, height: number): Uint8Array {
  return riff(
    [0x56, 0x50, 0x38, 0x20],
    [0x9d, 0x01, 0x2a, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height)],
  );
}

/** "VP8L": the 0x2F signature, then width-1 and height-1 packed into a u32. */
function webpVp8l(width: number, height: number): Uint8Array {
  const packed = ((width - 1) | ((height - 1) << 14)) >>> 0;
  return riff(
    [0x56, 0x50, 0x38, 0x4c],
    [
      0x2f,
      packed & 0xff,
      (packed >>> 8) & 0xff,
      (packed >>> 16) & 0xff,
      (packed >>> 24) & 0xff,
    ],
  );
}

/** "VP8X": flags, then the canvas as two 24-bit little-endian minus-ones. */
function webpVp8x(width: number, height: number): Uint8Array {
  return riff(
    [0x56, 0x50, 0x38, 0x58],
    [0x10, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)],
  );
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof MediaError) return err.code;
    throw err;
  }
  throw new Error("expected a MediaError");
}

describe("canonicalMediaName (O6)", () => {
  it("lowercases, NFC-normalizes, and collapses whitespace/underscores to dashes", () => {
    expect(canonicalMediaName("Moon  Map_v2.PNG")).toBe("moon-map-v2.png");
    // NFD "ê" (e + combining circumflex) → NFC single code point.
    expect(canonicalMediaName("crêpe.png")).toBe("crêpe.png");
    expect(canonicalMediaName("  padded .Jpg ")).toBe("padded-.jpg");
  });

  it("accepts every allowlisted extension", () => {
    for (const ext of ["png", "jpg", "jpeg", "webp", "gif"]) {
      expect(canonicalMediaName(`shot.${ext}`)).toBe(`shot.${ext}`);
    }
  });

  it("rejects svg and unknown extensions with 415", () => {
    expect(code(() => canonicalMediaName("vector.svg"))).toBe("unsupported-media-type");
    expect(code(() => canonicalMediaName("archive.zip"))).toBe("unsupported-media-type");
    expect(code(() => canonicalMediaName("noextension"))).toBe("unsupported-media-type");
  });

  it("rejects traversal and separator names with 400", () => {
    expect(code(() => canonicalMediaName("../evil.png"))).toBe("invalid-filename");
    expect(code(() => canonicalMediaName("..\\evil.png"))).toBe("invalid-filename");
    expect(code(() => canonicalMediaName("a/b.png"))).toBe("invalid-filename");
    expect(code(() => canonicalMediaName("a\\b.png"))).toBe("invalid-filename");
    expect(code(() => canonicalMediaName(".hidden.png"))).toBe("invalid-filename");
    expect(code(() => canonicalMediaName("tricky..png"))).toBe("invalid-filename");
    expect(code(() => canonicalMediaName(""))).toBe("invalid-filename");
    expect(code(() => canonicalMediaName("   "))).toBe("invalid-filename");
    expect(code(() => canonicalMediaName("nul" + String.fromCharCode(0) + "byte.png"))).toBe("invalid-filename");
  });

  it("rejects characters no [[File:…]] could ever name", () => {
    // Each of these stores and serves perfectly and is then unreferenceable:
    // `#` becomes a fragment (parseTitle keeps only "screenshot-"), `|` opens
    // a file parameter, and the rest move the parser's bracket/brace counters.
    expect(code(() => canonicalMediaName("Screenshot #1.png"))).toBe("invalid-filename");
    expect(code(() => canonicalMediaName("a|b.png"))).toBe("invalid-filename");
    for (const ch of ["[", "]", "{", "}", "<", ">"]) {
      expect(code(() => canonicalMediaName(`a${ch}b.png`))).toBe("invalid-filename");
    }
  });

  it("still accepts the punctuation wikitext has no opinion about", () => {
    expect(canonicalMediaName("Ship (2).png")).toBe("ship-(2).png");
    expect(canonicalMediaName("a+b,c!.png")).toBe("a+b,c!.png");
  });
});

describe("resolveMediaPath (traversal rejection)", () => {
  const root = path.join("wiki-data", "uploads");

  it("resolves a plain name inside the root", () => {
    const resolved = resolveMediaPath(root, "moon-map.png");
    expect(resolved).toBe(path.resolve(root, "moon-map.png"));
    expect(resolved.startsWith(path.resolve(root) + path.sep)).toBe(true);
  });

  it("rejects escapes from the upload root", () => {
    expect(code(() => resolveMediaPath(root, "../secrets.png"))).toBe("invalid-path");
    expect(code(() => resolveMediaPath(root, "..\\secrets.png"))).toBe("invalid-path");
    expect(code(() => resolveMediaPath(root, "a/../../b.png"))).toBe("invalid-path");
    expect(code(() => resolveMediaPath(root, ""))).toBe("invalid-path");
    expect(code(() => resolveMediaPath(root, path.resolve("etc", "passwd")))).toBe("invalid-path");
  });

  it("rejects a path resolving to the root itself", () => {
    expect(code(() => resolveMediaPath(root, "."))).toBe("invalid-path");
  });
});

describe("sniffImageMime", () => {
  it("identifies the allowed formats by magic bytes", () => {
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(JPEG)).toBe("image/jpeg");
    expect(sniffImageMime(GIF)).toBe("image/gif");
    expect(sniffImageMime(WEBP)).toBe("image/webp");
  });

  it("returns null for anything else (svg, text, truncated headers)", () => {
    expect(sniffImageMime(SVG)).toBeNull();
    expect(sniffImageMime(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(sniffImageMime(new Uint8Array())).toBeNull();
    // RIFF but not WEBP (a .wav file).
    expect(
      sniffImageMime(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]),
      ),
    ).toBeNull();
  });
});

describe("measureImageSize", () => {
  it("reads a PNG IHDR", () => {
    expect(measureImageSize(png(1200, 675))).toEqual({ width: 1200, height: 675 });
  });

  it("reads a GIF logical screen descriptor (little-endian)", () => {
    expect(measureImageSize(gif(640, 400))).toEqual({ width: 640, height: 400 });
  });

  it("walks JPEG marker segments to the first SOFn", () => {
    // A JFIF APP0 sits between SOI and SOF0 in every camera JPEG, so the
    // reader must skip a segment by its length rather than assume an offset.
    expect(measureImageSize(jpeg(0xc0, 800, 600))).toEqual({ width: 800, height: 600 });
    // Progressive JPEGs use SOF2; SOF1/SOF9 are as common in the wild.
    expect(measureImageSize(jpeg(0xc2, 1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(measureImageSize(jpeg(0xc1, 32, 16))).toEqual({ width: 32, height: 16 });
  });

  it("reads all three WEBP flavours", () => {
    expect(measureImageSize(webpVp8(320, 240))).toEqual({ width: 320, height: 240 });
    expect(measureImageSize(webpVp8l(300, 200))).toEqual({ width: 300, height: 200 });
    expect(measureImageSize(webpVp8x(4000, 3000))).toEqual({ width: 4000, height: 3000 });
  });

  it("answers null rather than a zero box for a header it cannot read", () => {
    // Truncated PNG (signature only), a JPEG whose SOF is past the buffer, a
    // GIF cut inside the screen descriptor, and a WEBP with no known chunk.
    expect(measureImageSize(PNG)).toBeNull();
    expect(measureImageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBeNull();
    expect(measureImageSize(GIF.slice(0, 7))).toBeNull();
    expect(measureImageSize(WEBP)).toBeNull();
    expect(measureImageSize(SVG)).toBeNull();
    // A 0x0 PNG is a header lie, and a zero box is what made "Full size"
    // publish an invisible picture — never report one.
    expect(measureImageSize(png(0, 0))).toBeNull();
  });
});

describe("validateUpload", () => {
  it("accepts a matching png and returns canonical row values", () => {
    const result = validateUpload({ filename: "Moon Map.PNG", bytes: PNG });
    expect(result).toEqual({
      filename: "moon-map.png",
      mime: "image/png",
      size: PNG.byteLength,
      sha1: sha1Hex(PNG),
      // This fixture is a bare signature with no IHDR behind it.
      width: null,
      height: null,
    });
  });

  it("carries the measured dimensions into the row values", () => {
    // Without these the `files` row is NULL/NULL, PageStore.getFile reports
    // 0x0, and a "Full size" placement renders `<img width="0">`.
    const bytes = png(1200, 675);
    const result = validateUpload({ filename: "ship.png", bytes });
    expect(result.width).toBe(1200);
    expect(result.height).toBe(675);
  });

  it("treats jpg and jpeg extensions as image/jpeg", () => {
    expect(validateUpload({ filename: "a.jpg", bytes: JPEG }).mime).toBe("image/jpeg");
    expect(validateUpload({ filename: "a.jpeg", bytes: JPEG }).mime).toBe("image/jpeg");
  });

  it("rejects svg content even when named .png", () => {
    expect(code(() => validateUpload({ filename: "sneaky.png", bytes: SVG }))).toBe(
      "unsupported-media-type",
    );
  });

  it("rejects content/extension mismatches", () => {
    expect(code(() => validateUpload({ filename: "actually-gif.png", bytes: GIF }))).toBe(
      "media-type-mismatch",
    );
  });

  it("rejects empty and oversized payloads", () => {
    expect(code(() => validateUpload({ filename: "a.png", bytes: new Uint8Array() }))).toBe(
      "empty-file",
    );
    expect(code(() => validateUpload({ filename: "a.png", bytes: PNG, maxBytes: 4 }))).toBe(
      "payload-too-large",
    );
    expect(MEDIA_MAX_BYTES).toBeGreaterThan(0);
  });
});

describe("sha1Hex", () => {
  it("produces the known digest for a fixed input", () => {
    expect(sha1Hex(new TextEncoder().encode("abc"))).toBe(
      "a9993e364706816aba3e25717850c26c9cd0d89d",
    );
  });
});
