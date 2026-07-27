import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import { EditorView } from "@codemirror/view";
import App from "../../src/App.svelte";
import { workspace } from "../../src/lib/stores/workspace";
import { terminalVisible } from "../../src/lib/stores/layout";
import { tabsState, openFile, requestSave, reconcileExternalChange, renameOpenTabs } from "../../src/lib/stores/tabs";
import { focusedEditorPaneId, editorPaneTree } from "../../src/lib/stores/editorPanes";
import { rename } from "../../src/lib/explorer/contextMenu";
import * as commands from "../../src/lib/ipc/commands";

// Regresses issue #249: renaming an open, dirty file via the explorer must
// not lose the unsaved edit (the "Data-loss hazard" the plan calls out —
// editorViewRegistry has to be rekeyed before the pane tree's keyed re-render
// tears down and remounts the EditorPane), and a save after the rename must
// land on the new path, never resurrecting the old one.
vi.mock("../../src/lib/explorer/FileTree.svelte", async () => {
  const mod = await import("./FileTreeStub.svelte");
  return { default: mod.default };
});

vi.mock("../../src/lib/terminal/TerminalPane.svelte", async () => {
  const mod = await import("./TerminalPaneStub.svelte");
  return { default: mod.default };
});

vi.mock("../../src/lib/ipc/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ipc/commands")>();
  return {
    ...actual,
    workspaceTakePendingOpen: vi.fn().mockResolvedValue(null),
    appConfirmClose: vi.fn().mockResolvedValue(undefined),
    fsReadFile: vi.fn().mockResolvedValue("original\n"),
    fsListDir: vi.fn().mockResolvedValue([]),
    fsRename: vi.fn().mockResolvedValue(undefined),
    fsWriteFile: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../src/lib/ipc/events", () => ({
  onFsChanged: vi.fn().mockResolvedValue(() => {}),
  onMenuEvent: vi.fn().mockResolvedValue(() => {}),
  onDockOpenPath: vi.fn().mockResolvedValue(() => {}),
  onCloseRequested: vi.fn().mockResolvedValue(() => {}),
  onDragDropEvent: vi.fn().mockResolvedValue(() => {}),
}));

function findView(container: HTMLElement): EditorView {
  const dom = container.querySelector(".cm-editor") as HTMLElement;
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error("expected an EditorView to be mounted");
  return view;
}

function resetStores(): void {
  localStorage.clear();
  workspace.set({ id: "local", root: null });
  terminalVisible.set(false);
  tabsState.set({ tabs: [], activeTabPath: null });
  focusedEditorPaneId.set(null);
  editorPaneTree.set(null);
}

describe("App rename reconciliation (issue #249)", () => {
  beforeEach(() => {
    resetStores();
    vi.mocked(commands.fsRename).mockClear();
    vi.mocked(commands.fsWriteFile).mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("renaming an open file with unsaved edits keeps the live buffer, updates the tab strip, and saves to the new path", async () => {
    workspace.set({ id: "local", root: "/proj" });
    const { container } = render(App);
    await tick();

    await openFile("/proj/notes.md");
    await tick();
    await tick();

    const viewBeforeRename = findView(container);
    viewBeforeRename.dispatch({ changes: { from: 0, to: 0, insert: "unsaved edit\n" } });
    expect(viewBeforeRename.state.doc.toString()).toBe("unsaved edit\noriginal\n");

    await rename("/proj/notes.md", "notes-renamed.md");
    await tick();
    await tick();

    // The tab strip now shows the new name, not the stale old one.
    const tabNames = [...container.querySelectorAll(".editor-panel .tab-name")].map((el) => el.textContent);
    expect(tabNames.some((t) => t?.includes("notes-renamed.md"))).toBe(true);
    expect(tabNames.some((t) => t?.includes("notes.md") && !t.includes("notes-renamed.md"))).toBe(false);
    expect(get(tabsState).tabs.map((t) => t.path)).toEqual(["/proj/notes-renamed.md"]);

    // The remounted EditorPane's own buffer still has the unsaved edit — the
    // data-loss hazard this fix exists to close.
    const viewAfterRename = findView(container);
    expect(viewAfterRename.state.doc.toString()).toBe("unsaved edit\noriginal\n");

    // Saving now writes to the new path; the old path is never touched again.
    await requestSave("/proj/notes-renamed.md");
    await tick();

    expect(commands.fsWriteFile).toHaveBeenCalledWith(
      "local",
      "/proj/notes-renamed.md",
      "unsaved edit\noriginal\n",
    );
    expect(commands.fsWriteFile).not.toHaveBeenCalledWith(
      "local",
      "/proj/notes.md",
      expect.anything(),
    );
  });

  // Regression coverage for a review finding on this fix: `rekeyPath` alone
  // isn't enough — the destroyed pane's own `onDestroy` still calls
  // `unregisterView` with its stale, pre-rename `filePath` prop, which used
  // to look up the wrong (already-vacated) registry entry and leave a dead,
  // destroyed view registered under the new path forever. That dead view
  // kept receiving `broadcastChange` dispatches, so any edit made to the
  // renamed tab *after* a silent external reload (a "Modify" event on a
  // clean tab, or the conflict banner's "Reload" action) would try to
  // dispatch into the destroyed view and crash. This continues past the
  // rename itself: reload, then edit again.
  it("editing a renamed, clean tab after it silently reloads from an external change does not crash (dead-view regression)", async () => {
    workspace.set({ id: "local", root: "/proj" });
    const { container } = render(App);
    await tick();

    await openFile("/proj/notes.md");
    await tick();
    await tick();

    await rename("/proj/notes.md", "notes-renamed.md");
    await tick();
    await tick();

    expect(get(tabsState).tabs.map((t) => t.path)).toEqual(["/proj/notes-renamed.md"]);

    vi.mocked(commands.fsReadFile).mockResolvedValueOnce("changed on disk\n");
    await reconcileExternalChange("/proj/notes-renamed.md");
    await tick();
    await tick();

    const view = findView(container);
    expect(view.state.doc.toString()).toBe("changed on disk\n");

    expect(() => {
      view.dispatch({ changes: { from: 0, to: 0, insert: "x" } });
    }).not.toThrow();
    expect(view.state.doc.toString()).toBe("xchanged on disk\n");
  });

  it("renaming a file twice in a row (e.g. two quick explorer renames) leaves exactly one tab at the final path with content intact", async () => {
    workspace.set({ id: "local", root: "/proj" });
    const { container } = render(App);
    await tick();

    await openFile("/proj/notes.md");
    await tick();
    await tick();

    await rename("/proj/notes.md", "notes-renamed-1.md");
    await tick();
    await tick();
    await rename("/proj/notes-renamed-1.md", "notes-renamed-2.md");
    await tick();
    await tick();

    expect(get(tabsState).tabs.map((t) => t.path)).toEqual(["/proj/notes-renamed-2.md"]);
    const tabNames = [...container.querySelectorAll(".editor-panel .tab-name")].map((el) => el.textContent);
    expect(tabNames.filter((t) => t?.includes("notes-renamed")).length).toBe(1);

    const view = findView(container);
    expect(() => {
      view.dispatch({ changes: { from: 0, to: 0, insert: "still alive" } });
    }).not.toThrow();
  });

  it("an external rename onto an already-open path drops the displaced tab instead of crashing the keyed tab strip", async () => {
    workspace.set({ id: "local", root: "/proj" });
    render(App);
    await tick();

    await openFile("/proj/a.md");
    await tick();
    await openFile("/proj/b.md");
    await tick();
    await tick();

    expect(get(tabsState).tabs.map((t) => t.path)).toEqual(["/proj/a.md", "/proj/b.md"]);

    expect(() => renameOpenTabs("/proj/a.md", "/proj/b.md")).not.toThrow();
    await tick();
    await tick();

    expect(get(tabsState).tabs.map((t) => t.path)).toEqual(["/proj/b.md"]);
  });
});
