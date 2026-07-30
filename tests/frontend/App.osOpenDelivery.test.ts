import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import { render, cleanup, screen } from "@testing-library/svelte";
import App from "../../src/App.svelte";
import { workspace } from "../../src/lib/stores/workspace";
import { terminalVisible } from "../../src/lib/stores/layout";
import { tabsState } from "../../src/lib/stores/tabs";
import { focusedEditorPaneId, editorPaneTree } from "../../src/lib/stores/editorPanes";
import { closePrompt } from "../../src/lib/stores/closePrompt";
import { standaloneWorkspaceId } from "../../src/lib/ipc/commands";
import * as commands from "../../src/lib/ipc/commands";
import * as events from "../../src/lib/ipc/events";

// The frontend half of OS-open delivery (issue #325's cold-launch plan,
// §4.4/§9.3 tests 13-14): given a path, by either of the two mechanisms
// Rust's `launch_open` module can use to deliver one — a path already
// sitting in the pending-open queue at mount (`workspaceTakePendingOpen`),
// or one emitted live on `dock:open-path` after mount — the frontend opens
// it as a standalone tab and the welcome screen is gone. This file does
// NOT reproduce a cold launch: the actual bug (paths silently discarded
// before Rust's own queue existed to hold them) lived entirely on the Rust
// side and is covered there, in `launch_open`'s own unit tests. What these
// tests establish is the invariant the plan calls out explicitly — cold
// and warm delivery must converge on identical frontend state, so a
// regression in either delivery mechanism is caught regardless of which
// one production actually exercises for a given launch.
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
    workspaceRecordRecentFile: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../src/lib/ipc/events", () => ({
  onFsChanged: vi.fn().mockResolvedValue(() => {}),
  onMenuEvent: vi.fn().mockResolvedValue(() => {}),
  onDockOpenPath: vi.fn().mockResolvedValue(() => {}),
  onCloseRequested: vi.fn().mockResolvedValue(() => {}),
  onDragDropEvent: vi.fn().mockResolvedValue(() => {}),
}));

function queryWelcomeScreen() {
  return screen.queryByRole("button", { name: /open folder/i });
}

function resetStores(): void {
  localStorage.clear();
  workspace.set({ id: "local", root: null });
  terminalVisible.set(false);
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

describe("App OS-open delivery (issue #325)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(commands.workspaceGetRecents).mockResolvedValue([]);
    vi.mocked(commands.fsReadFile).mockResolvedValue("content\n");
    vi.mocked(commands.fsExternalPathsAreDirs).mockResolvedValue([false]);
    vi.mocked(events.onDockOpenPath).mockResolvedValue(() => {});
    resetStores();
  });

  afterEach(() => {
    cleanup();
  });

  // Test 13 (§9.3) — the drain path: a path Rust already has queued (the
  // shape `launch_open::take_pending_open` returns for anything recorded
  // before the frontend declared itself ready) is opened as a standalone
  // tab at mount, and the welcome screen never shows.
  it("opens a path already sitting in the pending-open queue at mount as a standalone tab, not WelcomeScreen", async () => {
    const path = "/tmp/queued.md";
    vi.mocked(commands.workspaceTakePendingOpen).mockResolvedValue([path]);

    render(App);
    await flush();

    expect(get(tabsState).tabs.map((t) => t.path)).toContain(path);
    expect(get(tabsState).tabs.find((t) => t.path === path)?.workspaceId).toBe(standaloneWorkspaceId());
    expect(get(workspace).root).toBeNull();
    expect(queryWelcomeScreen()).toBeNull();
  });

  // Test 14 (§9.3) — the live-listener path: nothing was queued at mount,
  // but the OS-open event reaches the frontend afterward, e.g. because the
  // frontend was already up and ready when Rust observed it. Asserts the
  // same end state as the drain test above — the cold/warm convergence
  // invariant §7.3 of the plan calls out explicitly.
  it("opens a path delivered only via the live listener after mount as a standalone tab, not WelcomeScreen", async () => {
    const path = "/tmp/live.md";
    vi.mocked(commands.workspaceTakePendingOpen).mockResolvedValue([]);
    let liveHandler: ((path: string) => void) | undefined;
    vi.mocked(events.onDockOpenPath).mockImplementation(async (handler) => {
      liveHandler = handler;
      return () => {};
    });

    render(App);
    await flush();
    expect(get(tabsState).tabs).toHaveLength(0);

    if (!liveHandler) throw new Error("expected onDockOpenPath to have been registered by App.svelte's onMount");
    liveHandler(path);
    await flush();

    expect(get(tabsState).tabs.map((t) => t.path)).toContain(path);
    expect(get(tabsState).tabs.find((t) => t.path === path)?.workspaceId).toBe(standaloneWorkspaceId());
    expect(get(workspace).root).toBeNull();
    expect(queryWelcomeScreen()).toBeNull();
  });

  // A multi-select "Open With Atrium" batches every path into one drain;
  // the frontend must fan all of them out, in arrival order, not just open
  // the first.
  it("opens every path from a multi-file pending-open drain, not just the first", async () => {
    const pathA = "/tmp/a.md";
    const pathB = "/tmp/b.md";
    vi.mocked(commands.workspaceTakePendingOpen).mockResolvedValue([pathA, pathB]);

    render(App);
    // Two files means two links in the serialized `osOpenChain`, each with
    // its own multi-step async pipeline (classify, grant, read) — one
    // `flush()`'s worth of microtask ticks is calibrated for a single path
    // elsewhere in this file, so the second file here needs a second round.
    await flush();
    await flush();

    const openedPaths = get(tabsState).tabs.map((t) => t.path);
    expect(openedPaths).toContain(pathA);
    expect(openedPaths).toContain(pathB);
    expect(queryWelcomeScreen()).toBeNull();
  });

  // A path that no longer exists by the time the frontend actually reads it
  // (deleted between the OS event and the drain) must not silently strand
  // the app on WelcomeScreen with no explanation — `openFileReportingErrors`
  // already routes a failed read through the standard error toast, so this
  // asserts that existing behavior still fires for this call site
  // specifically, rather than the failure being swallowed a second time.
  it("surfaces an error toast, rather than silently doing nothing, for a pending path that fails to open", async () => {
    const path = "/tmp/vanished.md";
    vi.mocked(commands.workspaceTakePendingOpen).mockResolvedValue([path]);
    vi.mocked(commands.fsReadFile).mockRejectedValue(new Error("not found"));

    render(App);
    await flush();

    expect(get(tabsState).tabs.map((t) => t.path)).not.toContain(path);
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  // Regression coverage for the human's fourth reported follow-on defect:
  // "it doesnt save these cold start workspaces to the recent workspaces."
  // `doHandleOsOpenPath`'s file branch now goes through `openExternalFile`,
  // which records a standalone open to the recents list — this is the
  // frontend half of that; `recents.rs`'s own unit tests (and the
  // `require_recent_external_open` gate they exercise indirectly) cover the
  // Rust-side provenance requirement this call is gated on.
  it("records a cold-launched standalone file to the recents list", async () => {
    const path = "/repo/src-tauri/Cargo.lock";
    vi.mocked(commands.workspaceTakePendingOpen).mockResolvedValue([path]);

    render(App);
    await flush();

    expect(get(workspace).root).toBeNull();
    expect(commands.workspaceRecordRecentFile).toHaveBeenCalledWith(path);
  });

  // A folder open is recorded by `workspace_set_root` on the Rust side
  // already (unconditionally, for every "open a folder" action) — the new
  // `workspaceRecordRecentFile` call exists specifically for the file
  // branch `workspace_set_root` never sees, and must not double-record a
  // directory open.
  it("does not call workspaceRecordRecentFile for a directory open", async () => {
    const path = "/repo/project";
    vi.mocked(commands.workspaceTakePendingOpen).mockResolvedValue([path]);
    vi.mocked(commands.fsExternalPathsAreDirs).mockResolvedValue([true]);

    render(App);
    await flush();

    expect(commands.workspaceRecordRecentFile).not.toHaveBeenCalled();
  });

  // A file opened externally while a project is already open becomes an
  // ordinary local tab (not a standalone workspace) — recording it to the
  // recents *workspaces* list would be wrong; `recentFiles.ts` is the
  // existing, separate mechanism for "recently opened files" within a
  // project.
  it("does not record an externally-opened file to recents when a project is already open", async () => {
    workspace.set({ id: "local", root: "/repo/project" });
    const path = "/elsewhere/notes.md";
    vi.mocked(commands.workspaceTakePendingOpen).mockResolvedValue([path]);

    render(App);
    await flush();

    expect(commands.workspaceRecordRecentFile).not.toHaveBeenCalled();
  });
});
