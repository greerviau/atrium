import { describe, it, expect, vi, afterEach } from "vitest";
import { tick } from "svelte";
import { get } from "svelte/store";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import EditorPanel from "../../src/lib/editor/EditorPanel.svelte";
import { moveTabInLeaf, type EditorLeafPane } from "../../src/lib/editor/editorPaneTree";
import { tabsState, saveRequest, notifySaveFailed, type Tab } from "../../src/lib/stores/tabs";
import { errorToast } from "../../src/lib/stores/errorToast";
import { mountLog } from "./mountLog";

vi.mock("../../src/lib/editor/EditorPane.svelte", async () => {
  const mod = await import("./EditorPaneStub.svelte");
  return { default: mod.default };
});

afterEach(() => {
  cleanup();
  tabsState.set({ tabs: [], activeTabPath: null });
  mountLog.length = 0;
});

function tab(path: string, patch: Partial<Tab> = {}): Tab {
  return {
    path,
    mode: "code",
    savedDoc: "",
    isDirty: false,
    hasExternalConflict: false,
    isExternal: false,
    isDeleted: false,
    ...patch,
  };
}

const TWO_TABS: EditorLeafPane = {
  type: "leaf",
  id: "p1",
  tabs: ["/a.ts", "/b.ts"],
  activeTabPath: "/a.ts",
};

function noop(): void {
  // used as an inert callback prop where the test doesn't assert on it
}

const baseProps = {
  onSplit: noop,
  onSetActiveTab: noop,
  onCloseTab: noop,
  onReorderTab: noop,
};

describe("EditorPanel", () => {
  it("renders one tab per open path and shows only the active path's EditorPane", () => {
    tabsState.set({ tabs: [tab("/a.ts"), tab("/b.ts")], activeTabPath: "/a.ts" });
    const { container } = render(EditorPanel, { tree: TWO_TABS, ...baseProps });

    expect(container.querySelectorAll('.tab-list .tab[role="tab"]')).toHaveLength(2);
    const slots = container.querySelectorAll(".editor-pane-slot");
    expect(slots[0].classList.contains("hidden")).toBe(false);
    expect(slots[1].classList.contains("hidden")).toBe(true);
  });

  it("clicking a tab calls onSetActiveTab with that path", async () => {
    tabsState.set({ tabs: [tab("/a.ts"), tab("/b.ts")], activeTabPath: "/a.ts" });
    const onSetActiveTab = vi.fn();
    const { container } = render(EditorPanel, { tree: TWO_TABS, ...baseProps, onSetActiveTab });

    const tabs = container.querySelectorAll('.tab-list .tab[role="tab"]');
    await fireEvent.click(tabs[1]);

    expect(onSetActiveTab).toHaveBeenCalledWith("/b.ts");
  });

  it("wires a tab's close button to onCloseTab with that path", async () => {
    tabsState.set({ tabs: [tab("/a.ts"), tab("/b.ts")], activeTabPath: "/a.ts" });
    const onCloseTab = vi.fn();
    const { container } = render(EditorPanel, { tree: TWO_TABS, ...baseProps, onCloseTab });

    const closeButtons = container.querySelectorAll(".tab-close");
    await fireEvent.click(closeButtons[1]);
    expect(onCloseTab).toHaveBeenCalledWith("/b.ts");
  });

  it("shows a dirty dot for a dirty tab and not for a clean one", () => {
    tabsState.set({ tabs: [tab("/a.ts", { isDirty: true }), tab("/b.ts")], activeTabPath: "/a.ts" });
    const { container } = render(EditorPanel, { tree: TWO_TABS, ...baseProps });

    const names = [...container.querySelectorAll(".tab-name")].map((el) => el.textContent);
    expect(names[0]).toContain("•");
    expect(names[1]).not.toContain("•");
  });

  it("renders a markdown view-mode toggle only for markdown tabs", () => {
    tabsState.set({
      tabs: [tab("/a.ts"), tab("/b.md", { mode: "markdown", viewMode: "rendered" })],
      activeTabPath: "/a.ts",
    });
    const tree: EditorLeafPane = { type: "leaf", id: "p1", tabs: ["/a.ts", "/b.md"], activeTabPath: "/a.ts" };
    const { container } = render(EditorPanel, { tree, ...baseProps });

    expect(container.querySelectorAll(".tab-view-mode")).toHaveLength(1);
  });

  it("renders the split button inside .tab-strip-controls, with no new-tab button", () => {
    tabsState.set({ tabs: [tab("/a.ts"), tab("/b.ts")], activeTabPath: "/a.ts" });
    const { container } = render(EditorPanel, { tree: TWO_TABS, ...baseProps });

    const controls = container.querySelector(".tab-strip-controls")!;
    expect(controls.querySelector('button[aria-label="Split editor"]')).not.toBeNull();
    expect(container.querySelector(".new-tab")).toBeNull();
  });

  it("opening the split dropdown and choosing each direction calls onSplit with the right direction", async () => {
    tabsState.set({ tabs: [tab("/a.ts"), tab("/b.ts")], activeTabPath: "/a.ts" });
    const onSplit = vi.fn();
    const { container } = render(EditorPanel, { tree: TWO_TABS, ...baseProps, onSplit });

    await fireEvent.click(container.querySelector('button[aria-label="Split editor"]')!);

    const items = [...container.querySelectorAll('[role="menuitem"]')];
    expect(items.map((el) => el.textContent)).toEqual([
      "Split Up⌥⌘↑",
      "Split Down⌥⌘↓",
      "Split Left⌥⌘←",
      "Split Right⌥⌘→",
    ]);

    await fireEvent.click(items[3]);
    expect(onSplit).toHaveBeenCalledWith("right");
  });

  it("shows a conflict banner for a path with hasExternalConflict, and 'Keep mine' dismisses it", async () => {
    tabsState.set({ tabs: [tab("/a.ts", { hasExternalConflict: true })], activeTabPath: "/a.ts" });
    const tree: EditorLeafPane = { type: "leaf", id: "p1", tabs: ["/a.ts"], activeTabPath: "/a.ts" };
    const { container, findByText } = render(EditorPanel, { tree, ...baseProps });

    expect(container.querySelector(".conflict-banner")).not.toBeNull();

    const keepMine = await findByText("Keep mine");
    await fireEvent.click(keepMine);

    expect(get(tabsState).tabs.find((t) => t.path === "/a.ts")?.hasExternalConflict).toBe(false);
    expect(container.querySelector(".conflict-banner")).toBeNull();
  });

  it("shows a deleted banner for a path with isDeleted, and 'Save' requests a save for it", async () => {
    saveRequest.set(null);
    tabsState.set({ tabs: [tab("/a.ts", { isDeleted: true })], activeTabPath: "/a.ts" });
    const tree: EditorLeafPane = { type: "leaf", id: "p1", tabs: ["/a.ts"], activeTabPath: "/a.ts" };
    const { container, findByText } = render(EditorPanel, { tree, ...baseProps });

    expect(container.querySelector(".deleted-banner")).not.toBeNull();

    const save = await findByText("Save");
    await fireEvent.click(save);

    expect(get(saveRequest)).toBe("/a.ts");
  });

  it("shows an error toast when the deleted banner's 'Save' fails, instead of an unhandled rejection", async () => {
    errorToast.set(null);
    tabsState.set({ tabs: [tab("/a.ts", { isDeleted: true })], activeTabPath: "/a.ts" });
    const tree: EditorLeafPane = { type: "leaf", id: "p1", tabs: ["/a.ts"], activeTabPath: "/a.ts" };
    const { findByText } = render(EditorPanel, { tree, ...baseProps });

    const save = await findByText("Save");
    await fireEvent.click(save);
    notifySaveFailed("/a.ts", { code: "IO_ERROR", message: "No such file or directory" });
    await Promise.resolve();
    await Promise.resolve();

    expect(get(errorToast)).toBe("Couldn't save a.ts: No such file or directory");
  });

  it("'Close' on the deleted banner closes the tab outright", async () => {
    tabsState.set({ tabs: [tab("/a.ts", { isDeleted: true })], activeTabPath: "/a.ts" });
    const tree: EditorLeafPane = { type: "leaf", id: "p1", tabs: ["/a.ts"], activeTabPath: "/a.ts" };
    const { findByText } = render(EditorPanel, { tree, ...baseProps });

    const close = await findByText("Close");
    await fireEvent.click(close);

    expect(get(tabsState).tabs.find((t) => t.path === "/a.ts")).toBeUndefined();
  });

  it("passes this leaf's own id as paneId to each stacked EditorPane", () => {
    tabsState.set({ tabs: [tab("/a.ts"), tab("/b.ts")], activeTabPath: "/a.ts" });
    const { container } = render(EditorPanel, { tree: TWO_TABS, ...baseProps });

    const stubs = container.querySelectorAll(".editor-pane-stub");
    expect([...stubs].every((el) => el.getAttribute("data-pane-id") === "p1")).toBe(true);
    expect([...stubs].map((el) => el.getAttribute("data-file-path"))).toEqual(["/a.ts", "/b.ts"]);
  });

  it(".tab-list carries role=tablist, for the individual role=tab children to sit inside", () => {
    tabsState.set({ tabs: [tab("/a.ts"), tab("/b.ts")], activeTabPath: "/a.ts" });
    const { container } = render(EditorPanel, { tree: TWO_TABS, ...baseProps });

    expect(container.querySelector(".tab-list")?.getAttribute("role")).toBe("tablist");
  });

  it("a pointerdown that never crosses the drag threshold still lets the tab's own click activate it", async () => {
    tabsState.set({ tabs: [tab("/a.ts"), tab("/b.ts")], activeTabPath: "/a.ts" });
    const onSetActiveTab = vi.fn();
    const { container } = render(EditorPanel, { tree: TWO_TABS, ...baseProps, onSetActiveTab });

    const target = container.querySelectorAll('.tab-list .tab[role="tab"]')[1];
    Object.defineProperty(target, "getBoundingClientRect", {
      value: () => ({ left: 0, right: 50, top: 0, bottom: 20, width: 50, height: 20, x: 0, y: 0, toJSON: () => ({}) }),
      configurable: true,
    });
    await fireEvent.pointerDown(target, { clientX: 5, clientY: 5, button: 0 });
    await fireEvent.click(target);

    expect(onSetActiveTab).toHaveBeenCalledWith("/b.ts");
  });

  it("⌘⇧→ on a focused tab calls onReorderTab with the next index", async () => {
    tabsState.set({ tabs: [tab("/a.ts"), tab("/b.ts")], activeTabPath: "/a.ts" });
    const onReorderTab = vi.fn();
    const { container } = render(EditorPanel, { tree: TWO_TABS, ...baseProps, onReorderTab });

    const firstTab = container.querySelectorAll('.tab-list .tab[role="tab"]')[0] as HTMLElement;
    await fireEvent.keyDown(firstTab, { key: "ArrowRight", metaKey: true, shiftKey: true });

    expect(onReorderTab).toHaveBeenCalledWith("/a.ts", 1);
  });

  it("⌘⇧← on a focused tab calls onReorderTab with the previous index", async () => {
    tabsState.set({ tabs: [tab("/a.ts"), tab("/b.ts")], activeTabPath: "/a.ts" });
    const onReorderTab = vi.fn();
    const { container } = render(EditorPanel, { tree: TWO_TABS, ...baseProps, onReorderTab });

    const secondTab = container.querySelectorAll('.tab-list .tab[role="tab"]')[1] as HTMLElement;
    await fireEvent.keyDown(secondTab, { key: "ArrowLeft", metaKey: true, shiftKey: true });

    expect(onReorderTab).toHaveBeenCalledWith("/b.ts", 0);
  });

  it("a plain ArrowRight/ArrowLeft with no meta/shift does not call onReorderTab", async () => {
    tabsState.set({ tabs: [tab("/a.ts"), tab("/b.ts")], activeTabPath: "/a.ts" });
    const onReorderTab = vi.fn();
    const { container } = render(EditorPanel, { tree: TWO_TABS, ...baseProps, onReorderTab });

    const firstTab = container.querySelectorAll('.tab-list .tab[role="tab"]')[0] as HTMLElement;
    await fireEvent.keyDown(firstTab, { key: "ArrowRight" });

    expect(onReorderTab).not.toHaveBeenCalled();
  });

  // Regression coverage for M4 (round 1): the pane stack must iterate a
  // reorder-stable order derived from `tabsState.tabs`, never `tree.tabs`
  // directly — otherwise a tab-strip reorder physically detaches/reinserts
  // the visible `.editor-pane-slot`'s live CodeMirror DOM, dropping its
  // scroll position and focus. `tabsState.tabs` (insertion order: a, b) is
  // never touched by a reorder, so re-rendering with `tree.tabs` reordered
  // to [b, a] (simulating a completed drag) must leave the pane-stack's own
  // DOM order at [a, b] — unchanged — even though the tab *strip*'s order
  // does follow the new [b, a].
  it("the pane stack's own DOM order stays pinned to tabsState.tabs's order across a tab-strip reorder (M4)", async () => {
    tabsState.set({ tabs: [tab("/a.ts"), tab("/b.ts")], activeTabPath: "/a.ts" });
    const { container, rerender } = render(EditorPanel, { tree: TWO_TABS, ...baseProps });
    mountLog.length = 0;

    const reordered: EditorLeafPane = { ...TWO_TABS, tabs: ["/b.ts", "/a.ts"] };
    await rerender({ tree: reordered, ...baseProps });
    await tick();

    const paneOrder = [...container.querySelectorAll(".editor-pane-stub")].map((el) =>
      el.getAttribute("data-file-path"),
    );
    expect(paneOrder).toEqual(["/a.ts", "/b.ts"]);

    const stripOrder = [...container.querySelectorAll('.tab-list .tab[role="tab"]')].map((el) =>
      el.getAttribute("data-tab-path"),
    );
    expect(stripOrder).toEqual(["/b.ts", "/a.ts"]);

    // Nothing was destroyed/remounted by the reorder — same live EditorPane instances throughout.
    expect(mountLog).not.toContain("destroy:p1:/a.ts");
    expect(mountLog).not.toContain("destroy:p1:/b.ts");
  });

  // Regression coverage for round 2's must-fix: without the tick()-then-
  // .focus() step in onTabKeyDown, moving a focused tab RIGHT relocates the
  // focused node itself in Svelte's keyed {#each}, dropping focus to
  // <body> — so a second ⌘⇧→ press (dispatched, as a real second keystroke
  // would be, on whatever element currently holds focus) never reaches the
  // tab's own keydown handler at all, and the tab never reaches the third
  // slot a second successful move would produce.
  it("two consecutive ⌘⇧→ presses on the same tab both keep it focused (round 2 regression)", async () => {
    tabsState.set({ tabs: [tab("/a.ts"), tab("/b.ts"), tab("/c.ts")], activeTabPath: "/a.ts" });
    let tree: EditorLeafPane = { type: "leaf", id: "p1", tabs: ["/a.ts", "/b.ts", "/c.ts"], activeTabPath: "/a.ts" };

    function onReorderTab(path: string, toIndex: number): void {
      tree = moveTabInLeaf(tree, "p1", path, toIndex) as EditorLeafPane;
      rerender({ tree, ...baseProps, onReorderTab });
    }

    const { container, rerender } = render(EditorPanel, { tree, ...baseProps, onReorderTab });

    const firstTabEl = container.querySelector<HTMLElement>('[data-tab-path="/a.ts"]')!;
    firstTabEl.focus();
    expect(document.activeElement).toBe(firstTabEl);

    await fireEvent.keyDown(firstTabEl, { key: "ArrowRight", metaKey: true, shiftKey: true });
    await tick();
    expect(tree.tabs).toEqual(["/b.ts", "/a.ts", "/c.ts"]);
    // Same DOM node (keyed {#each} preserves identity across the move) — but
    // only still focused if onTabKeyDown explicitly restored it.
    expect(document.activeElement).toBe(container.querySelector('[data-tab-path="/a.ts"]'));

    // A real second keystroke lands wherever focus currently is — if the
    // first press silently dropped focus to <body>, this dispatch never
    // reaches the tab's own onkeydown handler at all.
    await fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: "ArrowRight",
      metaKey: true,
      shiftKey: true,
    });
    await tick();

    expect(tree.tabs).toEqual(["/b.ts", "/c.ts", "/a.ts"]);
    expect(document.activeElement).toBe(container.querySelector('[data-tab-path="/a.ts"]'));
  });
});
