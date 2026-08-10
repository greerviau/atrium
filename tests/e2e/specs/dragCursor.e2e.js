import { expect } from "@wdio/globals";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "../fixtures");

// Mirrors `explorerDragScroll.e2e.js`'s own helper: the native folder picker
// is outside WebDriver's reach, so the workspace root is registered directly
// through the same `workspace_set_root` command the picker's callback would
// call. `contains(@class, ...)`, not `@class='recent-path'`, for the same
// scoped-class reason that spec documents.
async function openWorkspace(root) {
  await browser.execute((path) => {
    return window.__TAURI_INTERNALS__.invoke("workspace_set_root", {
      workspaceId: "local",
      path,
    });
  }, root);
  await browser.refresh();

  const recentRow = await $(`//span[contains(@class, 'recent-path') and text()='${root}']`);
  await recentRow.waitForExist({ timeout: 10000 });
  await recentRow.click();
}

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
 * Samples `window.getSelection().toString()` and the cursor at `(x, y)`
 * repeatedly over `durationMs`, rather than only before/after — a selection
 * or cursor change that appears and reverts within the hold would be
 * invisible to a single before/after check, the same reasoning
 * `explorerDragScroll.e2e.js` already applies to `scrollLeft`.
 */
async function sampleSelectionAndCursorDuring(durationMs, x, y) {
  const samples = [];
  const until = Date.now() + durationMs;
  while (Date.now() < until) {
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
  }
  return samples;
}

describe("drag cursor and text selection (issue #420)", () => {
  it("shows a grabbing cursor and selects no text while dragging a file row over the editor", async () => {
    await openWorkspace(fixturesDir);
    await openFile("long.md");

    const source = await centerOf(`.row[data-path="${path.join(fixturesDir, "long.md")}"]`);
    const editor = await centerOf(".cm-content");

    await browser
      .action("pointer", { id: "drag" })
      .move({ x: source.x, y: source.y, origin: "viewport" })
      .down()
      .move({ x: editor.x, y: editor.y, origin: "viewport", duration: 200 })
      .perform(true);

    const samples = await sampleSelectionAndCursorDuring(400, editor.x, editor.y);
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

    const cursorAttr = await browser.execute(() => document.documentElement.dataset.dragCursor);
    expect(cursorAttr).toBeUndefined();

    // Ordinary text selection works again after the drag.
    await (await $(".cm-content")).click();
    await browser.keys(["Home"]);
    await browser.keys(["Shift", "End"]);
    const restoredSelection = await browser.execute(() => window.getSelection().toString());
    expect(restoredSelection.length).toBeGreaterThan(0);
  });

  it("shows a grabbing cursor and selects no text while dragging an editor tab across the app", async () => {
    await openWorkspace(fixturesDir);
    await openFile("long.md");
    await openFile("note.md");

    const tab = await centerOf(`.tab[data-tab-path="${path.join(fixturesDir, "long.md")}"]`);
    const terminalToggle = await centerOf(".status-bar");

    await browser
      .action("pointer", { id: "drag" })
      .move({ x: tab.x, y: tab.y, origin: "viewport" })
      .down()
      .move({ x: terminalToggle.x, y: terminalToggle.y, origin: "viewport", duration: 200 })
      .perform(true);

    const samples = await sampleSelectionAndCursorDuring(400, terminalToggle.x, terminalToggle.y);
    expect(samples.every((s) => s.selection === "")).toBe(true);
    expect(samples.every((s) => s.cursor === "grabbing")).toBe(true);

    // Release back over the tab's own position — a no-op reorder.
    await browser
      .action("pointer", { id: "drag" })
      .move({ x: tab.x, y: tab.y, origin: "viewport", duration: 100 })
      .up()
      .perform();

    const cursorAttr = await browser.execute(() => document.documentElement.dataset.dragCursor);
    expect(cursorAttr).toBeUndefined();
  });

  // Regression guard for the `user-select` layer, not the `selectstart`
  // guard: selecting editor text and dragging a tab across it is worthless
  // here, and so is the same test against the rendered markdown preview —
  // both are the same `.cm-content` element, which the `-webkit-user-modify`
  // exemption (see dragLock.ts's own doc comment) makes immune to a
  // `user-select` write in the first place. This targets the CSV result
  // table instead, which declares no `user-select` of its own and is not
  // contenteditable — the one region in this app where the `user-select`
  // write is actually the layer doing the work, rather than the
  // `selectstart` guard.
  //
  // Drags the *other* open tab, not the CSV tab holding the selection: with
  // only the CSV tab open, the tab being dragged and the pane holding the
  // selection would be the same one, so a selection loss during the drag
  // couldn't be attributed to the `user-select` write specifically — it
  // could just as easily be the CSV pane's own DOM moving/re-rendering as
  // part of being dragged. A second, unrelated tab keeps the CSV pane
  // completely undisturbed while the drag lock's document-wide `user-select`
  // write is still in effect, isolating the one variable this test exists to
  // check.
  it("survives a tab drag started elsewhere without wiping a selection held in the CSV result table", async () => {
    await openWorkspace(fixturesDir);
    await openFile("launch-open.csv");
    await openFile("note.md");

    const cells = await $$(".data-pane table tbody td");
    await cells[0].waitForExist({ timeout: 10000 });
    const firstCell = await centerOf(".data-pane table tbody td:first-child");
    const lastCell = await centerOf(".data-pane table tbody td:last-child");

    await browser
      .action("pointer", { id: "select" })
      .move({ x: firstCell.x, y: firstCell.y, origin: "viewport" })
      .down()
      .move({ x: lastCell.x, y: lastCell.y, origin: "viewport", duration: 150 })
      .up()
      .perform();

    const selectionBeforeDrag = await browser.execute(() => window.getSelection().toString());
    expect(selectionBeforeDrag.length).toBeGreaterThan(0);

    const tab = await centerOf(`.tab[data-tab-path="${path.join(fixturesDir, "note.md")}"]`);
    const dataPane = await centerOf(".data-pane");

    await browser
      .action("pointer", { id: "drag" })
      .move({ x: tab.x, y: tab.y, origin: "viewport" })
      .down()
      .move({ x: dataPane.x, y: dataPane.y, origin: "viewport", duration: 200 })
      .up()
      .perform();

    const selectionAfterDrag = await browser.execute(() => window.getSelection().toString());
    // If this fails on a real device, the `user-select` writes in
    // `beginDragLock` are the cause and should be dropped: the `selectstart`
    // guard is the load-bearing layer and covers this region too. Do not
    // drop the guard.
    expect(selectionAfterDrag).toBe(selectionBeforeDrag);
  });
});
