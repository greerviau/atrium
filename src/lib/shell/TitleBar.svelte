<script lang="ts">
  import { workspace, openWorkspaceFolder, openWorkspacePath } from "../stores/workspace";
  import { tabsState, openExternalFile } from "../stores/tabs";
  import { recents } from "../stores/recents";
  import type { RecentProject } from "../ipc/commands";
  import { basename } from "../util/path";
  import ContextMenu from "../ui/ContextMenu.svelte";

  let open = $state(false);
  let buttonEl: HTMLButtonElement | undefined = $state();
  let rootEl: HTMLDivElement | undefined = $state();

  // What this window is currently "showing," for both the button label and
  // excluding it from its own recents list: the project root, or — in a
  // root-less standalone workspace (issue #325's follow-on defect: the
  // switcher used to be unreachable there at all) — whichever tab is
  // currently active.
  const currentPath = $derived($workspace.root ?? $tabsState.activeTabPath);
  const switcherLabel = $derived(currentPath ? basename(currentPath) : "Untitled");
  const otherRecents = $derived($recents.filter((r) => r.path !== currentPath));

  function toggleOpen(): void {
    open = !open;
  }

  // A folder recent switches the project root as before; a file recent
  // (issue #325's follow-on: single-file opens are now recorded here too)
  // opens standalone instead — `openWorkspacePath` would misinterpret a
  // file path as a directory to switch into.
  async function switchTo(project: RecentProject): Promise<void> {
    open = false;
    if (project.isFile) {
      await openExternalFile(project.path);
    } else {
      await openWorkspacePath(project.path);
    }
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
  {#if $workspace.root || $tabsState.tabs.length > 0}
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
        <span class="switcher-label">{switcherLabel}</span>
        <span class="switcher-chevron" aria-hidden="true">▾</span>
      </button>
      {#if open}
        <ContextMenu anchorEl={buttonEl}>
          <div class="switcher-menu" role="none">
            {#if otherRecents.length === 0}
              <p class="empty-state">No other recent projects</p>
            {:else}
              {#each otherRecents as project (project.path)}
                <button class="recent-row" role="menuitem" onclick={() => void switchTo(project)}>
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
    /* The native traffic lights are laid out by AppKit, not by this element. They are
       centered against this height by src-tauri/src/macos_traffic_lights.rs, which
       mirrors it as TITLE_BAR_HEIGHT (and pairs TRAFFIC_LIGHT_X with the padding-left
       below, which reserves room for the cluster) — update those two constants
       alongside these. */
    height: 38px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    padding-left: 78px;
    background: var(--atrium-bg-surface);
    border-bottom: 1px solid var(--atrium-border-subtle);
    -webkit-user-select: none;
    user-select: none;
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
    -webkit-user-select: text;
    user-select: text;
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
