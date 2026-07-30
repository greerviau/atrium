import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import { render, cleanup, screen } from "@testing-library/svelte";
import App from "../../src/App.svelte";
import { workspace, openWorkspacePath } from "../../src/lib/stores/workspace";
import { tabsState, openFile, closeTab } from "../../src/lib/stores/tabs";
import { focusedEditorPaneId, editorPaneTree } from "../../src/lib/stores/editorPanes";
import { closePrompt } from "../../src/lib/stores/closePrompt";
import { explorerVisible, standaloneExplorerVisible, terminalVisible, toggleExplorerVisible } from "../../src/lib/stores/layout";
import { standaloneWorkspaceId } from "../../src/lib/ipc/commands";
import * as commands from "../../src/lib/ipc/commands";

// The mode-aware explorer (issue #325's cold-launch plan, §7.2/§7.3, §9.3
// tests 9, 12, 15, 16): hidden by default in a single-file workspace,
// listing exactly the standalone file(s) when opened, and switching back to
// the ordinary project tree — at the project's own persisted visibility —
// the moment a folder is opened.
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
    fsWriteFile: vi.fn().mockResolvedValue(undefined),
    fsGrantExternalFile: vi.fn().mockResolvedValue(undefined),
    fsExternalPathsAreDirs: vi.fn().mockResolvedValue([false]),
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

function resetStores(): void {
  localStorage.clear();
  workspace.set({ id: "local", root: null });
  terminalVisible.set(false);
  explorerVisible.set(true);
  standaloneExplorerVisible.set(false);
  tabsState.set({ tabs: [], activeTabPath: null });
  focusedEditorPaneId.set(null);
  editorPaneTree.set(null);
  closePrompt.set(null);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

function queryWelcomeScreen() {
  return screen.queryByRole("button", { name: /open folder/i });
}

describe("App standalone explorer (issue #325)", () => {
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

  // Test 9 (§9.3) — the naive-implementation trap: a persisted
  // `explorerVisible: true` (a project-mode preference from some earlier
  // session) must NOT leak into standalone mode. Only
  // `standaloneExplorerVisible` (session-only, defaults false) governs the
  // explorer here.
  it("stays hidden in standalone mode even when the persisted project explorerVisible is true", async () => {
    explorerVisible.set(true);
    render(App);
    await flush();

    await openFile("/tmp/note.md", undefined, standaloneWorkspaceId());
    await flush();

    // The app shell (not the welcome screen) is what's actually rendering —
    // otherwise the assertions below would pass for the wrong reason.
    expect(queryWelcomeScreen()).toBeNull();
    expect(document.querySelector(".explorer")).toBeNull();
    expect(document.querySelector(".standalone-file-list")).toBeNull();
  });

  // Toggling shows exactly the standalone list, not the project tree.
  it("toggling the explorer in standalone mode shows the standalone file list, not FileTree", async () => {
    render(App);
    await flush();

    await openFile("/tmp/note.md", undefined, standaloneWorkspaceId());
    await flush();
    toggleExplorerVisible();
    await flush();

    expect(document.querySelector(".standalone-file-list")).not.toBeNull();
    expect(document.querySelector(".file-tree-stub")).toBeNull();
  });

  // Test 12 (§9.3) — project mode is unaffected: FileTree renders, gated on
  // the ordinary persisted `explorerVisible`, exactly as before this plan.
  it("project mode still renders FileTree and still honors the persisted explorerVisible", async () => {
    explorerVisible.set(false);
    render(App);
    await flush();

    await openWorkspacePath(PROJECT_A);
    await flush();

    expect(document.querySelector(".file-tree-stub")).toBeNull();

    toggleExplorerVisible();
    await flush();

    expect(document.querySelector(".file-tree-stub")).not.toBeNull();
    expect(document.querySelector(".standalone-file-list")).toBeNull();
  });

  // Test 15 (§9.3) — opening a folder from standalone mode switches the
  // explorer to the project tree at the project's own persisted visibility
  // (not whatever standalone's own toggle happened to be), and the
  // standalone tab survives the switch (already covered at the merge level
  // by App.standaloneMode.test.ts; this asserts the explorer element itself
  // switches).
  it("opening a folder from standalone mode switches the explorer to FileTree at the persisted project visibility", async () => {
    explorerVisible.set(false);
    render(App);
    await flush();

    const standalonePath = "/tmp/note.md";
    await openFile(standalonePath, undefined, standaloneWorkspaceId());
    await flush();
    toggleExplorerVisible();
    await flush();
    expect(document.querySelector(".standalone-file-list")).not.toBeNull();

    await openWorkspacePath(PROJECT_A);
    await flush();
    await flush();

    expect(document.querySelector(".standalone-file-list")).toBeNull();
    // The project's own persisted visibility (false) applies, not
    // standalone's toggled-on state.
    expect(document.querySelector(".file-tree-stub")).toBeNull();
    expect(get(tabsState).tabs.map((t) => t.path)).toContain(standalonePath);
  });

  // Test 16 (§9.3) — closing the last standalone tab with no project open
  // returns to the welcome screen and resets `standaloneExplorerVisible`,
  // so the *next* single-file open starts hidden again too.
  it("closing the last standalone tab with no root returns to the welcome screen and resets standaloneExplorerVisible", async () => {
    render(App);
    await flush();

    const standalonePath = "/tmp/note.md";
    await openFile(standalonePath, undefined, standaloneWorkspaceId());
    await flush();
    toggleExplorerVisible();
    await flush();
    expect(get(standaloneExplorerVisible)).toBe(true);

    closeTab(standalonePath);
    await flush();

    expect(queryWelcomeScreen()).not.toBeNull();
    expect(get(standaloneExplorerVisible)).toBe(false);
  });
});
