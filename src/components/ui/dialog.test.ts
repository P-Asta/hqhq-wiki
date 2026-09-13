/**
 * The two decisions the modal's key trap and focus trap make, exported so they
 * can be tested here: the suite runs in vitest's `node` environment, and
 * neither question — "is this key already answered?", "who gets focus back?" —
 * needs a browser to answer. The markup around them is markup.
 */

import { describe, expect, it } from "vitest";

import { bindDialogKeys, dialogKeyAction, openDialogFocusTrap } from "./dialog";

/* ---------------------------------------------------------------- */
/* dialogKeyAction — whose key is it?                                */
/* ---------------------------------------------------------------- */

describe("dialogKeyAction", () => {
  it("closes on Escape and traps Tab", () => {
    expect(dialogKeyAction({ key: "Escape", defaultPrevented: false })).toBe("close");
    expect(dialogKeyAction({ key: "Tab", defaultPrevented: false })).toBe("trap");
  });

  it("ignores everything else", () => {
    expect(dialogKeyAction({ key: "a", defaultPrevented: false })).toBe("ignore");
    expect(dialogKeyAction({ key: "Enter", defaultPrevented: false })).toBe("ignore");
  });

  it("leaves an Escape a nested popper already answered alone", () => {
    // The version dialog's TokenPicker dismisses its list on Escape and calls
    // preventDefault. It also calls stopPropagation, but React's delegated
    // listener and this dialog's listener are both on `document`, so that
    // never reached us — and the dialog closing here discards the whole form.
    expect(dialogKeyAction({ key: "Escape", defaultPrevented: true })).toBe("ignore");
    expect(dialogKeyAction({ key: "Tab", defaultPrevented: true })).toBe("ignore");
  });
});

/* ---------------------------------------------------------------- */
/* The two traps, and the fact that they are two                     */
/* ---------------------------------------------------------------- */

function focusRecorder() {
  const moves: string[] = [];
  const target = (name: string) => ({ focus: () => void moves.push(name) });
  return { moves, target };
}

describe("openDialogFocusTrap", () => {
  it("claims focus, locks scroll, and hands both back on teardown", () => {
    const { moves, target } = focusRecorder();
    const body = { style: { overflow: "auto" } };

    const teardown = openDialogFocusTrap(target("opener"), target("panel"), body);
    expect(moves).toEqual(["panel"]);
    expect(body.style.overflow).toBe("hidden");

    teardown();
    expect(moves).toEqual(["panel", "opener"]);
    expect(body.style.overflow).toBe("auto");
  });

  it("leaves focus where it is when a field already claimed it", () => {
    const { moves, target } = focusRecorder();
    openDialogFocusTrap(target("opener"), null, { style: { overflow: "" } });
    expect(moves).toEqual([]);
  });

  it("does not restore focus when only the key listener is rebound", () => {
    // The repro: the editor island re-renders mid-typing (preview debounce),
    // handing the dialog a fresh `onClose` arrow. That used to tear down the
    // one combined effect, so `opener.focus()` fired while the dialog was
    // still open and the caret left the caption field.
    const { moves, target } = focusRecorder();
    const listeners: Array<(event: KeyboardEvent) => void> = [];
    const host = {
      addEventListener: (_type: "keydown", handler: (event: KeyboardEvent) => void) => {
        listeners.push(handler);
      },
      removeEventListener: (_type: "keydown", handler: (event: KeyboardEvent) => void) => {
        const at = listeners.indexOf(handler);
        if (at >= 0) listeners.splice(at, 1);
      },
    };

    const teardown = openDialogFocusTrap(target("opener"), target("panel"), {
      style: { overflow: "" },
    });
    moves.length = 0;

    const unbind = bindDialogKeys(host, () => {});
    unbind();
    bindDialogKeys(host, () => {});

    expect(listeners).toHaveLength(1);
    expect(moves).toEqual([]);

    teardown();
    expect(moves).toEqual(["opener"]);
  });
});
