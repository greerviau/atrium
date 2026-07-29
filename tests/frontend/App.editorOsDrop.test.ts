import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";
import { get } from "svelte/store";
import { render, cleanup } from "@testing-library/svelte";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import App from "../../src/App.svelte";
import { workspace } from "../../src/lib/stores/workspace";
import { terminalVisible } from "../../src/lib/stores/layout";
import { tabsState } from "../../src/lib/stores/tabs";
import { focusedEditorPaneId, editorPaneTree } from "../../src/lib/stores/editorPanes";
import { errorToast } from "../../src/lib/stores/errorToast";
import * as terminalDropTargets from "../../src/lib/terminal/terminalDropTargets";
import * as explorerDropTargets from "../../src/lib/explorer/explorerDropTargets";
import * as editorDropTargets from "../../src/lib/editor/editorDropTargets";
import * as importExternalPaths from "../../src/lib/explorer/importExternalPaths";
import * as commands from "../../src/lib/ipc/commands";
import { dragOverTargetDir, draggingPath } from "../../src/lib/explorer/explorerDrag";
import type { DragDropEvent } from "@tauri-apps/api/webview";

// Covers issue #303's editor-panel drop routing (the drag-a-file-into-the-
// editor plan): a drop that hit-tests to the editor area opens each dropped
// file as its own tab, granting external-file access first for anything
// outside the workspace. Everything except the two heaviest leaf components
// (stubbed the same way App.terminalOsDrop.test.ts stubs them) runs
// unmodified, including the real onMount wiring under test.
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
    workspaceTakePendingOpen: vi.fn().mockResolvedValue([]),
    appConfirmClose: vi.fn().mockResolvedValue(undefined),
    fsReadFile: vi.fn().mockResolvedValue("content\n"),
    fsExternalPathsAreDirs: vi.fn().mockResolvedValue([]),
    fsGrantExternalFile: vi.fn().mockResolvedValue(undefined),
  };
});

let capturedDragDropHandler: ((event: DragDropEvent) => void) | undefined;

vi.mock("../../src/lib/ipc/events", () => ({
  onFsChanged: vi.fn().mockResolvedValue(() => {}),
  onMenuEvent: vi.fn().mockResolvedValue(() => {}),
  onDockOpenPath: vi.fn().mockResolvedValue(() => {}),
  onCloseRequested: vi.fn().mockResolvedValue(() => {}),
  onDragDropEvent: vi.fn((handler: (event: DragDropEvent) => void) => {
    capturedDragDropHandler = handler;
    return Promise.resolve(() => {});
  }),
}));

vi.mock("../../src/lib/terminal/terminalDropTargets", () => ({
  insertPathsAtScreenPoint: vi.fn(),
}));

vi.mock("../../src/lib/explorer/explorerDropTargets", () => ({
  resolveExplorerDropTargetDir: vi.fn().mockReturnValue(null),
}));

vi.mock("../../src/lib/editor/editorDropTargets", () => ({
  resolveEditorDropTarget: vi.fn().mockReturnValue(null),
}));

vi.mock("../../src/lib/explorer/importExternalPaths", () => ({
  importPathsInto: vi.fn(),
}));

const ROOT = "/projects/demo";

function resetStores(): void {
  localStorage.clear();
  workspace.set({ id: "local", root: ROOT });
  terminalVisible.set(true);
  tabsState.set({ tabs: [], activeTabPath: null });
  focusedEditorPaneId.set(null);
  editorPaneTree.set(null);
  errorToast.set(null);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
  await tick();
}

function drop(paths: string[]): void {
  capturedDragDropHandler?.({ type: "drop", paths, position: new PhysicalPosition(100, 100) });
}

describe("App editor-panel OS drop routing (issue #303)", () => {
  beforeEach(() => {
    resetStores();
    capturedDragDropHandler = undefined;
    vi.mocked(explorerDropTargets.resolveExplorerDropTargetDir).mockReturnValue(null);
    vi.mocked(editorDropTargets.resolveEditorDropTarget).mockReturnValue(null);
    vi.mocked(commands.fsExternalPathsAreDirs).mockResolvedValue([]);
    vi.mocked(commands.fsGrantExternalFile).mockResolvedValue(undefined);
    vi.mocked(commands.fsReadFile).mockResolvedValue("content\n");
    dragOverTargetDir.set(null);
    draggingPath.set(null);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("opens an in-workspace file dropped on the editor area, without granting", async () => {
    vi.mocked(editorDropTargets.resolveEditorDropTarget).mockReturnValue({ paneId: null });
    vi.mocked(commands.fsExternalPathsAreDirs).mockResolvedValue([false]);
    render(App);
    await tick();

    const path = `${ROOT}/notes.md`;
    drop([path]);
    await flush();

    expect(get(tabsState).tabs.map((t) => t.path)).toContain(path);
    const tab = get(tabsState).tabs.find((t) => t.path === path);
    expect(tab?.isExternal).toBe(false);
    expect(get(errorToast)).toBeNull();
  });

  it("grants before opening an outside-workspace file, in call order, and marks the resulting tab external", async () => {
    vi.mocked(editorDropTargets.resolveEditorDropTarget).mockReturnValue({ paneId: null });
    vi.mocked(commands.fsExternalPathsAreDirs).mockResolvedValue([false]);
    render(App);
    await tick();

    const calls: string[] = [];
    vi.mocked(commands.fsGrantExternalFile).mockImplementation(async () => {
      calls.push("grant");
    });
    vi.mocked(commands.fsReadFile).mockImplementation(async () => {
      calls.push("read");
      return "external contents";
    });

    const path = "/home/alice/outside.md";
    drop([path]);
    await flush();

    expect(calls).toEqual(["grant", "read"]);
    expect(commands.fsGrantExternalFile).toHaveBeenCalledWith(ROOT, path);
    const tab = get(tabsState).tabs.find((t) => t.path === path);
    expect(tab?.isExternal).toBe(true);
    expect(get(errorToast)).toBeNull();
  });

  it("still surfaces the standard error toast (and no unhandled rejection) when the grant fails and the fallback read is rejected", async () => {
    vi.mocked(editorDropTargets.resolveEditorDropTarget).mockReturnValue({ paneId: null });
    vi.mocked(commands.fsExternalPathsAreDirs).mockResolvedValue([false]);
    render(App);
    await tick();

    vi.mocked(commands.fsGrantExternalFile).mockRejectedValue({
      code: "INVALID_PATH",
      message: "was not part of a recent drop onto this window",
    });
    vi.mocked(commands.fsReadFile).mockRejectedValue({
      code: "INVALID_PATH",
      message: "path escapes the workspace root",
    });

    const path = "/home/alice/outside.md";
    drop([path]);
    await flush();

    expect(get(errorToast)).toContain("Couldn't open file");
    expect(get(tabsState).tabs.find((t) => t.path === path)).toBeUndefined();
  });

  it("routes a dropped directory to importPathsInto and never grants or opens it", async () => {
    vi.mocked(editorDropTargets.resolveEditorDropTarget).mockReturnValue({ paneId: null });
    vi.mocked(commands.fsExternalPathsAreDirs).mockResolvedValue([true]);
    render(App);
    await tick();

    const dirPath = "/home/alice/a-folder";
    drop([dirPath]);
    await flush();

    expect(importExternalPaths.importPathsInto).toHaveBeenCalledWith(ROOT, [dirPath]);
    expect(commands.fsGrantExternalFile).not.toHaveBeenCalled();
    expect(get(tabsState).tabs.find((t) => t.path === dirPath)).toBeUndefined();
  });

  it("grants each of several dropped files before its own open, each pair in order", async () => {
    vi.mocked(editorDropTargets.resolveEditorDropTarget).mockReturnValue({ paneId: null });
    const pathA = "/home/alice/a.md";
    const pathB = "/home/alice/b.md";
    vi.mocked(commands.fsExternalPathsAreDirs).mockResolvedValue([false, false]);

    const calls: string[] = [];
    vi.mocked(commands.fsGrantExternalFile).mockImplementation(async (_ws: string, path: string) => {
      calls.push(`grant:${path}`);
    });
    vi.mocked(commands.fsReadFile).mockImplementation(async (_ws: string, path: string) => {
      calls.push(`read:${path}`);
      return "content";
    });

    render(App);
    await tick();

    drop([pathA, pathB]);
    await flush();

    // file N's grant call always precedes file N's own read call — the
    // frontend's own reads may race each other (fire-and-forget), so only
    // the per-file ordering is asserted, not the interleaving across files.
    expect(calls.indexOf("grant:" + pathA)).toBeLessThan(calls.indexOf("read:" + pathA));
    expect(calls.indexOf("grant:" + pathB)).toBeLessThan(calls.indexOf("read:" + pathB));
    expect(get(tabsState).tabs.map((t) => t.path)).toEqual(expect.arrayContaining([pathA, pathB]));
  });

  // Both split-pane tests below pre-seed a real two-leaf tree so the dropped-
  // on pane id names an actual, existing leaf: naming a nonexistent id would
  // instead be caught by App.svelte's own pane-tree reconciliation effect,
  // which creates a fresh first pane whenever $focusedEditorPaneId names one
  // that doesn't exist — not a bug, just not what this test means to cover.
  function seedTwoPaneSplit(): void {
    editorPaneTree.set({
      type: "split",
      id: "split-1",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", id: "pane-a", tabs: [], activeTabPath: null },
        { type: "leaf", id: "pane-b", tabs: [], activeTabPath: null },
      ],
    });
    focusedEditorPaneId.set("pane-a");
  }

  it("sets focusedEditorPaneId to the specific dropped-on pane before opening, for an in-workspace file", async () => {
    seedTwoPaneSplit();
    vi.mocked(editorDropTargets.resolveEditorDropTarget).mockReturnValue({ paneId: "pane-b" });
    vi.mocked(commands.fsExternalPathsAreDirs).mockResolvedValue([false]);
    render(App);
    await tick();

    drop([`${ROOT}/notes.md`]);
    await flush();

    expect(get(focusedEditorPaneId)).toBe("pane-b");
  });

  it("sets focusedEditorPaneId to the specific dropped-on pane before opening, for a granted external file", async () => {
    seedTwoPaneSplit();
    vi.mocked(editorDropTargets.resolveEditorDropTarget).mockReturnValue({ paneId: "pane-b" });
    vi.mocked(commands.fsExternalPathsAreDirs).mockResolvedValue([false]);
    render(App);
    await tick();

    drop(["/home/alice/outside.md"]);
    await flush();

    expect(get(focusedEditorPaneId)).toBe("pane-b");
  });

  it("never touches the editor path when the drop resolves to the explorer instead", async () => {
    vi.mocked(explorerDropTargets.resolveExplorerDropTargetDir).mockReturnValue(`${ROOT}/src`);
    render(App);
    await tick();

    drop(["/home/alice/dropped.md"]);
    await flush();

    expect(importExternalPaths.importPathsInto).toHaveBeenCalledWith(`${ROOT}/src`, ["/home/alice/dropped.md"]);
    expect(commands.fsGrantExternalFile).not.toHaveBeenCalled();
    expect(editorDropTargets.resolveEditorDropTarget).not.toHaveBeenCalled();
  });

  it("leaves the terminal's existing paste-path behavior unaffected when neither the explorer nor the editor claims the drop", async () => {
    render(App);
    await tick();

    drop(["/home/alice/dropped.md"]);
    await flush();

    expect(terminalDropTargets.insertPathsAtScreenPoint).toHaveBeenCalled();
    expect(commands.fsGrantExternalFile).not.toHaveBeenCalled();
  });
});
