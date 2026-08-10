/**
 * The cursor a gesture forces app-wide for its own duration. Deliberately a
 * closed set rather than an arbitrary CSS string: each value needs a matching
 * `!important` rule in `app.css`, for the reason spelled out there (an inline
 * `style.cursor` write on an ancestor loses to WebKit's auto-cursor heuristic
 * over contenteditable content; a rule matching the element directly wins).
 */
export type DragCursor = "grabbing" | "col-resize" | "row-resize";

/**
 * Prevents a selection from *beginning* anywhere while a drag is in flight —
 * the only mechanism this module uses to block selection, everywhere, not
 * one layer of several.
 *
 * Capture phase, on `document`: WebKit's `effectiveUserSelect` deliberately
 * ignores an inherited `user-select: none` on any element carrying
 * `-webkit-user-modify: read-write*` — which is exactly what CodeMirror's own
 * base theme sets on `.cm-content` when it is contenteditable (WebKit
 * changeset 293028). That exemption governs how the `user-select` *property*
 * resolves and nothing more, so it has no bearing on `selectstart`, which
 * fires at the point a selection is actually about to begin.
 *
 * An earlier version of this module also wrote `user-select: none` on
 * `<html>` as a second, "belt and braces" layer alongside this guard. It was
 * dropped after a real-device check (`tests/e2e/specs/dragCursor.e2e.js`)
 * found that write alone *clears an existing selection* held elsewhere in
 * the DOM on this app's WebKit target — confirmed against the CSV/Parquet
 * result table, which sets no `user-select` of its own and isn't
 * contenteditable, so it was never covered by the exemption above. That is
 * exactly the failure mode this lock exists to prevent, not a redundant
 * safeguard against it: writing `user-select: none` while a selection is
 * live can wipe a selection this drag never touched. `selectstart`
 * interception has no such side effect — it only ever refuses a selection
 * that hasn't started yet, never touches one already in progress.
 *
 * Module-level, so the same function reference is added and removed every
 * time: `addEventListener`/`removeEventListener` are then no-ops on repeat
 * regardless of which gesture is starting or ending, with nothing to pair up
 * and nothing to leak.
 */
function preventSelectStart(event: Event): void {
  event.preventDefault();
}

/**
 * Blocks a selection from beginning, and nothing else — no cursor change.
 *
 * Armed at `pointerdown`, before a gesture is known to be a drag at all, so
 * nothing can seed a selection inside the few pixels before the drag
 * threshold is crossed. Safe to arm eagerly on every press: a plain click
 * starts no selection, so this is inert for one. That is why this is
 * separate from `beginDragLock` rather than a mode of it — the split
 * predates the `user-select` write's removal above and remains useful on its
 * own merits: a resting cursor (below) has no business changing for a
 * gesture that turns out not to be a drag at all.
 */
export function armDragSelectionGuard(): void {
  document.addEventListener("selectstart", preventSelectStart, true);
}

/**
 * Forces `cursor` app-wide and blocks text selection until `endDragLock()`.
 *
 * Called once the gesture has committed to being a drag. Re-registering the
 * `selectstart` listener here is deliberate and free: it is the same function
 * reference `armDragSelectionGuard` used, so the second `addEventListener` is
 * a no-op, and callers that have no pre-threshold phase (the resizers, the
 * table handles) can call this alone and still get the guard.
 *
 * Idempotent and unowned by design — see `endDragLock` for the trade-off this
 * deliberately accepts.
 */
export function beginDragLock(cursor: DragCursor): void {
  document.documentElement.dataset.dragCursor = cursor;
  document.addEventListener("selectstart", preventSelectStart, true);
}

/**
 * Single teardown path for every way a drag can end: a normal pointerup, a
 * pointercancel, a lost pointer capture, a window blur, or a surface being
 * unmounted mid-gesture. Undoes `armDragSelectionGuard` and `beginDragLock`
 * alike, so a gesture that armed the guard and never crossed its drag
 * threshold is cleaned up by exactly the same call as a completed drag.
 *
 * Every line is a plain, unconditional no-op when the thing it undoes was
 * never applied — nothing here carries "did I personally acquire something
 * that must be paired back" state. That is what makes it always safe to call
 * from every exit path of every gesture with no registry of
 * who-locked-what to keep in sync, and it is the same trade-off the minimap's
 * own `_endDrag` already documents and accepts. The one honest gap: two
 * genuinely simultaneous physical pointers (a trackpad and a mouse, dragging
 * two different surfaces at once — not a real usage pattern for this app)
 * would let the first gesture to finish drop the lock a little early for the
 * second. That is cosmetic for the remainder of that drag, never stuck: the
 * second gesture's own `endDragLock()` still runs cleanly and nothing stays
 * mutated once every drag has ended. A reference count would close that gap
 * at the cost of a far worse failure mode — one missed release and the app is
 * left permanently uncursorable and unselectable, with no self-healing path.
 */
export function endDragLock(): void {
  delete document.documentElement.dataset.dragCursor;
  document.removeEventListener("selectstart", preventSelectStart, true);
}
