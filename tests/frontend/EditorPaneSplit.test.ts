import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import EditorPaneSplit from "../../src/lib/editor/EditorPaneSplit.svelte";
import { resizeSplit, PANE_MIN_PX, type EditorPaneNode, type EditorSplitPane } from "../../src/lib/editor/editorPaneTree";
import { mountLog } from "./mountLog";

vi.mock("../../src/lib/editor/EditorPanel.svelte", async () => {
  const mod = await import("./EditorPanelStub.svelte");
  return { default: mod.default };
});

afterEach(() => {
  cleanup();
  mountLog.length = 0;
});

function leafNode(id: string) {
  return { type: "leaf" as const, id, tabs: [`${id}.txt`], activeTabPath: `${id}.txt` };
}

const LEAF: EditorPaneNode = leafNode("p1");

const SPLIT: EditorPaneNode = {
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
  onFocus: noop,
  onSplit: noop,
  onSetActiveTab: noop,
  onCloseTab: noop,
  onResizeSplit: noop,
};

describe("EditorPaneSplit", () => {
  it("renders a single-pane tree as one panel", () => {
    const { container } = render(EditorPaneSplit, { tree: LEAF, ...baseProps });

    expect(container.querySelectorAll(".editor-panel-stub")).toHaveLength(1);
    expect(container.querySelector(".editor-panel-stub")?.getAttribute("data-pane-id")).toBe("p1");
  });

  it("renders both children of a split tree, each as its own panel, with a resizer between them", () => {
    const { container } = render(EditorPaneSplit, { tree: SPLIT, ...baseProps });

    const panels = container.querySelectorAll(".editor-panel-stub");
    expect(panels).toHaveLength(2);
    expect([...panels].map((p) => p.getAttribute("data-pane-id"))).toEqual(["p1", "p2"]);
    expect(container.querySelectorAll(".pane-resizer")).toHaveLength(1);
  });

  it("marks a row split's resizer vertical and a column split's resizer horizontal", () => {
    const { container } = render(EditorPaneSplit, { tree: SPLIT, ...baseProps });
    const rowResizer = container.querySelector(".pane-resizer")!;
    expect(rowResizer.classList.contains("vertical")).toBe(true);
    expect(rowResizer.getAttribute("aria-orientation")).toBe("vertical");

    cleanup();

    const columnSplit: EditorPaneNode = { ...(SPLIT as EditorSplitPane), direction: "column" };
    const { container: columnContainer } = render(EditorPaneSplit, { tree: columnSplit, ...baseProps });
    const columnResizer = columnContainer.querySelector(".pane-resizer")!;
    expect(columnResizer.classList.contains("horizontal")).toBe(true);
    expect(columnResizer.getAttribute("aria-orientation")).toBe("horizontal");
  });

  it("marks the focused pane with the active class", () => {
    const { container } = render(EditorPaneSplit, { tree: SPLIT, ...baseProps, activePaneId: "p2" });

    const panes = container.querySelectorAll(".pane-leaf");
    expect(panes[0].classList.contains("active")).toBe(false);
    expect(panes[1].classList.contains("active")).toBe(true);
  });

  it("regression: a multi-event drag tracks the pointer's total displacement instead of compounding on every event", () => {
    const onResizeSplit = vi.fn();
    const { container } = render(EditorPaneSplit, { tree: SPLIT, ...baseProps, onResizeSplit });

    const rootEl = container.querySelector(".pane-split-root") as HTMLElement;
    Object.defineProperty(rootEl, "clientWidth", { value: 500, configurable: true });
    const resizer = container.querySelector(".pane-resizer")!;

    function pointerLikeEvent(type: string, clientX: number): Event {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, "clientX", { value: clientX, configurable: true });
      return event;
    }

    resizer.dispatchEvent(pointerLikeEvent("pointerdown", 0));
    for (const x of [5, 10, 15, 20, 25, 30]) {
      window.dispatchEvent(pointerLikeEvent("pointermove", x));
    }
    window.dispatchEvent(new Event("pointerup"));

    expect(onResizeSplit).toHaveBeenCalledTimes(6);

    let tree: EditorPaneNode = SPLIT;
    for (const [splitId, index, delta, containerSizePx] of onResizeSplit.mock.calls) {
      const minRatio = PANE_MIN_PX / containerSizePx;
      tree = resizeSplit(tree, splitId, index, delta, minRatio);
    }

    const result = tree as EditorSplitPane;
    expect(result.sizes[0]).toBeCloseTo(0.56, 5);
    expect(result.sizes[1]).toBeCloseTo(0.44, 5);
  });

  it("regression: splitting or collapsing a tree never destroys/remounts a leaf whose id survives the transition (#112)", () => {
    const { rerender } = render(EditorPaneSplit, { tree: LEAF, ...baseProps });
    mountLog.length = 0;

    rerender({ tree: SPLIT, ...baseProps });
    expect(mountLog).not.toContain("destroy:p1");
    expect(mountLog).toContain("mount:p2");

    mountLog.length = 0;

    rerender({ tree: leafNode("p2"), ...baseProps });
    expect(mountLog).toContain("destroy:p1");
    expect(mountLog).not.toContain("destroy:p2");
    expect(mountLog).not.toContain("mount:p2");
  });

  it("calls onFocus with the leaf id when focus lands inside that leaf", () => {
    const onFocus = vi.fn();
    const { container } = render(EditorPaneSplit, { tree: SPLIT, ...baseProps, onFocus });

    const panes = container.querySelectorAll(".pane-leaf");
    const focusinEvent = new Event("focusin", { bubbles: true });
    panes[1].querySelector(".editor-panel-stub")!.dispatchEvent(focusinEvent);

    expect(onFocus).toHaveBeenCalledWith("p2");
  });
});
