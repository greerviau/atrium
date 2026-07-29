import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import App from "../../src/App.svelte";
import { workspace } from "../../src/lib/stores/workspace";
import { terminalVisible } from "../../src/lib/stores/layout";
import { tabsState, openFile } from "../../src/lib/stores/tabs";
import { errorToast } from "../../src/lib/stores/errorToast";
import { focusedEditorPaneId, editorPaneTree } from "../../src/lib/stores/editorPanes";
import { onFsChanged } from "../../src/lib/ipc/events";

// Drives App.svelte's real fs:changed handler (App.svelte's onMount) to
// cover the actual routing this PR's fix depends on: a "remove"-kind event
// must reach markPathDeleted, not reconcileExternalChange. Everything else
// in the handler's dependency graph is real; only FileTree/TerminalPane
// (irrelevant here) and the IPC/event layer are stubbed, matching
// App.editorSplitPanes.test.ts's own scaffolding.
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
  };
});

vi.mock("../../src/lib/ipc/events", () => ({
  onFsChanged: vi.fn().mockResolvedValue(() => {}),
  onMenuEvent: vi.fn().mockResolvedValue(() => {}),
  onDockOpenPath: vi.fn().mockResolvedValue(() => {}),
  onCloseRequested: vi.fn().mockResolvedValue(() => {}),
  onDragDropEvent: vi.fn().mockResolvedValue(() => {}),
}));

function resetStores(): void {
  localStorage.clear();
  workspace.set({ id: "local", root: null });
  terminalVisible.set(false);
  tabsState.set({ tabs: [], activeTabPath: null });
  focusedEditorPaneId.set(null);
  editorPaneTree.set(null);
  errorToast.set(null);
}

function fsChangedHandler(): (event: { path: string; kind: string; fromPath?: string }) => void {
  const handler = vi.mocked(onFsChanged).mock.calls.at(-1)?.[0];
  if (!handler) throw new Error("expected onFsChanged to have been called by App.svelte's onMount");
  return handler as (event: { path: string; kind: string; fromPath?: string }) => void;
}

describe("App fs:changed routing (issue #253)", () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(() => {
    cleanup();
  });

  it("a remove-kind event closes a clean open tab and toasts", async () => {
    workspace.set({ id: "local", root: "/projects/demo" });
    render(App);
    await tick();

    await openFile("/projects/demo/notes.md");
    await tick();
    expect(get(tabsState).tabs.map((t) => t.path)).toEqual(["/projects/demo/notes.md"]);

    fsChangedHandler()({ path: "/projects/demo/notes.md", kind: "remove" });
    await tick();

    expect(get(tabsState).tabs).toHaveLength(0);
    expect(get(errorToast)).toBe("notes.md was deleted — its tab was closed.");
  });

  it("a remove-kind event flags a dirty open tab isDeleted instead of closing it", async () => {
    workspace.set({ id: "local", root: "/projects/demo" });
    render(App);
    await tick();

    await openFile("/projects/demo/notes.md");
    await tick();
    tabsState.update((s) => ({
      ...s,
      tabs: s.tabs.map((t) => ({ ...t, isDirty: true })),
    }));

    fsChangedHandler()({ path: "/projects/demo/notes.md", kind: "remove" });
    await tick();

    const tabs = get(tabsState).tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].isDeleted).toBe(true);
    expect(tabs[0].isDirty).toBe(true);
  });

  it("a rename-kind event with a paired fromPath re-keys the open tab to the new path (issue #249, mechanism 2)", async () => {
    workspace.set({ id: "local", root: "/projects/demo" });
    render(App);
    await tick();

    await openFile("/projects/demo/notes.md");
    await tick();

    fsChangedHandler()({
      path: "/projects/demo/notes-renamed.md",
      kind: "rename",
      fromPath: "/projects/demo/notes.md",
    });
    await tick();

    expect(get(tabsState).tabs.map((t) => t.path)).toEqual(["/projects/demo/notes-renamed.md"]);
  });

  it("a rename-kind event with no fromPath (an unpaired rename half never reaches the frontend, but this guards the fallback) falls through to reconcileExternalChange instead of guessing", async () => {
    workspace.set({ id: "local", root: "/projects/demo" });
    render(App);
    await tick();

    await openFile("/projects/demo/notes.md");
    await tick();

    fsChangedHandler()({ path: "/projects/demo/notes.md", kind: "rename" });
    await tick();

    // No fromPath means no rekey — the tab stays exactly where it was.
    expect(get(tabsState).tabs.map((t) => t.path)).toEqual(["/projects/demo/notes.md"]);
  });
});
