import { describe, it, expect, afterEach } from "vitest";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
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
// column's width — that's verified manually against the running app.
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
});
