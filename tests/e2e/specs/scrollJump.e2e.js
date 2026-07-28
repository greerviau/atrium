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

// `expect(actual, message)`'s two-argument form is a Vitest idiom, not
// WebdriverIO's: `@wdio/globals`' `expect` forwards straight to
// `expect-webdriverio` (wrapping Jest's `expect`), which throws "Expect
// takes at most one argument" before ever reaching a matcher — unconditionally,
// even when the assertion would have passed. A plain thrown `Error` is what
// the rest of this suite's own custom messages use instead (`waitUntil`'s
// `timeoutMsg`, e.g. `scrollThenClick.e2e.js`), so a diagnostic failure here
// does the same: check first, throw with the full context if it fails.
function assertOrThrow(condition, message) {
  if (!condition) throw new Error(message);
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

    try {
      // Scroll down in a continuous run of real wheel actions (not a single
      // synthetic `scrollTop` assignment). Each batch chains several scroll
      // ticks into one W3C Actions call (`.scroll().scroll()...perform()`)
      // rather than one `perform()` round trip per tick, so consecutive
      // ticks stay back-to-back instead of picking up idle time from the
      // Node<->driver round trip between them — closer to a continuous
      // gesture than a scripted, evenly-paced single-tick loop would be
      // (this repo's own investigation into #311 found that gap let async
      // work drain between ticks that a real, uneven scroll wouldn't). A
      // scripted action still can't fully reproduce a human's own uneven
      // input timing, so a manual trackpad-driven pass on real hardware
      // remains a useful complement to this spec, not a replacement for it.
      //
      // The loop stops on the earlier of "reached the bottom" or "stopped
      // making forward progress for a while" rather than a bare step count:
      // async image (`ImageWidget`) and Mermaid (`MermaidWidget`) rendering
      // can grow `scrollHeight` mid-gesture, so a fixed step budget sized
      // for the fixture's static height can run out before the (moving)
      // bottom is actually reached.
      const stepsPerBatch = 5;
      const maxBatches = 120; // 600 total ticks
      const stallLimit = 15;
      let atBottom = false;
      let lastScrollTop = -1;
      let stalledTicks = 0;
      for (let batch = 0; batch < maxBatches && !atBottom; batch++) {
        let action = browser.action("wheel");
        for (let tick = 0; tick < stepsPerBatch; tick++) {
          action = action.scroll({ x: point.x, y: point.y, deltaX: 0, deltaY: 600, duration: 50 });
        }
        await action.perform();

        const state = await browser.execute((el) => {
          return { scrollTop: el.scrollTop, atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 2 };
        }, scroller);
        atBottom = state.atBottom;

        if (state.scrollTop <= lastScrollTop + 0.5) {
          stalledTicks += stepsPerBatch;
          if (stalledTicks >= stallLimit) break;
        } else {
          stalledTicks = 0;
        }
        lastScrollTop = state.scrollTop;
      }

      // Let any in-flight decoration rebuild / async image or Mermaid render
      // that was still catching up at the bottom of the scroll settle before
      // sampling stops.
      await browser.pause(500);

      const samples = await browser.execute(() => window.__scrollJumpSamples);

      assertOrThrow(
        samples.length > 10,
        `expected more than 10 scrollTop samples, got ${samples.length} — the per-frame sampler may not have started`,
      );

      // Checked before `atBottom` below: a strong manifestation of #311
      // stalls the gesture entirely (the pane stops making forward
      // progress once its own scroll compensation starts fighting the
      // wheel input), which would otherwise fail on "didn't reach the
      // bottom" and never surface the backward-jump numbers that actually
      // diagnose the bug.
      let maxSoFar = samples[0];
      let maxAtWorstJump = samples[0];
      let worstBackwardJump = 0;
      let worstAtIndex = 0;
      let worstAtValue = samples[0];
      for (let i = 1; i < samples.length; i++) {
        const backward = maxSoFar - samples[i];
        if (backward > worstBackwardJump) {
          worstBackwardJump = backward;
          worstAtIndex = i;
          worstAtValue = samples[i];
          maxAtWorstJump = maxSoFar;
        }
        maxSoFar = Math.max(maxSoFar, samples[i]);
      }

      assertOrThrow(
        worstBackwardJump <= BACKWARD_JITTER_TOLERANCE_PX,
        `expected scrollTop to be monotonic (within ${BACKWARD_JITTER_TOLERANCE_PX}px jitter) while scrolling down, ` +
          `but it jumped backward by ${worstBackwardJump}px at sample ${worstAtIndex} of ${samples.length} ` +
          `(scrollTop went from a high of ${maxAtWorstJump}px down to ${worstAtValue}px)`,
      );

      assertOrThrow(atBottom, `expected the scroll gesture to reach the bottom of the fixture within ${maxBatches * stepsPerBatch} ticks`);
    } finally {
      // Stops the rAF sampling loop even if an assertion above threw, so a
      // failed run doesn't leave it running for the rest of the session.
      await browser.execute(() => {
        window.__scrollJumpSampling = false;
      });
    }
  });
});
