import { describe, it, expect, afterEach, vi } from "vitest";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import { EditorView } from "@codemirror/view";
import EditorPane from "../../src/lib/editor/EditorPane.svelte";
import { tabsState, type Tab } from "../../src/lib/stores/tabs";
import { focusedEditorPaneId } from "../../src/lib/stores/editorPanes";
import { proseWidth, DEFAULT_PROSE_WIDTH } from "../../src/lib/stores/proseWidth";

const PATH = "/notes.md";
const PANE_ID = "pane-1";

function seedTab(): void {
  const tab: Tab = {
    path: PATH, workspaceId: "local",
    mode: "markdown",
    savedDoc: "hello\n",
    isDirty: false,
    hasExternalConflict: false,
    isExternal: false,
    isDeleted: false,
    viewMode: "rendered",
  };
  tabsState.set({ tabs: [tab], activeTabPath: PATH });
  focusedEditorPaneId.set(PANE_ID);
}

// Only a string-attribute check: jsdom's `getComputedStyle` doesn't resolve
// inherited custom properties through a subtree, so this can't assert that
// the property actually cascades to `.cm-content` or changes the rendered
// column's width — that needs a look at the running app.
describe("EditorPane: prose max width", () => {
  afterEach(() => {
    cleanup();
    tabsState.set({ tabs: [], activeTabPath: null });
    focusedEditorPaneId.set(null);
    proseWidth.set(DEFAULT_PROSE_WIDTH);
  });

  it("applies the default preset as --atrium-prose-max-width", () => {
    seedTab();
    const { container } = render(EditorPane, { filePath: PATH, paneId: PANE_ID });

    expect(container.querySelector(".editor-pane")?.getAttribute("style")).toContain(
      "--atrium-prose-max-width: 80ch",
    );
  });

  it("applies a changed numeric preset", () => {
    proseWidth.set(120);
    seedTab();
    const { container } = render(EditorPane, { filePath: PATH, paneId: PANE_ID });

    expect(container.querySelector(".editor-pane")?.getAttribute("style")).toContain(
      "--atrium-prose-max-width: 120ch",
    );
  });

  it("applies the \"full\" preset as 100cqw, not a ch value", () => {
    proseWidth.set("full");
    seedTab();
    const { container } = render(EditorPane, { filePath: PATH, paneId: PANE_ID });

    expect(container.querySelector(".editor-pane")?.getAttribute("style")).toContain(
      "--atrium-prose-max-width: 100cqw",
    );
  });

  it("reconfigures live, without remounting, when the setting changes after mount", async () => {
    seedTab();
    const { container } = render(EditorPane, { filePath: PATH, paneId: PANE_ID });

    proseWidth.set(60);
    await tick();

    expect(container.querySelector(".editor-pane")?.getAttribute("style")).toContain(
      "--atrium-prose-max-width: 60ch",
    );
  });

  // CSS alone re-wraps the rendered prose (changing every line's height),
  // but nothing tells CodeMirror its cached height map is stale unless this
  // forces a fresh measure pass — see the effect's own comment in
  // EditorPane.svelte for why nothing else (no compartment, no
  // ResizeObserver) covers it.
  it("requests a fresh CodeMirror measure when the setting changes after mount", async () => {
    seedTab();
    render(EditorPane, { filePath: PATH, paneId: PANE_ID });
    await tick();

    const requestMeasureSpy = vi.spyOn(EditorView.prototype, "requestMeasure");

    proseWidth.set(60);
    await tick();

    expect(requestMeasureSpy).toHaveBeenCalled();
    requestMeasureSpy.mockRestore();
  });

  it("does not request a further measure when the setting has not changed", async () => {
    seedTab();
    render(EditorPane, { filePath: PATH, paneId: PANE_ID });
    await tick();

    const requestMeasureSpy = vi.spyOn(EditorView.prototype, "requestMeasure");
    await tick();

    expect(requestMeasureSpy).not.toHaveBeenCalled();
    requestMeasureSpy.mockRestore();
  });
});
