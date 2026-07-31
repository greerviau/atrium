import { expect } from "@wdio/globals";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "../fixtures");

async function openWorkspace(root) {
  await browser.execute((workspacePath) => {
    return window.__TAURI_INTERNALS__.invoke("workspace_set_root", {
      workspaceId: "local",
      path: workspacePath,
    });
  }, root);
  await browser.refresh();
  const recentRow = await $(`//span[@class='recent-path' and text()='${root}']`);
  await recentRow.waitForExist({ timeout: 10000 });
  await recentRow.click();
}

describe("issue #359 reproduction", () => {
  it("can move focus to the terminal after placing the cursor at line end", async () => {
    await openWorkspace(fixturesDir);
    const fileNode = await $("//span[@class='name' and text()='wrapped.md']");
    await fileNode.waitForExist({ timeout: 10000 });
    await fileNode.click();

    const editor = await $(".cm-content");
    await editor.waitForExist({ timeout: 5000 });
    await editor.click();
    await browser.keys(["End"]);

    const before = await browser.execute(() => ({
      editorActive: document.activeElement?.classList.contains("cm-content") ?? false,
    }));
    expect(before.editorActive).toBe(true);

    const terminal = await $(".xterm-screen");
    await terminal.waitForExist({ timeout: 5000 });
    await terminal.click();
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
