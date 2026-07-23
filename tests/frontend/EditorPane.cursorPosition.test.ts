import { describe, it, expect, afterEach, vi } from "vitest";
import { get } from "svelte/store";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import { EditorView } from "@codemirror/view";
import EditorPane from "../../src/lib/editor/EditorPane.svelte";
import { tabsState, closeTab, type Tab } from "../../src/lib/stores/tabs";
import { cursorPosition } from "../../src/lib/stores/editorStatus";
import { focusedEditorPaneId } from "../../src/lib/stores/editorPanes";

const ACTIVE_PATH = "/active.md";
const BACKGROUND_PATH = "/background.md";
const DOC = "one two\nthree four\nfive six\n";
const PANE_ID = "pane-1";

function seedTabs(activeTabPath: string): void {
  const tabs: Tab[] = [
    { path: ACTIVE_PATH, mode: "markdown", savedDoc: DOC, isDirty: false, hasExternalConflict: false, viewMode: "source" },
    { path: BACKGROUND_PATH, mode: "markdown", savedDoc: DOC, isDirty: false, hasExternalConflict: false, viewMode: "source" },
  ];
  tabsState.set({ tabs, activeTabPath });
  focusedEditorPaneId.set(PANE_ID);
}

function findView(container: HTMLElement): EditorView {
  const dom = container.querySelector(".cm-editor") as HTMLElement;
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error("expected an EditorView to be mounted");
  return view;
}

describe("EditorPane: cursor position tracking", () => {
  afterEach(() => {
    cleanup();
    tabsState.set({ tabs: [], activeTabPath: null });
    focusedEditorPaneId.set(null);
    cursorPosition.set(null);
    vi.restoreAllMocks();
  });

  it("pushes the active pane's cursor position on caret move", async () => {
    seedTabs(ACTIVE_PATH);
    const { container } = render(EditorPane, { filePath: ACTIVE_PATH, paneId: PANE_ID });
    await tick();

    const view = findView(container);
    // "three" starts at doc offset 8 (line 2, col 1); move the caret onto
    // "four" (offset 14 -> line 2, col 7).
    view.dispatch({ selection: { anchor: 14 } });
    await tick();

    expect(get(cursorPosition)).toEqual({ line: 2, col: 7, selection: null });
  });

  it("does not update from a hidden/inactive tab's own selection or doc changes", async () => {
    seedTabs(ACTIVE_PATH);
    const { container } = render(EditorPane, { filePath: BACKGROUND_PATH, paneId: PANE_ID });
    await tick();
    cursorPosition.set({ line: 1, col: 1, selection: null });

    const view = findView(container);
    view.dispatch({ selection: { anchor: 14 } });
    view.dispatch({ changes: { from: 0, to: 0, insert: "x" } });
    await tick();

    expect(get(cursorPosition)).toEqual({ line: 1, col: 1, selection: null });
  });

  it("pushes this pane's position when it becomes the active tab without a keystroke", async () => {
    seedTabs(ACTIVE_PATH);
    const { container } = render(EditorPane, { filePath: BACKGROUND_PATH, paneId: PANE_ID });
    await tick();
    const view = findView(container);
    view.dispatch({ selection: { anchor: 14 } });
    await tick();
    // Still inactive, so the move above must not have pushed anything.
    expect(get(cursorPosition)).toBeNull();

    tabsState.update((s) => ({ ...s, activeTabPath: BACKGROUND_PATH }));
    await tick();

    expect(get(cursorPosition)).toEqual({ line: 2, col: 7, selection: null });
  });

  it("clears the store when the last tab closes", async () => {
    tabsState.set({
      tabs: [{ path: ACTIVE_PATH, mode: "markdown", savedDoc: DOC, isDirty: false, hasExternalConflict: false, viewMode: "source" }],
      activeTabPath: ACTIVE_PATH,
    });
    focusedEditorPaneId.set(PANE_ID);
    const { unmount } = render(EditorPane, { filePath: ACTIVE_PATH, paneId: PANE_ID });
    await tick();
    expect(get(cursorPosition)).not.toBeNull();

    // App.svelte's `{#each $tabsState.tabs as tab}` is what actually
    // destroys a closed tab's pane; a bare `render()` here has no such
    // `{#each}` wrapper, so the tabsState update and the pane's unmount are
    // driven separately, in the same order App.svelte's reactivity would.
    closeTab(ACTIVE_PATH);
    unmount();
    await tick();

    expect(get(cursorPosition)).toBeNull();
  });

  it("reports a single-line selection's extent", async () => {
    seedTabs(ACTIVE_PATH);
    const { container } = render(EditorPane, { filePath: ACTIVE_PATH, paneId: PANE_ID });
    await tick();

    const view = findView(container);
    // "three" spans offsets 8-13 on line 2.
    view.dispatch({ selection: { anchor: 8, head: 13 } });
    await tick();

    expect(get(cursorPosition)).toEqual({ line: 2, col: 6, selection: { lines: 1, chars: 5 } });
  });

  it("reports a multi-line selection's extent", async () => {
    seedTabs(ACTIVE_PATH);
    const { container } = render(EditorPane, { filePath: ACTIVE_PATH, paneId: PANE_ID });
    await tick();

    const view = findView(container);
    // From "four" (offset 14) through "five" start (offset 19), spanning
    // lines 2-3.
    view.dispatch({ selection: { anchor: 14, head: 19 } });
    await tick();

    expect(get(cursorPosition)).toEqual({ line: 3, col: 1, selection: { lines: 2, chars: 5 } });
  });

  it("reverts to a null selection once the selection collapses back to a caret", async () => {
    seedTabs(ACTIVE_PATH);
    const { container } = render(EditorPane, { filePath: ACTIVE_PATH, paneId: PANE_ID });
    await tick();

    const view = findView(container);
    view.dispatch({ selection: { anchor: 8, head: 13 } });
    await tick();
    expect(get(cursorPosition)?.selection).not.toBeNull();

    view.dispatch({ selection: { anchor: 13 } });
    await tick();

    expect(get(cursorPosition)).toEqual({ line: 2, col: 6, selection: null });
  });
});
