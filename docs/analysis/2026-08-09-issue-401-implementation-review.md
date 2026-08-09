# Implementation review: configurable rendered-markdown max width (issue #401)

**Round 1 of 2. Verdict: request changes.** One must-fix, four nice-to-haves.

- **Target:** commit `5249709` ("feat(markdown): make rendered markdown max
  width configurable") on branch `feat/markdown-preview-max-width`.
- **Approved plan:** `docs/analysis/2026-08-09-issue-401-markdown-max-width-plan.md`
  (final revision, approved in
  `docs/analysis/2026-08-09-issue-401-plan-review-round-2.md`).
- **Checkout freshness:** verified — `HEAD` already contains `origin/main`, so
  every claim below about current file contents is against fresh code.
- **No pull request exists for this branch** (`gh pr list --head
  feat/markdown-preview-max-width` returns empty), so this verdict is delivered
  over the requester's own channel only. Nothing was written to GitHub.

The single must-fix is a behavioral gap, not a plan-conformance failure: the
implementation matches the approved plan essentially line for line. The defect
is one the plan never considered, and it is exactly the class of problem the
skipped manual check exists to catch.

## Checks run

Both were run in this worktree at `5249709` and both pass.

| Check | Result |
|---|---|
| `npm run check` (`svelte-check --fail-on-warnings`) | exit 0 — `780 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS` |
| `npm test` (vitest) | exit 0 — `Test Files 130 passed (130)`, `Tests 1680 passed (1680)`, 84.5s |

The developer's reported figures are accurate: 0 errors / 0 warnings, 130 test
files, 1680 tests. No flakiness observed in the single run performed.

## Plan conformance

Every item in the approved plan is implemented, and the two round-2
implementation notes the requester singled out are both correctly folded in.

| Plan section | Status |
|---|---|
| §1 store `src/lib/stores/proseWidth.ts` | Matches. Options tuple, type, default 80, type guard, `load`/`save` with try/catch, `writable` seeded from `load()`, `setProseWidth` set-and-persist, `proseWidthCssValue`. Storage key `atrium.markdown.proseWidth` follows the `atrium.markdown.defaultView` convention. |
| §2 `EditorPane.svelte` application | Matches. Concatenated into the `style` attribute (not `style:--custom-prop`), applied unconditionally, with the jsdom rationale retained as a comment. |
| §3 registry entry | Matches verbatim, placed immediately after `"default-view"` as required. |
| §4 `SettingsDialog.svelte` row | Matches verbatim, placed immediately after the `"default-view"` block as required. |
| §5 `decorations.ts` docstrings | **Both** updated. `NARROW_COLUMN_MAX_CHARS` (`decorations.ts:743-749`) drops the "small fraction" framing; `MAX_NARROW_COLUMNS` (`decorations.ts:752-762`) replaces the stale "65ch" sentence. Both now cite the 60ch floor and point at `PROSE_WIDTH_OPTIONS`. This was round-2 note 2, and it is fully honored — not the one-docstring half-fix. |
| §6 `app.css` comment | Matches verbatim. |
| Testing §1 `proseWidth.test.ts` | Matches, plus one extra case beyond the plan (mistyped string `"80"` rejected). |
| Testing §2 `EditorPane.proseWidth.test.ts` | Matches: default, changed numeric preset, `"full"` → `100cqw`, and live update after mount without remount. The jsdom limitation is stated in a file-level comment rather than presented as layout coverage. |
| Testing §3 `SettingsDialog.test.ts` | Matches. The new block uses `screen.getByLabelText("Max width of rendered markdown")`, **not** the shared `dropdownTrigger(container)` helper, with a comment explaining the first-match-in-DOM-order hazard. `proseWidth.set(DEFAULT_PROSE_WIDTH)` was added to the top-level `beforeEach` reset list (`SettingsDialog.test.ts:65`). This was round-2 note 1, correctly honored. |

Independent re-verification of the plan's load-bearing claims:

- **Consumer inventory is complete.** Grepping `--atrium-prose-max-width`
  across `src/` finds exactly the declarations in `app.css:57` and
  `EditorPane.svelte:749`, and five uses in `markdown.css` (`:50-51`,
  `:136-137`, `:563-564`, `:600`, `:634-635`). No consumer was missed.
- **`EditorPane` is the only mount site for rendered markdown.**
  `markdownExtensions` is imported in exactly one file
  (`EditorPane.svelte:37`), so setting the property on `.editor-pane` reaches
  every rendered-markdown surface in the app.
- **The `"full"` → `100cqw` mapping is sound.** `container-type: inline-size`
  is declared on `.cm-scroller` (`markdown.css:15-17`), which is a descendant
  of `.editor-pane` and an ancestor of `.cm-line`. Because
  `--atrium-prose-max-width` is an unregistered custom property, its value
  substitutes as a token stream into `.cm-line`'s own declaration, so the
  `cqw` unit resolves against `.cm-scroller` — the pane's visible width. With
  `"full"`, `max-width: min(100cqw, 100cqw)` is the pane width and
  `margin-inline-start: max(0px, (100cqw - 100cqw) / 2)` is `0px`. Notably,
  "Full" therefore means *pane* width, not `.cm-content` width, so it does not
  reintroduce the sideways-scroll regression that `markdown.css:4-14`
  documents.
- **No pre-existing test needed updating.** `EditorPane.activation.test.ts`'s
  `toContain("font-size: 150%")` still holds against the longer style string;
  `decorations.test.ts`'s `markdown.css` rule-body assertions are untouched
  because `markdown.css` is unchanged; `SettingsDialogSearchSections.test.ts`
  mocks its own section list. All confirmed green by the full run above.

## Must-fix

### 1. Changing the setting on an open pane never triggers a CodeMirror re-measure

**Where:** `src/lib/editor/EditorPane.svelte:749` (and the absence of any
`$effect` keyed on `$proseWidth`).

**What is wrong.** `--atrium-prose-max-width` changes `.cm-line`'s `max-width`,
which changes where rendered prose wraps, which changes every line's height.
CodeMirror caches line heights in its height map and only refreshes them during
a measure pass. This change gives it no way to learn that heights moved:

- It dispatches no transaction. Every *other* layout-affecting setting in this
  file does — word wrap (`:570`), tab size (`:582`), minimap (`:179`), theme
  (`:533`), view mode (`:637`) all go through `view.dispatch(...compartment
  .reconfigure(...))`, which drives CodeMirror's own measure cycle.
- It calls no `view.requestMeasure()`. The two effects in this file that change
  layout without a natural transaction both do call it explicitly
  (`:642`, `:665`), and the comment at `:616-620` states the reason directly:
  an explicit measure "guarantees a fresh measure pass re-derives the viewport
  from actual rendered DOM heights rather than relying on CodeMirror's
  implicit, best-effort async convergence."
- No resize observer covers it. In `@codemirror/view@6.43.6` (the pinned
  version in `node_modules`), the only `ResizeObserver` in the view layer is
  `resizeScroll.observe(view.scrollDOM)` (`dist/index.js:7188-7194`). Since
  `.editor-pane` and `.cm-editor` are both `height: 100%`
  (`EditorPane.svelte:790-797`), `.cm-scroller`'s own border box does not
  change when its content re-wraps, so that observer does not fire.

**Failure scenario.** Open a markdown file long enough to scroll (a few hundred
rendered lines) in rendered view, scroll to the middle, open Settings →
Markdown → Max Width and switch 80ch → 60ch. The CSS re-wraps immediately, so
every prose line gets taller and the document's real height grows
substantially, but CodeMirror's height map still holds the 80ch heights. The
scroll height and the viewport range it renders are both computed from stale
numbers: the scrollbar thumb is sized wrong, and for a long document the
rendered viewport can end short of the visible area (blank space or
mispositioned content below the fold) until some unrelated event — a scroll, a
keystroke, a tab switch — forces a measure and it converges.

**Confidence.** Moderate-high on the mechanism (traced through the pinned
CodeMirror source, this file's own precedents, and the pane's box model);
moderate on how visible the artifact is, which scales with document length and
scroll offset. **This is traced, not reproduced** — no browser engine is
available in this environment either (see below), so I could not demonstrate
the wrong pixels. If the developer can run the app and show that CodeMirror
converges on its own here, closing this with that evidence is a legitimate
resolution.

**Suggested fix** — one guarded `$effect`, mirroring the two that already exist
at `:622-643` and `:658-668`:

```ts
let lastAppliedProseWidth: ProseWidth | undefined;

$effect(() => {
  const width = $proseWidth;
  if (!view || width === lastAppliedProseWidth) return;
  lastAppliedProseWidth = width;
  view.requestMeasure();
});
```

The measure is scheduled for the next animation frame, after Svelte has written
the new `style` attribute and the browser has re-laid-out, so it reads the new
geometry. Cost is one frame of work on a setting change; it is unconditionally
safe.

**Follow-up, out of scope for this change:** `zoom` has the same shape — it is
the other pure-CSS setting on `.editor-pane` (`:749`), it changes line heights
via `font-size`, and it likewise dispatches nothing and requests no measure. If
the fix above proves necessary, zoom deserves the same treatment in its own
change.

## Nice-to-have

### 2. No findability test for the new setting's search keywords

`SettingsDialog.test.ts:1087-1120` is an explicit convention block —
`describe("search: new settings are findable")` — with one test per setting
whose registry keywords add synonyms beyond its title (Word Wrap via `"wrap"`,
Auto Save via `"autosave"`, Restore Tabs on Startup via `"reopen"`). Max Width
adds four such synonyms (`"reading width"`, `"line length"`, `"column"`,
`"prose"`) and gets no test, so a typo in any of them would ship silently. One
test asserting `screen.getByRole("heading", { name: "Max Width" })` after
searching e.g. `"line length"` closes it.

### 3. The `dropdownTrigger` helper is still an order-fragile trap

The new block correctly avoids `dropdownTrigger(container)`
(`SettingsDialog.test.ts:737-740`) and documents why. But the neighbouring
`markdown default view` block (`:819-828`) still uses it, and it only keeps
testing the right dropdown because Max Width is ordered after Default View in
both the registry and the markup. Reordering the two sections would make that
test silently assert against the wrong control rather than fail. The plan
consciously chose to record this rather than fix it, so this is not a
conformance miss — but switching that block to
`screen.getByLabelText("Default view for markdown files")`
(`SettingsDialog.svelte:311`) removes the trap in one line and makes both
markdown blocks robust by the same mechanism.

### 4. Residual vague phrasing in the `MAX_NARROW_COLUMNS` docstring

`decorations.ts:755` still reads "inside the narrowest
`--atrium-prose-max-width` anyone is plausibly running." That wording made
sense when the floor was a guess; two sentences later the same docstring now
names the concrete 60ch floor and its constant. The plan only asked for the
stale "65ch" sentence to be replaced, so this is not a miss — but "the
narrowest width the Max Width setting offers" would make the whole docstring
say one thing.

### 5. The `"full"` mechanism has an undocumented dependency

"Full" works only because `--atrium-prose-max-width` is an *unregistered*
custom property, so `100cqw` substitutes as tokens into `.cm-line`'s
declaration and resolves against `.cm-scroller`. There is no `@property`
declaration anywhere in `src/` today, so this holds. If someone later registers
it as `syntax: "<length>"`, the value would compute at the declaring element
(`.editor-pane`), which has no query-container ancestor, and `100cqw` would
fall back to resolving against the viewport — silently making "Full" wider than
the pane in a split layout. One line in `proseWidthCssValue`'s docstring
("depends on this property staying unregistered — a registered `<length>` would
compute `cqw` at `.editor-pane`, which is not the query container") would keep
that from being rediscovered the hard way.

## On the missing manual/visual check

**My assessment: the gap is not acceptable as-is, and finding 1 is the
concrete reason.**

I tried to close it independently rather than take a view on faith. Chromium
binaries are present under `~/.cache/puppeteer` and `~/.cache/ms-playwright`,
and I built a layout harness loading the real `app.css` and `markdown.css`
against a stand-in `.editor-pane` / `.cm-scroller` / `.cm-content` / `.cm-line`
tree to measure computed widths and insets per preset. Every binary fails to
start: `error while loading shared libraries: libnspr4.so`. `ldconfig` confirms
`libnspr4`/`libnss3` and `webkit2gtk` are all absent from this machine, which
independently corroborates the developer's report that no native Tauri build
and no browser-driven check was possible. Installing those libraries needs
root, which no agent session here has.

So the honest position is:

- **The static-substitution half of the feature is verified to a high
  standard.** Which value lands in the style attribute per preset is asserted
  by unit tests for all five presets; that the property inherits to `.cm-line`
  is guaranteed by custom properties being inherited with no intervening
  declaration (grep-confirmed); and the `min()`/`max()` arithmetic for both the
  `ch` and `cqw` cases resolves by inspection with no ambiguity. I would not
  ask for a manual check to confirm any of that.
- **The dynamic half is not verified at all, and that is where the defect
  is.** Nothing in the test suite or in two rounds of plan review could have
  surfaced finding 1, because jsdom does not lay out, does not wrap text, and
  does not run CodeMirror's measure cycle. "The style attribute updates
  reactively" and "the editor correctly re-renders after it updates" are
  different claims, and only the first is tested.

That is the actual shape of the risk: not that the widths are wrong, but that
changing the setting on a live pane leaves the editor in a stale layout state.
It is worth one look at the running app before this lands — and if that look is
still impossible, applying the one-line `requestMeasure()` defensively is the
right call, since it is cheap, unconditionally safe, and matches how every
comparable change in this file is already handled.

## Summary

The implementation is faithful to the approved plan, well-commented, and
cleanly tested for everything a jsdom suite can reach; `npm run check` and
`npm test` are both green at the reported figures. Fix finding 1 (or close it
with evidence from the running app), and this is ready.
