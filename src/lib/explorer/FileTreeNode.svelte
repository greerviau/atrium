<script lang="ts">
  import type { TreeNode } from "../stores/fileTree";
  import { toggleExpanded } from "../stores/fileTree";
  import { openFileReportingErrors } from "../stores/tabs";
  import { openContextMenu, treeActionRequest, type TreeActionRequest } from "./contextMenu";
  import { editingPath, pendingCreate, commitRename, commitCreate } from "./inlineEdit";
  import { beginExplorerDrag, dragOverTargetDir } from "./explorerDrag";
  import ExplorerIcon from "./icons/ExplorerIcon.svelte";
  import InlineNameInput from "./InlineNameInput.svelte";
  import NewEntryRow from "./NewEntryRow.svelte";
  import FileTreeNode from "./FileTreeNode.svelte";

  let {
    node,
    depth = 0,
    focusedPath = null,
    selectedPaths = new Set<string>(),
    rangeSelectedPaths = new Set<string>(),
    openPath = null,
    onFocusRow = () => {},
    onSelectRow = () => {},
  }: {
    node: TreeNode;
    depth?: number;
    focusedPath?: string | null;
    selectedPaths?: Set<string>;
    rangeSelectedPaths?: Set<string>;
    openPath?: string | null;
    onFocusRow?: (path: string) => void;
    onSelectRow?: (path: string, extendSelection: boolean) => void;
  } = $props();

  // Mirrors `TerminalPane.svelte`'s own platform check: the file-explorer
  // shortcuts below need the same Cmd-on-Mac/Ctrl-elsewhere branching
  // `terminalKeyHandling.ts` uses, and there is no shared export for this —
  // each caller computes it locally.
  const isMacPlatform = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

  let isEditing = $derived($editingPath === node.entry.path);
  let dropTargetActive = $derived($dragOverTargetDir === node.entry.path);
  let rowEl: HTMLDivElement;
  let justDragged = false;

  function activate(): void {
    if (node.entry.isDir) {
      void toggleExpanded(node);
    } else {
      openFileReportingErrors(node.entry.path);
    }
  }

  function onClick(event: MouseEvent): void {
    if (justDragged) {
      justDragged = false;
      return;
    }
    onSelectRow(node.entry.path, event.shiftKey);
    if (!event.shiftKey) activate();
  }

  function onContextMenu(event: MouseEvent): void {
    event.stopPropagation();
    openContextMenu(event, node.entry.path, node.entry.isDir);
  }

  // Maps a chord to a tree-action dispatch — the same `treeActionRequest`
  // channel `FileTree.svelte`'s own container-level fallback uses (§
  // Approach step 1). None of these are native `main.rs` menu accelerators:
  // firing globally regardless of what has focus would be unsafe for
  // New/Rename/Delete (see the plan's safety-constraint note), so they're
  // plain DOM `keydown` handlers scoped to whichever row holds focus instead.
  function dispatchAction(action: TreeActionRequest["action"]): void {
    treeActionRequest.set({ action, path: node.entry.path, isDir: node.entry.isDir });
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
      return;
    }
    const hasModifier = isMacPlatform ? event.metaKey : event.ctrlKey && !event.metaKey;
    const hasRevealModifier = isMacPlatform
      ? event.metaKey && event.altKey
      : event.ctrlKey && event.altKey && !event.metaKey;
    const key = event.key.toLowerCase();
    if (hasModifier && !event.altKey && key === "n") {
      event.preventDefault();
      dispatchAction(event.shiftKey ? "newFolder" : "newFile");
      return;
    }
    if (!hasModifier && !event.altKey && event.key === "F2") {
      event.preventDefault();
      dispatchAction("rename");
      return;
    }
    if (hasModifier && !event.altKey && event.key === "Backspace") {
      event.preventDefault();
      dispatchAction("delete");
      return;
    }
    if (hasRevealModifier && key === "r") {
      event.preventDefault();
      dispatchAction("reveal");
    }
  }

  function onRowPointerDown(event: PointerEvent): void {
    if (isEditing || event.button !== 0) return;
    // Cleared here, not just after use — a `click` fires on the nearest
    // common ancestor of the pointerdown/pointerup targets, not necessarily
    // on this row (a drag released over a different row never runs *this*
    // row's onClick), so a stale `true` from an earlier gesture must never
    // survive into this one.
    justDragged = false;
    beginExplorerDrag(rowEl, event, node.entry, () => {
      justDragged = true;
    });
  }
</script>

<div class="node">
  <div
    class="row"
    class:drop-target-active={dropTargetActive}
    class:range-selected={rangeSelectedPaths.has(node.entry.path)}
    style={`padding-left: ${depth * 14 + 6}px`}
    data-path={node.entry.path}
    data-is-dir={node.entry.isDir}
    bind:this={rowEl}
    onclick={isEditing ? undefined : onClick}
    onkeydown={isEditing ? undefined : onKeydown}
    oncontextmenu={isEditing ? undefined : onContextMenu}
    onpointerdown={isEditing ? undefined : onRowPointerDown}
    onfocus={() => onFocusRow(node.entry.path)}
    role="treeitem"
    aria-selected={selectedPaths.has(node.entry.path)}
    aria-current={node.entry.path === openPath ? "true" : undefined}
    aria-expanded={node.entry.isDir ? node.expanded : undefined}
    aria-level={depth + 1}
    tabindex={focusedPath === node.entry.path ? 0 : -1}
  >
    <ExplorerIcon entry={node.entry} expanded={node.expanded} />
    {#if isEditing}
      <InlineNameInput
        initialValue={node.entry.name}
        selectBaseNameOnly={!node.entry.isDir}
        onCommit={(value) => commitRename(node.entry.path, value)}
        onCancel={() => editingPath.set(null)}
      />
    {:else}
      <span class="name" class:symlink={node.entry.isSymlink}>{node.entry.name}</span>
    {/if}
  </div>
  {#if node.entry.isDir && node.expanded && node.children}
    {@const splitIdx = node.children.findIndex((c) => !c.entry.isDir)}
    {@const dirEnd = splitIdx === -1 ? node.children.length : splitIdx}
    <div role="group">
      {#if $pendingCreate?.parentPath === node.entry.path && $pendingCreate.isDir}
        <NewEntryRow
          depth={depth + 1}
          isDir={true}
          onCommit={(v) => commitCreate(node.entry.path, true, v)}
          onCancel={() => pendingCreate.set(null)}
        />
      {/if}
      {#each node.children.slice(0, dirEnd) as child (child.entry.path)}
        <FileTreeNode node={child} depth={depth + 1} {focusedPath} {selectedPaths} {rangeSelectedPaths} {openPath} {onFocusRow} {onSelectRow} />
      {/each}
      {#if $pendingCreate?.parentPath === node.entry.path && !$pendingCreate.isDir}
        <NewEntryRow
          depth={depth + 1}
          isDir={false}
          onCommit={(v) => commitCreate(node.entry.path, false, v)}
          onCancel={() => pendingCreate.set(null)}
        />
      {/if}
      {#each node.children.slice(dirEnd) as child (child.entry.path)}
        <FileTreeNode node={child} depth={depth + 1} {focusedPath} {selectedPaths} {rangeSelectedPaths} {openPath} {onFocusRow} {onSelectRow} />
      {/each}
    </div>
  {/if}
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding-top: 2px;
    padding-bottom: 2px;
    cursor: pointer;
    white-space: nowrap;
    -webkit-user-select: none;
    user-select: none;
    -webkit-user-drag: none;
  }
  .row :global(input) {
    -webkit-user-select: text;
    user-select: text;
  }
  /* The open file (aria-current, issue #400) and a genuine multi-row range
     selection (range-selected — a plain click or arrow move always
     collapses to a single row, so this only applies during an actual
     shift-click/shift-arrow range) share the one strong fill. A single
     current/focused row deliberately gets no fill of its own — see the
     `:focus` rule below — so "no file open" always means no fill anywhere,
     and the open file is never sharing the explorer with a second,
     unrelated highlighted row. All three of this rule, `.row.range-selected`
     via this selector, and `.row:hover` below have equal specificity, so
     `:hover` is declared last and wins whenever a highlighted row is
     hovered — losing the fill for a strict background swap is the accepted
     trade-off (see the plan) rather than the two rules fighting silently by
     declaration order. */
  .row.range-selected,
  .row[aria-current="true"] {
    background: var(--atrium-selection-bg);
  }
  .row:hover {
    background: var(--atrium-bg-hover);
  }
  /* Plain `:focus`, not `:focus-visible` — this row is a keyboard-shortcut
     target (New/Rename/Delete/Reveal act on whichever row holds focus), so
     it must paint regardless of whether focus arrived via click or Tab.
     `:focus-visible` is designed to suppress exactly the click-focus case on
     an element like this one (a `<div tabindex="0">` with no built-in
     text-editing semantics), which is the primary path these shortcuts are
     built around: click a row, then press a shortcut. No `background` here
     (unlike before issue #400) — a single current/focused row is conveyed by
     this outline alone now that the fill is reserved for the open file and
     genuine multi-row selection, above. */
  .row:focus {
    outline: 1px solid var(--atrium-accent);
    outline-offset: -1px;
  }
  .row.drop-target-active {
    outline: 2px solid var(--atrium-accent);
    outline-offset: -2px;
  }
  .name.symlink {
    font-style: italic;
    opacity: 0.8;
  }
</style>
