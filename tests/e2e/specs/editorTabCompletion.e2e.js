import { expect } from "@wdio/globals";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openWorkspace } from "../helpers/workspace.js";
import { hasClass } from "../helpers/selectors.js";
import { waitForEditorFocus } from "../helpers/editorFocus.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "../fixtures");
const FIXTURE = "editor-tab-completion.py";

// The fixture is `def mmap_read():\n    pass\n\n` — a real function
// definition (so the language pack's own completion source has something
// to offer) followed by a blank last line, reached via Ctrl+End, that every
// scenario below types into or presses Tab on.
async function openFixtureAndFocusEnd() {
  await openWorkspace(fixturesDir);
  const fileNode = await $(`//span[${hasClass("name")} and text()='${FIXTURE}']`);
  await fileNode.waitForExist({ timeout: 10000 });
  await fileNode.click();

  const editor = await $(".cm-content");
  await editor.waitForExist({ timeout: 5000 });
  await editor.click();
  await waitForEditorFocus();
  await browser.keys(["Control", "End"]);
}

async function lastLineText() {
  return browser.execute(() => {
    const lines = document.querySelectorAll(".cm-line");
    return lines[lines.length - 1]?.textContent ?? null;
  });
}

// Types `text` one character at a time and waits for the last line to
// actually read back as `text` before returning, rather than sending the
// whole string as a single burst and trusting it landed. Measured directly:
// `browser.keys("mm")` sent as one call can silently drop the second "m" —
// two back-to-back Actions-API key presses for the *same* character,
// dispatched only a few milliseconds apart, do not reliably both register
// through WebKitWebDriver's synthetic input — and the test would otherwise
// go on to open a tooltip and accept whatever the (wrong, one-character)
// prefix resolved to instead of failing loudly.
async function typeAndConfirm(text) {
  for (const char of text) {
    await browser.keys(char);
  }
  await browser.waitUntil(async () => (await lastLineText()) === text, {
    timeout: 5000,
    timeoutMsg: `expected the last line to read "${text}" after typing it`,
  });
}

describe("editor Tab handling and autocompletion (issue #435)", () => {
  it("draws a single app-owned caret, not the webview's native one", async () => {
    await openFixtureAndFocusEnd();

    const caretColor = await browser.execute(
      () => getComputedStyle(document.querySelector(".cm-content")).caretColor,
    );
    // A real browser's computed style normalizes the `transparent` keyword
    // to its rgba equivalent (jsdom, used by the unit tests, returns the
    // keyword literally instead).
    expect(caretColor).toBe("rgba(0, 0, 0, 0)");

    await browser.waitUntil(
      async () => (await $$(".cm-cursor")).length === 1,
      { timeout: 5000, timeoutMsg: "expected exactly one app-drawn .cm-cursor" },
    );
  });

  it("accepts the selected completion on Tab, with no leading whitespace inserted", async () => {
    await openFixtureAndFocusEnd();
    await typeAndConfirm("mm");

    const tooltip = await $(".cm-tooltip-autocomplete");
    await tooltip.waitForExist({ timeout: 5000 });
    // interactionDelay (75ms) — CodeMirror's own misclick guard against
    // accepting a tooltip that only just opened. A comfortable margin past
    // it, matching the unit tests this change also adds.
    await browser.pause(400);

    await browser.keys(["Tab"]);

    await browser.waitUntil(async () => (await lastLineText()) === "mmap_read", {
      timeout: 5000,
      timeoutMsg: "expected Tab to accept the completion with no leading indentation",
    });
  });

  it("does not accept a completion on Enter, and inserts a newline instead", async () => {
    await openFixtureAndFocusEnd();
    await typeAndConfirm("mm");

    const tooltip = await $(".cm-tooltip-autocomplete");
    await tooltip.waitForExist({ timeout: 5000 });
    await browser.pause(400);

    await browser.keys(["Enter"]);

    // The "mm" line is no longer last once Enter inserts a newline below it.
    const linesText = await browser.execute(() =>
      Array.from(document.querySelectorAll(".cm-line")).map((el) => el.textContent),
    );
    expect(linesText).toContain("mm");
    expect(linesText).not.toContain("mmap_read");
    expect(linesText[linesText.length - 1]).toBe("");
  });

  it("still indents by the configured tab size when Tab is pressed with no completion open", async () => {
    await openFixtureAndFocusEnd();

    expect(await $(".cm-tooltip-autocomplete").isExisting()).toBe(false);

    await browser.keys(["Tab"]);

    await browser.waitUntil(async () => (await lastLineText()) === "  ", {
      timeout: 5000,
      timeoutMsg: "expected Tab with no completion open to indent by 2 spaces",
    });
  });
});
