import { writable, get } from "svelte/store";
import { dirOf } from "../util/path";
import { resolveExplorerDropTargetDir } from "./explorerDropTargets";
import { movePath } from "./contextMenu";
import { terminalPaneAtScreenPoint, insertPathsAtScreenPoint, dragOverTerminalPane, setDragOverTerminalPane } from "../terminal/terminalDropTargets";
import { armDragSelectionGuard, beginDragLock, endDragLock } from "../ui/dragLock";
import type { DirEntry } from "../ipc/commands";

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

/** The dragged row's own entry (name/path/isDir/isSymlink) while a pointer-driven drag is in progress, or null. Set the same moment draggingPath is (once the gesture crosses the drag threshold); cleared in the same end(). Carries what ExplorerDragPreview needs to render — draggingPath alone is only a path string. */
export const draggingEntry = writable<DirEntry | null>(null);

/** Latest viewport point of the pointer during a drag, or null when no drag is in progress. Updated on every pointermove past the drag threshold; drives ExplorerDragPreview's position. */
export const dragPointerPosition = writable<{ x: number; y: number } | null>(null);

const DRAG_THRESHOLD_PX = 4;

/**
 * Starts a pointer-driven move gesture for `entry`, called from a row's
 * `pointerdown`. Takes the full entry rather than just its path because the
 * drag preview (`draggingEntry`, above) needs the item's name and `isDir` to
 * render, not only its path. Tracks movement past a small threshold before
 * committing to "this is a drag" (so a plain click still opens/toggles the
 * row normally, and `onRowStartedDragging` fires exactly once per gesture
 * that crosses the threshold), then on every `pointermove` re-resolves the
 * directory under the pointer via `resolveExplorerDropTargetDir` — the same
 * screen-point hit-test the native Finder-drop path already uses, now
 * serving both.
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
 * cancellation), `lostpointercapture` (capture stolen or released by the
 * platform), or a window `blur` (Cmd-Tab, a Space switch, a native context
 * menu — the one exit path `pointerup`/`pointercancel`/`lostpointercapture`
 * can't cover, since none of the three is guaranteed to fire from an
 * inactive window) — funnels through the single `end()` below, so there is
 * no path that leaves `window` listeners attached, the shared drag lock
 * (`dragLock.ts`) engaged, or `draggingPath`/`dragOverTargetDir`/
 * `dragOverTerminalPane`/`draggingEntry`/`dragPointerPosition` stuck set with
 * no active gesture behind them (the middle one is defined in
 * `terminalDropTargets.ts` and imported here — the guarantee is about what
 * `end()` clears, not about where the store lives); unlike the first three,
 * `draggingEntry`/`dragPointerPosition` leaking would be immediately visible
 * on screen, as a drag preview pinned mid-window with no drag behind it.
 * Only a genuine `pointerup` with `commit: true` ever calls `movePath`.
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
 * Text selection over the editor/terminal panes the drag passes over is
 * suppressed by `dragLock.ts`, not by pointer capture — capture retargets
 * pointer events, not the mouse-event-driven text-selection default, and
 * relying on capture to suppress selection isn't safe across engines.
 * `armDragSelectionGuard()` is called at the very top of this function, at
 * `pointerdown`, so nothing can seed a selection inside the few pixels
 * before the drag threshold is crossed; `beginDragLock("grabbing")` follows
 * at threshold crossing, once the gesture has committed to being a drag —
 * see `dragLock.ts` for why the pre-threshold guard and the cursor/
 * `user-select` lock are deliberately two separate calls rather than one.
 * Neither call touches `pointerdown`'s own default action, so the focus/blur
 * transition `InlineNameInput`'s `settleActiveEdit` needs is untouched.
 */
export function beginExplorerDrag(rowEl: HTMLElement, event: PointerEvent, entry: DirEntry, onRowStartedDragging: () => void): void {
  armDragSelectionGuard();
  const sourcePath = entry.path;
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
      draggingEntry.set(entry);
      onRowStartedDragging();
      rowEl.setPointerCapture(pointerId);
      captured = true;
      beginDragLock("grabbing");
    }
    e.preventDefault();
    lastX = e.clientX;
    lastY = e.clientY;
    dragPointerPosition.set({ x: e.clientX, y: e.clientY });
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
    window.removeEventListener("blur", onBlur);
    rowEl.removeEventListener("lostpointercapture", onLostCapture);
    if (captured) rowEl.releasePointerCapture(pointerId);
    endDragLock();
    const target = get(dragOverTargetDir);
    const overTerminal = get(dragOverTerminalPane);
    draggingPath.set(null);
    dragOverTargetDir.set(null);
    draggingEntry.set(null);
    dragPointerPosition.set(null);
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
  // A blur mid-drag (Cmd-Tab, a Space switch, a native context menu) has no
  // other exit path to lean on: pointerup never arrives from an inactive
  // macOS window, pointercancel isn't guaranteed, and lostpointercapture
  // can't fire for a gesture blurred before the 4px threshold, since
  // setPointerCapture above hasn't run yet. No commit — an interrupted drag
  // must not move a file.
  function onBlur(): void {
    end(false);
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("blur", onBlur);
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
