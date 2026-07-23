<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { fileTree, loadRoot, loadChildren } from "../stores/fileTree";
  import { workspace } from "../stores/workspace";
  import {
    contextMenu,
    closeContextMenu,
    openContextMenu,
    deletePath,
  } from "./contextMenu";
  import { revealInFinder } from "../ipc/reveal";
  import { editingPath, pendingCreate, settleActiveEdit } from "./inlineEdit";
  import FileTreeNode from "./FileTreeNode.svelte";
  import ContextMenu from "../ui/ContextMenu.svelte";
  import { attachScrollbarAutoHide } from "../ui/scrollbarAutoHide";
  import { dirOf } from "../util/path";

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

  async function startNewFile(): Promise<void> {
    if (!$contextMenu) return;
    const dir = $contextMenu.isDir ? $contextMenu.path : dirOf($contextMenu.path);
    await beginCreate(dir, false);
  }

  async function startNewFolder(): Promise<void> {
    if (!$contextMenu) return;
    const dir = $contextMenu.isDir ? $contextMenu.path : dirOf($contextMenu.path);
    await beginCreate(dir, true);
  }

  function startRename(): void {
    if (!$contextMenu) return;
    const path = $contextMenu.path;
    closeContextMenu();
    settleActiveEdit();
    pendingCreate.set(null);
    editingPath.set(path);
  }

  function startDelete(): void {
    if (!$contextMenu) return;
    deleteTarget = { path: $contextMenu.path, isDir: $contextMenu.isDir };
    closeContextMenu();
  }

  async function reveal(): Promise<void> {
    if (!$contextMenu) return;
    const path = $contextMenu.path;
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
</script>

<svelte:window onclick={() => closeContextMenu()} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="file-tree" bind:this={treeEl} oncontextmenu={onEmptyAreaContextMenu}>
  {#if $fileTree.root}
    <div role="tree">
      <FileTreeNode node={$fileTree.root} />
    </div>
  {/if}
</div>

{#if $contextMenu}
  <ContextMenu x={$contextMenu.x} y={$contextMenu.y}>
    <button role="menuitem" onclick={startNewFile}>New File</button>
    <button role="menuitem" onclick={startNewFolder}>New Folder</button>
    {#if !isRootContextMenu}
      <button role="menuitem" onclick={startRename}>Rename</button>
      <button role="menuitem" onclick={startDelete}>Delete</button>
    {/if}
    <button role="menuitem" onclick={() => void reveal()}>Reveal in Finder</button>
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
