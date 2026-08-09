# Plan: highlight the currently open file in the file explorer (issue #400)

**Revision 3** — incorporates round-1 findings
(`docs/analysis/2026-08-09-issue-400-plan-review.md`: the fill is now owned
by the open file instead of coexisting with the old selection fill, and
auto-reveal is in scope rather than an open question) and round-2 findings
(`docs/analysis/2026-08-09-issue-400-plan-review-round-2.md`: the reveal
effect's dependencies were too broad, and the ancestor walk didn't survive
Windows' native path separators). §1/§2 were approved as-is in round 2; only
§3 changed. See "Changes from revision 2" at the bottom. This is the final
plan revision — round 2 was the last of the two review rounds — and now
proceeds straight to implementation.

## Problem

The file explorer's row highlight is driven entirely by local click/keyboard
selection state (`FileTree.svelte`'s `selectedPaths`, rendered as
`aria-selected` in `FileTreeNode.svelte`). It has no connection to which file
is actually open in the editor. `FileTree.svelte` says so explicitly in a
comment on its own `focusedPath` state: "no coupling to
`tabsState`/`activeTabPath`".

That means the explorer highlight only happens to line up with the open file
when the user's last explorer interaction was clicking that exact row.
Switching files any other way — clicking a different tab in the tab strip,
following a markdown or terminal file link, restoring tabs on startup,
opening a file from the OS file manager (#398), or focusing a different split
pane — moves the active file without moving the explorer highlight. Worse,
today's fallback in `selectedPaths` (`FileTree.svelte:115-120`) always
highlights *some* row (the focused/current one) even when no file is open at
all, or highlights a stale previously-clicked row after that file's tab is
closed — both violate the issue's "if no file is open, no file should be
highlighted." `StandaloneFileList.svelte` (the single-file-workspace
explorer, issue #325) has the identical gap for the same reason.

## Existing state to build on

- `tabsState.activeTabPath` (`src/lib/stores/tabs.ts`) is the single,
  already-canonical "currently open file" value. `App.svelte` keeps it
  synced to the *focused* editor pane's own active tab
  (`syncActiveTabToFocusedPane`, `App.svelte:508-515`), so it stays correct
  even with split panes and even when the same path is open in more than one
  pane. It is re-keyed on rename and cleared to `null` when the last tab
  closes — no extra bookkeeping needed. This is exactly the value issue #400
  means by "currently open file."
- `--atrium-selection-bg` (`src/styles/app.css`, `src/lib/theme/tokens.ts`) is
  the existing, already-themed (light/dark) "this row matters" fill, today
  used for explorer selection. Reusing it for the open-file row (rather than
  the weaker `--atrium-bg-active`) gives the feature the same visual weight
  users already read as "important row here," instead of a second, fainter
  competing signal.
- Tree expansion is not persisted: `loadRoot` (`src/lib/stores/fileTree.ts`)
  starts every subdirectory collapsed, and `flattenVisible`
  (`FileTree.svelte:82-94`) only emits rows for paths under expanded
  ancestors. A file inside a collapsed directory has **no DOM row at all**
  until something expands its way down — relevant to reveal, below.

## Approach

### 1. Stop giving the old selection fallback a fill of its own

`selectedPaths` (`FileTree.svelte:115-120`) keeps its exact current semantics
— it still always resolves to at least the focused/current row, and
`aria-selected` keeps reflecting it unchanged, so the existing a11y contract
and `FileTreeKeyboardNav.test.ts:180-191` ("marks `aria-selected='true'` on
exactly the focused row") stay green. What changes is which state gets a
*visible* background fill:

- Add `let rangeSelectedPaths = $derived(selectedPaths.size > 1 ?
  selectedPaths : new Set<string>());` in `FileTree.svelte` (and the
  equivalent in `StandaloneFileList.svelte`). This is non-empty only during a
  genuine multi-row range selection (shift-click/shift-arrow) — a plain click
  or arrow-key move always collapses `explicitSelectedPaths` back to a
  singleton, so the common "click/focus one row" case no longer paints a
  fill; the existing `.row:focus` outline (`FileTreeNode.svelte:209-213`)
  keeps conveying "this is the current row" on its own, exactly as the review
  recommended.
- Pass `rangeSelectedPaths` down to `FileTreeNode` alongside the unchanged
  `selectedPaths`, and drop the background from `.row:focus` (outline only,
  no `background` declaration) since a single current row no longer needs a
  fill.

### 2. Give the open file the fill, in both explorers

- **`FileTree.svelte`**: import `tabsState`, pass
  `openPath={$tabsState.activeTabPath}` into the root `FileTreeNode`.
- **`FileTreeNode.svelte`**: accept new `openPath: string | null` and
  `rangeSelectedPaths: Set<string>` props (both threaded through the two
  recursive `{#each}` blocks the same way `focusedPath`/`selectedPaths`
  already are). Mark the open-file row with `aria-current={node.entry.path
  === openPath ? "true" : undefined}` — a real ARIA semantic for "the current
  item in a set," deliberately kept separate from `aria-selected` (unchanged
  multi/roving-focus semantics). CSS:
  ```css
  .row.range-selected,
  .row[aria-current="true"] {
    background: var(--atrium-selection-bg);
  }
  .row:hover {
    background: var(--atrium-bg-hover);
  }
  .row:focus {
    outline: 1px solid var(--atrium-accent);
    outline-offset: -1px;
  }
  ```
  All three selectors (`.range-selected`, `[aria-current="true"]`,
  `:hover`) have equal specificity, so declaring `:hover` last means hovering
  any row — including the open file or a range-selected row — still shows
  hover feedback, rather than silently losing to a same-specificity rule
  declared earlier (round-1 finding #4).
- **`StandaloneFileList.svelte`**: it already imports `tabsState`; add the
  same `rangeSelectedPaths` derivation, `aria-current={row.path ===
  $tabsState.activeTabPath ? "true" : undefined}`, and the matching CSS —
  including dropping `background: var(--atrium-selection-bg)` from its own
  `.row:focus` rule (`StandaloneFileList.svelte:186-190`), the same as
  `FileTreeNode.svelte`'s. Missing that half would leave arrow-key
  navigation there (which moves focus without activating a tab, unlike a
  click) painting a second fill on the focused row alongside the active
  tab's `aria-current` fill — round-1 finding #2 recurring in the other
  explorer. No expand-to-path step here — every row is already a flat,
  always-visible open tab, so there is never a hidden row to reveal.

With both changes, a row can be: the open file (fill, dominant), part of a
genuine multi-select range (same fill — the two are rarely simultaneous on
different rows, and no requirement calls for visually distinguishing them,
so reusing one token keeps the change minimal), the roving-focus current row
(outline only), or plain (nothing). No file open means no row anywhere
carries `aria-current`, and a single click/focus never paints a fill on its
own — both closes out the issue's "no file open → nothing highlighted."

### 3. Expand to the open file when its row doesn't exist yet

Decided (not deferred, per round-1 finding #3): implement auto-expand+scroll.
Named `expandToPath`, not `revealPath` — "reveal" already means "reveal in
the OS file manager" elsewhere in this codebase (`ipc/reveal.ts`, the context
menu's "Reveal in Finder"). Add to `src/lib/stores/fileTree.ts`:

```ts
function nativeDirOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx <= 0 ? path : path.slice(0, idx);
}

export async function expandToPath(path: string, isStale: () => boolean): Promise<void> {
  const root = get(fileTree).root;
  if (!root || root.entry.path === path || !isPathUnderOrEqual(path, root.entry.path)) {
    return;
  }
  const ancestors: string[] = [];
  let dir = nativeDirOf(path);
  while (dir !== root.entry.path && nativeDirOf(dir) !== dir) {
    ancestors.unshift(dir);
    dir = nativeDirOf(dir);
  }
  for (const ancestor of ancestors) {
    if (isStale()) return;
    const node = findNode(get(fileTree).root ?? root, ancestor);
    if (node?.expanded && node.children) continue;
    await loadChildren(ancestor);
  }
}
```

`findNode` already exists in this module (private, used by
`refreshDirectoryContaining`); `isPathUnderOrEqual` comes from `../util/path`
(the same helper `tabs.ts` uses to compute `isExternal`, so an
out-of-workspace/external tab is automatically skipped — no separate guard
needed). Ancestors are computed with the new **`nativeDirOf`**, not the
existing `dirOf` — round 2 caught that `dirOf` normalizes backslashes to `/`
in its *result*, not just for internal comparison, so on Windows every
computed ancestor comes back forward-slashed while `node.entry.path` stays in
native (backslash) form straight from the Rust backend. `findNode`/
`loadChildren` then never match any real node, and the walk only stops via
its fixed-point safety net at the drive root — reveal silently does nothing
on Windows, plus a few stray out-of-workspace `fsListDir` calls along the
way. `nativeDirOf` slices on whichever separator (`/` or `\`) actually
appears, so an ancestor is always a literal prefix of the original,
native-separator `path` string, which does match tree node paths on every
platform. The `nativeDirOf(dir) !== dir` clause is a self-terminating safety
net (the string strictly shrinks under repeated `nativeDirOf` until it hits a
fixed point) independent of whether `path` and `root.entry.path` ever compare
equal, so the loop can't hang even on a pathological path.

In `FileTree.svelte`, add two memoized `$derived` values and an effect that
expands to and scrolls to the open file:

```ts
let openPath = $derived($tabsState.activeTabPath);
let rootPath = $derived($fileTree.root?.entry.path ?? null);

$effect(() => {
  const path = openPath;
  const root = rootPath;
  if (!path || !root) return;
  const isStale = () => openPath !== path;
  void expandToPath(path, isStale)
    .then(async () => {
      if (isStale()) return;
      await tick();
      Array.from(treeEl.querySelectorAll<HTMLElement>(".row[data-path]")).find(
        (row) => row.dataset.path === path,
      )?.scrollIntoView({ block: "nearest" });
    })
    .catch((err: unknown) => {
      console.error("atrium: failed to expand to open file in explorer", err);
    });
});
```

Depending on `openPath`/`rootPath` — memoized values, not the raw
`$tabsState`/`$fileTree` store reads — is load-bearing, not stylistic: round
2 reproduced that reading the stores directly re-fires the effect on *every*
write to either one, not just when the active path or root actually changes.
Concretely, that made `collapse()` (ArrowLeft, or the chevron) get silently
undone one tick later for the directory containing the open file, and made
`markDirty` (fired on every keystroke) re-run `scrollIntoView` on every
keystroke, yanking the explorer's scroll back to the open file while the user
was browsing elsewhere. A Svelte `$derived` only propagates to dependents
when its *computed value* actually changes (`Object.is`-different from
before) — `markDirty`/`collapse`/an `fs:changed` refresh all publish a new
store object without changing `activeTabPath` or the root's own `entry.path`
string, so `openPath`/`rootPath` recompute to the same value and the effect
does not re-fire. Cold-start session restore still works: `rootPath` goes
from `null` to the real path exactly once when `loadRoot` finishes, which is
enough to fire the effect for whatever `openPath` a session restore already
set. `isStale` re-checks before each awaited step and before scrolling, so a
rapid tab switch aborts an in-flight expansion instead of racing it to a
wrong final scroll position. The trailing `.catch` (logged, not thrown)
matches the codebase's existing precedent for this exact call shape
(`beginCreate`, `FileTree.svelte:209-221`) — a failing `fsListDir`
(permission denied, a directory removed out from under a restored tab) must
not become an unhandled rejection. `scrollIntoView({ block: "nearest" })`
matches the one existing precedent for this idiom in the codebase
(`SettingsDialog.svelte:128`).

No backend/Rust change, no new store, no doc updates needed (no doc
describes explorer highlight behavior today).

## Testing

Extend the existing explorer test suites (`tests/frontend/`, Vitest +
`@testing-library/svelte`, following `FileTreeKeyboardNav.test.ts`'s
`rowFor(container, path)` helper pattern). Per round-1 feedback, assertions
target the actual highlight (the `range-selected` class / computed
background), not `aria-current` in isolation, so a regression in the fill
logic itself would fail these:

- With no tab ever opened, and again after opening then closing the only
  tab (`activeTabPath` back to `null`), no row carries a fill.
- With a file open, that file's row is the only one with a fill — including
  after clicking a *different directory* row in the explorer to browse
  (`aria-selected` moves; the fill does not). Must be a directory, not a
  file: clicking a file row opens it (`activate()` in `FileTreeNode.svelte`),
  which correctly *does* move the fill to that file.
- Setting `tabsState.activeTabPath` directly (simulating a tab-strip switch,
  not a click in the explorer) moves the fill without any explorer
  interaction.
- Setting `activeTabPath` to a file inside a currently-collapsed directory
  causes that directory (and any collapsed ancestor) to expand and the
  file's row to end up highlighted; `scrollIntoView` is called for it
  (`Element.prototype.scrollIntoView` mocked in `beforeEach`, per
  `SettingsDialogSearchSections.test.ts`'s existing pattern — jsdom has no
  real implementation).
- With a file open and its parent directory expanded, collapsing that parent
  (ArrowLeft or the chevron) leaves it collapsed — it does not silently
  re-expand on the next tick.
- A `tabsState` write that leaves `activeTabPath` unchanged (`markDirty`, the
  editor's own dirty-tracking on every keystroke) triggers no further
  `scrollIntoView` call — assert on the mock's call count, not just that it
  was called once at some point.
- A genuine multi-row range selection (shift-click) still shows a fill on
  every selected row, distinct from (and unaffected by) the open-file case.
- Same coverage (minus expand-to-path, which doesn't apply), mirrored, for
  `StandaloneFileList.svelte`.

## Changes from revision 1

Round-1 review (`docs/analysis/2026-08-09-issue-400-plan-review.md`)
requested changes on three points, all addressed above:

1. *"No file open" still highlighted a row* — fixed by removing the fill from
   the implicit/single-row selection fallback entirely (§1); the fallback's
   `aria-selected` semantics are untouched, only the CSS that used to paint
   it is gone.
2. *Two rows highlighted at once, wrong one dominant* — fixed by giving the
   open file the same strong `--atrium-selection-bg` fill instead of the
   weaker `--atrium-bg-active`, and by no longer painting a fill for a
   single-row selection at all, so at most the open file (plus, separately,
   a genuine multi-row range) ever carries one (§2).
3. *Nothing highlighted at startup / from outside the explorer* — fixed by
   adding `revealPath` + a reveal-and-scroll effect (§3), decided in favor of
   implementing it now rather than deferring, since without it the feature
   would visibly not work on the cold-start and non-explorer-open paths the
   issue is centrally about.

Nice-to-have #4 (specificity silently beating `:hover`) is fixed by the
CSS rule ordering in §2. Nice-to-have #5 (`StandaloneFileList` needing the
same reconciliation) is folded into §1/§2 directly rather than listed
separately.

## Changes from revision 2

Round-2 review (`docs/analysis/2026-08-09-issue-400-plan-review-round-2.md`)
approved §1/§2 as written and requested changes confined to §3, both now
fixed:

1. *Reveal effect's reactive dependencies were too broad* — fixed by
   depending on memoized `openPath`/`rootPath` `$derived` values instead of
   the raw `$tabsState`/`$fileTree` store reads, so an unrelated store write
   (a keystroke's `markDirty`, a `collapse()`, an `fs:changed` refresh) no
   longer re-fires the effect.
2. *Ancestor walk didn't survive Windows' native path separators* — fixed by
   a new `nativeDirOf` that slices on whichever separator is actually
   present instead of `dirOf`, which normalizes its result to `/` and so
   never matched a native (backslash) tree node path on Windows.

Also folded in: renamed `revealPath` to `expandToPath` (avoiding a name
collision with "reveal in Finder"), added a `.catch` on the expand promise,
dropped `StandaloneFileList.svelte`'s own `.row:focus` background, and
corrected the "click a different row" test to specify a directory row. This
was the second and last of the two plan-review rounds; remaining feedback
(if any) is caught by implementation review instead.
