import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import PaneSplit from "../../src/lib/terminal/PaneSplit.svelte";
import type { PaneNode } from "../../src/lib/terminal/paneTree";

vi.mock("../../src/lib/terminal/TerminalPane.svelte", async () => {
  const mod = await import("./TerminalPaneStub.svelte");
  return { default: mod.default };
});

afterEach(() => {
  cleanup();
});

const LEAF: PaneNode = { type: "leaf", id: "p1", cwd: "/proj", title: "proj" };

const SPLIT: PaneNode = {
  type: "split",
  id: "s1",
  direction: "row",
  children: [
    { type: "leaf", id: "p1", cwd: "/proj", title: "proj" },
    { type: "leaf", id: "p2", cwd: "/proj", title: "proj" },
  ],
  sizes: [0.5, 0.5],
};

function noop(): void {
  // used as an inert callback prop where the test doesn't assert on it
}

describe("PaneSplit", () => {
  it("renders a single-pane tree with no header, matching today's un-split terminal rendering", () => {
    const { container } = render(PaneSplit, {
      tree: LEAF,
      hasSplits: false,
      activePaneId: "p1",
      workspaceId: "local",
      onFocus: noop,
      onSplit: noop,
      onClose: noop,
      onTitleChange: noop,
      onResizeSplit: noop,
    });

    expect(container.querySelector(".pane-header")).toBeNull();
    expect(container.querySelector(".terminal-pane-stub")).not.toBeNull();
  });

  it("renders both children of a split tree, each with its own header and a resizer between them", () => {
    const { container } = render(PaneSplit, {
      tree: SPLIT,
      hasSplits: true,
      activePaneId: "p1",
      workspaceId: "local",
      onFocus: noop,
      onSplit: noop,
      onClose: noop,
      onTitleChange: noop,
      onResizeSplit: noop,
    });

    expect(container.querySelectorAll(".terminal-pane-stub")).toHaveLength(2);
    expect(container.querySelectorAll(".pane-header")).toHaveLength(2);
    expect(container.querySelectorAll(".pane-resizer")).toHaveLength(1);
  });

  it("wires a leaf's split-right button to onSplit with that leaf's own id, not the tab's active pane", async () => {
    const onSplit = vi.fn();
    const { container } = render(PaneSplit, {
      tree: SPLIT,
      hasSplits: true,
      activePaneId: "p1",
      workspaceId: "local",
      onFocus: noop,
      onSplit,
      onClose: noop,
      onTitleChange: noop,
      onResizeSplit: noop,
    });

    const panes = container.querySelectorAll(".pane-leaf");
    const secondPaneSplitRightButton = panes[1].querySelector('button[aria-label="Split pane right"]')!;
    await fireEvent.click(secondPaneSplitRightButton);

    expect(onSplit).toHaveBeenCalledWith("p2", "row");
  });

  it("wires a leaf's split-down button to onSplit with the column direction", async () => {
    const onSplit = vi.fn();
    const { container } = render(PaneSplit, {
      tree: SPLIT,
      hasSplits: true,
      activePaneId: "p1",
      workspaceId: "local",
      onFocus: noop,
      onSplit,
      onClose: noop,
      onTitleChange: noop,
      onResizeSplit: noop,
    });

    const panes = container.querySelectorAll(".pane-leaf");
    const firstPaneSplitDownButton = panes[0].querySelector('button[aria-label="Split pane down"]')!;
    await fireEvent.click(firstPaneSplitDownButton);

    expect(onSplit).toHaveBeenCalledWith("p1", "column");
  });

  it("wires a leaf's close button to onClose with that leaf's own id", async () => {
    const onClose = vi.fn();
    const { container } = render(PaneSplit, {
      tree: SPLIT,
      hasSplits: true,
      activePaneId: "p1",
      workspaceId: "local",
      onFocus: noop,
      onSplit: noop,
      onClose,
      onTitleChange: noop,
      onResizeSplit: noop,
    });

    const panes = container.querySelectorAll(".pane-leaf");
    const firstPaneCloseButton = panes[0].querySelector('button[aria-label="Close pane"]')!;
    await fireEvent.click(firstPaneCloseButton);

    expect(onClose).toHaveBeenCalledWith("p1");
  });

  it("marks the active pane with the active class", () => {
    const { container } = render(PaneSplit, {
      tree: SPLIT,
      hasSplits: true,
      activePaneId: "p2",
      workspaceId: "local",
      onFocus: noop,
      onSplit: noop,
      onClose: noop,
      onTitleChange: noop,
      onResizeSplit: noop,
    });

    const panes = container.querySelectorAll(".pane-leaf");
    expect(panes[0].classList.contains("active")).toBe(false);
    expect(panes[1].classList.contains("active")).toBe(true);
  });
});
