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

  it("splits the active pane into two independent concurrent PTYs, then survives closing one", async () => {
    // Type into the pre-existing pane *before* splitting, and confirm its
    // scrollback survives the split — the actual behavior issue #112 is
    // about (a pane that isn't the one being added must never have its PTY
    // killed and its terminal remounted just because the tree's shape
    // changed around it).
    const preSplitPane = await $(".xterm-screen");
    await preSplitPane.click();
    await browser.keys("echo atrium-pre-split-marker");
    await browser.keys("Enter");
    await browser.waitUntil(async () => (await preSplitPane.getText()).includes("atrium-pre-split-marker"), {
      timeout: 5000,
      timeoutMsg: "expected the pre-split marker to appear in the pane's output before splitting",
    });

    const splitButton = await $('button[aria-label="Split terminal"]');
    await splitButton.waitForExist({ timeout: 5000 });
    await splitButton.click();

    const splitRightOption = await $('[role="menuitem"]=Split Right');
    await splitRightOption.waitForExist({ timeout: 5000 });
    await splitRightOption.click();

    await browser.waitUntil(async () => (await $$(".xterm-screen")).length === 2, {
      timeout: 5000,
      timeoutMsg: "expected two independent terminal panes after splitting",
    });
    const [firstPane, secondPane] = await $$(".xterm-screen");

    // The pre-existing pane (now the first pane, per split-right placing the
    // new leaf after it) must still show the marker it had before the split
    // — its PTY and scrollback must never have been torn down.
    expect(await firstPane.getText()).toContain("atrium-pre-split-marker");

    // Distinct markers into each pane, clicking each first to move focus —
    // mirroring how the case above clicks `.xterm-screen` before typing.
    await firstPane.click();
    await browser.keys("echo atrium-split-marker-one");
    await browser.keys("Enter");

    await secondPane.click();
    await browser.keys("echo atrium-split-marker-two");
    await browser.keys("Enter");

    await browser.waitUntil(async () => (await firstPane.getText()).includes("atrium-split-marker-one"), {
      timeout: 5000,
      timeoutMsg: "expected the first pane's own marker to appear in its output",
    });
    await browser.waitUntil(async () => (await secondPane.getText()).includes("atrium-split-marker-two"), {
      timeout: 5000,
      timeoutMsg: "expected the second pane's own marker to appear in its output",
    });

    // Real concurrent-PTY behavior: neither pane's shell output leaks into
    // the other's, which only unit/component tests mocking TerminalPane
    // can't cover.
    expect(await firstPane.getText()).not.toContain("atrium-split-marker-two");
    expect(await secondPane.getText()).not.toContain("atrium-split-marker-one");

    // Close the first panel and confirm the second survives with its own
    // output intact. WebDriver can't inspect OS process state directly, so
    // the closed panel's PTY being gone is verified the same way the rest of
    // this suite verifies backend behavior — through the DOM: its
    // `.xterm-screen` only disappears once `TerminalPane`'s `onDestroy` ->
    // `ptyKill` has actually run.
    const firstPanel = (await $$(".pane-leaf"))[0];
    const closeButton = await firstPanel.$('button[aria-label="Close terminal"]');
    await closeButton.click();

    await browser.waitUntil(async () => (await $$(".xterm-screen")).length === 1, {
      timeout: 5000,
      timeoutMsg: "expected only one terminal pane to remain after closing the other",
    });

    const remainingPane = await $(".xterm-screen");
    expect(await remainingPane.getText()).toContain("atrium-split-marker-two");
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

describe("status bar", () => {
  it("shows the active file's path and cursor position, and updates as the caret moves", async () => {
    const statusBar = await $(".status-bar");
    await statusBar.waitForExist({ timeout: 5000 });

    const pathIndicator = await $(".status-bar .path");
    await expect(pathIndicator).toHaveText("note.md");

    const cursorIndicator = await $(".status-bar .status-item.mono:not(.path)");
    const before = await cursorIndicator.getText();

    const editor = await $(".cm-content");
    await editor.click();
    await browser.keys(["End"]);

    await browser.waitUntil(async () => (await cursorIndicator.getText()) !== before, {
      timeout: 5000,
      timeoutMsg: "expected the cursor-position indicator to update after moving the caret",
    });
  });

  it("clicking the status-bar search button opens the search overlay", async () => {
    const searchButton = await $('.status-bar button[aria-label="Search (Cmd/Ctrl+Shift+F)"]');
    await searchButton.click();

    const panel = await $(".search-panel");
    await panel.waitForExist({ timeout: 5000 });

    await browser.keys(["Escape"]);
    await panel.waitForExist({ timeout: 5000, reverse: true });
  });

  it("clicking the explorer toggle button hides and reshows the file explorer", async () => {
    const toggleButton = await $('.status-bar button[aria-label="Toggle Explorer (Cmd/Ctrl+B)"]');
    const explorer = await $(".explorer");
    await explorer.waitForExist({ timeout: 5000 });

    await toggleButton.click();
    await explorer.waitForExist({ timeout: 5000, reverse: true });

    await toggleButton.click();
    await explorer.waitForExist({ timeout: 5000 });
  });

  it("clicking the terminal toggle button hides and reshows the terminal panel", async () => {
    const toggleButton = await $('.status-bar button[aria-label="Toggle Terminal (Cmd/Ctrl+R)"]');
    const terminalArea = await $(".terminal-area");
    await terminalArea.waitForDisplayed({ timeout: 5000 });

    await toggleButton.click();
    await terminalArea.waitForDisplayed({ timeout: 5000, reverse: true });

    await toggleButton.click();
    await terminalArea.waitForDisplayed({ timeout: 5000 });
  });
});
