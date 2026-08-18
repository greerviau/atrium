import { expect } from "@wdio/globals";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openWorkspace } from "../helpers/workspace.js";
import { hasClass } from "../helpers/selectors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "../fixtures");

function tabFor(filePath) {
  return $(`//div[${hasClass("tab")} and @data-tab-path='${filePath}']`);
}

describe("editor tab scroll position", () => {
  it("preserves each editor tab's scroll position when switching tabs", async () => {
    await openWorkspace(fixturesDir);

    const longFile = await $(`//span[${hasClass("name")} and text()='long.md']`);
    await longFile.waitForExist({ timeout: 10000 });
    await longFile.click();

    const scroller = await $(".cm-scroller");
    await scroller.waitForExist({ timeout: 5000 });
    await browser.waitUntil(
      async () => await browser.execute((el) => el.scrollHeight > el.clientHeight, scroller),
      { timeout: 5000, timeoutMsg: "expected long.md to have a scrollable editor" },
    );

    const scrollPoint = await browser.execute((el) => {
      const rect = el.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    }, scroller);
    await browser.action("wheel").scroll({ ...scrollPoint, deltaX: 0, deltaY: 2400, duration: 0 }).perform();
    await browser.waitUntil(
      async () => await browser.execute((el) => el.scrollTop > 400, scroller),
      { timeout: 5000, timeoutMsg: "expected the long.md editor to scroll" },
    );
    const scrolledPosition = await browser.execute((el) => el.scrollTop, scroller);

    const noteFile = await $(`//span[${hasClass("name")} and text()='note.md']`);
    await noteFile.click();
    const noteTab = await tabFor(path.join(fixturesDir, "note.md"));
    await browser.waitUntil(
      async () => await noteTab.getAttribute("class").then((value) => value?.split(/\s+/).includes("active")),
      { timeout: 5000, timeoutMsg: "expected note.md's editor tab to become active" },
    );

    const longTab = await tabFor(path.join(fixturesDir, "long.md"));
    await longTab.click();
    await browser.waitUntil(
      async () => await longTab.getAttribute("class").then((value) => value?.split(/\s+/).includes("active")),
      { timeout: 5000, timeoutMsg: "expected long.md's editor tab to become active again" },
    );
    await browser.waitUntil(
      async () => await browser.execute((el, expected) => el.scrollTop >= expected - 100, scroller, scrolledPosition),
      { timeout: 5000, timeoutMsg: "expected long.md to return to its previous scroll position" },
    );

    const restoredPosition = await browser.execute((el) => el.scrollTop, scroller);
    expect(restoredPosition).toBeGreaterThanOrEqual(scrolledPosition - 100);
  });
});
