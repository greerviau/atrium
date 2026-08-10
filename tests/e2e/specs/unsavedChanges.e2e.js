import { expect } from "@wdio/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openWorkspace } from "../helpers/workspace.js";
import { hasClass } from "../helpers/selectors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "../fixtures");
const notePath = path.join(fixturesDir, "note.md");

async function openNoteAndDirtyIt(marker) {
  const fileNode = await $(`//span[${hasClass("name")} and text()='note.md']`);
  await fileNode.waitForExist({ timeout: 10000 });
  await fileNode.click();

  const editor = await $(".cm-content");
  await editor.waitForExist({ timeout: 5000 });
  await editor.click();
  await browser.keys(["End"]);
  await browser.keys(marker);

  const tab = await $(".editor-panel .tab.active .tab-name");
  await browser.waitUntil(async () => (await tab.getText()).includes("•"), {
    timeout: 5000,
    timeoutMsg: "expected the tab to show the dirty marker after editing",
  });
}

async function clickTabClose() {
  const closeButton = await $(".editor-panel .tab.active button.tab-close");
  // The accessible name is built from the tab's own absolute path
  // (`EditorPanel.svelte`), and the backend canonicalizes the workspace root
  // before emitting it, so the exact string is environment-dependent — assert
  // its tail rather than selecting on it.
  const label = await closeButton.getAttribute("aria-label");
  expect(label).toMatch(/^Close .*note\.md$/);
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
    await $(".editor-panel .tab.active").waitForExist({ timeout: 5000, reverse: true });

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
    await $(".editor-panel .tab.active").waitForExist({ timeout: 5000, reverse: true });

    await browser.waitUntil(() => fs.readFileSync(notePath, "utf8").includes("save-marker"), {
      timeout: 5000,
      timeoutMsg: "expected the edit to have been written to disk",
    });
  });
});

// Regresses issue #250: a failed save used to be swallowed silently on every
// trigger (the native Cmd+S accelerator/File > Save menu item, the in-editor
// Cmd+S keymap, and the editor context menu's Save item) — the dirty dot
// stayed lit and nothing else told the user anything went wrong. All three
// now route through `requestSaveReportingErrors`, which surfaces a failure
// via the shared `.error-toast`. `Meta+s` covers both the native
// accelerator and the in-editor keymap in one press: `main.rs` registers
// `CmdOrCtrl+S` as the `menu:save` item's own accelerator, so a real
// keypress is claimed by the native menu before it reaches either code
// path individually — this spec asserts the resulting user-visible
// behavior (the toast), which is identical regardless of which of the two
// call sites the platform ends up routing it through.
describe("silent save failure surfaces an error toast (issue #250)", () => {
  beforeEach(async () => {
    await openWorkspace(fixturesDir);
    fs.chmodSync(notePath, 0o444);
  });

  afterEach(() => {
    fs.chmodSync(notePath, 0o644);
  });

  it("Cmd+S shows an error toast naming the file when the write fails", async () => {
    await openNoteAndDirtyIt(" cmd-s-marker");

    await browser.keys(["Meta", "s"]);

    const toast = await $(".error-toast");
    await toast.waitForExist({ timeout: 5000 });
    await expect(toast).toHaveAttribute("role", "alert");
    await expect(toast).toHaveTextContaining("note.md");
  });

  it("the editor context menu's Save item shows an error toast when the write fails", async () => {
    await openNoteAndDirtyIt(" context-menu-marker");

    const editor = await $(".cm-content");
    await editor.click({ button: "right" });

    const saveItem = await $('[role="menuitem"]*=Save');
    await saveItem.waitForExist({ timeout: 5000 });
    await saveItem.click();

    const toast = await $(".error-toast");
    await toast.waitForExist({ timeout: 5000 });
    await expect(toast).toHaveTextContaining("note.md");
  });
});
