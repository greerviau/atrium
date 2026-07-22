import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import App from "../../src/App.svelte";
import { workspace } from "../../src/lib/stores/workspace";
import { terminalVisible } from "../../src/lib/stores/layout";

// App's two heaviest leaf components — FileTree (backed by real fs IPC
// calls on mount) and TerminalPane (backed by @xterm/xterm and a real PTY)
// — are stubbed the same way TerminalPanel.test.ts stubs TerminalPane.
// Everything else, including the real pane-tree state, the real
// newTerminalTab/closeTabInPane handlers, and the auto-spawn $effect under
// test, runs unmodified.
vi.mock("../../src/lib/explorer/FileTree.svelte", async () => {
  const mod = await import("./FileTreeStub.svelte");
  return { default: mod.default };
});

vi.mock("../../src/lib/terminal/TerminalPane.svelte", async () => {
  const mod = await import("./TerminalPaneStub.svelte");
  return { default: mod.default };
});

// Only the Tauri IPC boundary is mocked — every function App.svelte or its
// children call during mount that would otherwise reach `invoke`/`listen`
// and fail under jsdom (no Tauri backend). Everything else in commands.ts
// (localWorkspaceId, etc.) stays real.
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
}));

/** Resets the shared workspace/layout stores to a fresh-install baseline (no persisted layout, dock visible by default) before each case. */
function mockCommon(): void {
  localStorage.clear();
  workspace.set({ id: "local", root: null });
  terminalVisible.set(true);
}

describe("App terminal auto-spawn", () => {
  beforeEach(() => {
    mockCommon();
  });

  afterEach(() => {
    cleanup();
  });

  it("opening a fresh workspace with no persisted layout auto-spawns a session instead of showing the empty placeholder", async () => {
    // The dock is visible by default (DEFAULT_PANEL_VISIBILITY.terminalVisible)
    // and the pane tree starts null — this is a brand-new install, or any
    // workspace with no persisted terminal layout.
    workspace.set({ id: "local", root: "/projects/demo" });

    const { container } = render(App);
    await tick();
    await tick();

    expect(container.querySelector(".terminal-empty")).toBeNull();
    expect(container.querySelectorAll(".terminal-pane-stub")).toHaveLength(1);
  });

  it("closing the dock's last remaining tab respawns a session instead of leaving the empty placeholder", async () => {
    workspace.set({ id: "local", root: "/projects/demo" });

    const { container } = render(App);
    await tick();
    await tick();
    expect(container.querySelectorAll(".terminal-pane-stub")).toHaveLength(1);

    const closeButton = container.querySelector('.terminal-area button[aria-label="Close terminal"]');
    expect(closeButton).not.toBeNull();
    await fireEvent.click(closeButton!);
    await tick();
    await tick();

    expect(container.querySelector(".terminal-empty")).toBeNull();
    expect(container.querySelectorAll(".terminal-pane-stub")).toHaveLength(1);
  });

  it("toggling the dock hidden then visible still auto-spawns a session (control case)", async () => {
    workspace.set({ id: "local", root: "/projects/demo" });
    terminalVisible.set(false);

    const { container } = render(App);
    await tick();
    expect(container.querySelectorAll(".terminal-pane-stub")).toHaveLength(0);

    terminalVisible.set(true);
    await tick();
    await tick();

    expect(container.querySelector(".terminal-empty")).toBeNull();
    expect(container.querySelectorAll(".terminal-pane-stub")).toHaveLength(1);
  });
});
