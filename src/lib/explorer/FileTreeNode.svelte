<script lang="ts">
  import type { TreeNode } from "../stores/fileTree";
  import { toggleExpanded } from "../stores/fileTree";
  import { openFile } from "../stores/tabs";
  import { openContextMenu } from "./contextMenu";
  import ExplorerIcon from "./icons/ExplorerIcon.svelte";
  import FileTreeNode from "./FileTreeNode.svelte";
  import { EXPLORER_PATH_DRAG_TYPE } from "../util/dragDropTypes";

  let { node, depth = 0 }: { node: TreeNode; depth?: number } = $props();

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
    onclick={onClick}
    onkeydown={onKeydown}
    oncontextmenu={onContextMenu}
    draggable="true"
    ondragstart={onDragStart}
    role="treeitem"
    aria-selected="false"
    aria-expanded={node.entry.isDir ? node.expanded : undefined}
    tabindex="0"
  >
    <ExplorerIcon entry={node.entry} expanded={node.expanded} />
    <span class="name" class:symlink={node.entry.isSymlink}>{node.entry.name}</span>
  </div>
  {#if node.entry.isDir && node.expanded && node.children}
    {#each node.children as child (child.entry.path)}
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
