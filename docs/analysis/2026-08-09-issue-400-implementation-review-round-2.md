# Implementation review, round 2 (final): highlight the currently open file (issue #400)

**Target reviewed:** commit `47b51eb` on branch `fix/highlight-open-file-in-explorer`
(`git diff origin/main..HEAD`). No pull request exists for this branch, so this review is
against the committed diff directly.

**Reviewed against:** issue #400 ("The file that is currently open in the editor should be
the one highlighted in the file explorer. If no file is open, no file should be
highlighted"), and the round-1 implementation review
(`docs/analysis/2026-08-09-issue-400-implementation-review-round-1.md`).

**Verdict: approve.** The round-1 must-fix is genuinely closed — I reproduced the failing
scenario end-to-end against the real components and it now passes on every axis round 1
named. All four round-1 nice-to-haves are addressed as well. Three residual items are
listed below; none of them blocks, and the first is a one-line change I recommend landing
with this work rather than deferring.

Checkout freshness confirmed before asserting anything about current file contents:
`HEAD already contains origin/main`.

## The round-1 must-fix is closed

Round 1's must-fix was: `activeTabPath` is not guaranteed to be in the same
path-separator form as a tree node's `entry.path`, so on Windows, following a markdown
relative link (whose target is built by `resolveRelative`/`dirname`, both of which
normalize `\` to `/`) left **no row highlighted anywhere** and **expanded nothing**.

I verified the fix by reproducing the exact scenario as a throwaway component test
against `FileTree.svelte` and the real store, rather than by reading the diff: workspace
root `C:\ws`, a collapsed `C:\ws\src`, target file `C:\ws\src\index.ts`, and
`activeTabPath` set to the normalized `C:/ws/src/index.ts` a markdown link would produce.

Observed, after the reveal effect settles:

```
ALL ROWS: [ 'C:\ws', 'C:\ws\src', 'C:\ws\src\index.ts' ]
ROW PRESENT (ancestor expanded): true
ARIA-CURRENT: true
```

Both halves of the failure are gone. Specifically:

- **Expand.** `expandToPath` (`src/lib/stores/fileTree.ts:113-134`) now descends the tree
  instead of slicing the target string into ancestor paths. At each level it selects the
  child directory via `isPathUnderOrEqual(path, child.entry.path)`, which normalizes both
  sides, and then passes that child's **own** `entry.path` — native separators intact — to
  `loadChildren`. The separator form of the incoming `path` therefore stops mattering
  entirely, by construction rather than by a second normalization step. This is the shape
  round 1 recommended, and `nativeDirOf` is deleted outright along with the misleading
  invariant its doc comment asserted.
- **Highlight.** `FileTreeNode.svelte:139` and `StandaloneFileList.svelte:148` now go
  through `pathsEqual` (`src/lib/util/path.ts:59-62`) instead of `===`. The explicit
  `openPath !== null &&` guard in front of it is correct and load-bearing: without it,
  `pathsEqual(path, null)` would throw rather than quietly returning false, and "no file
  open" must never highlight anything.

I also confirmed the loop terminates. `currentPath` moves strictly one level deeper each
iteration and the tree is finite; every early exit (`isStale`, a root swapped out from
under an in-flight expansion, an unloaded `current.children`, no matching child) returns
rather than spinning. The only construction that could loop forever is a directory listing
that contains itself, which the Rust backend cannot produce.

## The round-1 nice-to-haves are addressed

- **#2, root `/` expands nothing** — fixed as a side effect of the tree descent, and now
  pinned directly (`tests/frontend/fileTree.test.ts`, "expands a nested directory when the
  workspace root itself is `\"/\"`").
- **#3, reveal chain throws on a torn-down component** — `FileTree.svelte:173` adds the
  `if (!treeEl) return;` guard, and `FileTreeNode.test.ts` now stubs
  `Element.prototype.scrollIntoView`. The stderr line round 1 quoted is gone from the
  suite; the remaining stderr noise (`SearchOverlay`, jsdom's missing canvas) is
  pre-existing and unrelated to this change.
- **#4, hover erases the open-file highlight** — fixed properly rather than by reordering.
  The plain hover fill is now excluded on a highlighted row
  (`.row:hover:not(.range-selected):not([aria-current="true"])`), and highlighted rows get
  an accent outline layered on top of the retained fill. The `:not(.drop-target-active)`
  exclusion in `FileTreeNode.svelte` is necessary and its comment's specificity reasoning
  is correct: the hover-outline selector is `(0,4,0)` against `.row.drop-target-active`'s
  `(0,2,0)`, so without the exclusion it would suppress the stronger 2px drag-over
  outline. `StandaloneFileList.svelte` has no drop target, so omitting the exclusion there
  is right, not an oversight.
- **#5, `expandToPath` has no store-level tests** — four direct tests added
  (`tests/frontend/fileTree.test.ts`), covering the separator mismatch, the `isStale`
  abort partway through a multi-level expansion, the out-of-root early return, and the
  root-`/` case. The `isStale` test in particular asserts on the recorded `fsListDir` call
  sequence, which is the assertion that actually pins the abort.

## Verification run

- `npx vitest run`: 128 files, 1657 tests, all passing.
- `npm run check` (`svelte-check --fail-on-warnings`): 777 files, 0 errors, 0 warnings.
- The repo has no `lint` script; `check` is the standing gate and it is clean.

## Nice-to-have

### 1. The reveal's scroll step still matches the row by exact string equality

`src/lib/explorer/FileTree.svelte:174-176`:

```ts
Array.from(treeEl.querySelectorAll<HTMLElement>(".row[data-path]")).find(
  (row) => row.dataset.path === path,
)?.scrollIntoView({ block: "nearest" });
```

`data-path` carries `node.entry.path` (native separators); `path` is `openPath`
(`activeTabPath`, which for the markdown-link caller is forward-slashed). This is the last
surviving instance of the exact comparison this commit was written to eliminate, and it
fails in the same scenario. In the reproduction above, alongside the two lines that now
pass:

```
scrollIntoView calls: 0
```

So on Windows, following a markdown relative link into a collapsed directory expands the
tree and highlights the row correctly, but the explorer does not scroll to it — if the
newly-revealed row is below the fold, the user sees a directory pop open and no visible
answer to "which file is open" until they scroll by hand.

This does not block: issue #400's two acceptance criteria are about the highlight, and
both hold. But it leaves the fix two-thirds complete on the one platform and code path it
was written for, and it is one line — `pathsEqual(row.dataset.path ?? "", path)`, with
`pathsEqual` added to the `../util/path` import this file already has at line 27.

For scope: the two other `row.dataset.path === path` sites are correct as they stand.
`FileTree.svelte:206` (`moveFocusTo`) and `StandaloneFileList.svelte:85` both compare
against a path that came out of the tree/row list itself, so no mismatch is possible
there.

### 2. Nothing in the suite pins the highlight half of the separator-mismatch case

Round 1 asked for a regression test asserting **both** that the ancestor expands and that
the row carries `aria-current`. Only the first half landed: the new store test covers
`expandToPath`, but `pathsEqual` has no unit test in `tests/frontend/path.test.ts` (which
does cover `basename`, `dirOf`, and `isPathUnderOrEqual`, including their own
backslash-normalization cases), and no component test drives a forward-slashed
`activeTabPath` against backslashed node paths.

The consequence is concrete: reverting `FileTreeNode.svelte:139` and
`StandaloneFileList.svelte:148` to `===` — reintroducing precisely the round-1 must-fix —
leaves all 1657 tests green. The throwaway component test I wrote for this review catches
it; something equivalent belongs in `FileTreeOpenFileHighlight.test.ts`, plus a handful of
`pathsEqual` cases in `path.test.ts` alongside the neighbouring helpers.

One test-authoring trap worth passing on, since it cost me a false negative: a CSS
attribute selector treats `\` as an escape, so
``container.querySelector(`.row[data-path="C:\\ws\\src\\index.ts"]`)`` silently matches
nothing even when the row is present. Filter `querySelectorAll(".row[data-path]")` on
`dataset.path` instead, the way `filledPaths` in that suite already does.

### 3. The teardown comment names the wrong value

`src/lib/explorer/FileTree.svelte:169-172` says `treeEl` "reverts to `undefined`" once the
component unmounts. Svelte 5's `bind:this` teardown assigns `null`
(`svelte/src/internal/client/dom/elements/bindings/this.js`, `update(null, ...parts)`);
`undefined` is only the declaration's initial value before mount. The `if (!treeEl)` guard
is correct for both, so this is purely a comment that would mislead the next reader into
thinking a `=== undefined` check would do.

## Open questions

None.
