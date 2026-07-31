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

describe("rendered markdown: horizontal rule cursor placement (issue #366)", () => {
  it("places the cursor on the clicked line below a horizontal rule", async () => {
    await openWorkspace(fixturesDir);

    const fileNode = await $("//span[@class='name' and text()='horizontal-rule.md']");
    await fileNode.waitForExist({ timeout: 10000 });
    await fileNode.click();

    const rule = await $(".cm-hr");
    await rule.waitForExist({ timeout: 5000 });

    const lineAfterRule = await $("//div[contains(@class, 'cm-line') and contains(., 'After the rule')]");
    await lineAfterRule.waitForExist({ timeout: 5000 });
    await lineAfterRule.click();

    const cursorPosition = await $(".status-bar .status-item.mono:not(.path)");
    await browser.waitUntil(
      async () => (await cursorPosition.getText()).startsWith("Ln 5"),
      {
        timeout: 3000,
        timeoutMsg: `expected the clicked line to place the cursor on source line 5, got ${await cursorPosition.getText()}`,
      },
    );
    await expect(cursorPosition).toHaveText(expect.stringContaining("Ln 5"));
  });
});
