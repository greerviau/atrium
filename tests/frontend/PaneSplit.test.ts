import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import PaneSplit from "../../src/lib/terminal/PaneSplit.svelte";
import { resizeSplit, PANE_MIN_PX, type PaneNode, type SplitPane } from "../../src/lib/terminal/paneTree";

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

  it("regression: a multi-event drag tracks the pointer's total displacement instead of compounding on every event", () => {
    // `resizeSplit` (paneTree.ts) adds each emitted delta onto whatever
    // `sizes[index]` already is, since App.svelte feeds every prior delta
    // back live. The resizer's pointermove handler must therefore emit the
    // increment since the *last* event, not the cumulative displacement
    // since the drag began — the latter double-counts every prior event's
    // movement on top of a size that already reflects it, and the divider
    // runs away far faster than the pointer.
    const onResizeSplit = vi.fn();
    const { container } = render(PaneSplit, {
      tree: SPLIT,
      hasSplits: true,
      activePaneId: "p1",
      workspaceId: "local",
      onFocus: noop,
      onSplit: noop,
      onClose: noop,
      onTitleChange: noop,
      onResizeSplit,
    });

    const splitEl = container.querySelector(".pane-split") as HTMLElement;
    Object.defineProperty(splitEl, "clientWidth", { value: 500, configurable: true });
    const resizer = container.querySelector(".pane-resizer")!;

    function pointerLikeEvent(type: string, clientX: number): Event {
      // Svelte 5 delegates common pointer events at the document root, so
      // the event must bubble to reach the handler (real pointer events do).
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, "clientX", { value: clientX, configurable: true });
      return event;
    }

    resizer.dispatchEvent(pointerLikeEvent("pointerdown", 0));
    // A 30px drag over a 500px container, delivered as six 5px pointermove
    // events — real drags fire far more events than that.
    for (const x of [5, 10, 15, 20, 25, 30]) {
      window.dispatchEvent(pointerLikeEvent("pointermove", x));
    }
    window.dispatchEvent(new Event("pointerup"));

    expect(onResizeSplit).toHaveBeenCalledTimes(6);

    // Fold every emitted delta through the real `resizeSplit`, exactly as
    // App.svelte's `resizePaneSplit` does, and check where the divider
    // actually lands.
    let tree: PaneNode = SPLIT;
    for (const [splitId, index, delta, containerSizePx] of onResizeSplit.mock.calls) {
      const minRatio = PANE_MIN_PX / containerSizePx;
      tree = resizeSplit(tree, splitId, index, delta, minRatio);
    }

    const result = tree as SplitPane;
    expect(result.sizes[0]).toBeCloseTo(0.56, 5);
    expect(result.sizes[1]).toBeCloseTo(0.44, 5);
  });
});
