import { writable, get } from "svelte/store";
import { resolveTabDropTarget, type TabDropTarget, type TabSurface } from "./tabDropTargets";

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
 * The original tab stays in place while the pointer moves. Releasing over
 * its own center drop zone reorders it once; moving over another pane's center
 * moves it there; moving over an edge creates a new split on that edge. The
 * pointer is intentionally not captured because the source pane can be
 * removed by a drop, which ends pointer capture in WebKit.
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
      document.documentElement.classList.add("tab-drag-active");
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
        onReorder(path, targetIndex(lastPointerX));
      } else {
        options.onDrop(currentTarget);
      }
    }
    document.documentElement.classList.remove("tab-drag-active");
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

/** Clears a stale gesture state when a surface is unmounted during a drag. */
export function clearTabDrag(): void {
  if (get(activeTabDrag)) activeTabDrag.set(null);
  draggingTabKey.set(null);
  document.documentElement.classList.remove("tab-drag-active");
}

export type { TabDropTarget, TabDropZone, TabSurface } from "./tabDropTargets";
