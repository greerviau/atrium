import { expect } from "@wdio/globals";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openWorkspace } from "../helpers/workspace.js";
import { hasClass } from "../helpers/selectors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "../fixtures");

const CURSOR_READOUT = ".status-group.indicators .status-item.mono";

// How far the mid-settle click's resolved line may sit from where a click on
// the same point resolves once the pane has settled. Not zero: on this target
// the two differ by one line, reproducibly, because the deferred click is
// replayed at its original screen coordinates after the pane has shifted
// underneath them (issue #454). Two lines allows that without allowing the
// gross mis-resolution this spec is here to notice.
const MAX_LINE_DRIFT = 2;

// How many times to re-stage the gesture if the click misses the settle
// window. Missing it is a property of WebDriver's own latency, not of the app
// — a cold first session is slower than a warm one — so it is a setup
// precondition to retry, never something to assert around.
const MAX_ATTEMPTS = 4;

/**
 * Waits for the rendered-markdown pane to finish rendering and measuring the
 * content a scroll just brought into view.
 *
 * A fast wheel scroll lands the scroller on content CodeMirror has not
 * rendered yet, so for a window afterwards the pane is half-built: the newly
 * visible lines carry no live-preview decorations, `scrollHeight` still
 * reflects estimated rather than measured block heights, and `scrollTop` has
 * not taken the compensating adjustment CodeMirror applies when it swaps
 * those estimates for real ones. Measured on this target, that window closes
 * 270-420ms after the wheel, and the offset moves about 60px over it.
 *
 * Reading anything from the pane before this returns reads a half-built
 * layout. That is what made this spec intermittently red for a long time: its
 * previous gate waited only for `scrollTop` to change, which is already true
 * the instant the wheel returns.
 */
async function waitForPaneToSettle(scroller) {
  await browser.execute(() => {
    delete window.__paneSettleSample;
  });
  await browser.waitUntil(
    async () =>
      await browser.execute((el) => {
        const now = { top: Math.round(el.scrollTop), height: el.scrollHeight };
        const previous = window.__paneSettleSample;
        const stable = previous && previous.top === now.top && previous.height === now.height ? previous.stable + 1 : 0;
        window.__paneSettleSample = { ...now, stable };
        return stable >= 2;
      }, scroller),
    { timeout: 10000, timeoutMsg: "expected the scrolled-to content to finish rendering and measuring" },
  );
}

// Captures the pane's rendering state when the click's `mousedown` fires, so
// the test can confirm the click really did land while the pane was still
// half-built rather than after it had settled.
async function recordStateAtMousedown(scroller) {
  await browser.execute((el) => {
    window.__stateAtMousedown = null;
    document.addEventListener(
      "mousedown",
      () => {
        if (window.__stateAtMousedown === null) {
          window.__stateAtMousedown = {
            scrollTop: Math.round(el.scrollTop),
            scrollHeight: el.scrollHeight,
            headings: el.querySelectorAll(".cm-heading-2").length,
          };
        }
      },
      { capture: true },
    );
  }, scroller);
}

async function paneState(scroller) {
  return await browser.execute(
    (el) => ({
      scrollTop: Math.round(el.scrollTop),
      scrollHeight: el.scrollHeight,
      headings: el.querySelectorAll(".cm-heading-2").length,
    }),
    scroller,
  );
}

async function cursorReadout() {
  return await browser.execute((selector) => document.querySelector(selector)?.textContent?.trim(), CURSOR_READOUT);
}

function lineOf(readout) {
  const match = /^Ln (\d+),/.exec(readout ?? "");
  return match ? Number(match[1]) : null;
}

/**
 * A click at the given point.
 *
 * `move`, `down` and `up` must stay in one `perform()`. Splitting the pointer
 * move into its own `perform()` from the button press permanently drops
 * `document.hasFocus()` in this WebDriver/WebKit combination — it stays false
 * for the rest of the session and survives `browser.refresh()`. Nothing
 * registers after that: CodeMirror gates `view.hasFocus` on
 * `document.hasFocus()`, so the pane can never take focus, and every click is
 * silently swallowed while the cursor readout sits at its initial value. A
 * spec that splits them looks like it is clicking and is not.
 */
async function clickAt(point) {
  await browser
    .action("pointer")
    .move({ x: point.x, y: point.y, origin: "viewport" })
    .down({ button: 0 })
    .up({ button: 0 })
    .perform();
  await browser.releaseActions();
}

/**
 * Opens `long.md` fresh, scrolls it, and clicks mid-settle — retrying the
 * whole thing from a new pane if the click misses the window, so the caller
 * always gets a gesture that actually exercised the condition.
 */
async function scrollAndClickMidSettle() {
  let last;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await openWorkspace(fixturesDir);

    const fileNode = await $(`//span[${hasClass("name")} and text()='long.md']`);
    await fileNode.waitForExist({ timeout: 10000 });
    await fileNode.click();
    await (await $(".cm-heading-2")).waitForExist({ timeout: 5000 });

    const scroller = await $(".cm-scroller");
    // Offset from the exact centre, which sits on a line-wrap boundary where
    // the resolved column flips between end-of-line and start-of-next for
    // reasons that have nothing to do with what this spec measures.
    const point = await browser.execute((el) => {
      const rect = el.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) + 20 };
    }, scroller);

    const initialReadout = await cursorReadout();
    await recordStateAtMousedown(scroller);

    // `duration: 0` so `perform()` returns immediately instead of spending the
    // settle window before the click can even be sent. With the wheel spread
    // over 200ms the click arrived at 336-381ms, past a window closing around
    // 350ms; delivered instantly it arrives at 120-210ms.
    await browser.action("wheel").scroll({ x: point.x, y: point.y, deltaX: 0, deltaY: 4000, duration: 0 }).perform();

    // Deliberately no wait. The click has to land on a pane that is still
    // rendering the content it just scrolled to, and that has never been
    // clicked into — together, the condition issues #183 and #367 are about.
    await clickAt(point);
    await waitForPaneToSettle(scroller);

    const atMousedown = await browser.execute(() => window.__stateAtMousedown);
    const settledState = await paneState(scroller);
    const midSettleReadout = await cursorReadout();

    // The click must have landed inside the window, or this attempt tested
    // nothing. The scroll has to have been applied already (`duration: 0`
    // lets `perform()` return before the compositor moves the scroller) and
    // the pane has to have still been half-built.
    const landedMidSettle =
      atMousedown !== null &&
      atMousedown.scrollTop > 1000 &&
      (atMousedown.scrollTop !== settledState.scrollTop ||
        atMousedown.scrollHeight !== settledState.scrollHeight ||
        atMousedown.headings !== settledState.headings);

    last = { scroller, point, initialReadout, atMousedown, settledState, midSettleReadout, landedMidSettle, attempt };
    if (landedMidSettle) return last;
  }
  return last;
}

describe("rendered markdown: scroll then click resolves against the rendered viewport (the condition issues #183 and #367 are about)", () => {
  it("resolves a click made while the pane is still settling, and holds the scroll position", async () => {
    const { scroller, point, initialReadout, atMousedown, settledState, midSettleReadout, landedMidSettle } =
      await scrollAndClickMidSettle();

    expect(
      landedMidSettle
        ? "landed mid-settle"
        : `click never landed inside the settle window in ${MAX_ATTEMPTS} attempts: at mousedown ${JSON.stringify(atMousedown)}, settled ${JSON.stringify(settledState)}`,
    ).toBe("landed mid-settle");

    // The click has to have actually registered. Without this the readouts
    // compared below can both be the untouched initial value, and every
    // comparison between them passes vacuously.
    expect(
      midSettleReadout !== initialReadout
        ? "click registered"
        : `click did not move the cursor off its initial position ${initialReadout}`,
    ).toBe("click registered");

    // `scrollTop` collapsing back toward 0 as the first click focuses the pane
    // is issue #183's own symptom. The pane's settle correction moves the
    // offset by well under 100px, so a collapse from ~4000 is unambiguous.
    const scrollDrift = Math.abs(settledState.scrollTop - atMousedown.scrollTop);
    expect(
      settledState.scrollTop > 1000 && scrollDrift < 200
        ? "scroll held"
        : `scrollTop moved from ${atMousedown.scrollTop} to ${settledState.scrollTop}, resetting toward the top`,
    ).toBe("scroll held");

    // Where a click on this same point lands once everything has settled.
    // Neither guard applies to it — focused pane, no recent scroll — so it is
    // the position the rendered viewport actually maps these coordinates to.
    // 700ms comfortably clears baseExtensions.ts's own RECENT_SCROLL_WINDOW_MS
    // (120ms), well past the pane settling itself.
    await browser.pause(700);
    await clickAt(point);
    await waitForPaneToSettle(scroller);
    const settledReadout = await cursorReadout();

    const midSettleLine = lineOf(midSettleReadout);
    const settledLine = lineOf(settledReadout);
    expect(
      midSettleLine !== null && settledLine !== null
        ? "both readouts parsed"
        : `could not parse a line number from ${midSettleReadout} / ${settledReadout}`,
    ).toBe("both readouts parsed");
    expect(
      Math.abs(midSettleLine - settledLine) <= MAX_LINE_DRIFT
        ? "resolved near the settled position"
        : `mid-settle click resolved to ${midSettleReadout}, ${Math.abs(midSettleLine - settledLine)} lines from the settled ${settledReadout}`,
    ).toBe("resolved near the settled position");
  });
});
