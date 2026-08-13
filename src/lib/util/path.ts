/**
 * Minimal POSIX-style path helpers shared across the editor and explorer.
 * Deliberately not Node's `path` module (not available in the WebView) nor
 * `@tauri-apps/api/path` (that module's resolution helpers are async IPC
 * calls; callers like the markdown decorations need a synchronous string
 * join to build a `src`/target eagerly during rendering).
 *
 * **Canonical path form.** Every path that crosses the IPC boundary
 * (`src/lib/ipc/commands.ts`, `src/lib/ipc/events.ts`) is folded into one
 * form by `canonicalizePath` before it enters the frontend's identity space:
 * absolute, `/`-separated, no `\\?\` verbatim prefix, no repeated
 * separators, and no trailing separator (except where the whole path is a
 * root). Downstream code — `Set`/`Map` membership, keyed `{#each}` blocks,
 * raw `===` — is correct on paths only because exactly one spelling of each
 * file exists once this fold has run. `canonical_key` in
 * `src-tauri/src/path_key.rs` mirrors this function exactly for the
 * backend's own `String`-keyed identity structures; the two are held in
 * step by `tests/fixtures/canonical-path-vectors.json`.
 */

/**
 * Whether `path` looks like a Windows path: a drive letter (`C:\` or `C:/`)
 * or a UNC prefix (`\\server` or `//server`). Structural, not
 * platform-flagged, so this function (and everything built on it) is fully
 * exercisable from vitest on any host, and so it never mistakes a POSIX
 * filename that legally contains a literal backslash for a separator.
 */
function isWindowsShaped(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path);
}

/** Folds `\` to `/`, but only when `path` is Windows-shaped — see `isWindowsShaped`. */
function foldSeparators(path: string): string {
  return isWindowsShaped(path) ? path.replace(/\\/g, "/") : path;
}

/** Extension (no dot, lowercased) of a path's final segment; "" for extensionless names and dotfiles like `.gitignore`. */
export function extensionOf(path: string): string {
  const folded = foldSeparators(path);
  const name = folded.split("/").pop() ?? folded;
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Last path segment ("folder" for "/a/b/folder" or "/a/b/folder/"); falls back to the input if empty (e.g. `path` is "/"). */
export function basename(path: string): string {
  const folded = foldSeparators(path).replace(/\/+$/, "");
  const idx = folded.lastIndexOf("/");
  const name = idx < 0 ? folded : folded.slice(idx + 1);
  return name === "" ? path : name;
}

function dirname(filePath: string): string {
  const normalized = foldSeparators(filePath);
  const idx = normalized.lastIndexOf("/");
  return idx <= 0 ? "" : normalized.slice(0, idx);
}

/** Parent directory of `path`; falls back to `path` itself when there's no `/` to split on (unlike `dirname`, which falls back to `""`). Shared by the explorer's mutation flows (`contextMenu.ts`, `FileTree.svelte`, `explorerDropTargets.ts`), which all need "the directory a bare/root-level path still belongs to" rather than an empty string. */
export function dirOf(path: string): string {
  const normalized = foldSeparators(path);
  const idx = normalized.lastIndexOf("/");
  return idx <= 0 ? path : normalized.slice(0, idx);
}

/** Whether `path` is `prefix` itself or a descendant of it, matched at a path-separator boundary (so a prefix of `a/b` does not also match a sibling like `a/bc`). Normalizes backslashes first (only for Windows-shaped input — see `isWindowsShaped`): callers here compare tab/root/rename-event paths, which are absolute filesystem paths from the Rust side and use native separators on Windows — unlike `find_files`' `display_path`, which the backend already normalizes to `/`. */
export function isPathUnderOrEqual(path: string, prefix: string): boolean {
  const normalizedPath = foldSeparators(path);
  const normalizedPrefix = foldSeparators(prefix);
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
 * tab, issue #325). Normalizes backslashes on both sides first (only for
 * Windows-shaped input), so a native Windows root and path still match; the
 * `/`-separated result matches `find_files`' own `display_path` contract,
 * which every consumer of a workspace-relative path in the frontend already
 * assumes (notably `SearchOverlay`'s `splitHighlightedPath`, which splits
 * filename from directory on a literal `/`). The out-of-root fallback
 * deliberately returns the *original* string, not a normalized one: a path
 * outside the workspace is displayed in full, and is most readable in its
 * native form.
 */
export function relativeToRoot(path: string, root: string | null | undefined): string {
  if (!root) return path;
  const normalizedPath = foldSeparators(path);
  const prefix = `${foldSeparators(root).replace(/\/+$/, "")}/`;
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : path;
}

/**
 * Whether `a` and `b` refer to the same path, ignoring separator style
 * (`/` vs `\`, and only for Windows-shaped input) and a trailing separator.
 * Unlike `isPathUnderOrEqual`, which also accepts `a` being a *descendant*
 * of `b`, this is exact-match only — for comparing a tree node's
 * native-separator `entry.path` against `tabsState.activeTabPath`, which is
 * not guaranteed to be in the same form (most callers pass a path through
 * verbatim, but at least one, a markdown link's relative-path resolution,
 * normalizes backslashes to `/` along the way).
 */
export function pathsEqual(a: string, b: string): boolean {
  const normalize = (path: string) => foldSeparators(path).replace(/\/+$/, "");
  return normalize(a) === normalize(b);
}

const VERBATIM_UNC_PREFIX = /^\\\\\?\\UNC\\/i;
const VERBATIM_DISK_PREFIX = /^\\\\\?\\/;

/** Strips a `\\?\` verbatim prefix, per `canonicalizePath` rule 1. */
function stripVerbatimPrefix(path: string): string {
  if (VERBATIM_UNC_PREFIX.test(path)) {
    return `\\\\${path.slice(8)}`;
  }
  if (VERBATIM_DISK_PREFIX.test(path)) {
    return path.slice(4);
  }
  return path;
}

/** Collapses runs of `/` into one, preserving exactly one leading `//` for a UNC path, per `canonicalizePath` rule 3. */
function collapseSeparators(path: string): string {
  if (/^\/\//.test(path)) {
    return `//${path.slice(2).replace(/\/+/g, "/").replace(/^\/+/, "")}`;
  }
  return path.replace(/\/+/g, "/");
}

/** Strips a trailing `/`, per `canonicalizePath` rule 4, unless doing so would leave an empty string, a bare `/`, or a bare drive root (`C:/`). A UNC share root (`//server/share`) needs no special case: stripping its one possible trailing separator already lands there. */
function stripTrailingSeparator(path: string): string {
  if (path.length <= 1) return path;
  if (!path.endsWith("/")) return path;
  if (/^[A-Za-z]:\/$/.test(path)) return path;
  return path.slice(0, -1);
}

/**
 * Folds `path` into the canonical frontend form: absolute, `/`-separated,
 * no `\\?\` verbatim prefix, no repeated or trailing separators.
 *
 * Windows-shape detection is structural (a drive letter or a UNC prefix),
 * not platform-flagged, for two reasons. It keeps the function pure and
 * fully exercisable from vitest on any host, and it avoids corrupting a
 * POSIX filename that legally contains a literal backslash — the same
 * hazard `local.rs`'s `display_path` guards with `#[cfg(windows)]` and
 * `pty_manager.rs`'s `trim_trailing_separators` guards with its
 * `windows_style` flag.
 *
 * The canonical form for a UNC path is `//server/share/…` — folded to
 * forward slashes like every other Windows-shaped path, with exactly one
 * leading `//` preserved rather than collapsed to one slash (which would
 * turn it into an ordinary absolute path and lose the "this is a network
 * share" distinction Windows itself makes).
 *
 * Idempotent by construction —
 * `canonicalizePath(canonicalizePath(p)) === canonicalizePath(p)` — which
 * matters because persisted `localStorage` data (already canonical) is run
 * through this again on every restore (`editorSession.ts`, `recentFiles.ts`).
 *
 * **Known limitation, deliberate:** stripping `\\?\` gives up the
 * >260-character path support that the verbatim prefix confers on systems
 * without long-path mode enabled. This affects only external terminal-link
 * targets (the sole producer of that form) and is the same trade-off the
 * widely-used `dunce` crate makes by design.
 */
export function canonicalizePath(path: string): string {
  const stripped = stripVerbatimPrefix(path);
  const folded = foldSeparators(stripped);
  const collapsed = collapseSeparators(folded);
  return stripTrailingSeparator(collapsed);
}

/** Joins `dir` and `name` into a canonical path, tolerating a trailing separator on `dir`. */
export function joinPath(dir: string, name: string): string {
  return canonicalizePath(dir.endsWith("/") || dir.endsWith("\\") ? `${dir}${name}` : `${dir}/${name}`);
}

/**
 * `path` re-addressed from under `oldPath` to under `newPath`, or `null`
 * when `path` is not at or under `oldPath`. Pairs the containment guard
 * with the offset that depends on it, so the two can never be written
 * apart — the hazard behind issue #459, where `isPathUnderOrEqual`'s
 * tolerance of a trailing separator on its prefix was not matched by the
 * raw `oldPath.length` offset the callers sliced at.
 */
export function rekeyUnder(path: string, oldPath: string, newPath: string): string | null {
  if (!isPathUnderOrEqual(path, oldPath)) return null;
  const normalizedPath = foldSeparators(path);
  const normalizedOld = foldSeparators(oldPath).replace(/\/+$/, "");
  const suffix = normalizedPath.slice(normalizedOld.length);
  return canonicalizePath(`${newPath}${suffix}`);
}

/** Joins `base` and `relative`, resolving `.`/`..` segments lexically, and folds the result into the canonical path form. */
function resolveRelative(base: string, relative: string): string {
  if (relative.startsWith("/")) {
    return canonicalizePath(relative);
  }
  const foldedBase = foldSeparators(base);
  const baseParts = foldedBase.length > 0 ? foldedBase.split("/") : [];
  const relativeParts = foldSeparators(relative).split("/");
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
  return canonicalizePath(stack.join("/"));
}

export default { dirname, resolveRelative };
