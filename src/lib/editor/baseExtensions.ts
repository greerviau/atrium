import { EditorSelection, findClusterBreak, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type MouseSelectionStyle } from "@codemirror/view";
import { history, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { autocompletion } from "@codemirror/autocomplete";

// --- Part 1: a mouse-selection style that never mistakes scroll-drift for a drag (issue #161) ---
//
// `@codemirror/view`'s own `basicMouseSelection` resolves a click's document
// position once at `mousedown` and again when it builds the selection
// (`get()` — called synchronously right after for a stationary click, or
// again on the next `mousemove`). If a scroll settles between those two
// resolutions, the two positions differ even though the pointer never
// moved, and upstream's plain `start.pos != cur.pos` check reads that as a
// drag, producing a large spurious range selection. The fix below is a
// vendored adaptation of upstream (MIT-licensed) that additionally requires
// real on-screen pointer movement before treating the gesture as a drag.

/** Matches `@codemirror/view`'s own threshold (its internal `dist()`/`MouseSelection.move()`) for "the pointer actually moved, this is a drag." */
const DRAG_MOVEMENT_THRESHOLD_PX = 10;

function pointerDistance(a: { clientX: number; clientY: number }, b: { clientX: number; clientY: number }): number {
  return Math.max(Math.abs(a.clientX - b.clientX), Math.abs(a.clientY - b.clientY));
}

/**
 * Vendored `groupAt` from `@codemirror/view` (MIT) — the word/grapheme-cluster
 * group surrounding `pos`, used for double-click selection. Not part of the
 * package's public API, so re-implemented here from its public primitives
 * (`EditorState.charCategorizer`, `findClusterBreak`).
 */
function groupAt(state: EditorState, pos: number, bias: -1 | 1 = 1) {
  const categorize = state.charCategorizer(pos);
  const line = state.doc.lineAt(pos);
  const linePos = pos - line.from;
  if (line.length === 0) return EditorSelection.cursor(pos);
  let effectiveBias = bias;
  if (linePos === 0) effectiveBias = 1;
  else if (linePos === line.length) effectiveBias = -1;
  let from = linePos;
  let to = linePos;
  if (effectiveBias < 0) from = findClusterBreak(line.text, linePos, false);
  else to = findClusterBreak(line.text, linePos);
  const cat = categorize(line.text.slice(from, to));
  while (from > 0) {
    const prev = findClusterBreak(line.text, from, false);
    if (categorize(line.text.slice(prev, from)) !== cat) break;
    from = prev;
  }
  while (to < line.length) {
    const next = findClusterBreak(line.text, to);
    if (categorize(line.text.slice(to, next)) !== cat) break;
    to = next;
  }
  return EditorSelection.undirectionalRange(from + line.from, to + line.from);
}

/** The subset of `EditorView`'s internal (not publicly typed) `docView` used below, matching upstream's own `rangeForClick`. */
interface InternalDocView {
  lineAt(pos: number, side: -1 | 1): { posAtStart: number; posAtEnd: number } | null;
}

/**
 * Vendored `rangeForClick` from `@codemirror/view` (MIT) — the click-count-aware
 * range for a resolved position: a cursor (single click), a word (double
 * click), or a line (triple click, preferring the visual/wrapped line the
 * same way upstream does via its internal `docView`).
 */
function rangeForClick(view: EditorView, pos: number, bias: -1 | 1, clickCount: number) {
  if (clickCount === 1) {
    return EditorSelection.cursor(pos, bias);
  } else if (clickCount === 2) {
    return groupAt(view.state, pos, bias);
  } else {
    const docView = (view as unknown as { docView: InternalDocView }).docView;
    const visual = docView.lineAt(pos, bias);
    const line = view.state.doc.lineAt(visual ? visual.posAtEnd : pos);
    const from = visual ? visual.posAtStart : line.from;
    let to = visual ? visual.posAtEnd : line.to;
    if (to < view.state.doc.length && to === line.to) to++;
    return EditorSelection.undirectionalRange(from, to);
  }
}

function removeRangeAround(sel: EditorSelection, pos: number) {
  for (let i = 0; i < sel.ranges.length; i++) {
    const { from, to } = sel.ranges[i];
    if (from <= pos && to >= pos) {
      return EditorSelection.create(
        sel.ranges.slice(0, i).concat(sel.ranges.slice(i + 1)),
        sel.mainIndex === i ? 0 : sel.mainIndex - (sel.mainIndex > i ? 1 : 0),
      );
    }
  }
  return null;
}

/**
 * `EditorView.mouseSelectionStyle` override: identical to upstream's own
 * `basicMouseSelection` (double/triple-click, shift-extend, multi-cursor
 * Alt/Cmd-click, real click-and-drag all behave exactly as before) except
 * that building a *range* out of two disagreeing position samples also
 * requires the pointer's on-screen coordinates to have actually moved. A
 * click that is stationary on screen never produces a selection, no matter
 * how the resolved document position drifted underneath it.
 */
export function movementAwareMouseSelectionStyle(view: EditorView, startEvent: MouseEvent): MouseSelectionStyle {
  const start = view.posAndSideAtCoords({ x: startEvent.clientX, y: startEvent.clientY }, false);
  const clickCount = startEvent.detail || 1;
  let startSel = view.state.selection;
  return {
    update(update) {
      if (update.docChanged) {
        start.pos = update.changes.mapPos(start.pos);
        startSel = startSel.map(update.changes);
      }
    },
    get(curEvent, extend, multiple) {
      const cur = view.posAndSideAtCoords({ x: curEvent.clientX, y: curEvent.clientY }, false);
      let range = rangeForClick(view, cur.pos, cur.assoc, clickCount);
      const moved = pointerDistance(startEvent, curEvent) >= DRAG_MOVEMENT_THRESHOLD_PX;
      if (start.pos !== cur.pos && moved && !extend) {
        const startRange = rangeForClick(view, start.pos, start.assoc, clickCount);
        const from = Math.min(startRange.from, range.from);
        const to = Math.max(startRange.to, range.to);
        range = from < range.from ? EditorSelection.range(from, to, range.assoc) : EditorSelection.range(to, from, range.assoc);
      }
      if (extend) {
        return startSel.replaceRange(startSel.main.extend(range.from, range.to, range.assoc));
      }
      const removed =
        multiple && clickCount === 1 && startSel.ranges.length > 1 ? removeRangeAround(startSel, cur.pos) : null;
      if (removed) {
        return removed;
      } else if (multiple) {
        return startSel.addRange(range);
      } else {
        return EditorSelection.create([range]);
      }
    },
  };
}

// --- Part 2: never resolve a click's position before a very recent scroll has actually landed ---
//
// A wheel/trackpad scroll's visible effect (`scrollTop`) lags its own event
// by tens of milliseconds — generic browser (compositor) behavior, not
// something application code can speed up. A `mousedown` landing inside
// that window gets its position resolved against the pre-scroll layout. Part
// 1 above stops that from producing a spurious *range*, but the resolved
// cursor position itself is still wrong. This tracks the most recent `wheel`
// event on the pane's scroller and, on a `mousedown` that follows one too
// closely, defers this click's resolution by one animation frame — by which
// point the scroll has always caught up — then replays it as a fresh
// `mousedown` so it runs back through the exact same (movement-aware)
// selection logic as any other click.

/** 3-4x the measured real scroll-settle window (~15-40ms): enough margin to never miss the race, without widening far enough to interfere with an intentional fast double-click. */
const RECENT_SCROLL_WINDOW_MS = 120;

class WheelTracker {
  lastWheelTime = -Infinity;
  private view: EditorView;
  private onWheel = () => {
    this.lastWheelTime = Date.now();
  };

  constructor(view: EditorView) {
    this.view = view;
    view.scrollDOM.addEventListener("wheel", this.onWheel, { passive: true });
  }

  destroy() {
    this.view.scrollDOM.removeEventListener("wheel", this.onWheel);
  }
}

const wheelTracker = ViewPlugin.fromClass(WheelTracker);

/** Marks a `mousedown` this extension has already redispatched once (after the settle delay), so it isn't deferred a second time. */
const deferredMouseEvents = new WeakSet<MouseEvent>();

function replayMousedownNextFrame(view: EditorView, event: MouseEvent, target: EventTarget): void {
  requestAnimationFrame(() => {
    const replay = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      view: window,
      detail: event.detail,
      clientX: event.clientX,
      clientY: event.clientY,
      button: event.button,
      buttons: event.buttons,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
    });
    deferredMouseEvents.add(replay);
    target.dispatchEvent(replay);
  });
}

/**
 * Registered via `EditorView.domEventHandlers`, which — like the existing
 * `linkClickHandler` in `livePreviewPlugin.ts` — runs before CodeMirror's own
 * built-in `mousedown` handling, so returning `true` here pre-empts it for
 * this event only.
 */
const scrollSettleMouseHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (deferredMouseEvents.has(event)) {
      return false;
    }
    const sinceWheel = Date.now() - (view.plugin(wheelTracker)?.lastWheelTime ?? -Infinity);
    if (sinceWheel >= RECENT_SCROLL_WINDOW_MS) {
      return false;
    }
    replayMousedownNextFrame(view, event, event.target ?? view.contentDOM);
    return true;
  },
});

/**
 * Extensions shared by every pane (markdown rendered, markdown source, and
 * code — all via `EditorPane.svelte`'s `viewModeExtensions`): history, the
 * default/history keymaps, tab-to-indent, the find/replace panel, word-based
 * autocompletion, and the scroll-safe mouse-selection handling above.
 * Multi-cursor (Alt-click, Cmd-D select-next) is core `EditorView`/
 * `defaultKeymap` behavior and needs no extra extension. The CM theme and
 * syntax highlight style (theme-driven, not a library default) live in
 * `EditorPane.svelte`'s theme `Compartment` instead, since they need to be
 * reconfigured on a theme change without tearing down everything else in
 * this array. Line wrapping is mode-dependent (prose wraps, code doesn't) so
 * it lives in `EditorPane.svelte` alongside the other mode-dependent
 * extensions instead of here.
 */
export function baseExtensions(): Extension[] {
  return [
    history(),
    search(),
    autocompletion(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    EditorView.mouseSelectionStyle.of(movementAwareMouseSelectionStyle),
    wheelTracker,
    scrollSettleMouseHandler,
  ];
}
