<script lang="ts">
  import { onMount } from "svelte";
  import { workspaceGetRecents, workspaceRemoveRecent, type RecentProject } from "../ipc/commands";
  import { openWorkspaceFolder, openWorkspacePath } from "../stores/workspace";

  let recents = $state<RecentProject[]>([]);

  onMount(async () => {
    recents = await workspaceGetRecents();
  });

  async function openRecent(path: string): Promise<void> {
    await openWorkspacePath(path);
  }

  async function removeRecent(event: MouseEvent, path: string): Promise<void> {
    event.stopPropagation();
    await workspaceRemoveRecent(path);
    recents = recents.filter((r) => r.path !== path);
  }
</script>

<div class="welcome">
  <div class="welcome-content">
    <h1>Atrium</h1>
    <button class="open-folder" onclick={() => void openWorkspaceFolder()}>Open Folder…</button>

    <div class="recents">
      <h2>Recent</h2>
      {#if recents.length === 0}
        <p class="empty-state">No recent projects yet</p>
      {:else}
        <div role="list">
          {#each recents as project (project.path)}
            <div
              class="recent-row"
              onclick={() => void openRecent(project.path)}
              onkeydown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  void openRecent(project.path);
                }
              }}
              role="button"
              tabindex="0"
            >
              <div class="recent-info">
                <span class="recent-name">{project.name}</span>
                <span class="recent-path">{project.path}</span>
              </div>
              <button
                class="remove"
                onclick={(e) => void removeRecent(e, project.path)}
                aria-label={`Remove ${project.name} from recent projects`}
              >
                ×
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .welcome {
    height: 100vh;
    width: 100vw;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: auto;
  }
  .welcome-content {
    width: 100%;
    max-width: 480px;
    padding: 24px;
  }
  h1 {
    margin: 0 0 20px;
    font-size: 1.6em;
    text-align: center;
  }
  .open-folder {
    display: block;
    width: 100%;
    padding: 10px;
    font-size: 1em;
    cursor: pointer;
    border: 1px solid var(--atrium-border, #333);
    border-radius: 6px;
    background: var(--atrium-menu-bg, #24272c);
    color: inherit;
  }
  .open-folder:hover {
    background: var(--atrium-hover-bg, rgba(255, 255, 255, 0.08));
  }
  .recents {
    margin-top: 28px;
  }
  h2 {
    margin: 0 0 8px;
    font-size: 0.85em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--atrium-text-muted, #8a8f98);
  }
  .empty-state {
    color: var(--atrium-text-muted, #8a8f98);
  }
  .recent-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 6px;
    border-radius: 6px;
    cursor: pointer;
  }
  .recent-row:hover {
    background: var(--atrium-hover-bg, rgba(255, 255, 255, 0.08));
  }
  .recent-info {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .recent-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .recent-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.85em;
    color: var(--atrium-text-muted, #8a8f98);
  }
  .remove {
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    opacity: 0;
    padding: 0 6px;
    flex-shrink: 0;
  }
  .recent-row:hover .remove {
    opacity: 0.6;
  }
  .remove:hover {
    opacity: 1;
  }
</style>
