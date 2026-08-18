import { writable, get } from "svelte/store";
import { resolveTabDropTarget, type TabDropTarget, type TabSurface } from "./tabDropTargets";
import { armDragSelectionGuard, beginDragLock, endDragLock } from "../ui/dragLock";

export interface ActiveTabDrag {
  key: string;
  surface: TabSurface;
  sourcePaneId: string;
  path: string;
  label: string;
  clientX: number;
  clientY: number;
  target: TabDropTarget | null;
}

export const activeTabDrag = writable<ActiveTabDrag | null>(null);

/** The composite key of the tab whose pointer gesture is currently active. */
export const draggingTabKey = writable<string | null>(null);

const DRAG_THRESHOLD_PX = 4;

export interface TabDragOptions {
  surface: TabSurface;
  paneId: string;
  label?: string;
  onDrop: (target: TabDropTarget) => void;
  onDragEnd?: (didDrag: boolean) => void;
}

function sameTarget(a: TabDropTarget | null, b: TabDropTarget | null): boolean {
  return a?.paneId === b?.paneId && a?.zone === b?.zone;
}

/**
 * Starts a pointer-driven tab gesture.
 *
 * Reordering within the source pane commits as the pointer crosses tab
 * midpoints, so the other tabs animate into their new positions. Moving over
 * another pane's center moves the tab there on release; moving over an edge
 * creates a new split on that edge. The pointer is intentionally not captured
 * because the source pane can be removed by a drop, which ends pointer capture
 * in WebKit.
 */
export function beginTabDrag(
  tabEl: HTMLElement,
  event: PointerEvent,
  key: string,
  path: string,
  getTabRects: () => Array<{ path: string; rect: DOMRect }>,
  onReorder: (path: string, toIndex: number) => void,
  options?: TabDragOptions,
): void {
  armDragSelectionGuard();
  const startX = event.clientX;
  const startY = event.clientY;
  const pointerId = event.pointerId;
  const grabOffsetX = event.clientX - tabEl.getBoundingClientRect().left;
  let dragging = false;
  let lastCommittedIndex: number | null = null;
  let currentTarget: TabDropTarget | null = null;
  let lastPointerX = event.clientX;

  function targetIndex(pointerX: number): number {
    const others = getTabRects().filter((t) => t.path !== path);
    for (let i = 0; i < others.length; i++) {
      const mid = (others[i].rect.left + others[i].rect.right) / 2;
      if (pointerX < mid) return i;
    }
    return others.length;
  }

  function onMove(e: PointerEvent): void {
    if (e.pointerId !== pointerId) return;
    if (!dragging) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      draggingTabKey.set(key);
      beginDragLock("grabbing");
    }
    lastPointerX = e.clientX;

    if (options) {
      const target = resolveTabDropTarget(options.surface, e.clientX, e.clientY);
      if (!sameTarget(currentTarget, target)) currentTarget = target;
      activeTabDrag.set({
        key,
        surface: options.surface,
        sourcePaneId: options.paneId,
        path,
        label: options.label ?? path,
        clientX: e.clientX,
        clientY: e.clientY,
        target: currentTarget,
      });

      if (currentTarget?.paneId === options.paneId && currentTarget.zone === "center") {
        const idx = targetIndex(e.clientX);
        if (idx !== lastCommittedIndex) {
          lastCommittedIndex = idx;
          onReorder(path, idx);
        }
      }
    }

    e.preventDefault();
    if (options) return;
    // Legacy callers reorder live while dragging. The pane tab components use
    // the preview-only path above so their source tabs stay stationary.
    tabEl.style.transform = "";
    const rect = tabEl.getBoundingClientRect();
    tabEl.style.transform = `translateX(${e.clientX - grabOffsetX - rect.left}px)`;
    const idx = targetIndex(e.clientX);
    if (idx !== lastCommittedIndex) {
      lastCommittedIndex = idx;
      onReorder(path, idx);
    }
  }

  function end(commit: boolean): void {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("blur", onBlur);
    tabEl.style.transform = "";

    if (commit && dragging && options && currentTarget) {
      if (currentTarget.paneId === options.paneId && currentTarget.zone === "center") {
        const idx = targetIndex(lastPointerX);
        if (idx !== lastCommittedIndex) onReorder(path, idx);
      } else {
        options.onDrop(currentTarget);
      }
    }
    endDragLock();
    activeTabDrag.set(null);
    draggingTabKey.set(null);
    options?.onDragEnd?.(dragging);
  }

  function onUp(e: PointerEvent): void {
    if (e.pointerId !== pointerId) return;
    end(true);
  }
  function onCancel(e: PointerEvent): void {
    if (e.pointerId !== pointerId) return;
    end(false);
  }
  function onBlur(): void {
    end(false);
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("blur", onBlur);
}

/**
 * Clears a stale gesture state when a surface is unmounted during a drag.
 * Exported for a consumer that unmounts the dragged surface out from under
 * `beginTabDrag`'s own `window` listeners to call explicitly; not wired to
 * any unmount hook itself, and currently unreferenced by any call site in
 * `src/` — `end()`'s own `pointerup`/`pointercancel`/`blur` funnel already
 * covers every exit path a live gesture takes today.
 */
export function clearTabDrag(): void {
  if (get(activeTabDrag)) activeTabDrag.set(null);
  draggingTabKey.set(null);
  endDragLock();
}

export type { TabDropTarget, TabDropZone, TabSurface } from "./tabDropTargets";
