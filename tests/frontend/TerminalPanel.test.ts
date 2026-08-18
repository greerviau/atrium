import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import TerminalPanel from "../../src/lib/terminal/TerminalPanel.svelte";
import type { LeafPane } from "../../src/lib/terminal/paneTree";
import { DEFAULT_SIMULATE_ELAPSED_MS } from "./TerminalPaneStub.svelte";

vi.mock("../../src/lib/terminal/TerminalPane.svelte", async () => {
  const mod = await import("./TerminalPaneStub.svelte");
  return { default: mod.default };
});

afterEach(() => {
  cleanup();
  delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
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
  workspaceId: "local",
  onSplit: noop,
  onNewTab: noop,
  onCloseTab: noop,
  onSessionExit: noop,
  onSetActiveTab: noop,
  onTitleChange: noop,
};

function pointerEvent(type: string, clientX: number, pointerId = 1): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: clientX },
    clientY: { value: 5 },
    pointerId: { value: pointerId },
  });
  return event;
}

describe("TerminalPanel", () => {
  it("renders one tab per session and shows only the active session's TerminalPane", () => {
    const { container } = render(TerminalPanel, { tree: TWO_TABS, ...baseProps });

    expect(container.querySelectorAll('.tab-list .tab[role="tab"]')).toHaveLength(2);
    const slots = container.querySelectorAll(".terminal-pane-slot");
    expect(slots[0].classList.contains("hidden")).toBe(false);
    expect(slots[1].classList.contains("hidden")).toBe(true);
  });

  it("renders a leading terminal icon in every tab", () => {
    const { container } = render(TerminalPanel, { tree: TWO_TABS, ...baseProps });

    const tabs = container.querySelectorAll('.tab-list .tab[role="tab"]');
    for (const tab of tabs) {
      expect(tab.querySelector(".terminal-icon")).not.toBeNull();
    }
  });

  it("scrolling vertically over the tab list scrolls tabs horizontally", async () => {
    const { container } = render(TerminalPanel, { tree: TWO_TABS, ...baseProps });
    const tabList = container.querySelector(".tab-list") as HTMLDivElement;

    await fireEvent.wheel(tabList, { deltaY: 120 });
    await fireEvent.wheel(tabList, { deltaY: -50 });

    expect(tabList.scrollLeft).toBe(70);
  });

  it("reorders a tab while the pointer crosses another tab, then leaves the order settled on release", () => {
    const onReorderTab = vi.fn();
    const { container } = render(TerminalPanel, { tree: TWO_TABS, ...baseProps, onReorderTab });
    container.classList.add("terminal-area", "pane-leaf");
    container.dataset.paneId = "p1";

    const tabs = [...container.querySelectorAll<HTMLElement>('.tab-list .tab[role="tab"]')];
    tabs.forEach((tab, index) => {
      Object.defineProperty(tab, "getBoundingClientRect", {
        value: () => ({ left: index * 50, right: index * 50 + 50, top: 0, bottom: 20, width: 50, height: 20 }),
      });
    });
    Object.defineProperty(document, "elementFromPoint", { value: () => tabs[0], configurable: true });

    tabs[0].dispatchEvent(pointerEvent("pointerdown", 10));
    window.dispatchEvent(pointerEvent("pointermove", 80));

    expect(onReorderTab).toHaveBeenCalledTimes(1);
    expect(onReorderTab).toHaveBeenCalledWith("s1", 1);

    window.dispatchEvent(pointerEvent("pointerup", 80));
    expect(onReorderTab).toHaveBeenCalledTimes(1);
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

    expect(onSessionExit).toHaveBeenCalledWith("s1", DEFAULT_SIMULATE_ELAPSED_MS);
    expect(onCloseTab).not.toHaveBeenCalled();
  });

  it("renders the split button inside .tab-strip-controls and no close-panel button", () => {
    const { container } = render(TerminalPanel, { tree: TWO_TABS, ...baseProps });

    const controls = container.querySelector(".tab-strip-controls")!;
    expect(controls.querySelector('button[aria-label="Split terminal"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Close panel"]')).toBeNull();
  });

  it("opening the split dropdown and choosing each direction calls onSplit with the right direction", async () => {
    const onSplit = vi.fn();
    const { container } = render(TerminalPanel, { tree: TWO_TABS, ...baseProps, onSplit });

    await fireEvent.click(container.querySelector('button[aria-label="Split terminal"]')!);

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
});
