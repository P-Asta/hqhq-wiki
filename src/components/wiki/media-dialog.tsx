"use client";

/**
 * Fandom's "Images and media" dialog — docs/engine/visual-editor.md §5.2, the
 * `🖼` affordance in both toolbars (§1) and `INSERT ▸ Media`.
 *
 * The flow Fandom uses, and the reason this is one dialog rather than two:
 * uploading a picture and picking one that is already on the wiki are the same
 * task with a different first step. Both end on a *selected file*, and the
 * placement controls (layout, alignment, width, caption) plus the live preview
 * hang off that one piece of state — so an author who has just uploaded never
 * has to find the file again in a second dialog to say where it goes.
 *
 * Four decisions worth stating.
 *
 * **Validation happens twice, deliberately.** The extension and size checks
 * here read `@/lib/media-rules`, the very constants `validateUpload` enforces,
 * so a 40 MB screenshot is refused without a 40 MB round-trip. The checks a
 * browser *cannot* make stay on the server: magic-byte sniffing is what kills
 * an SVG renamed to `.png`, and nothing here is trusted.
 *
 * **Upload goes through XMLHttpRequest, not `fetch`.** `fetch` cannot report
 * upload progress, and a picture on a slow connection is exactly where a real
 * percentage beats a spinner. When the browser cannot measure the body the bar
 * falls back to an indeterminate state rather than inventing a number.
 *
 * **The token may be null** when the visitor is signed out: that means "send
 * no Authorization header" — an empty one reads as a malformed credential —
 * and the route answers 401, which is the refusal the dialog surfaces.
 *
 * **All the state lives in `MediaDialogBody`**, which `Dialog` mounts only
 * while it is open. Opening the dialog is therefore the reset: the last
 * picture's caption and alignment cannot leak into this one, and no effect has
 * to write state back to clear them.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type ReactElement,
} from "react";

import { Button, buttonClasses } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FieldMessage } from "@/components/ui/field-message";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { MediaIcon, UploadIcon } from "@/components/wiki/editor-icons";
import { formatMessage } from "@/lib/i18n";
import {
  MEDIA_ALLOWED_EXTENSIONS,
  MEDIA_FORBIDDEN_NAME_CHARS,
  MEDIA_MAX_BYTES,
  MEDIA_MIME_BY_EXTENSION,
  hasForbiddenMediaNameChar,
  isAllowedMediaExtension,
} from "@/lib/media-rules";
import { canonicalFilename } from "@/lib/title";
import { cn } from "@/lib/utils";

/** Long enough that typing a filter does not fire a request per keystroke. */
const SEARCH_DEBOUNCE_MS = 220;

/** The route caps at 40 anyway; asking for more would only look ambitious. */
const LIBRARY_LIMIT = 40;

/** The file input's `accept`, derived from the allowlist rather than retyped. */
const ACCEPT = Array.from(new Set(Object.values(MEDIA_MIME_BY_EXTENSION))).join(",");

type MediaLayout = "thumb" | "frameless" | "full";
type MediaAlign = "right" | "left" | "center" | "none";
type MediaTab = "upload" | "library";

/* ------------------------------------------------------------------ */
/* Wikitext                                                            */
/* ------------------------------------------------------------------ */

/** §5.9's option keywords, in every spelling `links.ts` matches. */
const RESERVED_OPTIONS = new Set([
  // format group
  "thumb",
  "thumbnail",
  "frame",
  "framed",
  "frameless",
  // horizontal alignment
  "left",
  "right",
  "center",
  "none",
  // vertical alignment
  "baseline",
  "sub",
  "super",
  "top",
  "text-top",
  "middle",
  "bottom",
  "text-bottom",
  // border
  "border",
]);

/** The resize group and `upright`, in the shapes `links.ts` tests for. */
const RESERVED_SHAPES = [
  /^\d+\s*x\s*\d+\s*px$/i,
  /^\d+\s*px$/i,
  /^x\s*\d+\s*px$/i,
  /^upright(?:[= ]\s*[0-9]*\.?[0-9]+)?$/i,
];

/** The key/value group; `link=` is the worst of them — it retargets the picture. */
const RESERVED_KEYS = new Set(["alt", "link", "page", "class", "lang"]);

/** Would `buildImageLink` read this parameter as an option rather than a caption? */
function isReservedOption(text: string): boolean {
  if (RESERVED_OPTIONS.has(text.toLowerCase())) return true;
  if (RESERVED_SHAPES.some((shape) => shape.test(text))) return true;
  const eq = text.indexOf("=");
  return eq > 0 && RESERVED_KEYS.has(text.slice(0, eq).trim().toLowerCase());
}

/**
 * Spell the first character as a numeric character reference: `Center` becomes
 * `&#67;enter`, which matches no keyword, no size and no `key=` shape, and
 * which `escapeText` passes through untouched.
 */
function hideFirstChar(text: string): string {
  const code = text.codePointAt(0);
  if (code === undefined) return text;
  return `&#${code};${text.slice(String.fromCodePoint(code).length)}`;
}

/**
 * Neutralize the three characters that can break *out* of `[[File:…|…]]`.
 *
 * `|` would open another parameter (the engine keeps the last unmatched one as
 * the caption, so the front of a piped caption silently disappears), and
 * `[[`/`]]` move the depth counter that finds the closing brackets — an
 * unbalanced one either swallows the rest of the paragraph or ends the link
 * early. Numeric character references survive `escapeText` verbatim (spec
 * §11.5), so the reader still sees the character the author typed.
 *
 * Braces are deliberately left alone: they cannot escape the construct, and a
 * template call inside a caption is a wikitext feature, not an accident.
 *
 * A caption that *is* an option keyword needs the same trick for the same
 * reason. §5.9 tries every option before it settles for a caption, so a
 * caption of "Center" is not merely dropped — it also overrides the alignment
 * the author picked, and "Link = Bracken" turns the picture into a link to an
 * article. Hiding the first character behind a reference misses every one of
 * those tests while reading identically on the page.
 */
function escapeCaption(caption: string): string {
  const escaped = caption
    // A caption is one line by definition: a newline would end the block.
    .replace(/[\r\n]+/g, " ")
    .trim()
    .replace(/\|/g, "&#124;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;");
  return isReservedOption(escaped) ? hideFirstChar(escaped) : escaped;
}

/**
 * Compose `[[File:NAME|thumb|right|300px|Caption]]` in MediaWiki's parameter
 * order, emitting nothing for an option that is off — "full" size carries no
 * format keyword, `none` no alignment, a null width no `px` term, an empty
 * caption no trailing pipe. Exported and pure so the composition rules can be
 * tested without a DOM.
 *
 * The name is canonicalized (decisions O6) because that is what the wiki
 * stores. `PageStore.getFile` canonicalizes on lookup too, so this only keeps
 * the *source* honest about which file the page means.
 */
export function buildFileWikitext(input: {
  filename: string;
  layout: MediaLayout;
  align: MediaAlign;
  width: number | null;
  caption: string;
}): string {
  const options: string[] = [];
  if (input.layout !== "full") options.push(input.layout);
  if (input.align !== "none") options.push(input.align);
  if (input.width !== null && Number.isFinite(input.width) && input.width > 0) {
    options.push(`${Math.round(input.width)}px`);
  }
  const caption = escapeCaption(input.caption);
  if (caption !== "") options.push(caption);

  const tail = options.map((option) => `|${option}`).join("");
  return `[[File:${canonicalFilename(input.filename)}${tail}]]`;
}

/* ------------------------------------------------------------------ */
/* API shapes                                                          */
/* ------------------------------------------------------------------ */

/** The `files` columns this dialog draws with (GET and POST /api/media). */
interface MediaFile {
  filename: string;
  size: number;
  src: string;
  /** Null when the row records no dimensions; the preview copes either way. */
  width: number | null;
  height: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Read a response row defensively instead of asserting its type: this is the
 * one place the component trusts data it did not compute, and a row missing
 * the two fields the preview needs is worth dropping, not crashing on.
 */
function readMediaFile(value: unknown): MediaFile | null {
  if (!isRecord(value)) return null;
  const filename = readText(value.filename);
  const src = readText(value.src);
  if (filename === null || src === null) return null;
  return {
    filename,
    src,
    size: readCount(value.size) ?? 0,
    width: readCount(value.width),
    height: readCount(value.height),
  };
}

function readMediaList(value: unknown): MediaFile[] {
  if (!isRecord(value)) return [];
  const rows: unknown[] = Array.isArray(value.files) ? value.files : [];
  const files: MediaFile[] = [];
  for (const row of rows) {
    const file = readMediaFile(row);
    if (file !== null) files.push(file);
  }
  return files;
}

/** The unified error body — `{ error: { code, message } }` (api-response.ts). */
function readErrorCode(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error)) return null;
  return readText(value.error.code);
}

/** Carries what `failureMessage` reads; its own message is never rendered. */
class MediaUploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`media upload failed: ${status} ${code ?? "-"}`);
    this.name = "MediaUploadError";
  }
}

/* ------------------------------------------------------------------ */
/* Sizes                                                               */
/* ------------------------------------------------------------------ */

const BYTE_UNITS = ["B", "KB", "MB"] as const;

/**
 * "10 MB", "348 KB". The unit symbols are not dictionary strings for the same
 * reason wikitext is not one in editor-link-dialog.tsx: they are international
 * abbreviations that read identically in every locale this wiki ships.
 */
function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal only where it carries information: "1.4 MB", but "348 KB".
  const rounded = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${BYTE_UNITS[unit]}`;
}

/* ------------------------------------------------------------------ */
/* Client-side upload gate                                             */
/* ------------------------------------------------------------------ */

/** The extension `canonicalMediaName` would land on, without its throwing. */
function extensionOf(name: string): string {
  const canonical = canonicalFilename(name);
  const dot = canonical.lastIndexOf(".");
  return dot > 0 ? canonical.slice(dot + 1) : "";
}

/** The forbidden characters as a sentence reads them: "# | [ ] { } < >". */
const FORBIDDEN_CHARS_HINT = Array.from(MEDIA_FORBIDDEN_NAME_CHARS).join(" ");

/**
 * The half of `validateUpload` a browser can run — name, extension and size,
 * against the same constants and rules the route enforces, in the order
 * `canonicalMediaName` applies them. Returns the localized line to show, or
 * null when the file is worth sending.
 *
 * Exported, and asking for only the two fields it reads, so the gate can be
 * tested without building a `File`.
 */
export function localProblem(
  file: { name: string; size: number },
  labels: Pick<MediaDialogLabels, "badName" | "badType" | "tooLarge">,
): string | null {
  // A name the wiki would happily store but no `[[File:…]]` could ever spell:
  // caught here so the author renames the file, rather than watching a picture
  // upload and then refuse to appear on any page.
  if (hasForbiddenMediaNameChar(canonicalFilename(file.name))) {
    return formatMessage(labels.badName, { chars: FORBIDDEN_CHARS_HINT });
  }
  if (!isAllowedMediaExtension(extensionOf(file.name))) {
    return formatMessage(labels.badType, { types: MEDIA_ALLOWED_EXTENSIONS.join(", ") });
  }
  if (file.size > MEDIA_MAX_BYTES) {
    return formatMessage(labels.tooLarge, { max: formatBytes(MEDIA_MAX_BYTES) });
  }
  return null;
}

/** A server refusal → the labelled line for it (visual-editor.md §5.2). */
function failureMessage(error: unknown, labels: MediaDialogLabels): string {
  if (error instanceof MediaUploadError) {
    if (error.status === 413 || error.code === "payload-too-large") {
      return formatMessage(labels.tooLarge, { max: formatBytes(MEDIA_MAX_BYTES) });
    }
    if (
      error.status === 415 ||
      error.code === "unsupported-media-type" ||
      error.code === "media-type-mismatch"
    ) {
      return formatMessage(labels.badType, { types: MEDIA_ALLOWED_EXTENSIONS.join(", ") });
    }
    if (error.code === "invalid-filename") {
      return formatMessage(labels.badName, { chars: FORBIDDEN_CHARS_HINT });
    }
  }
  return labels.failed;
}

/** Rejection used when the dialog closes mid-upload; not a failure to report. */
const ABORTED = "aborted";

/**
 * POST the multipart body, reporting real progress. `register` hands the
 * request back so the caller can abort it when the dialog unmounts.
 */
function postMedia(
  file: File,
  token: string | null,
  onProgress: (percent: number | null) => void,
  register: (request: XMLHttpRequest) => void,
): Promise<MediaFile> {
  return new Promise<MediaFile>((resolve, reject) => {
    const body = new FormData();
    body.append("file", file);

    const request = new XMLHttpRequest();
    register(request);
    request.open("POST", "/api/media");
    if (token !== null) request.setRequestHeader("Authorization", `Bearer ${token}`);

    request.upload.addEventListener("progress", (event) => {
      onProgress(event.lengthComputable ? Math.round((event.loaded / event.total) * 100) : null);
    });

    request.addEventListener("load", () => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(request.responseText);
      } catch {
        // An unshaped body is still a failure with a status; fall through.
      }
      const uploaded = isRecord(parsed) ? readMediaFile(parsed.file) : null;
      if (request.status === 201 && uploaded !== null) {
        resolve(uploaded);
        return;
      }
      reject(new MediaUploadError(request.status, readErrorCode(parsed)));
    });
    request.addEventListener("error", () => reject(new MediaUploadError(0, null)));
    request.addEventListener("abort", () => reject(new MediaUploadError(0, ABORTED)));

    request.send(body);
  });
}

/**
 * Does the wiki already hold this canonical name? The list route filters by
 * substring, so an exact hit is the name itself. A probe that fails answers
 * "no": the warning is a courtesy before an upsert the route performs either
 * way, and refusing to upload because a *listing* broke would be worse.
 */
async function existsOnWiki(canonical: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/media?q=${encodeURIComponent(canonical)}&limit=${LIBRARY_LIMIT}`, {
      cache: "no-store",
    });
    if (!res.ok) return false;
    return readMediaList(await res.json()).some((file) => file.filename === canonical);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Props                                                               */
/* ------------------------------------------------------------------ */

export interface MediaDialogLabels {
  title: string;
  tabUpload: string;
  tabLibrary: string;
  dropHint: string;
  choose: string;
  uploading: string;
  librarySearch: string;
  libraryEmpty: string;
  loading: string;
  captionLabel: string;
  captionPlaceholder: string;
  layoutLabel: string;
  layoutThumb: string;
  layoutFrameless: string;
  layoutFull: string;
  alignLabel: string;
  alignRight: string;
  alignLeft: string;
  alignCenter: string;
  alignNone: string;
  widthLabel: string;
  insert: string;
  close: string;
  /** "{max}" = a human size like "10 MB". */
  tooLarge: string;
  /** "{types}" = the allowed extension list. */
  badType: string;
  /** "{chars}" = the characters a filename may not contain. */
  badName: string;
  failed: string;
  /** "{name}" = the file being replaced. */
  replaceWarning: string;
}

export interface MediaDialogProps {
  open: boolean;
  onClose: () => void;
  /** The wikitext to place, e.g. [[File:Ship.png|thumb|right|300px|Caption]]. */
  onApply: (source: string) => void;
  /** Null when signed out — send no Authorization header then. */
  getIdToken: () => Promise<string | null>;
  /**
   * A file the author dropped or pasted **onto the editing surface** rather
   * than into this dialog (visual-editor.md §15). The dialog opens already
   * uploading it, and everything after that — the name clash warning, the
   * placement controls, the preview — is the flow it always had. Handing the
   * file here rather than writing an upload of its own into the surface is the
   * whole point: there is one uploader, one validation and one set of
   * placement controls, and a dropped picture is not a second way to get a
   * different answer.
   */
  initialFile?: File | null;
  labels: MediaDialogLabels;
}

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

export function MediaDialog(props: MediaDialogProps): ReactElement {
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={props.labels.title}
      closeLabel={props.labels.close}
      // Two tabs, a drop zone, the placement controls and a preview do not fit
      // a short laptop viewport, and Dialog locks body scroll while it is open.
      className="max-h-[85vh] max-w-3xl overflow-y-auto"
    >
      <MediaDialogBody {...props} />
    </Dialog>
  );
}

function MediaDialogBody({
  onClose,
  onApply,
  getIdToken,
  initialFile,
  labels,
}: MediaDialogProps): ReactElement {
  const [tab, setTab] = useState<MediaTab>("upload");

  const [selected, setSelected] = useState<MediaFile | null>(null);
  const [layout, setLayout] = useState<MediaLayout>("thumb");
  const [align, setAlign] = useState<MediaAlign>("right");
  const [width, setWidth] = useState("");
  const [caption, setCaption] = useState("");

  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  /** A chosen file held back until the replace warning is acknowledged. */
  const [pending, setPending] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [library, setLibrary] = useState<MediaFile[]>([]);
  const [listing, setListing] = useState(true);
  /** Bumped after an upload so the grid re-runs its fetch and shows the file. */
  const [refresh, setRefresh] = useState(0);

  const uploadRef = useRef<XMLHttpRequest | null>(null);
  const listRef = useRef<AbortController | null>(null);

  const ids = useId();
  const fileId = `${ids}-file`;
  const panelId = `${ids}-panel`;
  const uploadTabId = `${ids}-tab-upload`;
  const libraryTabId = `${ids}-tab-library`;
  const searchId = `${ids}-search`;
  const captionId = `${ids}-caption`;
  const layoutId = `${ids}-layout`;
  const alignId = `${ids}-align`;
  const widthId = `${ids}-width`;

  /* ---------------- library ---------------- */

  useEffect(() => {
    const timer = setTimeout(() => {
      // Every setState below runs inside the debounce callback, never in the
      // effect body: typing a filter must not cascade renders.
      setListing(true);
      void (async () => {
        listRef.current?.abort();
        const controller = new AbortController();
        listRef.current = controller;
        try {
          const res = await fetch(
            `/api/media?q=${encodeURIComponent(query)}&limit=${LIBRARY_LIMIT}`,
            { cache: "no-store", signal: controller.signal },
          );
          if (res.ok) setLibrary(readMediaList(await res.json()));
        } catch {
          // A dropped listing leaves the previous grid standing; the upload tab
          // needs no network to try, so this is not worth an error line.
        } finally {
          if (listRef.current === controller) setListing(false);
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, refresh]);

  useEffect(
    () => () => {
      listRef.current?.abort();
      uploadRef.current?.abort();
    },
    [],
  );

  /* ---------------- upload ---------------- */

  const upload = useCallback(
    async (file: File) => {
      setUploading(true);
      setPercent(null);
      setError(null);
      try {
        // A null token means signed out: send no Authorization header and
        // let the route answer 401 rather than inventing an empty credential.
        const token = await getIdToken();
        const uploaded = await postMedia(file, token, setPercent, (request) => {
          uploadRef.current = request;
        });
        setSelected(uploaded);
        setRefresh((value) => value + 1);
      } catch (failure) {
        if (failure instanceof MediaUploadError && failure.code === ABORTED) return;
        setError(failureMessage(failure, labels));
      } finally {
        uploadRef.current = null;
        setUploading(false);
        setPercent(null);
      }
    },
    [getIdToken, labels],
  );

  /**
   * A file arriving from the input or a drop: refuse it locally, warn when it
   * would replace a name the wiki already holds, otherwise send it.
   */
  const offer = useCallback(
    async (file: File) => {
      setPending(null);
      const problem = localProblem(file, labels);
      if (problem !== null) {
        setError(problem);
        return;
      }
      setError(null);
      if (await existsOnWiki(canonicalFilename(file.name))) {
        setPending(file);
        return;
      }
      await upload(file);
    },
    [labels, upload],
  );

  /**
   * The file the surface handed over, offered exactly once.
   *
   * The body is mounted by `Dialog` only while the dialog is open, so opening
   * it with a file is this effect's whole trigger — there is no state to reset
   * afterwards and no way for the same drop to be uploaded twice.
   */
  useEffect(() => {
    if (initialFile == null) return;
    // Off the effect body, like every other state write in this file: `offer`
    // sets state synchronously, and a render cascading out of an effect is
    // what this repo's lint forbids.
    const handle = setTimeout(() => void offer(initialFile), 0);
    return () => clearTimeout(handle);
    // `offer` changes identity with the labels, and re-running on that would
    // upload the same dropped file a second time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFile]);

  /* ---------------- drag and drop ---------------- */

  // Without preventDefault the browser leaves the editor to display the file.
  // The listeners are document-wide while the dialog is open because a drop
  // that *misses* the zone would navigate away from an unpublished edit.
  useEffect(() => {
    const swallow = (event: Event) => event.preventDefault();
    document.addEventListener("dragover", swallow);
    document.addEventListener("drop", swallow);
    return () => {
      document.removeEventListener("dragover", swallow);
      document.removeEventListener("drop", swallow);
    };
  }, []);

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!dragging) setDragging(true);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    // A second file mid-upload would orphan the first request's handle, and
    // the file input is already disabled for the same reason.
    if (uploading) return;
    const file = event.dataTransfer.files.item(0);
    if (file !== null) void offer(file);
  };

  /* ---------------- derived ---------------- */

  const requested = Number.parseInt(width, 10);
  const pixelWidth = Number.isFinite(requested) && requested > 0 ? requested : null;

  const source =
    selected === null
      ? ""
      : buildFileWikitext({
          filename: selected.filename,
          layout,
          align,
          width: pixelWidth,
          caption,
        });

  /* ---------------- render ---------------- */

  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label={labels.title} className="flex gap-1 border-b border-hairline">
        <TabButton
          id={uploadTabId}
          controls={panelId}
          active={tab === "upload"}
          onSelect={() => setTab("upload")}
        >
          {labels.tabUpload}
        </TabButton>
        <TabButton
          id={libraryTabId}
          controls={panelId}
          active={tab === "library"}
          onSelect={() => setTab("library")}
        >
          {labels.tabLibrary}
        </TabButton>
      </div>

      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={tab === "upload" ? uploadTabId : libraryTabId}
      >
        {tab === "upload" ? (
          <div className="flex flex-col gap-3">
            <div
              onDragOver={onDragOver}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={cn(
                "flex flex-col items-center justify-center gap-3 rounded-[var(--radius-lg)] border border-dashed px-6 py-10 text-center transition-colors",
                dragging ? "border-link bg-canvas-soft-2" : "border-hairline-strong bg-canvas-soft",
              )}
            >
              <UploadIcon className="size-6 text-faint" />
              <p className="max-w-sm text-sm text-mute">{labels.dropHint}</p>

              {/* The input stays in the tab order (sr-only clips, it does not
                  hide), so the drop zone owns a real focusable control; the
                  label is its visible button and mirrors the input's focus. */}
              <input
                id={fileId}
                type="file"
                accept={ACCEPT}
                disabled={uploading}
                className="peer sr-only"
                onChange={(event) => {
                  const file = event.target.files?.item(0) ?? null;
                  // Clear the field so re-choosing the same file fires again.
                  event.target.value = "";
                  if (file !== null) void offer(file);
                }}
              />
              <label
                htmlFor={fileId}
                className={cn(
                  buttonClasses("secondary", "md", "cursor-pointer"),
                  "peer-disabled:pointer-events-none peer-disabled:opacity-50",
                  "peer-focus-visible:border-link peer-focus-visible:ring-2 peer-focus-visible:ring-link/40",
                )}
              >
                <UploadIcon className="size-4" />
                {labels.choose}
              </label>

              {uploading ? (
                <div className="flex w-full max-w-sm flex-col gap-1.5">
                  <p className="text-[13px] text-mute">{labels.uploading}</p>
                  <div
                    role="progressbar"
                    aria-label={labels.uploading}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent ?? undefined}
                    className="h-1.5 w-full overflow-hidden rounded-[var(--radius-sm)] bg-canvas-soft-2"
                  >
                    {/* The width is measured, so it cannot be a utility class;
                        an unmeasurable body animates instead of guessing. */}
                    <div
                      className={cn(
                        "h-full bg-primary transition-[width]",
                        percent === null && "w-1/3 animate-pulse",
                      )}
                      style={percent === null ? undefined : { width: `${percent}%` }}
                    />
                  </div>
                </div>
              ) : null}
            </div>

            {pending !== null ? (
              <div className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-hairline bg-canvas-soft p-3">
                <p className="text-[13px] text-body">
                  {formatMessage(labels.replaceWarning, { name: canonicalFilename(pending.name) })}
                </p>
                {/* The label set has no word for "replace", and inventing English
                    inside a component is the one rule this repo does not bend.
                    The filename is the honest, locale-free confirmation: the
                    sentence above says what pressing it does, and choosing a
                    different file above is the way out. */}
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    onClick={() => {
                      const file = pending;
                      setPending(null);
                      void upload(file);
                    }}
                  >
                    <UploadIcon className="size-4" />
                    <span className="font-mono">{canonicalFilename(pending.name)}</span>
                  </Button>
                </div>
              </div>
            ) : null}

            {error !== null ? <FieldMessage tone="error">{error}</FieldMessage> : null}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <Label htmlFor={searchId}>{labels.librarySearch}</Label>
              <Input
                id={searchId}
                value={query}
                placeholder={labels.librarySearch}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>

            {library.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-[var(--radius-md)] border border-hairline bg-canvas-soft px-6 py-10 text-center">
                <MediaIcon className="size-6 text-faint" />
                <p className="text-sm text-faint">{listing ? labels.loading : labels.libraryEmpty}</p>
              </div>
            ) : (
              <ul className="grid max-h-64 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
                {library.map((file) => (
                  <li key={file.filename}>
                    <button
                      type="button"
                      aria-pressed={selected?.filename === file.filename}
                      onClick={() => setSelected(file)}
                      className={cn(
                        "focus-ring flex w-full flex-col gap-1 rounded-[var(--radius-md)] border p-2 text-left transition-colors",
                        selected?.filename === file.filename
                          ? "border-hairline-strong bg-canvas-soft-2"
                          : "border-hairline bg-surface hover:bg-canvas-soft",
                      )}
                    >
                      <span className="flex h-20 items-center justify-center overflow-hidden rounded-[var(--radius-sm)] bg-canvas-soft">
                        {/* eslint-disable-next-line @next/next/no-img-element -- uploads are streamed by /api/media and may be animated GIFs, which next/image would re-encode */}
                        <img
                          src={file.src}
                          alt=""
                          loading="lazy"
                          width={file.width ?? undefined}
                          height={file.height ?? undefined}
                          className="max-h-20 w-auto object-contain"
                        />
                      </span>
                      <span className="truncate text-[13px] text-ink">{file.filename}</span>
                      <span className="font-mono text-[11px] text-faint">
                        {formatBytes(file.size)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {selected !== null ? (
        <section className="flex flex-col gap-3 border-t border-hairline pt-4">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex min-h-40 items-center justify-center overflow-hidden rounded-[var(--radius-md)] border border-hairline bg-canvas p-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- same reason as the grid; the intrinsic size, where the row has one, keeps the panel from jumping as it loads */}
                <img
                  src={selected.src}
                  alt={selected.filename}
                  width={selected.width ?? undefined}
                  height={selected.height ?? undefined}
                  className="max-h-40 w-auto object-contain"
                />
              </div>
              <p className="truncate font-mono text-[11px] text-mute">{selected.filename}</p>
            </div>

            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Label htmlFor={captionId}>{labels.captionLabel}</Label>
                <Input
                  id={captionId}
                  value={caption}
                  placeholder={labels.captionPlaceholder}
                  onChange={(event) => setCaption(event.target.value)}
                />
              </div>

              <div>
                <Label htmlFor={layoutId}>{labels.layoutLabel}</Label>
                <Select
                  id={layoutId}
                  value={layout}
                  onChange={(event) => setLayout(toLayout(event.target.value))}
                >
                  <option value="thumb">{labels.layoutThumb}</option>
                  <option value="frameless">{labels.layoutFrameless}</option>
                  <option value="full">{labels.layoutFull}</option>
                </Select>
              </div>

              <div>
                <Label htmlFor={alignId}>{labels.alignLabel}</Label>
                <Select
                  id={alignId}
                  value={align}
                  onChange={(event) => setAlign(toAlign(event.target.value))}
                >
                  <option value="right">{labels.alignRight}</option>
                  <option value="left">{labels.alignLeft}</option>
                  <option value="center">{labels.alignCenter}</option>
                  <option value="none">{labels.alignNone}</option>
                </Select>
              </div>

              <div>
                <Label htmlFor={widthId}>{labels.widthLabel}</Label>
                <Input
                  id={widthId}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={10}
                  value={width}
                  onChange={(event) => setWidth(event.target.value)}
                />
              </div>
            </div>
          </div>

          {/* Wikitext reads the same in every locale, so it needs no label —
              the choice editor-link-dialog.tsx makes for its own hint. */}
          <pre className="overflow-x-auto rounded-[var(--radius-sm)] border border-hairline bg-canvas-soft p-2 font-mono text-[11px] leading-4 text-mute">
            {source}
          </pre>
        </section>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-hairline pt-3">
        <Button variant="secondary" onClick={onClose}>
          {labels.close}
        </Button>
        <Button
          disabled={selected === null}
          onClick={() => {
            if (selected !== null) onApply(source);
          }}
        >
          {labels.insert}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

function TabButton({
  id,
  controls,
  active,
  onSelect,
  children,
}: {
  id: string;
  controls: string;
  active: boolean;
  onSelect: () => void;
  children: string;
}): ReactElement {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      aria-controls={controls}
      aria-selected={active}
      onClick={onSelect}
      className={cn(
        "focus-ring -mb-px border-b-2 px-3 py-2 text-sm transition-colors",
        active ? "border-ink font-medium text-ink" : "border-transparent text-mute hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

/**
 * A `<select>` hands back a plain string; these keep the state honest without
 * an assertion, falling back to what the dialog opened with.
 */
function toLayout(value: string): MediaLayout {
  return value === "frameless" || value === "full" ? value : "thumb";
}

function toAlign(value: string): MediaAlign {
  return value === "left" || value === "center" || value === "none" ? value : "right";
}
