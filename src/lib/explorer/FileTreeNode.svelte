<script lang="ts">
  import type { TreeNode } from "../stores/fileTree";
  import { toggleExpanded } from "../stores/fileTree";
  import { openFile } from "../stores/tabs";
  import { openContextMenu } from "./contextMenu";
  import { editingPath, pendingCreate, commitRename, commitCreate } from "./inlineEdit";
  import ExplorerIcon from "./icons/ExplorerIcon.svelte";
  import InlineNameInput from "./InlineNameInput.svelte";
  import NewEntryRow from "./NewEntryRow.svelte";
  import FileTreeNode from "./FileTreeNode.svelte";
  import { EXPLORER_PATH_DRAG_TYPE } from "../util/dragDropTypes";

  let { node, depth = 0 }: { node: TreeNode; depth?: number } = $props();

  let isEditing = $derived($editingPath === node.entry.path);

  function onClick(): void {
    if (node.entry.isDir) {
      void toggleExpanded(node);
    } else {
      void openFile(node.entry.path);
    }
  }

  function onContextMenu(event: MouseEvent): void {
    event.stopPropagation();
    openContextMenu(event, node.entry.path, node.entry.isDir);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onClick();
    }
  }

  function onDragStart(event: DragEvent): void {
    event.dataTransfer?.setData(EXPLORER_PATH_DRAG_TYPE, node.entry.path);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "copy";
    }
  }
</script>

<div class="node">
  <div
    class="row"
    style={`padding-left: ${depth * 14 + 6}px`}
    onclick={isEditing ? undefined : onClick}
    onkeydown={isEditing ? undefined : onKeydown}
    oncontextmenu={isEditing ? undefined : onContextMenu}
    draggable={!isEditing}
    ondragstart={isEditing ? undefined : onDragStart}
    role="treeitem"
    aria-selected="false"
    aria-expanded={node.entry.isDir ? node.expanded : undefined}
    tabindex="0"
  >
    <ExplorerIcon entry={node.entry} expanded={node.expanded} />
    {#if isEditing}
      <InlineNameInput
        initialValue={node.entry.name}
        selectExtension={!node.entry.isDir}
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
    {#if $pendingCreate?.parentPath === node.entry.path && $pendingCreate.isDir}
      <NewEntryRow
        depth={depth + 1}
        isDir={true}
        onCommit={(v) => commitCreate(node.entry.path, true, v)}
        onCancel={() => pendingCreate.set(null)}
      />
    {/if}
    {#each node.children.slice(0, dirEnd) as child (child.entry.path)}
      <FileTreeNode node={child} depth={depth + 1} />
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
      <FileTreeNode node={child} depth={depth + 1} />
    {/each}
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
    user-select: none;
  }
  .row:hover {
    background: var(--atrium-bg-hover);
  }
  .name.symlink {
    font-style: italic;
    opacity: 0.8;
  }
</style>
