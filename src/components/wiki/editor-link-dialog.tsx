"use client";

/**
 * Fandom's link dialog: a target field, a display-text field, and — only when
 * the caret was already inside a link — a remove button. Reached from the
 * toolbar's `🔗` and from `Ctrl/Cmd+K` (docs/engine/visual-editor.md §1, §6).
 *
 * Four decisions worth stating.
 *
 * The fields live in their own component, so *opening* the dialog mounts them
 * and closing it throws their state away. The caret has almost certainly moved
 * since the last opening, and fields that survived it would quietly relink the
 * wrong words; letting the mount do the seeding gets that for free, without an
 * effect writing state back into the render it just finished.
 *
 * The internal/external hint is drawn as the wikitext the link will become,
 * not as a sentence. Wikitext is syntax and reads identically in every locale
 * (syntax-help.tsx keeps its examples out of the dictionary for that reason),
 * so the hint needs no dictionary line — and it shows the author what will
 * actually land in the source rather than a category name for it.
 *
 * **The target field searches the wiki as it is typed** (`GET
 * /api/search/suggest`), because a free-text target is how a wiki rots: one
 * transposed letter makes a red link that looks exactly like a link to a page
 * that has not been written yet, and nothing on the page ever says which it
 * is. So the field is the combobox the search page already has —
 * `suggest-box.tsx`'s listbox behaviour, its debounce and its ARIA, over the
 * same route — and under it a line saying plainly whether the typed target
 * names a page that exists. Nothing here blocks anything: a red link is how a
 * wiki grows, and "this will be a new page" is information rather than an
 * error.
 *
 * **`TokenPicker` is not reused**, close as it looks. Its whole shape is the
 * create row — "search what exists, offer what doesn't" — and a link has no
 * such row: the target the author has already typed *is* the new page, so an
 * offer to create it would be a row that does nothing when chosen. More
 * decisively, the picker keeps its results private (they drive its own loading
 * state and its create row), and the one fact this dialog has to publish —
 * does the typed target exist? — is a fact *about* those results, drawn under
 * the field whether or not the list is open. Two smaller mismatches follow
 * from the same place: the picker swallows Enter unconditionally because it
 * sits inside forms it must never submit, while Enter in this field is the
 * fastest way to insert a link; and a suggestion is a page rather than a
 * token, so choosing one has to spell a link target out of a namespace and a
 * title.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { CONTROL_CLASSES, Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DEFAULT_NAMESPACES,
  NS_ID_BY_STORABLE,
  nsPrefix,
  parseTitle,
  type StorableNamespace,
} from "@/lib/title";
import { cn } from "@/lib/utils";
import { matchProtocol } from "@/lib/wikitext/external-links";

/**
 * Whether a target reads as a URL rather than a page name.
 *
 * The allowlist is the engine's own (`URL_PROTOCOLS`, spec §6.1), so the hint
 * this dialog shows can never disagree with what stage 5 will render. The
 * protocol-relative `//host` form counts here because the link this dialog
 * writes is always bracketed, which is the only place MediaWiki accepts it.
 *
 * A colon on its own is not a protocol: `Template:Infobox moon` is a page.
 */
export function isExternalTarget(target: string): boolean {
  return matchProtocol(target.trim(), 0, true) > 0;
}

/* ------------------------------------------------------------------ */
/* Searching for the target (routes.md /api/search/suggest)            */
/* ------------------------------------------------------------------ */

/** One row of `GET /api/search/suggest` — the same rows `suggest-box.tsx` reads. */
export interface LinkSuggestion {
  pageId: number;
  namespace: StorableNamespace;
  slug: string;
  title: string;
}

/**
 * What to send as `q=` for a typed target, or null when there is nothing to
 * search for.
 *
 * The index holds **bare page names**: a `Template:` page is indexed as
 * "Infobox moon", so sending the target as the author typed it answers nothing
 * for every page outside the main namespace — and a dialog that then said "no
 * page is called this" would be wrong about exactly the pages hardest to spell
 * from memory. `parseTitle` is what splits the prefix off (spec §5.7–§5.8), and
 * it drops the fragment and the plain-link colon on the way.
 *
 * A URL is not a page name, so an external target searches for nothing at all.
 */
export function linkSearchQuery(target: string): string | null {
  const trimmed = target.trim();
  if (trimmed === "" || isExternalTarget(trimmed)) return null;
  const parsed = parseTitle(trimmed);
  return parsed === null ? null : parsed.pageName;
}

/**
 * The wikitext target that *links to* one suggestion.
 *
 * The leading colon on `File:` and `Category:` is not decoration: without it
 * `[[Category:Mechanics]]` files the page into that category and renders
 * nothing at all, and `[[File:Ship.png]]` embeds the image (spec §5.8). This
 * dialog makes links, so those two get the plain-link form — the media dialog
 * is where an image is placed.
 */
export function linkSuggestionTarget(item: Pick<LinkSuggestion, "namespace" | "title">): string {
  if (item.namespace === "main") return item.title;
  const canonical = DEFAULT_NAMESPACES.canonical[NS_ID_BY_STORABLE[item.namespace]];
  const plain = item.namespace === "file" || item.namespace === "category" ? ":" : "";
  return `${plain}${canonical}:${item.title}`;
}

/**
 * What the line under the field may claim about the typed target.
 *
 * `"none"` is the honest answer more often than it looks: for a URL, for a
 * blank or unparseable title, for a namespace this wiki cannot store a page in
 * (`Talk:`, `User:` — decisions O2 makes those permanently red rather than
 * newly written), and for as long as the search has not answered *this* target
 * yet. Saying nothing beats saying something the search has not established.
 */
export type LinkTargetStatus = "none" | "existing" | "new";

/**
 * Whether the search found the page the author typed.
 *
 * `answered` is the suggestion list **for this exact target** — null while one
 * is still owed — because a list answering an earlier keystroke is not evidence
 * about this one. Identity is (namespace, slug) per decisions O1, so the
 * comparison runs on the parsed title and not on the raw string: `gold_bar`,
 * `Gold bar` and `gold bar` are one page.
 */
export function linkTargetStatus(
  target: string,
  answered: readonly LinkSuggestion[] | null,
): LinkTargetStatus {
  if (answered === null || linkSearchQuery(target) === null) return "none";
  const parsed = parseTitle(target.trim());
  if (parsed === null || parsed.nsName === null) return "none";
  const found = answered.some(
    (item) => item.namespace === parsed.nsName && item.slug === parsed.slug,
  );
  return found ? "existing" : "new";
}

/* ------------------------------------------------------------------ */
/* The dialog                                                          */
/* ------------------------------------------------------------------ */

export interface LinkDialogLabels {
  title: string;
  target: string;
  targetPlaceholder: string;
  text: string;
  apply: string;
  remove: string;
  close: string;
  /** Accessible name of the suggestion listbox. */
  suggestions: string;
  /** The typed target names a page that already exists. */
  existingPage: string;
  /** It does not — which is allowed, and worth knowing before publishing. */
  newPage: string;
}

export interface LinkDialogValue {
  target: string;
  text: string;
}

export interface LinkDialogProps {
  open: boolean;
  /** The link under the caret, or null when one is being created. */
  initial: LinkDialogValue | null;
  /** Content locale being edited — the search is per locale (routes.md). */
  locale: string;
  onClose: () => void;
  onApply: (value: LinkDialogValue) => void;
  /** Only offered when `initial` is not null — there is nothing else to unlink. */
  onRemove: () => void;
  labels: LinkDialogLabels;
}

/**
 * The wikitext these fields would produce — `[[target|text]]` / `[href text]`,
 * collapsing to the bare form when the text adds nothing, which is the choice
 * `VeLink`/`VeExtLink` describe (model.ts).
 */
function previewWikitext(target: string, text: string): string {
  if (isExternalTarget(target)) return text === "" ? `[${target}]` : `[${target} ${text}]`;
  return text === "" || text === target ? `[[${target}]]` : `[[${target}|${text}]]`;
}

export function LinkDialog({
  open,
  initial,
  locale,
  onClose,
  onApply,
  onRemove,
  labels,
}: LinkDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title={labels.title} closeLabel={labels.close}>
      <LinkFields
        initial={initial}
        locale={locale}
        onClose={onClose}
        onApply={onApply}
        onRemove={onRemove}
        labels={labels}
      />
    </Dialog>
  );
}

/** Long enough to swallow a burst of typing, short enough to feel live. */
const DEBOUNCE_MS = 200;

/** One search's answer, kept beside the query it answered, so staleness is `===`. */
interface Answer {
  query: string;
  items: LinkSuggestion[];
}

function LinkFields({
  initial,
  locale,
  onClose,
  onApply,
  onRemove,
  labels,
}: Omit<LinkDialogProps, "open">) {
  const editing = initial !== null;
  const listId = useId();

  const [target, setTarget] = useState(initial === null ? "" : initial.target);
  const [text, setText] = useState(initial === null ? "" : initial.text);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [activeRaw, setActiveRaw] = useState(-1);

  const trimmedTarget = target.trim();
  const trimmedText = text.trim();
  const canApply = trimmedTarget !== "";

  const query = linkSearchQuery(target);

  // Aborted rather than sequence-numbered: this is a real request over the
  // network, and a keystroke that supersedes it should free the socket rather
  // than wait for an answer nobody will read.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (query === null) return;
    // Every setState below sits inside the debounce callback, never in the
    // effect body: typing must not cascade a render per keystroke.
    const handle = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const url =
        `/api/search/suggest?q=${encodeURIComponent(query)}` +
        `&locale=${encodeURIComponent(locale)}`;
      fetch(url, { signal: controller.signal })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
        .then((body: { suggestions?: LinkSuggestion[] }) => {
          // The list is opened by the author (typing, focus, an arrow key) and
          // never by an arriving answer: choosing a row puts that page's name
          // in the field, which starts a search for it, and a list that opened
          // itself would pop straight back up over the choice just made.
          setAnswer({ query, items: body.suggestions ?? [] });
          setActiveRaw(-1);
        })
        .catch(() => {
          // A search that failed is not evidence that the page is missing, so
          // the answer is dropped rather than recorded as "nothing found" —
          // the note below stays silent instead of calling a real page new.
          // Only *this* query's answer is dropped: an abort arrives late.
          setAnswer((previous) =>
            previous === null || previous.query === query ? null : previous,
          );
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query, locale]);

  /* — derived every render, so an arriving answer can never leave a stale
       active row behind (the list shrinks under it) — */

  const answered = answer !== null && answer.query === query ? answer.items : null;
  const options = (answered ?? []).map((item) => ({
    key: `${item.namespace}:${item.slug}`,
    target: linkSuggestionTarget(item),
    title: item.title,
    hint: `${nsPrefix(item.namespace)}${item.slug}`,
  }));
  const activeIndex = activeRaw >= 0 && activeRaw < options.length ? activeRaw : -1;
  const showList = listOpen && options.length > 0;
  const status = linkTargetStatus(target, answered);
  const note =
    status === "existing" ? labels.existingPage : status === "new" ? labels.newPage : "";

  const closeList = () => {
    setListOpen(false);
    setActiveRaw(-1);
  };

  // Wikitext ignores the padding around a link's parts anyway, so trimming
  // here keeps `[[ Moons | the list ]]` out of the source in the first place.
  const apply = () => {
    if (!canApply) return;
    onApply({ target: trimmedTarget, text: trimmedText });
  };

  const onTargetKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      // Only ours while the list is open, and taken by `preventDefault` rather
      // than by `stopPropagation`: the dialog listens on the same node React
      // does, so only a defaultPrevented key is one it leaves alone
      // (`dialogKeyAction`, ui/dialog.tsx). Otherwise dismissing the list would
      // also discard the link.
      if (!showList) return;
      event.preventDefault();
      closeList();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (options.length === 0) return;
      event.preventDefault();
      // From nothing, ArrowDown lands on the first row and ArrowUp on the
      // LAST — the same walk `suggest-box.tsx` does, and the one a reader who
      // has used a combobox before expects.
      const from = showList ? activeIndex : -1;
      const last = options.length - 1;
      const down = event.key === "ArrowDown";
      setListOpen(true);
      setActiveRaw(down ? (from + 1) % options.length : from <= 0 ? last : from - 1);
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const active = showList && activeIndex >= 0 ? options[activeIndex] : undefined;
    if (active !== undefined) {
      // Chosen, not applied: the display text is still to be decided, and a
      // second Enter is the shortest way to say "that one, as it is".
      setTarget(active.target);
      closeList();
      return;
    }
    apply();
  };

  const onTextKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    apply();
  };

  return (
    <div className="flex flex-col gap-4">
      {/* These fields exist only while the dialog is open, so `autoFocus` lands
          on every opening: the target for a new link, the display text for one
          whose target is presumably already right. */}
      <div>
        <Label htmlFor="link-dialog-target">{labels.target}</Label>
        <div className="relative">
          <input
            id="link-dialog-target"
            type="text"
            role="combobox"
            autoFocus={!editing}
            value={target}
            placeholder={labels.targetPlaceholder}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              showList && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined
            }
            onChange={(event) => {
              setTarget(event.target.value);
              setActiveRaw(-1);
              setListOpen(true);
            }}
            onFocus={() => setListOpen(true)}
            // Pointer-downs inside the list are prevented below, so a blur here
            // is always a real departure: an outside click, or Tab away.
            onBlur={closeList}
            onKeyDown={onTargetKeyDown}
            className={cn(CONTROL_CLASSES, "h-10 px-3")}
          />
          {showList ? (
            <div
              onMouseDown={(event) => event.preventDefault()}
              className="absolute inset-x-0 top-full z-30 mt-1 max-h-56 overflow-y-auto rounded-[var(--radius-md)] border border-hairline bg-surface shadow-[var(--shadow-md)]"
            >
              <ul id={listId} role="listbox" aria-label={labels.suggestions}>
                {options.map((option, index) => (
                  <li
                    key={option.key}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    onClick={() => {
                      setTarget(option.target);
                      closeList();
                    }}
                    onMouseEnter={() => setActiveRaw(index)}
                    className={cn(
                      "flex cursor-pointer items-baseline justify-between gap-3 px-3 py-2 text-sm",
                      index === activeIndex ? "bg-canvas-soft text-ink" : "text-body",
                    )}
                  >
                    <span className="truncate font-medium">{option.title}</span>
                    <span className="shrink-0 font-mono text-[11px] text-faint">{option.hint}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        {canApply ? (
          <p className="mt-1.5 break-all font-mono text-[11px] leading-4 text-mute">
            {previewWikitext(trimmedTarget, trimmedText)}
          </p>
        ) : null}
        {/* Not a `FieldMessage`: neither answer is an error, and the one that
            reports a red link is the one an author most needs to read calmly.
            The live region is mounted from the start and only its *text*
            changes — a `role="status"` element inserted at the moment it has
            something to say is the one a screen reader is liable to miss — and
            an empty one lays out at zero height because it makes no line box. */}
        <p
          role="status"
          className={cn("text-[11px] leading-4 text-mute", note !== "" && "mt-1")}
        >
          {note}
        </p>
      </div>

      <div>
        <Label htmlFor="link-dialog-text">{labels.text}</Label>
        <Input
          id="link-dialog-text"
          autoFocus={editing}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onTextKeyDown}
        />
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-hairline pt-3">
        {editing ? (
          <Button variant="ghost" className="me-auto" onClick={onRemove}>
            {labels.remove}
          </Button>
        ) : null}
        <Button variant="secondary" onClick={onClose}>
          {labels.close}
        </Button>
        <Button disabled={!canApply} onClick={apply}>
          {labels.apply}
        </Button>
      </div>
    </div>
  );
}
