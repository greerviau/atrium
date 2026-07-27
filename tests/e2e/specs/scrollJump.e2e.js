import { expect } from "@wdio/globals";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "../fixtures");

// A backward jump of a pixel or two is within normal sub-pixel rounding
// noise; anything larger is the user-visible "scrolls back up" regression
// from issue #311.
const BACKWARD_JITTER_TOLERANCE_PX = 2;

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

describe("rendered markdown: scrolling down does not jump back up (issue #311)", () => {
  it("keeps scrollTop monotonic while scrolling continuously through a large, media-heavy file", async () => {
    await openWorkspace(fixturesDir);

    const fileNode = await $("//span[@class='name' and text()='scrollJump.md']");
    await fileNode.waitForExist({ timeout: 10000 });
    await fileNode.click();

    const heading = await $(".cm-heading-2");
    await heading.waitForExist({ timeout: 5000 });

    const scroller = await $(".cm-scroller");
    const point = await browser.execute((el) => {
      const rect = el.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    }, scroller);

    // Sample scrollTop on every animation frame for the duration of the
    // gesture, the same way a real compositor-timed regression would be
    // observed, rather than only checking before/after snapshots.
    await browser.execute((el) => {
      window.__scrollJumpSamples = [];
      window.__scrollJumpSampling = true;
      const sample = () => {
        if (!window.__scrollJumpSampling) return;
        window.__scrollJumpSamples.push(el.scrollTop);
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, scroller);

    // Scroll down in a continuous run of real wheel actions (not a single
    // synthetic `scrollTop` assignment) with no deliberate idle gaps between
    // steps, so background parsing and async image/Mermaid rendering have
    // to keep up with a run of scroll input rather than draining between
    // evenly-spaced ticks. This is a complement to, not a replacement for,
    // a manual trackpad-driven pass on real hardware (see the plan's Phase
    // 1, step 3) — a scripted action still can't fully reproduce a human's
    // uneven input timing.
    //
    // The loop stops on the earlier of "reached the bottom" or "stopped
    // making forward progress for a while" rather than a bare step count:
    // async image/Mermaid rendering can grow `scrollHeight` mid-gesture, so
    // a fixed step budget sized for the fixture's static height can run out
    // before the (moving) bottom is actually reached.
    const maxSteps = 600;
    const stallLimit = 15;
    let atBottom = false;
    let lastScrollTop = -1;
    let stalledSteps = 0;
    for (let i = 0; i < maxSteps && !atBottom; i++) {
      await browser
        .action("wheel")
        .scroll({ x: point.x, y: point.y, deltaX: 0, deltaY: 600, duration: 50 })
        .perform();

      const state = await browser.execute((el) => {
        return { scrollTop: el.scrollTop, atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 2 };
      }, scroller);
      atBottom = state.atBottom;

      if (state.scrollTop <= lastScrollTop + 0.5) {
        stalledSteps++;
        if (stalledSteps >= stallLimit) break;
      } else {
        stalledSteps = 0;
      }
      lastScrollTop = state.scrollTop;
    }

    // Let any in-flight decoration rebuild / async image or Mermaid render
    // that was still catching up at the bottom of the scroll settle before
    // sampling stops.
    await browser.pause(500);

    const samples = await browser.execute(() => {
      window.__scrollJumpSampling = false;
      return window.__scrollJumpSamples;
    });

    expect(samples.length).toBeGreaterThan(10);
    expect(atBottom, `expected the scroll gesture to reach the bottom of the fixture within ${maxSteps} steps`).toBe(
      true,
    );

    let maxSoFar = samples[0];
    let worstBackwardJump = 0;
    let worstAtIndex = 0;
    let worstAtValue = samples[0];
    for (let i = 1; i < samples.length; i++) {
      const backward = maxSoFar - samples[i];
      if (backward > worstBackwardJump) {
        worstBackwardJump = backward;
        worstAtIndex = i;
        worstAtValue = samples[i];
      }
      maxSoFar = Math.max(maxSoFar, samples[i]);
    }

    expect(
      worstBackwardJump,
      `expected scrollTop to be monotonic (within ${BACKWARD_JITTER_TOLERANCE_PX}px jitter) while scrolling down, ` +
        `but it jumped backward by ${worstBackwardJump}px at sample ${worstAtIndex} of ${samples.length} ` +
        `(scrollTop went from a high of ${maxSoFar}px down to ${worstAtValue}px)`,
    ).toBeLessThanOrEqual(BACKWARD_JITTER_TOLERANCE_PX);
  });
});
