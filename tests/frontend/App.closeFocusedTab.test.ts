import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import App from "../../src/App.svelte";
import { workspace } from "../../src/lib/stores/workspace";
import { terminalVisible } from "../../src/lib/stores/layout";
import { tabsState, openFile } from "../../src/lib/stores/tabs";
import { closePrompt } from "../../src/lib/stores/closePrompt";
import { focusedEditorPaneId, editorPaneTree } from "../../src/lib/stores/editorPanes";
import { appConfirmClose } from "../../src/lib/ipc/commands";
import type { MenuEventId } from "../../src/lib/ipc/events";

// Covers issue #279's Cmd+W fix (`App.svelte`'s `closeFocusedTab`) end-to-end
// against the real pane-tree wiring, mirroring
// `App.splitFocusedSurface.test.ts`'s stubbing/capturing-`onMenuEvent`
// strategy so a fired `menu:close-tab` event can be replayed directly
// against whatever `App.svelte` actually registered.
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

// `initMenuBar` registers its `menu:*` handlers one `await` at a time, and
// `menu:close-tab` is the last one registered; a fixed handful of `tick()`s
// isn't guaranteed to drain that whole chain, so tests that need
// `menu:close-tab` present flush the microtask queue with a real macrotask
// first.
function flushMenuBarRegistration(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function resetStores(): void {
  localStorage.clear();
  menuHandlers.clear();
  workspace.set({ id: "local", root: null });
  terminalVisible.set(false);
  tabsState.set({ tabs: [], activeTabPath: null });
  closePrompt.set(null);
  focusedEditorPaneId.set(null);
  editorPaneTree.set(null);
}

describe("App Cmd+W close-focused-tab routing (issue #279)", () => {
  beforeEach(() => {
    resetStores();
    vi.mocked(appConfirmClose).mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("closes a single clean editor tab and never touches the whole-app close path", async () => {
    workspace.set({ id: "local", root: "/projects/demo" });
    render(App);
    await tick();
    await flushMenuBarRegistration();

    await openFile("/a.ts");
    await tick();
    await tick();

    expect(get(tabsState).tabs.map((t) => t.path)).toEqual(["/a.ts"]);

    menuHandlers.get("menu:close-tab")?.();
    await tick();
    await tick();

    expect(get(tabsState).tabs).toHaveLength(0);
    expect(get(closePrompt)).toBeNull();
    expect(appConfirmClose).not.toHaveBeenCalled();
  });

  it("raises the tab-scoped unsaved-changes prompt for a dirty editor tab, not the window-scoped one", async () => {
    workspace.set({ id: "local", root: "/projects/demo" });
    render(App);
    await tick();
    await flushMenuBarRegistration();

    await openFile("/a.ts");
    await tick();
    await tick();

    tabsState.update((s) => ({
      ...s,
      tabs: s.tabs.map((t) => (t.path === "/a.ts" ? { ...t, isDirty: true } : t)),
    }));

    menuHandlers.get("menu:close-tab")?.();
    await tick();

    expect(get(closePrompt)).toEqual({ kind: "tab", path: "/a.ts" });
    expect(appConfirmClose).not.toHaveBeenCalled();
  });

  it("closing the focused pane's tab, when the same file is split across two panes, only drops it from that pane", async () => {
    workspace.set({ id: "local", root: "/projects/demo" });
    const { container } = render(App);
    await tick();
    await flushMenuBarRegistration();

    await openFile("/a.ts");
    await tick();
    await tick();

    menuHandlers.get("menu:split-right")?.();
    await tick();

    expect(container.querySelectorAll(".editor-area .pane-leaf")).toHaveLength(2);

    // The newly split pane is the currently-focused one.
    menuHandlers.get("menu:close-tab")?.();
    await tick();

    expect(container.querySelectorAll(".editor-area .pane-leaf")).toHaveLength(1);
    expect(get(tabsState).tabs.map((t) => t.path)).toEqual(["/a.ts"]);
    expect(get(closePrompt)).toBeNull();
  });

  it("closes the focused terminal tab, hiding the dock when it was the only tab", async () => {
    workspace.set({ id: "local", root: "/projects/demo" });
    const { container } = render(App);
    await tick();
    await flushMenuBarRegistration();

    terminalVisible.set(true);
    await tick();
    await tick();
    expect(container.querySelectorAll(".terminal-pane-stub")).toHaveLength(1);

    menuHandlers.get("menu:close-tab")?.();
    await tick();

    expect(container.querySelectorAll(".terminal-pane-stub")).toHaveLength(0);
    expect(get(terminalVisible)).toBe(false);
  });

  it("is a no-op, and never calls appConfirmClose, when neither surface has an open tab", async () => {
    workspace.set({ id: "local", root: "/projects/demo" });
    render(App);
    await tick();
    await flushMenuBarRegistration();

    expect(get(tabsState).tabs).toHaveLength(0);
    expect(get(editorPaneTree)).toBeNull();

    expect(menuHandlers.get("menu:close-tab")).toBeDefined();
    expect(() => menuHandlers.get("menu:close-tab")?.()).not.toThrow();
    await tick();

    expect(get(tabsState).tabs).toHaveLength(0);
    expect(get(editorPaneTree)).toBeNull();
    expect(get(closePrompt)).toBeNull();
    expect(appConfirmClose).not.toHaveBeenCalled();
  });
});
