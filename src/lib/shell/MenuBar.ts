import { onMenuEvent } from "../ipc/events";
import { openWorkspaceFolder } from "../stores/workspace";
import { tabsState, requestSave } from "../stores/tabs";
import { setTheme } from "../stores/theme";
import { get } from "svelte/store";

/**
 * Wires the native menu bar (built in `main.rs`) to frontend behavior. Menu
 * items have no notion of "the active editor," so `menu:save` goes through
 * the same `saveRequest` store an `EditorPane` would react to for a
 * synthetic Cmd+S; `menu:open-folder` and `menu:new-terminal-tab` call the
 * same functions their in-app buttons would; the four `menu:theme:*` items
 * call `setTheme` on the theme store.
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
  await onMenuEvent("menu:theme:auto", () => setTheme("auto"));
  await onMenuEvent("menu:theme:atrium-dark", () => setTheme("atrium-dark"));
  await onMenuEvent("menu:theme:atrium-light", () => setTheme("atrium-light"));
  await onMenuEvent("menu:theme:atrium-high-contrast", () => setTheme("atrium-high-contrast"));
}
