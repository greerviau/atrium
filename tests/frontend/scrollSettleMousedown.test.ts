import { describe, it, expect, afterEach, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { handleScrollSettleMousedown, wheelTracker, RECENT_SCROLL_WINDOW_MS } from "../../src/lib/editor/baseExtensions";

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
function stubAnimationFrame(): { flush: () => void } {
  const callbacks: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    callbacks.push(cb);
    return callbacks.length;
  });
  return {
    flush: () => callbacks.splice(0, callbacks.length).forEach((cb) => cb(0)),
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
    frame.flush();

    expect(seen).toEqual(["mousedown:5,5"]);
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
    frame.flush();

    expect(replayResult).toBe(false);
  });

  it("treats a mousedown at or beyond the settle window as not recent", () => {
    const v = makeView();
    const target = makeTarget();
    v.scrollDOM.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));

    const tracker = v.plugin(wheelTracker);
    expect(tracker).toBeTruthy();
    // Simulate the settle window having fully elapsed since the wheel event.
    tracker!.lastWheelTime -= RECENT_SCROLL_WINDOW_MS;

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
    frame.flush();

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
    frame.flush();

    expect(seenTypes).toEqual(["mousedown"]);
  });
});
