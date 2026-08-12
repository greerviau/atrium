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
  const anchor = replayAnchors.get(startEvent);
  // The gesture's press-time position: the latched anchor for a replayed
  // click, a live resolution for an ordinary one. Mutable because `update()`
  // maps it through document changes.
  const start = anchor
    ? { pos: anchor.pos, assoc: anchor.assoc }
    : view.posAndSideAtCoords({ x: startEvent.clientX, y: startEvent.clientY }, false);
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
      // Both operands of the drag test come from the layout as it is right
      // now. For an anchored gesture `start` is a press-time resolution and
      // `cur` a current one, so comparing those two would read the pane's own
      // relayout as pointer movement and build the spurious range issue #161
      // is about — see the plan's §5.6. Re-resolving the press coordinates
      // against the current layout is what keeps the test honest.
      const pressNow = anchor
        ? view.posAndSideAtCoords({ x: startEvent.clientX, y: startEvent.clientY }, false)
        : start;
      const dragged = pressNow.pos !== cur.pos && hasPointerMoved(startEvent, curEvent) && !extend;
      // A gesture that never became a drag names the position it was pressed
      // on — the anchor, when there is one. A drag is a screen-space sweep, so
      // both of its ends are resolved in the layout being swept across and the
      // anchor plays no part.
      const target = dragged || !anchor ? cur : start;
      let range = rangeForClick(view, target.pos, target.assoc, clickCount);
      if (dragged) {
        const startRange = rangeForClick(view, pressNow.pos, pressNow.assoc, clickCount);
        const from = Math.min(startRange.from, range.from);
        const to = Math.max(startRange.to, range.to);
        range = from < range.from ? EditorSelection.range(from, to, range.assoc) : EditorSelection.range(to, from, range.assoc);
      }
      if (extend) {
        return startSel.replaceRange(startSel.main.extend(range.from, range.to, range.assoc));
      }
      const removed =
        multiple && clickCount === 1 && startSel.ranges.length > 1 ? removeRangeAround(startSel, target.pos) : null;
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
// inside either window arrives while CodeMirror is still measuring the newly
// scrolled rendered layout — decorations not yet applied, block heights not
// yet corrected from estimates to measurements. This tracks both signals on
// the pane's scroller and, on a `mousedown` that follows one too closely,
// defers the click.
//
// The click's target is latched as a document position (issue #454) at the
// very top of the deferral, before any waiting — against the layout the user
// was looking at when the button went down. Nothing that happens afterwards
// (the scroll landing, CodeMirror re-measuring, the scroll-anchoring
// correction) can move it, because a document position isn't expressed in
// any frame those movements act on; `movementAwareMouseSelectionStyle` (Part
// 1) is what actually consumes that anchor. The deferral then waits for the
// scroll offset (Phase A) and CodeMirror's own reported geometry (Phase B) to
// hold still before replaying the click as a fresh `mousedown`, so it runs
// back through the exact same (movement-aware, anchor-aware) selection logic
// as any other click - on a settled layout, even though the position it
// names was fixed on an earlier one.

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

/** The document position a deferred click was pointing at when its button went down, keyed by the synthetic `mousedown` that replays it. Latched before any waiting, so no relayout during the deferral can move it. */
export const replayAnchors = new WeakMap<MouseEvent, { pos: number; assoc: -1 | 1 }>();

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
 * Bound on how many settle checks the whole deferral will spend before
 * replaying anyway, shared across every phase that waits on one. Each check
 * costs two animation frames — `requestMeasure` schedules its own frame
 * before running the `read`, and the `read` schedules another — so eight
 * checks is ~267ms at 60Hz.
 */
export const MAX_SETTLE_CHECKS = 8;

/**
 * Steps once per animation frame, sampling from inside CodeMirror's measure
 * cycle and again after the following frame, until `same` reports two
 * consecutive quiet frames (comparing the previous frame's settled value,
 * this frame's in-measure value, and this frame's post-frame value) or
 * `budget` runs out, then calls `done`.
 *
 * Call this from a frame callback, never from inside a measure `read` or
 * `write`: a `requestMeasure` issued during a measure pass is picked up by
 * that same pass rather than a fresh frame, so the first two samples would
 * come from one frame and could report "settled" without a frame having
 * elapsed. `done` itself always runs on a frame callback, so it may safely
 * call layout-reading APIs.
 */
function whenSettled<S>(
  view: EditorView,
  budget: { remaining: number },
  sample: () => S,
  same: (a: S, b: S) => boolean,
  done: () => void,
): void {
  if (budget.remaining <= 0) {
    // A prior phase already spent the whole shared budget - this phase gets
    // no checks of its own, not one "free" check before noticing that. The
    // caller is already inside a frame callback whenever this can happen
    // (Phase A's own `done`, or the `requestAnimationFrame` hop a caller
    // takes before starting a later phase), so `done`'s contract still holds.
    done();
    return;
  }

  let stableFrames = 0;
  let previous: S | undefined;

  const check = () => {
    budget.remaining--;
    view.requestMeasure({
      read() {
        const measured = sample();
        requestAnimationFrame(() => {
          const current = sample();
          if (previous !== undefined && same(previous, measured) && same(measured, current)) {
            stableFrames++;
          } else {
            stableFrames = 0;
          }
          previous = current;

          if (stableFrames >= 2 || budget.remaining <= 0) {
            done();
          } else {
            check();
          }
        });
      },
    });
  };

  check();
}

/**
 * The DOM element a replayed `mousedown`/`mouseup` should dispatch on.
 * `original` (the element the real event targeted at press time) survives
 * most deferrals unchanged, but CodeMirror recycles and replaces `.cm-line`
 * DOM across a viewport or decoration change, so after settling through two
 * phases it can be detached from the document entirely. Dispatching on a
 * detached node fires the event there and stops: it never reaches
 * `contentDOM`, so CodeMirror never sees it and the click is silently lost.
 * Falling back straight to `contentDOM` is not safe either, because
 * downstream handlers read `event.target` - `livePreviewPlugin.ts`'s
 * link-click handler does `target.closest(".cm-link")` - so a Cmd/Ctrl-click
 * on a markdown link made during the settle window would silently degrade to
 * plain cursor placement. Re-deriving the live element for the anchor's
 * position is the fallback that keeps both working.
 *
 * The check is `isConnected` rather than `contentDOM.contains(original)`:
 * what actually breaks dispatch is the node leaving the document, not merely
 * sitting outside `contentDOM` (which a live, still-connected element never
 * legitimately does in production, since a real click can only ever target
 * something the user is actually looking at inside the pane).
 */
function replayTarget(view: EditorView, original: EventTarget, anchor: { pos: number }): EventTarget {
  if ((original as Node).isConnected) {
    return original;
  }
  // `domAtPos` reads `docView` directly and never flushes a measure, so it's
  // safe to call here regardless of what phase the caller is in - but it's
  // only meaningful for a position CodeMirror has actually rendered.
  if (anchor.pos >= view.viewport.from && anchor.pos <= view.viewport.to) {
    const { node } = view.domAtPos(anchor.pos);
    const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
    if (element && view.contentDOM.contains(element)) {
      return element;
    }
  }
  return view.contentDOM;
}

/**
 * Waits for CodeMirror to measure the newly scrolled rendered layout and for
 * the scroll offset and geometry to remain stable across consecutive frames,
 * then replays `event` as a fresh `mousedown`.
 *
 * The click's target is latched as a document position at the very top, from
 * the layout the user was looking at when the button went down - before any
 * waiting. Nothing that happens afterwards (the scroll landing, CodeMirror
 * re-measuring, decorations rendering, the scroll-anchoring correction, the
 * focus-induced relayout) can move it, because a document position is not
 * expressed in any frame those movements act on. `movementAwareMouseSelectionStyle`
 * (Part 1) is what actually consumes the anchor; this function only latches
 * and carries it.
 *
 * A click that lands inside the *existing* selection isn't resolved into a
 * selection at `mousedown` at all (only on the following `mouseup`, per
 * upstream's own ambiguous click-vs-drag handling) - so a real mouseup
 * arriving before the deferred `mousedown` has built the selection object
 * would otherwise silently swallow the click. A capturing listener holds
 * that early `mouseup` until the focus and scroll guards have run, then
 * replays it so it is never lost or resolved against the transient scroll.
 */
function replayMousedownAfterMeasure(view: EditorView, event: MouseEvent, target: EventTarget): void {
  const anchor = view.posAndSideAtCoords({ x: event.clientX, y: event.clientY }, false);

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

  const budget = { remaining: MAX_SETTLE_CHECKS };

  const dispatchMousedown = () => {
    const dispatchTarget = replayTarget(view, target, anchor);
    const replayedMousedown = cloneMouseEvent("mousedown", event);
    deferredMouseEvents.add(replayedMousedown);
    replayAnchors.set(replayedMousedown, anchor);
    dispatchTarget.dispatchEvent(replayedMousedown);

    // The first-focus path has already run before this event. Dispatching the
    // held mouseup in the next frame keeps it after the restored layout.
    requestAnimationFrame(() => {
      doc.removeEventListener("mouseup", captureEarlyMouseup, { capture: true });
      if (earlyMouseup) {
        dispatchTarget.dispatchEvent(cloneMouseEvent("mouseup", earlyMouseup));
      }
    });
  };

  // Phase B: CodeMirror has finished measuring the layout Phase A's scroll
  // settled into (no further block-height or viewport change pending), not
  // just holding the same scroll offset. This is quality rather than
  // correctness - the anchor above already protects the landing position -
  // so it shares Phase A's budget rather than extending it: a target whose
  // settle window outlasts the shared budget replays anyway, exactly as it
  // did before this phase existed.
  const waitForGeometryThenDispatch = () => {
    whenSettled(
      view,
      budget,
      () => ({
        top: view.scrollDOM.scrollTop,
        left: view.scrollDOM.scrollLeft,
        geometryEpoch: view.plugin(paneActivityTracker)?.geometryEpoch ?? 0,
      }),
      (a, b) => a.top === b.top && a.left === b.left && a.geometryEpoch === b.geometryEpoch,
      dispatchMousedown,
    );
  };

  const replay = () => {
    if (view.root.activeElement === view.contentDOM) {
      waitForGeometryThenDispatch();
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
        // second measure records the restored offset before Phase B starts.
        view.requestMeasure({
          read() {
            // `whenSettled` must not start from inside this `read()` - a
            // `requestMeasure` issued during a measure pass is picked up by
            // that same pass rather than a fresh frame (Step 2's contract) -
            // so it starts from the following frame callback instead.
            requestAnimationFrame(waitForGeometryThenDispatch);
          },
        });
      },
    });
  };

  // `requestAnimationFrame` alone does not force CodeMirror to measure after
  // a rendered-preview scroll changes the visible decoration set. The
  // measure request runs after the viewport and its DOM have stabilized, and
  // the following frame keeps the synthetic event outside that measure pass.
  whenSettled(
    view,
    budget,
    () => ({ top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft }),
    (a, b) => a.top === b.top && a.left === b.left,
    replay,
  );
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
// mousedown and sends it through the same anchor-latch, focus, measure,
// restore, and replay path as a scroll-settle click (Part 2). The replay
// dispatches once the focus-induced layout has settled, resolving the click
// against the anchor named at the original press.
//
// The predicate is DOM focus rather than `view.hasFocus`: the relayout this
// guard protects against is driven by `livePreviewPlugin`'s `editorFocusField`,
// which follows `contentDOM`'s own `focus`/`blur` events, whereas
// `view.hasFocus` is additionally gated on `document.hasFocus()` — an
// OS/window-manager property `view.focus()` cannot change. Keying the guard on
// `view.hasFocus` made termination depend on the window holding OS focus
// (issue #455); keying it on DOM focus makes termination a property of the code.
//
// The contract is "run the focus-and-restore path exactly once before this
// click resolves", not "resolve this click only once the pane is focused". If
// focus cannot be taken at all, the replayed click still resolves, with the
// focus attempt and the scroll restore having run. A click is never swallowed
// to protect a guard - hence the `deferredMouseEvents` check, which both entry
// points now share.
export function guardFirstFocusScrollPosition(event: MouseEvent, view: EditorView): boolean {
  if (view.root.activeElement === view.contentDOM || deferredMouseEvents.has(event)) {
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
