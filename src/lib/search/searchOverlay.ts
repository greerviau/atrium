import { writable } from "svelte/store";

/**
 * Whether the project-wide search overlay is open. Deliberately minimal —
 * query text, toggle state, results, and selection index are local state
 * inside `SearchOverlay.svelte` itself, the same reasoning `WelcomeScreen`
 * gives for not lifting its own single-usage-site state into a store.
 */
export const searchOverlay = writable<{ open: boolean }>({ open: false });

export function openSearch(): void {
  searchOverlay.set({ open: true });
}

export function closeSearch(): void {
  searchOverlay.set({ open: false });
}
