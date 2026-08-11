import { browser } from "@wdio/globals";

// Triggers a native-menu-bound command by emitting the same `menu:*` event
// `main.rs` emits when its accelerator or menu item fires.
//
// The accelerators in `main.rs` (`CmdOrCtrl+Shift+F`, `CmdOrCtrl+P`,
// `CmdOrCtrl+S`, the four split directions) are `muda` menu-item accelerators
// handled above the WebView, and WebDriver cannot reach them: a synthetic
// `Control+Shift+F` arrives in the DOM with the correct `ctrlKey`/`shiftKey`
// and the menu item still never fires, because nothing in `src/` listens for
// the chord — `openSearch()` is only ever called from `MenuBar.ts`'s menu-event
// handlers and from the status-bar button. Sending raw chords therefore tests
// nothing at all, on any platform.
//
// This is the same boundary `openWorkspace` works around for the native folder
// picker, handled the same way: drive the real frontend path from its first
// reachable point. Everything downstream of the menu event is genuine app code
// — `MenuBar.ts`'s handler, its workspace guard, and the store it writes. The
// accelerator strings themselves are covered in `src-tauri/src/main.rs`'s own
// tests, which is the only layer that can see them.
export function invokeMenuCommand(id) {
  return browser.execute(
    (event) => window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event, payload: null }),
    id,
  );
}

// Opens the editor's right-click context menu.
//
// A WebDriver `click({button: "right"})` does reach the app's handler — the
// event arrives at `.editor-pane`'s bubble phase and `preventDefault()` is
// observably called — but the menu is not present afterwards, because the
// synthesized pointer sequence that accompanies the right-click closes it
// again. Dispatching the `contextmenu` event on its own leaves it open, and
// drives exactly the same `onContextMenu` handler.
export function openEditorContextMenu() {
  return browser.execute(() => {
    const pane = document.querySelector(".editor-pane");
    const rect = pane.getBoundingClientRect();
    pane.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: Math.round(rect.x + rect.width / 2),
      clientY: Math.round(rect.y + 40),
    }));
  });
}
