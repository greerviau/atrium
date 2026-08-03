<script lang="ts">
  import { get } from "svelte/store";
  import ContextMenu from "../ui/ContextMenu.svelte";
  import { workspace, openWorkspacePath } from "../stores/workspace";
  import { gitGetContext, gitSwitchBranch, type GitBranch, type GitContext } from "../ipc/commands";
  import { basename } from "../util/path";
  import { describeError, showErrorToast } from "../stores/errorToast";

  type OpenMenu = "worktree" | "branch" | null;

  let openMenu = $state<OpenMenu>(null);
  let rootEl: HTMLDivElement | undefined = $state();
  let worktreeButtonEl: HTMLButtonElement | undefined = $state();
  let branchButtonEl: HTMLButtonElement | undefined = $state();
  let context = $state<GitContext | null>(null);
  let loading = $state(false);
  let requestId = 0;

  const worktreeLabel = $derived(context ? basename(context.worktreePath) : "Git");
  const branchLabel = $derived(context?.branch ?? (context ? `detached @ ${context.head}` : ""));

  async function refresh(path: string): Promise<void> {
    const request = ++requestId;
    loading = true;
    try {
      const next = await gitGetContext(path);
      if (request === requestId) context = next;
    } catch {
      if (request === requestId) context = null;
    } finally {
      if (request === requestId) loading = false;
    }
  }

  $effect(() => {
    const root = $workspace.root;
    openMenu = null;
    context = null;
    if (root) void refresh(root);
  });

  function toggleMenu(menu: Exclude<OpenMenu, null>): void {
    openMenu = openMenu === menu ? null : menu;
    if (openMenu && $workspace.root) void refresh($workspace.root);
  }

  async function chooseWorktree(path: string): Promise<void> {
    openMenu = null;
    await openWorkspacePath(path);
  }

  async function chooseBranch(branch: GitBranch): Promise<void> {
    if (branch.isCurrent) {
      openMenu = null;
      return;
    }
    if (branch.worktreePath && context && branch.worktreePath !== context.worktreePath) {
      await chooseWorktree(branch.worktreePath);
      return;
    }

    const root = get(workspace).root;
    if (!root) return;
    openMenu = null;
    try {
      await gitSwitchBranch(root, branch.name);
      await refresh(root);
    } catch (err) {
      showErrorToast(`Could not switch branch: ${describeError(err)}`);
    }
  }

  function onWindowClick(event: MouseEvent): void {
    if (!openMenu) return;
    if (rootEl && event.target instanceof Node && rootEl.contains(event.target)) return;
    openMenu = null;
  }
</script>

<svelte:window onclick={onWindowClick} />

{#if $workspace.root && context}
  <div class="git-switcher" bind:this={rootEl} data-tauri-drag-region="false">
    <div class="git-control">
      <button
        class="git-switcher-btn"
        bind:this={worktreeButtonEl}
        onclick={() => toggleMenu("worktree")}
        aria-haspopup="true"
        aria-expanded={openMenu === "worktree"}
        aria-label="Switch worktree"
        title={context.worktreePath}
      >
        <span class="git-icon" aria-hidden="true">⑂</span>
        <span class="git-label">{worktreeLabel}</span>
        <span class="git-switcher-chevron" aria-hidden="true">▾</span>
      </button>
      {#if openMenu === "worktree"}
        <ContextMenu anchorEl={worktreeButtonEl}>
          <div class="git-menu" role="none">
            <div class="menu-heading">Worktrees</div>
            <div class="git-menu-list scrollbar-autohide" role="none">
              {#each context.worktrees as worktree (worktree.path)}
                <button
                  class:current={worktree.isCurrent}
                  role="menuitem"
                  disabled={worktree.isCurrent}
                  onclick={() => void chooseWorktree(worktree.path)}
                >
                  <span class="row-main">{basename(worktree.path)}</span>
                  <span class="row-detail">{worktree.branch ?? `detached @ ${worktree.head}`}</span>
                </button>
              {/each}
            </div>
          </div>
        </ContextMenu>
      {/if}
    </div>

    <div class="git-control">
      <button
        class="git-switcher-btn"
        bind:this={branchButtonEl}
        onclick={() => toggleMenu("branch")}
        aria-haspopup="true"
        aria-expanded={openMenu === "branch"}
        aria-label="Switch branch"
        title={branchLabel}
      >
        <svg class="git-icon" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
          <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"></path>
        </svg>
        <span class="git-label">{branchLabel}</span>
        <span class="git-switcher-chevron" aria-hidden="true">▾</span>
      </button>
      {#if openMenu === "branch"}
        <ContextMenu anchorEl={branchButtonEl}>
          <div class="git-menu" role="none">
            <div class="menu-heading">Branches</div>
            <div class="git-menu-list scrollbar-autohide" role="none">
              {#if context.branches.length === 0}
                <p class="empty-state">No local branches</p>
              {:else}
                {#each context.branches as branch (branch.name)}
                  <button
                    class:current={branch.isCurrent}
                    role="menuitem"
                    disabled={branch.isCurrent}
                    onclick={() => void chooseBranch(branch)}
                  >
                    <span class="row-main">{branch.name}</span>
                    {#if branch.worktreePath && branch.worktreePath !== context.worktreePath}
                      <span class="row-detail">in {basename(branch.worktreePath)}</span>
                    {/if}
                  </button>
                {/each}
              {/if}
            </div>
          </div>
        </ContextMenu>
      {/if}
    </div>
  </div>
{:else if $workspace.root && loading}
  <div class="git-switcher-placeholder" aria-hidden="true"></div>
{/if}

<style>
  .git-switcher,
  .git-switcher-placeholder {
    display: flex;
    align-items: center;
  }

  .git-switcher {
    gap: 2px;
  }

  .git-switcher-placeholder {
    width: 180px;
    height: 24px;
  }

  .git-control {
    display: inline-flex;
  }

  .git-switcher-btn {
    display: flex;
    align-items: center;
    gap: 5px;
    max-width: 180px;
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

  .git-switcher-btn:hover {
    opacity: 1;
    background: var(--atrium-bg-hover);
  }

  .git-icon {
    color: var(--atrium-text-secondary);
    flex-shrink: 0;
  }

  .git-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .git-switcher-chevron {
    opacity: 0.6;
    font-size: 0.8em;
    flex-shrink: 0;
  }

  .git-menu {
    display: flex;
    flex-direction: column;
    min-width: 220px;
    max-width: 360px;
    height: 300px;
    -webkit-user-select: text;
    user-select: text;
  }

  .git-menu-list {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
  }

  .menu-heading {
    padding: 5px 14px 3px;
    color: var(--atrium-text-muted);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
  }

  .git-menu button {
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }

  .row-main,
  .row-detail {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }

  .row-detail {
    color: var(--atrium-text-muted);
    font-size: 0.85em;
  }

  .git-menu button.current {
    color: var(--atrium-accent);
  }

  .git-menu .empty-state {
    margin: 0;
    padding: 6px 14px;
    color: var(--atrium-text-muted);
  }
</style>
