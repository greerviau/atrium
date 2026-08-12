/**
 * Minimal POSIX-style path helpers shared across the editor and explorer.
 * Deliberately not Node's `path` module (not available in the WebView) nor
 * `@tauri-apps/api/path` (that module's resolution helpers are async IPC
 * calls; callers like the markdown decorations need a synchronous string
 * join to build a `src`/target eagerly during rendering).
 */

/** Extension (no dot, lowercased) of a path's final segment; "" for extensionless names and dotfiles like `.gitignore`. */
export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Last path segment ("folder" for "/a/b/folder" or "/a/b/folder/"); falls back to the input if empty (e.g. `path` is "/"). */
export function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  const name = idx < 0 ? normalized : normalized.slice(idx + 1);
  return name === "" ? path : name;
}

function dirname(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx <= 0 ? "" : normalized.slice(0, idx);
}

/** Parent directory of `path`; falls back to `path` itself when there's no `/` to split on (unlike `dirname`, which falls back to `""`). Shared by the explorer's mutation flows (`contextMenu.ts`, `FileTree.svelte`, `explorerDropTargets.ts`), which all need "the directory a bare/root-level path still belongs to" rather than an empty string. */
export function dirOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx <= 0 ? path : normalized.slice(0, idx);
}

/** Whether `path` is `prefix` itself or a descendant of it, matched at a path-separator boundary (so a prefix of `a/b` does not also match a sibling like `a/bc`). Normalizes backslashes first: callers here compare tab/root/rename-event paths, which are absolute filesystem paths from the Rust side and use native separators on Windows — unlike `find_files`' `display_path`, which the backend already normalizes to `/`. */
export function isPathUnderOrEqual(path: string, prefix: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/");
  const normalizedPrefix = prefix.replace(/\\/g, "/");
  return (
    normalizedPath === normalizedPrefix ||
    normalizedPath.startsWith(
      normalizedPrefix.endsWith("/") ? normalizedPrefix : `${normalizedPrefix}/`,
    )
  );
}

/**
 * `path` expressed relative to `root`, always `/`-separated, or `path`
 * verbatim when it is not under `root` (or there is no root — a standalone
 * tab, issue #325). Normalizes backslashes on both sides first, so a native
 * Windows root and path still match; the `/`-separated result matches
 * `find_files`' own `display_path` contract, which every consumer of a
 * workspace-relative path in the frontend already assumes (notably
 * `SearchOverlay`'s `splitHighlightedPath`, which splits filename from
 * directory on a literal `/`). The out-of-root fallback deliberately returns
 * the *original* string, not a normalized one: a path outside the workspace
 * is displayed in full, and is most readable in its native form.
 */
export function relativeToRoot(path: string, root: string | null | undefined): string {
  if (!root) return path;
  const normalizedPath = path.replace(/\\/g, "/");
  const prefix = `${root.replace(/\\/g, "/").replace(/\/+$/, "")}/`;
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : path;
}

/**
 * Whether `a` and `b` refer to the same path, ignoring separator style
 * (`/` vs `\`) and a trailing separator. Unlike `isPathUnderOrEqual`, which
 * also accepts `a` being a *descendant* of `b`, this is exact-match only —
 * for comparing a tree node's native-separator `entry.path` against
 * `tabsState.activeTabPath`, which is not guaranteed to be in the same form
 * (most callers pass a path through verbatim, but at least one, a markdown
 * link's relative-path resolution, normalizes backslashes to `/` along the
 * way).
 */
export function pathsEqual(a: string, b: string): boolean {
  const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalize(a) === normalize(b);
}

/** Joins `base` and `relative`, resolving `.`/`..` segments lexically. */
function resolveRelative(base: string, relative: string): string {
  if (relative.startsWith("/")) {
    return relative;
  }
  const baseParts = base.length > 0 ? base.replace(/\\/g, "/").split("/") : [];
  const relativeParts = relative.replace(/\\/g, "/").split("/");
  const stack = [...baseParts];
  for (const part of relativeParts) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join("/");
}

export default { dirname, resolveRelative };
