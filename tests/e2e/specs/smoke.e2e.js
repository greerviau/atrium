import { expect } from "@wdio/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openWorkspace } from "../helpers/workspace.js";
import { hasClass } from "../helpers/selectors.js";
import { elementText } from "../helpers/text.js";
import { waitForEditorFocus } from "../helpers/editorFocus.js";
import { invokeMenuCommand } from "../helpers/menu.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "../fixtures");
const notePath = path.join(fixturesDir, "note.md");

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

describe("markdown live preview", () => {
  let pristine;

  beforeEach(() => {
    pristine = fs.readFileSync(notePath, "utf8");
  });

  afterEach(() => {
    fs.writeFileSync(notePath, pristine);
  });

  it("renders a heading, edits, saves, and persists content", async () => {
    await openWorkspace(fixturesDir);

    const fileNode = await $(`//span[${hasClass("name")} and text()='note.md']`);
    await fileNode.waitForExist({ timeout: 10000 });
    await fileNode.click();

    const heading = await $(".cm-heading-1");
    await heading.waitForExist({ timeout: 5000 });
    await expect(heading).toHaveText("Hello");

    const editor = await $(".cm-content");
    await editor.click();
    await waitForEditorFocus();
    await browser.keys(["End"]);
    await browser.keys(" edited");

    // `main.rs` registers CmdOrCtrl+S as a native menu accelerator, which a
    // WebDriver-synthesized chord never reaches; emitting `menu:save` drives
    // the same path the accelerator and the File > Save item both take.
    await invokeMenuCommand("menu:save");

    // Read the file back through the same "open" path and confirm the edit
    // round-tripped to disk, rather than merely invoking the read.
    await browser.waitUntil(
      async () => {
        const contents = await browser.execute((filePath) => {
          return window.__TAURI_INTERNALS__.invoke("fs_read_file", {
            workspaceId: "local",
            path: filePath,
          });
        }, notePath);
        return typeof contents === "string" && contents.includes(" edited");
      },
      { timeout: 10000, timeoutMsg: "expected the edit to have round-tripped to disk" },
    );
  });
});

describe("code syntax highlighting", () => {
  for (const [filename, language] of [
    ["config.toml", "TOML"],
    ["main.tf", "Terraform"],
  ]) {
    it(`highlights ${filename} and identifies it as ${language}`, async () => {
      await openWorkspace(fixturesDir);

      const fileNode = await $(`//span[${hasClass("name")} and text()='${filename}']`);
      await fileNode.waitForExist({ timeout: 10000 });
      await fileNode.click();

      await browser.waitUntil(
        async () => (await $$(".cm-content .cm-line span[class]")).length > 0,
        { timeout: 5000, timeoutMsg: `expected ${filename} to render syntax-highlighted tokens` },
      );
      await expect($(".status-group.indicators .status-item:first-child")).toHaveText(language);
    });
  }
});

describe("image viewer", () => {
  it("opens an image file in a dedicated pane", async () => {
    await openWorkspace(fixturesDir);

    const fileNode = await $(`//span[${hasClass("name")} and text()='pixel.png']`);
    await fileNode.waitForExist({ timeout: 10000 });
    await fileNode.click();

    const image = await $(".image-pane img");
    await image.waitForExist({ timeout: 5000 });
    await browser.waitUntil(
      async () => (await image.getProperty("naturalWidth")) > 0,
      { timeout: 5000, timeoutMsg: "expected pixel.png to load through the Atrium asset protocol" },
    );

    // `.tab-name` is `overflow: hidden`, and this target's Get Element Text
    // returns "" for a clipped element however plainly visible it is.
    await browser.waitUntil(
      async () => (await elementText(".editor-panel .tab.active .tab-name")) === "pixel.png",
      { timeout: 5000, timeoutMsg: "expected pixel.png's tab to be active" },
    );
  });
});

describe("terminal", () => {
  beforeEach(async () => {
    await openWorkspace(fixturesDir);
  });

  it("runs a command and renders its output", async () => {
    // No `.new-tab` click: opening a workspace auto-spawns a terminal
    // (`App.svelte`'s auto-spawn effect). Adding a second tab hides the first,
    // and the hidden pane — re-fitted to xterm.js's minimum grid — is what an
    // unscoped `.xterm-screen` lookup then resolves to.
    const terminal = await activeTerminalPane();
    await terminal.click();
    await browser.keys("echo atrium-e2e-marker");
    await browser.keys("Enter");

    await browser.waitUntil(
      async () => (await $(".xterm-screen").getText()).includes("atrium-e2e-marker"),
      { timeout: 10000, timeoutMsg: "expected echoed marker to appear in terminal output" },
    );
  });

  it("splits the active pane into two independent concurrent PTYs, then survives closing one", async () => {
    // Type into the pre-existing pane *before* splitting, and confirm its
    // scrollback survives the split — the actual behavior issue #112 is
    // about (a pane that isn't the one being added must never have its PTY
    // killed and its terminal remounted just because the tree's shape
    // changed around it).
    const preSplitPane = await activeTerminalPane();
    await preSplitPane.click();
    await browser.keys("echo atrium-pre-split-marker");
    await browser.keys("Enter");
    await browser.waitUntil(async () => (await preSplitPane.getText()).includes("atrium-pre-split-marker"), {
      timeout: 10000,
      timeoutMsg: "expected the pre-split marker to appear in the pane's output before splitting",
    });

    const splitButton = await $('button[aria-label="Split terminal"]');
    await splitButton.waitForExist({ timeout: 5000 });
    await splitButton.click();

    const splitRightOption = await $('[role="menuitem"]=Split Right');
    await splitRightOption.waitForExist({ timeout: 5000 });
    await splitRightOption.click();

    await browser.waitUntil(async () => (await $$(".xterm-screen")).length === 2, {
      timeout: 10000,
      timeoutMsg: "expected two independent terminal panes after splitting",
    });
    const [firstPane, secondPane] = await $$(".xterm-screen");

    // The pre-existing pane (now the first pane, per split-right placing the
    // new leaf after it) must still show the marker it had before the split
    // — its PTY and scrollback must never have been torn down.
    expect(await firstPane.getText()).toContain("atrium-pre-split-marker");

    // Distinct markers into each pane, clicking each first to move focus —
    // mirroring how the case above clicks `.xterm-screen` before typing.
    await firstPane.click();
    await browser.keys("echo atrium-split-marker-one");
    await browser.keys("Enter");

    await secondPane.click();
    await browser.keys("echo atrium-split-marker-two");
    await browser.keys("Enter");

    await browser.waitUntil(async () => (await firstPane.getText()).includes("atrium-split-marker-one"), {
      timeout: 10000,
      timeoutMsg: "expected the first pane's own marker to appear in its output",
    });
    await browser.waitUntil(async () => (await secondPane.getText()).includes("atrium-split-marker-two"), {
      timeout: 10000,
      timeoutMsg: "expected the second pane's own marker to appear in its output",
    });

    // Real concurrent-PTY behavior: neither pane's shell output leaks into
    // the other's, which only unit/component tests mocking TerminalPane
    // can't cover.
    expect(await firstPane.getText()).not.toContain("atrium-split-marker-two");
    expect(await secondPane.getText()).not.toContain("atrium-split-marker-one");

    // Close the first panel and confirm the second survives with its own
    // output intact. WebDriver can't inspect OS process state directly, so
    // the closed panel's PTY being gone is verified the same way the rest of
    // this suite verifies backend behavior — through the DOM: its
    // `.xterm-screen` only disappears once `TerminalPane`'s `onDestroy` ->
    // `ptyKill` has actually run.
    //
    // Scoped to `.terminal-area`: `.pane-leaf` is rendered by the editor's
    // split tree as well, and the editor's leaf comes first in document
    // order, so an unscoped `$$(".pane-leaf")[0]` is the editor pane and
    // carries no "Close terminal" button at all.
    const firstPanel = (await $$(".terminal-area .pane-leaf"))[0];
    const closeButton = await firstPanel.$('button[aria-label="Close terminal"]');
    await closeButton.click();

    await browser.waitUntil(async () => (await $$(".xterm-screen")).length === 1, {
      timeout: 10000,
      timeoutMsg: "expected only one terminal pane to remain after closing the other",
    });

    const remainingPane = await $(".xterm-screen");
    expect(await remainingPane.getText()).toContain("atrium-split-marker-two");
  });
});

describe("project-wide search", () => {
  beforeEach(async () => {
    await openWorkspace(fixturesDir);
  });

  it("opens via the Find in Files command, finds a match, and jumps to it", async () => {
    // The accelerator itself is a native menu binding and unreachable from
    // WebDriver; emitting `menu:find-in-files` drives the same frontend path.
    await invokeMenuCommand("menu:find-in-files");

    const searchInput = await $(".search-panel input");
    await searchInput.waitForExist({ timeout: 5000 });
    await searchInput.click();
    await browser.keys("bold");

    const resultRow = await $(".search-result-row");
    await resultRow.waitForExist({ timeout: 10000 });
    await resultRow.click();

    // Selecting a result closes the overlay and jumps to it via the same
    // `openFile`/`pendingSelection` mechanism markdown-link clicks and the
    // terminal's file-path links already use.
    await $(".search-panel").waitForExist({ timeout: 5000, reverse: true });

    await browser.waitUntil(
      async () => ((await elementText(".editor-panel .tab.active .tab-name")) ?? "").includes("note.md"),
      { timeout: 10000, timeoutMsg: "expected note.md's tab to be active after jumping to the search result" },
    );
    await browser.waitUntil(
      async () => (await $(".cm-content").getText()).includes("bold"),
      { timeout: 10000, timeoutMsg: "expected the editor to have scrolled to the matched line" },
    );
  });
});

describe("go to file", () => {
  beforeEach(async () => {
    await openWorkspace(fixturesDir);
  });

  it("opens via the Go to File command in Files mode, finds a file by name, and jumps to it", async () => {
    await invokeMenuCommand("menu:go-to-file");

    const panel = await $(".search-panel");
    await panel.waitForExist({ timeout: 5000 });

    // Files mode has no case-sensitivity/regex toggles.
    const toggles = await $$(".search-input-row .search-toggle");
    expect(toggles).toHaveLength(0);

    const searchInput = await $(".search-panel input");
    await searchInput.click();
    await browser.keys("note");

    // Files mode's empty-query state is a real "browse all files" list, not
    // a blank slate — unlike content mode, which never searches below its
    // three-character minimum. A `.search-result-row` can already exist
    // from that browse list the instant the overlay opens, so waiting for
    // mere existence can click a row that predates the debounced "note"
    // query settling. Wait for the first row's own text to actually reflect
    // the typed query before clicking it.
    const resultRow = await $(".search-result-row");
    await browser.waitUntil(
      async () => ((await elementText(".search-result-row .search-result-filename")) ?? "").toLowerCase().includes("note"),
      { timeout: 10000, timeoutMsg: "expected the first result row to reflect the \"note\" query" },
    );
    await resultRow.click();

    // Selecting a file result closes the overlay and jumps straight to the
    // file via the same `openFile` mechanism content search uses, minus any
    // line/col selection since a filename match has none.
    await $(".search-panel").waitForExist({ timeout: 5000, reverse: true });

    await browser.waitUntil(
      async () => ((await elementText(".editor-panel .tab.active .tab-name")) ?? "").includes("note.md"),
      { timeout: 10000, timeoutMsg: "expected note.md's tab to be active after jumping to the file result" },
    );
  });
});

describe("status bar", () => {
  beforeEach(async () => {
    await openWorkspace(fixturesDir);
    const fileNode = await $(`//span[${hasClass("name")} and text()='note.md']`);
    await fileNode.waitForExist({ timeout: 10000 });
    await fileNode.click();
    await $(".cm-content").waitForExist({ timeout: 5000 });
  });

  it("shows the active file's path and cursor position, and updates as the caret moves", async () => {
    const statusBar = await $(".status-bar");
    await statusBar.waitForExist({ timeout: 5000 });

    // `.status-item.path` is `overflow: hidden`, so its text must be read
    // through the DOM rather than Get Element Text.
    await browser.waitUntil(async () => (await elementText(".status-bar .path")) === "note.md", {
      timeout: 5000,
      timeoutMsg: "expected the status bar to show the active file's path",
    });

    const cursorSelector = ".status-bar .status-item.mono:not(.path)";

    const editor = await $(".cm-content");
    await editor.click();
    await waitForEditorFocus();

    // Place the caret deterministically first. A click lands on the centre of
    // `.cm-content`, which for this fixture is below the last line, so
    // CodeMirror puts the caret at the end of the document — where `End` is a
    // no-op and the indicator never changes.
    // Re-sends the chord each poll until the caret is actually at the top.
    // `waitForEditorFocus` guarantees `.cm-content` holds focus, but the first
    // chord after focus lands can still be dropped under software rendering —
    // the same class of race as the editor click itself. Ctrl+Home is
    // idempotent, so re-sending it is safe and self-healing.
    await browser.waitUntil(
      async () => {
        await browser.keys(["Control", "Home"]);
        return (await elementText(cursorSelector)) === "Ln 1, Col 1";
      },
      { timeout: 10000, interval: 500, timeoutMsg: "expected the caret to start at the top of the document" },
    );

    await browser.keys(["End"]);
    await browser.waitUntil(
      async () => {
        const text = (await elementText(cursorSelector)) ?? "";
        return text.startsWith("Ln 1,") && text !== "Ln 1, Col 1";
      },
      { timeout: 5000, timeoutMsg: "expected the cursor-position indicator to update after moving the caret" },
    );
  });

  it("clicking the status-bar search button opens the search overlay", async () => {
    // Matched on the label's stable prefix: the parenthesised part is a
    // rendered keybinding glyph (`Search (⌘⇧F)`), not part of the button's
    // identity.
    const searchButton = await $('.status-bar button[aria-label^="Search ("]');
    await searchButton.click();

    const panel = await $(".search-panel");
    await panel.waitForExist({ timeout: 5000 });

    await browser.keys(["Escape"]);
    await panel.waitForExist({ timeout: 5000, reverse: true });
  });

  it("clicking the explorer toggle button hides and reshows the file explorer", async () => {
    const toggleButton = await $('.status-bar button[aria-label^="Toggle Explorer ("]');
    const explorer = await $(".explorer");
    await explorer.waitForExist({ timeout: 5000 });

    await toggleButton.click();
    await explorer.waitForExist({ timeout: 5000, reverse: true });

    await toggleButton.click();
    await explorer.waitForExist({ timeout: 5000 });
  });

  it("clicking the terminal toggle button hides and reshows the terminal panel", async () => {
    const toggleButton = await $('.status-bar button[aria-label^="Toggle Terminal ("]');
    const terminalArea = await $(".terminal-area");
    await terminalArea.waitForDisplayed({ timeout: 5000 });

    await toggleButton.click();
    await terminalArea.waitForDisplayed({ timeout: 5000, reverse: true });

    await toggleButton.click();
    await terminalArea.waitForDisplayed({ timeout: 5000 });
  });
});
