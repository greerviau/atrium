import { get, writable } from "svelte/store";
import { workspace } from "../stores/workspace";

/**
 * Whether the project-wide search overlay is open, and which mode it's in.
 * Deliberately minimal — query text, toggle state, results, and selection
 * index are local state inside `SearchOverlay.svelte` itself, the same
 * reasoning `WelcomeScreen` gives for not lifting its own single-usage-site
 * state into a store. `mode` is the one piece of "which picker is this"
 * state that has to live here rather than in the component, since it's what
 * both global shortcuts write through `openSearch(mode)`. Content and Files
 * are two fully separate, exclusive views — there is no in-panel control to
 * switch between them, only Cmd/Ctrl+Shift+F (always content) and
 * Cmd/Ctrl+P (always files).
 */
export type SearchMode = "content" | "files";

export const searchOverlay = writable<{ open: boolean; mode: SearchMode }>({
  open: false,
  mode: "content",
});

/**
 * Opens the overlay — a no-op with no project open. Search only ever
 * operates over a workspace root, so there is nothing for it to search in
 * standalone mode (issue #325); `StatusBar`'s search button is already
 * gated on `$workspace.root`, and `MenuBar.ts`'s two menu events are already
 * gated the same way, so this is belt-and-suspenders against any other
 * caller reaching it with no project open.
 */
export function openSearch(mode: SearchMode = "content"): void {
  if (!get(workspace).root) return;
  searchOverlay.set({ open: true, mode });
}

export function closeSearch(): void {
  searchOverlay.update((s) => ({ ...s, open: false }));
}
