<script lang="ts">
  import { workspace } from "../stores/workspace";
  import { tabsState } from "../stores/tabs";
  import { cursorPosition } from "../stores/editorStatus";
  import { languageLabel } from "../editor/languageLabel";
  import {
    explorerVisible,
    terminalVisible,
    toggleExplorerVisible,
    toggleTerminalVisible,
  } from "../stores/layout";
  import { openSearch } from "../search/searchOverlay";
  import { openSettings } from "../stores/settingsOverlay";
  import { tooltip } from "../ui/tooltip";
  import { SHORTCUT_LABELS } from "./shortcutLabels";

  const activeTab = $derived($tabsState.tabs.find((t) => t.path === $tabsState.activeTabPath));

  function relativePath(path: string): string {
    const root = $workspace.root;
    if (!root) return path;
    const prefix = root.endsWith("/") ? root : `${root}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
  }

  const cursorText = $derived.by(() => {
    const pos = $cursorPosition;
    if (!pos) return "";
    const base = `Ln ${pos.line}, Col ${pos.col}`;
    if (!pos.selection) return base;
    const { lines, chars } = pos.selection;
    return lines > 1 ? `${base} (${lines} lines, ${chars} selected)` : `${base} (${chars} selected)`;
  });
</script>

{#snippet explorerIcon()}
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3">
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
    <line x1="6" y1="2.5" x2="6" y2="13.5" />
  </svg>
{/snippet}

{#snippet terminalIcon()}
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3">
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
    <path d="M4 6.2L7 8L4 9.8" stroke-linecap="round" stroke-linejoin="round" />
    <line x1="8.2" y1="10" x2="11.2" y2="10" stroke-linecap="round" />
  </svg>
{/snippet}

{#snippet searchIcon()}
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3">
    <circle cx="6.8" cy="6.8" r="4.3" />
    <line x1="10" y1="10" x2="14" y2="14" stroke-linecap="round" />
  </svg>
{/snippet}

{#snippet settingsIcon()}
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3">
    <circle cx="8" cy="8" r="2.3" />
    <path
      d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M12.5 3.5l-1.4 1.4M4.9 11.1l-1.4 1.4"
      stroke-linecap="round"
    />
  </svg>
{/snippet}

{#if $workspace.root}
  <div class="status-bar">
    <div class="status-group actions">
      <button
        class="status-btn"
        class:active={$explorerVisible}
        onclick={toggleExplorerVisible}
        aria-pressed={$explorerVisible}
        aria-label={`Toggle Explorer (${SHORTCUT_LABELS.toggleExplorer})`}
        use:tooltip={{ label: "Toggle Explorer", shortcut: SHORTCUT_LABELS.toggleExplorer }}
      >
        {@render explorerIcon()}
      </button>
      <button
        class="status-btn"
        class:active={$terminalVisible}
        onclick={toggleTerminalVisible}
        aria-pressed={$terminalVisible}
        aria-label={`Toggle Terminal (${SHORTCUT_LABELS.toggleTerminal})`}
        use:tooltip={{ label: "Toggle Terminal", shortcut: SHORTCUT_LABELS.toggleTerminal }}
      >
        {@render terminalIcon()}
      </button>
      <button
        class="status-btn"
        onclick={() => openSearch()}
        aria-label={`Search (${SHORTCUT_LABELS.findInFiles})`}
        use:tooltip={{ label: "Search", shortcut: SHORTCUT_LABELS.findInFiles }}
      >
        {@render searchIcon()}
      </button>
      <button
        class="status-btn"
        onclick={openSettings}
        aria-label={`Settings (${SHORTCUT_LABELS.settings})`}
        use:tooltip={{ label: "Settings", shortcut: SHORTCUT_LABELS.settings }}
      >
        {@render settingsIcon()}
      </button>
    </div>
    {#if activeTab}
      <div class="status-group indicators">
        <span class="status-item">{languageLabel(activeTab.path)}</span>
        <span class="status-divider">│</span>
        <span class="status-item mono">{cursorText}</span>
        <span class="status-divider">│</span>
        <span class="status-item mono path" title={relativePath(activeTab.path)}>{relativePath(activeTab.path)}</span>
      </div>
    {/if}
  </div>
{/if}

<style>
  .status-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 22px;
    flex-shrink: 0;
    border-top: 1px solid var(--atrium-border);
    padding: 0 8px;
    font-size: 11px;
    overflow: hidden;
  }
  .status-group {
    display: flex;
    align-items: center;
    min-width: 0;
  }
  .status-group.actions {
    gap: 2px;
    margin-left: 6px; /* clears the native macOS bottom-left window corner */
  }
  .status-group.indicators {
    gap: 6px;
    color: var(--atrium-text-muted);
  }
  .status-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    border-radius: 3px;
    color: inherit;
    font: inherit;
    line-height: 1;
    cursor: pointer;
    opacity: 0.6;
    padding: 2px 6px;
  }
  .status-btn:hover {
    opacity: 1;
    background: var(--atrium-bg-hover);
  }
  .status-btn.active {
    opacity: 1;
    background: var(--atrium-bg-active);
  }
  .status-item {
    white-space: nowrap;
  }
  .status-item.mono {
    font-family: var(--atrium-mono-font);
  }
  .status-item.path {
    overflow: hidden;
    text-overflow: ellipsis;
    direction: rtl;
    text-align: left;
  }
  .status-divider {
    opacity: 0.4;
  }
</style>
