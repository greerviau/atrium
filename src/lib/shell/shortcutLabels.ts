/**
 * The single source of truth for the Mac-glyph shortcut labels that are
 * displayed in more than one place. `StatusBar.svelte`'s button tooltips and
 * `KeyboardShortcutsDialog.svelte`'s `SHORTCUT_GROUPS` both read from here
 * for the four rows they share, so there is exactly one hand-maintained
 * mirror of `main.rs`'s `build_menu` accelerators to keep in sync, not two.
 * Atrium only ships for macOS, so every label is a Mac glyph — there is no
 * "Cmd/Ctrl" text or platform branching here.
 */
export const SHORTCUT_LABELS = {
  toggleExplorer: "⌘B",
  toggleTerminal: "⌘R",
  findInFiles: "⌘⇧F",
  settings: "⌘,",
} as const;
