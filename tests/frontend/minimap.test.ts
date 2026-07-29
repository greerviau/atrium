import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { minimapExtension } from "../../src/lib/editor/minimap";

let view: EditorView | undefined;

afterEach(() => {
  view?.destroy();
  view = undefined;
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  document.body.style.webkitUserSelect = "";
});

function mount(enabled: boolean): HTMLElement {
  const container = document.createElement("div");
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
  // selection engine and doesn't implement WebKit's effectiveUserSelect at
  // all, so these can only prove the DOM attribute is toggled and restored
  // at the right moments — not that a real WebKit build actually stops
  // selecting text or shows the right cursor. That can only be confirmed by
  // hand against the packaged app.

  it("disables contentEditable on the content DOM for the duration of a drag, and restores it on mouseup", () => {
    const container = mount(true);
    const content = container.querySelector(".cm-content") as HTMLElement;
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container");
    expect(overlayContainer).not.toBeNull();
    expect(content.getAttribute("contenteditable")).toBe("true");

    overlayContainer!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(content.getAttribute("contenteditable")).toBe("false");

    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    expect(content.getAttribute("contenteditable")).toBe("true");
  });

  it("restores contentEditable via the off-window self-heal path", () => {
    const container = mount(true);
    const content = container.querySelector(".cm-content") as HTMLElement;
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container");
    expect(overlayContainer).not.toBeNull();

    overlayContainer!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(content.getAttribute("contenteditable")).toBe("false");

    window.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, cancelable: true, buttons: 0, clientY: 50 }),
    );
    expect(content.getAttribute("contenteditable")).toBe("true");
  });

  it("restores contentEditable when the view is destroyed mid-drag", () => {
    const container = mount(true);
    const content = container.querySelector(".cm-content") as HTMLElement;
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container");
    expect(overlayContainer).not.toBeNull();

    overlayContainer!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(content.getAttribute("contenteditable")).toBe("false");

    view?.destroy();
    view = undefined;
    expect(content.getAttribute("contenteditable")).toBe("true");
  });

  it("restores contentEditable immediately on a keydown mid-drag, without ending the drag", () => {
    const container = mount(true);
    const content = container.querySelector(".cm-content") as HTMLElement;
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container");
    expect(overlayContainer).not.toBeNull();

    overlayContainer!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(content.getAttribute("contenteditable")).toBe("false");
    expect(overlayContainer!.classList.contains("cm-minimap-overlay-active")).toBe(true);

    // A keystroke landing mid-drag must never be silently dropped — the
    // content DOM regains editability before this event's own default
    // action (native text insertion) would otherwise run against it.
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "a" }));
    expect(content.getAttribute("contenteditable")).toBe("true");

    // The drag itself keeps running: a stray keystroke isn't a mouseup.
    expect(overlayContainer!.classList.contains("cm-minimap-overlay-active")).toBe(true);
    expect(document.body.style.cursor).toBe("default");

    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    expect(overlayContainer!.classList.contains("cm-minimap-overlay-active")).toBe(false);
  });

  it("leaves a non-editable editor's contentEditable untouched by a minimap drag", () => {
    const container = document.createElement("div");
    view = new EditorView({
      state: EditorState.create({
        doc: "line one\nline two\nline three\n",
        extensions: [minimapExtension(true), EditorView.editable.of(false)],
      }),
      parent: container,
    });
    const content = container.querySelector(".cm-content") as HTMLElement;
    expect(content.getAttribute("contenteditable")).toBe("false");

    const overlayContainer = container.querySelector(".cm-minimap-overlay-container");
    expect(overlayContainer).not.toBeNull();

    overlayContainer!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(content.getAttribute("contenteditable")).toBe("false");

    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    expect(content.getAttribute("contenteditable")).toBe("false");
  });
});
