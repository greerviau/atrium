import { describe, it, expect, vi, afterEach } from "vitest";
import { get } from "svelte/store";
import { beginTabDrag, draggingTabKey } from "../../src/lib/editor/tabDrag";

/**
 * jsdom implements no real `PointerEvent` with usable coordinates, so the
 * gesture is driven through plain bubbling `Event`s stamped with the fields
 * `tabDrag.ts` reads — the same convention `explorerDragMove.test.ts` and
 * `tableHandles.test.ts` use for their own pointer-driven drags. No
 * `setPointerCapture`/`releasePointerCapture` stubbing is needed here:
 * `beginTabDrag` uses neither, unlike `explorerDrag.ts`'s own gesture.
 */
function pointerEvt(
  type: string,
  opts: { clientX?: number; clientY?: number; pointerId?: number; button?: number } = {},
): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperty(event, "button", { value: opts.button ?? 0, configurable: true });
  Object.defineProperty(event, "pointerId", { value: opts.pointerId ?? 1, configurable: true });
  Object.defineProperty(event, "clientX", { value: opts.clientX ?? 0, configurable: true });
  Object.defineProperty(event, "clientY", { value: opts.clientY ?? 0, configurable: true });
  return event;
}

function makeTabEl(left: number, width: number): HTMLElement {
  const el = document.createElement("div");
  vi.spyOn(el, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        left,
        right: left + width,
        top: 0,
        bottom: 20,
        width,
        height: 20,
        x: left,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  );
  return el;
}

/** Three 50px-wide tabs laid out left to right: a [0,50), b [50,100), c [100,150). */
function threeTabRects(): Array<{ path: string; rect: DOMRect }> {
  return [
    { path: "a", rect: makeTabEl(0, 50).getBoundingClientRect() },
    { path: "b", rect: makeTabEl(50, 50).getBoundingClientRect() },
    { path: "c", rect: makeTabEl(100, 50).getBoundingClientRect() },
  ];
}

/**
 * A tab element whose own measured `left` can be changed mid-gesture, via
 * the returned setter — standing in for what a real committed reorder does
 * to the dragged tab's own layout position (it moves to a new sibling slot,
 * so its next `getBoundingClientRect()` reads a different `left`).
 * `makeTabEl`'s own rect is fixed for its whole lifetime, which can't
 * exercise the clear-measure-reapply fix at all: with a rect that never
 * changes, `e.clientX - grabOffsetX - rect.left` and the naive, gesture-
 * start-anchored `e.clientX - startX` compute the exact same number on
 * every move, so a reversion to the naive form would leave every existing
 * assertion green.
 */
function makeMovableTabEl(initialLeft: number, width: number): { el: HTMLElement; setLeft: (left: number) => void } {
  let left = initialLeft;
  const el = document.createElement("div");
  vi.spyOn(el, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        left,
        right: left + width,
        top: 0,
        bottom: 20,
        width,
        height: 20,
        x: left,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  );
  return { el, setLeft: (l) => (left = l) };
}

afterEach(() => {
  draggingTabKey.set(null);
});

describe("beginTabDrag", () => {
  it("does not call onReorder or set draggingTabKey for a move below the drag threshold", () => {
    const tabEl = makeTabEl(0, 50);
    const onReorder = vi.fn();
    beginTabDrag(tabEl, pointerEvt("pointerdown", { clientX: 10 }), "leaf:a", "a", threeTabRects, onReorder);

    window.dispatchEvent(pointerEvt("pointermove", { clientX: 12 })); // 2px, under DRAG_THRESHOLD_PX (4)

    expect(onReorder).not.toHaveBeenCalled();
    expect(get(draggingTabKey)).toBeNull();
  });

  it("fires onReorder once the pointer crosses the threshold, and sets draggingTabKey", () => {
    const tabEl = makeTabEl(0, 50);
    const onReorder = vi.fn();
    beginTabDrag(tabEl, pointerEvt("pointerdown", { clientX: 10 }), "leaf:a", "a", threeTabRects, onReorder);

    // Past b's own midpoint (75): targets index 1 (between b and c).
    window.dispatchEvent(pointerEvt("pointermove", { clientX: 80 }));

    expect(get(draggingTabKey)).toBe("leaf:a");
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith("a", 1);
  });

  // This is the test that catches M3 (the clear-measure-reapply fix): a
  // naive, gesture-start-anchored transform (`translateX(clientX - startX)`)
  // and the correct clear-measure-reapply one (`clientX - grabOffsetX -
  // rect.left`, re-measuring the tab's own live position on every move)
  // compute the *same* number as long as the tab's own measured position
  // never changes mid-gesture — which is exactly what a fixed-rect mock
  // gives you, and exactly why this needs `makeMovableTabEl` rather than
  // `makeTabEl`. `setLeft` between the two moves stands in for a real
  // committed reorder relocating the dragged tab's DOM node to a new
  // sibling slot: the second move's pointer travels 50px further, but the
  // tab's own layout position also shifted 50px, so the *correct* transform
  // stays anchored at the same 70px offset from the pointer throughout — a
  // stale, start-anchored implementation can't see the shift at all and
  // drifts to 120px instead.
  it("re-measures the tab's own position fresh on each move, instead of caching the offset from drag start (M3 regression)", () => {
    const { el: tabEl, setLeft } = makeMovableTabEl(0, 50);
    const onReorder = vi.fn();
    beginTabDrag(tabEl, pointerEvt("pointerdown", { clientX: 10 }), "leaf:a", "a", threeTabRects, onReorder);

    window.dispatchEvent(pointerEvt("pointermove", { clientX: 80 }));
    expect(tabEl.style.transform).toBe("translateX(70px)");

    setLeft(50); // simulate the prior commit relocating the tab 50px right
    window.dispatchEvent(pointerEvt("pointermove", { clientX: 130 }));
    expect(tabEl.style.transform).toBe("translateX(70px)");
  });

  // This is the test that would have caught round 1's M2 (pointer capture
  // ending the gesture after exactly one committed step): a single-move
  // assertion can't distinguish "the gesture keeps tracking the pointer"
  // from "the gesture silently died after its first commit," since
  // capture-loss doesn't throw — it just stops delivering events. A second,
  // further pointermove in the same gesture (no intervening pointerup) must
  // still produce a fresh onReorder call with a further new index.
  it("keeps reordering across multiple pointermove steps in the same gesture, without an intervening pointerup", () => {
    const tabEl = makeTabEl(0, 50);
    const onReorder = vi.fn();
    beginTabDrag(tabEl, pointerEvt("pointerdown", { clientX: 10 }), "leaf:a", "a", threeTabRects, onReorder);

    window.dispatchEvent(pointerEvt("pointermove", { clientX: 80 })); // past b's midpoint: index 1
    window.dispatchEvent(pointerEvt("pointermove", { clientX: 130 })); // past c's midpoint too: index 2

    expect(onReorder).toHaveBeenCalledTimes(2);
    expect(onReorder).toHaveBeenNthCalledWith(1, "a", 1);
    expect(onReorder).toHaveBeenNthCalledWith(2, "a", 2);
  });

  it("does not re-fire onReorder for a further move that resolves to the same target index", () => {
    const tabEl = makeTabEl(0, 50);
    const onReorder = vi.fn();
    beginTabDrag(tabEl, pointerEvt("pointerdown", { clientX: 10 }), "leaf:a", "a", threeTabRects, onReorder);

    window.dispatchEvent(pointerEvt("pointermove", { clientX: 80 })); // index 1
    window.dispatchEvent(pointerEvt("pointermove", { clientX: 90 })); // still index 1

    expect(onReorder).toHaveBeenCalledTimes(1);
  });

  it("clears the inline transform and draggingTabKey on pointerup, without calling onReorder again", () => {
    const tabEl = makeTabEl(0, 50);
    const onReorder = vi.fn();
    beginTabDrag(tabEl, pointerEvt("pointerdown", { clientX: 10 }), "leaf:a", "a", threeTabRects, onReorder);

    window.dispatchEvent(pointerEvt("pointermove", { clientX: 80 }));
    onReorder.mockClear();

    window.dispatchEvent(pointerEvt("pointerup", { clientX: 80 }));

    expect(tabEl.style.transform).toBe("");
    expect(get(draggingTabKey)).toBeNull();
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("clears the inline transform and draggingTabKey on pointercancel, without calling onReorder again", () => {
    const tabEl = makeTabEl(0, 50);
    const onReorder = vi.fn();
    beginTabDrag(tabEl, pointerEvt("pointerdown", { clientX: 10 }), "leaf:a", "a", threeTabRects, onReorder);

    window.dispatchEvent(pointerEvt("pointermove", { clientX: 80 }));
    onReorder.mockClear();

    window.dispatchEvent(pointerEvt("pointercancel", { clientX: 80 }));

    expect(tabEl.style.transform).toBe("");
    expect(get(draggingTabKey)).toBeNull();
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("clears the inline transform and draggingTabKey on a window blur mid-drag, without calling onReorder again", () => {
    const tabEl = makeTabEl(0, 50);
    const onReorder = vi.fn();
    beginTabDrag(tabEl, pointerEvt("pointerdown", { clientX: 10 }), "leaf:a", "a", threeTabRects, onReorder);

    window.dispatchEvent(pointerEvt("pointermove", { clientX: 80 }));
    onReorder.mockClear();

    window.dispatchEvent(new Event("blur"));

    expect(tabEl.style.transform).toBe("");
    expect(get(draggingTabKey)).toBeNull();
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("removes its window listeners once the gesture ends — a pointermove after pointerup is a no-op", () => {
    const tabEl = makeTabEl(0, 50);
    const onReorder = vi.fn();
    beginTabDrag(tabEl, pointerEvt("pointerdown", { clientX: 10 }), "leaf:a", "a", threeTabRects, onReorder);

    window.dispatchEvent(pointerEvt("pointermove", { clientX: 80 }));
    window.dispatchEvent(pointerEvt("pointerup", { clientX: 80 }));
    onReorder.mockClear();

    window.dispatchEvent(pointerEvt("pointermove", { clientX: 130 }));

    expect(onReorder).not.toHaveBeenCalled();
  });

  it("ignores pointer events from a different pointerId (a second, unrelated pointer)", () => {
    const tabEl = makeTabEl(0, 50);
    const onReorder = vi.fn();
    beginTabDrag(tabEl, pointerEvt("pointerdown", { clientX: 10, pointerId: 1 }), "leaf:a", "a", threeTabRects, onReorder);

    window.dispatchEvent(pointerEvt("pointermove", { clientX: 80, pointerId: 2 }));

    expect(onReorder).not.toHaveBeenCalled();
    expect(get(draggingTabKey)).toBeNull();
  });

  it("excludes the dragged tab itself from the target-index computation — a single open tab is a no-op-producing drag", () => {
    const tabEl = makeTabEl(0, 50);
    const onReorder = vi.fn();
    const onlyTab = () => [{ path: "a", rect: makeTabEl(0, 50).getBoundingClientRect() }];
    beginTabDrag(tabEl, pointerEvt("pointerdown", { clientX: 10 }), "leaf:a", "a", onlyTab, onReorder);

    window.dispatchEvent(pointerEvt("pointermove", { clientX: 200 }));

    expect(onReorder).toHaveBeenCalledWith("a", 0);
  });
});
