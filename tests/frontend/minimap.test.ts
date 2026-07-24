import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { minimapExtension } from "../../src/lib/editor/minimap";

let view: EditorView | undefined;

afterEach(() => {
  view?.destroy();
  view = undefined;
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

  it("takes the gutter out of flow with an absolute, top-right-anchored panel", () => {
    mount(true);
    const css = allStyleText();
    const gutterRule = css.split("\n").find((line) => line.includes(".cm-minimap-gutter") && line.includes("position: absolute"));
    expect(gutterRule, `expected a .cm-minimap-gutter rule with position: absolute, got:\n${css}`).toBeDefined();
    expect(gutterRule).toContain("position: absolute");
    expect(gutterRule).not.toContain("position: sticky");
    expect(gutterRule).toContain("top: 8px");
    expect(gutterRule).toContain("right: 8px");
  });

  it("gives the panel floating chrome matching the app's other floating panels", () => {
    mount(true);
    const css = allStyleText();
    const gutterRule = css.split("\n").find((line) => line.includes(".cm-minimap-gutter") && line.includes("position: absolute"));
    expect(gutterRule).toBeDefined();
    expect(gutterRule).toContain("border-radius: 6px");
    expect(gutterRule).toContain("box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3)");
    expect(gutterRule).toContain("var(--atrium-border)");
  });
});
