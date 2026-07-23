import { get, writable } from "svelte/store";
import { fsReadFile, fsWriteFile, localWorkspaceId } from "../ipc/commands";
import { modeForPath, type PaneMode } from "../editor/codeExtensions";
import { closePrompt } from "./closePrompt";
import { workspace } from "./workspace";
import { recordFileOpened } from "./recentFiles";

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
    viewMode: mode === "markdown" ? "rendered" : undefined,
  };
  tabsState.update((s) => ({
    tabs: [...s.tabs, tab],
    activeTabPath: path,
  }));
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

export function closeTab(path: string): void {
  tabsState.update((s) => {
    const tabs = s.tabs.filter((t) => t.path !== path);
    const activeTabPath =
      s.activeTabPath === path ? (tabs[tabs.length - 1]?.path ?? null) : s.activeTabPath;
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
      t.path === path ? { ...t, savedDoc: contents, isDirty: false, hasExternalConflict: false } : t,
    ),
  }));
}

/**
 * Reacts to an `fs:changed` event for `path` (App.svelte forwards these from
 * the global listener). A clean tab silently reloads; a dirty tab shows a
 * conflict banner instead of overwriting unsaved edits (section 6.2).
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
  const contents = await fsReadFile(localWorkspaceId(), path);
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
      t.path === path ? { ...t, savedDoc: contents, isDirty: false, hasExternalConflict: false } : t,
    ),
  }));
}

/** "Keep mine" action on the conflict banner: dismiss the banner, keep editing. */
export function dismissConflict(path: string): void {
  tabsState.update((s) => ({
    ...s,
    tabs: s.tabs.map((t) => (t.path === path ? { ...t, hasExternalConflict: false } : t)),
  }));
}
