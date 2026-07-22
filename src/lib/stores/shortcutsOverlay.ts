import { writable } from "svelte/store";

/**
 * Whether the keyboard shortcuts dialog is open. Deliberately minimal,
 * mirroring `settingsOverlay.ts` — the dialog has no interactive controls of
 * its own, so there's no other state to centralize here.
 */
export const shortcutsOverlay = writable<{ open: boolean }>({ open: false });

export function openShortcuts(): void {
  shortcutsOverlay.set({ open: true });
}

export function closeShortcuts(): void {
  shortcutsOverlay.set({ open: false });
}
