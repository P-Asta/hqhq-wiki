"use client";

/**
 * The missing-page branch of `/{locale}/wiki/[...title]` — decisions-v2 O14.
 *
 * O14.1: a page that does not exist renders **the editor for that title,
 * inline**, in the normal article chrome. No "create this page" landing, no
 * intermediate CTA click — the editor element is built by the route (the same
 * `<Editor>` the `/edit` route mounts, from the same loader) and handed here
 * as `editor`.
 *
 * O14.2: a visitor who may not edit gets the classic "there is currently no
 * text in this page" notice plus a sign-in CTA **and** a link to the edit URL
 * — never a dead end.
 *
 * Who may edit is a client fact: auth is a stateless Bearer flow, so the
 * server cannot know whether this request carries a signed-in user (exactly
 * how `/edit` decides, via `useAuth`).
 */

import type { ReactNode } from "react";

import { useAuth } from "@/components/auth-provider";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export interface CreatePageNoticeLabels {
  /** "There is currently no text in this page". */
  title: string;
  description: string;
  /** Sign-in CTA ("Sign in"). */
  signIn: string;
  /** Link to the edit URL ("Create this page"). */
  edit: string;
}

export interface CreatePageNotice {
  labels: CreatePageNoticeLabels;
  signInHref: string;
  editHref: string;
  /** Shown in the description so the reader sees the exact title requested. */
  slug: string;
}

export interface CreatePageViewProps {
  /** `<Editor>` for the URL's title, pre-built by the route. */
  editor: ReactNode;
  notice: CreatePageNotice;
}

export interface InlineEditorAuthState {
  /** A Firebase user is signed in. */
  user: boolean;
  /** The principal has not resolved yet. */
  loading: boolean;
}

/**
 * O14.1 is the default: the editor shows unless we positively know the
 * visitor may not edit. While the principal is still resolving we therefore
 * render the editor rather than flashing the O14.2 notice at every editor —
 * the editor is inert until auth resolves anyway (its own Save stays disabled
 * and it raises a sign-in banner for a resolved anonymous visitor).
 */
export function mayEditInline(state: InlineEditorAuthState): boolean {
  return state.user || state.loading;
}

export function CreatePageView({ editor, notice }: CreatePageViewProps) {
  const auth = useAuth();
  const mayEdit = mayEditInline({ user: auth.user !== null, loading: auth.loading });

  if (mayEdit) return <>{editor}</>;

  return (
    <EmptyState
      title={notice.labels.title}
      description={
        <>
          {notice.labels.description}{" "}
          <span className="font-mono text-xs text-faint">{notice.slug}</span>
        </>
      }
      action={
        <div className="flex flex-wrap items-center justify-center gap-2">
          <ButtonLink href={notice.signInHref}>{notice.labels.signIn}</ButtonLink>
          <ButtonLink href={notice.editHref} variant="secondary">
            {notice.labels.edit}
          </ButtonLink>
        </div>
      }
      className="my-10"
    />
  );
}
