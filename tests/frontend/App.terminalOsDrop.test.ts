import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";
import { get } from "svelte/store";
import { render, cleanup } from "@testing-library/svelte";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import App from "../../src/App.svelte";
import { workspace } from "../../src/lib/stores/workspace";
import { terminalVisible } from "../../src/lib/stores/layout";
import * as terminalDropTargets from "../../src/lib/terminal/terminalDropTargets";
import * as explorerDropTargets from "../../src/lib/explorer/explorerDropTargets";
import * as importExternalPaths from "../../src/lib/explorer/importExternalPaths";
import { dragOverTargetDir, draggingPath } from "../../src/lib/explorer/explorerDrag";
import type { DragDropEvent } from "@tauri-apps/api/webview";

// App's two heaviest leaf components, stubbed the same way
// App.terminalAutoSpawn.test.ts stubs them — everything else, including the
// real onMount wiring under test, runs unmodified.
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

// A non-null workspace root keeps App rendering the terminal/editor shell
// instead of WelcomeScreen, which calls workspaceGetRecents() (real IPC,
// unmocked here) on mount.
function resetStores(): void {
  localStorage.clear();
  workspace.set({ id: "local", root: "/projects/demo" });
  terminalVisible.set(true);
}

describe("App OS-level file drop wiring", () => {
  beforeEach(() => {
    resetStores();
    capturedDragDropHandler = undefined;
    vi.mocked(explorerDropTargets.resolveExplorerDropTargetDir).mockReturnValue(null);
    dragOverTargetDir.set(null);
    draggingPath.set(null);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("registers exactly one onDragDropEvent handler on mount", async () => {
    const events = await import("../../src/lib/ipc/events");
    render(App);
    await tick();

    expect(events.onDragDropEvent).toHaveBeenCalledTimes(1);
    expect(capturedDragDropHandler).toBeInstanceOf(Function);
  });

  it("a type: 'drop' payload is hit-tested at the correctly scaled logical coordinates", async () => {
    render(App);
    await tick();

    const originalDpr = window.devicePixelRatio;
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });

    const position = new PhysicalPosition(400, 500);
    capturedDragDropHandler?.({ type: "drop", paths: ["/a/b"], position });

    expect(terminalDropTargets.insertPathsAtScreenPoint).toHaveBeenCalledWith(["/a/b"], 200, 250);

    Object.defineProperty(window, "devicePixelRatio", { value: originalDpr, configurable: true });
  });

  it("never calls insertPathsAtScreenPoint for enter/over/leave payloads", async () => {
    render(App);
    await tick();

    const position = new PhysicalPosition(100, 100);
    capturedDragDropHandler?.({ type: "enter", paths: ["/a/b"], position });
    capturedDragDropHandler?.({ type: "over", position });
    capturedDragDropHandler?.({ type: "leave" });

    expect(terminalDropTargets.insertPathsAtScreenPoint).not.toHaveBeenCalled();
  });

  it("imports into the explorer's resolved directory instead of falling back to the terminal path when a drop lands on the explorer", async () => {
    vi.mocked(explorerDropTargets.resolveExplorerDropTargetDir).mockReturnValue("/projects/demo/src");
    render(App);
    await tick();

    const position = new PhysicalPosition(100, 100);
    capturedDragDropHandler?.({ type: "drop", paths: ["/a/b"], position });

    expect(importExternalPaths.importPathsInto).toHaveBeenCalledWith("/projects/demo/src", ["/a/b"]);
    expect(terminalDropTargets.insertPathsAtScreenPoint).not.toHaveBeenCalled();
  });

  it("falls back to the terminal hit test unchanged when a drop resolves to no explorer directory", async () => {
    vi.mocked(explorerDropTargets.resolveExplorerDropTargetDir).mockReturnValue(null);
    render(App);
    await tick();

    const position = new PhysicalPosition(100, 100);
    capturedDragDropHandler?.({ type: "drop", paths: ["/a/b"], position });

    expect(terminalDropTargets.insertPathsAtScreenPoint).toHaveBeenCalled();
    expect(importExternalPaths.importPathsInto).not.toHaveBeenCalled();
  });

  it("sets dragOverTargetDir to the resolved directory on 'enter'", async () => {
    vi.mocked(explorerDropTargets.resolveExplorerDropTargetDir).mockReturnValue("/projects/demo/src");
    render(App);
    await tick();

    capturedDragDropHandler?.({ type: "enter", paths: ["/a/b"], position: new PhysicalPosition(100, 100) });

    expect(get(dragOverTargetDir)).toBe("/projects/demo/src");
  });

  it("sets dragOverTargetDir to the resolved directory on 'over', independent of a prior 'enter'", async () => {
    vi.mocked(explorerDropTargets.resolveExplorerDropTargetDir).mockReturnValue("/projects/demo/src");
    render(App);
    await tick();

    capturedDragDropHandler?.({ type: "over", position: new PhysicalPosition(100, 100) });

    expect(get(dragOverTargetDir)).toBe("/projects/demo/src");
  });

  it("clears dragOverTargetDir on 'enter'/'over' once the pointer moves off the explorer", async () => {
    vi.mocked(explorerDropTargets.resolveExplorerDropTargetDir).mockReturnValue("/projects/demo/src");
    render(App);
    await tick();

    capturedDragDropHandler?.({ type: "enter", paths: ["/a/b"], position: new PhysicalPosition(100, 100) });
    expect(get(dragOverTargetDir)).toBe("/projects/demo/src");

    vi.mocked(explorerDropTargets.resolveExplorerDropTargetDir).mockReturnValue(null);
    capturedDragDropHandler?.({ type: "over", position: new PhysicalPosition(500, 500) });

    expect(get(dragOverTargetDir)).toBeNull();
  });

  it("clears dragOverTargetDir unconditionally on 'leave'", async () => {
    vi.mocked(explorerDropTargets.resolveExplorerDropTargetDir).mockReturnValue("/projects/demo/src");
    render(App);
    await tick();

    capturedDragDropHandler?.({ type: "enter", paths: ["/a/b"], position: new PhysicalPosition(100, 100) });
    expect(get(dragOverTargetDir)).toBe("/projects/demo/src");

    capturedDragDropHandler?.({ type: "leave" });

    expect(get(dragOverTargetDir)).toBeNull();
  });

  it("clears dragOverTargetDir on 'drop' whether it resolved to the explorer or fell back to the terminal", async () => {
    vi.mocked(explorerDropTargets.resolveExplorerDropTargetDir).mockReturnValue("/projects/demo/src");
    render(App);
    await tick();

    capturedDragDropHandler?.({ type: "enter", paths: ["/a/b"], position: new PhysicalPosition(100, 100) });
    expect(get(dragOverTargetDir)).toBe("/projects/demo/src");

    capturedDragDropHandler?.({ type: "drop", paths: ["/a/b"], position: new PhysicalPosition(100, 100) });
    expect(get(dragOverTargetDir)).toBeNull();

    vi.mocked(explorerDropTargets.resolveExplorerDropTargetDir).mockReturnValue("/projects/demo/src");
    capturedDragDropHandler?.({ type: "enter", paths: ["/a/b"], position: new PhysicalPosition(100, 100) });
    expect(get(dragOverTargetDir)).toBe("/projects/demo/src");

    vi.mocked(explorerDropTargets.resolveExplorerDropTargetDir).mockReturnValue(null);
    capturedDragDropHandler?.({ type: "drop", paths: ["/a/b"], position: new PhysicalPosition(100, 100) });
    expect(get(dragOverTargetDir)).toBeNull();
  });

  it("clears a stale dragOverTargetDir when the window loses focus mid-OS-drag", async () => {
    vi.mocked(explorerDropTargets.resolveExplorerDropTargetDir).mockReturnValue("/projects/demo/src");
    render(App);
    await tick();

    capturedDragDropHandler?.({ type: "enter", paths: ["/a/b"], position: new PhysicalPosition(100, 100) });
    expect(get(dragOverTargetDir)).toBe("/projects/demo/src");

    window.dispatchEvent(new Event("blur"));

    expect(get(dragOverTargetDir)).toBeNull();
  });

  it("does not clear dragOverTargetDir on blur while an internal pointer-drag is in flight", async () => {
    render(App);
    await tick();

    draggingPath.set("/projects/demo/src/foo.ts");
    dragOverTargetDir.set("/projects/demo/src");

    window.dispatchEvent(new Event("blur"));

    expect(get(dragOverTargetDir)).toBe("/projects/demo/src");

    draggingPath.set(null);
  });
});
