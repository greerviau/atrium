import { expect } from "@wdio/globals";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openWorkspace } from "../helpers/workspace.js";
import { hasClass } from "../helpers/selectors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "../fixtures");

// The five file-explorer shortcuts (§ Gap 1a) are plain DOM `keydown`
// handlers scoped to whichever tree row holds focus, not native `main.rs`
// accelerators (see the safety-constraint note in the plan) — clicking a
// row focuses it exactly the way a real user would before pressing one of
// these chords.
describe("file-explorer keyboard shortcuts (issue #156)", () => {
  it("⌘N on a focused row creates a new file, and F2 opens an inline rename prefilled with its name", async () => {
    await openWorkspace(fixturesDir);

    const noteNode = await $(`//span[${hasClass("name")} and text()='note.md']`);
    await noteNode.waitForExist({ timeout: 10000 });
    await noteNode.click();

    await browser.keys(["Meta", "n"]);

    const createInput = await $(".inline-edit-input");
    await createInput.waitForExist({ timeout: 5000 });
    await createInput.setValue("e2e-shortcut-new-file.txt");
    await browser.keys(["Enter"]);

    const newFileNode = await $(`//span[${hasClass("name")} and text()='e2e-shortcut-new-file.txt']`);
    await newFileNode.waitForExist({ timeout: 5000 });

    // F2 on the newly created file's own row opens an inline rename
    // prefilled with its current name (not empty, and not the New
    // File/Folder flow) — Escape leaves it untouched.
    await newFileNode.click();
    await browser.keys(["F2"]);

    const renameInput = await $(".inline-edit-input");
    await renameInput.waitForExist({ timeout: 5000 });
    await expect(renameInput).toHaveValue("e2e-shortcut-new-file.txt");

    await browser.keys(["Escape"]);
    await renameInput.waitForExist({ timeout: 5000, reverse: true });
  });

  it("⌘⌫ on a focused row opens the permanent-delete confirmation modal rather than deleting immediately", async () => {
    const targetNode = await $(`//span[${hasClass("name")} and text()='e2e-shortcut-new-file.txt']`);
    await targetNode.waitForExist({ timeout: 10000 });
    await targetNode.click();

    await browser.keys(["Meta", "Backspace"]);

    const modal = await $(".modal-backdrop");
    await modal.waitForExist({ timeout: 5000 });
    expect(await $(".modal").getText()).toContain("e2e-shortcut-new-file.txt");

    // The entry must still exist — the chord opened the confirmation, it
    // didn't delete anything on its own.
    await expect(targetNode).toExist();

    // Confirming removes it, cleaning up the file this spec created.
    const confirmButton = await $(".modal .danger");
    await confirmButton.click();
    await modal.waitForExist({ timeout: 5000, reverse: true });
    await targetNode.waitForExist({ timeout: 5000, reverse: true });
  });
});

// The four split-direction shortcuts (§ Gap 1b) are native `main.rs`
// accelerators, reached the same way the existing Cmd+Shift+F/Cmd+P/Cmd+S
// accelerator tests already reach theirs in `smoke.e2e.js`: send the raw
// key combo via `browser.keys()` and let the native menu event drive the
// frontend, rather than clicking the per-pane split button/dropdown.
describe("split-direction keyboard shortcuts (issue #156)", () => {
  it("⌥⌘→ splits the last-focused terminal pane", async () => {
    let terminal = await $(".xterm-screen");
    if (!(await terminal.isExisting())) {
      const newTerminalButton = await $(".new-tab");
      await newTerminalButton.click();
      terminal = await $(".xterm-screen");
      await terminal.waitForExist({ timeout: 5000 });
    }
    await terminal.click();

    await browser.keys(["Alt", "Meta", "ArrowRight"]);

    await browser.waitUntil(async () => (await $$(".xterm-screen")).length === 2, {
      timeout: 5000,
      timeoutMsg: "expected a second terminal pane after ⌥⌘→",
    });
  });

  it("⌥⌘↓ splits the last-focused editor pane", async () => {
    const fileNode = await $(`//span[${hasClass("name")} and text()='note.md']`);
    await fileNode.waitForExist({ timeout: 5000 });
    await fileNode.click();

    const editor = await $(".cm-content");
    await editor.waitForExist({ timeout: 5000 });
    await editor.click();

    await browser.keys(["Alt", "Meta", "ArrowDown"]);

    await browser.waitUntil(async () => (await $$(".editor-panel")).length === 2, {
      timeout: 5000,
      timeoutMsg: "expected a second editor pane after ⌥⌘↓",
    });
  });
});
