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

export interface TitleState {
  cwd: string;
  commandRunning: boolean;
  processTitle: string | null;
}

export type OscEvent =
  | { type: "cwd"; cwd: string }
  | { type: "commandStart" }
  | { type: "commandFinish" }
  | { type: "title"; title: string };

/**
 * Pure reducer for the OSC 7 (cwd) / OSC 133 (command-start/finish) / OSC 0-2 (title)
 * state a terminal tab tracks. `commandStart` clears any `processTitle` left over from
 * the previous command, so a command that never sets its own title can't inherit a
 * stale one — this is the gating behavior `computeTabTitle` relies on to never show a
 * false process label on a shell without OSC 133 support (that shell simply never emits
 * `commandStart`, so `commandRunning` stays false forever).
 */
export function reduceTitleState(state: TitleState, event: OscEvent): TitleState {
  switch (event.type) {
    case "cwd":
      return { ...state, cwd: event.cwd };
    case "commandStart":
      return { ...state, commandRunning: true, processTitle: null };
    case "commandFinish":
      return { ...state, commandRunning: false };
    case "title":
      return { ...state, processTitle: event.title };
  }
}
