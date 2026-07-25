import { writable, get } from "svelte/store";
import { dirOf } from "../util/path";
import { resolveExplorerDropTargetDir } from "./explorerDropTargets";
import { movePath } from "./contextMenu";
import { terminalPaneAtScreenPoint, insertPathsAtScreenPoint, dragOverTerminalPane, setDragOverTerminalPane } from "../terminal/terminalDropTargets";

/** Path of the explorer row currently in a pointer-driven drag, or null. */
export const draggingPath = writable<string | null>(null);

/**
 * Directory the pointer currently resolves to as a valid drop target, or
 * null. Written both by the pointer-driven move gesture below (`onMove`)
 * and by `App.svelte`'s `onDragDropEvent` handler for a native OS
 * (Finder-style) drag, so `FileTreeNode.svelte`'s highlight looks identical
 * regardless of which drag source is in flight.
 */
export const dragOverTargetDir = writable<string | null>(null);

const DRAG_THRESHOLD_PX = 4;

/**
 * Starts a pointer-driven move gesture for `sourcePath`, called from a row's
 * `pointerdown`. Tracks movement past a small threshold before committing to
 * "this is a drag" (so a plain click still opens/toggles the row normally,
 * and `onRowStartedDragging` fires exactly once per gesture that crosses the
 * threshold), then on every `pointermove` re-resolves the directory under
 * the pointer via `resolveExplorerDropTargetDir` — the same screen-point
 * hit-test the native Finder-drop path already uses, now serving both.
 *
 * Does **not** call `event.preventDefault()` on `pointerdown` (unlike
 * `tableHandles.ts`'s `attachDragReorder`, which can — a table handle has no
 * competing click/focus semantics). An explorer row does: preventing the
 * default here would suppress the focus/blur transition
 * `InlineNameInput.svelte`'s `settleActiveEdit` relies on to commit an
 * in-flight rename/create when the user starts dragging a different row.
 *
 * Takes pointer capture on `rowEl` once the gesture becomes a drag, so a
 * `pointerup` outside the row (or outside the window) is still delivered to
 * these listeners instead of being lost. Every exit path — a genuine
 * `pointerup`, `pointercancel` (OS-level gesture takeover, touch/trackpad
 * cancellation), or `lostpointercapture` (capture stolen or released by the
 * platform) — funnels through the single `end()` below, so there is no path
 * that leaves `window` listeners attached or `draggingPath`/`dragOverTargetDir`/
 * `dragOverTerminalPane` stuck set with no active gesture behind them (the
 * latter is defined in `terminalDropTargets.ts` and imported here — the
 * guarantee is about what `end()` clears, not about where the store lives);
 * only a genuine `pointerup` with `commit: true` ever calls `movePath`.
 * `end()` removes every listener *before* releasing capture, so a
 * `lostpointercapture` fired synchronously by the release itself can't
 * re-enter `end()`.
 *
 * Every handler ignores an event whose `pointerId` doesn't match the one
 * that started the gesture (`event.pointerId`, captured at call time) — with
 * a mouse or trackpad there is only ever one active pointer, but on a
 * touch/pen input a second pointer's `pointerup` must not be able to commit
 * a move the user never released, nor should its `pointermove` be allowed to
 * steer `dragOverTargetDir` toward wherever that unrelated pointer is. As a
 * backstop, `onMove` also bails out if `e.buttons === 0` — a moved-without-a-
 * button-held event, which should never legitimately reach it mid-drag.
 *
 * Deliberately does **not** try to suppress text selection in the editor/
 * terminal panes the drag passes over via pointer capture alone — capture
 * retargets pointer events, not the mouse-event-driven text-selection
 * default, and relying on capture to suppress selection isn't safe across
 * engines. `onMove` calls `event.preventDefault()` once `dragging` is `true`
 * instead (safe at that point: only `pointerdown`'s default carries the
 * focus/blur semantics `InlineNameInput`'s `settleActiveEdit` needs, and by
 * the time `dragging` flips true the gesture has already committed to being
 * a drag, not a click).
 */
export function beginExplorerDrag(rowEl: HTMLElement, event: PointerEvent, sourcePath: string, onRowStartedDragging: () => void): void {
  const startX = event.clientX;
  const startY = event.clientY;
  const pointerId = event.pointerId;
  let dragging = false;
  let captured = false;
  let lastX = event.clientX;
  let lastY = event.clientY;

  function onMove(e: PointerEvent): void {
    if (e.pointerId !== pointerId || e.buttons === 0) return;
    if (!dragging) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      draggingPath.set(sourcePath);
      onRowStartedDragging();
      rowEl.setPointerCapture(pointerId);
      captured = true;
    }
    e.preventDefault();
    lastX = e.clientX;
    lastY = e.clientY;
    const explorerTarget = resolveExplorerDropTargetDir(e.clientX, e.clientY);
    if (explorerTarget !== null) {
      dragOverTargetDir.set(isValidMoveTarget(sourcePath, explorerTarget) ? explorerTarget : null);
      setDragOverTerminalPane(null);
    } else {
      dragOverTargetDir.set(null);
      setDragOverTerminalPane(terminalPaneAtScreenPoint(e.clientX, e.clientY));
    }
  }

  function end(commit: boolean): void {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    rowEl.removeEventListener("lostpointercapture", onLostCapture);
    if (captured) rowEl.releasePointerCapture(pointerId);
    const target = get(dragOverTargetDir);
    const overTerminal = get(dragOverTerminalPane);
    draggingPath.set(null);
    dragOverTargetDir.set(null);
    setDragOverTerminalPane(null);
    if (!commit || !dragging) return;
    if (target) {
      void movePath(sourcePath, target).catch((err) => {
        console.error("atrium: failed to move", sourcePath, "into", target, err);
      });
    } else if (overTerminal) {
      insertPathsAtScreenPoint([sourcePath], lastX, lastY);
    }
  }

  function onUp(e: PointerEvent): void {
    if (e.pointerId !== pointerId) return;
    lastX = e.clientX;
    lastY = e.clientY;
    end(true);
  }
  function onCancel(e: PointerEvent): void {
    if (e.pointerId !== pointerId) return;
    end(false);
  }
  function onLostCapture(): void {
    end(false);
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  rowEl.addEventListener("lostpointercapture", onLostCapture);
}

/**
 * True if dropping `sourcePath` onto `targetDir` is a move worth performing:
 * not onto itself, not onto one of its own descendants, and not onto the
 * directory it's already directly inside (a no-op today, not an implicit
 * move). Also correctly rejects moving the workspace root anywhere, without
 * special-casing it: every other directory in the tree is either the root
 * itself or one of its descendants, both already excluded.
 */
export function isValidMoveTarget(sourcePath: string, targetDir: string): boolean {
  if (targetDir === sourcePath) return false;
  if (targetDir.startsWith(`${sourcePath}/`)) return false;
  if (targetDir === dirOf(sourcePath)) return false;
  return true;
}
