import { EditorView } from "@codemirror/view";
import { Annotation, Transaction, type TransactionSpec } from "@codemirror/state";

export const syncAnnotation = Annotation.define<boolean>();

const registry = new Map<string, Set<EditorView>>();

/**
 * Each registered view's *current* key in `registry`, independent of
 * whatever `path` a caller later passes to `unregisterView`. A view mounted
 * at one path can outlive a rename that moves its entry to a new key
 * (`rekeyPath`), but the `EditorPane` instance being torn down as a result
 * still only knows its own, now-stale `filePath` prop — without this,
 * `unregisterView(staleOldPath, view)` would look up the already-vacated old
 * key and find nothing there.
 */
const currentKeyForView = new WeakMap<EditorView, string>();

/**
 * Views whose owning pane has called `unregisterView`, but whose entry is
 * still physically present in `registry` (see `unregisterView`'s deferred
 * cleanup below). Consulted so a destroyed view never receives a
 * `broadcastChange` dispatch — the actual crash the dead-view leak this
 * bookkeeping exists to prevent produced — while still being readable by
 * `liveDocFor` during the brief handoff window a rename's remount relies on.
 */
const destroyedViews = new WeakSet<EditorView>();

export function registerView(path: string, view: EditorView): void {
  let views = registry.get(path);
  if (!views) {
    views = new Set();
    registry.set(path, views);
  }
  views.add(view);
  currentKeyForView.set(view, path);
}

/**
 * Marks `view` as gone. The actual removal from `registry` is deferred to
 * the next microtask rather than done here synchronously: a rename's
 * outgoing `EditorPane` unregisters its view *before* Svelte mounts the
 * fresh replacement pane at the new key (empirically, for this codebase's
 * keyed `{#each}` tab strip, destroy of the outgoing keyed element runs
 * before create of the incoming one, not after) — and that fresh mount
 * seeds itself from `liveDocFor(newPath)` before it ever calls
 * `registerView` itself. Deleting the entry immediately here would empty
 * (and, once empty, remove) the very set that mount is about to read,
 * reintroducing exactly the data-loss hazard this whole registry exists to
 * close: the fresh pane would find nothing and fall back to stale,
 * last-saved content instead of the still-live buffer. Marking the view
 * destroyed instead keeps its document readable for that one read, while
 * `broadcastChange` below excludes every destroyed view from receiving a
 * dispatch — the actual leak symptom — regardless of removal timing.
 */
export function unregisterView(path: string, view: EditorView): void {
  const key = currentKeyForView.get(view) ?? path;
  destroyedViews.add(view);
  queueMicrotask(() => {
    const views = registry.get(key);
    if (!views || !views.has(view)) return;
    views.delete(view);
    currentKeyForView.delete(view);
    destroyedViews.delete(view);
    if (views.size === 0) {
      registry.delete(key);
    }
  });
}

/**
 * Moves the registered view set at `oldPath` (if any) to `newPath`. Must run
 * before a rename re-keys the pane tree's own `tabs` array: that re-keying
 * forces Svelte's keyed `{#each}` to destroy the old `EditorPane` and mount
 * a fresh one at the new path, and the fresh mount seeds its doc from
 * `liveDocFor(newPath)` — which only finds the still-live buffer if this
 * registry already knows the view by its new key. Rekeying after the
 * remount is too late: the mount would find nothing at `newPath` and fall
 * back to the tab's last-saved content, silently discarding any unsaved
 * edit.
 */
export function rekeyPath(oldPath: string, newPath: string): void {
  const views = registry.get(oldPath);
  if (!views) return;
  registry.delete(oldPath);
  registry.set(newPath, views);
  for (const view of views) {
    currentKeyForView.set(view, newPath);
  }
}

/**
 * The current document content of any already-registered view of `path`, or
 * `null` if none is registered yet. Consulted at registration time so a
 * newly-mounted view seeds from a live sibling's buffer instead of
 * `savedDoc` — which can be stale the instant the path is already open
 * elsewhere with unsaved edits. Prefers a non-destroyed view when one is
 * present, but falls back to a destroyed one rather than `null` — the exact
 * case right after a rename's outgoing pane has unregistered but before its
 * replacement has registered, where a destroyed view's document is still
 * the correct thing to seed the fresh mount from.
 */
export function liveDocFor(path: string): string | null {
  const views = registry.get(path);
  if (!views || views.size === 0) return null;
  for (const view of views) {
    if (!destroyedViews.has(view)) return view.state.doc.toString();
  }
  const [fallback] = views;
  return fallback.state.doc.toString();
}

function broadcastChange(path: string, sourceView: EditorView, tr: Transaction): void {
  const views = registry.get(path);
  if (!views) return;
  // Snapshot before iterating: dispatching into a sibling can synchronously
  // trigger its own teardown (e.g. a reconciliation effect it runs in
  // response), which would otherwise mutate `views` mid-iteration.
  //
  // Deliberately does not carry over `tr.userEvent`: `@codemirror/autocomplete`
  // activates a completion query purely on `tr.isUserEvent("input.type")`, with
  // no focus gate anywhere in that package, so forwarding the source
  // transaction's own `userEvent` would start a completion query — and pop a
  // tooltip — in every unfocused sibling view of the same file on every
  // keystroke. Leaving the mirrored dispatch's `userEvent` unset avoids that
  // misclassification; nothing else in this codebase reads `userEvent` or
  // calls `isUserEvent`.
  const spec: TransactionSpec = {
    changes: tr.changes,
    annotations: [syncAnnotation.of(true), Transaction.addToHistory.of(false)],
  };
  for (const view of [...views]) {
    if (view === sourceView || destroyedViews.has(view)) continue;
    view.dispatch(spec);
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
