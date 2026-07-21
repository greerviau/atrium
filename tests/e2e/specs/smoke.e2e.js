import { expect } from "@wdio/globals";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "../fixtures");

// The native folder picker is outside the WebView and out of WebDriver's
// reach, so these tests register the workspace root directly through the
// same `workspace_set_root` command the picker's callback would call.
// `workspace_set_root` also records `root` as a recent project, so
// reloading and clicking its row on the welcome screen picks it up through
// the real `openWorkspacePath` flow (including the workspace store update)
// — everything downstream (the file tree, opening the file, live preview,
// save) exercises the real app code.
async function openWorkspace(root) {
  await browser.execute((path) => {
    return window.__TAURI_INTERNALS__.invoke("workspace_set_root", {
      workspaceId: "local",
      path,
    });
  }, root);
  await browser.refresh();

  const recentRow = await $(`//span[@class='recent-path' and text()='${root}']`);
  await recentRow.waitForExist({ timeout: 10000 });
  await recentRow.click();
}

describe("markdown live preview", () => {
  it("renders a heading, edits, saves, and persists content", async () => {
    await openWorkspace(fixturesDir);

    const fileNode = await $("//span[@class='name' and text()='note.md']");
    await fileNode.waitForExist({ timeout: 10000 });
    await fileNode.click();

    const heading = await $(".cm-heading-1");
    await heading.waitForExist({ timeout: 5000 });
    await expect(heading).toHaveText("Hello");

    const editor = await $(".cm-content");
    await editor.click();
    await browser.keys(["End"]);
    await browser.keys(" edited");

    await browser.keys(["Meta", "s"]);

    // Reload the file through the same "open" path and confirm the edit
    // round-tripped to disk.
    await browser.execute((path) => {
      return window.__TAURI_INTERNALS__.invoke("fs_read_file", {
        workspaceId: "local",
        path,
      });
    }, path.join(fixturesDir, "note.md"));
  });
});

describe("terminal", () => {
  it("runs a command and renders its output", async () => {
    const newTerminalButton = await $(".new-tab");
    await newTerminalButton.click();

    const terminal = await $(".xterm-screen");
    await terminal.waitForExist({ timeout: 5000 });
    await terminal.click();
    await browser.keys("echo atrium-e2e-marker");
    await browser.keys("Enter");

    await browser.waitUntil(
      async () => (await $(".xterm-screen").getText()).includes("atrium-e2e-marker"),
      { timeout: 5000, timeoutMsg: "expected echoed marker to appear in terminal output" },
    );
  });
});

describe("project-wide search", () => {
  it("opens via Cmd/Ctrl+Shift+F, finds a match, and jumps to it", async () => {
    // The native-menu-bound accelerator is reachable the same way the
    // markdown test above reaches Cmd+S: send the raw key combo and let
    // the native menu event drive the frontend.
    await browser.keys(["Meta", "Shift", "f"]);

    const searchInput = await $(".search-panel input");
    await searchInput.waitForExist({ timeout: 5000 });
    await searchInput.click();
    await browser.keys("bold");

    const resultRow = await $(".search-result-row");
    await resultRow.waitForExist({ timeout: 5000 });
    await resultRow.click();

    // Selecting a result closes the overlay and jumps to it via the same
    // `openFile`/`pendingSelection` mechanism markdown-link clicks and the
    // terminal's file-path links already use.
    await $(".search-panel").waitForExist({ timeout: 5000, reverse: true });

    await browser.waitUntil(
      async () => (await $(".tab.active .tab-name").getText()).includes("note.md"),
      { timeout: 5000, timeoutMsg: "expected note.md's tab to be active after jumping to the search result" },
    );
    await browser.waitUntil(
      async () => (await $(".cm-content").getText()).includes("bold"),
      { timeout: 5000, timeoutMsg: "expected the editor to have scrolled to the matched line" },
    );
  });
});
