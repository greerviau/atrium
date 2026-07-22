<script lang="ts">
  import { onMount } from "svelte";
  import FileTree from "./lib/explorer/FileTree.svelte";
  import EditorPane from "./lib/editor/EditorPane.svelte";
  import PaneSplit from "./lib/terminal/PaneSplit.svelte";
  import WelcomeScreen from "./lib/welcome/WelcomeScreen.svelte";
  import SearchOverlay from "./lib/search/SearchOverlay.svelte";
  import UnsavedChangesDialog from "./lib/shell/UnsavedChangesDialog.svelte";
  import StatusBar from "./lib/shell/StatusBar.svelte";
  import DockSettingsMenu from "./lib/terminal/DockSettingsMenu.svelte";
  import { workspace, openWorkspacePath } from "./lib/stores/workspace";
  import {
    tabsState,
    setActiveTab,
    requestCloseTab,
    reconcileExternalChange,
    reloadFromDisk,
    dismissConflict,
    toggleMarkdownViewMode,
  } from "./lib/stores/tabs";
  import { closePrompt } from "./lib/stores/closePrompt";
  import { refreshDirectoryContaining } from "./lib/stores/fileTree";
  import { onFsChanged, onDockOpenPath, onCloseRequested, onDragDropEvent } from "./lib/ipc/events";
  import { insertPathsAtScreenPoint } from "./lib/terminal/terminalDropTargets";
  import { workspaceTakePendingOpen, appConfirmClose } from "./lib/ipc/commands";
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
    listLeaves,
    nextActivePane,
    addTabToLeaf,
    closeTabInLeaf,
    setActiveTabInLeaf,
    updateSessionInLeaf,
    PANE_MIN_PX,
    type PaneNode,
    type LeafPane,
    type TerminalSession,
    type SplitDirection,
  } from "./lib/terminal/paneTree";
  import { zoom } from "./lib/stores/textSize";

  const initialLayout = loadTerminalLayout();

  let explorerWidth = $state(240);
  let terminalPosition = $state<TerminalPosition>(initialLayout.position);
  let terminalHeight = $state(initialLayout.height);
  let terminalWidth = $state(initialLayout.width);
  let mainEl: HTMLDivElement | undefined = $state();

  // A single pane tree for the whole terminal dock — splitting no longer
  // creates an independent tab, it adds a sibling panel to this same tree,
  // each leaf owning its own tabs (see paneTree.ts). `focusedPaneId` tracks
  // whichever leaf last had focus, which is what keyboard shortcuts and menu
  // commands with no pane of their own act on.
  let terminalPaneTree = $state<PaneNode | null>(null);
  let focusedPaneId = $state<string | null>(null);

  // Blocks the auto-spawn effect (below) from immediately retrying right
  // after a session's own shell exits within CRASH_EXIT_WINDOW_MS of being
  // spawned, as opposed to its tab being closed via the × button or a
  // session the user actually worked in for a while: TerminalPane's onExit
  // routes through exitTabInPane (not closeTabInPane), which sets this
  // before removing the tab only when the exit looks like a crash. Without
  // it, a shell that exits right after starting (e.g. $SHELL pointing at a
  // binary that exits immediately, or an rc file that hits exit) would
  // respawn, exit, respawn — forever. Every explicit "open a terminal"
  // gesture — closing/opening a tab through the UI, toggling the dock
  // visible, or opening a workspace — clears it again, so each still gets
  // its own single attempt.
  let suppressAutoSpawn = $state(false);

  function genId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function spawnSession(root: string): TerminalSession {
    return { id: genId("term"), cwd: root, title: folderName(root) };
  }

  // Adds a new tab to a specific panel — used by that panel's own `+` button,
  // where the target pane id is already known.
  function addTabToPane(paneId: string): void {
    const root = $workspace.root;
    if (!root || !terminalPaneTree) return;
    terminalPaneTree = addTabToLeaf(terminalPaneTree, paneId, spawnSession(root));
    focusedPaneId = paneId;
  }

  // Used by `Cmd/Ctrl+T` and the native menu, which have no specific panel of
  // their own to act on: opens the first panel if the dock is empty,
  // otherwise adds a tab to whichever panel last had focus.
  function newTerminalTab(): void {
    const root = $workspace.root;
    if (!root) return;
    suppressAutoSpawn = false;
    if (!terminalPaneTree) {
      const paneId = genId("pane");
      const session = spawnSession(root);
      terminalPaneTree = { type: "leaf", id: paneId, tabs: [session], activeTabId: session.id };
      focusedPaneId = paneId;
      return;
    }
    const target =
      focusedPaneId && findLeaf(terminalPaneTree, focusedPaneId) ? focusedPaneId : listLeaves(terminalPaneTree)[0].id;
    addTabToPane(target);
  }

  // Splits `paneId`, moving focus to the newly created panel (matching VS
  // Code's default: a split is immediately followed by typing into the new
  // shell, not the old one).
  function splitPaneAt(paneId: string, direction: SplitDirection): void {
    const root = $workspace.root;
    if (!terminalPaneTree || !root) return;
    // A new panel's first tab always starts at the workspace root, matching
    // new-tab behavior, rather than wherever the panel being split has since
    // cd'd to.
    const session = spawnSession(root);
    const newLeaf: LeafPane = { type: "leaf", id: genId("pane"), tabs: [session], activeTabId: session.id };
    terminalPaneTree = splitPane(terminalPaneTree, paneId, direction, newLeaf);
    focusedPaneId = newLeaf.id;
  }

  // Used by the `Cmd/Ctrl+\` shortcut, which has no specific panel of its
  // own to act on — always targets whichever panel last had focus.
  function splitFocusedPane(direction: SplitDirection): void {
    if (!terminalPaneTree) return;
    const target =
      focusedPaneId && findLeaf(terminalPaneTree, focusedPaneId) ? focusedPaneId : listLeaves(terminalPaneTree)[0]?.id;
    if (target) splitPaneAt(target, direction);
  }

  // Force-closes an entire panel and all its tabs at once (the tab-strip's
  // "close panel" button, shown only once there's more than one panel).
  function closePanel(paneId: string): void {
    if (!terminalPaneTree) return;
    suppressAutoSpawn = false;
    const nextFocus = focusedPaneId === paneId ? nextActivePane(terminalPaneTree, paneId) : focusedPaneId;
    terminalPaneTree = removePane(terminalPaneTree, paneId);
    focusedPaneId = terminalPaneTree ? (nextFocus ?? focusedPaneId) : null;
  }

  function removeTabFromPane(paneId: string, sessionId: string): void {
    if (!terminalPaneTree) return;
    const leaf = findLeaf(terminalPaneTree, paneId);
    const isPanelsLastTab = leaf?.tabs.length === 1;
    const nextFocus = isPanelsLastTab && focusedPaneId === paneId ? nextActivePane(terminalPaneTree, paneId) : focusedPaneId;
    terminalPaneTree = closeTabInLeaf(terminalPaneTree, paneId, sessionId);
    focusedPaneId = terminalPaneTree ? (nextFocus ?? focusedPaneId) : null;
  }

  // The tab's × button — a deliberate close — always clears the auto-spawn
  // guard, so if this empties the dock the invariant below gets a fresh
  // spawn attempt (matching the "closing the last tab" case it exists for).
  function closeTabInPane(paneId: string, sessionId: string): void {
    suppressAutoSpawn = false;
    removeTabFromPane(paneId, sessionId);
  }

  // A shell that exits within this window of being spawned is treated as
  // crash-looping (a broken $SHELL, or an rc file that hits exit) rather
  // than a deliberate exit/Ctrl-D from a session the user was actually
  // using — see exitTabInPane below.
  const CRASH_EXIT_WINDOW_MS = 1000;

  // TerminalPane's onExit — the PTY itself exiting, not the user closing
  // its tab — routes through here instead of closeTabInPane. Only an exit
  // within CRASH_EXIT_WINDOW_MS of spawning sets the guard; a session that
  // ran long enough to be a deliberate close gets the same fresh respawn
  // attempt closeTabInPane gives the × button. See suppressAutoSpawn above.
  function exitTabInPane(paneId: string, sessionId: string, elapsedMs: number): void {
    suppressAutoSpawn = elapsedMs < CRASH_EXIT_WINDOW_MS;
    removeTabFromPane(paneId, sessionId);
  }

  function setActiveTabInPane(paneId: string, sessionId: string): void {
    if (!terminalPaneTree) return;
    terminalPaneTree = setActiveTabInLeaf(terminalPaneTree, paneId, sessionId);
    focusedPaneId = paneId;
  }

  function setSessionTitle(paneId: string, sessionId: string, title: string): void {
    if (!terminalPaneTree) return;
    terminalPaneTree = updateSessionInLeaf(terminalPaneTree, paneId, sessionId, { title });
  }

  function setFocusedPane(paneId: string): void {
    focusedPaneId = paneId;
  }

  function resizePaneSplit(splitId: string, index: number, delta: number, containerSizePx: number): void {
    if (!terminalPaneTree) return;
    const minRatio = containerSizePx > 0 ? PANE_MIN_PX / containerSizePx : 0;
    terminalPaneTree = resizeSplit(terminalPaneTree, splitId, index, delta, minRatio);
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

  // Toggling the dock visible or opening a workspace are themselves
  // explicit "give me a terminal" gestures, so each always gets a fresh
  // auto-spawn attempt below — clearing any guard left behind by an
  // earlier session that exited on its own (see suppressAutoSpawn).
  $effect(() => {
    void $terminalVisible;
    void $workspace.root;
    suppressAutoSpawn = false;
  });

  // The terminal dock never sits open with no active session: whenever it's
  // visible and the pane tree is empty — on first mount, after toggling it
  // open, or because the user closed the last remaining tab/panel while it
  // was already open — this spawns one, matching the VS Code/JetBrains
  // convention that the terminal panel never shows a blank panel. Guarded by
  // suppressAutoSpawn so a session that exits immediately after spawning
  // can't respawn itself forever.
  $effect(() => {
    if ($terminalVisible && $workspace.root && terminalPaneTree === null && !suppressAutoSpawn) {
      newTerminalTab();
    }
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
    void initMenuBar(newTerminalTab, () => splitFocusedPane("right"));
    void onFsChanged((event) => {
      void reconcileExternalChange(event.path);
      void refreshDirectoryContaining(event.path);
    });
    void onDockOpenPath((path) => void openWorkspacePath(path));
    void onDragDropEvent((event) => {
      if (event.type !== "drop") return;
      const logical = event.position.toLogical(window.devicePixelRatio);
      insertPathsAtScreenPoint(event.paths, logical.x, logical.y);
    });
    void onCloseRequested(() => {
      const dirty = $tabsState.tabs.filter((t) => t.isDirty);
      if (dirty.length === 0) {
        void appConfirmClose();
        return;
      }
      closePrompt.set({ kind: "window", paths: dirty.map((t) => t.path) });
    });
    void workspaceTakePendingOpen().then((path) => {
      if (path) void openWorkspacePath(path);
    });
  });
</script>

{#if !$workspace.root}
  <WelcomeScreen />
{:else}
<SearchOverlay />
<UnsavedChangesDialog />
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
                    requestCloseTab(tab.path);
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
                    <button onclick={() => reloadFromDisk(tab.path)}>Reload</button>
                    <button onclick={() => dismissConflict(tab.path)}>Keep mine</button>
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
          <div class="terminal-dock-header">
            <DockSettingsMenu position={terminalPosition} onSetPosition={setTerminalPosition} />
          </div>
          <div class="terminal-panes">
            {#if terminalPaneTree}
              <div class="terminal-pane-slot">
                <PaneSplit
                  tree={terminalPaneTree}
                  hasSplits={terminalPaneTree.type === "split"}
                  activePaneId={focusedPaneId ?? ""}
                  workspaceId={$workspace.id}
                  onFocus={setFocusedPane}
                  onSplit={(paneId, direction) => splitPaneAt(paneId, direction)}
                  onClose={(paneId) => closePanel(paneId)}
                  onNewTab={(paneId) => addTabToPane(paneId)}
                  onCloseTab={(paneId, sessionId) => closeTabInPane(paneId, sessionId)}
                  onSessionExit={(paneId, sessionId, elapsedMs) => exitTabInPane(paneId, sessionId, elapsedMs)}
                  onSetActiveTab={(paneId, sessionId) => setActiveTabInPane(paneId, sessionId)}
                  onTitleChange={(paneId, sessionId, title) => setSessionTitle(paneId, sessionId, title)}
                  onResizeSplit={(splitId, index, delta, containerSizePx) =>
                    resizePaneSplit(splitId, index, delta, containerSizePx)}
                />
              </div>
            {:else}
              <div class="terminal-empty">
                <button class="new-tab" onclick={newTerminalTab}>+ New Terminal</button>
              </div>
            {/if}
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
  .editor-pane-slot.hidden {
    display: none;
  }
  .terminal-empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .terminal-empty .new-tab {
    background: none;
    border: 1px solid var(--atrium-border);
    border-radius: 4px;
    color: inherit;
    font: inherit;
    cursor: pointer;
    padding: 6px 12px;
    opacity: 0.7;
  }
  .terminal-empty .new-tab:hover {
    opacity: 1;
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
  .terminal-dock-header {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-shrink: 0;
    padding: 2px 4px;
    border-bottom: 1px solid var(--atrium-border);
  }
</style>
