import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import PaneSplit from "../../src/lib/terminal/PaneSplit.svelte";
import { resizeSplit, PANE_MIN_PX, type PaneNode, type SplitPane } from "../../src/lib/terminal/paneTree";

vi.mock("../../src/lib/terminal/TerminalPanel.svelte", async () => {
  const mod = await import("./TerminalPanelStub.svelte");
  return { default: mod.default };
});

afterEach(() => {
  cleanup();
});

function leafNode(id: string) {
  return { type: "leaf" as const, id, tabs: [{ id: `${id}-tab`, cwd: "/proj", title: "proj" }], activeTabId: `${id}-tab` };
}

const LEAF: PaneNode = leafNode("p1");

const SPLIT: PaneNode = {
  type: "split",
  id: "s1",
  direction: "row",
  children: [leafNode("p1"), leafNode("p2")],
  sizes: [0.5, 0.5],
};

function noop(): void {
  // used as an inert callback prop where the test doesn't assert on it
}

const baseProps = {
  activePaneId: "p1",
  workspaceId: "local",
  onFocus: noop,
  onSplit: noop,
  onClose: noop,
  onNewTab: noop,
  onCloseTab: noop,
  onSetActiveTab: noop,
  onTitleChange: noop,
  onResizeSplit: noop,
};

describe("PaneSplit", () => {
  it("renders a single-pane tree as one panel", () => {
    const { container } = render(PaneSplit, { tree: LEAF, hasSplits: false, ...baseProps });

    expect(container.querySelectorAll(".terminal-panel-stub")).toHaveLength(1);
    expect(container.querySelector(".terminal-panel-stub")?.getAttribute("data-pane-id")).toBe("p1");
  });

  it("renders both children of a split tree, each as its own panel, with a resizer between them", () => {
    const { container } = render(PaneSplit, { tree: SPLIT, hasSplits: true, ...baseProps });

    const panels = container.querySelectorAll(".terminal-panel-stub");
    expect(panels).toHaveLength(2);
    expect([...panels].map((p) => p.getAttribute("data-pane-id"))).toEqual(["p1", "p2"]);
    expect(container.querySelectorAll(".pane-resizer")).toHaveLength(1);
  });

  it("lays out a row split horizontally and a column split vertically", () => {
    const { container } = render(PaneSplit, { tree: SPLIT, hasSplits: true, ...baseProps });
    expect(container.querySelector(".pane-split")?.classList.contains("row")).toBe(true);

    cleanup();

    const columnSplit: PaneNode = { ...(SPLIT as SplitPane), direction: "column" };
    const { container: columnContainer } = render(PaneSplit, { tree: columnSplit, hasSplits: true, ...baseProps });
    expect(columnContainer.querySelector(".pane-split")?.classList.contains("column")).toBe(true);
  });

  it("marks the focused pane with the active class", () => {
    const { container } = render(PaneSplit, { tree: SPLIT, hasSplits: true, ...baseProps, activePaneId: "p2" });

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
    const { container } = render(PaneSplit, { tree: SPLIT, hasSplits: true, ...baseProps, onResizeSplit });

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
