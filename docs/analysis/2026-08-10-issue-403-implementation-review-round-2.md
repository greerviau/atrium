# Implementation review round 2 (confirming pass): CSV/Parquet default-open (issue #403)

- **Under review:** PR #419, head commit `ba8b703` ("test(e2e): assert the CSV launch-open tab is actually displayed"), branch `fix/parquet-csv-default-open`
- **Previously approved at:** `97a53ef`, in `docs/analysis/2026-08-10-issue-403-implementation-review-round-1.md`
- **Scope of this pass:** confirm the one commit added since the approved review is only the agreed test tightening, and confirm CI is green. This is a confirming pass, not a new substantive review round; the round-1 analysis of the implementation itself stands unchanged.
- **Freshness:** `fresh:HEAD already contains origin/main`; 2 commits ahead of `origin/main`, 0 behind; working tree clean; GitHub reports the PR `MERGEABLE`

## Verdict

**Approve.** No must-fix items.

The delta is exactly what was agreed, CI is green on every job at this head, and the one
condition round 1 left open before merge (the new e2e case had never actually been
executed anywhere) is now closed by an observed green run.

---

## The delta is what it claims to be

`git diff 97a53ef..ba8b703` touches two files and nothing else:

| File | Change |
|---|---|
| `docs/analysis/2026-08-10-issue-403-implementation-review-round-1.md` | New file, 188 lines. The round-1 review findings, committed alongside the plan and plan-review documents already in this branch. |
| `tests/e2e/specs/launchOpen.e2e.js:39` | One line: `dataPane.waitForExist({ timeout: 10000 })` becomes `dataPane.waitForDisplayed({ timeout: 10000 })`. |

No production code, no configuration, no Rust, no TypeScript, no test other than that one
line. So the entire round-1 verification of `tauri.conf.json`, `src-tauri/linux/atrium-mime.xml`,
the packaged `.deb`, the generated `.desktop` MIME list, the dpkg trigger, and the macOS
`contentTypes`/`exportedType` reasoning carries over untouched and does not need re-deriving.

The test change is round-1's nice-to-have item 1, applied as written. It is a
strengthening, not a behavior change: `waitForExist` passed as long as a data-mode pane
existed anywhere in the DOM, and `EditorPanel.svelte` keeps every open tab's pane mounted,
hiding inactive ones with `display: none`. `waitForDisplayed` additionally requires the
pane to be visible, so the assertion now means what the test title says. Only one
`.data-pane` is ever mounted in this suite (the preceding case opens a markdown file,
which renders in the text editor), so the bare `$(".data-pane")` selector cannot pick up a
different, hidden pane and give a false pass.

The doc commit is consistent with this repository's existing convention: `docs/analysis/`
already carries plan, plan-review, and implementation-review files for issues #400, #401,
and #403.

Round 1's nice-to-have item 1 also suggested asserting the visible tab name is
`launch-open.csv`. That was not done and is not required; the displayed-pane check
already distinguishes the data grid from the text editor, which is the behavior issue #403
is about.

## CI is green at this head

`gh pr checks 419` reports four checks, all `pass`, and workflow run `31349094296` has
`head_sha = ba8b7033bd283809e6849a652c6ff124a5ae36d4` - this exact commit, not an earlier
one:

| Check | Result |
|---|---|
| `check-and-test` (ubuntu) | pass, 1m15s |
| `rust-check (ubuntu-latest)` | pass, 5m29s |
| `rust-check (macos-latest)` | pass, 4m37s |
| `rust-check (windows-latest)` | pass, 6m37s |

The two conditions round 1 asked to confirm before merge are both closed by the
`rust-check (ubuntu-latest)` job, whose step list I read directly rather than inferring
from the job's overall status:

- **Round-1 item 2 - the new e2e case had never been executed.** Step 14, "Test
  launch-time file open through the native process entry point", ran and succeeded. The
  job log shows the WebDriver `findElement("css selector", ".data-pane")` calls and then
  `2 passing (1s)`, `Spec Files: 1 passed, 1 total`. Both launch-open cases pass, including
  the new CSV one under the tightened assertion, and it resolved in about 200ms with no
  sign of retry pressure against the 10s timeout.
- **Round-1 item 3 - only `deb` was built locally, CI builds `deb,appimage`.** Step 12,
  "Build native packages", ran `--bundles deb,appimage` and succeeded. The new
  `bundle.linux.deb.files` entry does not break the AppImage build.

The AppImage caveat round 1 disclosed still holds and is unchanged by this: the MIME XML
lands inside the AppImage but an AppImage has no install step to register it. That is a
known, documented limitation of the approach, not a defect introduced here.

## Not verified here

- Whether Atrium appears in the native "Open With" / default-apps picker on macOS or
  Windows after a real installer run. Same human-hardware gap as round 1 and PR #398;
  not closeable from this environment.
- The e2e suite was observed passing on one CI run, not repeatedly. A single green run is
  not a flakiness measurement, though the sub-second resolution against a 10s timeout
  gives no reason for concern.

## Nice-to-have

None new. Round 1's items 4 and 5 (commit-message wording on the macOS inference
mechanism; "Text Document" still claiming CSV by UTI conformance) remain as recorded there
and were explicitly not recommended for action.

## Open questions

None.
