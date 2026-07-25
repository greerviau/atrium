import { writable, get } from "svelte/store";

const targets = new Map<HTMLElement, (paths: string[]) => void>();

/** A mounted TerminalPane registers its container + an insert callback so the app-level OS-drop router (App.svelte) can find it by screen position. */
export function registerTerminalDropTarget(
  el: HTMLElement,
  insert: (paths: string[]) => void,
): () => void {
  targets.set(el, insert);
  return () => targets.delete(el);
}

/** Hit-tests a viewport point against every currently mounted pane's container, or null if the point lands on none of them. */
export function terminalPaneAtScreenPoint(clientX: number, clientY: number): HTMLElement | null {
  return document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(".terminal-pane") ?? null;
}

/** Hit-tests a viewport point against every currently mounted pane and inserts into whichever one it lands inside, if any — a drop outside every pane (e.g. onto a resizer) is silently a no-op. `App.svelte` only reaches this after its own explorer hit test comes up empty, so a drop landing on the explorer is handled before it ever gets here. */
export function insertPathsAtScreenPoint(paths: string[], clientX: number, clientY: number): void {
  const el = terminalPaneAtScreenPoint(clientX, clientY);
  if (!el) return;
  targets.get(el)?.(paths);
}

/** Terminal pane element the pointer currently resolves to as a drop target during an in-app (explorer-row) drag, or null. Written by explorerDrag.ts's pointer-driven gesture as it moves; read by TerminalPane.svelte to drive its own drop-target-active highlight. A null value here always means "no terminal pane is currently under the pointer" — it comes directly from terminalPaneAtScreenPoint, not from any assumption about what the explorer's own hit-test returned. */
export const dragOverTerminalPane = writable<HTMLElement | null>(null);

/** Avoids notifying every mounted pane's $derived read of dragOverTerminalPane on every pointermove tick when the resolved pane hasn't actually changed — mirrors App.svelte's setDragOverTargetDir (App.svelte:520-522) for the explorer's own equivalent store. */
export function setDragOverTerminalPane(next: HTMLElement | null): void {
  if (get(dragOverTerminalPane) !== next) dragOverTerminalPane.set(next);
}
