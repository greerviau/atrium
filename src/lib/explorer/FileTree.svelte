<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { fileTree, loadRoot } from "../stores/fileTree";
  import { workspace } from "../stores/workspace";
  import {
    contextMenu,
    closeContextMenu,
    openContextMenu,
    newFile,
    newFolder,
    rename,
    deletePath,
    revealInFinder,
  } from "./contextMenu";
  import FileTreeNode from "./FileTreeNode.svelte";
  import ContextMenu from "../ui/ContextMenu.svelte";
  import { attachScrollbarAutoHide } from "../ui/scrollbarAutoHide";

  let treeEl: HTMLDivElement;
  let detach: (() => void) | undefined;

  onMount(() => {
    detach = attachScrollbarAutoHide(treeEl);
  });
  onDestroy(() => detach?.());

  let promptState = $state<
    | { kind: "new-file"; dir: string; value: string }
    | { kind: "new-folder"; dir: string; value: string }
    | { kind: "rename"; path: string; value: string }
    | null
  >(null);
  let deleteTarget = $state<{ path: string; isDir: boolean } | null>(null);
  let isRootContextMenu = $derived($contextMenu?.path === $fileTree.root?.entry.path);

  $effect(() => {
    if ($workspace.root) {
      void loadRoot($workspace.root);
    }
  });

  function dirOf(path: string): string {
    const idx = path.replace(/\\/g, "/").lastIndexOf("/");
    return idx <= 0 ? path : path.slice(0, idx);
  }

  function startNewFile(): void {
    if (!$contextMenu) return;
    const dir = $contextMenu.isDir ? $contextMenu.path : dirOf($contextMenu.path);
    promptState = { kind: "new-file", dir, value: "" };
    closeContextMenu();
  }

  function startNewFolder(): void {
    if (!$contextMenu) return;
    const dir = $contextMenu.isDir ? $contextMenu.path : dirOf($contextMenu.path);
    promptState = { kind: "new-folder", dir, value: "" };
    closeContextMenu();
  }

  function startRename(): void {
    if (!$contextMenu) return;
    const name = $contextMenu.path.replace(/\\/g, "/").split("/").pop() ?? "";
    promptState = { kind: "rename", path: $contextMenu.path, value: name };
    closeContextMenu();
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

  async function submitPrompt(): Promise<void> {
    const current = promptState;
    if (!current || current.value.trim() === "") {
      promptState = null;
      return;
    }
    if (current.kind === "new-file") {
      await newFile(current.dir, current.value.trim());
    } else if (current.kind === "new-folder") {
      await newFolder(current.dir, current.value.trim());
    } else {
      await rename(current.path, current.value.trim());
    }
    promptState = null;
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

{#if promptState}
  <div class="modal-backdrop">
    <div class="modal">
      <p>
        {#if promptState.kind === "new-file"}New file name{:else if promptState.kind === "new-folder"}New folder name{:else}Rename to{/if}
      </p>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        bind:value={promptState.value}
        onkeydown={(e) => e.key === "Enter" && submitPrompt()}
        autofocus
      />
      <div class="actions">
        <button onclick={() => (promptState = null)}>Cancel</button>
        <button onclick={submitPrompt}>OK</button>
      </div>
    </div>
  </div>
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
