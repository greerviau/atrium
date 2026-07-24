import { expect } from "@wdio/globals";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "../fixtures");

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

describe("rendered markdown: scroll then click preserves scroll position (issue #183)", () => {
  it("does not snap back to the top when clicking a freshly opened, scrolled pane", async () => {
    await openWorkspace(fixturesDir);

    const fileNode = await $("//span[@class='name' and text()='long.md']");
    await fileNode.waitForExist({ timeout: 10000 });
    await fileNode.click();

    const heading = await $(".cm-heading-2");
    await heading.waitForExist({ timeout: 5000 });

    const scroller = await $(".cm-scroller");
    const point = await browser.execute((el) => {
      const rect = el.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    }, scroller);

    // A real native wheel scroll, matching the reporter's own steps, on a
    // pane that has never yet been clicked into — the same
    // once-per-freshly-opened-file condition issue #161 described.
    await browser
      .action("wheel")
      .scroll({ x: point.x, y: point.y, deltaX: 0, deltaY: 4000, duration: 200 })
      .perform();

    let scrolledTo;
    await browser.waitUntil(
      async () => {
        scrolledTo = await browser.execute((el) => el.scrollTop, scroller);
        return scrolledTo > 1000;
      },
      { timeout: 5000, timeoutMsg: "expected the wheel scroll to move the pane down before clicking" },
    );

    // Click at that same viewport point via a raw pointer action rather than
    // `element.click()`, which would auto-scroll its target into view first
    // and undo the scroll set up above before the click ever lands.
    await browser.action("pointer").move({ x: point.x, y: point.y, origin: "viewport" }).down().up().perform();

    // The regression reproduces as `scrollTop` collapsing back toward 0 (the
    // off-screen, document-start caret scrolling into view on focus) —
    // assert the pane stays close to where it was scrolled to, not merely
    // "somewhere past the top".
    await browser.waitUntil(
      async () => {
        const scrollTop = await browser.execute((el) => el.scrollTop, scroller);
        return Math.abs(scrollTop - scrolledTo) < 50;
      },
      {
        timeout: 3000,
        timeoutMsg: `expected scrollTop to stay within 50px of ${scrolledTo} after clicking, not reset toward the top`,
      },
    );
  });
});
