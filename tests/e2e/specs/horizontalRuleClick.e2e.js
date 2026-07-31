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

describe("rendered markdown horizontal rules", () => {
  it("maps clicks after a rendered rule to the line under the pointer (issue #366)", async () => {
    await openWorkspace(fixturesDir);

    const fileNode = await $("//span[@class='name' and text()='horizontalRule.md']");
    await fileNode.waitForExist({ timeout: 10000 });
    await fileNode.click();

    const target = await $("//div[contains(@class, 'cm-line') and normalize-space(.)='text under']");
    await target.waitForExist({ timeout: 5000 });
    const rect = await target.getRect();

    // Click the rendered line with a real pointer coordinate. Calling
    // element.click() can scroll the target before the event lands and would
    // hide the coordinate-mapping failure this reproduces.
    await browser.action("pointer").move({ x: rect.x + 20, y: rect.y + rect.height / 2, origin: "viewport" }).down().up().perform();

    const cursor = await $(".status-item.mono");
    await browser.waitUntil(async () => (await cursor.getText()).startsWith("Ln 2, Col "), {
      timeout: 3000,
      timeoutMsg: "expected a click on the text below the horizontal rule to place the cursor on line 2",
    });
    await expect(cursor).toHaveText(/^Ln 2, Col \d+$/);
  });
});
