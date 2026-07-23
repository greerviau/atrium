import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import EditorPane from "../../src/lib/editor/EditorPane.svelte";
import { tabsState, type Tab } from "../../src/lib/stores/tabs";
import { focusedEditorPaneId } from "../../src/lib/stores/editorPanes";
import { setMinimapEnabled, DEFAULT_MINIMAP_ENABLED } from "../../src/lib/stores/minimapEnabled";

const PANE_ID = "pane-1";
const CODE_PATH = "/main.ts";
const MARKDOWN_PATH = "/notes.md";

function seedTab(path: string, mode: "code" | "markdown"): Tab {
  const tab: Tab = {
    path,
    mode,
    savedDoc: "line one\nline two\n",
    isDirty: false,
    hasExternalConflict: false,
    viewMode: "rendered",
  };
  tabsState.set({ tabs: [tab], activeTabPath: path });
  focusedEditorPaneId.set(PANE_ID);
  return tab;
}

describe("EditorPane: minimap", () => {
  beforeEach(() => {
    setMinimapEnabled(DEFAULT_MINIMAP_ENABLED);
  });

  afterEach(() => {
    cleanup();
    tabsState.set({ tabs: [], activeTabPath: null });
    focusedEditorPaneId.set(null);
    setMinimapEnabled(DEFAULT_MINIMAP_ENABLED);
  });

  it("shows the minimap gutter in a code pane by default (on by default)", () => {
    seedTab(CODE_PATH, "code");
    const { container } = render(EditorPane, { filePath: CODE_PATH, paneId: PANE_ID });

    expect(container.querySelector(".cm-minimap-gutter")).not.toBeNull();
  });

  it("shows the minimap gutter in a markdown pane by default (on by default)", () => {
    seedTab(MARKDOWN_PATH, "markdown");
    const { container } = render(EditorPane, { filePath: MARKDOWN_PATH, paneId: PANE_ID });

    expect(container.querySelector(".cm-minimap-gutter")).not.toBeNull();
  });

  it("omits the minimap gutter when the setting is off before mount", () => {
    setMinimapEnabled(false);
    seedTab(CODE_PATH, "code");
    const { container } = render(EditorPane, { filePath: CODE_PATH, paneId: PANE_ID });

    expect(container.querySelector(".cm-minimap-gutter")).toBeNull();
  });

  it("reconfigures live when the setting is toggled off, without unmounting the pane", async () => {
    seedTab(CODE_PATH, "code");
    const { container } = render(EditorPane, { filePath: CODE_PATH, paneId: PANE_ID });
    await tick();
    expect(container.querySelector(".cm-minimap-gutter")).not.toBeNull();

    setMinimapEnabled(false);
    await tick();

    expect(container.querySelector(".cm-minimap-gutter")).toBeNull();
    // The editor content itself survives the reconfigure untouched.
    expect(container.querySelector(".cm-content")?.textContent).toContain("line one");
  });

  it("reconfigures live when the setting is toggled back on", async () => {
    setMinimapEnabled(false);
    seedTab(MARKDOWN_PATH, "markdown");
    const { container } = render(EditorPane, { filePath: MARKDOWN_PATH, paneId: PANE_ID });
    await tick();
    expect(container.querySelector(".cm-minimap-gutter")).toBeNull();

    setMinimapEnabled(true);
    await tick();

    expect(container.querySelector(".cm-minimap-gutter")).not.toBeNull();
  });
});
