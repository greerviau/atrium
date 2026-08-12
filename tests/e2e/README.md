# End-to-end smoke tests

WebDriver-based smoke tests via `tauri-driver`, per the plan's testing strategy (implementation plan section 8).

## Prerequisites

These tests drive the actual compiled app through its native WebView, so they need either a real display or Xvfb, the system WebView libraries, and the full Tauri build toolchain.

- Linux or Windows, with a display **or** Xvfb (`xvfb-run`). `tauri-driver` does not support macOS.
- Rust toolchain, plus the Tauri v2 system dependencies for your platform ([webkit2gtk etc. on Linux](https://v2.tauri.app/start/prerequisites/), Microsoft C++ Build Tools and WebView2 on Windows).
- `cargo install tauri-driver` (once).
- On Linux, the package providing `WebKitWebDriver` — `webkitgtk-webdriver` on current Ubuntu releases (it was renamed from the older `webkit2gtk-driver`, which some CI images and older distributions still use) — and, for headless runs, the `xvfb` package.

## Running

```sh
cd tests/e2e
npm install
npm test
npm run test:launch-open
```

`wdio.conf.js` starts the Vite server used by Tauri's debug build, builds the binary (`cargo build` in `src-tauri/`), starts `tauri-driver`, and runs the specs in `specs/`. It stops both child processes when the suite finishes.
The `test:launch-open` command starts Atrium under WebDriver, launches a second native process with `fixtures/launch-open.md` as a real argument, and verifies that the existing app opens it instead of showing the welcome screen.

On a machine with no display attached (including a headless CI container), run the same commands under Xvfb — the same `dbus-run-session -- xvfb-run` recipe `.github/workflows/ci.yml` uses for `test:launch-open` (its runner image still resolves the older `webkit2gtk-driver` package name):

```sh
sudo apt-get install -y webkitgtk-webdriver xvfb # once — older Ubuntu releases: webkit2gtk-driver
cargo install tauri-driver --locked              # once

cd tests/e2e
npm install
dbus-run-session -- xvfb-run --auto-servernum --server-args="-screen 0 1600x1200x24" npm test
```

The explicit `--server-args` doesn't fix anything by itself — Xvfb's own default (`1280x1024x24`) is already large enough for the app's configured `1280x800` window — it just pins the geometry the suite runs against to a known value with horizontal slack, rather than inheriting whatever a distro's default happens to be, so a future geometry-sensitive failure has a stated baseline to diagnose against.

## Coverage

`specs/smoke.e2e.js` covers these scenarios:

1. Open a folder, open `note.md`, verify the heading gets its live-preview class, edit, save, reload, and confirm the edit persisted to disk.
2. Open TOML and Terraform files, verify that each renders highlighted tokens, and confirm the status bar identifies its language.
3. Open `pixel.png` and verify the dedicated image pane loads it through the scoped asset protocol.
4. Open a terminal tab, run `echo`, and verify the output renders.
5. Split the active terminal pane, run a distinct command in each of the two resulting panes, confirm neither pane's output leaks into the other's, then close one pane and confirm the other survives with its output intact.
6. Open the project-wide search overlay via the Find in Files command (its native `CmdOrCtrl+Shift+F` accelerator is unreachable from WebDriver — see Environment notes below), search for a string that matches `note.md`, click the result, and confirm the overlay closes and the editor jumps to `note.md`.
7. Confirm the bottom status bar shows the active file's path and cursor position and updates as the caret moves, that its search button opens the search overlay, and that its explorer/terminal toggle buttons show and hide their respective panels.
8. (Follow-up, not yet in the spec) feed a synthetic buffer containing a PR URL and a unique partial file path with a line suffix, then verify both linkify and that clicking the file path opens the matching workspace file at that line.

The native folder-picker dialog lives outside the WebView, so the spec registers the workspace root directly through the same `workspace_set_root` command the picker's callback would call, rather than trying to drive the OS dialog. `workspace_set_root` also records the path as a recent project, so the spec reloads and clicks its row on the welcome screen to pick it up — everything downstream, including the workspace store update, exercises real app code.

`specs/unsavedChanges.e2e.js` covers the unsaved-changes close confirmation:

1. Edit `note.md`, click its tab's "×", click "Don't Save" in the confirmation dialog, and confirm the tab closes with the on-disk file unchanged.
2. Same setup, click "Save" instead, and confirm the on-disk file now contains the edit.

It also covers issue #250 (a failed save going silently unreported): `chmod`s `note.md` read-only, edits it, then confirms an `.error-toast` naming the file appears both via `Cmd+S` and via the editor context menu's Save item.

`specs/scrollThenClick.e2e.js` targets the rendered-markdown scroll-then-click condition issues #183, #367, #454 and #455 were filed against.
It opens `long.md` on a pane that has never yet been clicked into, wheel-scrolls it, and clicks a fixed point in the viewport deliberately *inside* the pane's post-scroll settle window — before any heading has rendered and before CodeMirror's scroll correction has landed — exercising `guardFirstFocusScrollPosition` and `handleScrollSettleMousedown` together, the condition issues #183 and #367 were about.
It reads everything it asserts on only after the pane has settled.
This is a real-display, real-input-timing bug that jsdom/vitest tests cannot exercise (see `tests/frontend/scrollSettleMousedown.test.ts` for the unit-level coverage of the fix's mechanics).
It confirms the click actually landed mid-settle and actually registered, that the scroll position held, and that the click resolved to *exactly* the source line that was under the pointer when the button went down - not merely close to it, per issue #454's acceptance criterion - using a capture-phase `mousedown` listener on `document` (which runs before `baseExtensions.ts`'s guards) to record what was under the pointer, and a bubble-phase listener on the same event (which runs after them) to confirm the anchor's own measure flush didn't move the scroller before it could be resolved (plan §9.1 for the underlying hazard).
Because the oracle is now an exact match rather than a tolerance, this spec is real fault-injection coverage of the guard it exercises: removing it moves the resolved line, which the assertion catches.

A second, currently `it.skip`-ped case attempts the same thing through `handleScrollSettleMousedown` alone, on a pane already clicked into once — the path `guardFirstFocusScrollPosition` never touches. It's skipped rather than deleted: probing showed that once a pane has been clicked into and settled even once, a large wheel scroll to fresh content renders and decorates on the very next frame, with no measurable half-built window left to land a click inside. `handleScrollSettleMousedown` remains covered at the unit level regardless (including a case confirming it skips the focus-restore dance on an already-focused pane); see the skipped test's own comment for the full finding.

`specs/horizontalRuleCursor.e2e.js` covers issue #366: open `horizontal-rule.md`, click rendered text below a horizontal rule, and confirm the cursor position remains on the clicked source line.

`specs/issue359.e2e.js` covers issue #359: place the caret at a rendered Markdown visual wrap boundary, click the terminal, wait through CodeMirror's next measure cycle, and confirm the terminal retains focus while the preview hides its raw marker.

`specs/launchOpen.e2e.js` covers issue #362 by launching a second native application process with a file path argument, then verifying that the single-instance handoff opens the requested file in the existing editor and removes the welcome screen.
This focused spec runs under Xvfb in Linux CI.

`specs/keyboardShortcuts.e2e.js` covers issue #156's two kinds of shortcut:

1. The five file-explorer shortcuts, which are plain DOM `keydown` handlers scoped to whichever tree row holds focus rather than native accelerators (see the plan's safety-constraint note): click a row to focus it, press Ctrl+N, type a name, and confirm the new file appears in the tree; press F2 on that file's own row and confirm the inline rename opens prefilled with its current name; press Ctrl+Backspace and confirm the permanent-delete confirmation modal opens (and the entry survives) before actually deleting it via the modal's own button.
2. The four split-direction shortcuts, which unlike the explorer shortcuts *are* native `main.rs` accelerators. WebDriver cannot reach a native accelerator at all, with any modifier: a synthetic chord arrives in the DOM with the right modifiers and the menu item still never fires, because nothing in `src/` listens for it. These two scenarios instead emit the same `menu:*` event `main.rs` emits when the accelerator fires (`helpers/menu.js`'s `invokeMenuCommand`), which drives the real frontend path (`App.svelte`'s `splitFocusedSurface`): click into a terminal pane, invoke the Split Right command, and confirm a second `.xterm-screen` appears; click into an editor pane, invoke the Split Down command, and confirm a second `.editor-panel` appears.

`specs/explorerDragScroll.e2e.js` covers issue #390: opens a dedicated temp workspace (not the shared `fixtures/` directory — none of its entries are wide enough to force horizontal overflow) containing a deeply nested, long-named file, expands the tree to it, confirms `.file-tree` is horizontally scrollable, then drags the row toward and past the tree's right edge and holds it there — the window in which the reported native drag-autoscroll occurs — before releasing back onto the row itself (a guaranteed no-op drop) and asserting `scrollLeft` never moved during the gesture. Like `scrollThenClick.e2e.js`, this is a real-WebView, real-input-timing behavior that jsdom/vitest cannot exercise (see `tests/frontend/explorerDragMove.test.ts` for the unit-level coverage of the fix's `scrollLeft`-correction mechanics).

`specs/dragCursor.e2e.js` covers issue #420 (a drag showing the text-edit cursor and highlighting random text underneath it): dragging a file row over the editor shows a `grabbing` cursor and selects no text for the whole hold, sampled repeatedly rather than only before/after, and ordinary mouse selection works again once the drag ends; the same cursor/selection coverage holds for dragging an editor tab across the app. A third case targets the CSV/Parquet result table specifically: select a run of cells, then drag the explorer sidebar resizer (not a tab — see the test's own comment for why a resizer, which calls `preventDefault()` on `pointerdown`, is the only gesture that can isolate this from ordinary, unrelated click-elsewhere-collapses-a-selection browser behavior), and confirm the CSV selection survives. This is what caught a real-device-only regression during development: an earlier version of the shared lock also wrote `user-select: none` on `<html>`, which turned out to clear an existing selection over exactly this kind of plain, non-contenteditable region on this app's WebKit target, rather than merely fail to protect it. That write was removed; the `selectstart` guard alone is what this spec now confirms is sufficient. Real pointer drags in this WebDriver/WebKit combination also need several small explicit `move` steps rather than one duration-interpolated move to extend a selection over CodeMirror content specifically (the `dragSelect` helper) — plain, non-editable regions like a `<td>` don't need this. This is another real-WebView, real-input-timing behavior jsdom/vitest cannot exercise (see `tests/frontend/dragLock.test.ts` and the extended `explorerDragMove.test.ts`/`tabDrag.test.ts`/`tableHandles.test.ts`/resizer suites for the unit-level coverage of the shared lock's own mechanics).

## Status

The focused launch-open spec runs in Linux CI.
The broader smoke suite still requires a real Linux or Windows display (or Xvfb) and is not part of the default CI workflow.

`smoke.e2e.js` (12 scenarios), `unsavedChanges.e2e.js` (4 scenarios) and `keyboardShortcuts.e2e.js` (4 scenarios) each pass in full, repeatably, whether run standalone or as part of the whole suite.

Running the whole suite (`npm test`, all 11 spec files sharing one webview profile per run) passes all 11 spec files.

## Environment notes

Several behaviors of this target are worth knowing before adding a new spec or assertion, since each looks like a bug and is not:

- **`getText()` returns `""` for any `overflow: hidden` element.** WebKitWebDriver's Get Element Text comes back empty for a clipped element however visible and non-empty it is — confirmed with `isDisplayed()`, `getSize()` and `getHTML()` all reporting the element correctly regardless. Read such an element's text with `elementText()` (`helpers/text.js`), which reads `textContent` through the DOM instead. `.tab-name` (both the editor's and the terminal's tab names) and `.status-item.path` are deliberately clipped in this app's own CSS; `tests/frontend/e2eSelectors.test.ts` guards against reintroducing a `getText()`/`toHaveText…()` read on either.
- **A freshly scrolled rendered-markdown pane is briefly undecorated and still measuring.** For roughly 200ms after a fast wheel scroll, the newly visible lines carry no live-preview decorations (`.cm-heading-2` matches nothing), `scrollHeight` still reflects estimated block heights, and `scrollTop` has not yet taken the compensating adjustment CodeMirror applies when it replaces those estimates with measurements — about 60px on `long.md`. A spec that measures a pane right after scrolling it must therefore wait for decorations *and* a stable `scrollHeight`, not merely a changed `scrollTop`; waiting on `scrollTop` alone reads a half-built pane and was the cause of a long-standing flake in `scrollThenClick.e2e.js`. Conversely, a spec that wants a click to land *inside* that window has to fight WebDriver latency for it: send the wheel with `duration: 0` so `perform()` returns before the window closes, then send the click immediately after — keeping its `move`, `down` and `up` together in one `perform()`, per the next note — or the click overshoots the window entirely.
- **Splitting a pointer `move` from its `down` across two `perform()` calls permanently drops `document.hasFocus()`.** In this WebDriver/WebKit combination the flag stays false for the rest of the session and survives `browser.refresh()`. Nothing registers afterwards: CodeMirror gates `view.hasFocus` on `document.hasFocus()`, so an editor pane can never take focus, and every click is silently swallowed while the cursor readout sits at its initial value — a spec written this way looks like it is clicking and is not. Keep `move`, `down` and `up` in a single `perform()`. A spec whose assertions compare two values that are both read *after* such a click will compare the same untouched value to itself and pass vacuously, so assert that a click changed something before comparing anything derived from it.
- **Native menu accelerators are unreachable from WebDriver.** The `muda` menu-item accelerators registered in `src-tauri/src/main.rs` (Find in Files, Go to File, Save, the four Split-direction items) are handled above the WebView. A WebDriver-synthesized key combo arrives in the DOM with the correct modifiers and still never fires the menu item, because nothing in `src/` listens for the chord — the frontend path behind each of these is only ever reached through the real native menu event. `invokeMenuCommand()` (`helpers/menu.js`) emits the same `menu:*` event `main.rs` emits when the accelerator fires, driving that real frontend path from its first reachable point; the accelerator strings themselves are covered separately, by a Rust unit test in `src-tauri/src/main.rs`.
