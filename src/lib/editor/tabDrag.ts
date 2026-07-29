import { writable } from "svelte/store";

/**
 * `${leafId}:${path}` of the tab currently being drag-reordered, or null —
 * composite-keyed (matching `EditorPane.svelte`'s own `${paneId}:${path}`
 * convention) so dragging a tab in one split leaf doesn't also mark a
 * same-path tab open in a *different* leaf as `.dragging`.
 */
export const draggingTabKey = writable<string | null>(null);

const DRAG_THRESHOLD_PX = 4;

/**
 * Starts a pointer-driven reorder gesture for `path`, called from a tab's
 * own `pointerdown`. Deliberately takes NO pointer capture, unlike
 * `explorerDrag.ts`'s `beginExplorerDrag` — `tabEl` moves in the DOM on
 * every live commit (Svelte's keyed `{#each tree.tabs as path (path)}`
 * detaches and re-inserts it at its new sibling position on a reorder), and
 * per the Pointer Events spec, moving a captured element implicitly
 * releases capture and fires `lostpointercapture` — which would end the
 * gesture after exactly one commit. `window`-level listeners need no
 * capture to keep receiving events regardless of where the pointer
 * physically is, matching `tableHandles.ts`'s `attachDragReorder` (the
 * in-repo precedent for a *live-commit* reorder).
 *
 * `getTabRects` is called fresh on every `pointermove` — never cached —
 * since a live reorder changes every other tab's position (same discipline
 * as `tableHandles.ts`'s `measureRectsByIndex`, adapted here because a flat
 * tab array has no adjacent-only constraint to loop over: the target index
 * is computed directly each move, not stepped one swap at a time).
 * `onReorder` fires only when the computed target index changes from the
 * last one committed, so a still pointer over the same slot doesn't
 * reassign `editorPaneTree` repeatedly.
 */
export function beginTabDrag(
  tabEl: HTMLElement,
  event: PointerEvent,
  key: string, // `${leafId}:${path}`
  path: string,
  getTabRects: () => Array<{ path: string; rect: DOMRect }>,
  onReorder: (path: string, toIndex: number) => void,
): void {
  const startX = event.clientX;
  const startY = event.clientY;
  const pointerId = event.pointerId;
  const grabOffsetX = event.clientX - tabEl.getBoundingClientRect().left;
  let dragging = false;
  let lastCommittedIndex: number | null = null;

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
    }
    e.preventDefault();
    // Clear, re-measure, reapply: by the time this event fires, any DOM
    // reorder from a *previous* onReorder call has already been flushed
    // (Svelte's reactivity flushes as a microtask, strictly before the
    // next browser task — and a pointermove is always a new task). Clearing
    // the transform before measuring reads the tab's true current layout
    // position rather than a stale offset from before the last commit, so
    // the tab tracks the pointer exactly instead of drifting a further
    // tab-width away on every step.
    tabEl.style.transform = "";
    const rect = tabEl.getBoundingClientRect();
    tabEl.style.transform = `translateX(${e.clientX - grabOffsetX - rect.left}px)`;
    // Vertical position is deliberately ignored — reorder only cares where
    // the pointer sits along the strip's own axis, same as tableHandles.ts's
    // column drag only reading clientX. A pointer that strays above/below
    // the strip (into the editor content, say) still keeps reordering.
    const idx = targetIndex(e.clientX);
    if (idx !== lastCommittedIndex) {
      lastCommittedIndex = idx;
      onReorder(path, idx);
    }
  }

  function end(): void {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("blur", onBlur);
    tabEl.style.transform = "";
    draggingTabKey.set(null);
  }
  function onUp(e: PointerEvent): void {
    if (e.pointerId !== pointerId) return;
    end();
  }
  function onCancel(e: PointerEvent): void {
    if (e.pointerId !== pointerId) return;
    end();
  }
  function onBlur(): void {
    end();
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  // A window blur mid-drag (app/tab switch) otherwise self-heals only on
  // the next pointerup anywhere, leaving the dragged tab's inline transform
  // stuck in the meantime — same gap tableHandles.ts's own blur listener
  // closes, for the same reason.
  window.addEventListener("blur", onBlur);
}
