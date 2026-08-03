import { get } from "svelte/store";
import { fsCheckFileAccess, fsReadFile, isAppError, localWorkspaceId } from "../ipc/commands";
import { isTextPaneMode, modeForPath } from "../editor/codeExtensions";
import { findLeaf, listLeaves, pruneMissingTabs, type EditorLeafPane, type EditorPaneNode } from "../editor/editorPaneTree";
import { markdownDefaultView } from "./markdownDefaultView";
import type { Tab } from "./tabs";

const STORAGE_PREFIX = "atrium.editorSession.";
const SAVE_DEBOUNCE_MS = 400;

/**
 * The editor's split-pane tree + which leaf was focused, per workspace root,
 * persisted to `localStorage` (the same lightweight, best-effort persistence
 * `recentFiles.ts` uses, for the same reason: this is pure frontend
 * rendering state with no Rust-side consumer). `tabsState`'s own `Tab`
 * objects aren't persisted here — a leaf's `tabs: string[]` already records
 * every open path and its order, and the tabs themselves are reconstructed
 * on restore by re-reading each path fresh off disk.
 */
export interface PersistedEditorSession {
  paneTree: EditorPaneNode | null;
  focusedPaneId: string | null;
}

function storageKey(root: string): string {
  return `${STORAGE_PREFIX}${root}`;
}

function isValidLeaf(value: unknown): value is EditorLeafPane {
  if (typeof value !== "object" || value === null) return false;
  const leaf = value as Record<string, unknown>;
  return (
    leaf.type === "leaf" &&
    typeof leaf.id === "string" &&
    Array.isArray(leaf.tabs) &&
    leaf.tabs.every((p): p is string => typeof p === "string") &&
    (typeof leaf.activeTabPath === "string" || leaf.activeTabPath === null)
  );
}

function isValidPaneNode(value: unknown): value is EditorPaneNode {
  if (typeof value !== "object" || value === null) return false;
  const node = value as Record<string, unknown>;
  if (node.type === "leaf") return isValidLeaf(value);
  if (node.type !== "split") return false;
  return (
    typeof node.id === "string" &&
    (node.direction === "row" || node.direction === "column") &&
    Array.isArray(node.children) &&
    node.children.length >= 2 &&
    node.children.every(isValidPaneNode) &&
    Array.isArray(node.sizes) &&
    node.sizes.length === node.children.length &&
    node.sizes.every((s): s is number => typeof s === "number" && Number.isFinite(s))
  );
}

function isValidSession(value: unknown): value is PersistedEditorSession {
  if (typeof value !== "object" || value === null) return false;
  const session = value as Record<string, unknown>;
  return (
    (session.paneTree === null || isValidPaneNode(session.paneTree)) &&
    (typeof session.focusedPaneId === "string" || session.focusedPaneId === null)
  );
}

/** Reads the persisted editor session for `root`. Returns `null` on anything missing, malformed, or absent — the caller treats that the same as a brand-new project. */
export function loadEditorSession(root: string): PersistedEditorSession | null {
  try {
    const raw = localStorage.getItem(storageKey(root));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValidSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeEditorSession(root: string, session: PersistedEditorSession): void {
  try {
    localStorage.setItem(storageKey(root), JSON.stringify(session));
  } catch {
    // localStorage unavailable or quota exceeded; session simply won't persist.
  }
}

interface PendingWrite {
  timer: ReturnType<typeof setTimeout>;
  session: PersistedEditorSession;
}

const pendingWrites = new Map<string, PendingWrite>();

/**
 * Persists the editor session for `root`, debounced ~400ms per root.
 * `editorPaneTree` updates on every `pointermove` during a split resize (not
 * just on drag end), so a naive write-per-change would hit `localStorage` on
 * every frame of a resize drag — the debounce keeps that contained here
 * rather than threading a "resize ended" callback through the resize path.
 */
export function saveEditorSession(root: string, session: PersistedEditorSession): void {
  const pending = pendingWrites.get(root);
  if (pending) clearTimeout(pending.timer);
  const timer = setTimeout(() => {
    pendingWrites.delete(root);
    writeEditorSession(root, session);
  }, SAVE_DEBOUNCE_MS);
  pendingWrites.set(root, { timer, session });
}

/**
 * Writes `root`'s pending debounced save immediately, instead of waiting out
 * the rest of the debounce window. A no-op if nothing is pending. Called
 * right before the app actually closes so a save scheduled just before
 * quitting (e.g. a split resized, or a tab opened, moments before Cmd+Q)
 * isn't silently dropped by the window closing out from under the timer.
 */
export function flushEditorSession(root: string): void {
  const pending = pendingWrites.get(root);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingWrites.delete(root);
  writeEditorSession(root, pending.session);
}

export interface RestoredEditorSession {
  tabs: Tab[];
  activeTabPath: string | null;
  paneTree: EditorPaneNode | null;
  focusedPaneId: string | null;
}

/**
 * Pure reconciliation step. Given the persisted pane tree and a map of
 * accessible paths, it prunes the tree and reconstructs the flat `tabsState`
 * tab list from the survivors. Map values contain text contents or an empty
 * value for a binary-backed pane. A missing map entry means the path is gone,
 * most commonly because it was deleted while the app was closed.
 *
 * Reuses `pruneMissingTabs` to drop paths, collapse empty leaves, and choose
 * each leaf's fallback `activeTabPath`. Kept free of IPC calls so restore-time
 * pruning is testable without mocking `fsReadFile`.
 */
export function reconcileRestoredSession(
  session: PersistedEditorSession,
  readable: ReadonlyMap<string, string>,
): RestoredEditorSession {
  if (!session.paneTree) {
    return { tabs: [], activeTabPath: null, paneTree: null, focusedPaneId: null };
  }

  const survivingPaths = new Set(
    listLeaves(session.paneTree)
      .flatMap((leaf) => leaf.tabs)
      .filter((path) => readable.has(path)),
  );

  const paneTree = pruneMissingTabs(session.paneTree, survivingPaths);
  const tabs: Tab[] = [...survivingPaths].map((path) => {
    const mode = modeForPath(path);
    return {
      path,
      // A restored project session only ever contains local tabs by
      // construction — a standalone tab is never persisted into a project's
      // own session (see `App.svelte`'s persistence-write effect).
      workspaceId: localWorkspaceId(),
      mode,
      savedDoc: readable.get(path) as string,
      isDirty: false,
      hasExternalConflict: false,
      isExternal: false,
      isDeleted: false,
      viewMode: mode === "markdown" ? get(markdownDefaultView) : undefined,
    };
  });

  const focusedPaneId =
    paneTree && session.focusedPaneId && findLeaf(paneTree, session.focusedPaneId)
      ? session.focusedPaneId
      : (paneTree ? (listLeaves(paneTree)[0]?.id ?? null) : null);
  const activeTabPath = focusedPaneId ? (findLeaf(paneTree as EditorPaneNode, focusedPaneId)?.activeTabPath ?? null) : null;

  return { tabs, activeTabPath, paneTree, focusedPaneId };
}

/**
 * Computes the restored editor session for `root`: loads it, re-reads every
 * distinct text path fresh off disk, validates binary-backed paths without
 * transferring their contents, and drops any path whose access
 * fails with `NOT_FOUND` (the file was deleted while the app was closed) or
 * `INVALID_PATH` (a persisted external tab — its grant is in-memory-only and
 * never survives a relaunch, so it falls straight through to the unmodified
 * `escapes_workspace_root` rejection on a fresh workspace instance) silently
 * — reused below via `reconcileRestoredSession`/`pruneMissingTabs` rather
 * than duplicated. Returns `null` if nothing was persisted for `root` (a
 * brand-new project) or an unexpected failure occurs (logged rather than
 * left as an unhandled rejection or a broken project open — restore is a
 * best-effort convenience, never a blocker).
 *
 * Tolerating `INVALID_PATH` is safe at this one call site specifically:
 * this is the only place `fsReadFile` is ever called against a brand-new
 * `LocalWorkspace` instance whose grant map is still empty, so
 * `capture_identity`'s own `"is not a regular file"` `InvalidPath` (the
 * only other source of that code) cannot yet be reachable through it. It is
 * *not* true that `read_file` only ever produces `INVALID_PATH` for the
 * escapes-the-workspace-root reason in general — widening a tolerance check
 * elsewhere in the app on that assumption would be wrong.
 *
 * Deliberately does *not* apply the result to `tabsState`/`editorPaneTree`/
 * `focusedEditorPaneId` itself: the caller (`App.svelte`) owns applying it,
 * guarded against a second, later project switch superseding this one
 * before its `fsReadFile` calls resolve — see the project-switch effect's
 * own switch-token comment for why that guard has to live there rather than
 * in here.
 */
export async function restoreEditorSession(root: string): Promise<RestoredEditorSession | null> {
  const session = loadEditorSession(root);
  if (!session || !session.paneTree) return null;

  try {
    const paths = [...new Set(listLeaves(session.paneTree).flatMap((leaf) => leaf.tabs))];
    const readable = new Map<string, string>();
    await Promise.all(
      paths.map(async (path) => {
        try {
          const mode = modeForPath(path);
          if (isTextPaneMode(mode)) {
            readable.set(path, await fsReadFile(localWorkspaceId(), path));
          } else {
            await fsCheckFileAccess(localWorkspaceId(), path);
            readable.set(path, "");
          }
        } catch (err) {
          if (!isAppError(err) || (err.code !== "NOT_FOUND" && err.code !== "INVALID_PATH")) throw err;
        }
      }),
    );

    return reconcileRestoredSession(session, readable);
  } catch (err) {
    console.error("Failed to restore editor session:", err);
    return null;
  }
}
