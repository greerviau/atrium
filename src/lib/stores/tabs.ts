import { get, writable } from "svelte/store";
import { fsReadFile, fsWriteFile, isAppError, localWorkspaceId } from "../ipc/commands";
import { modeForPath, type PaneMode } from "../editor/codeExtensions";
import { closePrompt } from "./closePrompt";
import { workspace } from "./workspace";
import { recordFileOpened } from "./recentFiles";
import { showErrorToast, describeError } from "./errorToast";
import { basename, isPathUnderOrEqual } from "../util/path";

export interface PendingSelection {
  line: number;
  col?: number;
}

export interface Tab {
  path: string;
  mode: PaneMode;
  savedDoc: string;
  isDirty: boolean;
  /** Set once by the pane on load/save; cleared once the pane has scrolled to it. */
  pendingSelection?: PendingSelection;
  /** True while a `fs:changed` conflict banner is showing for this tab (section 6.2). */
  hasExternalConflict: boolean;
  /**
   * True once the file backing this tab has been deleted (in-app or
   * externally) while the tab itself stayed open because it had unsaved
   * edits. Cleared the moment the tab's content is next written to disk
   * (`saveTab`) or re-synced from disk (`reloadFromDisk`).
   */
  isDeleted: boolean;
  /**
   * Which markdown presentation is active; only ever set for `mode ===
   * "markdown"` tabs. Not persisted — always starts at `"rendered"` on open,
   * including a fresh open after the tab was previously closed.
   */
  viewMode?: "rendered" | "source";
}

export interface TabsState {
  tabs: Tab[];
  activeTabPath: string | null;
}

export const tabsState = writable<TabsState>({ tabs: [], activeTabPath: null });

/**
 * Set to a path to ask that tab's `EditorPane` to save (used by the native
 * `File > Save` menu item, which has no direct handle on the active CM6
 * view). The pane clears it back to `null` once it has acted on it.
 */
export const saveRequest = writable<string | null>(null);

export interface TabRenameEvent {
  from: string;
  to: string;
}

/**
 * A one-shot signal set by `renameOpenTabs`, consumed by `App.svelte`'s
 * rename-reconciliation effect to re-key `editorPaneTree` and
 * `editorViewRegistry` to match — those two live outside `tabsState` and
 * have no other way to learn a path moved. Cleared back to `null` by the
 * consuming effect once it has acted on it, the same one-shot convention
 * `saveRequest` uses.
 */
export const tabRenameSignal = writable<TabRenameEvent | null>(null);

interface SaveWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

// A list per path, not a single slot: `saveRequest.set(path)` is a no-op
// (via svelte/store's equality check) while a save for that same path is
// already in flight, so a second `requestSave(path)` call that lands before
// the first resolves (e.g. the native Cmd+S menu firing mid-`Save All`)
// rides the same underlying save rather than triggering a second one — but
// still needs its own waiter recorded so it resolves/rejects too, instead
// of overwriting (and stranding) the first caller's.
const pendingSaveResolvers = new Map<string, SaveWaiter[]>();

/**
 * Requests a save for `path` and resolves once the owning `EditorPane` has
 * actually finished saving (via `notifySaveComplete`), or rejects if the
 * save failed (via `notifySaveFailed`). The `File > Save` menu caller
 * doesn't need this and can keep ignoring the returned promise; the
 * unsaved-changes close flow awaits it to sequence "save, then close".
 */
export function requestSave(path: string): Promise<void> {
  saveRequest.set(path);
  return new Promise((resolve, reject) => {
    const waiters = pendingSaveResolvers.get(path) ?? [];
    waiters.push({ resolve, reject });
    pendingSaveResolvers.set(path, waiters);
  });
}

/** Resolves every pending `requestSave` promise for `path`, if any. */
export function notifySaveComplete(path: string): void {
  const waiters = pendingSaveResolvers.get(path);
  pendingSaveResolvers.delete(path);
  waiters?.forEach((w) => w.resolve());
}

/** Rejects every pending `requestSave` promise for `path`, if any. */
export function notifySaveFailed(path: string, error: unknown): void {
  const waiters = pendingSaveResolvers.get(path);
  pendingSaveResolvers.delete(path);
  waiters?.forEach((w) => w.reject(error));
}

/**
 * Fire-and-forget save entry point for a UI trigger with no dialog of its
 * own to report a failure through (the File > Save menu item, the in-editor
 * Cmd+S keymap, the editor context menu's Save item) — requests the save and
 * surfaces a failure through the shared error toast, the same channel a
 * failed link-open already uses.
 */
export function requestSaveReportingErrors(path: string): void {
  requestSave(path).catch((err: unknown) => {
    showErrorToast(`Couldn't save ${basename(path)}: ${describeError(err)}`);
  });
}

/**
 * Opens `path` in the editor pane, focusing an existing tab if already open.
 * Shared by the file explorer, markdown-link clicks, and the terminal's
 * file-path link provider so "open a file" behaves identically everywhere.
 */
export async function openFile(path: string, selection?: PendingSelection): Promise<void> {
  const root = get(workspace).root;
  if (root) {
    // Best-effort, never blocks the actual open — see `recentFiles.ts`.
    recordFileOpened(root, path);
  }

  const state = get(tabsState);
  const existing = state.tabs.find((t) => t.path === path);
  if (existing) {
    tabsState.update((s) => ({
      ...s,
      activeTabPath: path,
      tabs: s.tabs.map((t) => (t.path === path ? { ...t, pendingSelection: selection } : t)),
    }));
    return;
  }

  const contents = await fsReadFile(localWorkspaceId(), path);
  const mode = modeForPath(path);
  const tab: Tab = {
    path,
    mode,
    savedDoc: contents,
    isDirty: false,
    pendingSelection: selection,
    hasExternalConflict: false,
    isDeleted: false,
    viewMode: mode === "markdown" ? "rendered" : undefined,
  };
  tabsState.update((s) => ({
    tabs: [...s.tabs, tab],
    activeTabPath: path,
  }));
}

/**
 * Fire-and-forget open entry point for a UI trigger with no dialog of its
 * own to report a failure through (an explorer row click, a rendered
 * markdown link, a terminal file-path link) — opens `path` and surfaces a
 * failure through the shared error toast, the same channel a failed save
 * already uses.
 */
export function openFileReportingErrors(path: string, selection?: PendingSelection): void {
  openFile(path, selection).catch((err: unknown) => {
    showErrorToast(`Couldn't open file: ${describeError(err)}`);
  });
}

/** Flips a markdown tab's `viewMode` between `"rendered"` and `"source"`; a no-op for a non-markdown tab or an unknown path. */
export function toggleMarkdownViewMode(path: string): void {
  tabsState.update((s) => ({
    ...s,
    tabs: s.tabs.map((t) =>
      t.path === path && t.mode === "markdown"
        ? { ...t, viewMode: t.viewMode === "source" ? "rendered" : "source" }
        : t,
    ),
  }));
}

/** Clears every open tab and the active-tab pointer — used when switching projects. */
export function resetTabs(): void {
  tabsState.set({ tabs: [], activeTabPath: null });
}

export function closeTab(path: string): void {
  tabsState.update((s) => {
    const closedIndex = s.tabs.findIndex((t) => t.path === path);
    const tabs = s.tabs.filter((t) => t.path !== path);
    const activeTabPath =
      s.activeTabPath === path
        ? (tabs[Math.min(closedIndex, tabs.length - 1)]?.path ?? null)
        : s.activeTabPath;
    return { tabs, activeTabPath };
  });
}

/**
 * The entry point for a user-driven tab close (the tab strip's "×" button).
 * A clean tab closes immediately, exactly as `closeTab` always has; a dirty
 * tab instead raises the unsaved-changes confirmation and leaves the tab
 * open until the user resolves it.
 */
export function requestCloseTab(path: string): void {
  const tab = get(tabsState).tabs.find((t) => t.path === path);
  if (tab?.isDirty) {
    closePrompt.set({ kind: "tab", path });
  } else {
    closeTab(path);
  }
}

export function setActiveTab(path: string): void {
  tabsState.update((s) => ({ ...s, activeTabPath: path }));
}

export function markDirty(path: string): void {
  tabsState.update((s) => ({
    ...s,
    tabs: s.tabs.map((t) => (t.path === path ? { ...t, isDirty: true } : t)),
  }));
}

export function clearPendingSelection(path: string): void {
  tabsState.update((s) => ({
    ...s,
    tabs: s.tabs.map((t) => (t.path === path ? { ...t, pendingSelection: undefined } : t)),
  }));
}

/** Saves `contents` for `path` and flips the tab back to clean. */
export async function saveTab(path: string, contents: string): Promise<void> {
  await fsWriteFile(localWorkspaceId(), path, contents);
  tabsState.update((s) => ({
    ...s,
    tabs: s.tabs.map((t) =>
      t.path === path
        ? { ...t, savedDoc: contents, isDirty: false, hasExternalConflict: false, isDeleted: false }
        : t,
    ),
  }));
}

/**
 * Reacts to an `fs:changed` event for `path` (App.svelte forwards these from
 * the global listener). A clean tab silently reloads; a dirty tab shows a
 * conflict banner instead of overwriting unsaved edits (section 6.2).
 *
 * A `NOT_FOUND` read failure is treated as a deletion rather than left as an
 * unhandled rejection: this is a defensive fallback for the timing race
 * where a `Modify` event's read loses to an external delete landing
 * microseconds later, since a genuine `Remove`-kind event is routed to
 * `markPathDeleted` directly by the `fs:changed` handler.
 *
 * A `FILE_TOO_LARGE` read failure (the file grew past the read guard after
 * it was already open) surfaces as a toast instead of an unhandled
 * rejection, leaving the tab showing its last-known content.
 */
export async function reconcileExternalChange(path: string): Promise<void> {
  const state = get(tabsState);
  const tab = state.tabs.find((t) => t.path === path);
  if (!tab) {
    return;
  }
  if (tab.isDirty) {
    tabsState.update((s) => ({
      ...s,
      tabs: s.tabs.map((t) => (t.path === path ? { ...t, hasExternalConflict: true } : t)),
    }));
    return;
  }
  let contents: string;
  try {
    contents = await fsReadFile(localWorkspaceId(), path);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") {
      markPathDeleted(path);
      return;
    }
    if (isAppError(err) && err.code === "FILE_TOO_LARGE") {
      showErrorToast(describeError(err));
      return;
    }
    throw err;
  }
  tabsState.update((s) => ({
    ...s,
    tabs: s.tabs.map((t) => (t.path === path ? { ...t, savedDoc: contents } : t)),
  }));
}

/** "Reload" action on the conflict banner: discard local edits, take disk contents. */
export async function reloadFromDisk(path: string): Promise<void> {
  const contents = await fsReadFile(localWorkspaceId(), path);
  tabsState.update((s) => ({
    ...s,
    tabs: s.tabs.map((t) =>
      t.path === path
        ? { ...t, savedDoc: contents, isDirty: false, hasExternalConflict: false, isDeleted: false }
        : t,
    ),
  }));
}

/**
 * Fire-and-forget wrapper around `reloadFromDisk` for the conflict banner's
 * "Reload" button: a rejection (e.g. the file grew past the read guard, or
 * was deleted, since the click) surfaces as a toast instead of an unhandled
 * rejection, the same idiom `requestSaveReportingErrors` and
 * `openFileReportingErrors` already use.
 */
export function reloadFromDiskReportingErrors(path: string): void {
  reloadFromDisk(path).catch((err: unknown) => {
    showErrorToast(`Couldn't reload ${basename(path)}: ${describeError(err)}`);
  });
}

/**
 * Reacts to a path being deleted, in-app or externally: every open tab at or
 * under `path` (a directory delete cascades to its open descendants) is
 * either closed outright (clean — nothing to lose) or flagged `isDeleted`
 * (dirty — kept open so the user can act on it via the deleted-tab banner).
 * A toast names every tab that was auto-closed, so a clean tab disappearing
 * is never silent.
 */
export function markPathDeleted(path: string): void {
  const state = get(tabsState);
  const affected = state.tabs.filter((t) => t.path === path || t.path.startsWith(path + "/"));
  if (affected.length === 0) {
    return;
  }

  const closedPaths = new Set(affected.filter((t) => !t.isDirty).map((t) => t.path));
  const flaggedPaths = new Set(affected.filter((t) => t.isDirty).map((t) => t.path));

  tabsState.update((s) => {
    const tabs = s.tabs
      .filter((t) => !closedPaths.has(t.path))
      .map((t) =>
        flaggedPaths.has(t.path) ? { ...t, isDeleted: true, hasExternalConflict: false } : t,
      );
    const activeTabPath =
      s.activeTabPath && closedPaths.has(s.activeTabPath)
        ? (tabs[tabs.length - 1]?.path ?? null)
        : s.activeTabPath;
    return { tabs, activeTabPath };
  });

  if (closedPaths.size > 0) {
    const names = [...closedPaths].map((p) => p.split("/").pop() ?? p);
    const message =
      names.length === 1
        ? `${names[0]} was deleted — its tab was closed.`
        : `${names.join(", ")} were deleted — their tabs were closed.`;
    showErrorToast(message);
  }
}

/**
 * Reacts to a path being renamed or moved, in-app or externally: every open
 * tab at or under `oldPath` (a directory rename cascades to its open
 * descendants) is re-keyed to its counterpart under `newPath` by prefix
 * substitution, preserving every other field (`savedDoc`, `isDirty`,
 * `viewMode`, `isDeleted`, etc.) unchanged. `activeTabPath` is re-keyed the
 * same way if it matched. Sets `tabRenameSignal` so `App.svelte`'s
 * reconciliation effect can re-key `editorPaneTree` and
 * `editorViewRegistry` to match.
 *
 * A tab already open at a computed destination is *displaced*: an in-app
 * rename can never reach this (`LocalWorkspace::rename` rejects an existing
 * destination), but an external rename has no such guard — the OS has
 * already overwritten that file on disk by the time this runs. Two open
 * tabs can't share one path (Svelte's keyed tab strip would throw on the
 * duplicate key), so the displaced tab is dropped in favor of the renamed
 * survivor; a dirty displaced tab is toasted so discarding its edits is
 * never silent, mirroring `markPathDeleted`'s own toast for an auto-closed
 * clean tab.
 */
export function renameOpenTabs(oldPath: string, newPath: string): void {
  const state = get(tabsState);
  const affected = state.tabs.some((t) => isPathUnderOrEqual(t.path, oldPath));
  if (!affected) {
    return;
  }

  const rekey = (path: string): string => newPath + path.slice(oldPath.length);
  let displacedDirtyNames: string[] = [];

  tabsState.update((s) => {
    const renamed = s.tabs.map((t) => {
      const wasRenamed = isPathUnderOrEqual(t.path, oldPath);
      return { tab: wasRenamed ? { ...t, path: rekey(t.path) } : t, wasRenamed };
    });
    const renamedDestinations = new Set(renamed.filter((r) => r.wasRenamed).map((r) => r.tab.path));

    displacedDirtyNames = renamed
      .filter((r) => !r.wasRenamed && renamedDestinations.has(r.tab.path) && r.tab.isDirty)
      .map((r) => r.tab.path.split("/").pop() ?? r.tab.path);

    const tabs = renamed.filter((r) => r.wasRenamed || !renamedDestinations.has(r.tab.path)).map((r) => r.tab);

    let activeTabPath = s.activeTabPath;
    if (activeTabPath && isPathUnderOrEqual(activeTabPath, oldPath)) {
      activeTabPath = rekey(activeTabPath);
    } else if (activeTabPath && !tabs.some((t) => t.path === activeTabPath)) {
      // The active tab was the displaced one dropped above — fall back the
      // same way closeTab/markPathDeleted do.
      activeTabPath = tabs[tabs.length - 1]?.path ?? null;
    }

    return { tabs, activeTabPath };
  });

  if (displacedDirtyNames.length > 0) {
    const message =
      displacedDirtyNames.length === 1
        ? `${displacedDirtyNames[0]} was overwritten by an external rename — its unsaved edits were discarded.`
        : `${displacedDirtyNames.join(", ")} were overwritten by an external rename — their unsaved edits were discarded.`;
    showErrorToast(message);
  }

  tabRenameSignal.set({ from: oldPath, to: newPath });
}

/** "Keep mine" action on the conflict banner: dismiss the banner, keep editing. */
export function dismissConflict(path: string): void {
  tabsState.update((s) => ({
    ...s,
    tabs: s.tabs.map((t) => (t.path === path ? { ...t, hasExternalConflict: false } : t)),
  }));
}
