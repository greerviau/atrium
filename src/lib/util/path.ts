/**
 * Minimal POSIX-style path helpers for resolving markdown link/image targets
 * relative to the file that contains them. Deliberately not Node's `path`
 * module (not available in the WebView) nor `@tauri-apps/api/path` (that
 * module's resolution helpers are async IPC calls; these decorations need a
 * synchronous string join to build a `src`/target eagerly during rendering).
 */

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
