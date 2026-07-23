import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import EditorPane from "../../src/lib/editor/EditorPane.svelte";
import { tabsState, type Tab } from "../../src/lib/stores/tabs";

function seedTab(tab: Tab): void {
  tabsState.set({ tabs: [tab], activeTabPath: tab.path });
}

describe("EditorPane: line wrapping by file type", () => {
  afterEach(() => {
    cleanup();
    tabsState.set({ tabs: [], activeTabPath: null });
  });

  it("does not wrap long lines in a code-mode pane", () => {
    seedTab({
      path: "/example.py",
      mode: "code",
      savedDoc: "x = 1\n",
      isDirty: false,
      hasExternalConflict: false,
    });
    const { container } = render(EditorPane, { filePath: "/example.py", paneId: "pane-1" });

    expect(container.querySelector(".cm-content")?.classList.contains("cm-lineWrapping")).toBe(false);
  });

  it("wraps long lines in a markdown-mode pane, in both rendered and source view", () => {
    seedTab({
      path: "/notes.md",
      mode: "markdown",
      savedDoc: "some prose\n",
      isDirty: false,
      hasExternalConflict: false,
      viewMode: "rendered",
    });
    const rendered = render(EditorPane, { filePath: "/notes.md", paneId: "pane-1" });
    expect(rendered.container.querySelector(".cm-content")?.classList.contains("cm-lineWrapping")).toBe(true);
    cleanup();

    seedTab({
      path: "/notes.md",
      mode: "markdown",
      savedDoc: "some prose\n",
      isDirty: false,
      hasExternalConflict: false,
      viewMode: "source",
    });
    const source = render(EditorPane, { filePath: "/notes.md", paneId: "pane-1" });
    expect(source.container.querySelector(".cm-content")?.classList.contains("cm-lineWrapping")).toBe(true);
  });
});

describe("EditorPane: scrollbar auto-hide", () => {
  afterEach(() => {
    cleanup();
    tabsState.set({ tabs: [], activeTabPath: null });
  });

  it("adds scrollbar-autohide to the CodeMirror scroller once mounted", () => {
    seedTab({
      path: "/example.py",
      mode: "code",
      savedDoc: "x = 1\n",
      isDirty: false,
      hasExternalConflict: false,
    });
    const { container } = render(EditorPane, { filePath: "/example.py", paneId: "pane-1" });

    expect(container.querySelector(".cm-scroller")?.classList.contains("scrollbar-autohide")).toBe(true);
  });
});
