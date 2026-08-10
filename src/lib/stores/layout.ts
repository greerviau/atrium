import { writable, get, derived } from "svelte/store";
import { workspace } from "./workspace";
import { isStandaloneWorkspace } from "./workspaceMode";

export type TerminalPosition = "bottom" | "left" | "right";

export interface TerminalLayout {
  position: TerminalPosition;
  height: number;
  width: number;
}

const STORAGE_KEY = "atrium.layout.terminal";

export const HEIGHT_MIN = 80;
export const WIDTH_MIN = 140;
// Sanity ceiling for validating *persisted* data only (guards against
// corrupt/absurd values, e.g. a stray 9e15 from a hand-edited localStorage
// entry). The real upper bound during drag/mount is the live container size
// minus the space reserved for the editor pane — see clampToContainer.
const SANITY_MAX = 4000;

// Space reserved for the editor pane and the resizer itself when the
// terminal panel is dragged toward its container's full size.
export const MIN_EDITOR_SIZE = 200;
export const RESIZER_THICKNESS = 4;

const DEFAULT_LAYOUT: TerminalLayout = { position: "bottom", height: 240, width: 320 };

export function clampHeight(h: number): number {
  return Math.max(HEIGHT_MIN, Math.min(SANITY_MAX, h));
}

export function clampWidth(w: number): number {
  return Math.max(WIDTH_MIN, Math.min(SANITY_MAX, w));
}

/** Clamps `value` to [min, containerSize - reserved], falling back to `min` if the container has no room to spare. */
export function clampToContainer(
  value: number,
  min: number,
  containerSize: number,
  reserved: number = MIN_EDITOR_SIZE + RESIZER_THICKNESS,
): number {
  const max = Math.max(min, containerSize - reserved);
  return Math.max(min, Math.min(max, value));
}

/**
 * The one rule every ratio re-baseline in the app follows: clamp the pixel
 * value into the live container *first*, then take the ratio from the clamped
 * value, never from the raw one.
 *
 * Taking it from the raw value is what lets a recorded ratio drift out of
 * range. A pixel value that no longer fits its container yields a ratio above
 * 1; a later container change applies that as "more than the whole container",
 * the clamp on the way out silently caps it, and the round trip back to the
 * original container lands somewhere else entirely instead of restoring what
 * was on screen (issue #417). Clamping first makes the round trip exact by
 * construction: for a clamped `p` in container `c`,
 * `clamp(round((p / c) * c)) === p`.
 *
 * `Math.min(1, ...)` is an invariant, not a behaviour: against today's clamps
 * it is inert on rendered pixels, for two different reasons in two different
 * regimes. When the container has room to spare, `clampToContainer`'s ceiling
 * is `containerSize - reserved`, strictly below the container, so any ratio at
 * or above 1 saturates to it. When the container is smaller than the floor,
 * the ceiling collapses onto the floor and every input maps to `min`
 * regardless — a 100px container against a 140px floor clamps to 140, above
 * the container, no matter what ratio produced the input. Either way a
 * recorded 1, 1.49, and 3 render identically at every container size. It is
 * here so the returned `ratio` is total over `(0, 1]` in both regimes, and
 * callers and tests can rely on that range rather than re-deriving which one
 * a given container falls into. The clamp on the line above is what does the
 * actual work either way — this is what keeps its result nameable as a
 * fraction.
 *
 * Returns `null` when the container is not measurable, meaning "change
 * nothing" — the caller keeps whatever pair it already had.
 */
export function rebaselineRatio(
  pixelValue: number,
  containerSize: number,
  clamp: (value: number, containerSize: number) => number,
): { pixel: number; ratio: number } | null {
  if (!Number.isFinite(containerSize) || containerSize <= 0) return null;
  const pixel = clamp(pixelValue, containerSize);
  return { pixel, ratio: Math.min(1, pixel / containerSize) };
}

function isTerminalPosition(value: unknown): value is TerminalPosition {
  return value === "bottom" || value === "left" || value === "right";
}

/** Reads the persisted terminal layout, validating shape and clamping both dimensions. Falls back to the default layout on any missing/malformed data. */
export function loadTerminalLayout(): TerminalLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LAYOUT };
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !isTerminalPosition(parsed.position) ||
      typeof parsed.height !== "number" ||
      typeof parsed.width !== "number" ||
      !Number.isFinite(parsed.height) ||
      !Number.isFinite(parsed.width)
    ) {
      return { ...DEFAULT_LAYOUT };
    }
    return {
      position: parsed.position,
      height: clampHeight(parsed.height),
      width: clampWidth(parsed.width),
    };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

/** Persists the terminal layout. Swallows quota/availability errors since layout persistence is a best-effort convenience. */
export function saveTerminalLayout(layout: TerminalLayout): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // localStorage unavailable or quota exceeded; layout simply won't persist.
  }
}

/**
 * Canonical terminal dock position, initialized from `loadTerminalLayout()`.
 * Height/width stay as `App.svelte`'s own local resize state rather than
 * living here too — position is the one dimension a control outside the
 * resize gesture itself (the settings dialog) needs to read and change
 * directly.
 */
export const terminalPosition = writable<TerminalPosition>(loadTerminalLayout().position);

/** Changes the terminal dock position and persists it, reading the current height/width fresh from storage since those aren't tracked as a store here. */
export function setTerminalPosition(position: TerminalPosition): void {
  terminalPosition.set(position);
  const { height, width } = loadTerminalLayout();
  saveTerminalLayout({ position, height, width });
}

const EXPLORER_STORAGE_KEY = "atrium.layout.explorer";

export const EXPLORER_WIDTH_MIN = 140;
export const EXPLORER_WIDTH_MAX = 600;
const EXPLORER_WIDTH_DEFAULT = 240;

function clampExplorerWidth(w: number): number {
  return Math.max(EXPLORER_WIDTH_MIN, Math.min(EXPLORER_WIDTH_MAX, w));
}

/** Clamps an explorer width against both its own absolute range and however much of `containerWidth` the rest of the app needs at minimum. */
export function clampExplorerToContainer(width: number, containerWidth: number): number {
  return Math.min(EXPLORER_WIDTH_MAX, clampToContainer(width, EXPLORER_WIDTH_MIN, containerWidth, MIN_EDITOR_SIZE + RESIZER_THICKNESS));
}

/** Reads the persisted explorer sidebar width, clamping to range. Falls back to the default on any missing/malformed data. */
export function loadExplorerWidth(): number {
  try {
    const raw = localStorage.getItem(EXPLORER_STORAGE_KEY);
    if (!raw) return EXPLORER_WIDTH_DEFAULT;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "number" || !Number.isFinite(parsed)) return EXPLORER_WIDTH_DEFAULT;
    return clampExplorerWidth(parsed);
  } catch {
    return EXPLORER_WIDTH_DEFAULT;
  }
}

/** Persists the explorer sidebar width. Swallows quota/availability errors since this persistence is a best-effort convenience. */
export function saveExplorerWidth(width: number): void {
  try {
    localStorage.setItem(EXPLORER_STORAGE_KEY, JSON.stringify(width));
  } catch {
    // localStorage unavailable or quota exceeded; width simply won't persist.
  }
}

export interface PanelVisibility {
  explorerVisible: boolean;
  terminalVisible: boolean;
}

const PANELS_STORAGE_KEY = "atrium.layout.panels";

const DEFAULT_PANEL_VISIBILITY: PanelVisibility = { explorerVisible: true, terminalVisible: true };

/** Reads the persisted panel visibility, validating shape. Falls back to both panels shown on any missing/malformed data. */
function loadPanelVisibility(): PanelVisibility {
  try {
    const raw = localStorage.getItem(PANELS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PANEL_VISIBILITY };
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.explorerVisible !== "boolean" ||
      typeof parsed.terminalVisible !== "boolean"
    ) {
      return { ...DEFAULT_PANEL_VISIBILITY };
    }
    return { explorerVisible: parsed.explorerVisible, terminalVisible: parsed.terminalVisible };
  } catch {
    return { ...DEFAULT_PANEL_VISIBILITY };
  }
}

/** Persists panel visibility. Swallows quota/availability errors since this persistence is a best-effort convenience. */
function persistPanelVisibility(visibility: PanelVisibility): void {
  try {
    localStorage.setItem(PANELS_STORAGE_KEY, JSON.stringify(visibility));
  } catch {
    // localStorage unavailable or quota exceeded; visibility simply won't persist.
  }
}

const initialPanelVisibility = loadPanelVisibility();

/**
 * Canonical shown/hidden state for the explorer and terminal panels. The
 * native menu accelerator, the keyboard shortcut, and any future UI control
 * (e.g. a status-bar button) all read these stores and call the toggle
 * functions below rather than deriving or duplicating this state elsewhere.
 */
export const explorerVisible = writable<boolean>(initialPanelVisibility.explorerVisible);
export const terminalVisible = writable<boolean>(initialPanelVisibility.terminalVisible);

/**
 * The explorer's shown/hidden state in a root-less single-file workspace
 * (issue #325) — deliberately NOT persisted (a bare `writable`, not backed
 * by `loadPanelVisibility`/`persistPanelVisibility` like `explorerVisible`
 * above): a single-file window always starts with the sidebar hidden,
 * matching Zed, regardless of whatever `explorerVisible`'s own persisted
 * value is for project mode. `App.svelte` resets this to `false` whenever
 * the last standalone tab closes with no project open, so the *next*
 * single-file open starts hidden too, not just the first one this process.
 */
export const standaloneExplorerVisible = writable<boolean>(false);

/**
 * The single store every consumer should read instead of `explorerVisible`
 * directly — folds "is there a project or standalone reason to show the
 * explorer at all" into one value, so the app-shell template,
 * `mainContentWidth`, and the status-bar toggle button need no mode
 * knowledge of their own.
 */
export const explorerShown = derived(
  [explorerVisible, standaloneExplorerVisible, workspace, isStandaloneWorkspace],
  ([$explorerVisible, $standaloneExplorerVisible, $workspace, $isStandalone]) =>
    $workspace.root ? $explorerVisible : $isStandalone && $standaloneExplorerVisible,
);

/** Mode-aware: flips (and persists) `explorerVisible` when a project is open, or flips `standaloneExplorerVisible` (session-only, no persistence) otherwise. */
export function toggleExplorerVisible(): void {
  if (get(workspace).root) {
    explorerVisible.update((visible) => {
      const next = !visible;
      persistPanelVisibility({ explorerVisible: next, terminalVisible: get(terminalVisible) });
      return next;
    });
  } else {
    standaloneExplorerVisible.update((visible) => !visible);
  }
}

export function toggleTerminalVisible(): void {
  setTerminalVisible(!get(terminalVisible));
}

/** Sets the terminal dock's shown/hidden state directly and persists it, rather than flipping it. */
export function setTerminalVisible(visible: boolean): void {
  terminalVisible.set(visible);
  persistPanelVisibility({ explorerVisible: get(explorerVisible), terminalVisible: visible });
}
