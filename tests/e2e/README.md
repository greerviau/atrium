# End-to-end smoke tests

WebDriver-based smoke tests via `tauri-driver`, per the plan's testing strategy (implementation plan section 8).

## Prerequisites

These tests drive the actual compiled app through its native WebView, so they need a machine with a display and the full Tauri build toolchain — they cannot run in a headless CI container or a sandbox without system WebView libraries.

- macOS or Linux with a display.
- Rust toolchain, plus the Tauri v2 system dependencies for your platform ([webkit2gtk etc. on Linux](https://v2.tauri.app/start/prerequisites/), Xcode command line tools on macOS).
- `cargo install tauri-driver` (once).

## Running

```sh
cd tests/e2e
npm install
npm test
```

`wdio.conf.js` builds the debug binary (`cargo build` in `src-tauri/`), starts `tauri-driver`, and runs the specs in `specs/`.

## Coverage

`specs/smoke.e2e.js` covers these scenarios:

1. Open a folder, open `note.md`, verify the heading gets its live-preview class, edit, save, reload, and confirm the edit persisted to disk.
2. Open a terminal tab, run `echo`, and verify the output renders.
3. Open the project-wide search overlay via Cmd/Ctrl+Shift+F, search for a string that matches `note.md`, click the result, and confirm the overlay closes and the editor jumps to `note.md`.
4. Confirm the bottom status bar shows the active file's path and cursor position and updates as the caret moves, that its search button opens the search overlay, and that its explorer/terminal toggle buttons show and hide their respective panels.
5. (Follow-up, not yet in the spec) feed a synthetic buffer containing a PR URL and a real file path and verify both linkify and that clicking the file path opens it in the editor.

The native folder-picker dialog lives outside the WebView, so the spec registers the workspace root directly through the same `workspace_set_root` command the picker's callback would call, rather than trying to drive the OS dialog. `workspace_set_root` also records the path as a recent project, so the spec reloads and clicks its row on the welcome screen to pick it up — everything downstream, including the workspace store update, exercises real app code.

## Status

Written against the plan but **not executed** in the environment this was developed in (no display, no system WebView libraries, no macOS). Run this suite on a real dev machine or in CI on `macos-latest` before relying on it — treat it as a starting point to verify and adjust selectors/timing against, not as already-passing.
