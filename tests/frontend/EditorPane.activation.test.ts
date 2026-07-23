import { describe, it, expect, afterEach, vi } from "vitest";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import { EditorView } from "@codemirror/view";
import EditorPane from "../../src/lib/editor/EditorPane.svelte";
import { tabsState, markDirty, type Tab } from "../../src/lib/stores/tabs";
import { focusedEditorPaneId } from "../../src/lib/stores/editorPanes";

const ACTIVE_PATH = "/active.md";
const BACKGROUND_PATH = "/background.md";
const PANE_ID = "pane-1";

function seedTabs(activeTabPath: string): void {
  const tabs: Tab[] = [
    { path: ACTIVE_PATH, mode: "markdown", savedDoc: "active\n", isDirty: false, hasExternalConflict: false, viewMode: "rendered" },
    { path: BACKGROUND_PATH, mode: "markdown", savedDoc: "background\n", isDirty: false, hasExternalConflict: false, viewMode: "rendered" },
  ];
  tabsState.set({ tabs, activeTabPath });
  focusedEditorPaneId.set(PANE_ID);
}

describe("EditorPane: remeasure on tab activation", () => {
  afterEach(() => {
    cleanup();
    tabsState.set({ tabs: [], activeTabPath: null });
    focusedEditorPaneId.set(null);
    vi.restoreAllMocks();
  });

  it("calls requestMeasure when a background tab's pane becomes active", async () => {
    seedTabs(ACTIVE_PATH);
    render(EditorPane, { filePath: BACKGROUND_PATH, paneId: PANE_ID });
    await tick();

    const requestMeasureSpy = vi.spyOn(EditorView.prototype, "requestMeasure");

    tabsState.update((s) => ({ ...s, activeTabPath: BACKGROUND_PATH }));
    await tick();

    expect(requestMeasureSpy).toHaveBeenCalledTimes(1);
  });

  it("does not call requestMeasure on mount when the pane is already active", async () => {
    seedTabs(ACTIVE_PATH);
    render(EditorPane, { filePath: ACTIVE_PATH, paneId: PANE_ID });
    await tick();

    const requestMeasureSpy = vi.spyOn(EditorView.prototype, "requestMeasure");
    await tick();

    expect(requestMeasureSpy).not.toHaveBeenCalled();
  });

  it("does not call requestMeasure on an unrelated tab-store update", async () => {
    seedTabs(ACTIVE_PATH);
    render(EditorPane, { filePath: BACKGROUND_PATH, paneId: PANE_ID });
    await tick();

    const requestMeasureSpy = vi.spyOn(EditorView.prototype, "requestMeasure");

    markDirty(BACKGROUND_PATH);
    await tick();

    expect(requestMeasureSpy).not.toHaveBeenCalled();
  });

  it("does not call requestMeasure again when switching away and the pane stays inactive", async () => {
    seedTabs(ACTIVE_PATH);
    render(EditorPane, { filePath: BACKGROUND_PATH, paneId: PANE_ID });
    await tick();

    const requestMeasureSpy = vi.spyOn(EditorView.prototype, "requestMeasure");

    tabsState.update((s) => ({ ...s, activeTabPath: ACTIVE_PATH }));
    await tick();
    tabsState.update((s) => ({ ...s, activeTabPath: ACTIVE_PATH }));
    await tick();

    expect(requestMeasureSpy).not.toHaveBeenCalled();
  });

  it("does not treat a pane as active when it isn't the focused pane, even if it shows the globally-active path", async () => {
    // A second split pane showing the same path as its own active tab, while
    // some other pane is the one actually focused — this is exactly the
    // state right after a single-file split (issue #158 scenario 1), before
    // the user has clicked into the new pane.
    seedTabs(ACTIVE_PATH);
    focusedEditorPaneId.set("some-other-pane");
    render(EditorPane, { filePath: ACTIVE_PATH, paneId: PANE_ID });
    await tick();

    const requestMeasureSpy = vi.spyOn(EditorView.prototype, "requestMeasure");
    await tick();

    expect(requestMeasureSpy).not.toHaveBeenCalled();
  });
});
