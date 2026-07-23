const STORAGE_PREFIX = "atrium.recentFiles.";
const MAX_RECENT_FILES = 20;

/**
 * Recently-opened file paths, per workspace root, persisted to
 * `localStorage` (the same lightweight, best-effort persistence
 * `theme.ts`/`layout.ts` use for frontend-only preferences — this doesn't
 * need the Rust-backed `recents.ts` project list's cross-surface visibility
 * with the macOS Dock menu, just a fast local list Files-mode search can
 * read synchronously). Keyed per workspace root so switching projects
 * doesn't mix each project's own recent files together.
 */

function storageKey(root: string): string {
  return `${STORAGE_PREFIX}${root}`;
}

function load(root: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey(root));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function save(root: string, paths: string[]): void {
  try {
    localStorage.setItem(storageKey(root), JSON.stringify(paths));
  } catch {
    // localStorage unavailable or quota exceeded; recency simply won't persist.
  }
}

/**
 * Records `path` as just-opened for the workspace at `root`, moving it to
 * the front (deduped) and capping the list at `MAX_RECENT_FILES`. Best
 * effort — a persistence failure never blocks the actual file open.
 */
export function recordFileOpened(root: string, path: string): void {
  const paths = load(root).filter((p) => p !== path);
  paths.unshift(path);
  save(root, paths.slice(0, MAX_RECENT_FILES));
}

/** The workspace's recently-opened file paths, most-recent-first. */
export function getRecentFiles(root: string): string[] {
  return load(root);
}
