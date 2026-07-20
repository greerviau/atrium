<script lang="ts">
  import { onMount } from "svelte";
  import FileTree from "./lib/explorer/FileTree.svelte";
  import EditorPane from "./lib/editor/EditorPane.svelte";
  import TerminalPane from "./lib/terminal/TerminalPane.svelte";
  import WelcomeScreen from "./lib/welcome/WelcomeScreen.svelte";
  import { workspace, openWorkspacePath } from "./lib/stores/workspace";
  import { tabsState, setActiveTab, closeTab, reconcileExternalChange } from "./lib/stores/tabs";
  import { refreshDirectoryContaining } from "./lib/stores/fileTree";
  import { onFsChanged, onDockOpenPath } from "./lib/ipc/events";
  import { workspaceTakePendingOpen } from "./lib/ipc/commands";
  import { initMenuBar } from "./lib/shell/MenuBar";

  let explorerWidth = $state(240);
  let terminalHeight = $state(240);

  interface TerminalSession {
    id: string;
    cwd: string;
  }
  let terminalSessions = $state<TerminalSession[]>([]);
  let activeTerminalId = $state<string | null>(null);

  function newTerminalTab(): void {
    const root = $workspace.root;
    if (!root) return;
    const id = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    terminalSessions = [...terminalSessions, { id, cwd: root }];
    activeTerminalId = id;
  }

  function closeTerminalTab(id: string): void {
    terminalSessions = terminalSessions.filter((t) => t.id !== id);
    if (activeTerminalId === id) {
      activeTerminalId = terminalSessions[terminalSessions.length - 1]?.id ?? null;
    }
  }

  function startDragExplorer(event: PointerEvent): void {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = explorerWidth;
    function onMove(e: PointerEvent): void {
      explorerWidth = Math.max(140, Math.min(600, startWidth + (e.clientX - startX)));
    }
    function onUp(): void {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function startDragTerminal(event: PointerEvent): void {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = terminalHeight;
    function onMove(e: PointerEvent): void {
      terminalHeight = Math.max(80, Math.min(700, startHeight - (e.clientY - startY)));
    }
    function onUp(): void {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  onMount(() => {
    void initMenuBar(newTerminalTab);
    void onFsChanged((event) => {
      void reconcileExternalChange(event.path);
      void refreshDirectoryContaining(event.path);
    });
    void onDockOpenPath((path) => void openWorkspacePath(path));
    void workspaceTakePendingOpen().then((path) => {
      if (path) void openWorkspacePath(path);
    });
  });
</script>

{#if !$workspace.root}
  <WelcomeScreen />
{:else}
<main class="app">
  <div class="explorer" style={`width: ${explorerWidth}px`}>
    <FileTree />
  </div>
  <div class="resizer vertical" role="separator" aria-orientation="vertical" onpointerdown={startDragExplorer}></div>

  <div class="main">
    <div class="editor-area">
      <div class="tab-strip">
        {#each $tabsState.tabs as tab (tab.path)}
          <div
            class="tab"
            class:active={tab.path === $tabsState.activeTabPath}
            onclick={() => setActiveTab(tab.path)}
            onkeydown={(e) => e.key === "Enter" && setActiveTab(tab.path)}
            role="tab"
            tabindex="0"
            aria-selected={tab.path === $tabsState.activeTabPath}
          >
            <span class="tab-name">
              {tab.path.split("/").pop()}{tab.isDirty ? " •" : ""}
            </span>
            <button
              class="tab-close"
              onclick={(e) => {
                e.stopPropagation();
                closeTab(tab.path);
              }}
              aria-label={`Close ${tab.path}`}
            >
              ×
            </button>
          </div>
        {/each}
      </div>
      <div class="editor-panes">
        {#each $tabsState.tabs as tab (tab.path)}
          <div class="editor-pane-slot" class:hidden={tab.path !== $tabsState.activeTabPath}>
            {#if tab.hasExternalConflict}
              <div class="conflict-banner">
                File changed on disk.
                <button onclick={() => reconcileExternalChange(tab.path)}>Reload</button>
              </div>
            {/if}
            <EditorPane filePath={tab.path} />
          </div>
        {/each}
        {#if $tabsState.tabs.length === 0}
          <div class="empty-state">Open a file from the explorer to start editing.</div>
        {/if}
      </div>
    </div>

    {#if $workspace.root}
      <div class="resizer horizontal" role="separator" aria-orientation="horizontal" onpointerdown={startDragTerminal}></div>
      <div class="terminal-area" style={`height: ${terminalHeight}px`}>
        <div class="tab-strip">
          {#each terminalSessions as session (session.id)}
            <div
              class="tab"
              class:active={session.id === activeTerminalId}
              onclick={() => (activeTerminalId = session.id)}
              onkeydown={(e) => e.key === "Enter" && (activeTerminalId = session.id)}
              role="tab"
              tabindex="0"
              aria-selected={session.id === activeTerminalId}
            >
              <span class="tab-name">Terminal</span>
              <button
                class="tab-close"
                onclick={(e) => {
                  e.stopPropagation();
                  closeTerminalTab(session.id);
                }}
                aria-label="Close terminal"
              >
                ×
              </button>
            </div>
          {/each}
          <button class="tab new-tab" onclick={newTerminalTab}>+</button>
        </div>
        <div class="terminal-panes">
          {#each terminalSessions as session (session.id)}
            <div class="terminal-pane-slot" class:hidden={session.id !== activeTerminalId}>
              <TerminalPane cwd={session.cwd} workspaceId={$workspace.id} onExit={() => closeTerminalTab(session.id)} />
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</main>
{/if}

<style>
  .app {
    display: flex;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
  }
  .explorer {
    flex-shrink: 0;
    overflow: auto;
    border-right: 1px solid var(--atrium-border, #333);
  }
  .resizer {
    background: transparent;
    flex-shrink: 0;
  }
  .resizer.vertical {
    width: 4px;
    cursor: col-resize;
  }
  .resizer.horizontal {
    height: 4px;
    cursor: row-resize;
  }
  .main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .editor-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .tab-strip {
    display: flex;
    border-bottom: 1px solid var(--atrium-border, #333);
    overflow-x: auto;
    flex-shrink: 0;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: none;
    border: none;
    border-right: 1px solid var(--atrium-border, #333);
    color: inherit;
    cursor: pointer;
    white-space: nowrap;
  }
  .tab.active {
    background: var(--atrium-active-tab-bg, rgba(128, 128, 128, 0.2));
  }
  .tab-close {
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    opacity: 0.6;
    padding: 0 2px;
  }
  .tab-close:hover {
    opacity: 1;
  }
  .editor-panes,
  .terminal-panes {
    flex: 1;
    min-height: 0;
    position: relative;
  }
  .editor-pane-slot,
  .terminal-pane-slot {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
  }
  .editor-pane-slot.hidden,
  .terminal-pane-slot.hidden {
    display: none;
  }
  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    opacity: 0.5;
  }
  .conflict-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    background: #7a4a1a;
    color: white;
    flex-shrink: 0;
  }
  .terminal-area {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--atrium-border, #333);
  }
</style>
