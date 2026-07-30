import { get, writable } from "svelte/store";
import {
  fsReadFile,
  fsWriteFile,
  fsGrantExternalFile,
  isAppError,
  localWorkspaceId,
  standaloneWorkspaceId,
  workspaceRecordRecentFile,
} from "../ipc/commands";
import { modeForPath, type PaneMode } from "../editor/codeExtensions";
import { closePrompt } from "./closePrompt";
import { workspace } from "./workspace";
import { recordFileOpened } from "./recentFiles";
import { loadRecents } from "./recents";
import { showErrorToast, describeError } from "./errorToast";
import { markdownDefaultView } from "./markdownDefaultView";
import { basename, isPathUnderOrEqual } from "../util/path";

export interface PendingSelection {
  line: number;
  col?: number;
}

export interface Tab {
  path: string;
  /** Which workspace this tab's reads/writes route through — `localWorkspaceId()` for an ordinary project tab, `standaloneWorkspaceId()` for a file opened with no project open (issue #325). */
  workspaceId: string;
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
   * "markdown"` tabs. Not persisted per-tab — always starts at the current
   * `markdownDefaultView` setting on open, including a fresh open after the
   * tab was previously closed.
   */
  viewMode?: "rendered" | "source";
  /**
   * True for a file opened from outside the workspace root via drag-drop —
   * purely a display hint (a badge/icon and a full-path tooltip on the tab),
   * never consulted for any permission decision. The real authorization is
   * enforced entirely server-side by the grant map (`external_grants.rs`),
   * independent of anything this flag says — a UI bug here can misrender a
   * tab, never bypass anything.
   */
  isExternal: boolean;
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
 * `workspaceId` defaults to the local project workspace for every existing
 * call site; the standalone-open path (`App.svelte`'s `doHandleOsOpenPath`)
 * is the only caller that passes something else.
 */
export async function openFile(
  path: string,
  selection?: PendingSelection,
  workspaceId: string = localWorkspaceId(),
): Promise<void> {
  const root = get(workspace).root;
  // A path opened through a non-local workspace (standalone) is always
  // external, regardless of what it looks like relative to the current
  // project root — without this, `isPathUnderOrEqual(anyAbsolutePath, "")`
  // degenerates to a bare `startsWith("/")` check and would wrongly compute
  // `isExternal: false` for a standalone open against no root.
  const isExternal = workspaceId !== localWorkspaceId() ? true : !isPathUnderOrEqual(path, root ?? "");
  if (root && !isExternal) {
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

  const contents = await fsReadFile(workspaceId, path);
  const mode = modeForPath(path);
  const tab: Tab = {
    path,
    workspaceId,
    mode,
    savedDoc: contents,
    isDirty: false,
    pendingSelection: selection,
    hasExternalConflict: false,
    isDeleted: false,
    viewMode: mode === "markdown" ? get(markdownDefaultView) : undefined,
    isExternal,
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
export function openFileReportingErrors(
  path: string,
  selection?: PendingSelection,
  workspaceId: string = localWorkspaceId(),
): void {
  openFile(path, selection, workspaceId).catch((err: unknown) => {
    showErrorToast(`Couldn't open file: ${describeError(err)}`);
  });
}

/**
 * Grants external access to `path` and opens it: an ordinary external tab
 * under the current project when one is open, or a root-less standalone tab
 * (issue #325) when none is. Shared by every "open a file with no in-app
 * browsing" entry point — an OS open (`RunEvent::Opened`, a Dock-menu pick,
 * a real "Open With Atrium"), and a recent-projects entry that turns out to
 * be a file rather than a folder — so a path arriving either way ends up in
 * the same place. A standalone open is additionally recorded to the recents
 * list (issue #325's follow-on: "so I can get back to them"), so it can be
 * reopened the same way later.
 */
export async function openExternalFile(path: string): Promise<void> {
  const root = get(workspace).root;
  const targetWorkspaceId = root ? localWorkspaceId() : standaloneWorkspaceId();
  try {
    await fsGrantExternalFile(targetWorkspaceId, path);
  } catch {
    // Swallowed deliberately — the open below surfaces its own,
    // already-tested error via the standard toast.
  }
  try {
    await openFile(path, undefined, targetWorkspaceId);
  } catch (err) {
    showErrorToast(`Couldn't open file: ${describeError(err)}`);
    return;
  }
  if (targetWorkspaceId === standaloneWorkspaceId()) {
    // Ancillary to the open that already succeeded above, so a failure here
    // is swallowed rather than surfaced — matching `performWorkspaceSwitch`'s
    // own best-effort recents refresh.
    workspaceRecordRecentFile(path)
      .then(() => loadRecents())
      .catch(() => {});
  }
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

/**
 * Saves `contents` for `path` and flips the tab back to clean.
 *
 * `hasExternalConflict`/`isDeleted` are only cleared here when they were
 * already set *before* this write started (captured in `before`, taken from
 * the same pre-`await` read `workspaceId` comes from) — a successful save
 * resolving a conflict or deletion the caller already knew about is the
 * existing "keep mine" / recreate-on-save behavior. A flag that turns true
 * only *during* the write — a genuinely new external event racing with this
 * save — is left untouched: this write knows nothing about it, and clearing
 * it would make the conflict banner disappear the instant it appears,
 * exactly the failure `reconcileExternalChange` was fixed to avoid, one
 * layer down.
 *
 * `getLiveContent`, when given (`EditorPane.svelte`'s `save()` passes its own
 * `currentDoc`), is called from *inside* the same `tabsState.update` that
 * applies this write's result, not after a further `await` back in the
 * caller — a keystroke landing while `fsWriteFile`'s round trip was in
 * flight moves the live buffer on before `savedDoc`/`isDirty` are decided,
 * and only a check made at that exact synchronous moment can see it. A
 * post-`await` check back in the caller is a tick too late: resolving this
 * function's own promise takes one more microtask hop than the
 * `tabsState.update` below, and the external-change reconciliation effect's
 * own re-run is already scheduled off that update, ahead of the caller's
 * continuation — it would silently replace the buffer with the
 * (already-stale) `savedDoc` before the caller ever got to react. Without
 * `getLiveContent`, this behaves as it always did: `isDirty` unconditionally
 * flips to `false`.
 */
export async function saveTab(path: string, contents: string, getLiveContent?: () => string): Promise<void> {
  const before = get(tabsState).tabs.find((t) => t.path === path);
  const workspaceId = before?.workspaceId ?? localWorkspaceId();
  await fsWriteFile(workspaceId, path, contents);
  tabsState.update((s) => ({
    ...s,
    tabs: s.tabs.map((t) => {
      if (t.path !== path) return t;
      const movedOn = getLiveContent !== undefined && getLiveContent() !== contents;
      return {
        ...t,
        savedDoc: contents,
        isDirty: movedOn,
        hasExternalConflict: before?.hasExternalConflict ? false : t.hasExternalConflict,
        isDeleted: before?.isDeleted ? false : t.isDeleted,
      };
    }),
  }));
}

/**
 * Reacts to an `fs:changed` event for `path` (App.svelte forwards these from
 * the global listener). A clean tab silently reloads; a dirty tab reads disk
 * and only raises the conflict banner (instead of overwriting unsaved
 * edits, section 6.2) when the disk contents actually differ from what this
 * tab believes is saved.
 *
 * The dirty branch used to flag a conflict unconditionally, without reading
 * disk at all. That was harmless when the only way to reach a clean-then-
 * dirty-again cycle was manual typing between manual saves, but the file
 * watcher has no self-write suppression: every in-app write (including
 * auto-save) echoes back as its own `fs:changed` event, and comparing
 * against event provenance can't distinguish "this is our own write coming
 * back" from "something else changed this file" — only the actual disk
 * content can. Reading first and comparing against `savedDoc` (what this
 * tab's own last write set it to) makes an echo of our own write a no-op,
 * while a disk content that genuinely diverges from `savedDoc` still raises
 * the banner, even if it arrives coalesced with our own echo inside the
 * same watcher debounce window. This never *clears* an already-raised
 * conflict on its own — it only sets it or returns — so a later echo can't
 * dismiss a banner the user hasn't acted on yet.
 *
 * A `NOT_FOUND` read failure is treated as a deletion rather than left as an
 * unhandled rejection: this is a defensive fallback for the timing race
 * where a `Modify` event's read loses to an external delete landing
 * microseconds later, since a genuine `Remove`-kind event is routed to
 * `markPathDeleted` directly by the `fs:changed` handler. Now reachable from
 * a dirty tab too — a dirty tab whose file disappears is correctly flagged
 * `isDeleted` rather than only ever showing a conflict banner.
 *
 * A `FILE_TOO_LARGE` or `EXTERNAL_FILE_CHANGED` read failure surfaces as a
 * toast instead of an unhandled rejection (or, for a dirty tab, instead of
 * the conflict banner — a "Reload" action would fail against either error
 * anyway), leaving the tab showing its last-known content.
 *
 * Every decision made *after* the `await fsReadFile` re-reads this tab's live
 * state rather than trusting the snapshot taken before it — `tab.isDirty`/
 * `tab.savedDoc` can both change while that read is in flight (a keystroke
 * landing mid-read, or this tab's own save completing mid-read), and
 * branching on the stale values reproduces exactly the two failure modes
 * this function exists to prevent: a real external change lands while the
 * tab is still clean by the stale snapshot, silently overwrites `savedDoc`
 * with no conflict ever raised (and no later reconcile can raise one either,
 * since the comparison baseline is now the external content); or this tab's
 * own write completes mid-read, making the stale `savedDoc` comparison wrong
 * and raising a spurious conflict on the app's own write. Only the read
 * itself is issued against the pre-`await` snapshot (`tab.workspaceId`,
 * which cannot change once a tab exists) — everything decided from the
 * result comes from a fresh read of `tabsState`.
 */
export async function reconcileExternalChange(path: string): Promise<void> {
  const state = get(tabsState);
  const tab = state.tabs.find((t) => t.path === path);
  if (!tab) {
    return;
  }

  let contents: string;
  try {
    contents = await fsReadFile(tab.workspaceId, path);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") {
      markPathDeleted(path);
      return;
    }
    if (isAppError(err) && err.code === "FILE_TOO_LARGE") {
      showErrorToast(describeError(err));
      return;
    }
    if (isAppError(err) && err.code === "EXTERNAL_FILE_CHANGED") {
      showErrorToast(describeError(err));
      return;
    }
    throw err;
  }

  const live = get(tabsState).tabs.find((t) => t.path === path);
  if (!live) {
    return;
  }

  if (live.isDirty) {
    if (contents !== live.savedDoc) {
      tabsState.update((s) => ({
        ...s,
        tabs: s.tabs.map((t) => (t.path === path ? { ...t, hasExternalConflict: true } : t)),
      }));
    }
    return;
  }

  tabsState.update((s) => ({
    ...s,
    tabs: s.tabs.map((t) => (t.path === path ? { ...t, savedDoc: contents } : t)),
  }));
}

/** "Reload" action on the conflict banner: discard local edits, take disk contents. */
export async function reloadFromDisk(path: string): Promise<void> {
  const workspaceId = get(tabsState).tabs.find((t) => t.path === path)?.workspaceId ?? localWorkspaceId();
  const contents = await fsReadFile(workspaceId, path);
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
