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
