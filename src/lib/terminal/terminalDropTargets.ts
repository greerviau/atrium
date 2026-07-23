const targets = new Map<HTMLElement, (paths: string[]) => void>();

/** A mounted TerminalPane registers its container + an insert callback so the app-level OS-drop router (App.svelte) can find it by screen position. */
export function registerTerminalDropTarget(
  el: HTMLElement,
  insert: (paths: string[]) => void,
): () => void {
  targets.set(el, insert);
  return () => targets.delete(el);
}

/** Hit-tests a viewport point against every currently mounted pane and inserts into whichever one it lands inside, if any — a drop outside every pane (e.g. onto a resizer) is silently a no-op. `App.svelte` only reaches this after its own explorer hit test comes up empty, so a drop landing on the explorer is handled before it ever gets here. */
export function insertPathsAtScreenPoint(paths: string[], clientX: number, clientY: number): void {
  const el = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(".terminal-pane");
  if (!el) return;
  targets.get(el)?.(paths);
}
