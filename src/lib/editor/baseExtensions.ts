import { EditorSelection, EditorState, Prec, findClusterBreak, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, drawSelection, keymap, type MouseSelectionStyle, type ViewUpdate } from "@codemirror/view";
import { history, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import { acceptCompletion, autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { inFileSearch } from "./search/atriumSearchPanel";

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

function pointerDistance(a: { clientX: number; clientY: number }, b: { clientX: number; clientY: number }): number {
  return Math.max(Math.abs(a.clientX - b.clientX), Math.abs(a.clientY - b.clientY));
}

/**
 * Upstream's own `basicMouseSelection` has no minimum drag distance at all
 * for ordinary range selection — any pointer movement that resolves to a
 * different position starts building a range (its 10px `dist()` gate is a
 * different decision entirely: whether a click *inside* an existing
 * selection is a click-to-place-cursor or a drag-to-move-it). Issue #161 is
 * a pointer that never moved on screen at all (distance exactly 0), so
 * requiring only "moved by more than zero" fully fixes it without touching
 * real drag-select of any size.
 */
function hasPointerMoved(a: { clientX: number; clientY: number }, b: { clientX: number; clientY: number }): boolean {
  return pointerDistance(a, b) > 0;
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
      if (start.pos !== cur.pos && hasPointerMoved(startEvent, curEvent) && !extend) {
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
// A wheel/trackpad scroll's visible effect (`scrollTop`) can lag its input
// event by tens of milliseconds — generic browser (compositor) behavior, not
// something application code can speed up. The scroll event also marks the
// point at which the pane's viewport has just moved. A `mousedown` landing
// inside either window can get its position resolved against stale layout. Part
// 1 above stops that from producing a spurious *range*, but the resolved
// cursor position itself is still wrong. This tracks both signals on the
// pane's scroller and, on a `mousedown` that follows one too closely, defers
// this click until CodeMirror measures the newly scrolled rendered layout,
// then replays it as a fresh `mousedown` so it runs back through the exact
// same (movement-aware) selection logic as any other click.

/** 3-4x the measured real scroll-settle window (~15-40ms): enough margin to never miss the race, without widening far enough to interfere with an intentional fast double-click. */
export const RECENT_SCROLL_WINDOW_MS = 120;

class PaneActivityTracker {
  lastWheelTime = -Infinity;
  lastScrollTime = -Infinity;
  /**
   * Counts CodeMirror's own block-height/viewport changes rather than
   * timestamping them, so Phase B (§6 Step 4) can tell "no geometry change
   * since I last looked" apart from "a change I haven't seen yet" without
   * caring how many happened in one frame — two height-changing updates in
   * one frame must be distinguishable from none, and the only thing a
   * consumer ever does with this is compare it across frames.
   */
  geometryEpoch = 0;
  private view: EditorView;
  private onWheel = () => {
    this.lastWheelTime = Date.now();
  };
  private onScroll = () => {
    this.lastScrollTime = Date.now();
  };

  constructor(view: EditorView) {
    this.view = view;
    view.scrollDOM.addEventListener("wheel", this.onWheel, { passive: true });
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
  }

  update(update: ViewUpdate) {
    if (update.heightChanged || update.viewportChanged) {
      this.geometryEpoch++;
    }
  }

  destroy() {
    this.view.scrollDOM.removeEventListener("wheel", this.onWheel);
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
  }
}

export const paneActivityTracker = ViewPlugin.fromClass(PaneActivityTracker);

/** Marks a `mousedown` this extension has already redispatched once (after the settle delay), so it isn't deferred a second time. */
const deferredMouseEvents = new WeakSet<MouseEvent>();

function cloneMouseEvent(type: string, source: MouseEvent): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    view: source.view,
    detail: source.detail,
    clientX: source.clientX,
    clientY: source.clientY,
    button: source.button,
    buttons: source.buttons,
    shiftKey: source.shiftKey,
    ctrlKey: source.ctrlKey,
    altKey: source.altKey,
    metaKey: source.metaKey,
  });
}

/**
 * Waits for CodeMirror to measure the newly scrolled rendered layout and for
 * the scroll offset to remain stable across consecutive frames, then replays
 * `event` as a fresh `mousedown` on `target`.
 * A click that lands inside the *existing* selection isn't resolved into a
 * selection at `mousedown` at all (only on the following `mouseup`, per
 * upstream's own ambiguous click-vs-drag handling) - so a real mouseup
 * arriving before the deferred `mousedown` has built the selection object
 * would otherwise silently swallow the click. A capturing listener holds
 * that early `mouseup` until the focus and scroll guards have run, then
 * replays it so it is never lost or resolved against the transient scroll.
 */
function replayMousedownAfterMeasure(view: EditorView, event: MouseEvent, target: EventTarget): void {
  const doc = view.contentDOM.ownerDocument;
  let earlyMouseup: MouseEvent | null = null;
  const captureEarlyMouseup = (e: MouseEvent) => {
    if (earlyMouseup) {
      return;
    }
    earlyMouseup = e;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  doc.addEventListener("mouseup", captureEarlyMouseup, { capture: true });

  // `requestAnimationFrame` alone does not force CodeMirror to measure after
  // a rendered-preview scroll changes the visible decoration set. The
  // measure request runs after the viewport and its DOM have stabilized, and
  // the following frame keeps the synthetic event outside that measure pass.
  let stableFrames = 0;
  let settleChecks = 0;
  let previousScroll: { top: number; left: number } | undefined;

  const dispatchMousedown = () => {
    const replayedMousedown = cloneMouseEvent("mousedown", event);
    deferredMouseEvents.add(replayedMousedown);
    target.dispatchEvent(replayedMousedown);

    // The first-focus path has already run before this event. Dispatching the
    // held mouseup in the next frame keeps it after the restored layout.
    requestAnimationFrame(() => {
      doc.removeEventListener("mouseup", captureEarlyMouseup, { capture: true });
      if (earlyMouseup) {
        target.dispatchEvent(cloneMouseEvent("mouseup", earlyMouseup));
      }
    });
  };

  const replay = () => {
    if (view.hasFocus) {
      dispatchMousedown();
      return;
    }

    // Focus changes the rendered decoration set before CodeMirror resolves
    // the click. Focus first, then wait for that new layout to settle and
    // restore the reading position before dispatching the mousedown.
    const beforeFocusScrollTop = view.scrollDOM.scrollTop;
    const beforeFocusScrollLeft = view.scrollDOM.scrollLeft;
    view.focus();
    // Keep the focus-induced movement inside this task as well. The measured
    // write below is still required for CodeMirror's internal scroll state,
    // but restoring here prevents the transient position from being painted.
    view.scrollDOM.scrollTop = beforeFocusScrollTop;
    view.scrollDOM.scrollLeft = beforeFocusScrollLeft;
    view.requestMeasure({
      read: () => undefined,
      write() {
        view.scrollDOM.scrollTop = beforeFocusScrollTop;
        view.scrollDOM.scrollLeft = beforeFocusScrollLeft;
        // The write above changes the DOM after CodeMirror's read phase. A
        // second measure records the restored offset before posAtCoords runs.
        view.requestMeasure({
          read() {
            requestAnimationFrame(dispatchMousedown);
          },
        });
      },
    });
  };

  const settle = () => {
    settleChecks++;
    view.requestMeasure({
      read() {
        const measured = { top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft };
        requestAnimationFrame(() => {
          const current = { top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft };
          if (
            previousScroll &&
            previousScroll.top === measured.top &&
            previousScroll.left === measured.left &&
            measured.top === current.top &&
            measured.left === current.left
          ) {
            stableFrames++;
          } else {
            stableFrames = 0;
          }
          previousScroll = current;

          if (stableFrames >= 2 || settleChecks >= 8) {
            replay();
          } else {
            settle();
          }
        });
      },
    });
  };

  settle();
}

/**
 * `mousedown` handler passed to `EditorView.domEventHandlers`, which — like
 * the existing `linkClickHandler` in `livePreviewPlugin.ts` — runs before
 * CodeMirror's own built-in `mousedown` handling, so returning `true` here
 * pre-empts it for this event only.
 */
export function handleScrollSettleMousedown(event: MouseEvent, view: EditorView): boolean {
  if (deferredMouseEvents.has(event)) {
    return false;
  }
  const tracker = view.plugin(paneActivityTracker);
  const sinceWheel = Date.now() - (tracker?.lastWheelTime ?? -Infinity);
  const sinceScroll = Date.now() - (tracker?.lastScrollTime ?? -Infinity);
  if (sinceWheel >= RECENT_SCROLL_WINDOW_MS && sinceScroll >= RECENT_SCROLL_WINDOW_MS) {
    return false;
  }
  replayMousedownAfterMeasure(view, event, event.target ?? view.contentDOM);
  return true;
}

export const scrollSettleMouseHandler = EditorView.domEventHandlers({
  mousedown: handleScrollSettleMousedown,
});

// --- Part 3: resolve the first click only after the pane has been focused and measured (issue #183) ---
//
// CodeMirror focuses an unfocused pane during its own mousedown handling. In
// a rendered markdown pane that focus changes the decoration layout and can
// scroll the caret into view before CodeMirror resolves the click position.
// Restoring `scrollTop` afterward is too late: the selection has already been
// calculated against the wrong viewport. `Prec.highest` pre-empts that first
// mousedown and sends it through the same focus, measure, restore, and replay
// path as a scroll-settle click. The replay runs with the pane focused, so
// CodeMirror resolves the click against the restored layout.
export function guardFirstFocusScrollPosition(event: MouseEvent, view: EditorView): boolean {
  if (view.hasFocus) {
    return false;
  }
  replayMousedownAfterMeasure(view, event, event.target ?? view.contentDOM);
  return true;
}

export const firstFocusScrollGuard = Prec.highest(
  EditorView.domEventHandlers({
    mousedown: guardFirstFocusScrollPosition,
  }),
);

/**
 * Extensions shared by every pane (markdown rendered, markdown source, and
 * code — all via `EditorPane.svelte`'s `viewModeExtensions`): history, the
 * default/history keymaps, tab-to-indent, the find/replace panel, word-based
 * autocompletion, an app-drawn caret and selection, and the scroll-safe
 * mouse-selection/focus handling above. `drawSelection()` is what makes
 * `src/lib/theme/cmTheme.ts`'s `cursor` and `selectionBg` tokens take
 * effect and what makes `allowMultipleSelections` below actually render more
 * than one caret — without it, the caret and selection are the webview's own
 * native `contenteditable` rendering, which this app does not control the
 * painting or invalidation of. `EditorState.allowMultipleSelections` is
 * turned on here since it's a `static` facet that must be part of the
 * initial configuration: without it, every multi-cursor gesture (Alt-click,
 * Cmd-D select-next, the search panel's select-all-matches) silently
 * collapses to a single cursor instead of erroring, so the gap has no other
 * way to surface than a passing-looking click that does the wrong thing.
 * The CM theme and syntax highlight style (theme-driven, not a library
 * default) live in `EditorPane.svelte`'s theme `Compartment` instead, since
 * they need to be reconfigured on a theme change without tearing down
 * everything else in this array. Line wrapping is mode-dependent (prose
 * wraps, code doesn't) so it lives in `EditorPane.svelte` alongside the
 * other mode-dependent extensions instead of here.
 */
export function baseExtensions(): Extension[] {
  return [
    history(),
    inFileSearch(),
    drawSelection(),
    autocompletion({ defaultKeymap: false }),
    keymap.of([
      // Tab must precede `indentWithTab` below: same-key bindings within one
      // `keymap.of` array run in order until one returns `true`, and
      // `indentMore` (inside `indentWithTab`) always returns `true`, so
      // placed after it, a completion would never get the chance to accept.
      // This is deliberately not `Prec.highest` — that precedence level is
      // already occupied by `autocompletion()`'s own internal keymap and by
      // the markdown table keymap
      // (`src/lib/editor/markdown/livePreviewPlugin.ts`), so a third
      // `Prec.highest` Tab binding would resolve by extension array order
      // rather than by any stated rule. `completionKeymap` is spread rather
      // than hand-transcribed because two of its nine entries
      // (`{mac: "Alt-`"}`, `{mac: "Alt-i"}`) have no `key` field at all and
      // are easy to drop by accident. Enter is filtered out: CodeMirror
      // binds it to accept a completion by default, which is fine while the
      // tooltip is rare, but the word-completion fallback below
      // (`wordCompletion.ts`) makes the tooltip open on nearly every
      // identifier typed in a code file — leaving Enter bound would mean
      // pressing Enter for a plain newline can silently insert an unrelated
      // completion instead. Tab accepts; Enter is always a newline.
      { key: "Tab", run: acceptCompletion },
      ...completionKeymap.filter((binding) => binding.key !== "Enter"),
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      indentWithTab,
    ]),
    EditorState.allowMultipleSelections.of(true),
    EditorView.mouseSelectionStyle.of(movementAwareMouseSelectionStyle),
    paneActivityTracker,
    firstFocusScrollGuard,
    scrollSettleMouseHandler,
  ];
}
