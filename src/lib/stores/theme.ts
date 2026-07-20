import { writable } from "svelte/store";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyThemeToDocument } from "../theme/cssVars";
import { atriumDark, themeById, type Theme } from "../theme/tokens";

const STORAGE_KEY = "atrium.theme";
const AUTO = "auto";

function isKnownSelection(value: unknown): value is string {
  return value === AUTO || themeById(value as string) !== undefined;
}

/** Reads the persisted theme selection id, falling back to Auto if unset/unrecognized (matches layout.ts's own validate-and-fallback pattern). */
function loadSelection(): string {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isKnownSelection(raw) ? raw : AUTO;
  } catch {
    return AUTO;
  }
}

/** Persists the theme selection. Swallows quota/availability errors since theme persistence is a best-effort convenience. */
function saveSelection(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // localStorage unavailable or quota exceeded; selection simply won't persist.
  }
}

let selection = loadSelection();
let unlistenThemeChanged: (() => void) | undefined;

/** The current resolved `Theme` (never the "auto" sentinel itself — Auto is always resolved to a concrete theme before landing here). */
export const theme = writable<Theme>(atriumDark);

/** Resolves Auto to Atrium Dark/Light based on the OS's live window appearance, falling back to Atrium Dark if the window-theme API is unavailable (e.g. outside a Tauri window). */
async function resolveAuto(): Promise<Theme> {
  try {
    const osTheme = await getCurrentWindow().theme();
    return osTheme === "light" ? themeById("atrium-light")! : atriumDark;
  } catch {
    return atriumDark;
  }
}

async function resolveAndApply(): Promise<void> {
  const resolved = selection === AUTO ? await resolveAuto() : (themeById(selection) ?? atriumDark);
  theme.set(resolved);
  applyThemeToDocument(resolved);
}

/** Subscribes to live OS-appearance changes only while the selection is Auto; otherwise tears down any previous subscription. */
async function syncAutoSubscription(): Promise<void> {
  unlistenThemeChanged?.();
  unlistenThemeChanged = undefined;
  if (selection !== AUTO) {
    return;
  }
  try {
    unlistenThemeChanged = await getCurrentWindow().onThemeChanged(() => {
      void resolveAndApply();
    });
  } catch {
    // Window-theme-change events unavailable (e.g. outside a Tauri window); Auto just won't live-update.
  }
}

/** Resolves and applies the persisted selection, and subscribes to live OS-appearance changes if it's Auto. Called once from `main.ts`, before mounting `App`, to minimize the flash-of-wrong-theme window on startup. */
export async function initTheme(): Promise<void> {
  await resolveAndApply();
  await syncAutoSubscription();
}

/** Changes the active theme selection (a built-in theme id, or `"auto"`), persists it, and re-applies to every surface. */
export function setTheme(id: string): void {
  if (!isKnownSelection(id)) {
    return;
  }
  selection = id;
  saveSelection(id);
  void resolveAndApply();
  void syncAutoSubscription();
}
