import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import { tick } from "svelte";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import App from "../../src/App.svelte";
import { workspace } from "../../src/lib/stores/workspace";
import { terminalVisible } from "../../src/lib/stores/layout";
import { tabsState, openFile } from "../../src/lib/stores/tabs";
import { focusedEditorPaneId, editorPaneTree } from "../../src/lib/stores/editorPanes";

// Covers issue #158's two entry-point scenarios end-to-end against the real
// App.svelte pane-tree wiring: only FileTree (backed by real fs IPC calls on
// mount) and TerminalPane (backed by @xterm/xterm, not under test here) are
// stubbed, the same way App.terminalAutoSpawn.test.ts stubs them. Every
// editor-pane handler (splitEditorPaneAt, closeTabInEditorPane, the pane-tree
// reconciliation effects) runs unmodified.
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

vi.mock("../../src/lib/ipc/events", () => ({
  onFsChanged: vi.fn().mockResolvedValue(() => {}),
  onMenuEvent: vi.fn().mockResolvedValue(() => {}),
  onDockOpenPath: vi.fn().mockResolvedValue(() => {}),
  onCloseRequested: vi.fn().mockResolvedValue(() => {}),
  onDragDropEvent: vi.fn().mockResolvedValue(() => {}),
}));

function resetStores(): void {
  localStorage.clear();
  workspace.set({ id: "local", root: null });
  terminalVisible.set(false);
  tabsState.set({ tabs: [], activeTabPath: null });
  focusedEditorPaneId.set(null);
  editorPaneTree.set(null);
}

describe("App editor split panes (issue #158)", () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(() => {
    cleanup();
  });

  it("scenario 1: splitting a pane with a single open file duplicates that file into a second pane", async () => {
    workspace.set({ id: "local", root: "/projects/demo" });
    const { container } = render(App);
    await tick();

    await openFile("/a.ts");
    await tick();
    await tick();

    expect(container.querySelectorAll(".editor-panel-stub, .editor-pane-slot").length).toBeGreaterThan(0);
    const firstPaneEls = container.querySelectorAll(".pane-leaf");
    expect(firstPaneEls).toHaveLength(1);

    const splitButton = container.querySelector('button[aria-label="Split editor"]')!;
    await fireEvent.click(splitButton);
    const rightItem = [...container.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === "Split Right")!;
    await fireEvent.click(rightItem);
    await tick();

    const panes = container.querySelectorAll(".pane-leaf");
    expect(panes).toHaveLength(2);

    // Both panes show /a.ts as their own active tab; the original pane's tab
    // strip still lists exactly one tab (the file itself isn't duplicated in
    // tabsState — just its view).
    const activeTabs = container.querySelectorAll(".editor-panel .tab.active .tab-name");
    expect(activeTabs).toHaveLength(2);
    expect([...activeTabs].every((el) => el.textContent?.includes("a.ts"))).toBe(true);

    // Duplicating the view never creates a second `Tab` — the document
    // itself stays a single shared registry entry, per the plan's design.
    expect(get(tabsState).tabs.filter((t) => t.path === "/a.ts")).toHaveLength(1);
  });

  it("scenario 2: splitting a pane with multiple tabs open takes only the active tab into the new pane", async () => {
    workspace.set({ id: "local", root: "/projects/demo" });
    const { container } = render(App);
    await tick();

    await openFile("/a.ts");
    await tick();
    await openFile("/b.ts");
    await tick();
    await openFile("/c.ts");
    await tick();
    await tick();

    // All three tabs are in the one existing pane, with /c.ts (the last
    // opened) as the active one.
    const tabsBeforeSplit = container.querySelectorAll(".editor-panel .tab");
    expect(tabsBeforeSplit).toHaveLength(3);

    const splitButton = container.querySelector('button[aria-label="Split editor"]')!;
    await fireEvent.click(splitButton);
    const rightItem = [...container.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === "Split Right")!;
    await fireEvent.click(rightItem);
    await tick();

    const panels = container.querySelectorAll(".editor-panel");
    expect(panels).toHaveLength(2);

    const [firstPanelTabs, secondPanelTabs] = [...panels].map((p) => [...p.querySelectorAll(".tab-name")].map((el) => el.textContent));
    // The original pane keeps all three tabs...
    expect(firstPanelTabs).toHaveLength(3);
    // ...and the new pane has only the one that was active (c.ts).
    expect(secondPanelTabs).toHaveLength(1);
    expect(secondPanelTabs[0]).toContain("c.ts");
  });

  it("closing a tab that's open in another pane too only removes this pane's view, leaving the file open", async () => {
    workspace.set({ id: "local", root: "/projects/demo" });
    const { container } = render(App);
    await tick();
    await openFile("/a.ts");
    await tick();

    const splitButton = container.querySelector('button[aria-label="Split editor"]')!;
    await fireEvent.click(splitButton);
    const rightItem = [...container.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === "Split Right")!;
    await fireEvent.click(rightItem);
    await tick();

    expect(container.querySelectorAll(".pane-leaf")).toHaveLength(2);

    const closeButtons = container.querySelectorAll(".editor-panel .tab-close");
    await fireEvent.click(closeButtons[closeButtons.length - 1]);
    await tick();

    // Only one pane remains, and the file is still open in it — closing a
    // split view must not raise the unsaved-changes prompt or drop the file.
    expect(container.querySelectorAll(".pane-leaf")).toHaveLength(1);
    expect(container.querySelector(".close-prompt-backdrop")).toBeNull();
    expect([...container.querySelectorAll(".editor-panel .tab-name")].some((el) => el.textContent?.includes("a.ts"))).toBe(true);
  });

  it("re-opening a file that's already open in an unfocused pane reveals and focuses that pane, keeping tabsState.activeTabPath in sync", async () => {
    workspace.set({ id: "local", root: "/projects/demo" });
    const { container } = render(App);
    await tick();

    await openFile("/a.ts");
    await tick();

    // Split so /a.ts is open in two panes, then open a second file in the
    // now-focused (new) pane so the two panes show different files.
    const splitButton = container.querySelector('button[aria-label="Split editor"]')!;
    await fireEvent.click(splitButton);
    const rightItem = [...container.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === "Split Right")!;
    await fireEvent.click(rightItem);
    await tick();

    await openFile("/b.ts");
    await tick();

    // The second pane (focused) now shows /b.ts; tabsState mirrors that.
    expect(get(tabsState).activeTabPath).toBe("/b.ts");

    // Re-opening /a.ts (e.g. clicking it again in the explorer) must reveal
    // and focus the pane that already has it, rather than leaving
    // tabsState.activeTabPath pointing at a file no focused pane shows.
    await openFile("/a.ts");
    await tick();

    expect(get(tabsState).activeTabPath).toBe("/a.ts");
    const activeTabNames = [...container.querySelectorAll(".editor-panel .tab.active .tab-name")].map((el) => el.textContent);
    expect(activeTabNames.some((t) => t?.includes("a.ts"))).toBe(true);
    // No duplicate view was created — still exactly two panes.
    expect(container.querySelectorAll(".pane-leaf")).toHaveLength(2);
  });
});
