import { describe, it, expect, afterEach, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  handleScrollSettleMousedown,
  guardFirstFocusScrollPosition,
  wheelTracker,
  RECENT_SCROLL_WINDOW_MS,
} from "../../src/lib/editor/baseExtensions";

let view: EditorView | undefined;

afterEach(() => {
  view?.destroy();
  view = undefined;
  vi.restoreAllMocks();
});

/** Only used so `view.plugin(wheelTracker)` resolves; test mousedown/mouseup events are dispatched on a separate plain element (see `makeTarget`), never on this view's own `contentDOM` — real CodeMirror mouse handling would try to measure real layout, which jsdom can't provide. */
function makeView(): EditorView {
  const container = document.createElement("div");
  document.body.appendChild(container);
  view = new EditorView({ state: EditorState.create({ doc: "hello world", extensions: [wheelTracker] }), parent: container });
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

/** Replaces `requestAnimationFrame` with a queue the test flushes by hand, so the deferred replay runs deterministically. */
function stubAnimationFrame(): { flush: () => void; flushAll: () => void } {
  const callbacks: FrameRequestCallback[] = [];
  const requestFrame = (cb: FrameRequestCallback) => {
    callbacks.push(cb);
    return callbacks.length;
  };
  vi.stubGlobal("requestAnimationFrame", requestFrame);
  const flush = () => callbacks.splice(0, callbacks.length).forEach((cb) => cb(0));
  return {
    flush,
    flushAll: () => {
      while (callbacks.length > 0) flush();
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

    const tracker = v.plugin(wheelTracker);
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

describe("guardFirstFocusScrollPosition composed with handleScrollSettleMousedown (issue #183/#161 interaction)", () => {
  /** Wires both handlers on `target` in the same precedence order `baseExtensions()` gives them in production (`firstFocusScrollGuard` is `Prec.highest`, so it always runs before `scrollSettleMouseHandler`), so a single `mousedown` dispatch — original or replayed — exercises the real composed behavior instead of either handler in isolation. */
  function installComposedMousedownHandler(target: HTMLElement, v: EditorView): void {
    target.addEventListener("mousedown", (e) => {
      const event = e as MouseEvent;
      if (guardFirstFocusScrollPosition(event, v)) return;
      handleScrollSettleMousedown(event, v);
    });
  }

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
