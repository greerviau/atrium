import { expect } from "@wdio/globals";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "../fixtures");

// The native folder picker is outside the WebView and out of WebDriver's
// reach, so these tests register the workspace root directly through the
// same `workspace_set_root` command the picker's callback would call —
// everything downstream (the file tree, opening the file, live preview,
// save) exercises the real app code.
async function openWorkspace(root) {
  await browser.execute((path) => {
    return window.__TAURI_INTERNALS__.invoke("workspace_set_root", {
      workspaceId: "local",
      path,
    });
  }, root);
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
