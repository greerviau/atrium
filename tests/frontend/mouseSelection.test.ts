import { describe, it, expect, afterEach, vi } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { movementAwareMouseSelectionStyle } from "../../src/lib/editor/baseExtensions";

let view: EditorView | undefined;

afterEach(() => {
  view?.destroy();
  view = undefined;
});

function makeView(doc: string): EditorView {
  const container = document.createElement("div");
  document.body.appendChild(container);
  view = new EditorView({ state: EditorState.create({ doc }), parent: container });
  return view;
}

function mouseEvent(type: string, opts: Partial<MouseEventInit> & { detail?: number } = {}): MouseEvent {
  return new MouseEvent(type, { clientX: 0, clientY: 0, detail: 1, ...opts });
}

/** jsdom has no real layout, so `posAndSideAtCoords` can't resolve coordinates on its own; stub it to return a scripted sequence of positions, one per call, repeating the last for any call beyond the list. */
function stubResolvedPositions(target: EditorView, positions: number[]): void {
  let call = 0;
  vi.spyOn(target, "posAndSideAtCoords").mockImplementation(() => {
    const pos = positions[Math.min(call, positions.length - 1)];
    call++;
    return { pos, assoc: 1 };
  });
}

describe("movementAwareMouseSelectionStyle: Part 1 (issue #161)", () => {
  it("collapses the selection when the resolved position drifts but the pointer never moved", () => {
    const v = makeView("word1 word2 word3\nline two\nline three");
    // mousedown resolves to 5 (pre-scroll layout); get() resolves to 20 (post-scroll,
    // correct) — same event, so identical clientX/clientY: no real movement occurred.
    stubResolvedPositions(v, [5, 20]);
    const mousedown = mouseEvent("mousedown", { clientX: 100, clientY: 100, detail: 1 });
    const style = movementAwareMouseSelectionStyle(v, mousedown);
    const sel = style.get(mousedown, false, false);

    expect(sel.ranges).toHaveLength(1);
    expect(sel.main.from).toBe(sel.main.to);
    expect(sel.main.from).toBe(20);
  });

  it("still builds a range selection for a genuine click-and-drag", () => {
    const v = makeView("word1 word2 word3\nline two\nline three");
    stubResolvedPositions(v, [5, 20]);
    const mousedown = mouseEvent("mousedown", { clientX: 10, clientY: 10, detail: 1 });
    const style = movementAwareMouseSelectionStyle(v, mousedown);
    const moveEvent = mouseEvent("mousemove", { clientX: 200, clientY: 10, detail: 1 });
    const sel = style.get(moveEvent, false, false);

    expect(sel.main.from).toBe(5);
    expect(sel.main.to).toBe(20);
  });

  it("places a plain collapsed cursor for an ordinary stationary click", () => {
    const v = makeView("word1 word2 word3");
    stubResolvedPositions(v, [7]);
    const mousedown = mouseEvent("mousedown", { clientX: 10, clientY: 10, detail: 1 });
    const style = movementAwareMouseSelectionStyle(v, mousedown);
    const sel = style.get(mousedown, false, false);

    expect(sel.ranges).toHaveLength(1);
    expect(sel.main.from).toBe(7);
    expect(sel.main.to).toBe(7);
  });

  it("selects the enclosing word on a double click", () => {
    const v = makeView("hello world");
    stubResolvedPositions(v, [2]);
    const mousedown = mouseEvent("mousedown", { clientX: 10, clientY: 10, detail: 2 });
    const style = movementAwareMouseSelectionStyle(v, mousedown);
    const sel = style.get(mousedown, false, false);

    expect(sel.main.from).toBe(0);
    expect(sel.main.to).toBe(5); // "hello"
  });

  it("selects the whole line on a triple click", () => {
    const v = makeView("first line\nsecond line\nthird line");
    const line2 = v.state.doc.line(2);
    stubResolvedPositions(v, [line2.from + 3]);
    const mousedown = mouseEvent("mousedown", { clientX: 10, clientY: 10, detail: 3 });
    const style = movementAwareMouseSelectionStyle(v, mousedown);
    const sel = style.get(mousedown, false, false);

    expect(sel.main.from).toBe(line2.from);
    expect(sel.main.to).toBe(line2.to + 1); // includes the trailing newline, matching upstream
  });

  it("extends the existing selection on a shift-click", () => {
    const v = makeView("word1 word2 word3");
    v.dispatch({ selection: EditorSelection.cursor(3) });
    stubResolvedPositions(v, [10]);
    const mousedown = mouseEvent("mousedown", { clientX: 10, clientY: 10, detail: 1, shiftKey: true });
    const style = movementAwareMouseSelectionStyle(v, mousedown);
    const sel = style.get(mousedown, true, false);

    expect(sel.main.anchor).toBe(3);
    expect(sel.main.head).toBe(10);
  });

  it("adds a new cursor for a multi-select click (Alt/Cmd-click)", () => {
    const v = makeView("word1 word2 word3");
    v.dispatch({ selection: EditorSelection.cursor(3) });
    stubResolvedPositions(v, [10]);
    const mousedown = mouseEvent("mousedown", { clientX: 10, clientY: 10, detail: 1 });
    const style = movementAwareMouseSelectionStyle(v, mousedown);
    const sel = style.get(mousedown, false, true);

    expect(sel.ranges).toHaveLength(2);
    expect(sel.ranges.some((r) => r.from === 10 && r.to === 10)).toBe(true);
    expect(sel.ranges.some((r) => r.from === 3 && r.to === 3)).toBe(true);
  });
});
