import { expect } from "@wdio/globals";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openWorkspace } from "../helpers/workspace.js";
import { hasClass } from "../helpers/selectors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "../fixtures");

describe("rendered markdown: horizontal rule cursor placement (issue #366)", () => {
  it("places the cursor on the clicked line below a horizontal rule", async () => {
    await openWorkspace(fixturesDir);

    const fileNode = await $(`//span[${hasClass("name")} and text()='horizontal-rule.md']`);
    await fileNode.waitForExist({ timeout: 10000 });
    await fileNode.click();

    const rule = await $(".cm-hr");
    await rule.waitForExist({ timeout: 5000 });

    const lineAfterRule = await $(`//div[${hasClass("cm-line")} and contains(., 'After the rule')]`);
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

    await rule.click();
    await browser.waitUntil(async () => !(await $(".cm-hr").isExisting()), {
      timeout: 3000,
      timeoutMsg: "expected the horizontal rule to reveal its raw marker while editing",
    });
    const rawRule = await $(`//div[${hasClass("cm-line")} and normalize-space(.)='---']`);
    await expect(rawRule).toHaveText("---");
  });
});
