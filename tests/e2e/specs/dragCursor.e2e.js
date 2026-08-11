import { expect } from "@wdio/globals";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openWorkspace } from "../helpers/workspace.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "../fixtures");

async function openFile(name) {
  const filePath = path.join(fixturesDir, name);
  const row = await $(`.row[data-path="${filePath}"]`);
  await row.waitForExist({ timeout: 10000 });
  await row.click();
  return filePath;
}

async function centerOf(selector) {
  const el = await $(selector);
  const rect = await browser.execute((element) => {
    const r = element.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, el);
  return { el, ...rect };
}

/**
 * A point a few pixels in from a cell's own left/right edge, vertically
 * centered — not the cell's own visual center. A `<td>`'s bounding box
 * includes its padding, so a drag-select anchored at the geometric center
 * can land past the end of short, left-aligned text (e.g. "launched")
 * instead of on it, silently truncating the selection this test exists to
 * check.
 */
async function edgeOf(selector, side) {
  const el = await $(selector);
  const rect = await browser.execute(
    (element, fromRight) => {
      const r = element.getBoundingClientRect();
      const x = fromRight ? r.right - 4 : r.left + 4;
      return { x: Math.round(x), y: Math.round(r.top + r.height / 2) };
    },
    el,
    side === "right",
  );
  return { el, ...rect };
}

/**
 * Like `edgeOf`, but anchored to the element's *rendered inline content*
 * (via `Range.getClientRects()`), not its own box. A block-level element
 * like `.cm-line` fills its container's width regardless of how short the
 * line's own text is — `edgeOf` alone can land hundreds of pixels into
 * empty space past the last glyph, which CodeMirror's own `posAtCoords`
 * doesn't reliably map back onto the line's real content.
 */
async function textEdgeOf(selector, side) {
  const el = await $(selector);
  const rect = await browser.execute(
    (element, fromRight) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const rects = Array.from(range.getClientRects());
      const left = Math.min(...rects.map((r) => r.left));
      const right = Math.max(...rects.map((r) => r.right));
      const top = Math.min(...rects.map((r) => r.top));
      const bottom = Math.max(...rects.map((r) => r.bottom));
      const x = fromRight ? right - 2 : left + 2;
      return { x: Math.round(x), y: Math.round((top + bottom) / 2) };
    },
    el,
    side === "right",
  );
  return { el, ...rect };
}

/**
 * A mouse drag-select from `from` to `to`, as several small explicit steps
 * rather than one `move({ ..., duration })` call. CodeMirror implements its
 * own drag-to-extend-selection logic against real `mousemove` events rather
 * than relying purely on the browser's native text-selection default, and
 * this WebDriver/WebKit combination does not synthesize intermediate
 * `mousemove` events for a single duration-interpolated `move` the way real
 * hardware input does — confirmed by observing a collapsed, zero-length
 * selection from a single-step move landing squarely on real rendered text,
 * and a correct, non-empty selection from the same two points split into
 * several steps. Plain, non-editable regions (a `<td>`, tested via `edgeOf`
 * elsewhere in this file) don't need this: native browser text selection
 * there extends correctly from a single interpolated move.
 */
async function dragSelect(from, to, steps = 8, id = "drag") {
  let chain = browser.action("pointer", { id }).move({ x: from.x, y: from.y, origin: "viewport" }).down();
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
    chain = chain.move({ x, y, origin: "viewport", duration: 20 });
  }
  await chain.up().perform();
}

// Samples `window.getSelection().toString()` and the cursor at `(x, y)`
// repeatedly over `durationMs`, rather than only before/after — a selection
// or cursor change that appears and reverts within the hold would be
// invisible to a single before/after check, the same reasoning
// `explorerDragScroll.e2e.js` already applies to `scrollLeft`. Always takes
// at least one sample regardless of how `durationMs`/timing interact, so a
// caller's `samples.every(...)` can never pass vacuously on an empty array.
async function sampleSelectionAndCursorDuring(durationMs, x, y) {
  const samples = [];
  const until = Date.now() + durationMs;
  do {
    const sample = await browser.execute(
      (px, py) => ({
        selection: window.getSelection().toString(),
        cursor: getComputedStyle(document.elementFromPoint(px, py)).cursor,
      }),
      x,
      y,
    );
    samples.push(sample);
    await browser.pause(50);
  } while (Date.now() < until);
  return samples;
}

// WebDriver's Execute Script clones its return value through the internal
// JSON clone algorithm, which maps a `undefined` result to `null` — so
// `expect(await browser.execute(() => el.dataset.foo)).toBeUndefined()` can
// never hold even when the attribute is genuinely absent. Checking
// `hasAttribute` in-browser and returning a plain boolean sidesteps the
// serialization entirely.
async function dragCursorAttributeIsSet() {
  return browser.execute(() => document.documentElement.hasAttribute("data-drag-cursor"));
}

describe("drag cursor and text selection (issue #420)", () => {
  it("shows a grabbing cursor and selects no text while dragging a file row over the editor", async () => {
    await openWorkspace(fixturesDir);
    await openFile("long.md");

    const source = await centerOf(`.row[data-path="${path.join(fixturesDir, "long.md")}"]`);
    // `.cm-content` itself is sized to the *whole document* (320 lines), not
    // the visible viewport, so its own center sits far below the window and
    // WebDriver rejects it as "move target out of bounds". `.cm-line` picks
    // the first rendered line instead — guaranteed on-screen, and still
    // squarely inside `.cm-content` for the selection/cursor checks below.
    const editor = await centerOf(".cm-line");

    await browser
      .action("pointer", { id: "drag" })
      .move({ x: source.x, y: source.y, origin: "viewport" })
      .down()
      .move({ x: editor.x, y: editor.y, origin: "viewport", duration: 200 })
      .perform(true);

    const samples = await sampleSelectionAndCursorDuring(400, editor.x, editor.y);
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((s) => s.selection === "")).toBe(true);
    expect(samples.every((s) => s.cursor === "grabbing")).toBe(true);

    // Release back over the dragged row's own coordinates — a guaranteed-
    // inert drop: a file row hit-tests to its own parent directory, which
    // `isValidMoveTarget` (explorerDrag.ts) always rejects.
    await browser
      .action("pointer", { id: "drag" })
      .move({ x: source.x, y: source.y, origin: "viewport", duration: 100 })
      .up()
      .perform();

    expect(await dragCursorAttributeIsSet()).toBe(false);

    // Ordinary mouse text selection works again after the drag — a real
    // drag-select over `.cm-line`'s own rendered text (`textEdgeOf` +
    // `dragSelect`, not a keyboard Home/Shift+End): this is the mechanism
    // the fix actually touches (the `selectstart` guard, torn down by
    // `endDragLock()`), so it's what a regression here should be caught by.
    //
    // Uses a fresh pointer id ("drag2") rather than reusing "drag" from the
    // gesture above. Measured directly: once `drawSelection()` is in play
    // (#435), reusing the same id back-to-back for two unrelated gestures
    // intermittently left this drag-select's own mousemove/mouseup events
    // never reaching CodeMirror's mouse-selection tracking at all — only its
    // mousedown did — producing a collapsed selection instead of a real one.
    // Neither an explicit `browser.releaseActions()` nor a fixed pause
    // between the two gestures fixed it reliably; a fresh id, which by
    // construction carries no state from the prior gesture, did (5/5 clean
    // runs against 0-3/5 for the other approaches tried).
    const lineStart = await textEdgeOf(".cm-line", "left");
    const lineEnd = await textEdgeOf(".cm-line", "right");
    await dragSelect(lineStart, lineEnd, 8, "drag2");
    const restoredSelection = await browser.execute(() => window.getSelection().toString());
    expect(restoredSelection.length).toBeGreaterThan(0);
  });

  it("shows a grabbing cursor and selects no text while dragging an editor tab across the app", async () => {
    await openWorkspace(fixturesDir);
    await openFile("long.md");
    await openFile("note.md");

    // `.tab` is rendered by both the editor and terminal tab strips; scoped
    // to `.editor-panel` even though `data-tab-path` is editor-only today.
    const tab = await centerOf(`.editor-panel .tab[data-tab-path="${path.join(fixturesDir, "long.md")}"]`);
    const statusBar = await centerOf(".status-bar");

    await browser
      .action("pointer", { id: "drag" })
      .move({ x: tab.x, y: tab.y, origin: "viewport" })
      .down()
      .move({ x: statusBar.x, y: statusBar.y, origin: "viewport", duration: 200 })
      .perform(true);

    const samples = await sampleSelectionAndCursorDuring(400, statusBar.x, statusBar.y);
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((s) => s.selection === "")).toBe(true);
    expect(samples.every((s) => s.cursor === "grabbing")).toBe(true);

    // Release back over the tab's own position — a no-op reorder.
    await browser
      .action("pointer", { id: "drag" })
      .move({ x: tab.x, y: tab.y, origin: "viewport", duration: 100 })
      .up()
      .perform();

    expect(await dragCursorAttributeIsSet()).toBe(false);
  });

  // Regression guard for the `selectstart` guard's coverage of a plain,
  // non-contenteditable region — the one place a naive "belt and braces"
  // second layer looked appealing and, on a real device, was actively
  // harmful instead. dragLock.ts's own doc comment records the finding this
  // test pins: an early version of the shared lock also wrote
  // `user-select: none` on `<html>` for exactly this kind of region, and
  // that write alone was found to *clear* a selection already held
  // elsewhere in the DOM on this app's WebKit target — confirmed against
  // this same CSV/Parquet result table, which declares no `user-select` of
  // its own and is not contenteditable. The write was removed; this test is
  // what proves the `selectstart` guard alone is sufficient here without it.
  //
  // Drags the explorer sidebar resizer, not a tab: any pointerdown on an
  // element outside the current selection ordinarily collapses that
  // selection anyway, as plain, unavoidable browser click-elsewhere
  // behavior, entirely independent of this fix — confirmed directly: a tab
  // drag (which never calls `preventDefault()` on `pointerdown`, by design,
  // for the focus-transition reasons `tabDrag.ts` documents) collapses an
  // unrelated selection the instant the button goes down, before the drag
  // lock engages at all. That is not a regression this fix could or should
  // prevent. A resizer's `startDragExplorer` does call
  // `event.preventDefault()` on `pointerdown` (App.svelte), which suppresses
  // that default click-elsewhere behavior — so a resizer drag is the
  // gesture that can actually isolate what this test exists to check: does
  // the drag *lock itself*, once engaged, harm an unrelated selection.
  it("survives a resizer drag started elsewhere without wiping a selection held in the CSV result table", async () => {
    await openWorkspace(fixturesDir);
    await openFile("launch-open.csv");

    const firstCellSelector = ".data-pane table tbody td:first-child";
    await (await $(firstCellSelector)).waitForExist({ timeout: 10000 });
    const firstCell = await edgeOf(firstCellSelector, "left");
    const lastCell = await edgeOf(".data-pane table tbody td:last-child", "right");
    await dragSelect(firstCell, lastCell);

    const selectionBeforeDrag = await browser.execute(() => window.getSelection().toString());
    expect(selectionBeforeDrag.length).toBeGreaterThan(0);

    const resizer = await centerOf(".explorer + .resizer");
    await browser
      .action("pointer", { id: "drag" })
      .move({ x: resizer.x, y: resizer.y, origin: "viewport" })
      .down()
      .move({ x: resizer.x + 60, y: resizer.y, origin: "viewport", duration: 200 })
      .up()
      .perform();

    const selectionAfterDrag = await browser.execute(() => window.getSelection().toString());
    expect(selectionAfterDrag).toBe(selectionBeforeDrag);
    expect(await dragCursorAttributeIsSet()).toBe(false);
  });
});
