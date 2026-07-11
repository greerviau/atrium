import { get, writable } from "svelte/store";
import { fsReadFile, fsWriteFile, localWorkspaceId } from "../ipc/commands";
import { modeForPath, type PaneMode } from "../editor/codeExtensions";

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

export function requestSave(path: string): void {
  saveRequest.set(path);
}

/**
 * Opens `path` in the editor pane, focusing an existing tab if already open.
 * Shared by the file explorer, markdown-link clicks, and the terminal's
 * file-path link provider so "open a file" behaves identically everywhere.
 */
export async function openFile(path: string, selection?: PendingSelection): Promise<void> {
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
  const tab: Tab = {
    path,
    mode: modeForPath(path),
    savedDoc: contents,
    isDirty: false,
    pendingSelection: selection,
    hasExternalConflict: false,
  };
  tabsState.update((s) => ({
    tabs: [...s.tabs, tab],
    activeTabPath: path,
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
