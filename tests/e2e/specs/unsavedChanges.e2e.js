import { expect } from "@wdio/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openWorkspace } from "../helpers/workspace.js";
import { hasClass } from "../helpers/selectors.js";
import { elementText } from "../helpers/text.js";
import { waitForEditorFocus } from "../helpers/editorFocus.js";
import { invokeMenuCommand, openEditorContextMenu } from "../helpers/menu.js";

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
  await waitForEditorFocus();
  await browser.keys(["End"]);
  await browser.keys(marker);

  await browser.waitUntil(
    async () => ((await elementText(".editor-panel .tab.active .tab-name")) ?? "").includes("•"),
    { timeout: 5000, timeoutMsg: "expected the tab to show the dirty marker after editing" },
  );
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

// Chains the scope instead of `$(".close-prompt-panel button=Save")`: that
// compound form is not recognized, and gets forwarded as raw CSS.
async function clickPromptButton(label) {
  const panel = await $(".close-prompt-panel");
  const button = await panel.$(`button=${label}`);
  await button.waitForExist({ timeout: 5000 });
  await button.click();
}

describe("unsaved-changes close confirmation", () => {
  let pristine;

  beforeEach(async () => {
    pristine = fs.readFileSync(notePath, "utf8");
    await openWorkspace(fixturesDir);
  });

  afterEach(() => {
    fs.writeFileSync(notePath, pristine);
  });

  it("Don't Save discards the edit and closes the tab without touching disk", async () => {
    const before = fs.readFileSync(notePath, "utf8");
    await openNoteAndDirtyIt(" dont-save-marker");

    await clickTabClose();

    const dialog = await $(".close-prompt-panel");
    await dialog.waitForExist({ timeout: 5000 });
    await expect(dialog).toHaveText(expect.stringContaining("note.md"));

    await clickPromptButton("Don't Save");

    await dialog.waitForExist({ timeout: 5000, reverse: true });
    await $(".editor-panel .tab.active").waitForExist({ timeout: 5000, reverse: true });

    expect(fs.readFileSync(notePath, "utf8")).toBe(before);
  });

  it("Save writes the edit to disk before closing the tab", async () => {
    await openNoteAndDirtyIt(" save-marker");

    await clickTabClose();

    const dialog = await $(".close-prompt-panel");
    await dialog.waitForExist({ timeout: 5000 });

    await clickPromptButton("Save");

    await dialog.waitForExist({ timeout: 5000, reverse: true });
    await $(".editor-panel .tab.active").waitForExist({ timeout: 5000, reverse: true });

    await browser.waitUntil(() => fs.readFileSync(notePath, "utf8").includes("save-marker"), {
      timeout: 5000,
      timeoutMsg: "expected the edit to have been written to disk",
    });
  });
});

// Regresses issue #250: a failed save used to be swallowed silently. Both
// triggers now route through `requestSaveReportingErrors`, which surfaces the
// failure via the shared `.error-toast`.
//
// The save is driven by emitting `menu:save` rather than pressing Cmd/Ctrl+S:
// `main.rs` registers `CmdOrCtrl+S` as a native menu accelerator, and a
// WebDriver-synthesized chord never reaches the native menu, so the keypress
// tests nothing. Emitting the event exercises the same path the accelerator
// and the File > Save menu item both take. The in-editor CodeMirror keymap is
// consequently not covered here; `tests/frontend/` covers that.
describe("silent save failure surfaces an error toast (issue #250)", () => {
  let pristine;

  beforeEach(async () => {
    pristine = fs.readFileSync(notePath, "utf8");
    await openWorkspace(fixturesDir);
    fs.chmodSync(notePath, 0o444);
  });

  afterEach(() => {
    fs.chmodSync(notePath, 0o644);
    fs.writeFileSync(notePath, pristine);
  });

  it("Save shows an error toast naming the file when the write fails", async () => {
    await openNoteAndDirtyIt(" cmd-s-marker");

    await invokeMenuCommand("menu:save");

    const toast = await $(".error-toast");
    await toast.waitForExist({ timeout: 5000 });
    await expect(toast).toHaveAttribute("role", "alert");
    await expect(toast).toHaveText(expect.stringContaining("note.md"));
  });

  it("the editor context menu's Save item shows an error toast when the write fails", async () => {
    await openNoteAndDirtyIt(" context-menu-marker");

    await openEditorContextMenu();

    // Chained, not `$('.context-menu [role="menuitem"]*=Save')`: a descendant
    // combinator in front of a `=`/`*=` text match is not recognized and the
    // whole string is forwarded as raw CSS, which this target rejects.
    const menu = await $(".context-menu");
    await menu.waitForExist({ timeout: 5000 });
    const saveItem = await menu.$('[role="menuitem"]*=Save');
    await saveItem.waitForExist({ timeout: 5000 });
    await saveItem.click();

    const toast = await $(".error-toast");
    await toast.waitForExist({ timeout: 5000 });
    await expect(toast).toHaveText(expect.stringContaining("note.md"));
  });
});
