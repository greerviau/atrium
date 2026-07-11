import { onMenuEvent } from "../ipc/events";
import { openWorkspaceFolder } from "../stores/workspace";
import { tabsState, requestSave } from "../stores/tabs";
import { get } from "svelte/store";

/**
 * Wires the native menu bar (built in `main.rs`) to frontend behavior. Menu
 * items have no notion of "the active editor," so `menu:save` goes through
 * the same `saveRequest` store an `EditorPane` would react to for a
 * synthetic Cmd+S; `menu:open-folder` and `menu:new-terminal-tab` call the
 * same functions their in-app buttons would.
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
}
