import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import App from "../../src/App.svelte";
import { workspace } from "../../src/lib/stores/workspace";
import { terminalVisible } from "../../src/lib/stores/layout";
import { tabsState, type Tab } from "../../src/lib/stores/tabs";

// Regression coverage for the human's reported follow-on defects on issue
// #325's cold-launch fix (PR #363): opening a file with no project workspace
// open left the terminal dock showing only a dead, unclickable "+ New
// Terminal" button — every terminal-creation call site (the auto-spawn
// effect, the button itself, `newTerminalTab`/`addTabToPane`/`splitPaneAt`)
// hard-required `$workspace.root`, with no fallback for a root-less
// standalone workspace. The desired behavior (matching Zed) is a live shell
// cwd'd to the directory CONTAINING the opened file, not the workspace root
// (there is none) and not the file itself.
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

function resetStores(): void {
  localStorage.clear();
  workspace.set({ id: "local", root: null });
  terminalVisible.set(true);
  tabsState.set({ tabs: [], activeTabPath: null });
}

async function settle(ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await tick();
  }
}

describe("App terminal cwd in a root-less standalone workspace (issue #325 follow-on)", () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(() => {
    cleanup();
  });

  it("auto-spawns a live session instead of leaving the dead + New Terminal placeholder up", async () => {
    tabsState.set({
      tabs: [standaloneTab("/repo/src-tauri/Cargo.lock")],
      activeTabPath: "/repo/src-tauri/Cargo.lock",
    });

    const { container } = render(App);
    await settle(3);

    expect(container.querySelector(".terminal-empty")).toBeNull();
    expect(container.querySelectorAll(".terminal-pane-stub")).toHaveLength(1);
  });

  it("cwd's the spawned session to the directory CONTAINING the opened file, not the file itself or a workspace root", async () => {
    tabsState.set({
      tabs: [standaloneTab("/repo/src-tauri/Cargo.lock")],
      activeTabPath: "/repo/src-tauri/Cargo.lock",
    });

    const { container } = render(App);
    await settle(3);

    const pane = container.querySelector(".terminal-pane-stub");
    expect(pane?.getAttribute("data-cwd")).toBe("/repo/src-tauri");
  });

  // The actual timing of the reported bug: the cold-launch drain resolves
  // asynchronously, after `App.svelte` has already mounted and its effects
  // have already run their first synchronous pass — so the standalone tab
  // is not yet in `tabsState` at render time (with zero tabs and no root,
  // the welcome screen shows, not the terminal dock at all — unaffected by
  // this fix). A fix that only resolves cwd correctly when the tab happens
  // to already be open before render would pass every test above while
  // still leaving a real cold launch stuck on the dead placeholder, exactly
  // like the human hit.
  it("picks up a standalone tab that arrives asynchronously after mount, not just one already open at render time", async () => {
    const { container } = render(App);
    await settle(3);
    expect(container.querySelectorAll(".terminal-pane-stub")).toHaveLength(0);

    tabsState.set({
      tabs: [standaloneTab("/repo/notes/todo.md")],
      activeTabPath: "/repo/notes/todo.md",
    });
    await settle(3);

    expect(container.querySelector(".terminal-empty")).toBeNull();
    const pane = container.querySelector(".terminal-pane-stub");
    expect(pane?.getAttribute("data-cwd")).toBe("/repo/notes");
  });

  // A defensive edge case for `terminalCwd`'s fallback: tabs exist (so the
  // app-shell — and the terminal dock — renders at all) but nothing is
  // active to resolve a directory from. Must still refuse to enable the
  // button, the same as the true "nothing open at all" state.
  it("does not enable + New Terminal when tabs exist but nothing is active", async () => {
    tabsState.set({ tabs: [standaloneTab("/repo/notes/todo.md")], activeTabPath: null });

    const { container } = render(App);
    await settle(3);

    const button = container.querySelector(".terminal-empty button");
    expect(button).not.toBeNull();
    expect(button?.hasAttribute("disabled")).toBe(true);
  });
});
