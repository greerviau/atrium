import { describe, it, expect, afterEach, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { minimapExtension } from "../../src/lib/editor/minimap";

let view: EditorView | undefined;
let mountedContainer: HTMLElement | undefined;

afterEach(() => {
  view?.destroy();
  view = undefined;
  mountedContainer?.remove();
  mountedContainer = undefined;
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  document.body.style.webkitUserSelect = "";
});

// Attached to document.body (not left detached) because a mousemove
// dispatched from `.cm-content` needs to bubble all the way to the
// `window`-level listener the overlay actually registers — a detached
// subtree's events never reach `window` at all, only ancestors within the
// same detached tree.
function mount(enabled: boolean): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  mountedContainer = container;
  view = new EditorView({
    state: EditorState.create({
      doc: "line one\nline two\nline three\n",
      extensions: minimapExtension(enabled),
    }),
    parent: container,
  });
  return container;
}

/** Injected <style> text across the whole document, where style-mod mounts EditorView.baseTheme() rules. */
function allStyleText(): string {
  return Array.from(document.querySelectorAll("style"))
    .map((el) => el.textContent ?? "")
    .join("\n");
}

/**
 * Fakes the geometry jsdom does not provide (getBoundingClientRect, scroll
 * metrics), needed to exercise onMouseDown/onMouseMove's actual pixel math:
 * a 500px viewport over 5000px of content, with the minimap track spanning
 * y = 0..500 on screen.
 */
function fakeGeometry(root: HTMLElement) {
  const scrollDOM = view!.scrollDOM;
  let scrollTop = 0;
  Object.defineProperty(scrollDOM, "clientHeight", { configurable: true, get: () => 500 });
  Object.defineProperty(scrollDOM, "scrollHeight", { configurable: true, get: () => 5000 });
  Object.defineProperty(scrollDOM, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    // Mimics the browser clamping scrollTop into [0, scrollHeight - clientHeight].
    set: (v: number) => {
      scrollTop = Number.isNaN(v) ? scrollTop : Math.min(Math.max(0, v), 4500);
    },
  });

  const overlayContainer = root.querySelector(".cm-minimap-overlay-container") as HTMLElement;
  const indicator = root.querySelector(".cm-minimap-overlay") as HTMLElement;
  overlayContainer.getBoundingClientRect = () => ({ top: 0, y: 0, height: 500, bottom: 500 }) as DOMRect;
  indicator.getBoundingClientRect = () =>
    ({
      top: parseFloat(indicator.style.top || "0"),
      y: parseFloat(indicator.style.top || "0"),
      height: 62.5,
    }) as DOMRect;

  return { scrollDOM, overlayContainer, indicator, read: () => scrollTop };
}

describe("minimapExtension", () => {
  it("renders the minimap gutter DOM node when enabled", () => {
    const container = mount(true);
    expect(container.querySelector(".cm-minimap-gutter")).not.toBeNull();
  });

  it("renders no minimap gutter DOM node when disabled", () => {
    const container = mount(false);
    expect(container.querySelector(".cm-minimap-gutter")).toBeNull();
  });

  it("leaves the gutter in flow, with no position: absolute override", () => {
    mount(true);
    const css = allStyleText();
    const gutterRules = css.split("\n").filter((line) => line.includes(".cm-minimap-gutter"));
    expect(gutterRules.length, `expected at least one .cm-minimap-gutter rule, got:\n${css}`).toBeGreaterThan(0);
    for (const rule of gutterRules) {
      expect(rule).not.toMatch(/position:\s*absolute/);
    }
  });

  it("renders the -webkit-user-select guard on the overlay container", () => {
    mount(true);
    const css = allStyleText();
    const containerRules = css.split("\n").filter((line) => line.includes(".cm-minimap-overlay-container"));
    expect(containerRules.length, `expected at least one .cm-minimap-overlay-container rule, got:\n${css}`).toBeGreaterThan(0);
    expect(containerRules.some((rule) => rule.includes("-webkit-user-select: none"))).toBe(true);
  });

  it("pins the cursor to default on a container mousedown and clears it on mouseup", () => {
    const container = mount(true);
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container");
    expect(overlayContainer).not.toBeNull();

    overlayContainer!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(document.body.style.cursor).toBe("default");

    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    expect(document.body.style.cursor).toBe("");
  });

  it("disables user-select on the body for a container mousedown and restores it on mouseup", () => {
    const container = mount(true);
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container");
    expect(overlayContainer).not.toBeNull();

    overlayContainer!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(document.body.style.userSelect).toBe("none");
    expect(document.body.style.webkitUserSelect).toBe("none");

    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    expect(document.body.style.userSelect).toBe("");
    expect(document.body.style.webkitUserSelect).toBe("");
  });

  it("clears the body user-select guard when the view is destroyed mid-drag", () => {
    const container = mount(true);
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container");
    expect(overlayContainer).not.toBeNull();

    overlayContainer!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(document.body.style.userSelect).toBe("none");
    expect(document.body.style.webkitUserSelect).toBe("none");

    view?.destroy();
    view = undefined;
    expect(document.body.style.userSelect).toBe("");
    expect(document.body.style.webkitUserSelect).toBe("");
  });

  it("self-heals a drag left dangling when the primary button was released outside the window", () => {
    const container = mount(true);
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container");
    expect(overlayContainer).not.toBeNull();

    overlayContainer!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(overlayContainer!.classList.contains("cm-minimap-overlay-active")).toBe(true);
    expect(document.body.style.cursor).toBe("default");

    // The mouseup happened outside the window, so no mouseup event was ever
    // dispatched; the next mousemove back inside the window reports buttons
    // === 0, which is the only signal this recovery path has to go on.
    window.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, cancelable: true, buttons: 0, clientY: 50 }),
    );

    expect(overlayContainer!.classList.contains("cm-minimap-overlay-active")).toBe(false);
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
    expect(document.body.style.webkitUserSelect).toBe("");
  });

  it("prevents default on a mousemove following a mousedown on the container (not just the indicator)", () => {
    const container = mount(true);
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container");
    expect(overlayContainer).not.toBeNull();

    // Mousedown lands on the container itself (the canvas/track), not the
    // inner .cm-minimap-overlay indicator rectangle.
    overlayContainer!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));

    const moveEvent = new MouseEvent("mousemove", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      clientY: 50,
    });
    window.dispatchEvent(moveEvent);
    expect(moveEvent.defaultPrevented).toBe(true);

    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
  });

  it("clears the cursor when the view is destroyed mid-drag", () => {
    const container = mount(true);
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container");
    expect(overlayContainer).not.toBeNull();

    overlayContainer!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(document.body.style.cursor).toBe("default");

    view?.destroy();
    view = undefined;
    expect(document.body.style.cursor).toBe("");
  });

  it("keeps the jumped-to scroll position across the first pointer move of a drag", () => {
    const container = mount(true);
    const g = fakeGeometry(container);
    g.indicator.style.top = "0px";

    // Click three quarters of the way down the minimap track.
    g.overlayContainer.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientY: 400 }),
    );
    const afterJump = g.read();
    expect(afterJump).toBeGreaterThan(0);

    // Nudge the pointer 2px, as any real click-and-drag does.
    window.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, cancelable: true, buttons: 1, clientY: 402 }),
    );
    const afterNudge = g.read();

    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));

    // A 2px nudge must not move the document by more than a few percent of the viewport.
    expect(Math.abs(afterNudge - afterJump)).toBeLessThan(100);
  });

  it("leaves a right-click on the container untouched", () => {
    const container = mount(true);
    const g = fakeGeometry(container);

    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2, clientY: 400 });
    g.overlayContainer.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.body.style.cursor).toBe("");
    expect(g.overlayContainer.classList.contains("cm-minimap-overlay-active")).toBe(false);
    expect(g.read()).toBe(0);
  });

  it("only performs the click-to-jump scroll write for a canvas click, not a mousedown on the indicator", () => {
    const container = mount(true);
    const g = fakeGeometry(container);

    g.indicator.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientY: 400 }),
    );
    expect(g.read()).toBe(0);
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));

    g.overlayContainer.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientY: 400 }),
    );
    expect(g.read()).toBeGreaterThan(0);
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
  });

  // The cases below cover the contentEditable lifecycle added to defeat
  // WebKit's -webkit-user-modify exemption (see the vendored patch's
  // _restoreEditability doc comment for the mechanism). jsdom has no
  // selection engine and doesn't implement WebKit's effectiveUserSelect, or
  // WebKit's blur-on-loss-of-editability, at all — it still reports
  // `hasFocus === true` with `contenteditable="false"` — so these can only
  // prove the DOM attribute (and, where noted, the view.focus() call) are
  // toggled and restored at the right moments, never that a real WebKit
  // build actually stops selecting text, shows the right cursor, or keeps
  // the caret visible. That can only be confirmed by hand against the
  // packaged app.

  /** Simulates the pointer being over `el` when a mousemove fires, by dispatching from `el` so it bubbles to `window` with `event.target === el` — matching how a real browser sets `target` from hit-testing, which `window.dispatchEvent(...)` alone cannot reproduce (its `target` would be `window` itself). */
  function moveFrom(el: Element, opts: Partial<MouseEventInit> = {}) {
    el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, buttons: 1, clientY: 50, ...opts }));
  }

  it("defers clearing contentEditable until the drag leaves the minimap, then restores it on mouseup", () => {
    const container = mount(true);
    const content = container.querySelector(".cm-content") as HTMLElement;
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container") as HTMLElement;
    expect(overlayContainer).not.toBeNull();
    expect(content.getAttribute("contenteditable")).toBe("true");

    overlayContainer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    // Mousedown alone must never blur the editor — only a drag that
    // actually reaches outside the minimap needs the guard.
    expect(content.getAttribute("contenteditable")).toBe("true");

    moveFrom(content);
    expect(content.getAttribute("contenteditable")).toBe("false");

    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    expect(content.getAttribute("contenteditable")).toBe("true");
  });

  it("never clears contentEditable for a click-to-jump or a drag that stays on the minimap track", () => {
    const container = mount(true);
    const content = container.querySelector(".cm-content") as HTMLElement;
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container") as HTMLElement;

    overlayContainer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    moveFrom(overlayContainer, { clientY: 60 });
    expect(content.getAttribute("contenteditable")).toBe("true");

    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    expect(content.getAttribute("contenteditable")).toBe("true");
  });

  it("restores contentEditable via the off-window self-heal path", () => {
    const container = mount(true);
    const content = container.querySelector(".cm-content") as HTMLElement;
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container") as HTMLElement;

    overlayContainer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    moveFrom(content);
    expect(content.getAttribute("contenteditable")).toBe("false");

    // The mouseup happened outside the window, so no mouseup event was ever
    // dispatched; the next mousemove back inside the window reports buttons
    // === 0, which is the only signal this recovery path has to go on.
    window.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, cancelable: true, buttons: 0, clientY: 50 }),
    );
    expect(content.getAttribute("contenteditable")).toBe("true");
  });

  it("restores contentEditable and cursor on a window blur mid-drag", () => {
    const container = mount(true);
    const content = container.querySelector(".cm-content") as HTMLElement;
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container") as HTMLElement;

    overlayContainer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    moveFrom(content);
    expect(content.getAttribute("contenteditable")).toBe("false");
    expect(document.body.style.cursor).toBe("default");

    // A mid-drag Cmd-Tab / Space switch / native context menu blurs the
    // window; the in-window self-heal above never fires because an
    // inactive window gets no mousemove at all — this is the recovery path
    // that case needs instead.
    window.dispatchEvent(new Event("blur"));

    expect(content.getAttribute("contenteditable")).toBe("true");
    expect(document.body.style.cursor).toBe("");
    expect(overlayContainer.classList.contains("cm-minimap-overlay-active")).toBe(false);
  });

  it("recovers from a mousedown arriving while a drag is still latched, restoring contentEditable too", () => {
    const container = mount(true);
    const content = container.querySelector(".cm-content") as HTMLElement;
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container") as HTMLElement;

    // The first drag leaves the minimap (clearing contentEditable) but its
    // mouseup is never delivered — e.g. released outside the window before
    // any self-heal move was observed.
    overlayContainer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    moveFrom(content);
    expect(content.getAttribute("contenteditable")).toBe("false");

    // A fresh mousedown arrives while that stale drag is still latched.
    overlayContainer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));

    expect(content.getAttribute("contenteditable")).toBe("true");
  });

  // The case above passes even with the re-entrancy guard deleted, because
  // once contentEditable clearing is deferred to onMouseMove (see the
  // "defers clearing" case), nothing in onMouseDown touches _wasEditable
  // any more — so it can't be re-captured from a stale, already-false DOM
  // the way it could before. What the guard actually still protects is the
  // *indicator's on-screen position*: computeTop() is gated on
  // `!this._isDragging`, and without the guard resetting `_isDragging` to
  // false first, a re-entrant click-to-jump's computeTop() call silently
  // no-ops, leaving the indicator drawn at the stale, first drag's position
  // even though the scroll position itself did jump to the new one.
  it("recovers from a mousedown arriving while a drag is still latched, re-anchoring the indicator to the new position", () => {
    const container = mount(true);
    const g = fakeGeometry(container);

    // First drag: click near the top. Its mouseup is never delivered.
    g.overlayContainer.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientY: 50 }),
    );
    const topAfterFirstJump = g.indicator.style.top;

    // A fresh mousedown arrives, clicking near the bottom instead, while
    // the stale first drag is still latched.
    g.overlayContainer.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientY: 450 }),
    );
    const topAfterSecondJump = g.indicator.style.top;

    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));

    expect(topAfterSecondJump).not.toBe(topAfterFirstJump);
  });

  it("clears and restores contentEditable independently across two separate, fully-completed drags", () => {
    const container = mount(true);
    const content = container.querySelector(".cm-content") as HTMLElement;
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container") as HTMLElement;

    // Deleting the _editableToggled reset in _restoreEditability() would
    // leave every drag after the first silently unable to clear
    // contentEditable again — this exercises drag 2, not just drag 1.
    for (let i = 0; i < 2; i++) {
      overlayContainer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      expect(content.getAttribute("contenteditable"), `drag ${i + 1}: mousedown alone must not blur`).toBe("true");

      moveFrom(content);
      expect(content.getAttribute("contenteditable"), `drag ${i + 1}: should clear once outside the minimap`).toBe(
        "false",
      );

      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
      expect(content.getAttribute("contenteditable"), `drag ${i + 1}: should restore on mouseup`).toBe("true");
    }
  });

  it("restores contentEditable immediately on a keydown mid-drag, without ending the drag", () => {
    const container = mount(true);
    const content = container.querySelector(".cm-content") as HTMLElement;
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container") as HTMLElement;

    overlayContainer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    moveFrom(content);
    expect(content.getAttribute("contenteditable")).toBe("false");
    expect(overlayContainer.classList.contains("cm-minimap-overlay-active")).toBe(true);

    // Doesn't rescue this exact keystroke (see onKeyDown's doc comment),
    // but restores editability and focus before the next one, so typing
    // resumes rather than staying silently stuck for the rest of the drag.
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "a" }));
    expect(content.getAttribute("contenteditable")).toBe("true");

    // The drag itself keeps running: a stray keystroke isn't a mouseup.
    expect(overlayContainer.classList.contains("cm-minimap-overlay-active")).toBe(true);
    expect(document.body.style.cursor).toBe("default");

    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    expect(overlayContainer.classList.contains("cm-minimap-overlay-active")).toBe(false);
  });

  it("ignores a bare modifier keydown mid-drag, leaving contentEditable cleared", () => {
    const container = mount(true);
    const content = container.querySelector(".cm-content") as HTMLElement;
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container") as HTMLElement;

    overlayContainer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    moveFrom(content);
    expect(content.getAttribute("contenteditable")).toBe("false");

    for (const key of ["Shift", "Control", "Alt", "Meta"]) {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
      expect(content.getAttribute("contenteditable"), `expected ${key} to be ignored`).toBe("false");
    }

    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    expect(content.getAttribute("contenteditable")).toBe("true");
  });

  it("restores contentEditable when the view is destroyed mid-drag", () => {
    const container = mount(true);
    const content = container.querySelector(".cm-content") as HTMLElement;
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container") as HTMLElement;

    overlayContainer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    moveFrom(content);
    expect(content.getAttribute("contenteditable")).toBe("false");

    view?.destroy();
    view = undefined;
    expect(content.getAttribute("contenteditable")).toBe("true");
  });

  it("leaves a non-editable editor's contentEditable untouched by a minimap drag", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    mountedContainer = container;
    view = new EditorView({
      state: EditorState.create({
        doc: "line one\nline two\nline three\n",
        extensions: [minimapExtension(true), EditorView.editable.of(false)],
      }),
      parent: container,
    });
    const content = container.querySelector(".cm-content") as HTMLElement;
    expect(content.getAttribute("contenteditable")).toBe("false");

    const overlayContainer = container.querySelector(".cm-minimap-overlay-container") as HTMLElement;
    expect(overlayContainer).not.toBeNull();

    overlayContainer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    moveFrom(content);
    expect(content.getAttribute("contenteditable")).toBe("false");

    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    expect(content.getAttribute("contenteditable")).toBe("false");
  });

  it("unconditionally blanks body cursor/user-select on drag end, regardless of any pre-existing value", () => {
    // "Restore whatever was there before" sounds more correct than blanking
    // — it isn't, once there can be more than one minimap instance (one per
    // pane in a split editor) sharing this single global resource. Each
    // instance would capture/restore independently; if any one instance's
    // drag ends without its own matching capture ever landing (e.g. a
    // stale, still-latched drag on another pane — see the two re-entrancy
    // cases above for how a drag can go stale), the wrong "previous" value
    // gets written back and then perpetuated by every drag after it,
    // leaving body stuck at cursor:default/user-select:none with no
    // recovery short of a reload. Blanking is the only pairing that's
    // correct no matter how many instances exist.
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "text";
    document.body.style.webkitUserSelect = "text";

    const container = mount(true);
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container") as HTMLElement;

    overlayContainer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(document.body.style.cursor).toBe("default");

    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
    expect(document.body.style.webkitUserSelect).toBe("");
  });

  it("split editor: a stale drag on one minimap instance doesn't leave a second instance's restore stuck", () => {
    // Two independent editor panes, each with its own OverlayView, both
    // listening on the same window-level mouseup/mousemove. Reproduces the
    // exact scenario "restore the prior value" broke: pane A's drag starts
    // (setting the shared body cursor/user-select) but its mouseup never
    // arrives — release outside the window, no self-heal move first — so
    // it's still latched when pane B starts and completes its own,
    // entirely unrelated drag.
    const containerA = mount(true);
    const overlayA = containerA.querySelector(".cm-minimap-overlay-container") as HTMLElement;

    const containerB = document.createElement("div");
    document.body.appendChild(containerB);
    const viewB = new EditorView({
      state: EditorState.create({ doc: "b\n", extensions: minimapExtension(true) }),
      parent: containerB,
    });
    const overlayB = containerB.querySelector(".cm-minimap-overlay-container") as HTMLElement;

    try {
      overlayA.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      expect(document.body.style.cursor).toBe("default");

      overlayB.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      // The one mouseup in this whole sequence: dispatched once on window,
      // received by both instances' listeners (pane A's fires first, pane
      // B's second, matching creation order) — this is what a real release
      // during pane B's drag looks like from either instance's perspective.
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));

      // Pane B's own drag ending must leave body clean, regardless of
      // pane A's drag never having ended on its own.
      expect(document.body.style.cursor).toBe("");
      expect(document.body.style.userSelect).toBe("");
      expect(document.body.style.webkitUserSelect).toBe("");
    } finally {
      viewB.destroy();
      containerB.remove();
    }
  });

  it("split editor: dragging one pane's minimap into a DIFFERENT pane's content clears THAT pane's contentEditable too", () => {
    // This is #320 itself, reproduced in a split editor: the fix only
    // neutralized the DRAGGING view's own contentEditable, so dragging
    // pane A's minimap rightward into pane B's text left pane B's
    // `.cm-content` fully editable the whole time — WebKit's exemption
    // still applied there, so the original selection/cursor bug happened
    // in full, in pane B, even though the fix worked perfectly for pane A.
    // A minimap drag is a single global mouse gesture; the pointer can end
    // up over ANY pane's content, not just the one whose minimap started
    // the drag.
    const containerA = mount(true);
    const overlayA = containerA.querySelector(".cm-minimap-overlay-container") as HTMLElement;
    const contentA = containerA.querySelector(".cm-content") as HTMLElement;

    const containerB = document.createElement("div");
    document.body.appendChild(containerB);
    const viewB = new EditorView({
      state: EditorState.create({ doc: "b\n", extensions: minimapExtension(true) }),
      parent: containerB,
    });
    const contentB = containerB.querySelector(".cm-content") as HTMLElement;

    try {
      expect(contentB.getAttribute("contenteditable")).toBe("true");

      // Drag starts on pane A's minimap; the pointer crosses into pane B's
      // content, not pane A's own.
      overlayA.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      moveFrom(contentB);

      // Pane B's content — not the one whose minimap is being dragged —
      // must be neutralized too.
      expect(contentB.getAttribute("contenteditable")).toBe("false");
      // Pane A's own content is suppressed as well: the pointer could end
      // up back over it later in the same drag, and there's no cheap way
      // to know in advance which panes it will and won't cross.
      expect(contentA.getAttribute("contenteditable")).toBe("false");

      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
      expect(contentB.getAttribute("contenteditable")).toBe("true");
      expect(contentA.getAttribute("contenteditable")).toBe("true");
    } finally {
      viewB.destroy();
      containerB.remove();
    }
  });

  it("does not blank body cursor/user-select on an unrelated mouseup with no drag ever active", () => {
    // _endDrag()'s `if (!this._isDragging) return` guard is what stops
    // this: onMouseUp/the blur listener are registered globally by every
    // open pane's OverlayView and fire on every mouseup/blur in the whole
    // app, drag or not. Without the guard, an ordinary click anywhere
    // would unconditionally wipe out any cursor/user-select some other
    // feature had legitimately set.
    document.body.style.cursor = "some-other-feature-set-this";
    mount(true);

    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));

    expect(document.body.style.cursor).toBe("some-other-feature-set-this");
  });

  it("keeps contentEditable restored after a keydown, even across a further mousemove outside the minimap in the same drag", () => {
    // Restoring on keydown isn't enough on its own: mousemove keeps firing
    // as the drag continues, and without cancelling suppression for the
    // rest of this drag, the very next outside-the-minimap mousemove
    // (which fires far more often than keydowns in real usage) would
    // immediately re-clear contentEditable again — silently defeating the
    // escape hatch for every keystroke after the first, even though the
    // restore itself looks correct in isolation right after the keydown.
    const container = mount(true);
    const content = container.querySelector(".cm-content") as HTMLElement;
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container") as HTMLElement;

    overlayContainer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    moveFrom(content);
    expect(content.getAttribute("contenteditable")).toBe("false");

    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "a" }));
    expect(content.getAttribute("contenteditable")).toBe("true");

    moveFrom(content, { clientY: 60 });
    expect(content.getAttribute("contenteditable")).toBe("true");

    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
  });

  it("calls view.focus() on restore only when the view was focused going into the drag", () => {
    const container = mount(true);
    const content = container.querySelector(".cm-content") as HTMLElement;
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container") as HTMLElement;
    content.focus();
    expect(view!.hasFocus).toBe(true);
    const focusSpy = vi.spyOn(view!, "focus");

    overlayContainer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    moveFrom(content);
    expect(content.getAttribute("contenteditable")).toBe("false");

    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    expect(focusSpy).toHaveBeenCalled();
  });

  it("does not call view.focus() on restore when the view wasn't focused going into the drag", () => {
    const container = mount(true);
    const content = container.querySelector(".cm-content") as HTMLElement;
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container") as HTMLElement;
    // Deliberately not focused: content.focus() is never called.
    const focusSpy = vi.spyOn(view!, "focus");

    overlayContainer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    moveFrom(content);
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));

    expect(focusSpy).not.toHaveBeenCalled();
  });
});
