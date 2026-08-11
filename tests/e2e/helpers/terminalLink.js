import { browser } from "@wdio/globals";

/**
 * Locates the exact rendered substring `text` within `pane`'s rows and
 * returns the viewport-relative pixel coordinates of its center. Used to
 * target a real mouse event at the actual rendered glyphs of a terminal
 * link, since xterm.js hit-tests links against pixel coordinates translated
 * to buffer cells, not against DOM node identity.
 */
async function terminalTextCenter(pane, text) {
  return browser.execute(
    (paneEl, needle) => {
      const rowContainer = paneEl.querySelector(".xterm-rows") ?? paneEl;
      const walker = document.createTreeWalker(rowContainer, NodeFilter.SHOW_TEXT);
      let matchNode = null;
      let matchIndex = -1;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = node.textContent.indexOf(needle);
        if (index !== -1) {
          matchNode = node;
          matchIndex = index;
          break;
        }
      }
      if (!matchNode) {
        throw new Error(`terminal link text not found in rendered DOM: ${needle}`);
      }

      const range = document.createRange();
      range.setStart(matchNode, matchIndex);
      range.setEnd(matchNode, matchIndex + needle.length);
      const rect = range.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    },
    pane,
    text,
  );
}

/**
 * Ctrl-clicks a terminal file-path link by locating the exact rendered
 * substring in the DOM and dispatching real mouse events at its measured
 * pixel position.
 *
 * xterm.js's `Linkifier` hit-tests links against real mouse coordinates
 * translated to buffer cells via listeners on the terminal's `screenElement`
 * (`.xterm-screen`), and it resolves a link's *identity* lazily: `provideLinks`
 * (the real `fs_resolve_candidates` IPC round trip, batched with a 50ms
 * debounce) only runs the first time the mouse hovers a given line, not
 * eagerly on render, so `mousedown`/`mouseup` fired synchronously right after
 * `mousemove` in the same tick would race a `_currentLink` that hasn't
 * resolved yet and activate nothing. The `mousemove` is therefore a separate,
 * awaited step from `mousedown`/`mouseup`, with the resolve round trip given
 * time to land in between.
 */
export async function ctrlClickTerminalLink(pane, linkText) {
  const { x, y } = await terminalTextCenter(pane, linkText);
  const eventInit = { bubbles: true, cancelable: true, ctrlKey: true };

  await browser.execute(
    (paneEl, clientX, clientY, init) => {
      paneEl.dispatchEvent(new MouseEvent("mousemove", { ...init, clientX, clientY, view: window }));
    },
    pane,
    x,
    y,
    eventInit,
  );

  // Gives the link provider's async resolve round trip (and its 50ms
  // `ResolveBatcher` debounce) time to land before the click checks whether
  // a link is actually under the cursor. `Linkifier._linkHover` adds
  // `xterm-cursor-pointer` directly to the screen element (`pane` itself,
  // not a descendant) once a link resolves under the current hover position.
  await browser.waitUntil(
    async () => browser.execute((paneEl) => paneEl.classList.contains("xterm-cursor-pointer"), pane),
    { timeout: 5000, timeoutMsg: "expected the terminal link to resolve and show hover state before clicking" },
  );

  await browser.execute(
    (paneEl, clientX, clientY, init) => {
      paneEl.dispatchEvent(new MouseEvent("mousedown", { ...init, clientX, clientY, view: window }));
      paneEl.dispatchEvent(new MouseEvent("mouseup", { ...init, clientX, clientY, view: window }));
    },
    pane,
    x,
    y,
    eventInit,
  );
}
