import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import App from "../../src/App.svelte";
import { workspace } from "../../src/lib/stores/workspace";
import { terminalVisible } from "../../src/lib/stores/layout";
import { tabsState, openFile } from "../../src/lib/stores/tabs";
import { focusedEditorPaneId, editorPaneTree } from "../../src/lib/stores/editorPanes";
import type { MenuEventId } from "../../src/lib/ipc/events";

// Covers issue #156's split-direction routing (`App.svelte`'s
// `splitFocusedSurface`/`lastFocusedSurface`) end-to-end against the real
// pane-tree wiring — the same stubbing strategy `App.editorSplitPanes.test.ts`
// already uses, plus a capturing `onMenuEvent` mock (mirroring
// `MenuBar.test.ts`'s own pattern) so a fired `menu:split-*` event can be
// replayed directly against whatever `App.svelte` actually registered.
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
  };
});

const menuHandlers = new Map<MenuEventId, () => void>();

vi.mock("../../src/lib/ipc/events", () => ({
  onFsChanged: vi.fn().mockResolvedValue(() => {}),
  onMenuEvent: vi.fn((id: MenuEventId, handler: () => void) => {
    menuHandlers.set(id, handler);
    return Promise.resolve(() => {});
  }),
  onDockOpenPath: vi.fn().mockResolvedValue(() => {}),
  onCloseRequested: vi.fn().mockResolvedValue(() => {}),
  onDragDropEvent: vi.fn().mockResolvedValue(() => {}),
}));

function resetStores(): void {
  localStorage.clear();
  menuHandlers.clear();
  workspace.set({ id: "local", root: null });
  terminalVisible.set(false);
  tabsState.set({ tabs: [], activeTabPath: null });
  focusedEditorPaneId.set(null);
  editorPaneTree.set(null);
}

describe("App split-direction routing (issue #156)", () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(() => {
    cleanup();
  });

  it("routes a split-direction chord to the editor when only the editor has a pane open", async () => {
    workspace.set({ id: "local", root: "/projects/demo" });
    const { container } = render(App);
    await tick();

    await openFile("/a.ts");
    await tick();
    await tick();

    expect(container.querySelectorAll(".editor-area .pane-leaf")).toHaveLength(1);

    menuHandlers.get("menu:split-right")?.();
    await tick();

    expect(container.querySelectorAll(".editor-area .pane-leaf")).toHaveLength(2);
  });

  it("routes a split-direction chord to the terminal once it's the last-focused surface", async () => {
    workspace.set({ id: "local", root: "/projects/demo" });
    const { container } = render(App);
    await tick();

    // Opening the dock auto-spawns a terminal pane and marks the terminal as
    // the last-focused surface (newTerminalTab sets both).
    terminalVisible.set(true);
    await tick();
    await tick();
    expect(container.querySelectorAll(".terminal-pane-stub")).toHaveLength(1);

    menuHandlers.get("menu:split-down")?.();
    await tick();

    expect(container.querySelectorAll(".terminal-pane-stub")).toHaveLength(2);
  });

  it("falls back to the editor when the terminal was last focused but its dock is now hidden", async () => {
    workspace.set({ id: "local", root: "/projects/demo" });
    const { container } = render(App);
    await tick();

    terminalVisible.set(true);
    await tick();
    await tick();
    expect(container.querySelectorAll(".terminal-pane-stub")).toHaveLength(1);

    // Hiding the dock never tears down terminalPaneTree or clears
    // lastFocusedSurface — it stays "terminal" even though the terminal is
    // no longer visible.
    terminalVisible.set(false);
    await tick();

    await openFile("/a.ts");
    await tick();
    await tick();
    expect(container.querySelectorAll(".editor-area .pane-leaf")).toHaveLength(1);

    menuHandlers.get("menu:split-up")?.();
    await tick();

    // Routed to the editor, not silently no-op'd against the hidden,
    // invisible terminal dock.
    expect(container.querySelectorAll(".editor-area .pane-leaf")).toHaveLength(2);
    expect(container.querySelectorAll(".terminal-pane-stub")).toHaveLength(1);
  });

  it("is a silent no-op when neither surface has a pane tree", async () => {
    workspace.set({ id: "local", root: "/projects/demo" });
    const { container } = render(App);
    await tick();

    expect(container.querySelectorAll(".editor-area .pane-leaf")).toHaveLength(0);
    expect(container.querySelectorAll(".terminal-pane-stub")).toHaveLength(0);

    expect(() => menuHandlers.get("menu:split-left")?.()).not.toThrow();
    await tick();

    expect(container.querySelectorAll(".editor-area .pane-leaf")).toHaveLength(0);
    expect(container.querySelectorAll(".terminal-pane-stub")).toHaveLength(0);
  });
});
