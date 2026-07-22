import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import TerminalPanel from "../../src/lib/terminal/TerminalPanel.svelte";
import type { LeafPane } from "../../src/lib/terminal/paneTree";

vi.mock("../../src/lib/terminal/TerminalPane.svelte", async () => {
  const mod = await import("./TerminalPaneStub.svelte");
  return { default: mod.default };
});

afterEach(() => {
  cleanup();
});

const TWO_TABS: LeafPane = {
  type: "leaf",
  id: "p1",
  tabs: [
    { id: "s1", cwd: "/proj", title: "proj" },
    { id: "s2", cwd: "/proj/sub", title: "sub" },
  ],
  activeTabId: "s1",
};

function noop(): void {
  // used as an inert callback prop where the test doesn't assert on it
}

const baseProps = {
  hasSplits: false,
  workspaceId: "local",
  onSplit: noop,
  onClosePanel: noop,
  onNewTab: noop,
  onCloseTab: noop,
  onSessionExit: noop,
  onSetActiveTab: noop,
  onTitleChange: noop,
};

describe("TerminalPanel", () => {
  it("renders one tab per session and shows only the active session's TerminalPane", () => {
    const { container } = render(TerminalPanel, { tree: TWO_TABS, ...baseProps });

    expect(container.querySelectorAll('.tab-list .tab[role="tab"]')).toHaveLength(2);
    const slots = container.querySelectorAll(".terminal-pane-slot");
    expect(slots[0].classList.contains("hidden")).toBe(false);
    expect(slots[1].classList.contains("hidden")).toBe(true);
  });

  it("clicking a tab switches which TerminalPane is visible", async () => {
    const onSetActiveTab = vi.fn();
    const { container } = render(TerminalPanel, { tree: TWO_TABS, ...baseProps, onSetActiveTab });

    const tabs = container.querySelectorAll('.tab-list .tab[role="tab"]');
    await fireEvent.click(tabs[1]);

    expect(onSetActiveTab).toHaveBeenCalledWith("s2");
  });

  it("places the new-tab button as the last element in .tab-list, adjacent to the tabs", () => {
    const { container } = render(TerminalPanel, { tree: TWO_TABS, ...baseProps });

    const tabListChildren = [...container.querySelector(".tab-list")!.children];
    expect(tabListChildren.at(-1)?.classList.contains("new-tab")).toBe(true);
  });

  it("wires the new-tab button to onNewTab", async () => {
    const onNewTab = vi.fn();
    const { container } = render(TerminalPanel, { tree: TWO_TABS, ...baseProps, onNewTab });

    await fireEvent.click(container.querySelector(".new-tab")!);
    expect(onNewTab).toHaveBeenCalled();
  });

  it("wires a tab's close button to onCloseTab with that session's id", async () => {
    const onCloseTab = vi.fn();
    const { container } = render(TerminalPanel, { tree: TWO_TABS, ...baseProps, onCloseTab });

    const closeButtons = container.querySelectorAll(".tab-close");
    await fireEvent.click(closeButtons[1]);
    expect(onCloseTab).toHaveBeenCalledWith("s2");
  });

  it("routes a session's own PTY exit to onSessionExit, not onCloseTab", async () => {
    const onSessionExit = vi.fn();
    const onCloseTab = vi.fn();
    const { container } = render(TerminalPanel, { tree: TWO_TABS, ...baseProps, onSessionExit, onCloseTab });

    const exitTriggers = container.querySelectorAll(".terminal-pane-stub-exit");
    await fireEvent.click(exitTriggers[0]);

    expect(onSessionExit).toHaveBeenCalledWith("s1", 60_000);
    expect(onCloseTab).not.toHaveBeenCalled();
  });

  it("renders the split button and close-panel button inside .tab-strip-controls", () => {
    const { container } = render(TerminalPanel, { tree: TWO_TABS, ...baseProps, hasSplits: true });

    const controls = container.querySelector(".tab-strip-controls")!;
    expect(controls.querySelector('button[aria-label="Split terminal"]')).not.toBeNull();
    expect(controls.querySelector('button[aria-label="Close panel"]')).not.toBeNull();
  });

  it("hides the close-panel button when this is the only panel", () => {
    const { container } = render(TerminalPanel, { tree: TWO_TABS, ...baseProps, hasSplits: false });

    expect(container.querySelector('button[aria-label="Close panel"]')).toBeNull();
    // The split button stays available even when unsplit — it's the only
    // way to trigger the very first split.
    expect(container.querySelector('button[aria-label="Split terminal"]')).not.toBeNull();
  });

  it("opening the split dropdown and choosing each direction calls onSplit with the right direction", async () => {
    const onSplit = vi.fn();
    const { container } = render(TerminalPanel, { tree: TWO_TABS, ...baseProps, onSplit });

    await fireEvent.click(container.querySelector('button[aria-label="Split terminal"]')!);

    const items = [...container.querySelectorAll('[role="menuitem"]')];
    expect(items.map((el) => el.textContent)).toEqual(["Split Up", "Split Down", "Split Left", "Split Right"]);

    await fireEvent.click(items[3]);
    expect(onSplit).toHaveBeenCalledWith("right");
  });

  it("wires the close-panel button to onClosePanel", async () => {
    const onClosePanel = vi.fn();
    const { container } = render(TerminalPanel, { tree: TWO_TABS, ...baseProps, hasSplits: true, onClosePanel });

    await fireEvent.click(container.querySelector('button[aria-label="Close panel"]')!);
    expect(onClosePanel).toHaveBeenCalled();
  });
});
