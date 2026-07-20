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
