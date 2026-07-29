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

// Cold-launch / already-running-at-welcome-screen open (issue #325): a file
// handed to Atrium by the OS (Finder's Open With, a double-click, a Dock
// pick) with no project workspace open must land as a standalone tab, never
// leave the app sitting on WelcomeScreen. Two independent deliveries exist
// for the same data — Rust's `RunEvent::Opened` handler both stashes every
// path into `pending_open` (drained once, at mount, via
// `workspaceTakePendingOpen`) and emits it live (`onDockOpenPath`) — because
// nothing in this repo can observe, from Linux, which of the two actually
// wins the race against a cold launch's own startup latency. Both delivery
// shapes are exercised here so a regression in either one is caught
// regardless of which shape production actually hits.
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

describe("App OS-open on cold launch / at the welcome screen (issue #325)", () => {
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

  // The cold-launch shape: Rust's `RunEvent::Opened` handler ran (and
  // stashed the path into `pending_open`) before the frontend ever asked —
  // the plausible ordering when the file-open is what triggered the process
  // to start at all. `workspaceTakePendingOpen`'s one-shot drain at mount is
  // the only thing that can recover this; if it silently found nothing (or
  // its result was ignored), the app is left on WelcomeScreen forever, since
  // nothing else ever re-checks `pending_open`.
  it("opens a path already sitting in the pending-open queue at mount as a standalone tab, not WelcomeScreen", async () => {
    const path = "/tmp/cold-launch.md";
    vi.mocked(commands.workspaceTakePendingOpen).mockResolvedValue([path]);

    render(App);
    await flush();

    expect(get(tabsState).tabs.map((t) => t.path)).toContain(path);
    expect(get(tabsState).tabs.find((t) => t.path === path)?.workspaceId).toBe(standaloneWorkspaceId());
    expect(get(workspace).root).toBeNull();
    expect(queryWelcomeScreen()).toBeNull();
  });

  // The already-running shape (also named explicitly in the original
  // analysis as a distinct trigger from cold launch): nothing was pending at
  // mount, but the OS event's live emit reaches the listener afterward —
  // this is the path the human confirmed already works, kept here as a
  // regression guard so a future change to the mount sequencing can't break
  // it while fixing the cold-launch shape above.
  it("opens a path delivered only via the live listener after mount as a standalone tab, not WelcomeScreen", async () => {
    const path = "/tmp/already-running.md";
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

  // Multiple files opened at once from Finder on a cold launch (a
  // multi-select "Open With Atrium") must all land as tabs, in arrival
  // order — the Rust side batches every url from one `RunEvent::Opened`
  // into a single `pending_open` extend and a single `recent_os_open` set
  // (`macos_dock::open_paths`'s own doc comment), so the frontend's drain
  // must fan them all out rather than only handling the first.
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
});
