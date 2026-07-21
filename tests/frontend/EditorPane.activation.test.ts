import { describe, it, expect, afterEach, vi } from "vitest";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import { EditorView } from "@codemirror/view";
import EditorPane from "../../src/lib/editor/EditorPane.svelte";
import { tabsState, markDirty, type Tab } from "../../src/lib/stores/tabs";

const ACTIVE_PATH = "/active.md";
const BACKGROUND_PATH = "/background.md";

function seedTabs(activeTabPath: string): void {
  const tabs: Tab[] = [
    { path: ACTIVE_PATH, mode: "markdown", savedDoc: "active\n", isDirty: false, hasExternalConflict: false, viewMode: "rendered" },
    { path: BACKGROUND_PATH, mode: "markdown", savedDoc: "background\n", isDirty: false, hasExternalConflict: false, viewMode: "rendered" },
  ];
  tabsState.set({ tabs, activeTabPath });
}

describe("EditorPane: remeasure on tab activation", () => {
  afterEach(() => {
    cleanup();
    tabsState.set({ tabs: [], activeTabPath: null });
    vi.restoreAllMocks();
  });

  it("calls requestMeasure when a background tab's pane becomes active", async () => {
    seedTabs(ACTIVE_PATH);
    render(EditorPane, { filePath: BACKGROUND_PATH });
    await tick();

    const requestMeasureSpy = vi.spyOn(EditorView.prototype, "requestMeasure");

    tabsState.update((s) => ({ ...s, activeTabPath: BACKGROUND_PATH }));
    await tick();

    expect(requestMeasureSpy).toHaveBeenCalledTimes(1);
  });

  it("does not call requestMeasure on mount when the pane is already active", async () => {
    seedTabs(ACTIVE_PATH);
    render(EditorPane, { filePath: ACTIVE_PATH });
    await tick();

    const requestMeasureSpy = vi.spyOn(EditorView.prototype, "requestMeasure");
    await tick();

    expect(requestMeasureSpy).not.toHaveBeenCalled();
  });

  it("does not call requestMeasure on an unrelated tab-store update", async () => {
    seedTabs(ACTIVE_PATH);
    render(EditorPane, { filePath: BACKGROUND_PATH });
    await tick();

    const requestMeasureSpy = vi.spyOn(EditorView.prototype, "requestMeasure");

    markDirty(BACKGROUND_PATH);
    await tick();

    expect(requestMeasureSpy).not.toHaveBeenCalled();
  });

  it("does not call requestMeasure again when switching away and the pane stays inactive", async () => {
    seedTabs(ACTIVE_PATH);
    render(EditorPane, { filePath: BACKGROUND_PATH });
    await tick();

    const requestMeasureSpy = vi.spyOn(EditorView.prototype, "requestMeasure");

    tabsState.update((s) => ({ ...s, activeTabPath: ACTIVE_PATH }));
    await tick();
    tabsState.update((s) => ({ ...s, activeTabPath: ACTIVE_PATH }));
    await tick();

    expect(requestMeasureSpy).not.toHaveBeenCalled();
  });
});
