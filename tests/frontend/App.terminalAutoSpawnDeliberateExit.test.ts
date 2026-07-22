import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import App from "../../src/App.svelte";
import { workspace } from "../../src/lib/stores/workspace";
import { terminalVisible } from "../../src/lib/stores/layout";
import { setDefaultSimulateElapsedMs, DEFAULT_SIMULATE_ELAPSED_MS } from "./TerminalPaneStub.svelte";

// Regression coverage for issue #118: a shell the user worked in for a
// while and then deliberately exited (typing `exit` or Ctrl-D) must
// respawn a fresh session, the same way closing the last tab does —
// unlike App.terminalAutoSpawnLoop.test.ts's crash-loop case, which must
// stay suppressed. Stubbing convention matches App.terminalAutoSpawn.test.ts:
// FileTree and TerminalPane stubbed, everything else (the real pane tree,
// real handlers, and the real auto-spawn $effect) runs unmodified.
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

vi.mock("../../src/lib/ipc/events", () => ({
  onFsChanged: vi.fn().mockResolvedValue(() => {}),
  onMenuEvent: vi.fn().mockResolvedValue(() => {}),
  onDockOpenPath: vi.fn().mockResolvedValue(() => {}),
  onCloseRequested: vi.fn().mockResolvedValue(() => {}),
  onDragDropEvent: vi.fn().mockResolvedValue(() => {}),
}));

function resetStores(): void {
  localStorage.clear();
  workspace.set({ id: "local", root: "/projects/demo" });
  terminalVisible.set(true);
}

async function spawnInitialSession(container: HTMLElement): Promise<void> {
  await tick();
  await tick();
  expect(container.querySelectorAll(".terminal-pane-stub")).toHaveLength(1);
}

describe("App terminal auto-spawn — deliberate exit", () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(() => {
    cleanup();
    setDefaultSimulateElapsedMs(DEFAULT_SIMULATE_ELAPSED_MS);
  });

  it("a session exiting well above the crash-exit window respawns instead of leaving the empty placeholder", async () => {
    const { container } = render(App);
    await spawnInitialSession(container);

    // TerminalPaneStub's exit button defaults simulateElapsedMs to
    // DEFAULT_SIMULATE_ELAPSED_MS, well above CRASH_EXIT_WINDOW_MS — models
    // a shell the user worked in and then deliberately exited.
    const exitButton = container.querySelector(".terminal-pane-stub-exit");
    expect(exitButton).not.toBeNull();
    await fireEvent.click(exitButton!);
    await tick();
    await tick();

    expect(container.querySelector(".terminal-empty")).toBeNull();
    expect(container.querySelectorAll(".terminal-pane-stub")).toHaveLength(1);
  });

  it("a session exiting just under the crash-exit window still suppresses auto-spawn", async () => {
    setDefaultSimulateElapsedMs(999);
    const { container } = render(App);
    await spawnInitialSession(container);

    const exitButton = container.querySelector(".terminal-pane-stub-exit");
    expect(exitButton).not.toBeNull();
    await fireEvent.click(exitButton!);
    await tick();
    await tick();

    expect(container.querySelector(".terminal-empty")).not.toBeNull();
    expect(container.querySelectorAll(".terminal-pane-stub")).toHaveLength(0);
  });

  it("toggling the dock after a deliberate exit still respawns on toggle (control case)", async () => {
    const { container } = render(App);
    await spawnInitialSession(container);

    const exitButton = container.querySelector(".terminal-pane-stub-exit");
    await fireEvent.click(exitButton!);
    await tick();
    await tick();
    expect(container.querySelector(".terminal-empty")).toBeNull();

    terminalVisible.set(false);
    await tick();
    terminalVisible.set(true);
    await tick();
    await tick();

    expect(container.querySelector(".terminal-empty")).toBeNull();
    expect(container.querySelectorAll(".terminal-pane-stub")).toHaveLength(1);
  });
});
