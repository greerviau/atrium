# End-to-end smoke tests

WebDriver-based smoke tests via `tauri-driver`, per the plan's testing strategy (implementation plan section 8).

## Prerequisites

These tests drive the actual compiled app through its native WebView, so they need a machine with a display and the full Tauri build toolchain — they cannot run in a headless CI container or a sandbox without system WebView libraries.

- Linux or Windows with a display. `tauri-driver` does not support macOS.
- Rust toolchain, plus the Tauri v2 system dependencies for your platform ([webkit2gtk etc. on Linux](https://v2.tauri.app/start/prerequisites/), Microsoft C++ Build Tools and WebView2 on Windows).
- `cargo install tauri-driver` (once).

## Running

```sh
cd tests/e2e
npm install
npm test
npm run test:launch-open
```

`wdio.conf.js` builds the debug binary (`cargo build` in `src-tauri/`), starts `tauri-driver`, and runs the specs in `specs/`.
The `test:launch-open` command starts Atrium under WebDriver, launches a second native process with `fixtures/launch-open.md` as a real argument, and verifies that the existing app opens it instead of showing the welcome screen.

## Coverage

`specs/smoke.e2e.js` covers these scenarios:

1. Open a folder, open `note.md`, verify the heading gets its live-preview class, edit, save, reload, and confirm the edit persisted to disk.
2. Open TOML and Terraform files, verify that each renders highlighted tokens, and confirm the status bar identifies its language.
3. Open `pixel.png` and verify the dedicated image pane loads it through the scoped asset protocol.
4. Open a terminal tab, run `echo`, and verify the output renders.
5. Split the active terminal pane, run a distinct command in each of the two resulting panes, confirm neither pane's output leaks into the other's, then close one pane and confirm the other survives with its output intact.
6. Open the project-wide search overlay via Cmd/Ctrl+Shift+F, search for a string that matches `note.md`, click the result, and confirm the overlay closes and the editor jumps to `note.md`.
7. Confirm the bottom status bar shows the active file's path and cursor position and updates as the caret moves, that its search button opens the search overlay, and that its explorer/terminal toggle buttons show and hide their respective panels.
8. (Follow-up, not yet in the spec) feed a synthetic buffer containing a PR URL and a unique partial file path with a line suffix, then verify both linkify and that clicking the file path opens the matching workspace file at that line.

The native folder-picker dialog lives outside the WebView, so the spec registers the workspace root directly through the same `workspace_set_root` command the picker's callback would call, rather than trying to drive the OS dialog. `workspace_set_root` also records the path as a recent project, so the spec reloads and clicks its row on the welcome screen to pick it up — everything downstream, including the workspace store update, exercises real app code.

`specs/unsavedChanges.e2e.js` covers the unsaved-changes close confirmation:

1. Edit `note.md`, click its tab's "×", click "Don't Save" in the confirmation dialog, and confirm the tab closes with the on-disk file unchanged.
2. Same setup, click "Save" instead, and confirm the on-disk file now contains the edit.

It also covers issue #250 (a failed save going silently unreported): `chmod`s `note.md` read-only, edits it, then confirms an `.error-toast` naming the file appears both via `Cmd+S` and via the editor context menu's Save item.

`specs/scrollThenClick.e2e.js` covers the rendered-markdown scroll-then-click regressions (issues #183 and #367).
It opens `long.md`, scrolls the pane down, clicks a visible rendered heading shortly after the scroll on a pane that has never yet been clicked into, and confirms both that the scroll position is preserved and that the cursor resolves to the heading's source line rather than the pre-scroll location.
These are real-display, real-input-timing bugs that jsdom/vitest tests cannot exercise (see `tests/frontend/scrollSettleMousedown.test.ts` for the unit-level coverage of the fix's mechanics).

`specs/horizontalRuleCursor.e2e.js` covers issue #366: open `horizontal-rule.md`, click rendered text below a horizontal rule, and confirm the cursor position remains on the clicked source line.

`specs/issue359.e2e.js` covers issue #359: place the caret at a rendered Markdown visual wrap boundary, click the terminal, wait through CodeMirror's next measure cycle, and confirm the terminal retains focus while the preview hides its raw marker.

`specs/launchOpen.e2e.js` covers issue #362 by launching a second native application process with a file path argument, then verifying that the single-instance handoff opens the requested file in the existing editor and removes the welcome screen.
This focused spec runs under Xvfb in Linux CI.

`specs/keyboardShortcuts.e2e.js` covers issue #156's two kinds of shortcut:

1. The five file-explorer shortcuts, which are plain DOM `keydown` handlers scoped to whichever tree row holds focus rather than native accelerators (see the plan's safety-constraint note): click a row to focus it, press ⌘N, type a name, and confirm the new file appears in the tree; press F2 on that file's own row and confirm the inline rename opens prefilled with its current name; press ⌘⌫ and confirm the permanent-delete confirmation modal opens (and the entry survives) before actually deleting it via the modal's own button.
2. The four split-direction shortcuts, which unlike the explorer shortcuts *are* native `main.rs` accelerators — reached the same way this suite's own Cmd+Shift+F/Cmd+P/Cmd+S accelerator tests already reach theirs, by sending the raw key combo via `browser.keys()` rather than clicking a per-pane split button: click into a terminal pane, press ⌥⌘→, and confirm a second `.xterm-screen` appears; click into an editor pane, press ⌥⌘↓, and confirm a second `.editor-panel` appears.

## Status

The focused launch-open spec runs in Linux CI.
The broader smoke suite still requires a real Linux or Windows display and is not part of the default CI workflow.
