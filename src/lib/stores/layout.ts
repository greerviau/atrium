export type TerminalPosition = "bottom" | "left" | "right";

export interface TerminalLayout {
  position: TerminalPosition;
  height: number;
  width: number;
}

const STORAGE_KEY = "atrium.layout.terminal";

const HEIGHT_RANGE = [80, 700] as const;
const WIDTH_RANGE = [140, 600] as const;

const DEFAULT_LAYOUT: TerminalLayout = { position: "bottom", height: 240, width: 320 };

export function clampHeight(h: number): number {
  return Math.max(HEIGHT_RANGE[0], Math.min(HEIGHT_RANGE[1], h));
}

export function clampWidth(w: number): number {
  return Math.max(WIDTH_RANGE[0], Math.min(WIDTH_RANGE[1], w));
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
