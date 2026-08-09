import { expect } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

// A dedicated temp workspace rather than the shared `tests/e2e/fixtures/`
// directory: this needs a tree wide enough to make `.file-tree` itself
// horizontally scrollable, and a long, deeply-repeated name is the simplest
// way to force that — not worth adding permanently to the fixtures other
// specs also enumerate.
function makeWideWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atrium-explorer-drag-scroll-"));
  const deepDir = path.join(
    root,
    "a-very-long-directory-name-for-forcing-horizontal-overflow",
    "another-quite-long-nested-directory-name-here",
  );
  fs.mkdirSync(deepDir, { recursive: true });
  fs.writeFileSync(path.join(deepDir, "target-file-with-a-fairly-long-name.txt"), "drag me\n");
  return root;
}

describe("file explorer: horizontal scroll during a drag (issue #390)", () => {
  let root;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("does not scroll .file-tree sideways while a row is being dragged", async () => {
    root = makeWideWorkspace();
    await openWorkspace(root);

    // Expand both levels of nesting so the deeply-indented leaf row is what
    // actually forces `.file-tree`'s content wider than the panel.
    const outerDir = await $("//span[@class='name' and contains(text(), 'a-very-long-directory-name')]");
    await outerDir.waitForExist({ timeout: 10000 });
    await outerDir.click();

    const innerDir = await $("//span[@class='name' and contains(text(), 'another-quite-long-nested-directory-name')]");
    await innerDir.waitForExist({ timeout: 5000 });
    await innerDir.click();

    const targetRow = await $("//div[@class='row' and .//span[contains(text(), 'target-file-with-a-fairly-long-name')]]");
    await targetRow.waitForExist({ timeout: 5000 });

    const tree = await $(".file-tree");
    await browser.waitUntil(
      async () => {
        const { scrollWidth, clientWidth } = await browser.execute((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }), tree);
        return scrollWidth > clientWidth;
      },
      { timeout: 5000, timeoutMsg: "expected the deeply-nested long filename to make .file-tree horizontally scrollable" },
    );

    const startPoint = await browser.execute((el) => {
      const rect = el.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    }, targetRow);
    const scrollLeftBefore = await browser.execute((el) => el.scrollLeft, tree);

    // A real pointer drag toward and past the tree's right edge, held there
    // for several frames — the window in which a native drag-autoscroll (the
    // reported bug) would kick in — then released back over the dragged
    // row's own coordinates. Hit-testing a file row resolves to its parent
    // directory (`resolveExplorerDropTargetDir`), which `isValidMoveTarget`
    // (explorerDrag.ts) always rejects as "already directly inside its
    // current parent" — so this is a guaranteed-inert release regardless of
    // what else occupies the screen past the tree's right edge (unlike
    // releasing out past `.file-tree`'s bounding box, which resolves against
    // whatever pane is under that point rather than against the tree at all).
    const treeRect = await browser.execute((el) => {
      const rect = el.getBoundingClientRect();
      return { right: rect.right };
    }, tree);

    await browser
      .action("pointer")
      .move({ x: startPoint.x, y: startPoint.y, origin: "viewport" })
      .down()
      .move({ x: Math.round(treeRect.right) + 40, y: startPoint.y, origin: "viewport", duration: 200 })
      .pause(600)
      .move({ x: startPoint.x, y: startPoint.y, origin: "viewport", duration: 100 })
      .up()
      .perform();

    const scrollLeftAfter = await browser.execute((el) => el.scrollLeft, tree);
    expect(scrollLeftAfter).toBe(scrollLeftBefore);
  });
});
