import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import PaneSplit from "../../src/lib/terminal/PaneSplit.svelte";
import { resizeSplit, PANE_MIN_PX, type PaneNode, type SplitPane } from "../../src/lib/terminal/paneTree";
import { mountLog } from "./mountLog";

vi.mock("../../src/lib/terminal/TerminalPanel.svelte", async () => {
  const mod = await import("./TerminalPanelStub.svelte");
  return { default: mod.default };
});

afterEach(() => {
  cleanup();
  mountLog.length = 0;
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
  onNewTab: noop,
  onCloseTab: noop,
  onSessionExit: noop,
  onSetActiveTab: noop,
  onTitleChange: noop,
  onResizeSplit: noop,
};

describe("PaneSplit", () => {
  it("renders a single-pane tree as one panel", () => {
    const { container } = render(PaneSplit, { tree: LEAF, ...baseProps });

    expect(container.querySelectorAll(".terminal-panel-stub")).toHaveLength(1);
    expect(container.querySelector(".terminal-panel-stub")?.getAttribute("data-pane-id")).toBe("p1");
  });

  it("renders both children of a split tree, each as its own panel, with a resizer between them", () => {
    const { container } = render(PaneSplit, { tree: SPLIT, ...baseProps });

    const panels = container.querySelectorAll(".terminal-panel-stub");
    expect(panels).toHaveLength(2);
    expect([...panels].map((p) => p.getAttribute("data-pane-id"))).toEqual(["p1", "p2"]);
    expect(container.querySelectorAll(".pane-resizer")).toHaveLength(1);
  });

  it("marks a row split's resizer vertical and a column split's resizer horizontal", () => {
    const { container } = render(PaneSplit, { tree: SPLIT, ...baseProps });
    const rowResizer = container.querySelector(".pane-resizer")!;
    expect(rowResizer.classList.contains("vertical")).toBe(true);
    expect(rowResizer.getAttribute("aria-orientation")).toBe("vertical");

    cleanup();

    const columnSplit: PaneNode = { ...(SPLIT as SplitPane), direction: "column" };
    const { container: columnContainer } = render(PaneSplit, { tree: columnSplit, ...baseProps });
    const columnResizer = columnContainer.querySelector(".pane-resizer")!;
    expect(columnResizer.classList.contains("horizontal")).toBe(true);
    expect(columnResizer.getAttribute("aria-orientation")).toBe("horizontal");
  });

  it("marks the focused pane with the active class", () => {
    const { container } = render(PaneSplit, { tree: SPLIT, ...baseProps, activePaneId: "p2" });

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
    const { container } = render(PaneSplit, { tree: SPLIT, ...baseProps, onResizeSplit });

    // The flat renderer has only one real container element (`.pane-split-root`);
    // a given split's own local pixel size is derived from it by scaling by
    // that split's own rectangle fraction (here 100%, since SPLIT is the root).
    const rootEl = container.querySelector(".pane-split-root") as HTMLElement;
    Object.defineProperty(rootEl, "clientWidth", { value: 500, configurable: true });
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

  it("regression: splitting or collapsing a tree never destroys/remounts a leaf whose id survives the transition (#112)", () => {
    // This is the mount/destroy regression test for issue #112: the old
    // recursive `{#if tree.type === "leaf"} ... {:else} ... {/if}` renderer
    // tore down and remounted an untouched surviving leaf's whole component
    // subtree (killing its PTY) whenever a node's type flipped between
    // "leaf" and "split". The flat, `leaf.id`-keyed renderer must not.
    const { rerender } = render(PaneSplit, { tree: LEAF, ...baseProps });
    mountLog.length = 0; // only care about mount/destroy events from here on

    // Split the lone leaf p1 into split[p1, p2]: p1 must survive untouched.
    rerender({ tree: SPLIT, ...baseProps });
    expect(mountLog).not.toContain("destroy:p1");
    expect(mountLog).toContain("mount:p2");

    mountLog.length = 0;

    // Collapse back down to a lone leaf p2 (closing p1): the survivor p2
    // must not be destroyed/remounted either.
    rerender({ tree: leafNode("p2"), ...baseProps });
    expect(mountLog).toContain("destroy:p1");
    expect(mountLog).not.toContain("destroy:p2");
    expect(mountLog).not.toContain("mount:p2");
  });
});
