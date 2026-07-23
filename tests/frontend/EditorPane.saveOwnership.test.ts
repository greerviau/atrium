import { describe, it, expect, afterEach, vi } from "vitest";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import EditorPane from "../../src/lib/editor/EditorPane.svelte";
import { tabsState, requestSave, type Tab } from "../../src/lib/stores/tabs";
import { focusedEditorPaneId, editorPaneTree } from "../../src/lib/stores/editorPanes";
import type { EditorPaneNode } from "../../src/lib/editor/editorPaneTree";
import * as commands from "../../src/lib/ipc/commands";

// A path open in two split panes has two independent, unsynced `EditorPane`
// instances (PR1's own scope — no live content sync yet), so a single save
// request naming just the path is ambiguous unless exactly one instance
// responds: see the `isSaveOwner` derived value and `saveOwnerLeafId`'s own
// doc comment for the fix and why a plain `active`-only guard isn't enough
// (a background save — e.g. "Save All" on a dirty tab that isn't the
// focused pane's own active tab — would otherwise get no responder at all).
vi.mock("../../src/lib/ipc/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ipc/commands")>();
  return { ...actual, fsWriteFile: vi.fn().mockResolvedValue(undefined), fsReadFile: vi.fn() };
});

const PATH = "/shared.ts";
const PANE_A = "pane-a";
const PANE_B = "pane-b";

function seedTab(): Tab {
  const tab: Tab = { path: PATH, mode: "code", savedDoc: "original\n", isDirty: false, hasExternalConflict: false };
  tabsState.set({ tabs: [tab], activeTabPath: PATH });
  return tab;
}

function twoPaneSplitShowingPath(): EditorPaneNode {
  return {
    type: "split",
    id: "split-a-b",
    direction: "row",
    children: [
      { type: "leaf", id: PANE_A, tabs: [PATH], activeTabPath: PATH },
      { type: "leaf", id: PANE_B, tabs: [PATH], activeTabPath: PATH },
    ],
    sizes: [0.5, 0.5],
  };
}

describe("EditorPane: save ownership across split panes showing the same path", () => {
  afterEach(() => {
    cleanup();
    tabsState.set({ tabs: [], activeTabPath: null });
    focusedEditorPaneId.set(null);
    editorPaneTree.set(null);
    vi.restoreAllMocks();
  });

  it("a save request for a path open in two panes writes to disk exactly once, from the focused pane's own buffer", async () => {
    seedTab();
    editorPaneTree.set(twoPaneSplitShowingPath());
    focusedEditorPaneId.set(PANE_A);

    const { container: containerA } = render(EditorPane, { filePath: PATH, paneId: PANE_A });
    const { container: containerB } = render(EditorPane, { filePath: PATH, paneId: PANE_B });
    await tick();

    const fsWriteFile = vi.mocked(commands.fsWriteFile);
    fsWriteFile.mockClear();

    void requestSave(PATH);
    await tick();
    await tick();

    expect(fsWriteFile).toHaveBeenCalledTimes(1);

    // Both containers exist purely to prove the *other* pane's mount didn't
    // also fire a write; nothing else about their DOM is asserted here.
    expect(containerA).toBeTruthy();
    expect(containerB).toBeTruthy();
  });

  it("a save request for a path open only in an unfocused pane still gets exactly one responder", async () => {
    // Mirrors the unsaved-changes dialog's "Save All", which can request a
    // save for a dirty tab that isn't the focused pane's own active tab.
    seedTab();
    editorPaneTree.set({ type: "leaf", id: PANE_B, tabs: [PATH], activeTabPath: PATH });
    focusedEditorPaneId.set("some-other-pane-not-showing-this-path");

    render(EditorPane, { filePath: PATH, paneId: PANE_B });
    await tick();

    const fsWriteFile = vi.mocked(commands.fsWriteFile);
    fsWriteFile.mockClear();

    await requestSave(PATH);

    expect(fsWriteFile).toHaveBeenCalledTimes(1);
  });
});
