import { fsReadFile, isAppError, localWorkspaceId } from "../ipc/commands";
import { modeForPath } from "../editor/codeExtensions";
import { findLeaf, listLeaves, pruneMissingTabs, type EditorLeafPane, type EditorPaneNode } from "../editor/editorPaneTree";
import { tabsState, type Tab } from "./tabs";
import { editorPaneTree, focusedEditorPaneId } from "./editorPanes";

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

const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Persists the editor session for `root`, debounced ~400ms per root.
 * `editorPaneTree` updates on every `pointermove` during a split resize (not
 * just on drag end), so a naive write-per-change would hit `localStorage` on
 * every frame of a resize drag — the debounce keeps that contained here
 * rather than threading a "resize ended" callback through the resize path.
 */
export function saveEditorSession(root: string, session: PersistedEditorSession): void {
  const pending = pendingWrites.get(root);
  if (pending) clearTimeout(pending);
  pendingWrites.set(
    root,
    setTimeout(() => {
      pendingWrites.delete(root);
      writeEditorSession(root, session);
    }, SAVE_DEBOUNCE_MS),
  );
}

export interface RestoredEditorSession {
  tabs: Tab[];
  activeTabPath: string | null;
  paneTree: EditorPaneNode | null;
  focusedPaneId: string | null;
}

/**
 * Pure reconciliation step: given the persisted pane tree and a map of which
 * of its referenced paths were actually readable off disk (path -> file
 * contents; a path missing from `readable` is treated as gone — most
 * commonly deleted while the app was closed), prunes the tree down to just
 * the surviving paths — reusing `pruneMissingTabs`'s own tree-surgery (drop
 * the path from its leaf, collapse an emptied leaf, fall back that leaf's
 * `activeTabPath`) rather than duplicating it — and reconstructs the flat
 * `tabsState` tab list from the survivors. Kept free of IPC calls so
 * restore-time pruning is testable without mocking `fsReadFile`.
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
      mode,
      savedDoc: readable.get(path) as string,
      isDirty: false,
      hasExternalConflict: false,
      isDeleted: false,
      viewMode: mode === "markdown" ? "rendered" : undefined,
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
 * Restores the persisted editor session for `root` into `tabsState`,
 * `editorPaneTree`, and `focusedEditorPaneId`: loads it, re-reads every
 * distinct referenced path fresh off disk, and drops any path whose read
 * fails with `NOT_FOUND` (the file was deleted while the app was closed)
 * silently — reused below via `reconcileRestoredSession`/`pruneMissingTabs`
 * rather than duplicated. A no-op if nothing was persisted for `root` (a
 * brand-new project) — the caller's own reset already left
 * `tabsState`/`editorPaneTree` empty. Any other unexpected failure is
 * caught and logged rather than left as an unhandled rejection or a broken
 * project open — restore is a best-effort convenience, never a blocker.
 *
 * Sets `tabsState` before `editorPaneTree`/`focusedEditorPaneId` so the
 * tabsState/editorPaneTree reconciliation effect in `App.svelte` never
 * observes a tree referencing paths `tabsState` doesn't know about yet.
 */
export async function restoreEditorSession(root: string): Promise<void> {
  const session = loadEditorSession(root);
  if (!session || !session.paneTree) return;

  try {
    const paths = [...new Set(listLeaves(session.paneTree).flatMap((leaf) => leaf.tabs))];
    const readable = new Map<string, string>();
    await Promise.all(
      paths.map(async (path) => {
        try {
          readable.set(path, await fsReadFile(localWorkspaceId(), path));
        } catch (err) {
          if (!isAppError(err) || err.code !== "NOT_FOUND") throw err;
        }
      }),
    );

    const restored = reconcileRestoredSession(session, readable);
    tabsState.set({ tabs: restored.tabs, activeTabPath: restored.activeTabPath });
    editorPaneTree.set(restored.paneTree);
    focusedEditorPaneId.set(restored.focusedPaneId);
  } catch (err) {
    console.error("Failed to restore editor session:", err);
  }
}
