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
  it("does not snap back to the top when clicking shortly after scrolling a freshly opened pane", async () => {
    await openWorkspace(fixturesDir);

    const fileNode = await $("//span[@class='name' and text()='long.md']");
    await fileNode.waitForExist({ timeout: 10000 });
    await fileNode.click();

    const heading = await $(".cm-heading-2");
    await heading.waitForExist({ timeout: 5000 });

    const scroller = await $(".cm-scroller");

    // Scroll well past the fold and fire a real `wheel` event so the app's
    // own scroll-settle tracking (`wheelTracker` in `baseExtensions.ts`)
    // registers it, matching the reporter's steps: open the file, scroll,
    // click — on a pane that has never yet been clicked into, the same
    // once-per-freshly-opened-file condition issue #161 described.
    await browser.execute((el) => {
      el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 4000 }));
      el.scrollTop = 4000;
    }, scroller);

    const scrolledTo = await browser.execute((el) => el.scrollTop, scroller);
    expect(scrolledTo).toBeGreaterThan(1000);

    // Click at a fixed viewport point inside the now-scrolled content,
    // immediately after the wheel event, via a raw pointer action rather
    // than `element.click()` — the latter auto-scrolls its target into view
    // first, which would undo the scroll set up above before the click ever
    // lands.
    const point = await browser.execute((el) => {
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, scroller);

    await browser
      .action("pointer")
      .move({ x: Math.round(point.x), y: Math.round(point.y), origin: "viewport" })
      .down()
      .up()
      .perform();

    // The regression reproduces as `scrollTop` collapsing back toward 0 (the
    // off-screen, document-start caret scrolling into view on focus) —
    // assert the pane stays near where the click landed instead.
    await browser.waitUntil(
      async () => {
        const scrollTop = await browser.execute((el) => el.scrollTop, scroller);
        return scrollTop > 500;
      },
      {
        timeout: 3000,
        timeoutMsg: "expected the pane's scroll position to be preserved after clicking, not reset to the top",
      },
    );
  });
});
