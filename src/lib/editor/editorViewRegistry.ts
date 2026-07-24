import { EditorView } from "@codemirror/view";
import { Annotation, Transaction, type TransactionSpec } from "@codemirror/state";

export const syncAnnotation = Annotation.define<boolean>();

const registry = new Map<string, Set<EditorView>>();

export function registerView(path: string, view: EditorView): void {
  let views = registry.get(path);
  if (!views) {
    views = new Set();
    registry.set(path, views);
  }
  views.add(view);
}

export function unregisterView(path: string, view: EditorView): void {
  const views = registry.get(path);
  if (!views) return;
  views.delete(view);
  if (views.size === 0) {
    registry.delete(path);
  }
}

/**
 * The current document content of any already-registered view of `path`, or
 * `null` if none is registered yet. Consulted at registration time so a
 * newly-mounted view seeds from a live sibling's buffer instead of
 * `savedDoc` — which can be stale the instant the path is already open
 * elsewhere with unsaved edits.
 */
export function liveDocFor(path: string): string | null {
  const views = registry.get(path);
  const first = views?.values().next().value;
  return first ? first.state.doc.toString() : null;
}

function broadcastChange(path: string, sourceView: EditorView, tr: Transaction): void {
  const views = registry.get(path);
  if (!views) return;
  // Snapshot before iterating: dispatching into a sibling can synchronously
  // trigger its own teardown (e.g. a reconciliation effect it runs in
  // response), which would otherwise mutate `views` mid-iteration.
  for (const view of [...views]) {
    if (view === sourceView) continue;
    const spec: TransactionSpec = {
      changes: tr.changes,
      annotations: [syncAnnotation.of(true), Transaction.addToHistory.of(false)],
    };
    const userEvent = tr.annotation(Transaction.userEvent);
    view.dispatch(userEvent ? { ...spec, userEvent } : spec);
  }
}

/**
 * `dispatchTransactions` override for a view showing `path` — passed as
 * `EditorView`'s own constructor config, not hooked via `updateListener`.
 * Applies the view's own transactions first (`view.update(trs)`, the
 * override's own responsibility once supplied), then mirrors any
 * doc-changing, non-mirrored transaction to every sibling view of `path`.
 */
export function createSyncDispatch(path: string): (trs: readonly Transaction[], view: EditorView) => void {
  return (trs, view) => {
    view.update(trs);
    for (const tr of trs) {
      if (tr.docChanged && !tr.annotation(syncAnnotation)) {
        broadcastChange(path, view, tr);
      }
    }
  };
}
