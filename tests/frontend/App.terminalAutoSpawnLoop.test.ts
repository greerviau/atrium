import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import App from "../../src/App.svelte";
import { workspace } from "../../src/lib/stores/workspace";
import { terminalVisible } from "../../src/lib/stores/layout";
import { mountLog } from "./mountLog";

// Regression coverage for the auto-spawn effect (App.terminalAutoSpawn.test.ts)
// respawning a session whose own shell exits immediately after starting,
// which — without a guard — turns into an unbounded spawn/exit loop: the
// effect spawns a replacement for every empty tree, TerminalPane's onExit
// closes the tab, the tree goes empty again, and so on. Stubs TerminalPane
// with one that always exits itself right after mounting (see
// ExitingTerminalPaneStub.svelte) and counts spawn attempts via mountLog,
// the same shared counter TerminalPanelStub already uses for mount/destroy
// assertions elsewhere.
vi.mock("../../src/lib/explorer/FileTree.svelte", async () => {
  const mod = await import("./FileTreeStub.svelte");
  return { default: mod.default };
});

vi.mock("../../src/lib/terminal/TerminalPane.svelte", async () => {
  const mod = await import("./ExitingTerminalPaneStub.svelte");
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

async function settle(ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await tick();
  }
}

describe("App terminal auto-spawn — exit loop guard", () => {
  beforeEach(() => {
    localStorage.clear();
    workspace.set({ id: "local", root: null });
    terminalVisible.set(true);
    mountLog.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  it("a session that exits immediately after spawning respawns exactly once, not forever", async () => {
    workspace.set({ id: "local", root: "/projects/demo" });

    const { container } = render(App);
    await settle(40);

    const spawns = mountLog.filter((entry) => entry.startsWith("spawn:"));
    expect(spawns).toHaveLength(1);
    expect(container.querySelector(".terminal-empty")).not.toBeNull();
  });

  it("toggling the dock after an immediate exit gets exactly one fresh attempt, not a fresh cascade", async () => {
    workspace.set({ id: "local", root: "/projects/demo" });

    render(App);
    await settle(10);
    expect(mountLog.filter((entry) => entry.startsWith("spawn:"))).toHaveLength(1);

    terminalVisible.set(false);
    await tick();
    terminalVisible.set(true);
    await settle(10);

    expect(mountLog.filter((entry) => entry.startsWith("spawn:"))).toHaveLength(2);
  });
});
