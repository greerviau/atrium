import { onMenuEvent } from "../ipc/events";
import { openWorkspaceFolder, workspace } from "../stores/workspace";
import { tabsState, requestSaveReportingErrors } from "../stores/tabs";
import { toggleExplorerVisible, toggleTerminalVisible } from "../stores/layout";
import { zoomIn, zoomOut, resetZoom } from "../stores/textSize";
import { openSearch } from "../search/searchOverlay";
import { openSettings } from "../stores/settingsOverlay";
import { openShortcuts } from "../stores/shortcutsOverlay";
import { openExternalLink } from "../ipc/commands";
import { showErrorToast, describeError } from "../stores/errorToast";
import { get } from "svelte/store";
import type { SplitDirection } from "../terminal/paneTree";

/**
 * Wires the native menu bar (built in `main.rs`) to frontend behavior. Menu
 * items have no notion of "the active editor," so `menu:save` goes through
 * the same `saveRequest` store an `EditorPane` would react to for a
 * synthetic Cmd+S; `menu:open-folder`, `menu:new-terminal-tab`, and
 * `menu:split-terminal` call the same functions their in-app buttons would;
 * `menu:find-in-files` opens the search overlay in content mode, guarded on
 * a workspace being open the same way `menu:save` is guarded on an active
 * tab; `menu:go-to-file` opens it in Files mode under the same guard;
 * `menu:settings` opens the settings dialog unconditionally, since it's
 * reachable whether or not a workspace is open;
 * `menu:toggle-explorer` and `menu:toggle-terminal` call the same
 * panel-visibility store actions a status-bar button would;
 * `menu:zoom-in`/`menu:zoom-out`/`menu:zoom-reset` call the zoom store's
 * actions; `menu:help:shortcuts` opens the keyboard shortcuts dialog, and
 * `menu:help:github`/`menu:help:report-issue` open their hardcoded GitHub
 * URLs via the same `openExternalLink` command rendered markdown links use.
 * `menu:split-up`/`-down`/`-left`/`-right` all route through the same
 * `onSplitDirection` callback (`App.svelte`'s `splitFocusedSurface`), which
 * decides for itself which of the terminal dock or the editor's split panes
 * last had focus — the menu item itself carries no more context than which
 * direction was chosen. `menu:split-terminal` keeps calling `onSplitTerminal`
 * unchanged, a separate, terminal-only alias for split-right specifically.
 * `menu:close-tab` routes through `onCloseTab` (`App.svelte`'s
 * `closeFocusedTab`), which resolves the same last-focused surface to close
 * that surface's active tab.
 */
export async function initMenuBar(
  onNewTerminalTab: () => void,
  onSplitTerminal: () => void,
  onSplitDirection: (direction: SplitDirection) => void,
  onCloseTab: () => void,
): Promise<void> {
  await onMenuEvent("menu:open-folder", () => void openWorkspaceFolder());
  await onMenuEvent("menu:settings", () => openSettings());
  await onMenuEvent("menu:save", () => {
    const active = get(tabsState).activeTabPath;
    if (active) {
      requestSaveReportingErrors(active);
    }
  });
  await onMenuEvent("menu:new-terminal-tab", onNewTerminalTab);
  await onMenuEvent("menu:split-terminal", onSplitTerminal);
  await onMenuEvent("menu:split-up", () => onSplitDirection("up"));
  await onMenuEvent("menu:split-down", () => onSplitDirection("down"));
  await onMenuEvent("menu:split-left", () => onSplitDirection("left"));
  await onMenuEvent("menu:split-right", () => onSplitDirection("right"));
  await onMenuEvent("menu:find-in-files", () => {
    if (get(workspace).root) {
      openSearch();
    }
  });
  await onMenuEvent("menu:go-to-file", () => {
    if (get(workspace).root) {
      openSearch("files");
    }
  });
  await onMenuEvent("menu:toggle-explorer", () => toggleExplorerVisible());
  await onMenuEvent("menu:toggle-terminal", () => toggleTerminalVisible());
  await onMenuEvent("menu:zoom-in", () => zoomIn());
  await onMenuEvent("menu:zoom-out", () => zoomOut());
  await onMenuEvent("menu:zoom-reset", () => resetZoom());
  await onMenuEvent("menu:help:shortcuts", () => openShortcuts());
  const openHelpLink = (url: string): void => {
    openExternalLink(url).catch((err: unknown) => {
      showErrorToast(`Couldn't open link: ${describeError(err)}`);
    });
  };
  await onMenuEvent("menu:help:github", () => openHelpLink("https://github.com/greerviau/atrium"));
  await onMenuEvent("menu:help:report-issue", () =>
    openHelpLink("https://github.com/greerviau/atrium/issues/new"),
  );
  await onMenuEvent("menu:close-tab", onCloseTab);
}
