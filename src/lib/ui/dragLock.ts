/**
 * The cursor a gesture forces app-wide for its own duration. Deliberately a
 * closed set rather than an arbitrary CSS string: each value needs a matching
 * `!important` rule in `app.css`, for the reason spelled out there (an inline
 * `style.cursor` write on an ancestor loses to WebKit's auto-cursor heuristic
 * over contenteditable content; a rule matching the element directly wins).
 */
export type DragCursor = "grabbing" | "col-resize" | "row-resize";

/**
 * Prevents a selection from *beginning* anywhere while a drag is in flight.
 *
 * Capture phase, on `document`: WebKit's `effectiveUserSelect` deliberately
 * ignores an inherited `user-select: none` on any element carrying
 * `-webkit-user-modify: read-write*` — which is exactly what CodeMirror's own
 * base theme sets on `.cm-content` when it is contenteditable (WebKit
 * changeset 293028). That exemption governs how the `user-select` *property*
 * resolves and nothing more, so it has no bearing on `selectstart`, which
 * fires at the point a selection is actually about to begin. Intercepting the
 * event is what actually holds over the editor; the `user-select` writes below
 * are the belt to this braces, covering ordinary non-editable regions.
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
 * Blocks a selection from beginning, and nothing else — no cursor change, no
 * `user-select` write.
 *
 * Armed at `pointerdown`, before a gesture is known to be a drag at all, so
 * nothing can seed a selection inside the few pixels before the drag
 * threshold is crossed. It is safe to arm this eagerly on every press in a way
 * the rest of the lock is not: a plain click starts no selection, so this is
 * inert for one, whereas writing `user-select: none` on <html> for every
 * click would touch a document-wide property (and, on engines that clear a
 * selection when one is applied to its ancestor, could drop a selection the
 * user is holding) for a gesture that turns out not to be a drag at all.
 * That is why this is separate from `beginDragLock` rather than a mode of it.
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
  const root = document.documentElement;
  root.dataset.dragCursor = cursor;
  root.style.userSelect = "none";
  root.style.webkitUserSelect = "none";
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
  const root = document.documentElement;
  delete root.dataset.dragCursor;
  root.style.userSelect = "";
  root.style.webkitUserSelect = "";
  document.removeEventListener("selectstart", preventSelectStart, true);
}
