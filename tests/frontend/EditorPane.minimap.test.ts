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

// The minimap's first build is deferred to `requestIdleCallback` (falling
// back to `setTimeout` under jsdom, which has no `requestIdleCallback`) so
// that opening a large file doesn't block the pane's own initial mount and
// paint — see `EditorPane.svelte`'s `applyMinimap` doc comment. Tests that
// assert the minimap's presence after mount need to wait past that deferral.
async function waitForIdle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  await tick();
}

function seedTab(path: string, mode: "code" | "markdown", viewMode: "rendered" | "source" = "rendered"): Tab {
  const tab: Tab = {
    path,
    mode,
    savedDoc: "line one\nline two\n",
    isDirty: false,
    hasExternalConflict: false,
    isExternal: false,
    isDeleted: false,
    viewMode,
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

  it("does not block initial mount: the editor content is present before the deferred minimap build runs", () => {
    seedTab(CODE_PATH, "code");
    const { container } = render(EditorPane, { filePath: CODE_PATH, paneId: PANE_ID });

    expect(container.querySelector(".cm-content")?.textContent).toContain("line one");
    expect(container.querySelector(".cm-minimap-gutter")).toBeNull();
  });

  it("shows the minimap gutter in a code pane by default, once the deferred build runs", async () => {
    seedTab(CODE_PATH, "code");
    const { container } = render(EditorPane, { filePath: CODE_PATH, paneId: PANE_ID });
    await waitForIdle();

    expect(container.querySelector(".cm-minimap-gutter")).not.toBeNull();
  });

  it("never shows the minimap gutter in a markdown pane in rendered view, even once the deferred build runs", async () => {
    seedTab(MARKDOWN_PATH, "markdown", "rendered");
    const { container } = render(EditorPane, { filePath: MARKDOWN_PATH, paneId: PANE_ID });
    await waitForIdle();

    expect(container.querySelector(".cm-minimap-gutter")).toBeNull();
  });

  it("never shows the minimap gutter in a markdown pane in source view either", async () => {
    seedTab(MARKDOWN_PATH, "markdown", "source");
    const { container } = render(EditorPane, { filePath: MARKDOWN_PATH, paneId: PANE_ID });
    await waitForIdle();

    expect(container.querySelector(".cm-minimap-gutter")).toBeNull();
  });

  // Wrapping alone already breaks `@replit/codemirror-minimap`'s one
  // document-line-per-visual-row assumption — a `viewMode`-only gate would
  // still show a wrong minimap in source view on any wrapped file, which
  // (per this repo's own semantic-line-break convention) is most of them.
  // This pins the real precondition (`mode === "markdown"`) against the
  // symptom it exists to prevent, so it fails loudly if wrapping and the
  // minimap gate ever drift apart again.
  it("gates the minimap on markdown's always-on line wrapping, not on view mode", async () => {
    seedTab(MARKDOWN_PATH, "markdown", "source");
    const { container } = render(EditorPane, { filePath: MARKDOWN_PATH, paneId: PANE_ID });
    await waitForIdle();

    expect(container.querySelector(".cm-content")?.classList.contains("cm-lineWrapping")).toBe(true);
    expect(container.querySelector(".cm-minimap-gutter")).toBeNull();
  });

  it("never shows the minimap gutter when the setting is off before mount", async () => {
    setMinimapEnabled(false);
    seedTab(CODE_PATH, "code");
    const { container } = render(EditorPane, { filePath: CODE_PATH, paneId: PANE_ID });
    await waitForIdle();

    expect(container.querySelector(".cm-minimap-gutter")).toBeNull();
  });

  it("reconfigures live when the setting is toggled off, without unmounting the pane", async () => {
    seedTab(CODE_PATH, "code");
    const { container } = render(EditorPane, { filePath: CODE_PATH, paneId: PANE_ID });
    await waitForIdle();
    expect(container.querySelector(".cm-minimap-gutter")).not.toBeNull();

    setMinimapEnabled(false);
    await tick();

    expect(container.querySelector(".cm-minimap-gutter")).toBeNull();
    // The editor content itself survives the reconfigure untouched.
    expect(container.querySelector(".cm-content")?.textContent).toContain("line one");
  });

  it("reconfigures live when the setting is toggled back on", async () => {
    setMinimapEnabled(false);
    seedTab(CODE_PATH, "code");
    const { container } = render(EditorPane, { filePath: CODE_PATH, paneId: PANE_ID });
    await waitForIdle();
    expect(container.querySelector(".cm-minimap-gutter")).toBeNull();

    setMinimapEnabled(true);
    await tick();

    expect(container.querySelector(".cm-minimap-gutter")).not.toBeNull();
  });

  // A deliberate, silent tradeoff of the markdown gate (see "Open questions"
  // in the plan this implements): the setting toggle is a global control,
  // but a markdown pane's effective minimap state never moves regardless of
  // what it's set to. Worth a named test rather than leaving it undiscovered.
  it("leaves the minimap gutter absent in a markdown pane throughout a setting toggle off and back on", async () => {
    seedTab(MARKDOWN_PATH, "markdown");
    const { container } = render(EditorPane, { filePath: MARKDOWN_PATH, paneId: PANE_ID });
    await waitForIdle();
    expect(container.querySelector(".cm-minimap-gutter")).toBeNull();

    setMinimapEnabled(false);
    await tick();
    expect(container.querySelector(".cm-minimap-gutter")).toBeNull();

    setMinimapEnabled(true);
    await tick();
    expect(container.querySelector(".cm-minimap-gutter")).toBeNull();
  });

  it("toggling before the deferred build fires applies immediately, without waiting for idle", async () => {
    seedTab(CODE_PATH, "code");
    const { container } = render(EditorPane, { filePath: CODE_PATH, paneId: PANE_ID });

    // No waitForIdle() here — the toggle happens before the mount-time idle
    // callback has had a chance to fire.
    setMinimapEnabled(false);
    await tick();
    expect(container.querySelector(".cm-minimap-gutter")).toBeNull();

    // Confirms the deferred callback doesn't fire a stale re-apply later
    // (which would re-show it and desync from the store's current value).
    await waitForIdle();
    expect(container.querySelector(".cm-minimap-gutter")).toBeNull();
  });
});
