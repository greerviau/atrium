import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import { tick } from "svelte";
import { render, fireEvent, cleanup, screen } from "@testing-library/svelte";
import App from "../../src/App.svelte";
import { workspace, openWorkspacePath } from "../../src/lib/stores/workspace";
import { terminalVisible } from "../../src/lib/stores/layout";
import { tabsState, openFile, markDirty } from "../../src/lib/stores/tabs";
import { focusedEditorPaneId, editorPaneTree } from "../../src/lib/stores/editorPanes";
import { closePrompt } from "../../src/lib/stores/closePrompt";
import * as commands from "../../src/lib/ipc/commands";

// Reproduces issue #255 against the real App.svelte wiring: only FileTree
// (backed by real fs IPC calls on mount) and TerminalPane (backed by
// @xterm/xterm and a real PTY) are stubbed, the same way
// App.terminalAutoSpawn.test.ts and App.editorSplitPanes.test.ts stub them.
// The real tabsState, editorPaneTree, terminalPaneTree, and the workspace
// switch handlers under test all run unmodified.
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
    fsReadFile: vi.fn().mockResolvedValue("content\n"),
    fsWriteFile: vi.fn().mockResolvedValue(undefined),
    workspaceSetRoot: vi.fn().mockResolvedValue(undefined),
    workspaceGetRecents: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../../src/lib/ipc/events", () => ({
  onFsChanged: vi.fn().mockResolvedValue(() => {}),
  onMenuEvent: vi.fn().mockResolvedValue(() => {}),
  onDockOpenPath: vi.fn().mockResolvedValue(() => {}),
  onCloseRequested: vi.fn().mockResolvedValue(() => {}),
  onDragDropEvent: vi.fn().mockResolvedValue(() => {}),
}));

const PROJECT_A = "/projects/a";
const PROJECT_B = "/projects/b";

function resetStores(): void {
  localStorage.clear();
  workspace.set({ id: "local", root: null });
  terminalVisible.set(true);
  tabsState.set({ tabs: [], activeTabPath: null });
  focusedEditorPaneId.set(null);
  editorPaneTree.set(null);
  closePrompt.set(null);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
  await tick();
}

describe("App workspace switch (issue #255)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(commands.workspaceSetRoot).mockResolvedValue(undefined);
    vi.mocked(commands.workspaceGetRecents).mockResolvedValue([]);
    vi.mocked(commands.fsReadFile).mockResolvedValue("content\n");
    vi.mocked(commands.fsWriteFile).mockResolvedValue(undefined);
    resetStores();
  });

  afterEach(() => {
    cleanup();
  });

  it("switching projects clears the previous project's tabs, editor panes, and terminal sessions", async () => {
    workspace.set({ id: "local", root: PROJECT_A });
    const { container } = render(App);
    await flush();

    await openFile("/a.ts");
    await flush();

    // Sanity check on project A's state before switching.
    expect(get(tabsState).tabs).toHaveLength(1);
    expect(get(editorPaneTree)).not.toBeNull();
    expect(container.querySelectorAll(".terminal-pane-stub")).toHaveLength(1);
    expect(container.querySelector(".terminal-pane-stub")?.getAttribute("data-cwd")).toBe(PROJECT_A);

    await openWorkspacePath(PROJECT_B);
    await flush();
    await flush();

    expect(get(workspace).root).toBe(PROJECT_B);

    // The stale tab and editor pane from project A are gone, not merely
    // hidden — this is the actual bug from issue #255 (a save while
    // looking at B's file tree would otherwise silently write into A).
    expect(get(tabsState).tabs).toHaveLength(0);
    expect(get(tabsState).activeTabPath).toBeNull();
    expect(get(editorPaneTree)).toBeNull();
    expect(get(focusedEditorPaneId)).toBeNull();

    // The old terminal session was torn down and a fresh one auto-spawned
    // cd'd into the new root — never both old and new coexisting.
    const stubs = container.querySelectorAll(".terminal-pane-stub");
    expect(stubs).toHaveLength(1);
    expect(stubs[0].getAttribute("data-cwd")).toBe(PROJECT_B);
  });

  it("a dirty tab blocks the switch and raises the workspace unsaved-changes prompt", async () => {
    workspace.set({ id: "local", root: PROJECT_A });
    render(App);
    await flush();

    await openFile("/dirty.ts");
    await flush();
    markDirty("/dirty.ts");

    await openWorkspacePath(PROJECT_B);
    await flush();

    expect(get(workspace).root).toBe(PROJECT_A);
    expect(commands.workspaceSetRoot).not.toHaveBeenCalled();
    expect(get(closePrompt)).toEqual({
      kind: "workspace",
      paths: ["/dirty.ts"],
      targetPath: PROJECT_B,
    });
    // Nothing was torn down while the prompt is pending.
    expect(get(tabsState).tabs).toHaveLength(1);
  });

  it("Don't Save in the workspace prompt discards the dirty tab and completes the switch", async () => {
    workspace.set({ id: "local", root: PROJECT_A });
    render(App);
    await flush();

    await openFile("/dirty.ts");
    await flush();
    markDirty("/dirty.ts");

    await openWorkspacePath(PROJECT_B);
    await flush();

    expect(await screen.findByText(/switching projects/)).toBeTruthy();

    await fireEvent.click(screen.getByText("Don't Save"));
    await flush();
    await flush();

    expect(commands.fsWriteFile).not.toHaveBeenCalled();
    expect(get(workspace).root).toBe(PROJECT_B);
    expect(get(closePrompt)).toBeNull();
    expect(get(tabsState).tabs).toHaveLength(0);
  });

  it("Save All in the workspace prompt saves the dirty tab before completing the switch", async () => {
    workspace.set({ id: "local", root: PROJECT_A });
    render(App);
    await flush();

    await openFile("/dirty.ts");
    await flush();
    markDirty("/dirty.ts");

    await openWorkspacePath(PROJECT_B);
    await flush();

    await fireEvent.click(screen.getByText("Save All"));
    await flush();
    await flush();

    expect(commands.fsWriteFile).toHaveBeenCalledWith("local", "/dirty.ts", expect.any(String));
    expect(get(workspace).root).toBe(PROJECT_B);
    expect(get(closePrompt)).toBeNull();
    expect(get(tabsState).tabs).toHaveLength(0);
  });

  it("re-selecting the already-open root is a no-op", async () => {
    workspace.set({ id: "local", root: PROJECT_A });
    render(App);
    await flush();

    await openFile("/a.ts");
    await flush();

    await openWorkspacePath(PROJECT_A);
    await flush();

    expect(commands.workspaceSetRoot).not.toHaveBeenCalled();
    expect(commands.workspaceGetRecents).not.toHaveBeenCalled();
    expect(get(tabsState).tabs).toHaveLength(1);
    expect(get(editorPaneTree)).not.toBeNull();
  });
});
