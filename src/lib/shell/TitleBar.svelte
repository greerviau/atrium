<script lang="ts">
  import { workspace, openWorkspaceFolder, openWorkspacePath } from "../stores/workspace";
  import { recents } from "../stores/recents";
  import { basename } from "../util/path";
  import ContextMenu from "../ui/ContextMenu.svelte";

  let open = $state(false);
  let buttonEl: HTMLButtonElement | undefined = $state();
  let rootEl: HTMLDivElement | undefined = $state();

  const otherRecents = $derived($recents.filter((r) => r.path !== $workspace.root));

  function toggleOpen(): void {
    open = !open;
  }

  async function switchTo(path: string): Promise<void> {
    open = false;
    await openWorkspacePath(path);
  }

  async function openFolder(): Promise<void> {
    open = false;
    await openWorkspaceFolder();
  }

  function onWindowClick(event: MouseEvent): void {
    if (!open) return;
    if (rootEl && event.target instanceof Node && rootEl.contains(event.target)) return;
    open = false;
  }
</script>

{#snippet folderIcon()}
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3">
    <path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.2 1.6h6.3a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1z" />
  </svg>
{/snippet}

<svelte:window onclick={onWindowClick} />

<div class="title-bar" data-tauri-drag-region="deep">
  {#if $workspace.root}
    <div class="switcher" bind:this={rootEl} data-tauri-drag-region="false">
      <button
        class="switcher-btn"
        bind:this={buttonEl}
        onclick={toggleOpen}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Switch project"
      >
        {@render folderIcon()}
        <span class="switcher-label">{basename($workspace.root)}</span>
        <span class="switcher-chevron" aria-hidden="true">▾</span>
      </button>
      {#if open}
        <ContextMenu anchorEl={buttonEl}>
          <div class="switcher-menu" role="none">
            {#if otherRecents.length === 0}
              <p class="empty-state">No other recent projects</p>
            {:else}
              {#each otherRecents as project (project.path)}
                <button class="recent-row" role="menuitem" onclick={() => void switchTo(project.path)}>
                  <span class="recent-name">{project.name}</span>
                  <span class="recent-path">{project.path}</span>
                </button>
              {/each}
            {/if}
            <div class="menu-separator"></div>
            <button role="menuitem" onclick={() => void openFolder()}>Open Folder…</button>
          </div>
        </ContextMenu>
      {/if}
    </div>
  {/if}
</div>

<style>
  .title-bar {
    /* Native traffic lights are positioned independently via trafficLightPosition in
       src-tauri/tauri.conf.json: x pairs with padding-left, y with this height. If height
       changes, re-derive y ≈ 21 + (height - 38) / 2 — 21 is empirically calibrated for
       this 38px bar, not a general offset formula to extrapolate from. */
    height: 38px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    padding-left: 78px;
    background: var(--atrium-bg-surface);
    border-bottom: 1px solid var(--atrium-border-subtle);
  }

  .switcher {
    display: flex;
    align-items: center;
  }

  .switcher-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: none;
    border-radius: 4px;
    color: inherit;
    font: inherit;
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
    opacity: 0.75;
    padding: 5px 8px;
  }

  .switcher-btn:hover {
    opacity: 1;
    background: var(--atrium-bg-hover);
  }

  .switcher-label {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .switcher-chevron {
    font-size: 0.8em;
    opacity: 0.7;
  }

  .switcher-menu {
    display: flex;
    flex-direction: column;
    min-width: 220px;
  }

  .switcher-menu .empty-state {
    margin: 0;
    padding: 6px 14px;
    color: var(--atrium-text-muted);
    white-space: nowrap;
  }

  .recent-row {
    display: flex;
    max-width: 320px;
  }

  .switcher-menu .recent-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }

  .recent-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }

  .recent-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
    font-size: 0.85em;
    color: var(--atrium-text-muted);
  }
</style>
