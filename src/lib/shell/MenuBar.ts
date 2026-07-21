import { onMenuEvent } from "../ipc/events";
import { openWorkspaceFolder, workspace } from "../stores/workspace";
import { tabsState, requestSave } from "../stores/tabs";
import { setTheme } from "../stores/theme";
import { toggleExplorerVisible, toggleTerminalVisible } from "../stores/layout";
import { zoomIn, zoomOut, resetZoom } from "../stores/textSize";
import { openSearch } from "../search/searchOverlay";
import { get } from "svelte/store";

/**
 * Wires the native menu bar (built in `main.rs`) to frontend behavior. Menu
 * items have no notion of "the active editor," so `menu:save` goes through
 * the same `saveRequest` store an `EditorPane` would react to for a
 * synthetic Cmd+S; `menu:open-folder` and `menu:new-terminal-tab` call the
 * same functions their in-app buttons would; `menu:find-in-files` opens the
 * search overlay, guarded on a workspace being open the same way `menu:save`
 * is guarded on an active tab; `menu:toggle-explorer` and
 * `menu:toggle-terminal` call the same panel-visibility store actions a
 * status-bar button would; `menu:zoom-in`/`menu:zoom-out`/`menu:zoom-reset`
 * call the zoom store's actions; the four `menu:theme:*` items call
 * `setTheme` on the theme store.
 */
export async function initMenuBar(onNewTerminalTab: () => void): Promise<void> {
  await onMenuEvent("menu:open-folder", () => void openWorkspaceFolder());
  await onMenuEvent("menu:save", () => {
    const active = get(tabsState).activeTabPath;
    if (active) {
      requestSave(active);
    }
  });
  await onMenuEvent("menu:new-terminal-tab", onNewTerminalTab);
  await onMenuEvent("menu:find-in-files", () => {
    if (get(workspace).root) {
      openSearch();
    }
  });
  await onMenuEvent("menu:toggle-explorer", () => toggleExplorerVisible());
  await onMenuEvent("menu:toggle-terminal", () => toggleTerminalVisible());
  await onMenuEvent("menu:zoom-in", () => zoomIn());
  await onMenuEvent("menu:zoom-out", () => zoomOut());
  await onMenuEvent("menu:zoom-reset", () => resetZoom());
  await onMenuEvent("menu:theme:auto", () => setTheme("auto"));
  await onMenuEvent("menu:theme:atrium-dark", () => setTheme("atrium-dark"));
  await onMenuEvent("menu:theme:atrium-light", () => setTheme("atrium-light"));
  await onMenuEvent("menu:theme:atrium-high-contrast", () => setTheme("atrium-high-contrast"));
}
