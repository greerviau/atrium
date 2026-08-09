# Review: implementation plan for issue #400 (highlight the currently open file)

- **Artifact reviewed:** `docs/analysis/2026-08-09-issue-400-highlight-open-file-plan.md`
- **Requirement reviewed against:** issue #400 - "The file that is currently open in the editor should be the one highlighted in the file explorer. If no file is open, no file should be highlighted."
- **Code state:** checkout verified fresh against `origin/main` (`fresh:HEAD already contains origin/main`); the plan file is identical on both.
- **Verdict: request changes.** Three must-fix items, two nice-to-haves.

## Summary

The plan's mechanism is right and its reading of the code is accurate: `tabsState.activeTabPath`
really is the canonical "currently open file" (`src/App.svelte:508-516` keeps it mirrored to the
focused pane's own active tab), `--atrium-bg-active` really is defined for every theme
(`src/lib/theme/tokens.ts:67,110,153`), and the tab strip really does use it for its own active tab
(`src/lib/editor/EditorPanel.svelte:151,281`). Threading an `openPath` prop into `FileTreeNode` and
marking the row with `aria-current` is a sound, minimal way to get the signal into the explorer.

The problem is what the plan leaves untouched. It adds a *second* highlight next to the explorer's
existing one and never reconciles the two, so it does not deliver either half of the issue's
acceptance criteria:

- the existing selection highlight still paints when **no file is open** (violating the issue's
  second sentence), and
- the existing selection highlight still paints on a **different row** than the open file, more
  prominently than the new one (violating "should be **the one** highlighted").

Both were reproduced against the real components, not inferred. I rendered `FileTree.svelte` in the
existing Vitest harness (the `FileTreeKeyboardNav.test.ts` setup) and read back every row carrying
the highlight; the probe was removed afterward, so the tree is unmodified.

## Must-fix

### 1. "No file open" still highlights a row - the issue's second requirement is not met

`FileTree.svelte:115-120` derives `selectedPaths` with a fallback that is never empty while the tree
has rows:

```js
if (selected.size > 0) return selected;
return activePath === null ? new Set<string>() : new Set([activePath]);
```

and `FileTreeNode.svelte:199-201` paints every `aria-selected="true"` row with
`--atrium-selection-bg`. Neither is touched by the plan, so:

| Scenario | Observed highlighted rows |
|---|---|
| Project opened, no file ever opened | `/workspace` (the root row) |
| Open `a.txt`, then close the only tab (`activeTabPath` is now `null`) | `/workspace/a.txt` - still highlighted |

The second row is the damning one: a user opens a file, closes it, and the explorer still shows that
file highlighted in blue. The plan's own test list ("`activeTabPath: null` (no tabs open) - no row
has `aria-current="true"`") passes in that state while the user-visible requirement fails, so the
proposed test suite gives false confidence on exactly the criterion it is meant to cover.

Fix direction (developer's call on the exact shape): the highlight *fill* must be owned by
`activeTabPath`, not by explorer selection. The cleanest small change is to stop painting a fill for
a single implicit/collapsed selection - keyboard/click feedback for one row is already carried by
`.row:focus` (`FileTreeNode.svelte:209-213`) - and reserve the fill for the open file, keeping a fill
for `explicitSelectedPaths` only when it is a genuine multi-row range. Note that the `aria-selected`
*semantics* can stay exactly as they are; only the CSS that paints them needs to change, which keeps
`FileTreeKeyboardNav.test.ts:180-191` ("marks aria-selected='true' on exactly the focused row") green.

### 2. Two rows highlighted at once, with the wrong one dominant

With `a.txt` clicked in the explorer and then `src/index.ts` made active from the tab strip (the
exact flow the plan's Problem section is written about), the explorer ends up with `a.txt` carrying
`aria-selected="true"` and `index.ts` carrying the new `aria-current="true"`. Reproduced.

The plan's `:not([aria-selected="true"])` guard prevents the two backgrounds colliding on one row,
but does nothing about them landing on two different rows - and the relative strengths are backwards:

| Token | Dark | Light |
|---|---|---|
| `--atrium-selection-bg` (stale explorer selection) | `rgba(91,157,255,0.25)` - tinted blue | `rgba(26,115,232,0.15)` |
| `--atrium-bg-active` (proposed open-file highlight) | `rgba(255,255,255,0.10)` | `rgba(0,0,0,0.07)` |
| `--atrium-bg-hover` (for scale) | `rgba(255,255,255,0.06)` | - |

The file the issue is about would be the *least* prominent mark in the explorer, barely separable
from hover, while a stale click from ten minutes ago stays the eye-catching blue row. The plan's
justification for keeping the two independent - "a user can multi-select a range of files (for a
bulk delete/move) while a completely different file stays open" - overstates today's code: nothing
consumes `selectedPaths` outside these two components (the context menu's delete and the drag
handler both act on a single path, `FileTree.svelte:250-254`, `FileTreeNode.svelte:112-114`), so the
multi-selection is presently visual-only. That is a weak reason to let it outrank the feature being
built.

Fix direction: give the open-file row the dominant treatment and demote (or drop, for the single-row
case) the selection fill, per item 1. If both marks are kept, they must be visually distinguishable
*and* the open one must be the stronger.

### 3. Nothing is highlighted at startup, the moment the feature matters most

Tree expansion is not persisted: `loadRoot` (`src/lib/stores/fileTree.ts:36-45`) builds a fresh root
with `expanded: true` and every child `expanded: false` (`toNode`, line 19-21), and children load
lazily. `flattenVisible` (`FileTree.svelte:82-94`) only emits rows under expanded ancestors, so a row
for a file in a subdirectory **does not exist in the DOM** until the user expands its way down.

So on a cold start with a restored session whose active tab is `src/index.ts`, the plan produces no
visible change at all: no row exists to carry `aria-current`. The same holds for any open triggered
from outside the explorer - a terminal link, a markdown link, an OS-file-manager open (#398) - into a
collapsed directory. The feature would only work when the user had already navigated to the file's
folder, which is close to the pre-existing coincidental behavior the plan's Problem section
criticizes.

The plan does not mention reveal, expansion, or scroll-into-view anywhere, and states "Open
questions: None." At minimum this must become an explicit, recorded decision. My recommendation is
to implement it: on `activeTabPath` change, expand+`loadChildren` the ancestor chain under the
workspace root and scroll the row into view (`FileTree.svelte:140-148` already has the
`tick()`-then-query-the-row pattern to build on). Guard for the path being outside the root
(`isExternal` tabs, `src/lib/stores/tabs.ts:153-157`) and for the async expansion racing a rapid tab
switch. If the human prefers to defer reveal to a follow-up, that is a legitimate call - but it has
to be stated in the plan and agreed, not silently omitted, because it decides whether #400 is
actually satisfied on launch.

## Nice-to-have

### 4. The proposed selector silently outranks `:hover` and `:focus`

`.row[aria-current="true"]:not([aria-selected="true"])` has specificity (0,3,0);
`.row:hover` and `.row:focus` are both (0,2,0). The open-file row would therefore lose its hover
feedback entirely and, when focused without being selected, paint `--atrium-bg-active` instead of the
focus background (the outline still applies, so focus stays visible). Cosmetic, but it should be a
deliberate choice rather than a side effect - worth an explicit `:hover` rule ordered after it.

### 5. `StandaloneFileList` needs the same reconciliation, and its test note is understated

The plan's step 3 inherits items 1 and 2 verbatim: `StandaloneFileList.svelte:41-46` has the identical
never-empty `selectedPaths` fallback and the identical `--atrium-selection-bg` paint
(lines 180-182), so a tab-strip switch there also leaves two rows marked. Its "no file open" case is
benign only by accident - `rows` is derived from the tabs themselves (line 28), so with no tabs there
are no rows at all.

## What I checked and found correct

- `tabsState.activeTabPath` is the right source; no new store or aggregation is needed. Verified it
  is re-keyed on rename (`tabs.ts:533-541`) and cleared to `null` when the last tab closes
  (`tabs.ts:231-240`), so the plan does not need extra bookkeeping for either.
- Path strings match: explorer rows use `DirEntry.path` from `fs_list_dir` and open tabs are keyed by
  the same string passed straight through `openFile` (`tabs.ts:146-198`), so a `===` comparison is
  sound for explorer-originated opens.
- `aria-current` is a global ARIA attribute and is valid alongside `role="treeitem"`; keeping it
  distinct from `aria-selected` is the correct semantic split, and the existing a11y tests stay green.
- "No backend/Rust change, no doc updates" is accurate - nothing under `docs/` describes explorer
  highlight behavior today.

## Open questions

```wingman-questions
{
  "questions": [
    {
      "id": "reveal",
      "type": "choice",
      "question": "Should the explorer auto-reveal (expand ancestors and scroll to) the open file, or only highlight it when its row already happens to be visible?",
      "options": [
        { "label": "Auto-reveal", "recommended": true,
          "detail": "Without it the highlight is invisible on every cold start, since directory expansion is not persisted and subdirectories load collapsed - the feature would appear not to work." },
        { "label": "Highlight only",
          "detail": "Smaller change, but #400 is only satisfied when the user has already expanded the file's folder; reveal becomes a required follow-up." }
      ],
      "free_text": true
    },
    {
      "id": "selection",
      "type": "choice",
      "question": "How should the explorer's existing selection highlight coexist with the new open-file highlight?",
      "options": [
        { "label": "Open file owns the fill", "recommended": true,
          "detail": "Single-row selection is conveyed by the existing focus outline; the fill is reserved for the open file, so 'no file open' means no fill and the open file is always the one highlighted." },
        { "label": "Keep both, invert prominence",
          "detail": "Retains a fill for any selection but makes the open-file mark dominant; still leaves two rows filled at once and still highlights a row when no file is open." },
        { "label": "Clear selection when no tab is open",
          "detail": "Narrowest fix for the 'no file open' case only; leaves the two-rows-highlighted ambiguity of item 2 unaddressed." }
      ],
      "free_text": true
    }
  ]
}
```

## How to verify a revision

Component-level tests that would have caught items 1-3, phrased as the issue's own criteria rather
than as attribute checks:

- After any sequence of explorer interactions, with `activeTabPath === null`, **no row has a
  highlight** (assert on the highlight, not on `aria-current` alone).
- With `activeTabPath === X`, **X is the only highlighted row**, including when the last explorer
  click was on a different row.
- Setting `activeTabPath` to a file inside a collapsed directory results in that row existing and
  being highlighted (or the deferral is recorded and this test is explicitly out of scope).
- Mirrored coverage for `StandaloneFileList.svelte`.
