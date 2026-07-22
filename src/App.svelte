<script lang="ts">
  import { onMount } from "svelte";
  import FileTree from "./lib/explorer/FileTree.svelte";
  import EditorPane from "./lib/editor/EditorPane.svelte";
  import PaneSplit from "./lib/terminal/PaneSplit.svelte";
  import WelcomeScreen from "./lib/welcome/WelcomeScreen.svelte";
  import SearchOverlay from "./lib/search/SearchOverlay.svelte";
  import StatusBar from "./lib/shell/StatusBar.svelte";
  import { workspace, openWorkspacePath } from "./lib/stores/workspace";
  import {
    tabsState,
    setActiveTab,
    closeTab,
    reconcileExternalChange,
    toggleMarkdownViewMode,
  } from "./lib/stores/tabs";
  import { refreshDirectoryContaining } from "./lib/stores/fileTree";
  import { onFsChanged, onDockOpenPath } from "./lib/ipc/events";
  import { workspaceTakePendingOpen } from "./lib/ipc/commands";
  import { initMenuBar } from "./lib/shell/MenuBar";
  import {
    loadTerminalLayout,
    saveTerminalLayout,
    clampToContainer,
    HEIGHT_MIN,
    WIDTH_MIN,
    explorerVisible,
    terminalVisible,
    type TerminalPosition,
  } from "./lib/stores/layout";
  import { folderName } from "./lib/terminal/tabTitle";
  import {
    splitPane,
    removePane,
    resizeSplit,
    findLeaf,
    updateLeaf,
    nextActivePane,
    PANE_MIN_PX,
    type PaneNode,
    type LeafPane,
    type SplitDirection,
  } from "./lib/terminal/paneTree";
  import { zoom } from "./lib/stores/textSize";

  const initialLayout = loadTerminalLayout();

  let explorerWidth = $state(240);
  let terminalPosition = $state<TerminalPosition>(initialLayout.position);
  let terminalHeight = $state(initialLayout.height);
  let terminalWidth = $state(initialLayout.width);
  let mainEl: HTMLDivElement | undefined = $state();

  interface TerminalTab {
    id: string;
    paneTree: PaneNode;
    activePaneId: string;
  }
  let terminalTabs = $state<TerminalTab[]>([]);
  let activeTabId = $state<string | null>(null);
  let activeTab = $derived(terminalTabs.find((t) => t.id === activeTabId) ?? null);

  function genId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function newTerminalTab(): void {
    const root = $workspace.root;
    if (!root) return;
    const paneId = genId("pane");
    const leaf: LeafPane = { type: "leaf", id: paneId, cwd: root, title: folderName(root) };
    terminalTabs = [...terminalTabs, { id: genId("term"), paneTree: leaf, activePaneId: paneId }];
    activeTabId = terminalTabs[terminalTabs.length - 1].id;
  }

  function closeTerminalTab(id: string): void {
    terminalTabs = terminalTabs.filter((t) => t.id !== id);
    if (activeTabId === id) {
      activeTabId = terminalTabs[terminalTabs.length - 1]?.id ?? null;
    }
  }

  // Splits `paneId` within `tabId`, moving focus to the newly created pane
  // (matching VS Code's default: a split is immediately followed by typing
  // into the new shell, not the old one).
  function splitPaneAt(tabId: string, paneId: string, direction: SplitDirection): void {
    const root = $workspace.root;
    const tab = terminalTabs.find((t) => t.id === tabId);
    if (!tab || !root) return;
    // A new pane always starts at the tab's root cwd, matching new-tab
    // behavior, rather than wherever the pane being split has since cd'd to.
    const newLeaf: LeafPane = { type: "leaf", id: genId("pane"), cwd: root, title: folderName(root) };
    const paneTree = splitPane(tab.paneTree, paneId, direction, newLeaf);
    terminalTabs = terminalTabs.map((t) =>
      t.id === tabId ? { ...t, paneTree, activePaneId: newLeaf.id } : t,
    );
  }

  // Used by the tab-strip split buttons and the `Cmd/Ctrl+\` shortcut, which
  // have no specific pane of their own to act on — they always target
  // whichever pane in the active tab last had focus.
  function splitActivePane(direction: SplitDirection): void {
    const tab = terminalTabs.find((t) => t.id === activeTabId);
    if (!tab) return;
    splitPaneAt(tab.id, tab.activePaneId, direction);
  }

  function closePane(tabId: string, paneId: string): void {
    const tab = terminalTabs.find((t) => t.id === tabId);
    if (!tab) return;
    const nextActive = tab.activePaneId === paneId ? nextActivePane(tab.paneTree, paneId) : tab.activePaneId;
    const paneTree = removePane(tab.paneTree, paneId);
    if (paneTree === null) {
      closeTerminalTab(tabId);
      return;
    }
    terminalTabs = terminalTabs.map((t) =>
      t.id === tabId ? { ...t, paneTree, activePaneId: nextActive ?? t.activePaneId } : t,
    );
  }

  function setActivePane(tabId: string, paneId: string): void {
    terminalTabs = terminalTabs.map((t) => (t.id === tabId ? { ...t, activePaneId: paneId } : t));
  }

  function setPaneTitle(tabId: string, paneId: string, title: string): void {
    terminalTabs = terminalTabs.map((t) =>
      t.id === tabId ? { ...t, paneTree: updateLeaf(t.paneTree, paneId, { title }) } : t,
    );
  }

  function resizePaneSplit(tabId: string, splitId: string, index: number, delta: number, containerSizePx: number): void {
    const minRatio = containerSizePx > 0 ? PANE_MIN_PX / containerSizePx : 0;
    terminalTabs = terminalTabs.map((t) =>
      t.id === tabId ? { ...t, paneTree: resizeSplit(t.paneTree, splitId, index, delta, minRatio) } : t,
    );
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

  type MainSlot = "editor" | "resizer" | "terminal";
  // For "left", the terminal comes before the editor in DOM order (not just
  // visually via CSS) so keyboard tab order matches what's on screen. Each
  // slot's DOM subtree keeps its own identity across a position change
  // because {#each ... (slot)} is keyed by the (stable) slot name, not by
  // array index — the terminal subtree (and its running PTY session) is
  // only ever moved, never torn down and recreated.
  let mainSlotOrder = $derived<MainSlot[]>(
    terminalPosition === "left" ? ["terminal", "resizer", "editor"] : ["editor", "resizer", "terminal"],
  );

  // Showing the terminal panel with no tab open auto-spawns one, matching
  // the VS Code/JetBrains convention that toggling the terminal never
  // reveals a blank panel.
  let wasTerminalVisible = $terminalVisible;
  $effect(() => {
    const visible = $terminalVisible;
    if (visible && !wasTerminalVisible && terminalTabs.length === 0) {
      newTerminalTab();
    }
    wasTerminalVisible = visible;
  });

  function setTerminalPosition(position: TerminalPosition): void {
    terminalPosition = position;
    saveTerminalLayout({ position: terminalPosition, height: terminalHeight, width: terminalWidth });
  }

  function startDragTerminal(event: PointerEvent): void {
    event.preventDefault();
    function onUp(): void {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      saveTerminalLayout({ position: terminalPosition, height: terminalHeight, width: terminalWidth });
    }
    let onMove: (e: PointerEvent) => void;
    if (terminalPosition === "bottom") {
      const startY = event.clientY;
      const startHeight = terminalHeight;
      onMove = (e: PointerEvent): void => {
        const available = mainEl?.clientHeight ?? Infinity;
        terminalHeight = clampToContainer(startHeight - (e.clientY - startY), HEIGHT_MIN, available);
      };
    } else {
      const startX = event.clientX;
      const startWidth = terminalWidth;
      const sign = terminalPosition === "left" ? 1 : -1;
      onMove = (e: PointerEvent): void => {
        const available = mainEl?.clientWidth ?? Infinity;
        terminalWidth = clampToContainer(startWidth + sign * (e.clientX - startX), WIDTH_MIN, available);
      };
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  onMount(() => {
    if (mainEl) {
      terminalHeight = clampToContainer(terminalHeight, HEIGHT_MIN, mainEl.clientHeight);
      terminalWidth = clampToContainer(terminalWidth, WIDTH_MIN, mainEl.clientWidth);
    }
    void initMenuBar(newTerminalTab, () => splitActivePane("row"));
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
<SearchOverlay />
<div class="app-shell">
<main class="app">
  {#if $explorerVisible}
    <div class="explorer" style={`width: ${explorerWidth}px`}>
      <FileTree />
    </div>
    <div class="resizer vertical" role="separator" aria-orientation="vertical" onpointerdown={startDragExplorer}></div>
  {/if}

  <div class="main" class:row={terminalPosition !== "bottom"} bind:this={mainEl}>
    {#each mainSlotOrder as slot (slot)}
      {#if slot === "editor"}
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
                {#if tab.mode === "markdown"}
                  <button
                    class="tab-view-mode"
                    onclick={(e) => {
                      e.stopPropagation();
                      toggleMarkdownViewMode(tab.path);
                    }}
                    aria-label={tab.viewMode === "source" ? "Switch to rendered view" : "Switch to source view"}
                    title={tab.viewMode === "source" ? "Switch to rendered view" : "Switch to source view"}
                  >
                    {tab.viewMode === "source" ? "{}" : "¶"}
                  </button>
                {/if}
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
          <div class="editor-panes" style={`font-size: ${$zoom * 100}%`}>
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
          </div>
        </div>
      {:else if slot === "resizer"}
        <div
          class="resizer"
          class:horizontal={terminalPosition === "bottom"}
          class:vertical={terminalPosition !== "bottom"}
          class:hidden={!$terminalVisible}
          role="separator"
          aria-orientation={terminalPosition === "bottom" ? "horizontal" : "vertical"}
          onpointerdown={startDragTerminal}
        ></div>
      {:else}
        <div
          class="terminal-area"
          class:dock-left={terminalPosition === "left"}
          class:dock-right={terminalPosition === "right"}
          class:hidden={!$terminalVisible}
          style={terminalPosition === "bottom" ? `height: ${terminalHeight}px` : `width: ${terminalWidth}px`}
        >
          <div class="tab-strip">
            {#each terminalTabs as tab (tab.id)}
              <div
                class="tab"
                class:active={tab.id === activeTabId}
                onclick={() => (activeTabId = tab.id)}
                onkeydown={(e) => e.key === "Enter" && (activeTabId = tab.id)}
                role="tab"
                tabindex="0"
                aria-selected={tab.id === activeTabId}
              >
                <span class="tab-name" title={findLeaf(tab.paneTree, tab.activePaneId)?.title}>
                  {findLeaf(tab.paneTree, tab.activePaneId)?.title ?? ""}
                </span>
                <button
                  class="tab-close"
                  onclick={(e) => {
                    e.stopPropagation();
                    closeTerminalTab(tab.id);
                  }}
                  aria-label="Close terminal"
                >
                  ×
                </button>
              </div>
            {/each}
            {#if activeTab && activeTab.paneTree.type === "leaf"}
              <div class="dock-controls" role="group" aria-label="Split terminal">
                <button
                  class="dock-btn"
                  onclick={() => splitActivePane("row")}
                  aria-label="Split terminal right"
                  title="Split right (Cmd/Ctrl+\)"
                >
                  ⬒
                </button>
                <button
                  class="dock-btn"
                  onclick={() => splitActivePane("column")}
                  aria-label="Split terminal down"
                  title="Split down"
                >
                  ⬓
                </button>
              </div>
            {/if}
            <div class="dock-controls" role="group" aria-label="Terminal dock position">
              <button
                class="dock-btn"
                class:active={terminalPosition === "bottom"}
                onclick={() => setTerminalPosition("bottom")}
                aria-label="Dock terminal to bottom"
                aria-pressed={terminalPosition === "bottom"}
                title="Dock bottom"
              >
                ⬇
              </button>
              <button
                class="dock-btn"
                class:active={terminalPosition === "left"}
                onclick={() => setTerminalPosition("left")}
                aria-label="Dock terminal to left"
                aria-pressed={terminalPosition === "left"}
                title="Dock left"
              >
                ⬅
              </button>
              <button
                class="dock-btn"
                class:active={terminalPosition === "right"}
                onclick={() => setTerminalPosition("right")}
                aria-label="Dock terminal to right"
                aria-pressed={terminalPosition === "right"}
                title="Dock right"
              >
                ➡
              </button>
            </div>
            <button class="tab new-tab" onclick={newTerminalTab}>+</button>
          </div>
          <div class="terminal-panes">
            {#each terminalTabs as tab (tab.id)}
              <div class="terminal-pane-slot" class:hidden={tab.id !== activeTabId}>
                <PaneSplit
                  tree={tab.paneTree}
                  hasSplits={tab.paneTree.type === "split"}
                  activePaneId={tab.activePaneId}
                  workspaceId={$workspace.id}
                  onFocus={(paneId) => setActivePane(tab.id, paneId)}
                  onSplit={(paneId, direction) => splitPaneAt(tab.id, paneId, direction)}
                  onClose={(paneId) => closePane(tab.id, paneId)}
                  onTitleChange={(paneId, title) => setPaneTitle(tab.id, paneId, title)}
                  onResizeSplit={(splitId, index, delta, containerSizePx) =>
                    resizePaneSplit(tab.id, splitId, index, delta, containerSizePx)}
                />
              </div>
            {/each}
          </div>
        </div>
      {/if}
    {/each}
  </div>
</main>
<StatusBar />
</div>
{/if}

<style>
  .app-shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
  }
  .app {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .explorer {
    flex-shrink: 0;
    overflow: auto;
    border-right: 1px solid var(--atrium-border);
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
  .resizer.hidden {
    display: none;
  }
  .main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .main.row {
    flex-direction: row;
  }
  .editor-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }
  .tab-strip {
    display: flex;
    border-bottom: 1px solid var(--atrium-border);
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
    border-right: 1px solid var(--atrium-border);
    color: inherit;
    cursor: pointer;
    white-space: nowrap;
  }
  .tab.active {
    background: var(--atrium-bg-active);
  }
  .tab-name {
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tab-view-mode,
  .tab-close {
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    opacity: 0.6;
    padding: 0 2px;
  }
  .tab-view-mode:hover,
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
  .conflict-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    background: var(--atrium-warning-bg);
    color: var(--atrium-text-primary);
    flex-shrink: 0;
  }
  .terminal-area {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--atrium-border);
  }
  .terminal-area.dock-left {
    border-top: none;
    border-right: 1px solid var(--atrium-border);
  }
  .terminal-area.dock-right {
    border-top: none;
    border-left: 1px solid var(--atrium-border);
  }
  .terminal-area.hidden {
    display: none;
  }
  .dock-controls {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 4px;
    flex-shrink: 0;
  }
  .dock-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    border-radius: 3px;
    color: inherit;
    font: inherit;
    font-size: 11px;
    line-height: 1;
    cursor: pointer;
    opacity: 0.6;
    padding: 4px 6px;
  }
  .dock-btn:hover {
    opacity: 1;
  }
  .dock-btn.active {
    opacity: 1;
    background: var(--atrium-bg-active);
  }
</style>
