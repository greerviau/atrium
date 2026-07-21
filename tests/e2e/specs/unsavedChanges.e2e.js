import { expect } from "@wdio/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "../fixtures");
const notePath = path.join(fixturesDir, "note.md");

// Mirrors `smoke.e2e.js`'s own helper: the native folder picker is outside
// WebDriver's reach, so the workspace root is registered directly through
// the same `workspace_set_root` command the picker's callback would call.
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

async function openNoteAndDirtyIt(marker) {
  const fileNode = await $("//span[@class='name' and text()='note.md']");
  await fileNode.waitForExist({ timeout: 10000 });
  await fileNode.click();

  const editor = await $(".cm-content");
  await editor.waitForExist({ timeout: 5000 });
  await editor.click();
  await browser.keys(["End"]);
  await browser.keys(marker);

  const tab = await $("//div[@class='tab active']//span[@class='tab-name']");
  await browser.waitUntil(async () => (await tab.getText()).includes("•"), {
    timeout: 5000,
    timeoutMsg: "expected the tab to show the dirty marker after editing",
  });
}

async function clickTabClose() {
  const closeButton = await $('.tab.active button[aria-label="Close /note.md"]');
  await closeButton.click();
}

describe("unsaved-changes close confirmation", () => {
  beforeEach(async () => {
    await openWorkspace(fixturesDir);
  });

  it("Don't Save discards the edit and closes the tab without touching disk", async () => {
    const before = fs.readFileSync(notePath, "utf8");
    await openNoteAndDirtyIt(" dont-save-marker");

    await clickTabClose();

    const dialog = await $(".close-prompt-panel");
    await dialog.waitForExist({ timeout: 5000 });
    await expect(dialog).toHaveTextContaining("note.md");

    const dontSaveButton = await $(".close-prompt-panel button=Don't Save");
    await dontSaveButton.click();

    await dialog.waitForExist({ timeout: 5000, reverse: true });
    await $("//div[@class='tab active']").waitForExist({ timeout: 5000, reverse: true });

    expect(fs.readFileSync(notePath, "utf8")).toBe(before);
  });

  it("Save writes the edit to disk before closing the tab", async () => {
    await openNoteAndDirtyIt(" save-marker");

    await clickTabClose();

    const dialog = await $(".close-prompt-panel");
    await dialog.waitForExist({ timeout: 5000 });

    const saveButton = await $(".close-prompt-panel button=Save");
    await saveButton.click();

    await dialog.waitForExist({ timeout: 5000, reverse: true });
    await $("//div[@class='tab active']").waitForExist({ timeout: 5000, reverse: true });

    await browser.waitUntil(() => fs.readFileSync(notePath, "utf8").includes("save-marker"), {
      timeout: 5000,
      timeoutMsg: "expected the edit to have been written to disk",
    });
  });
});
