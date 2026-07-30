import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import App from "../../src/App.svelte";
import { workspace } from "../../src/lib/stores/workspace";
import { terminalVisible } from "../../src/lib/stores/layout";
import { tabsState, type Tab } from "../../src/lib/stores/tabs";
import { mountLog } from "./mountLog";

// Regression coverage for the human's report: "there is no shell, just what
// looks like a button that says 'New Terminal', but I cant click it." Reaches
// the "dock visible, empty tree, but auto-respawn suppressed" state via a
// shell that exits immediately after spawning (mirrors
// App.terminalAutoSpawnLoop.test.ts's own technique) — the one state where
// only a direct button click, not the auto-spawn effect
// (App.terminalStandaloneCwd.test.ts), can produce a new session. This
// isolates the button's own click handler (newTerminalTab) and proves it is
// neither `disabled` nor a no-op in a root-less standalone workspace.
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
    workspaceTakePendingOpen: vi.fn().mockResolvedValue([]),
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

function standaloneTab(path: string): Tab {
  return {
    path,
    workspaceId: "standalone",
    mode: "code",
    savedDoc: "",
    isDirty: false,
    hasExternalConflict: false,
    isExternal: true,
    isDeleted: false,
  };
}

async function settle(ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await tick();
  }
}

describe("App terminal + New Terminal button in a root-less standalone workspace (issue #325 follow-on)", () => {
  beforeEach(() => {
    localStorage.clear();
    workspace.set({ id: "local", root: null });
    terminalVisible.set(true);
    tabsState.set({
      tabs: [standaloneTab("/repo/src-tauri/Cargo.lock")],
      activeTabPath: "/repo/src-tauri/Cargo.lock",
    });
    mountLog.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  it("is enabled, and clicking it actually spawns a session cwd'd to the active tab's directory", async () => {
    const { container } = render(App);
    await settle(10);
    // The auto-spawn effect's one attempt already exited (ExitingTerminalPaneStub),
    // and the crash-loop guard (suppressAutoSpawn) now blocks it from retrying
    // on its own — this is the dead-looking state the human hit.
    expect(mountLog.filter((entry) => entry.startsWith("spawn:"))).toHaveLength(1);
    expect(container.querySelector(".terminal-empty")).not.toBeNull();

    const button = container.querySelector<HTMLButtonElement>(".terminal-empty button.new-tab");
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(false);

    await fireEvent.click(button!);
    await settle(10);

    const spawns = mountLog.filter((entry) => entry.startsWith("spawn:"));
    expect(spawns.length).toBeGreaterThanOrEqual(2);
    expect(spawns.at(-1)).toBe("spawn:/repo/src-tauri");
  });
});
