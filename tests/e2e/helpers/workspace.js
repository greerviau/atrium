import { $, browser } from "@wdio/globals";
import { hasClass } from "./selectors.js";

// Registers `root` as the workspace root and opens it through the real
// welcome-screen flow.
//
// The native folder picker is outside the WebView and out of WebDriver's
// reach, so the root is registered directly through the same
// `workspace_set_root` command the picker's callback would call.
// `workspace_set_root` also records `root` as a recent project, so reloading
// and clicking its row on the welcome screen picks it up through the real
// `openWorkspacePath` flow (including the workspace store update) —
// everything downstream exercises real app code.
export async function openWorkspace(root) {
  await browser.execute((workspacePath) => {
    return window.__TAURI_INTERNALS__.invoke("workspace_set_root", {
      workspaceId: "local",
      path: workspacePath,
    });
  }, root);

  // Clears persisted frontend state before the reload that picks the root up.
  // `restoreTabsOnStartup` defaults to true and the editor's split-pane tree
  // is persisted per workspace root, so without this a spec inherits whatever
  // tabs and pane splits an *earlier spec file* left in the shared webview
  // profile. A restored split renders every leaf fully visible side by side
  // (there is no hidden-pane mechanism on the editor side, unlike the
  // terminal's `.terminal-pane-slot.hidden`) — so an unscoped `$(".cm-content")`
  // or `$(".cm-heading-1")` resolves to the first leaf in DOM order, which can
  // be a stale pane left over from a previous spec rather than the one holding
  // the file the current spec just opened, producing a wrong-pane content
  // mismatch rather than a real interactability failure. The workspace root
  // itself survives: `workspace_set_root` records it in the backend's
  // `recents.json`, not in `localStorage`.
  await browser.execute(() => {
    localStorage.clear();
  });
  await browser.refresh();

  const recentRow = await $(`//span[${hasClass("recent-path")} and text()='${root}']`);
  await recentRow.waitForExist({ timeout: 10000 });
  await recentRow.click();
}
