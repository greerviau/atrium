import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import EditorPane from "../../src/lib/editor/EditorPane.svelte";
import { tabsState, type Tab } from "../../src/lib/stores/tabs";
import { wordWrapEnabled, setWordWrapEnabled, DEFAULT_WORD_WRAP_ENABLED } from "../../src/lib/stores/wordWrap";

function seedTab(tab: Tab): void {
  tabsState.set({ tabs: [tab], activeTabPath: tab.path });
}

describe("EditorPane: line wrapping by file type", () => {
  beforeEach(() => {
    wordWrapEnabled.set(DEFAULT_WORD_WRAP_ENABLED);
  });

  afterEach(() => {
    cleanup();
    tabsState.set({ tabs: [], activeTabPath: null });
    wordWrapEnabled.set(DEFAULT_WORD_WRAP_ENABLED);
  });

  it("does not wrap long lines in a code-mode pane by default (wordWrapEnabled off)", () => {
    seedTab({
      path: "/example.py", workspaceId: "local",
      mode: "code",
      savedDoc: "x = 1\n",
      isDirty: false,
      hasExternalConflict: false,
      isExternal: false,
      isDeleted: false,
    });
    const { container } = render(EditorPane, { filePath: "/example.py", paneId: "pane-1" });

    expect(container.querySelector(".cm-content")?.classList.contains("cm-lineWrapping")).toBe(false);
  });

  it("wraps long lines in a code-mode pane when wordWrapEnabled is true at mount", () => {
    setWordWrapEnabled(true);
    seedTab({
      path: "/example.py", workspaceId: "local",
      mode: "code",
      savedDoc: "x = 1\n",
      isDirty: false,
      hasExternalConflict: false,
      isExternal: false,
      isDeleted: false,
    });
    const { container } = render(EditorPane, { filePath: "/example.py", paneId: "pane-1" });

    expect(container.querySelector(".cm-content")?.classList.contains("cm-lineWrapping")).toBe(true);
  });

  it("reconfigures word wrap live in a code-mode pane when the setting toggles after mount", async () => {
    seedTab({
      path: "/example.py", workspaceId: "local",
      mode: "code",
      savedDoc: "x = 1\n",
      isDirty: false,
      hasExternalConflict: false,
      isExternal: false,
      isDeleted: false,
    });
    const { container } = render(EditorPane, { filePath: "/example.py", paneId: "pane-1" });
    expect(container.querySelector(".cm-content")?.classList.contains("cm-lineWrapping")).toBe(false);

    setWordWrapEnabled(true);
    await tick();

    expect(container.querySelector(".cm-content")?.classList.contains("cm-lineWrapping")).toBe(true);

    setWordWrapEnabled(false);
    await tick();

    expect(container.querySelector(".cm-content")?.classList.contains("cm-lineWrapping")).toBe(false);
  });

  it("wraps long lines in a markdown-mode pane, in both rendered and source view, regardless of the wordWrapEnabled setting", async () => {
    for (const wrapSetting of [false, true]) {
      setWordWrapEnabled(wrapSetting);

      seedTab({
        path: "/notes.md", workspaceId: "local",
        mode: "markdown",
        savedDoc: "some prose\n",
        isDirty: false,
        hasExternalConflict: false,
        isExternal: false,
        isDeleted: false,
        viewMode: "rendered",
      });
      const rendered = render(EditorPane, { filePath: "/notes.md", paneId: "pane-1" });
      expect(rendered.container.querySelector(".cm-content")?.classList.contains("cm-lineWrapping")).toBe(true);
      cleanup();

      seedTab({
        path: "/notes.md", workspaceId: "local",
        mode: "markdown",
        savedDoc: "some prose\n",
        isDirty: false,
        hasExternalConflict: false,
        isExternal: false,
        isDeleted: false,
        viewMode: "source",
      });
      const source = render(EditorPane, { filePath: "/notes.md", paneId: "pane-1" });
      expect(source.container.querySelector(".cm-content")?.classList.contains("cm-lineWrapping")).toBe(true);
      cleanup();
    }
  });
});

describe("EditorPane: scrollbar auto-hide", () => {
  afterEach(() => {
    cleanup();
    tabsState.set({ tabs: [], activeTabPath: null });
  });

  it("adds scrollbar-autohide to the CodeMirror scroller once mounted", () => {
    seedTab({
      path: "/example.py", workspaceId: "local",
      mode: "code",
      savedDoc: "x = 1\n",
      isDirty: false,
      hasExternalConflict: false,
      isExternal: false,
      isDeleted: false,
    });
    const { container } = render(EditorPane, { filePath: "/example.py", paneId: "pane-1" });

    expect(container.querySelector(".cm-scroller")?.classList.contains("scrollbar-autohide")).toBe(true);
  });
});
