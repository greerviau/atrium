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
  /**
   * Whether `explicitTitle` was set after the most recent `commandSubmitted`
   * event (an Enter keypress). A program's own OSC 0/2 title normally
   * arrives within milliseconds of it starting, well before the backend's
   * next poll tick confirms the new foreground process — so at the moment
   * `backendTitle` reports that transition, an `explicitTitle` set since the
   * triggering Enter plausibly belongs to the program that just started,
   * while one set before it is the idle shell's own prompt title (many
   * shells, e.g. Debian/Ubuntu bash and macOS zsh by default, set one) and
   * must not bleed into the next program's label.
   */
  explicitTitleIsFresh: boolean;
}

/** Composes the display title: `folder`, or `folder — label` when a program is running. */
export function computeTabTitle(state: TitleState): string {
  const folder = folderName(state.cwd);
  const label = state.program ? (state.explicitTitle ?? state.program) : null;
  return label ? `${folder} — ${label}` : folder;
}

export type TitleEvent =
  | { type: "backendTitle"; cwd: string; program: string | null }
  | { type: "title"; title: string }
  | { type: "commandSubmitted" };

/**
 * Pure reducer for the OS-reported `(cwd, program)` pair and the OSC 0/2
 * explicit-title override a terminal tab tracks.
 *
 * A `backendTitle` event whose `program` differs from the current one
 * (including a transition to or from `null`) clears `explicitTitle` unless
 * it's still fresh (set since the last `commandSubmitted`) — a stale title
 * left over from the previous program, or from the shell's own idle
 * prompt, can't bleed into the new one, while a title the just-started
 * program set for itself survives the backend's later confirmation of it.
 */
export function reduceTitleState(state: TitleState, event: TitleEvent): TitleState {
  switch (event.type) {
    case "backendTitle":
      if (event.program === state.program) {
        return { ...state, cwd: event.cwd };
      }
      return {
        ...state,
        cwd: event.cwd,
        program: event.program,
        explicitTitle: state.explicitTitleIsFresh ? state.explicitTitle : null,
      };
    case "title":
      return { ...state, explicitTitle: event.title, explicitTitleIsFresh: true };
    case "commandSubmitted":
      return { ...state, explicitTitleIsFresh: false };
  }
}
