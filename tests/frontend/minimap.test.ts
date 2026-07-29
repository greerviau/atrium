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
  // Belt-and-suspenders: view?.destroy() above should already have run
  // _endDrag() and removed this if a test left a drag mid-flight, but a
  // leaked class here would silently corrupt every dispatchSelectStart()
  // baseline in whichever test runs next, so reset it unconditionally too.
  document.body.classList.remove("cm-minimap-dragging-active");
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

  // The cases below cover the selectstart/cursor-class mechanism that
  // replaced the contentEditable-toggling approach: see DRAGGING_CLASS and
  // preventSelectStart's doc comments in the vendored patch for why. jsdom
  // has no selection engine, so it cannot prove a selectstart it lets
  // through would actually have started a WebKit selection, or that the
  // `!important` cursor class actually wins the same way it does for
  // tableHandles.ts's proven table-drag precedent — these can only prove
  // the class and the listener are engaged and torn down at the right
  // moments. That can only be confirmed by hand against the packaged app.

  /** A selectstart event dispatched from `target`, bubbling to the document-level listener the same way a real WebKit-initiated selection would. Returns whether it was prevented. */
  function dispatchSelectStart(target: EventTarget = document): boolean {
    const event = new Event("selectstart", { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }

  const DRAGGING_CLASS = "cm-minimap-dragging-active";

  it("adds the cursor-forcing body class and the selectstart guard on mousedown", () => {
    const container = mount(true);
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container") as HTMLElement;

    expect(document.body.classList.contains(DRAGGING_CLASS)).toBe(false);
    expect(dispatchSelectStart()).toBe(false);

    overlayContainer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));

    expect(document.body.classList.contains(DRAGGING_CLASS)).toBe(true);
    expect(dispatchSelectStart()).toBe(true);

    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
  });

  it("removes the cursor-forcing body class and the selectstart guard on mouseup", () => {
    const container = mount(true);
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container") as HTMLElement;

    overlayContainer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(document.body.classList.contains(DRAGGING_CLASS)).toBe(true);
    expect(dispatchSelectStart()).toBe(true);

    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));

    expect(document.body.classList.contains(DRAGGING_CLASS)).toBe(false);
    expect(dispatchSelectStart()).toBe(false);
  });

  it("removes the cursor class and selectstart guard via the off-window self-heal path", () => {
    const container = mount(true);
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container") as HTMLElement;

    overlayContainer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(document.body.classList.contains(DRAGGING_CLASS)).toBe(true);

    // The mouseup happened outside the window, so no mouseup event was ever
    // dispatched; the next mousemove back inside the window reports buttons
    // === 0, which is the only signal this recovery path has to go on.
    window.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, cancelable: true, buttons: 0, clientY: 50 }),
    );

    expect(document.body.classList.contains(DRAGGING_CLASS)).toBe(false);
    expect(dispatchSelectStart()).toBe(false);
  });

  it("removes the cursor class and selectstart guard on a window blur mid-drag", () => {
    const container = mount(true);
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container") as HTMLElement;

    overlayContainer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(document.body.classList.contains(DRAGGING_CLASS)).toBe(true);

    // A mid-drag Cmd-Tab / Space switch / native context menu blurs the
    // window; the in-window self-heal above never fires because an
    // inactive window gets no mousemove at all — this is the recovery path
    // that case needs instead.
    window.dispatchEvent(new Event("blur"));

    expect(document.body.classList.contains(DRAGGING_CLASS)).toBe(false);
    expect(dispatchSelectStart()).toBe(false);
    expect(overlayContainer.classList.contains("cm-minimap-overlay-active")).toBe(false);
  });

  it("removes the cursor class and selectstart guard when the view is destroyed mid-drag", () => {
    const container = mount(true);
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container") as HTMLElement;

    overlayContainer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(document.body.classList.contains(DRAGGING_CLASS)).toBe(true);

    view?.destroy();
    view = undefined;

    expect(document.body.classList.contains(DRAGGING_CLASS)).toBe(false);
    expect(dispatchSelectStart()).toBe(false);
  });

  it("removes the cursor class and selectstart guard when a stale drag is superseded by a fresh mousedown", () => {
    const container = mount(true);
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container") as HTMLElement;

    // The first drag's mouseup is never delivered — e.g. released outside
    // the window before any self-heal move was observed.
    overlayContainer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(document.body.classList.contains(DRAGGING_CLASS)).toBe(true);

    // A fresh mousedown arrives while that stale drag is still latched.
    overlayContainer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    // Still true: the fresh drag re-engages both immediately.
    expect(document.body.classList.contains(DRAGGING_CLASS)).toBe(true);
    expect(dispatchSelectStart()).toBe(true);

    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    expect(document.body.classList.contains(DRAGGING_CLASS)).toBe(false);
    expect(dispatchSelectStart()).toBe(false);
  });

  // computeTop() is gated on `!this._isDragging`, which the re-entrancy
  // guard above resets before a fresh drag begins. Without that guard, a
  // re-entrant click-to-jump's computeTop() call would silently no-op,
  // leaving the indicator drawn at the stale, first drag's position even
  // though the scroll position itself did jump to the new one — unrelated
  // to the cursor/selectstart mechanism, but the same guard serves both.
  it("re-anchors the indicator to the new position when a stale drag is superseded by a fresh mousedown", () => {
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

  it("does not add the cursor class or the selectstart guard for a right-click", () => {
    const container = mount(true);
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container") as HTMLElement;

    overlayContainer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2 }));

    expect(document.body.classList.contains(DRAGGING_CLASS)).toBe(false);
    expect(dispatchSelectStart()).toBe(false);
  });

  it("does not disturb an unrelated mouseup's cursor/user-select with no drag ever active", () => {
    // _endDrag()'s `if (!this._isDragging) return` guard is what stops
    // this: onMouseUp/the blur listener are registered globally by every
    // open pane's OverlayView and fire on every mouseup/blur in the whole
    // app, drag or not. The class/listener removals are harmless no-ops
    // either way, but the inline `document.body.style.cursor` clear is
    // not — without the guard, an ordinary click anywhere would
    // unconditionally wipe out any cursor/user-select some other feature
    // had legitimately set via the same inline-style mechanism.
    document.body.style.cursor = "some-other-feature-set-this";
    mount(true);

    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));

    expect(document.body.style.cursor).toBe("some-other-feature-set-this");
  });

  it("split editor: the selectstart guard and cursor class engage document-wide from either pane's minimap, not just the dragging one", () => {
    // This is #320 itself, reproduced in a split editor: a per-view
    // mechanism (the contentEditable-toggling approach this replaced)
    // needed to know which OTHER views to touch, and a prior version of
    // this fix got that registry wrong — tracking panes with a minimap
    // rather than panes that are editable, so a code-plus-markdown split
    // still reproduced the bug in the markdown pane specifically. A
    // document-level selectstart listener and a body-level CSS class have
    // no such distinction to get wrong: engaging either from ANY pane's
    // minimap protects every pane, including ones with no minimap of
    // their own at all, which is exactly the code-plus-markdown case.
    const containerA = mount(true);
    const overlayA = containerA.querySelector(".cm-minimap-overlay-container") as HTMLElement;
    const contentA = containerA.querySelector(".cm-content") as HTMLElement;

    // Pane B has no minimap of its own (mirrors a markdown pane, which
    // never gets one — see EditorPane.svelte:149) — no OverlayView, no
    // .cm-minimap-overlay-container, nothing pane-specific to suppress it.
    const containerB = document.createElement("div");
    document.body.appendChild(containerB);
    const viewB = new EditorView({
      state: EditorState.create({ doc: "b\n", extensions: minimapExtension(false) }),
      parent: containerB,
    });
    const contentB = containerB.querySelector(".cm-content") as HTMLElement;

    try {
      // Pinning the premise this test depends on: pane B genuinely has no
      // minimap of its own. Querying from contentB here would be vacuous —
      // the overlay container is a DOM SIBLING of .cm-content, never a
      // descendant of it (see minimapClass's own create(), which inserts
      // the gutter via view.scrollDOM.insertBefore(..., contentDOM.nextSibling)),
      // so `contentB.querySelector(...)` is null regardless of whether B
      // has a minimap at all. Querying from containerB (the pane's own
      // root) is what actually distinguishes the two cases.
      expect(containerB.querySelector(".cm-minimap-overlay-container")).toBeNull();
      expect(dispatchSelectStart(contentB)).toBe(false);

      // Drag starts on pane A's minimap; the pointer crosses into pane B's
      // content, not pane A's own.
      overlayA.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));

      // Selection is prevented over pane B specifically, and pane A's own
      // content, and the cursor class covers both since it's on body.
      expect(dispatchSelectStart(contentB)).toBe(true);
      expect(dispatchSelectStart(contentA)).toBe(true);
      expect(document.body.classList.contains(DRAGGING_CLASS)).toBe(true);

      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
      expect(dispatchSelectStart(contentB)).toBe(false);
      expect(dispatchSelectStart(contentA)).toBe(false);
    } finally {
      viewB.destroy();
      containerB.remove();
    }
  });

  it("split editor: a stale drag on one minimap instance doesn't leave a second instance's restore stuck", () => {
    // Two independent editor panes, each with its own OverlayView, both
    // listening on the same window-level mouseup/mousemove. Pane A's drag
    // starts (setting the shared body cursor/user-select) but its mouseup
    // never arrives — release outside the window, no self-heal move first
    // — so it's still latched when pane B starts and completes its own,
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
      expect(document.body.classList.contains(DRAGGING_CLASS)).toBe(false);
      expect(dispatchSelectStart()).toBe(false);
    } finally {
      viewB.destroy();
      containerB.remove();
    }
  });
});
