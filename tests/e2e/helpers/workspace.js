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
  await browser.refresh();

  const recentRow = await $(`//span[${hasClass("recent-path")} and text()='${root}']`);
  await recentRow.waitForExist({ timeout: 10000 });
  await recentRow.click();
}
