import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import EditorPane from "../../src/lib/editor/EditorPane.svelte";
import { tabsState, type Tab } from "../../src/lib/stores/tabs";

function seedTab(tab: Tab): void {
  tabsState.set({ tabs: [tab], activeTabPath: tab.path });
}

describe("EditorPane: app-drawn caret (issue #435)", () => {
  afterEach(() => {
    cleanup();
    tabsState.set({ tabs: [], activeTabPath: null });
  });

  it("mounts CodeMirror's own cursor and selection layers instead of relying on the native caret", () => {
    seedTab({
      path: "/example.py",
      workspaceId: "local",
      mode: "code",
      savedDoc: "x = 1\n",
      isDirty: false,
      hasExternalConflict: false,
      isExternal: false,
      isDeleted: false,
    });
    const { container } = render(EditorPane, { filePath: "/example.py", paneId: "pane-1" });

    // jsdom has no layout, so `.cm-cursor` itself never renders here
    // (`drawSelection()` measures through `Range.getClientRects`, which the
    // shim in tests/setup.ts answers with empty geometry) — the layers that
    // host it are what's assertable under jsdom. The cursor-element count
    // itself is E2E's job (tests/e2e/specs/editorTabCompletion.e2e.js).
    expect(container.querySelector(".cm-cursorLayer")).not.toBeNull();
    expect(container.querySelector(".cm-selectionLayer")).not.toBeNull();
  });
});
