import { expect } from "@wdio/globals";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openWorkspace } from "../helpers/workspace.js";
import { hasClass } from "../helpers/selectors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "../fixtures");

describe("rendered markdown: scroll then click resolves against the rendered viewport (issues #183 and #367)", () => {
  it("preserves scroll position and places the cursor on the clicked heading", async () => {
    await openWorkspace(fixturesDir);

    const fileNode = await $(`//span[${hasClass("name")} and text()='long.md']`);
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

    // Pick a heading that is already visible and click its coordinates via a
    // raw pointer action rather than `element.click()`, which would
    // auto-scroll its target into view before the click ever lands.
    const clickPoint = await browser.execute((el) => {
      const pane = el.getBoundingClientRect();
      const heading = [...el.querySelectorAll(".cm-heading-2")].find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.top >= pane.top + 10 && rect.bottom <= pane.bottom - 10;
      });
      if (!heading) return null;
      const rect = heading.getBoundingClientRect();
      const match = heading.textContent?.match(/Section (\d+)/);
      return match ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), section: Number(match[1]) } : null;
    }, scroller);
    expect(clickPoint).not.toBeNull();

    await browser.action("pointer").move({ x: clickPoint.x, y: clickPoint.y, origin: "viewport" }).down().up().perform();

    // The cursor must resolve to the source line represented by the rendered
    // heading, rather than the line that occupied those coordinates before
    // the pane scrolled. Each fixture section occupies four source lines.
    const expectedLine = (clickPoint.section - 1) * 4 + 1;
    const cursor = await $(".status-group.indicators .status-item.mono");
    await browser.waitUntil(
      async () => (await cursor.getText()).startsWith(`Ln ${expectedLine},`),
      { timeout: 3000, timeoutMsg: `expected the clicked heading to resolve to source line ${expectedLine}` },
    );

    // The regression also reproduces as `scrollTop` collapsing back toward 0
    // when the first click focuses the pane. Assert that the pane stays close
    // to where it was scrolled to, not merely somewhere past the top.
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
