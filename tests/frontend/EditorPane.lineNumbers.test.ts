import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import EditorPane from "../../src/lib/editor/EditorPane.svelte";
import { tabsState, type Tab } from "../../src/lib/stores/tabs";
import {
  lineNumbersEnabled,
  setLineNumbersEnabled,
  DEFAULT_LINE_NUMBERS_ENABLED,
} from "../../src/lib/stores/lineNumbersEnabled";

function seedTab(tab: Tab): void {
  tabsState.set({ tabs: [tab], activeTabPath: tab.path });
}

describe("EditorPane: line numbers", () => {
  beforeEach(() => {
    lineNumbersEnabled.set(DEFAULT_LINE_NUMBERS_ENABLED);
  });

  afterEach(() => {
    cleanup();
    tabsState.set({ tabs: [], activeTabPath: null });
    lineNumbersEnabled.set(DEFAULT_LINE_NUMBERS_ENABLED);
  });

  it("shows the gutter by default in a code pane", () => {
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

    expect(container.querySelector(".cm-lineNumbers")).not.toBeNull();
  });

  it("hides the gutter in a code pane when lineNumbersEnabled is false at mount", () => {
    setLineNumbersEnabled(false);
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

    expect(container.querySelector(".cm-lineNumbers")).toBeNull();
  });

  it("reconfigures the gutter live in a code pane when the setting toggles after mount", async () => {
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
    expect(container.querySelector(".cm-lineNumbers")).not.toBeNull();

    setLineNumbersEnabled(false);
    await tick();

    expect(container.querySelector(".cm-lineNumbers")).toBeNull();

    setLineNumbersEnabled(true);
    await tick();

    expect(container.querySelector(".cm-lineNumbers")).not.toBeNull();
  });

  it("shows the gutter by default in a markdown source-view pane, hides it when the setting is off", async () => {
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
    const { container } = render(EditorPane, { filePath: "/notes.md", paneId: "pane-1" });
    expect(container.querySelector(".cm-lineNumbers")).not.toBeNull();

    setLineNumbersEnabled(false);
    await tick();

    expect(container.querySelector(".cm-lineNumbers")).toBeNull();
  });

  it("never shows a gutter in a markdown rendered-view pane, regardless of the setting", async () => {
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
    const { container } = render(EditorPane, { filePath: "/notes.md", paneId: "pane-1" });
    expect(container.querySelector(".cm-lineNumbers")).toBeNull();

    setLineNumbersEnabled(true);
    await tick();

    expect(container.querySelector(".cm-lineNumbers")).toBeNull();
  });
});
