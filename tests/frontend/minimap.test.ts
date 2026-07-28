import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { minimapExtension } from "../../src/lib/editor/minimap";

let view: EditorView | undefined;

afterEach(() => {
  view?.destroy();
  view = undefined;
  document.body.style.cursor = "";
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

  it("pins the cursor to default on a container mousedown and clears it on mouseup", () => {
    const container = mount(true);
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container");
    expect(overlayContainer).not.toBeNull();

    overlayContainer!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(document.body.style.cursor).toBe("default");

    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    expect(document.body.style.cursor).toBe("");
  });

  it("prevents default on a mousemove following a mousedown on the container (not just the indicator)", () => {
    const container = mount(true);
    const overlayContainer = container.querySelector(".cm-minimap-overlay-container");
    expect(overlayContainer).not.toBeNull();

    // Mousedown lands on the container itself (the canvas/track), not the
    // inner .cm-minimap-overlay indicator rectangle.
    overlayContainer!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));

    const moveEvent = new MouseEvent("mousemove", { bubbles: true, cancelable: true, button: 0, clientY: 50 });
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
});
