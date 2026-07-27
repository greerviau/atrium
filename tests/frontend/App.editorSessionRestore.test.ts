import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import { render, cleanup } from "@testing-library/svelte";
import App from "../../src/App.svelte";
import { workspace, openWorkspacePath } from "../../src/lib/stores/workspace";
import { terminalVisible } from "../../src/lib/stores/layout";
import { tabsState, openFile } from "../../src/lib/stores/tabs";
import { focusedEditorPaneId, editorPaneTree } from "../../src/lib/stores/editorPanes";
import { closePrompt } from "../../src/lib/stores/closePrompt";
import { loadEditorSession } from "../../src/lib/stores/editorSession";
import * as commands from "../../src/lib/ipc/commands";

// Reproduces the cross-project restore race flagged in review of #324:
// restoreEditorSession's own fsReadFile calls for a stale root could resolve
// *after* a later project switch already started, applying a superseded
// project's tabs/pane tree on top of the current project's state and then
// persisting that stale tree under the current project's own storage key.
// Uses the same real-App-mount harness as App.workspaceSwitch.test.ts.
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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
}

describe("App editor session restore (review of #324)", () => {
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

  it("restores a persisted session on open, and later changes persist under the same root", async () => {
    localStorage.setItem(
      "atrium.editorSession." + PROJECT_A,
      JSON.stringify({
        paneTree: { type: "leaf", id: "LA", tabs: [PROJECT_A + "/a.ts"], activeTabPath: PROJECT_A + "/a.ts" },
        focusedPaneId: "LA",
      }),
    );

    render(App);
    await flush();

    // Root starts null (the real app's bootstrap state before any project
    // is opened) so this exercises a genuine null -> root transition, the
    // same one the project-switch effect observes on the very first open of
    // a session — not a root that happened to already match at mount time,
    // which the effect would treat as a no-op.
    await openWorkspacePath(PROJECT_A);
    await flush();

    expect(get(tabsState).tabs.map((t) => t.path)).toEqual([PROJECT_A + "/a.ts"]);
    expect(get(tabsState).activeTabPath).toBe(PROJECT_A + "/a.ts");
    expect(get(focusedEditorPaneId)).toBe("LA");
    expect(get(editorPaneTree)).toEqual({
      type: "leaf",
      id: "LA",
      tabs: [PROJECT_A + "/a.ts"],
      activeTabPath: PROJECT_A + "/a.ts",
    });

    await openFile(PROJECT_A + "/b.ts");
    await flush();
    // The debounced write is real-timer based; wait it out.
    await new Promise((resolve) => setTimeout(resolve, 450));

    expect(loadEditorSession(PROJECT_A)).toEqual({
      paneTree: {
        type: "leaf",
        id: "LA",
        tabs: [PROJECT_A + "/a.ts", PROJECT_A + "/b.ts"],
        activeTabPath: PROJECT_A + "/b.ts",
      },
      focusedPaneId: "LA",
    });
  });

  it("a project switch started before a stale restore resolves never applies the stale project's state or corrupts the new project's storage key", async () => {
    localStorage.setItem(
      "atrium.editorSession." + PROJECT_A,
      JSON.stringify({
        paneTree: { type: "leaf", id: "LA", tabs: [PROJECT_A + "/a.ts"], activeTabPath: PROJECT_A + "/a.ts" },
        focusedPaneId: "LA",
      }),
    );

    const gatedA = deferred<string>();
    vi.mocked(commands.fsReadFile).mockImplementation((_ws: string, path: string) => {
      if (path === PROJECT_A + "/a.ts") return gatedA.promise;
      return Promise.resolve("content\n");
    });

    render(App);
    await flush();

    // Root starts null, so this is a genuine transition — the project-switch
    // effect actually fires and starts restoreEditorSession(A), whose sole
    // fsReadFile call is gated and won't resolve until told to below.
    await openWorkspacePath(PROJECT_A);
    await flush();

    // A's restore is still awaiting its gated fsReadFile call — nothing has
    // been applied to tabsState/editorPaneTree yet.
    expect(get(workspace).root).toBe(PROJECT_A);
    expect(get(tabsState).tabs).toHaveLength(0);

    // Switch to B (never opened — no persisted session) before A's restore
    // resolves. B's own restore is a same-tick no-op (loadEditorSession(B)
    // is null), so it settles well before A's gated read ever will.
    await openWorkspacePath(PROJECT_B);
    await flush();

    expect(get(workspace).root).toBe(PROJECT_B);
    expect(get(tabsState).tabs).toHaveLength(0);
    expect(get(editorPaneTree)).toBeNull();
    expect(get(focusedEditorPaneId)).toBeNull();

    // Now let A's stale restore actually resolve.
    gatedA.resolve("stale content");
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 450));

    // The current project (B) must still show its own empty session — not
    // A's leaked tab/pane — and B's own storage key must never have been
    // written with A's pane tree.
    expect(get(workspace).root).toBe(PROJECT_B);
    expect(get(tabsState).tabs).toHaveLength(0);
    expect(get(tabsState).activeTabPath).toBeNull();
    expect(get(editorPaneTree)).toBeNull();
    expect(get(focusedEditorPaneId)).toBeNull();
    expect(loadEditorSession(PROJECT_B)).toBeNull();

    // A's own persisted session on disk is untouched by the discarded restore.
    expect(loadEditorSession(PROJECT_A)).toEqual({
      paneTree: { type: "leaf", id: "LA", tabs: [PROJECT_A + "/a.ts"], activeTabPath: PROJECT_A + "/a.ts" },
      focusedPaneId: "LA",
    });
  });
});
