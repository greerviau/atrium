import { writable } from "svelte/store";

/**
 * Whether the settings dialog is open. Deliberately minimal, mirroring
 * `searchOverlay.ts` — the dialog's own controls all read/write their
 * existing stores directly, so there's no other state to centralize here.
 */
export const settingsOverlay = writable<{ open: boolean }>({ open: false });

export function openSettings(): void {
  settingsOverlay.set({ open: true });
}

export function closeSettings(): void {
  settingsOverlay.set({ open: false });
}
