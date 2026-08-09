# Round-2 review: implementation plan for issue #400 (highlight the currently open file)

- **Artifact reviewed:** `docs/analysis/2026-08-09-issue-400-highlight-open-file-plan.md` (revision 2)
- **Reviewed against:** issue #400 ("The file that is currently open in the editor should be the one
  highlighted in the file explorer. If no file is open, no file should be highlighted"), the real
  code, and round-1 findings (`docs/analysis/2026-08-09-issue-400-plan-review.md`)
- **Code state:** checkout verified fresh against `origin/main`
  (`fresh:HEAD already contains origin/main`); the plan file is identical on both.
- **Verdict: request changes.** Two must-fix items, both confined to §3 (reveal). §1 and §2 are
  ready to implement as written.

## Round-1 closure

| Round-1 item | Status |
|---|---|
| 1. "No file open" still highlights a row | **Closed.** §1 removes the fill from the single-row/implicit selection and §2 moves it to `aria-current`. Verified that `--atrium-selection-bg` is painted in exactly four places in the explorer (`FileTreeNode.svelte:200,212`, `StandaloneFileList.svelte:181,189`), all four of which the plan replaces or drops, so no other fill source survives. |
| 2. Two rows highlighted, wrong one dominant | **Closed.** The open file gets the strong token, single-row selection gets no fill at all, so the only remaining two-fill case is a deliberate multi-row range. |
| 3. Nothing highlighted at startup / from outside the explorer | **Addressed in intent, defective in mechanism.** Auto-reveal is correctly decided in favour of implementing now, but the proposed effect and `revealPath` have the two defects below. |
| 4. Selector silently outranks `:hover` | **Closed.** The specificity claim is correct: `.row.range-selected`, `.row[aria-current="true"]` and `.row:hover` are all (0,2,0), so declaring `:hover` last wins. |
| 5. `StandaloneFileList` needs the same treatment | **Closed** by folding it into §1/§2. |

The plan's claim that the existing a11y tests stay green is also correct: `FileTreeKeyboardNav.test.ts`
and `StandaloneFileList.test.ts` assert only on the `aria-selected` *attribute*, never on a
background, and the plan leaves `selectedPaths`/`aria-selected` semantics untouched.

## Must-fix

### A. The reveal effect's reactive dependencies are far too broad

`$effect` in §3 reads `$tabsState.activeTabPath` and `$fileTree.root`. Both are whole-store reads, so
the effect re-runs on **every write to either store**, not only when the active path or the root
changes. Two concrete consequences, both reproduced (probe components mounted in the existing Vitest
harness, running the plan's effect and its `revealPath` verbatim; the probe was removed afterwards,
the tree is unmodified):

**A1 - the user can no longer collapse the directory containing the open file.** `collapse()`
(`fileTree.ts:66-71`) writes the store, the effect re-fires, `revealPath` finds the ancestor with
`expanded: false` and calls `loadChildren`, which sets `expanded: true` again
(`fileTree.ts:49-64`). Reproduced: with `/ws/src/index.ts` active, `collapse("/ws/src")` leaves
`expanded === false` synchronously and `expanded === true` again one tick later. ArrowLeft
(`FileTree.svelte:186-190`) and the chevron both go through `collapse`, so the folder is
permanently pinned open for as long as that file is the active tab.

**A2 - the explorer's scroll position is pinned to the open file while typing.**
`EditorPane.svelte:435-446` calls `markDirty(filePath)` on every non-sync `docChanged`, and
`markDirty` (`tabs.ts:262-267`) unconditionally publishes a new `tabsState` object. Reproduced: one
`markDirty` call re-fires the effect. Each re-fire runs `tick()` then
`scrollIntoView({ block: "nearest" })` on the open file's row, so a user who scrolls the explorer
away to browse another folder has it yanked back on the next keystroke - and again on every
`fs:changed` event, since `App.svelte:1159-1173` routes those into `refreshDirectoryContaining`,
which writes the tree store on any change in an expanded directory (including a save of the open
file itself). It also re-runs `querySelectorAll(".row[data-path]")` over the whole tree per
keystroke.

Neither is caught by the plan's proposed tests: jsdom has no `scrollIntoView`, and no proposed test
collapses a directory while a file is open.

*Fix direction (developer's call on the shape):* make the effect depend on the two values it
actually cares about rather than on the stores. Reading them through memoized `$derived` values -
`let openPath = $derived($tabsState.activeTabPath)` and a root **path** rather than the root node,
e.g. `let rootPath = $derived($fileTree.root?.entry.path ?? null)` - keeps the cold-start re-fire the
plan wants (`null` → the root path, once) while making keystrokes, collapses and `fs:changed`
refreshes inert, because a `$derived` whose value is `===`-unchanged does not propagate. A
`lastRevealedPath` guard that suppresses a repeat reveal/scroll for a path already revealed would
work too; what must not survive is "any store write re-reveals and re-scrolls."

### B. The ancestor walk never terminates at the root on Windows, so reveal silently does nothing there

```ts
while (dir !== root.entry.path && dirOf(dir) !== dir) { ... }
```

`dirOf` normalizes backslashes to `/` (`util/path.ts:31-35`); `root.entry.path` does not - it is the
raw path from the picker/Rust, kept in native form (`workspace.ts:34`, and see
`isPathUnderOrEqual`'s own docstring at `util/path.ts:37`, which exists precisely because these are
"absolute filesystem paths from the Rust side [that] use native separators on Windows"). So the
`dir !== root.entry.path` comparison can never match on Windows, and only the `dirOf(dir) !== dir`
safety net stops the walk - at the drive root. Traced with `root = "C:\Users\me\proj"` and
`path = "C:\Users\me\proj\src\index.ts"`:

- the `isPathUnderOrEqual` guard passes (it normalizes both sides), so the early return does not save you;
- `ancestors` comes out as `["C:/Users", "C:/Users/me", "C:/Users/me/proj", "C:/Users/me/proj/src"]`
  - two of them outside the workspace entirely, each getting its own `fsListDir` IPC on every active-tab change;
- every entry is forward-slashed, so `findNode`/`patchNode` (`fileTree.ts:109-133`, exact `===`
  against backslash node paths) never match and no node is ever expanded.

Net: on Windows the feature degrades to exactly the round-1 finding #3 state (highlight only when the
row already happens to be visible), plus a handful of stray out-of-workspace directory listings.
Windows is a supported platform - #398 (the commit directly under this branch) exists to fix Windows
file-manager opens, which is one of the very paths this reveal is meant to serve. Confidence:
high on the string behaviour (traced), moderate-high on `root.entry.path` carrying native separators
(inferred from the codebase's own documented invariant; I have no Windows host to confirm on).

*Fix direction:* normalize both sides before comparing (the module already has `normalizePath`,
`fileTree.ts:32-35`), and bound the walk by containment against the normalized root rather than by
string equality plus a fixed-point fallback. Note the same normalization has to reach `findNode`, or
the lookup misses even when the walk stops in the right place.

While in there: `void revealPath(path, isStale).then(...)` has no `.catch`, so a failing
`fsListDir` (permission denied, directory removed under a restored tab) becomes an unhandled
rejection. The codebase's existing precedent for exactly this call is to catch and log -
`beginCreate`, `FileTree.svelte:209-221`.

## Non-blocking notes

- §2's `StandaloneFileList` bullet says "and the matching CSS", which needs to include **dropping the
  `background` from `.row:focus`** (`StandaloneFileList.svelte:186-190`), not just adding the new
  rules. Without that, arrow-key navigation there (which moves focus without activating, unlike a
  click) paints a second fill on the focused row while the active tab keeps `aria-current` -
  round-1 finding #2 recurring in the other explorer.
- The testing bullet "including after clicking a *different* row in the explorer to browse
  (aria-selected moves; the fill does not)" needs the clicked row to be a **directory**, or the
  assertion is wrong: clicking a file row calls `activate()` → `openFileReportingErrors`
  (`FileTreeNode.svelte:40-55`), which makes that file the open file, so the fill correctly *does*
  move.
- `revealPath` collides with the established meaning of "reveal" in this codebase, which is "reveal
  in the OS file manager" (`ipc/reveal.ts`, the context menu's "Reveal in Finder",
  `FileTree.svelte:245-248`). Something like `expandToPath` would keep the vocabulary unambiguous.
- Ordering `:hover` last means hovering the open file swaps its strong fill for the fainter hover
  fill. That is the correct resolution of round-1 #4 and not worth changing; noting it only so it is
  a known consequence rather than a surprise.

## What I verified as correct

- The four `--atrium-selection-bg` paint sites are the complete set; §1/§2 covers all of them.
- Specificity arithmetic in §2 is right, and Svelte's scoping adds the same increment to every
  selector, so the declared order decides.
- `revealPath`'s early guard genuinely covers external/out-of-workspace tabs via
  `isPathUnderOrEqual`, and `findNode` really is available in-module.
- Reading the root inside the effect really is what makes cold-start session restore work (the
  active tab is set before `loadRoot` finishes); the fix in A must preserve that, which the
  memoized-root-path shape does.
- The existing explorer tests assert only on `aria-selected`, so the plan's "stays green" claim holds.

## How to verify the revision

Beyond the plan's own list:

- With a file open, collapsing its parent directory (ArrowLeft and chevron) leaves it collapsed.
- With a file open and its parent expanded, a `tabsState` write that does not change
  `activeTabPath` (e.g. `markDirty`) causes no further reveal work and no `scrollIntoView` call
  (assert on the mocked `Element.prototype.scrollIntoView` call count, not just that it was called).
- A tree-store write that does not change the root path (`refreshDirectoryContaining`, `collapse`)
  likewise triggers no reveal.
- `revealPath`'s ancestor walk, unit-tested directly against a backslash-separated root, stops at
  the root and yields ancestors that match the tree's own node paths.
