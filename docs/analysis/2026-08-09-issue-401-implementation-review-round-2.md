# Implementation review: configurable rendered-markdown max width (issue #401)

**Round 2 of 2 (final). Verdict: approve.** No must-fix items. Two
nice-to-haves and one restated follow-up, none blocking.

- **Target:** commit `7492fbd` ("fix(markdown): force a CodeMirror re-measure
  on max-width change") on branch `feat/markdown-preview-max-width`, reviewed
  as the cumulative branch state (`5249709` + `7492fbd`).
- **Round 1:** `docs/analysis/2026-08-09-issue-401-implementation-review.md`
  (request changes: one must-fix, four nice-to-haves).
- **Approved plan:**
  `docs/analysis/2026-08-09-issue-401-markdown-max-width-plan.md`.
- **Checkout freshness:** verified — `git-freshness-check.sh` reports
  `fresh:HEAD already contains origin/main`, so every claim below about
  current file contents is against fresh code.
- **No pull request exists for this branch** (`gh pr list --repo
  greerviau/atrium --head feat/markdown-preview-max-width` returns `[]`), so
  this verdict is delivered over the requester's own channel. Nothing was
  written to GitHub.

## Checks run

Both re-run independently in this worktree at `7492fbd`; both pass, at exactly
the figures the developer reported.

| Check | Result |
|---|---|
| `npm run check` (`svelte-check --fail-on-warnings`) | exit 0 — `780 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS` |
| `npm test` (vitest) | exit 0 — `Test Files 130 passed (130)`, `Tests 1683 passed (1683)`, 81.7s |

The test count moved 1680 → 1683, matching the three tests this commit adds
(two in `EditorPane.proseWidth.test.ts`, one in `SettingsDialog.test.ts`). No
flakiness observed. The code delta outside `docs/` is 5 files, +78/-6 — no
drive-by changes rode along with the fix.

## Round-1 findings: disposition

### Must-fix 1 — no CodeMirror re-measure on a max-width change: **fixed, and verified behaviorally**

`EditorPane.svelte:586-604` adds the guarded `$effect`, and it is the right
fix, implemented in the file's own idiom (`lastAppliedProseWidth` declared
alongside the other `lastApplied*` guards at `:105`; the same
`if (!view || unchanged) return` shape as the word-wrap, view-mode, and
activation effects).

I did not take this on inspection. Behavior was measured directly, by spying
on `EditorView.prototype.requestMeasure` around a mounted pane in a throwaway
vitest file (since removed — the working tree is clean):

| Action | `requestMeasure` calls |
|---|---|
| `proseWidth.set(60)` on a mounted pane (real change) | 1 |
| `proseWidth.set(60)` again (no-op re-publish) | 0 |
| `proseWidth.set("full")` | 1 |

So the effect fires exactly once per real change and the guard genuinely
suppresses redundant store publishes; it is not firing on every unrelated
flush. The pane's `style` attribute was confirmed to carry the new value
(`--atrium-prose-max-width: 100cqw`) at the same point.

Two supporting facts I checked rather than assumed:

- **`requestMeasure()` with no argument is not a no-op.** In the pinned
  `@codemirror/view@6.43.6`, `requestMeasure(request)`
  (`dist/index.js:8345-8347`) schedules `this.measure()` on the next animation
  frame whenever none is pending, independent of whether a `request` object is
  passed; the `request` argument only adds a keyed read/write callback to the
  queue. `measure()` (`:8157+`) runs the full pass — flushes the DOM observer
  and re-derives heights and viewport from actual geometry. This is the same
  call the view-mode (`:678`) and activation (`:693`) effects already rely on.
- **Ordering is safe.** Svelte 5 runs template render effects before user
  effects in a flush, so the new `style` attribute is written before the
  effect body runs; and `requestMeasure` defers to `requestAnimationFrame`
  regardless, so the measure reads geometry after the browser has applied the
  new style. The fix does not depend on the ordering happening to be right.

### Nice-to-haves 2-5 — all four addressed

| Round-1 item | Disposition |
|---|---|
| 2. No findability test for the new search keywords | Fixed. `SettingsDialog.test.ts:1125-1135` searches `"line length"` and asserts the `Max Width` heading. Keyword confirmed present at `settingsRegistry.ts:94`; the test passes in the full run. |
| 3. `dropdownTrigger` order-fragile trap in the default-view block | Fixed. `SettingsDialog.test.ts:829` now uses `screen.getByLabelText("Default view for markdown files")`; that accessible name exists at `SettingsDialog.svelte:315`. The helper is still used by nine other blocks, so nothing is left unused. |
| 4. Vague `MAX_NARROW_COLUMNS` docstring wording | Fixed. `decorations.ts:755-756` now reads "the narrowest width the Max Width setting offers", consistent with the concrete 60ch floor two sentences later. |
| 5. Undocumented dependency on the property staying unregistered | Fixed. `proseWidth.ts:49-54` documents it, with the correct mechanism (a registered `<length>` would compute `cqw` at `.editor-pane`, outside the query container). Re-confirmed the dependency still holds: grepping `@property` across `src/` finds only this docstring's own mention — no registration exists. |

## Nice-to-have

### 1. The second new test asserts something its name says it verified, and it did not

**Where:** `tests/frontend/EditorPane.proseWidth.test.ts:100-113`, `it("does
not request a measure on mount for the already-applied default")`.

The test installs its spy *after* `render()` and `await tick()` — after the
mount flush has already completed. It therefore cannot observe mount-time
behavior at all; what it actually verifies is the weaker (still useful) claim
that no *further* measure fires on an idle tick once the pane has settled.

The named claim is also false. Two measurements:

- Spying *before* `render()` shows 5 `requestMeasure` calls during mount (from
  this and the other measure-requesting effects combined).
- Decisively for this effect specifically: after mount, re-publishing the
  default (`proseWidth.set(DEFAULT_PROSE_WIDTH)`) fires **0** measures. That
  is only possible if `lastAppliedProseWidth` was already set to `80` during
  mount — i.e. the effect ran at mount with `view` assigned and did call
  `view.requestMeasure()`. (`view` is created in `onMount` at
  `EditorPane.svelte:456`, which Svelte registers before this effect, so it is
  truthy on the effect's first run and the `undefined` initial guard value
  never suppresses it.)

**Why this is not a must-fix.** The mount-time measure costs nothing:
`requestMeasure` only schedules an animation frame when none is pending
(`dist/index.js:8346`), so all five mount-time calls coalesce into a single
measure pass before first paint. The behavior is fine; only the test's
description is wrong. It matches the shape of the neighbouring effects anyway
— the word-wrap and tab-size effects also fire once at mount off an
`undefined` guard.

**Suggested fix:** rename to what it verifies, e.g. "does not request a
further measure when the setting has not changed". Asserting the true
mount-time count instead is possible but not worth it — the count is shared
with unrelated effects, so it would be a brittle assertion on a number that
has nothing to do with this feature.

### 2. A committed comment claims a manual verification that did not happen

**Where:** `tests/frontend/EditorPane.proseWidth.test.ts:28-31` (file-level
comment): "...this can't assert that the property actually cascades to
`.cm-content` or changes the rendered column's width — **that's verified
manually against the running app**."

No such check was performed. No browser engine or native build works in this
environment: Chromium binaries under `~/.cache/puppeteer` and
`~/.cache/ms-playwright` fail with `libnspr4.so` missing, and `libnss3` /
`webkit2gtk` are absent from the machine (round 1 established this
independently and I re-confirmed the environment is unchanged). The first half
of the comment is valuable and accurate; the last clause states as done
something nobody here could do, and a future reader would reasonably rely on
it.

Recommend rewording to what is true, e.g. "...— that needs a look at the
running app, which the test suite cannot substitute for."

## Follow-up (out of scope, restated from round 1)

`zoom` still has the identical shape and is still unhandled: it is written
into the same `style` attribute (`EditorPane.svelte:769`), changes line
heights via `font-size`, dispatches nothing, and requests no measure. That is
pre-existing behavior this branch does not touch or worsen, but the branch
does create an asymmetry — the two settings sharing that one attribute now
behave differently. Worth its own change.

## On the missing manual/visual check

**I agree with round 1's judgment: the `requestMeasure()` fix is an acceptable
resolution without visual evidence, and I would not hold the branch for
evidence that cannot be produced here.** Stated as a judgment call, not as a
claim that the visual behavior was confirmed.

The reasoning, now stronger than it was in round 1:

- The fix is unconditionally safe and bounded. Worst case, the setting was
  already converging on its own and this schedules one redundant measure pass
  per setting change — coalesced into a single animation frame, on a
  user-initiated action that happens at human frequency.
- The mechanism is verified end to end at every layer reachable without a
  browser: the effect fires exactly once per change and never on a no-op
  (measured, above); `requestMeasure()` with no argument provably schedules
  `measure()` in the pinned dependency (read in `node_modules`); and
  `measure()` is the same pass two neighbouring effects in this file already
  depend on for exactly this purpose.
- What remains unverified is unchanged from round 1 and is not specific to the
  fix: that rendered prose visually re-wraps and re-centers correctly at each
  preset. That is a property of the CSS, which this commit does not touch, and
  whose arithmetic resolves by inspection.

The residual risk is that the stale-height-map defect round 1 traced was never
real, in which case this commit adds a harmless no-op. That asymmetry — cheap
if unnecessary, correct if necessary — is what makes it the right call to
land.

## Summary

The round-1 must-fix is fixed, correctly and idiomatically, and I verified the
fix behaviorally rather than by inspection. All four nice-to-haves are
addressed. `npm run check` and `npm test` are green at the reported figures,
independently re-run. The two remaining items are wording accuracy in a test
name and a test comment; neither affects behavior and neither should hold the
branch. Ready to land.
