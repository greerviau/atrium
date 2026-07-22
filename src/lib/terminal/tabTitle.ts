/** Last path segment, with any trailing slash stripped; falls back to the full path for "/" or a single-segment path. */
export function folderName(path: string): string {
  const trimmed = path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash === -1) return trimmed;
  const segment = trimmed.slice(lastSlash + 1);
  return segment === "" ? trimmed : segment;
}

export interface TitleState {
  cwd: string;
  /** The foreground program's name, from the backend's OS-level `Title` event. */
  program: string | null;
  /** From OSC 0/2 (`terminal.onTitleChange`); overrides the bare `program` name when set. */
  explicitTitle: string | null;
}

/** Composes the display title: `folder`, or `folder — label` when a program is running. */
export function computeTabTitle(state: TitleState): string {
  const folder = folderName(state.cwd);
  const label = state.program ? (state.explicitTitle ?? state.program) : null;
  return label ? `${folder} — ${label}` : folder;
}

export type TitleEvent =
  | { type: "backendTitle"; cwd: string; program: string | null }
  | { type: "title"; title: string };

/**
 * Pure reducer for the OS-reported `(cwd, program)` pair and the OSC 0/2
 * explicit-title override a terminal tab tracks. A `backendTitle` event
 * whose `program` differs from the current one (including a transition to
 * or from `null`) clears any `explicitTitle` left over from the previous
 * program, so a program that never sets its own title can't inherit a
 * stale one from whatever ran before it.
 */
export function reduceTitleState(state: TitleState, event: TitleEvent): TitleState {
  switch (event.type) {
    case "backendTitle":
      if (event.program === state.program) {
        return { ...state, cwd: event.cwd };
      }
      return { ...state, cwd: event.cwd, program: event.program, explicitTitle: null };
    case "title":
      return { ...state, explicitTitle: event.title };
  }
}
