import { browser } from "@wdio/globals";

// Reads an element's text through the DOM instead of WebDriver's Get Element
// Text.
//
// WebKitWebDriver returns "" from `getText()` for any element with
// `overflow: hidden`, however plainly visible and non-empty it is: the
// element reports `isDisplayed() === true`, a real 71x19 rect, and a correct
// `getHTML()`, and `getText()` still comes back empty. Relaxing the element's
// `overflow` to `visible` at runtime makes the same call return the text, and
// relaxing `text-overflow`, `white-space` or `max-width` does not — the
// clipping is the whole trigger. The quirk also hides the text from an
// ancestor's `getText()`.
//
// Three of this app's own labels are legitimately clipped — the editor and
// terminal tab names (`.tab-name`) and the status bar's path
// (`.status-item.path`) — so any assertion on those must read `textContent`.
// `tests/frontend/e2eSelectors.test.ts` guards against reintroducing a
// `getText()` on them.
export function elementText(selector) {
  return browser.execute(
    (sel) => document.querySelector(sel)?.textContent?.trim() ?? null,
    selector,
  );
}
