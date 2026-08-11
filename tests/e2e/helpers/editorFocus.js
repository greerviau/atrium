import { browser } from "@wdio/globals";

// Waits until `.cm-content` actually holds document focus.
//
// `click()` returns before CodeMirror has taken focus — measured at 20-110 ms
// behind the call under Xvfb's software rendering, with `document.activeElement`
// still on the previously focused element throughout. Keystrokes sent inside
// that window are discarded outright: the document's own `textContent` never
// changes, so this is upstream of any query-layer quirk (issue #425).
//
// Polls the real focus state rather than pausing a fixed interval, so it
// neither trades a race for a flaky timeout nor pays a fixed cost on a fast
// machine.
export async function waitForEditorFocus() {
  await browser.waitUntil(
    () => browser.execute(() => {
      const editor = document.querySelector(".cm-content");
      return !!editor && document.activeElement === editor;
    }),
    { timeout: 10000, timeoutMsg: "expected the editor to take focus before sending keys" },
  );
}
