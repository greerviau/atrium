<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { fileTree, loadRoot, loadChildren } from "../stores/fileTree";
  import { workspace } from "../stores/workspace";
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
  bind:this={treeEl}
  oncontextmenu={onEmptyAreaContextMenu}
  onkeydown={onTreeContainerKeydown}
  tabindex="-1"
>
  {#if $fileTree.root}
    <div role="tree">
      <FileTreeNode node={$fileTree.root} />
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
