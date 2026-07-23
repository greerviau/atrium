import { describe, it, expect, vi, afterEach } from "vitest";
import { get } from "svelte/store";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import EditorPanel from "../../src/lib/editor/EditorPanel.svelte";
import type { EditorLeafPane } from "../../src/lib/editor/editorPaneTree";
import { tabsState, type Tab } from "../../src/lib/stores/tabs";

vi.mock("../../src/lib/editor/EditorPane.svelte", async () => {
  const mod = await import("./EditorPaneStub.svelte");
  return { default: mod.default };
});

afterEach(() => {
  cleanup();
  tabsState.set({ tabs: [], activeTabPath: null });
});

function tab(path: string, patch: Partial<Tab> = {}): Tab {
  return { path, mode: "code", savedDoc: "", isDirty: false, hasExternalConflict: false, ...patch };
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
    expect(items.map((el) => el.textContent)).toEqual(["Split Up", "Split Down", "Split Left", "Split Right"]);

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

  it("passes this leaf's own id as paneId to each stacked EditorPane", () => {
    tabsState.set({ tabs: [tab("/a.ts"), tab("/b.ts")], activeTabPath: "/a.ts" });
    const { container } = render(EditorPanel, { tree: TWO_TABS, ...baseProps });

    const stubs = container.querySelectorAll(".editor-pane-stub");
    expect([...stubs].every((el) => el.getAttribute("data-pane-id") === "p1")).toBe(true);
    expect([...stubs].map((el) => el.getAttribute("data-file-path"))).toEqual(["/a.ts", "/b.ts"]);
  });
});
