/**
 * Extracts the local filesystem path from an OSC 7 `file://host/path` payload.
 * Returns null when the payload isn't a well-formed `file://` URL.
 */
export function parseOsc7Cwd(payload: string): string | null {
  let url: URL;
  try {
    url = new URL(payload);
  } catch {
    return null;
  }
  if (url.protocol !== "file:") return null;
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
}

/** Last path segment, with any trailing slash stripped; falls back to the full path for "/" or a single-segment path. */
export function folderName(path: string): string {
  const trimmed = path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash === -1) return trimmed;
  const segment = trimmed.slice(lastSlash + 1);
  return segment === "" ? trimmed : segment;
}

/** Composes the display title: `folder`, or `folder — processTitle` when a command is running and has a title. */
export function computeTabTitle(params: {
  cwd: string;
  commandRunning: boolean;
  processTitle: string | null;
}): string {
  const folder = folderName(params.cwd);
  if (params.commandRunning && params.processTitle) {
    return `${folder} — ${params.processTitle}`;
  }
  return folder;
}
