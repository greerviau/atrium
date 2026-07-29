import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import { EditorView } from "@codemirror/view";
import { indentMore } from "@codemirror/commands";
import EditorPane from "../../src/lib/editor/EditorPane.svelte";
import { tabsState, type Tab } from "../../src/lib/stores/tabs";
import { tabSize, setTabSize, DEFAULT_TAB_SIZE } from "../../src/lib/stores/tabSize";

function seedTab(tab: Tab): void {
  tabsState.set({ tabs: [tab], activeTabPath: tab.path });
}

function findView(container: HTMLElement): EditorView {
  const dom = container.querySelector(".cm-editor") as HTMLElement;
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error("expected an EditorView to be mounted");
  return view;
}

describe("EditorPane: tab size", () => {
  beforeEach(() => {
    tabSize.set(DEFAULT_TAB_SIZE);
  });

  afterEach(() => {
    cleanup();
    tabsState.set({ tabs: [], activeTabPath: null });
    tabSize.set(DEFAULT_TAB_SIZE);
  });

  it("indents a code pane by the default tab size (2 spaces) when Tab is pressed", () => {
    seedTab({
      path: "/example.py", workspaceId: "local",
      mode: "code",
      savedDoc: "\n",
      isDirty: false,
      hasExternalConflict: false,
      isExternal: false,
      isDeleted: false,
    });
    const { container } = render(EditorPane, { filePath: "/example.py", paneId: "pane-1" });
    const view = findView(container);

    indentMore(view);

    expect(view.state.doc.toString()).toBe("  \n");
  });

  it("indents a code pane by a configured tab size (4 spaces)", () => {
    setTabSize(4);
    seedTab({
      path: "/example.py", workspaceId: "local",
      mode: "code",
      savedDoc: "\n",
      isDirty: false,
      hasExternalConflict: false,
      isExternal: false,
      isDeleted: false,
    });
    const { container } = render(EditorPane, { filePath: "/example.py", paneId: "pane-1" });
    const view = findView(container);

    indentMore(view);

    expect(view.state.doc.toString()).toBe("    \n");
  });

  it("indents a markdown source-view pane by the configured tab size", () => {
    setTabSize(8);
    seedTab({
      path: "/notes.md", workspaceId: "local",
      mode: "markdown",
      savedDoc: "\n",
      isDirty: false,
      hasExternalConflict: false,
      isExternal: false,
      isDeleted: false,
      viewMode: "source",
    });
    const { container } = render(EditorPane, { filePath: "/notes.md", paneId: "pane-1" });
    const view = findView(container);

    indentMore(view);

    expect(view.state.doc.toString()).toBe(" ".repeat(8) + "\n");
  });

  it("reconfigures tab size live, without remounting, when the setting changes after mount", async () => {
    seedTab({
      path: "/example.py", workspaceId: "local",
      mode: "code",
      savedDoc: "\n",
      isDirty: false,
      hasExternalConflict: false,
      isExternal: false,
      isDeleted: false,
    });
    const { container } = render(EditorPane, { filePath: "/example.py", paneId: "pane-1" });
    const view = findView(container);

    setTabSize(8);
    await tick();

    indentMore(view);

    expect(view.state.doc.toString()).toBe(" ".repeat(8) + "\n");
  });
});
