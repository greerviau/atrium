export type TabDropZone = "center" | "up" | "down" | "left" | "right";

export type TabSurface = "editor" | "terminal";

export interface TabDropTarget {
  paneId: string;
  zone: TabDropZone;
}

/**
 * Resolves the pane and drop zone under a pointer.
 *
 * The tab strip always behaves as a center drop so dragging across another
 * pane's tabs merges the tab instead of accidentally splitting near the top
 * edge. The pane content uses its nearest edge for a split and its center for
 * a merge.
 */
export function resolveTabDropTarget(
  surface: TabSurface,
  clientX: number,
  clientY: number,
): TabDropTarget | null {
  if (typeof document.elementFromPoint !== "function") return null;
  const hit = document.elementFromPoint(clientX, clientY);
  if (!hit) return null;
  const surfaceRoot = hit.closest<HTMLElement>(`.${surface}-area`);
  if (!surfaceRoot) return null;

  const pane = hit.closest<HTMLElement>('.pane-leaf[data-pane-id]');
  if (!pane || !surfaceRoot.contains(pane)) return null;
  if (hit.closest(".tab-strip")) return { paneId: pane.dataset.paneId!, zone: "center" };

  const rect = pane.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return { paneId: pane.dataset.paneId!, zone: "center" };

  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  const distances: Array<{ zone: Exclude<TabDropZone, "center">; distance: number }> = [
    { zone: "left", distance: x },
    { zone: "right", distance: 1 - x },
    { zone: "up", distance: y },
    { zone: "down", distance: 1 - y },
  ];
  const nearest = distances.reduce((best, candidate) => (candidate.distance < best.distance ? candidate : best));
  const zone = nearest.distance <= 0.25 ? nearest.zone : "center";
  return { paneId: pane.dataset.paneId!, zone };
}
