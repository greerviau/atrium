import { expect } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openWorkspace } from "../helpers/workspace.js";
import { ctrlClickTerminalLink } from "../helpers/terminalLink.js";
import { elementText } from "../helpers/text.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "../fixtures");

// The pane a freshly mounted terminal passes through before its first real
// fit is xterm.js's minimum grid, which renders at 90px tall; a real pane in
// this layout is ~195px. Waiting on a height above this floor is what keeps
// the interaction off a pane that is not yet laid out.
const TERMINAL_MIN_USABLE_HEIGHT = 100;

async function activeTerminalPane() {
  const pane = await $(".xterm-screen");
  await pane.waitForExist({ timeout: 10000 });
  await browser.waitUntil(async () => (await pane.getSize()).height > TERMINAL_MIN_USABLE_HEIGHT, {
    timeout: 10000,
    timeoutMsg: "expected the terminal pane to reach a usable rendered size",
  });
  return pane;
}

describe("terminal file-path links outside the open project (issue #406)", () => {
  let outsideDir;
  let outsideFile;

  beforeEach(() => {
    // A fresh directory outside `fixturesDir` (the open project root) on
    // every run, so the printed absolute path is never accidentally
    // in-workspace and never collides with a previous run's leftovers.
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "atrium-e2e-406-"));
    outsideFile = path.join(outsideDir, "outside-406.md");
    fs.writeFileSync(outsideFile, "# Outside the project\n");
  });

  afterEach(() => {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("opens a ctrl-clicked absolute path outside the workspace as an external tab", async () => {
    await openWorkspace(fixturesDir);

    const pane = await activeTerminalPane();
    await pane.click();
    // `printf` rather than `echo` -- and no shell quoting around the path
    // itself -- keeps the printed text an exact, predictable match for
    // `FILE_PATH_REGEX` and for the DOM text search `ctrlClickTerminalLink`
    // performs. The trailing `\n` keeps the path on its own line, so the
    // next shell prompt can't render butted up against it.
    await browser.keys(`printf '%s\\n' ${outsideFile}`);
    await browser.keys("Enter");

    await browser.waitUntil(async () => (await pane.getText()).includes(outsideFile), {
      timeout: 10000,
      timeoutMsg: "expected the printed absolute path to appear in terminal output",
    });

    await ctrlClickTerminalLink(pane, outsideFile);

    await browser.waitUntil(
      async () => ((await elementText(".editor-panel .tab.active .tab-name")) ?? "").includes("outside-406.md"),
      { timeout: 10000, timeoutMsg: "expected outside-406.md's tab to become active after the ctrl-click" },
    );

    const badge = await $(".editor-panel .tab.active .tab-external-badge");
    await expect(badge).toExist();

    const editor = await $(".cm-content");
    await editor.waitForExist({ timeout: 5000 });
    await browser.waitUntil(async () => (await editor.getText()).includes("Outside the project"), {
      timeout: 5000,
      timeoutMsg: "expected the external file's real contents to load",
    });
  });
});
