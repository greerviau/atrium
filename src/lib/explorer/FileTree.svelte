<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import {
    fileTree,
    loadRoot,
    loadChildren,
    collapse,
    toggleExpanded,
    expandToPath,
    type TreeNode,
  } from "../stores/fileTree";
  import { workspace } from "../stores/workspace";
  import { tabsState } from "../stores/tabs";
  import {
    contextMenu,
    closeContextMenu,
    openContextMenu,
    deletePath,
    treeActionRequest,
    type TreeActionRequest,
  } from "./contextMenu";
  import { revealInFinder } from "../ipc/reveal";
  import { editingPath, pendingCreate, settleActiveEdit } from "./inlineEdit";
  import FileTreeNode from "./FileTreeNode.svelte";
  import ContextMenu from "../ui/ContextMenu.svelte";
  import { attachScrollbarAutoHide } from "../ui/scrollbarAutoHide";
  import { dirOf } from "../util/path";
  import { SHORTCUT_LABELS } from "../shell/shortcutLabels";
  import { draggingPath } from "./explorerDrag";
  import { contiguousPathSelection } from "./rangeSelection";

  // Mirrors `TerminalPane.svelte`'s own platform check: the file-explorer
  // shortcuts below need the same Cmd-on-Mac/Ctrl-elsewhere branching
  // `terminalKeyHandling.ts` uses, and there is no shared export for this —
  // each caller computes it locally.
  const isMacPlatform = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

  let treeEl: HTMLDivElement;
  let detach: (() => void) | undefined;

  onMount(() => {
    detach = attachScrollbarAutoHide(treeEl);
  });
  onDestroy(() => detach?.());

  let deleteTarget = $state<{ path: string; isDir: boolean } | null>(null);
  let isRootContextMenu = $derived($contextMenu?.path === $fileTree.root?.entry.path);

  $effect(() => {
    if ($workspace.root) {
      void loadRoot($workspace.root);
    }
  });

  // Independent of the `.dragging` CSS lock below (issue #390 / #391): that
  // lock alone didn't hold on a real device (the issue was reopened after
  // #391 shipped it), and the exact native mechanism still causing the
  // scroll was never identified — this environment has no display to
  // observe it with. Rather than guess at a second mechanism-specific fix,
  // this corrects the *effect* of any scroll, whatever its cause, by
  // snapping scrollLeft back the instant it moves during a drag.
  // Self-terminating: after the corrective write, scrollLeft already equals
  // lockedScrollLeft, so the scroll event that write itself triggers is a
  // no-op through the `!==` guard rather than a second correction.
  $effect(() => {
    if ($draggingPath === null) return;
    const lockedScrollLeft = treeEl.scrollLeft;
    const onScroll = () => {
      if (treeEl.scrollLeft !== lockedScrollLeft) treeEl.scrollLeft = lockedScrollLeft;
    };
    treeEl.addEventListener("scroll", onScroll);
    return () => treeEl.removeEventListener("scroll", onScroll);
  });

  // Roving tabindex + arrow-key navigation (§ Approach step 1). Starts at the
  // root the first time `$fileTree.root` loads and otherwise just tracks
  // wherever the user last navigated during the session — no coupling to
  // `tabsState`/`activeTabPath`.
  let focusedPath = $state<string | null>(null);

  interface VisibleRow {
    path: string;
    node: TreeNode;
    depth: number;
    parentPath: string | null;
  }

  // Expansion-aware flattening of the whole tree: a node is included only
  // when every ancestor up to the root has `expanded: true`, giving arrow-key
  // and Home/End navigation a single ordering to walk (§ Approach step 1).
  function flattenVisible(root: TreeNode | null): VisibleRow[] {
    const rows: VisibleRow[] = [];
    function walk(node: TreeNode, depth: number, parentPath: string | null): void {
      rows.push({ path: node.entry.path, node, depth, parentPath });
      if (node.entry.isDir && node.expanded && node.children) {
        for (const child of node.children) {
          walk(child, depth + 1, node.entry.path);
        }
      }
    }
    if (root) walk(root, 0, null);
    return rows;
  }

  let visibleRows = $derived(flattenVisible($fileTree.root));

  // `focusedPath` can go stale: the row it names can stop existing (deleted,
  // renamed, refreshed out from under it) without anything reconciling it,
  // and since a row's own `tabindex` is keyed off whichever path this
  // resolves to, a dangling `focusedPath` would otherwise drop the entire
  // explorer out of the tab sequence (every row would read `-1`, and
  // `.file-tree` itself is `tabindex="-1"`). Rendering always goes through
  // this derived, guaranteed-valid projection instead — falling back to the
  // first visible row (the root) whenever the stored path isn't currently
  // visible, which also covers the very first render before anything has
  // been focused, so no separate init effect is needed.
  let activePath = $derived(
    visibleRows.some((row) => row.path === focusedPath) ? focusedPath : (visibleRows[0]?.path ?? null),
  );
  // Range selection follows the rendered, expansion-aware row order. Arrow
  // navigation and unmodified clicks collapse the selection to one row.
  let selectionAnchorPath = $state<string | null>(null);
  let explicitSelectedPaths = $state<Set<string>>(new Set());
  let selectedPaths = $derived.by(() => {
    const visiblePaths = new Set(visibleRows.map((row) => row.path));
    const selected = new Set([...explicitSelectedPaths].filter((path) => visiblePaths.has(path)));
    if (selected.size > 0) return selected;
    return activePath === null ? new Set<string>() : new Set([activePath]);
  });
  // The subset of `selectedPaths` that actually reflects a user-made,
  // multi-row range selection (shift-click/shift-arrow) rather than the
  // single-row fallback above — a plain click or arrow move always
  // collapses back to one row, so this is empty outside a genuine range
  // selection. Drives the visual fill (FileTreeNode.svelte); `selectedPaths`
  // itself still drives `aria-selected` unchanged, for the single-current-
  // row a11y semantics `FileTreeKeyboardNav.test.ts` already covers.
  let rangeSelectedPaths = $derived(selectedPaths.size > 1 ? selectedPaths : new Set<string>());

  // The currently open file (issue #400) and the workspace root's own path,
  // both as memoized values rather than raw store reads: `openPath`/
  // `rootPath` only change (by `Object.is`) when the active tab or the
  // root's own identity actually changes, not on every unrelated write to
  // `tabsState`/`fileTree` (a keystroke's `markDirty`, a `collapse()`, an
  // `fs:changed` refresh) — load-bearing for the expand effect below, which
  // must not re-fire on those.
  let openPath = $derived($tabsState.activeTabPath);
  let rootPath = $derived($fileTree.root?.entry.path ?? null);

  // Expands every collapsed ancestor of the open file and scrolls its row
  // into view (issue #400): without this, a file inside a collapsed
  // directory — the common case on a restored session, or any open
  // triggered from outside the explorer (a markdown/terminal link, an OS
  // file-manager open, #398) — has no DOM row to highlight at all.
  // `rootPath` going from `null` to the real path (once, when `loadRoot`
  // finishes) is what makes a cold-start session restore work, since the
  // active tab is typically set before that resolves. `isStale` is
  // re-checked before each awaited step and before scrolling, so a rapid tab
  // switch aborts an in-flight expansion instead of racing it to a wrong
  // final scroll target.
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

  function onFocusRow(path: string): void {
    focusedPath = path;
  }

  function onSelectRow(path: string, extendSelection: boolean): void {
    const anchorPath = selectionAnchorPath ?? activePath;
    focusedPath = path;
    if (!extendSelection) {
      selectionAnchorPath = path;
      explicitSelectedPaths = new Set([path]);
      return;
    }

    const visiblePaths = visibleRows.map((row) => row.path);
    explicitSelectedPaths = contiguousPathSelection(visiblePaths, anchorPath, path);
    selectionAnchorPath = anchorPath !== null && visiblePaths.includes(anchorPath) ? anchorPath : path;
  }

  async function moveFocusTo(path: string): Promise<void> {
    focusedPath = path;
    selectionAnchorPath = path;
    explicitSelectedPaths = new Set([path]);
    await tick();
    Array.from(treeEl.querySelectorAll<HTMLElement>(".row[data-path]")).find(
      (row) => row.dataset.path === path,
    )?.focus();
  }

  // Arrow/Home/End handling, matching the WAI-ARIA APG Tree View pattern (§
  // Approach step 2). Expanding a lazily-unloaded directory keeps focus in
  // place, so navigating into newly-loaded children is always a separate,
  // later keystroke against an already-populated `visibleRows`.
  function handleRowKeydown(event: KeyboardEvent, path: string): void {
    const index = visibleRows.findIndex((row) => row.path === path);
    if (index === -1) return;
    const row = visibleRows[index];

    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = visibleRows[Math.min(index + 1, visibleRows.length - 1)];
      void moveFocusTo(next.path);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      const prev = visibleRows[Math.max(index - 1, 0)];
      void moveFocusTo(prev.path);
      return;
    }
    if (event.key === "ArrowRight") {
      if (!row.node.entry.isDir) return;
      event.preventDefault();
      if (!row.node.expanded) {
        void toggleExpanded(row.node);
        return;
      }
      // `visibleRows[index + 1]` is only "the first child" when this
      // directory actually has visible children — an already-open but empty
      // (or not-yet-loaded) directory contributes none, so the next entry is
      // really a sibling from an ancestor's perspective; APG says do nothing.
      const next = visibleRows[index + 1];
      if (next?.parentPath === row.path) void moveFocusTo(next.path);
      return;
    }
    if (event.key === "ArrowLeft") {
      if (row.node.entry.isDir && row.node.expanded) {
        event.preventDefault();
        collapse(row.node.entry.path);
        return;
      }
      if (!row.parentPath) return;
      event.preventDefault();
      void moveFocusTo(row.parentPath);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      if (visibleRows.length > 0) void moveFocusTo(visibleRows[0].path);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      if (visibleRows.length > 0) void moveFocusTo(visibleRows[visibleRows.length - 1].path);
      return;
    }
  }

  async function beginCreate(dir: string, isDir: boolean): Promise<void> {
    closeContextMenu();
    settleActiveEdit();
    try {
      // Ensures the target directory is expanded/loaded so the new row is visible.
      await loadChildren(dir);
    } catch (err) {
      console.error("atrium: failed to load directory for new entry", err);
      return;
    }
    editingPath.set(null);
    pendingCreate.set({ parentPath: dir, isDir });
  }

  async function startNewFile(path: string, isDir: boolean): Promise<void> {
    const dir = isDir ? path : dirOf(path);
    await beginCreate(dir, false);
  }

  async function startNewFolder(path: string, isDir: boolean): Promise<void> {
    const dir = isDir ? path : dirOf(path);
    await beginCreate(dir, true);
  }

  function startRename(path: string): void {
    closeContextMenu();
    settleActiveEdit();
    pendingCreate.set(null);
    editingPath.set(path);
  }

  function startDelete(path: string, isDir: boolean): void {
    deleteTarget = { path, isDir };
    closeContextMenu();
  }

  async function reveal(path: string): Promise<void> {
    closeContextMenu();
    await revealInFinder(path);
  }

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget) return;
    await deletePath(deleteTarget.path, deleteTarget.isDir);
    deleteTarget = null;
  }

  function onEmptyAreaContextMenu(event: MouseEvent): void {
    const root = $fileTree.root;
    if (!root) return;
    openContextMenu(event, root.entry.path, true);
  }

  // The root entry itself can never be renamed/deleted via keyboard either,
  // mirroring the right-click menu's own `isRootContextMenu` exclusion
  // (§ Approach step 1) — a request for either action against the root path
  // is silently dropped rather than opening the confirm modal or an inline
  // rename on the workspace folder itself.
  function isRootPath(path: string): boolean {
    return path === $fileTree.root?.entry.path;
  }

  // Consumes a keyboard-originated tree action (§ Approach step 1): dispatch
  // to the same local handlers the right-click menu's own `onclick`
  // callbacks use, now that those take `(path, isDir)` as plain parameters
  // instead of reading them off `$contextMenu`. Clears the request back to
  // `null` first so a repeat of the same action (e.g. pressing ⌘⌫ again
  // after cancelling the confirm modal) re-fires the effect.
  $effect(() => {
    const request = $treeActionRequest;
    if (!request) return;
    treeActionRequest.set(null);
    dispatchTreeAction(request);
  });

  function dispatchTreeAction(request: TreeActionRequest): void {
    switch (request.action) {
      case "newFile":
        void startNewFile(request.path, request.isDir);
        break;
      case "newFolder":
        void startNewFolder(request.path, request.isDir);
        break;
      case "rename":
        if (!isRootPath(request.path)) startRename(request.path);
        break;
      case "delete":
        if (!isRootPath(request.path)) startDelete(request.path, request.isDir);
        break;
      case "reveal":
        void reveal(request.path);
        break;
    }
  }

  // The `.file-tree` container's own fallback for when no row holds DOM
  // focus (mirroring `onEmptyAreaContextMenu`'s existing root fallback for a
  // right-click on empty space): only reachable once the container itself
  // can hold focus (see the `tabindex="-1"` below). Must ignore a bubbled
  // `keydown` from a row that already handled its own chord — a bubbled
  // event's `target` is still the row, never the container, even though the
  // container's own listener also receives it (§ "Third revision" item 2).
  function onTreeContainerKeydown(event: KeyboardEvent): void {
    const targetPath = (event.target as HTMLElement | null)?.dataset.path;
    if (targetPath !== undefined) {
      handleRowKeydown(event, targetPath);
      return;
    }
    if (event.target !== treeEl) return;
    const root = $fileTree.root;
    if (!root) return;
    const hasModifier = isMacPlatform ? event.metaKey : event.ctrlKey && !event.metaKey;
    const key = event.key.toLowerCase();
    if (hasModifier && !event.altKey && key === "n") {
      event.preventDefault();
      treeActionRequest.set({
        action: event.shiftKey ? "newFolder" : "newFile",
        path: root.entry.path,
        isDir: true,
      });
    }
    // F2 / ⌘⌫ / ⌥⌘R are deliberate no-ops when the container itself, rather
    // than a row, holds focus — there is no specific entry for them to act
    // on at the root fallback (§ Approach step 1).
  }
</script>

<svelte:window onclick={() => closeContextMenu()} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="file-tree"
  class:dragging={$draggingPath !== null}
  bind:this={treeEl}
  oncontextmenu={onEmptyAreaContextMenu}
  onkeydown={onTreeContainerKeydown}
  tabindex="-1"
>
  {#if $fileTree.root}
    <div role="tree" aria-label="File Explorer" aria-multiselectable="true">
      <FileTreeNode
        node={$fileTree.root}
        focusedPath={activePath}
        {selectedPaths}
        {rangeSelectedPaths}
        {openPath}
        {onFocusRow}
        {onSelectRow}
      />
    </div>
  {/if}
</div>

{#if $contextMenu}
  <ContextMenu x={$contextMenu.x} y={$contextMenu.y}>
    <button role="menuitem" onclick={() => void startNewFile($contextMenu.path, $contextMenu.isDir)}>New File<kbd class="shortcut-hint">{SHORTCUT_LABELS.newFile}</kbd></button>
    <button role="menuitem" onclick={() => void startNewFolder($contextMenu.path, $contextMenu.isDir)}>New Folder<kbd class="shortcut-hint">{SHORTCUT_LABELS.newFolder}</kbd></button>
    {#if !isRootContextMenu}
      <button role="menuitem" onclick={() => startRename($contextMenu.path)}>Rename<kbd class="shortcut-hint">{SHORTCUT_LABELS.rename}</kbd></button>
      <button role="menuitem" onclick={() => startDelete($contextMenu.path, $contextMenu.isDir)}>Delete<kbd class="shortcut-hint">{SHORTCUT_LABELS.delete}</kbd></button>
    {/if}
    <button role="menuitem" onclick={() => void reveal($contextMenu.path)}>Reveal in Finder<kbd class="shortcut-hint">{SHORTCUT_LABELS.revealInFinder}</kbd></button>
  </ContextMenu>
{/if}

{#if deleteTarget}
  <div class="modal-backdrop">
    <div class="modal">
      <p>
        Permanently delete <strong>{deleteTarget.path}</strong>? This cannot be undone
        (there is no trash in Atrium).
      </p>
      <div class="actions">
        <button onclick={() => (deleteTarget = null)}>Cancel</button>
        <button class="danger" onclick={confirmDelete}>Delete</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .file-tree {
    height: 100%;
    overflow: auto;
    font-size: 0.9em;
    padding: 6px 0;
    -webkit-user-select: none;
    user-select: none;
  }
  .file-tree.dragging {
    overflow-x: hidden;
  }
  .file-tree :global(input) {
    -webkit-user-select: text;
    user-select: text;
  }
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
  }
  .modal {
    background: var(--atrium-bg-elevated);
    border-radius: 8px;
    padding: 16px;
    min-width: 320px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
  }
  .danger {
    background: var(--atrium-danger);
    color: var(--atrium-danger-text);
    border: none;
    border-radius: 4px;
    padding: 4px 10px;
  }
</style>
