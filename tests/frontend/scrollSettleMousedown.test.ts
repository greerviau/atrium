import { describe, it, expect, afterEach, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  handleScrollSettleMousedown,
  guardFirstFocusScrollPosition,
  movementAwareMouseSelectionStyle,
  paneActivityTracker,
  replayAnchors,
  MAX_SETTLE_CHECKS,
  RECENT_SCROLL_WINDOW_MS,
} from "../../src/lib/editor/baseExtensions";

let view: EditorView | undefined;

afterEach(() => {
  view?.destroy();
  view = undefined;
  vi.restoreAllMocks();
});

/** Only used so `view.plugin(paneActivityTracker)` resolves; test mousedown/mouseup events are dispatched on a separate plain element (see `makeTarget`), never on this view's own `contentDOM` — real CodeMirror mouse handling would try to measure real layout, which jsdom can't provide. */
function makeView(): EditorView {
  const container = document.createElement("div");
  document.body.appendChild(container);
  view = new EditorView({ state: EditorState.create({ doc: "hello world", extensions: [paneActivityTracker] }), parent: container });
  vi.spyOn(view, "requestMeasure").mockImplementation((request) => {
    request?.read(view!);
    request?.write?.(undefined, view!);
  });
  return view;
}

function makeTarget(): HTMLElement {
  const target = document.createElement("div");
  document.body.appendChild(target);
  return target;
}

/** Dispatches a real mousedown on `target` (with no listeners yet attached) purely so the event's `.target` is populated, matching what `handleScrollSettleMousedown` sees for a genuine DOM event. */
function dispatchMousedownOn(target: HTMLElement, clientX = 5, clientY = 5): MouseEvent {
  const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX, clientY, detail: 1 });
  target.dispatchEvent(event);
  return event;
}

/** Wires both handlers on `target` in the same precedence order `baseExtensions()` gives them in production (`firstFocusScrollGuard` is `Prec.highest`, so it always runs before `scrollSettleMouseHandler`), so a single `mousedown` dispatch — original or replayed — exercises the real composed behavior instead of either handler in isolation. */
function installComposedMousedownHandler(target: HTMLElement, v: EditorView): void {
  target.addEventListener("mousedown", (e) => {
    const event = e as MouseEvent;
    if (guardFirstFocusScrollPosition(event, v)) return;
    handleScrollSettleMousedown(event, v);
  });
}

/** Replaces `requestAnimationFrame` with a queue the test flushes by hand, so the deferred replay runs deterministically. */
function stubAnimationFrame(): {
  flush: () => void;
  flushAll: (limit?: number) => { reachedLimit: boolean; iterations: number };
} {
  const callbacks: FrameRequestCallback[] = [];
  const requestFrame = (cb: FrameRequestCallback) => {
    callbacks.push(cb);
    return callbacks.length;
  };
  vi.stubGlobal("requestAnimationFrame", requestFrame);
  const flush = () => callbacks.splice(0, callbacks.length).forEach((cb) => cb(0));
  return {
    flush,
    // `limit` bounds how many frame batches this drains, so a chain that
    // never terminates (e.g. issue #455's non-terminating replay loop) fails
    // the test as an assertion on `reachedLimit`, not as a suite hang.
    flushAll: (limit = Infinity) => {
      let iterations = 0;
      while (callbacks.length > 0 && iterations < limit) {
        flush();
        iterations++;
      }
      return { reachedLimit: iterations >= limit, iterations };
    },
  };
}

describe("handleScrollSettleMousedown: Part 2 (issue #161)", () => {
  it("passes an ordinary mousedown through untouched when no wheel has fired recently", () => {
    const v = makeView();
    const target = makeTarget();
    const event = dispatchMousedownOn(target);

    expect(handleScrollSettleMousedown(event, v)).toBe(false);
  });

  it("pre-empts a mousedown that follows a wheel within the settle window, then replays it", () => {
    const v = makeView();
    const target = makeTarget();
    const frame = stubAnimationFrame();
    v.scrollDOM.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));

    const event = dispatchMousedownOn(target, 5, 5);
    expect(handleScrollSettleMousedown(event, v)).toBe(true);

    const seen: string[] = [];
    target.addEventListener("mousedown", (e) => seen.push(`mousedown:${e.clientX},${e.clientY}`));
    frame.flushAll();

    expect(seen).toEqual(["mousedown:5,5"]);
  });

  it("requests a CodeMirror measure before replaying the deferred mousedown", () => {
    const v = makeView();
    const target = makeTarget();
    const frame = stubAnimationFrame();
    const requestMeasure = vi.spyOn(v, "requestMeasure").mockImplementation((request) => {
      request?.read(v);
      request?.write?.(undefined, v);
    });
    v.scrollDOM.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));

    const event = dispatchMousedownOn(target, 5, 5);
    handleScrollSettleMousedown(event, v);

    const seen: string[] = [];
    target.addEventListener("mousedown", () => seen.push("mousedown"));
    expect(requestMeasure).toHaveBeenCalledWith({ read: expect.any(Function) });
    expect(seen).toEqual([]);
    frame.flushAll();
    expect(seen).toEqual(["mousedown"]);
  });

  it("does not defer the replayed mousedown a second time", () => {
    const v = makeView();
    const target = makeTarget();
    const frame = stubAnimationFrame();
    v.scrollDOM.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));

    const original = dispatchMousedownOn(target, 5, 5);
    handleScrollSettleMousedown(original, v);

    let replayResult: boolean | undefined;
    target.addEventListener("mousedown", (e) => {
      replayResult = handleScrollSettleMousedown(e as MouseEvent, v);
    });
    frame.flushAll();

    expect(replayResult).toBe(false);
  });

  it("defers a mousedown after the pane reports a scroll even without a wheel event", () => {
    const v = makeView();
    const target = makeTarget();
    const frame = stubAnimationFrame();
    v.scrollDOM.dispatchEvent(new Event("scroll", { bubbles: true }));

    const event = dispatchMousedownOn(target, 5, 5);
    expect(handleScrollSettleMousedown(event, v)).toBe(true);

    const seen: string[] = [];
    target.addEventListener("mousedown", (e) => seen.push(e.type));
    frame.flushAll();

    expect(seen).toEqual(["mousedown"]);
  });

  it("treats a mousedown at or beyond the settle window as not recent", () => {
    const v = makeView();
    const target = makeTarget();
    v.scrollDOM.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));

    const tracker = v.plugin(paneActivityTracker);
    expect(tracker).toBeTruthy();
    // Simulate the settle window having fully elapsed since both scroll signals.
    tracker!.lastWheelTime -= RECENT_SCROLL_WINDOW_MS;
    tracker!.lastScrollTime -= RECENT_SCROLL_WINDOW_MS;

    const event = dispatchMousedownOn(target);
    expect(handleScrollSettleMousedown(event, v)).toBe(false);
  });

  it("replays an early mouseup that fires before the deferred mousedown, instead of swallowing it", () => {
    const v = makeView();
    const target = makeTarget();
    const frame = stubAnimationFrame();
    v.scrollDOM.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));

    const event = dispatchMousedownOn(target, 5, 5);
    handleScrollSettleMousedown(event, v);

    // The real mouseup arrives before the deferred replay has run (a click released faster than one frame).
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));

    const seenTypes: string[] = [];
    target.addEventListener("mousedown", (e) => seenTypes.push(e.type));
    target.addEventListener("mouseup", (e) => seenTypes.push(e.type));
    frame.flushAll();

    expect(seenTypes).toEqual(["mousedown", "mouseup"]);
  });

  it("does not replay a mouseup when none arrived before the deferred mousedown", () => {
    const v = makeView();
    const target = makeTarget();
    const frame = stubAnimationFrame();
    v.scrollDOM.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));

    const event = dispatchMousedownOn(target, 5, 5);
    handleScrollSettleMousedown(event, v);

    const seenTypes: string[] = [];
    target.addEventListener("mousedown", (e) => seenTypes.push(e.type));
    target.addEventListener("mouseup", (e) => seenTypes.push(e.type));
    frame.flushAll();

    expect(seenTypes).toEqual(["mousedown"]);
  });
});

describe("guardFirstFocusScrollPosition (issue #183)", () => {
  it("pre-empts the first click and replays it after focus restores the reading position", () => {
    const v = makeView();
    const target = makeTarget();
    const frame = stubAnimationFrame();
    let scrollAtMousedown: number | undefined;
    vi.spyOn(v, "focus").mockImplementation(() => {
      // Simulate CodeMirror's focus path scrolling the current selection into view.
      v.scrollDOM.scrollTop = 14;
      v.contentDOM.focus();
    });
    v.scrollDOM.scrollTop = 668;
    const event = dispatchMousedownOn(target);
    expect(guardFirstFocusScrollPosition(event, v)).toBe(true);
    target.addEventListener("mousedown", () => {
      scrollAtMousedown = v.scrollDOM.scrollTop;
    });
    expect(scrollAtMousedown).toBeUndefined();

    frame.flushAll();

    expect(v.hasFocus).toBe(true);
    expect(scrollAtMousedown).toBe(668);
    expect(v.scrollDOM.scrollTop).toBe(668);
  });

  it("does not guard a pane that already has focus", () => {
    const v = makeView();
    v.contentDOM.focus();
    expect(v.hasFocus).toBe(true);

    const frame = stubAnimationFrame();
    v.scrollDOM.scrollTop = 4000;
    const event = dispatchMousedownOn(makeTarget());
    expect(guardFirstFocusScrollPosition(event, v)).toBe(false);

    v.scrollDOM.scrollTop = 0;
    frame.flush();

    expect(v.scrollDOM.scrollTop).toBe(0);
  });
});

describe("guardFirstFocusScrollPosition (issue #455)", () => {
  it("[unit case 1] resolves a click into an unfocused pane exactly once, even when document.hasFocus() stays false", () => {
    const v = makeView();
    const target = makeTarget();
    const frame = stubAnimationFrame();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    vi.spyOn(v, "focus").mockImplementation(() => {
      v.contentDOM.focus();
    });
    installComposedMousedownHandler(target, v);

    dispatchMousedownOn(target, 5, 5);
    const seen: string[] = [];
    target.addEventListener("mousedown", (e) => {
      const event = e as MouseEvent;
      seen.push(`mousedown:${event.clientX},${event.clientY}`);
    });

    const { reachedLimit } = frame.flushAll(20);

    expect(reachedLimit).toBe(false);
    expect(seen).toEqual(["mousedown:5,5"]);
  });

  it("[unit case 2] does not defer a click when contentDOM already holds DOM focus, even though document.hasFocus() is false", () => {
    const v = makeView();
    v.contentDOM.focus();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    expect(v.hasFocus).toBe(false); // the predicate this guard no longer uses

    const event = dispatchMousedownOn(makeTarget());
    expect(guardFirstFocusScrollPosition(event, v)).toBe(false);
  });

  it("[unit case 3] still runs the focus-and-restore path exactly once before resolving, when focus cannot be taken at all", () => {
    const v = makeView();
    const target = makeTarget();
    const frame = stubAnimationFrame();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    let focusCalls = 0;
    vi.spyOn(v, "focus").mockImplementation(() => {
      focusCalls++;
      v.contentDOM.focus();
    });
    installComposedMousedownHandler(target, v);

    v.scrollDOM.scrollTop = 668;
    dispatchMousedownOn(target, 5, 5);
    let scrollAtMousedown: number | undefined;
    target.addEventListener("mousedown", () => {
      scrollAtMousedown = v.scrollDOM.scrollTop;
    });

    frame.flushAll(20);

    expect(focusCalls).toBe(1);
    expect(scrollAtMousedown).toBe(668);
  });
});

describe("guardFirstFocusScrollPosition composed with handleScrollSettleMousedown (issue #183/#161 interaction)", () => {
  it("lands on the settled scroll position, not the pre-settle stale one, for a click deferred into an unfocused pane", () => {
    const v = makeView();
    const target = makeTarget();
    const frame = stubAnimationFrame();
    installComposedMousedownHandler(target, v);

    v.scrollDOM.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    v.scrollDOM.scrollTop = 1000;
    dispatchMousedownOn(target, 5, 5);

    // Settles before the deferred replay's frame runs.
    v.scrollDOM.scrollTop = 4000;
    frame.flushAll();

    expect(v.scrollDOM.scrollTop).toBe(4000);
  });

  it("holds an early mouseup until the first-focus scroll restore runs", () => {
    const v = makeView();
    const target = makeTarget();
    const frame = stubAnimationFrame();
    installComposedMousedownHandler(target, v);

    let scrollAtMousedown: number | undefined;
    let scrollAtMouseup: number | undefined;
    vi.spyOn(v, "focus").mockImplementation(() => {
      // Simulate focus moving the scroller before the click is resolved.
      v.scrollDOM.scrollTop = 0;
      v.contentDOM.focus();
    });
    target.addEventListener("mousedown", () => {
      scrollAtMousedown = v.scrollDOM.scrollTop;
    });
    target.addEventListener("mouseup", () => {
      scrollAtMouseup = v.scrollDOM.scrollTop;
    });

    v.scrollDOM.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    v.scrollDOM.scrollTop = 1000;
    dispatchMousedownOn(target, 5, 5);
    v.scrollDOM.scrollTop = 4000;
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    frame.flushAll();

    expect(scrollAtMousedown).toBe(4000);
    expect(scrollAtMouseup).toBe(4000);
  });

  it("records the restored scroll offset before the replayed click resolves", () => {
    const v = makeView();
    const target = makeTarget();
    const frame = stubAnimationFrame();
    installComposedMousedownHandler(target, v);
    let scrollAtMousedown: number | undefined;
    vi.spyOn(v, "focus").mockImplementation(() => {
      v.scrollDOM.scrollTop = 0;
      v.contentDOM.focus();
    });
    target.addEventListener("mousedown", () => {
      scrollAtMousedown = v.scrollDOM.scrollTop;
    });

    v.scrollDOM.scrollTop = 4000;
    dispatchMousedownOn(target, 5, 5);
    frame.flushAll();

    expect(scrollAtMousedown).toBe(4000);
    expect(v.scrollDOM.scrollTop).toBe(4000);
  });
});

describe("replayMousedownAfterMeasure: the anchor latch, Phase B, and target re-derivation (issue #454)", () => {
  it("[unit case 4] latches the anchor at the press, before the settle loop runs", () => {
    const v = makeView();
    const target = makeTarget();
    const frame = stubAnimationFrame();
    let call = 0;
    // Resolves to 3 on the very first (press-time) call; every later call
    // returns 8, simulating the layout having moved by the time anything
    // else asks `posAndSideAtCoords` a question.
    const positions = [3, 8];
    vi.spyOn(v, "posAndSideAtCoords").mockImplementation(() => {
      const pos = positions[Math.min(call, positions.length - 1)];
      call++;
      return { pos, assoc: 1 };
    });
    v.scrollDOM.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));

    const event = dispatchMousedownOn(target, 5, 5);
    handleScrollSettleMousedown(event, v);

    let replayed: MouseEvent | undefined;
    target.addEventListener("mousedown", (e) => {
      replayed = e as MouseEvent;
    });
    frame.flushAll();

    expect(replayed).toBeDefined();
    expect(replayAnchors.get(replayed!)).toEqual({ pos: 3, assoc: 1 });

    // Resolving the replayed click's own selection - by which point every
    // further posAndSideAtCoords call returns 8 - still lands on the
    // position latched at the press, not on 8.
    const style = movementAwareMouseSelectionStyle(v, replayed!);
    const sel = style.get(replayed!, false, false);
    expect(sel.main.from).toBe(3);
    expect(sel.main.to).toBe(3);
  });

  it("on an already-focused pane, skips the focus-restore dance and goes straight to Phase B", () => {
    const v = makeView();
    const target = makeTarget();
    const frame = stubAnimationFrame();
    v.contentDOM.focus();
    expect(v.root.activeElement).toBe(v.contentDOM);
    const focusSpy = vi.spyOn(v, "focus");

    v.scrollDOM.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    const event = dispatchMousedownOn(target, 5, 5);
    handleScrollSettleMousedown(event, v);

    let dispatched = false;
    target.addEventListener("mousedown", () => {
      dispatched = true;
    });
    frame.flushAll();

    expect(focusSpy).not.toHaveBeenCalled();
    expect(dispatched).toBe(true);
  });

  it("[unit case 9] Phase B waits for CodeMirror's own geometry to hold still, not just the scroll offset", () => {
    const v = makeView();
    const target = makeTarget();
    const frame = stubAnimationFrame();
    // Phase B only runs on the already-focused fast path (see `replay()`'s
    // own comment on why the not-yet-focused branch skips it).
    v.contentDOM.focus();
    v.scrollDOM.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    const event = dispatchMousedownOn(target, 5, 5);
    handleScrollSettleMousedown(event, v);

    let dispatched = false;
    target.addEventListener("mousedown", () => {
      dispatched = true;
    });

    const tracker = v.plugin(paneActivityTracker)!;
    // Keep reporting a geometry change on every frame for a while - Phase A's
    // own condition (scroll offset) is already quiet throughout, so only a
    // guard that also watches geometry would still be waiting.
    for (let i = 0; i < 4; i++) {
      tracker.geometryEpoch++;
      frame.flush();
    }
    expect(dispatched).toBe(false);

    // Geometry holds still from here; Phase B needs two consecutive quiet
    // frames, well inside what's left of the shared budget.
    const { reachedLimit } = frame.flushAll(MAX_SETTLE_CHECKS * 2);
    expect(reachedLimit).toBe(false);
    expect(dispatched).toBe(true);
  });

  it("[unit case 10] the settle budget is shared and bounded: a Phase A that never quiets down still replays, spending at most MAX_SETTLE_CHECKS checks total", () => {
    const v = makeView();
    const target = makeTarget();
    const frame = stubAnimationFrame();
    vi.spyOn(v, "focus").mockImplementation(() => {
      v.contentDOM.focus();
    });
    let requestMeasureCalls = 0;
    const originalRequestMeasure = v.requestMeasure.bind(v);
    vi.spyOn(v, "requestMeasure").mockImplementation((request) => {
      requestMeasureCalls++;
      return originalRequestMeasure(request as never);
    });
    v.scrollDOM.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    const event = dispatchMousedownOn(target, 5, 5);
    handleScrollSettleMousedown(event, v);

    let dispatched = false;
    target.addEventListener("mousedown", () => {
      dispatched = true;
    });

    // Phase A's own condition never quiets down: keep nudging the scroll
    // offset every frame so it can never see two consecutive stable checks.
    let top = 0;
    for (let i = 0; i < MAX_SETTLE_CHECKS + 4 && !dispatched; i++) {
      v.scrollDOM.scrollTop = top++;
      frame.flush();
    }

    expect(dispatched).toBe(true);
    // Every settle check - Phase A's and Phase B's - calls requestMeasure
    // exactly once; a Phase A that never stabilizes should exhaust the whole
    // shared budget rather than run Phase B's checks on top of it.
    expect(requestMeasureCalls).toBeLessThanOrEqual(MAX_SETTLE_CHECKS + 2); // +2: replay()'s own focus-restore measure/write/measure, outside the settle budget
  });

  it("[unit case 11] re-derives a detached dispatch target from the anchor instead of dropping the click", () => {
    const v = makeView();
    const target = makeTarget();
    const frame = stubAnimationFrame();
    vi.spyOn(v, "focus").mockImplementation(() => {
      v.contentDOM.focus();
    });
    // A valid in-document position: dispatching the replayed event runs
    // through CodeMirror's own real (unconfigured, upstream) mousedown
    // handling once it lands inside `contentDOM`, which would throw on an
    // out-of-bounds selection.
    vi.spyOn(v, "posAndSideAtCoords").mockReturnValue({ pos: 3, assoc: 1 });
    const liveElement = document.createElement("span");
    v.contentDOM.appendChild(liveElement);
    vi.spyOn(v, "domAtPos").mockReturnValue({ node: liveElement, offset: 0 });

    v.scrollDOM.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    const event = dispatchMousedownOn(target, 5, 5);
    handleScrollSettleMousedown(event, v);

    // The press-time element is gone by the time the deferral resolves.
    target.remove();

    let dispatchedOnLiveElement = false;
    let dispatchedOnTarget = false;
    liveElement.addEventListener("mousedown", () => {
      dispatchedOnLiveElement = true;
    });
    target.addEventListener("mousedown", () => {
      dispatchedOnTarget = true;
    });

    frame.flushAll();

    expect(dispatchedOnTarget).toBe(false);
    expect(dispatchedOnLiveElement).toBe(true);
  });

  it("[unit case 11] falls back to contentDOM when the anchor has no live element to redirect to", () => {
    const v = makeView();
    const target = makeTarget();
    const frame = stubAnimationFrame();
    vi.spyOn(v, "focus").mockImplementation(() => {
      v.contentDOM.focus();
    });
    vi.spyOn(v, "posAndSideAtCoords").mockReturnValue({ pos: 3, assoc: 1 });
    // Outside the rendered viewport, so `replayTarget` never calls `domAtPos`.
    vi.spyOn(v, "viewport", "get").mockReturnValue({ from: 5, to: 6 });

    v.scrollDOM.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    const event = dispatchMousedownOn(target, 5, 5);
    handleScrollSettleMousedown(event, v);

    target.remove();

    let dispatchedOnContentDOM = false;
    v.contentDOM.addEventListener("mousedown", () => {
      dispatchedOnContentDOM = true;
    });

    frame.flushAll();

    expect(dispatchedOnContentDOM).toBe(true);
  });
});

/** jsdom has no real layout, so `posAndSideAtCoords` can't resolve coordinates on its own; matches the stub in `mouseSelection.test.ts`. */
function mouseEvent(type: string, opts: Partial<MouseEventInit> & { detail?: number } = {}): MouseEvent {
  return new MouseEvent(type, { clientX: 0, clientY: 0, detail: 1, ...opts });
}

describe("movementAwareMouseSelectionStyle: the replay anchor (issue #454, plan §5.6)", () => {
  it("[unit case 6] does not build a relayout-sized range from a one-pixel jiggle, even though the live layout has moved well away from the anchor", () => {
    // The regression revision 2 would have shipped: comparing the anchor
    // (press-time layout) against a live resolution reads the pane's own
    // relayout as pointer movement. Both live calls below resolve to the
    // same position, as they would in a real layout barely a pixel apart,
    // so drag-ness is decided honestly even though that live position sits
    // far from the anchor.
    const v = makeView();
    const mousedown = mouseEvent("mousedown", { clientX: 10, clientY: 10, detail: 1 });
    replayAnchors.set(mousedown, { pos: 2, assoc: 1 });
    vi.spyOn(v, "posAndSideAtCoords").mockReturnValue({ pos: 9, assoc: 1 });

    const style = movementAwareMouseSelectionStyle(v, mousedown);
    const moveEvent = mouseEvent("mousemove", { clientX: 11, clientY: 10, detail: 1 }); // 1px away
    const sel = style.get(moveEvent, false, false);

    expect(sel.ranges).toHaveLength(1);
    expect(sel.main.from).toBe(sel.main.to); // a cursor, never a range spanning anchor (2) to the live position (9)
    expect(sel.main.from).toBe(2);
  });

  it("[unit case 5] resolves a stationary click to the anchor, even though posAndSideAtCoords now resolves elsewhere", () => {
    const v = makeView();
    const mousedown = mouseEvent("mousedown", { clientX: 10, clientY: 10, detail: 1 });
    replayAnchors.set(mousedown, { pos: 3, assoc: 1 });
    vi.spyOn(v, "posAndSideAtCoords").mockReturnValue({ pos: 8, assoc: 1 });

    const style = movementAwareMouseSelectionStyle(v, mousedown);
    const sel = style.get(mousedown, false, false);

    expect(sel.main.from).toBe(3);
    expect(sel.main.to).toBe(3);
  });

  it("[unit case 7] does not regress issue #161 for an anchored gesture: identical coordinates never build a range, even if the live resolution drifts between calls", () => {
    const v = makeView();
    const mousedown = mouseEvent("mousedown", { clientX: 10, clientY: 10, detail: 1 });
    replayAnchors.set(mousedown, { pos: 2, assoc: 1 });
    let call = 0;
    const drifting = [5, 9];
    vi.spyOn(v, "posAndSideAtCoords").mockImplementation(() => {
      const pos = drifting[Math.min(call, drifting.length - 1)];
      call++;
      return { pos, assoc: 1 };
    });

    const style = movementAwareMouseSelectionStyle(v, mousedown);
    const sel = style.get(mousedown, false, false); // same event: identical coordinates, no real movement

    expect(sel.ranges).toHaveLength(1);
    expect(sel.main.from).toBe(sel.main.to);
    expect(sel.main.from).toBe(2); // the anchor, not either drifted live resolution
  });

  it("[unit case 8] resolves both ends of a real drag live, without the anchor", () => {
    const v = makeView();
    const mousedown = mouseEvent("mousedown", { clientX: 10, clientY: 10, detail: 1 });
    replayAnchors.set(mousedown, { pos: 1, assoc: 1 });
    let call = 0;
    // get() resolves `cur` first, then re-resolves the press coordinates as `pressNow`.
    const live = [9, 5];
    vi.spyOn(v, "posAndSideAtCoords").mockImplementation(() => {
      const pos = live[Math.min(call, live.length - 1)];
      call++;
      return { pos, assoc: 1 };
    });

    const style = movementAwareMouseSelectionStyle(v, mousedown);
    const moveEvent = mouseEvent("mousemove", { clientX: 50, clientY: 10, detail: 1 }); // 40px away
    const sel = style.get(moveEvent, false, false);

    expect(sel.main.from).toBe(5);
    expect(sel.main.to).toBe(9);
  });
});
