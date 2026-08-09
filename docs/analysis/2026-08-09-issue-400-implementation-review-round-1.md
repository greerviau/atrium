# Implementation review, round 1: highlight the currently open file (issue #400)

**Target reviewed:** commit `b195c3f` on branch `fix/highlight-open-file-in-explorer`
(`git diff origin/main..HEAD`). No pull request exists for this branch yet, so this
review is against the committed diff directly.

**Reviewed against:** issue #400 ("The file that is currently open in the editor should
be the one highlighted in the file explorer. If no file is open, no file should be
highlighted"), `docs/analysis/2026-08-09-issue-400-highlight-open-file-plan.md`
(revision 3), and the two plan-review rounds
(`...-issue-400-plan-review.md`, `...-issue-400-plan-review-round-2.md`).

**Verdict: request changes.** One must-fix. The feature is correct and well covered on
POSIX and on Windows for every path that reaches the explorer in native separator form,
and both plan-review must-fix items are genuinely addressed in the code (not merely in
the plan) — I verified each one. The must-fix below is the residue of the second of
them: the ancestor walk now survives native Windows separators, but the *incoming* path
is not always in that form, and for the one caller that normalizes it the feature is a
silent no-op on Windows.

## Verification of the two plan-review must-fix items

Both were checked against the implementation, not the plan text.

**Must-fix A — whole-store `$effect` dependencies causing re-expand and scroll-pin on
every keystroke: fixed, and covered by tests.** `FileTree.svelte:146-147` introduces
`openPath`/`rootPath` as memoized `$derived` string values, and the effect
(`FileTree.svelte:160-176`) reads only those, never `$tabsState`/`$fileTree` directly.
`expandToPath` reaches the store through `get(fileTree)`, which registers no reactive
dependency. Two tests pin the behaviour that actually matters and both pass:

- `FileTreeOpenFileHighlight.test.ts:177-187` asserts `markDirty(INDEX_TS)` — the
  per-keystroke write — produces **no additional** `scrollIntoView` call, asserted on the
  mock's call count rather than on "was called at some point."
- `FileTreeOpenFileHighlight.test.ts:165-175` asserts a user `collapse(SRC)` while the
  file inside it stays open leaves the directory collapsed, i.e. the effect does not
  re-fire and silently undo it a tick later.

Full suite: 128 files, 1653 tests, all passing. `npm run check`
(`svelte-check --fail-on-warnings`): 777 files, 0 errors, 0 warnings.

**Must-fix B — Windows path normalization making reveal a silent no-op: fixed for the
case as specified, incomplete in general.** `nativeDirOf` (`fileTree.ts:150-153`) slices
on whichever of `/` or `\` actually appears, replacing the `dirOf` call that normalized
its result. I reproduced the fixed behaviour directly against the real store with a
throwaway Vitest file: with root `C:\ws` and target `C:\ws\src\deep\index.ts`, the walk
issues `fsListDir` for exactly `C:\ws\src` then `C:\ws\src\deep`, and both nodes end up
`expanded: true`. That is the regression round 2 asked for, and it holds.

What it does not survive is a target path that arrives already normalized — see must-fix
1.

## Must-fix

### 1. The open file is matched by exact string equality, so a normalized path silently matches nothing

- `src/lib/explorer/FileTreeNode.svelte:138` — `node.entry.path === openPath`
- `src/lib/explorer/StandaloneFileList.svelte:148` — `row.path === openPath`
- `src/lib/stores/fileTree.ts:101-120` — `expandToPath`'s ancestor walk, and its
  `nativeDirOf` doc comment at `:140-153`

`nativeDirOf`'s doc comment states the load-bearing assumption: tree node paths are "kept
in native (OS-specific) separator form straight from the Rust backend." That is true of
`node.entry.path`. It is **not** true of the `path` argument, which is
`tabsState.activeTabPath` — a value stored verbatim by `openFile`
(`src/lib/stores/tabs.ts:146-199`, no normalization anywhere) from whatever each caller
supplies.

One caller supplies a normalized path. `handleLinkClick`
(`src/lib/editor/markdown/widgets.ts:301`) builds its target as
`path.resolveRelative(path.dirname(documentPath), url)`, and both helpers
(`src/lib/util/path.ts:24-28`, `:50-68`) replace `\` with `/` and re-join on `/`. On
Windows, clicking a relative link inside a rendered markdown file therefore opens a tab
whose `path` is `C:/ws/docs/b.md` while the explorer's node for the same file is
`C:\ws\docs\b.md`.

Failure scenario, on Windows:

1. Open `C:\ws\docs\a.md` from the explorer; it renders with a relative link to `b.md`.
2. Click that link. `activeTabPath` becomes `C:/ws/docs/b.md`.
3. `node.entry.path === openPath` is `false` for every row, so **no row anywhere carries
   `aria-current` and nothing is highlighted** — the editor shows `b.md`, the explorer
   shows no open file at all.
4. `expandToPath` fares no better. `isPathUnderOrEqual` normalizes both sides, so the
   guard passes, and the walk then produces forward-slashed ancestors that match no node.
   I reproduced this against the real store: with root `C:\ws` and target
   `C:/ws/src/index.ts`, the walk issues `fsListDir` for `C:/ws` and `C:/ws/src`, two
   round trips whose `patchNode` results match nothing, and expands nothing.

This is exactly the "following a markdown or terminal file link" scenario the plan's
Problem section names as a motivating case for the feature, and it is the same class of
defect round 2 caught — the fix closed the `dirOf`-normalizes-its-result half and left
the input-already-normalized half open. Independently, the `nativeDirOf` comment asserts
a codebase invariant that does not hold and would mislead the next reader.

Two corrections are needed, and the smaller of them subsumes the string surgery:

- **Walk the tree rather than the string.** Replace the `nativeDirOf` ancestor
  computation in `expandToPath` with a descent from the root: at each level, pick the
  child directory `c` for which `isPathUnderOrEqual(path, c.entry.path)` holds, expand it
  if needed, and recurse. `isPathUnderOrEqual` already normalizes both sides, so the
  descent is separator-agnostic by construction; `nativeDirOf` can then be deleted
  outright, and nice-to-have 1 below is fixed for free.
- **Compare the highlight the same way.** `FileTreeNode.svelte:138` and
  `StandaloneFileList.svelte:148` need a normalizing comparison (backslashes folded,
  trailing separator stripped — `fileTree.ts:33-35` already has exactly this as a private
  `normalizePath`) rather than `===`.

Add a regression test that pins it: a tree whose node paths use `\` and an
`activeTabPath` using `/` for the same file, asserting both that the ancestor expands and
that the row carries `aria-current`. As committed, nothing in the suite would catch a
regression here — `nativeDirOf` has no test of its own, so reverting it to `dirOf` (the
exact bug round 2 found) leaves the suite green.

Note for scope: normalizing at the `openFile` boundary instead would also fix a
pre-existing bug outside this issue — `openFile`'s duplicate-tab check
(`tabs.ts:167`) is likewise `===`, so on Windows the same file opened once from the
explorer and once from a markdown link produces two tabs. That is a wider change than
issue #400 needs; the explorer-side fix above is the smallest one that fully closes this
issue, and the `openFile` normalization is worth its own follow-up issue.

## Nice-to-have

### 2. `expandToPath` expands nothing when the workspace root is `/`

`src/lib/stores/fileTree.ts:108-112`. Reproduced: root `/`, target `/a/b.txt`. The first
`nativeDirOf` yields `/a`, whose own `nativeDirOf` hits the `idx <= 0` branch and returns
`/a` unchanged — the fixed-point guard fires immediately, `ancestors` is empty, and `/a`
is never expanded. `fsListDir` is called only for `/` (the initial `loadRoot`). A
workspace rooted at `/` is unusual enough that this is not blocking, and the
descend-the-tree rewrite recommended in must-fix 1 removes it as a side effect.

### 3. The reveal chain throws on a torn-down component, and now logs an error in an unrelated test

`src/lib/explorer/FileTree.svelte:169-175`. The `.then` dereferences `treeEl`
unconditionally. Svelte sets a `bind:this` target back to `null` on destroy, so an
`fsListDir` that resolves after the explorer unmounts turns into a `TypeError` swallowed
by the `.catch` and reported as "failed to expand to open file in explorer" — a message
that misattributes a DOM teardown to the filesystem.

This is already visible in the suite as new stderr noise from an unrelated file:

```
stderr | tests/frontend/FileTreeNode.test.ts > FileTreeNode: recent-files write path > records a file row click in the workspace's recent-files list
atrium: failed to expand to open file in explorer TypeError: Array.from(...).find(...)?.scrollIntoView is not a function
```

(That specific trigger is jsdom-only — `FileTreeNode.test.ts` does not stub
`Element.prototype.scrollIntoView`, and real browsers have it — but it is new noise
introduced by this change, and the null-`treeEl` variant is real.) An early
`if (!treeEl) return;` plus calling `scrollIntoView` optionally covers both.

### 4. Hovering the open file erases the only indication that it is open

`src/lib/explorer/FileTreeNode.svelte:215-221`, mirrored at
`src/lib/explorer/StandaloneFileList.svelte:193-199`. The equal-specificity ordering is
deliberate and documented, but its effect is a strict background swap: hovering the open
file replaces `--atrium-selection-bg` (`rgba(91, 157, 255, 0.25)`, clearly visible) with
`--atrium-bg-hover` (`rgba(255, 255, 255, 0.06)`, near-invisible), so the answer to
"which file is open" vanishes for as long as the pointer rests on that row. Before this
change the fill won, because `.row[aria-selected="true"]` was declared after `:hover`.

Round-1 finding #4 asked that hovering a highlighted row still give feedback, not that it
stop showing the highlight. Both goals are available:
`.row:hover:not([aria-current="true"]):not(.range-selected)` for the plain-row fill, plus
a distinct hover treatment on highlighted rows (a slightly stronger selection tint, or an
outline).

### 5. `expandToPath` has no store-level tests

`tests/frontend/` exercises `expandToPath` only through `FileTree.svelte`, which leaves
three of its own branches unpinned: the `isStale` abort (a rapid tab switch during an
in-flight expansion), the out-of-root early return for an external tab, and the
separator handling discussed in must-fix 1. A small direct suite against the store —
mock `fsListDir`, call `expandToPath`, assert on the recorded call sequence and the
resulting `expanded` flags — is cheap and would have caught both must-fix 1 and
nice-to-have 2.

## What is right

Worth recording, since the next round should not re-litigate it:

- The issue's two acceptance criteria are met and directly tested: no fill anywhere when
  no file is open (`FileTreeOpenFileHighlight.test.ts:100-117`, covering both "never
  opened" and "opened then closed"), and exactly one filled row otherwise
  (`:119-149`), including when the user clicks a different directory row to browse.
- Splitting `aria-selected` (unchanged roving-focus/multi-select a11y) from `aria-current`
  (the open file) and from `range-selected` (the visible fill) is the right decomposition.
  It keeps the existing `FileTreeKeyboardNav.test.ts` contract intact — verified green —
  while making "highlighted" mean one thing.
- `StandaloneFileList.svelte` is genuinely brought along rather than mentioned, including
  the easily-missed half: dropping its own `.row:focus` background so arrow-key
  navigation there does not paint a second fill. Its test at
  `tests/frontend/StandaloneFileList.test.ts` pins exactly that case.
- Comment density and voice match the surrounding files, and each comment explains a
  decision rather than restating the code.

## Open questions

None. The must-fix has a settled shape and needs no decision from the requester.
