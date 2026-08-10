import { expect } from "@wdio/globals";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openWorkspace } from "../helpers/workspace.js";
import { hasClass } from "../helpers/selectors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "../fixtures");

describe("issue #359 reproduction", () => {
  it("keeps terminal focus after the caret reaches a visual wrap boundary", async () => {
    await openWorkspace(fixturesDir);
    const fileNode = await $(`//span[${hasClass("name")} and text()='wrapped.md']`);
    await fileNode.waitForExist({ timeout: 10000 });
    await fileNode.click();

    const editor = await $(".cm-content");
    await editor.waitForExist({ timeout: 5000 });
    const heading = await $(".cm-heading-1");
    await heading.click();
    await browser.keys(["End"]);

    const before = await browser.execute(() => ({
      editorActive: document.activeElement?.classList.contains("cm-content") ?? false,
      lineWrapping: document.querySelector(".cm-content")?.classList.contains("cm-lineWrapping") ?? false,
      rendered: document.querySelector(".cm-heading-1")?.textContent ?? null,
    }));
    expect(before.editorActive).toBe(true);
    expect(before.lineWrapping).toBe(true);
    expect(before.rendered).toContain("# ");

    const terminal = await $(".xterm-screen");
    await terminal.waitForExist({ timeout: 5000 });
    await terminal.click();
    await browser.pause(250);

    const after = await browser.execute(() => ({
      editorActive: document.activeElement?.classList.contains("cm-content") ?? false,
      terminalActive: document.activeElement?.closest(".terminal-pane") !== null,
      rendered: document.querySelector(".cm-heading-1")?.textContent ?? null,
    }));
    expect(after.editorActive).toBe(false);
    expect(after.terminalActive).toBe(true);
    expect(after.rendered).not.toContain("# ");
  });
});
