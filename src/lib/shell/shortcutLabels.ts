/**
 * The single source of truth for the Mac-glyph shortcut labels that are
 * displayed in more than one place: `StatusBar.svelte`'s button tooltips,
 * `KeyboardShortcutsDialog.svelte`'s `SHORTCUT_GROUPS`, and the shortcut
 * hints `ContextMenu.svelte`'s callers (the file-explorer menu, both split
 * dropdowns, and the editor/terminal right-click menus) render next to a
 * bound item's label — one hand-maintained mirror of `main.rs`'s
 * `build_menu` accelerators (plus the explorer's own JS-scoped shortcuts,
 * which have no native accelerator at all) to keep in sync, not several.
 * Atrium only ships for macOS, so every label is a Mac glyph — there is no
 * "Cmd/Ctrl" text or platform branching here.
 */
export const SHORTCUT_LABELS = {
  toggleExplorer: "⌘B",
  toggleTerminal: "⌘R",
  findInFiles: "⌘⇧F",
  goToFile: "⌘P",
  settings: "⌘,",
  newFile: "⌘N",
  newFolder: "⌘⇧N",
  rename: "F2",
  delete: "⌘⌫",
  revealInFinder: "⌥⌘R",
  splitUp: "⌥⌘↑",
  splitDown: "⌥⌘↓",
  splitLeft: "⌥⌘←",
  splitRight: "⌥⌘→",
  splitTerminalAlias: "⌘\\",
  cut: "⌘X",
  copy: "⌘C",
  paste: "⌘V",
  selectAll: "⌘A",
  save: "⌘S",
} as const;
