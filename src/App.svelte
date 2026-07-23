<script lang="ts">
  import { onMount } from "svelte";
  import FileTree from "./lib/explorer/FileTree.svelte";
  import EditorPaneSplit from "./lib/editor/EditorPaneSplit.svelte";
  import PaneSplit from "./lib/terminal/PaneSplit.svelte";
  import WelcomeScreen from "./lib/welcome/WelcomeScreen.svelte";
  import SearchOverlay from "./lib/search/SearchOverlay.svelte";
  import UnsavedChangesDialog from "./lib/shell/UnsavedChangesDialog.svelte";
  import SettingsDialog from "./lib/shell/SettingsDialog.svelte";
  import KeyboardShortcutsDialog from "./lib/shell/KeyboardShortcutsDialog.svelte";
  import StatusBar from "./lib/shell/StatusBar.svelte";
  import { workspace, openWorkspacePath } from "./lib/stores/workspace";
  import { tabsState, setActiveTab, requestCloseTab, reconcileExternalChange } from "./lib/stores/tabs";
  import { closePrompt } from "./lib/stores/closePrompt";
  import { refreshDirectoryContaining } from "./lib/stores/fileTree";
  import { onFsChanged, onDockOpenPath, onCloseRequested, onDragDropEvent } from "./lib/ipc/events";
  import { insertPathsAtScreenPoint } from "./lib/terminal/terminalDropTargets";
  import { resolveExplorerDropTargetDir } from "./lib/explorer/explorerDropTargets";
  import { importPathsInto } from "./lib/explorer/importExternalPaths";
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
    terminalPosition,
  } from "./lib/stores/layout";
  import { folderName } from "./lib/terminal/tabTitle";
  import {
    splitPane,
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
  import {
    splitPane as splitEditorPane,
    resizeSplit as resizeEditorSplit,
    findLeaf as findEditorLeaf,
    listLeaves as listEditorLeaves,
    nextActivePane as nextActiveEditorPane,
    addTabToLeaf as addEditorTabToLeaf,
    closeTabInLeaf as closeEditorTabInLeaf,
    setActiveTabInLeaf as setActiveTabInEditorLeaf,
    pruneMissingTabs,
    type EditorPaneNode,
    type EditorLeafPane,
  } from "./lib/editor/editorPaneTree";
  import { focusedEditorPaneId, editorPaneTree } from "./lib/stores/editorPanes";

  const initialLayout = loadTerminalLayout();

  let explorerWidth = $state(240);
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

  // A single pane tree for the editor, parallel to `terminalPaneTree` above
  // — a split adds a sibling panel to this same tree, each leaf owning its
  // own tab strip of open paths (see editorPaneTree.ts). Unlike the
  // terminal, split panes over the same path don't yet share live content:
  // each pane's `EditorPane` mounts its own `EditorView` from the file's
  // current `savedDoc` at split time (issue #158's PR 1) — cross-view
  // content sync is a follow-up.
  //
  // Both `editorPaneTree` and `focusedEditorPaneId` (unlike `terminalPaneTree`/
  // `focusedPaneId` above) live in stores (`src/lib/stores/editorPanes.ts`),
  // not local state: `EditorPane.svelte`, several components below this one,
  // needs to read the whole tree directly — not just its own pane — to
  // decide whether it's the one pane, among possibly several showing the
  // same path, that owns driving the global cursor-position store or
  // responding to a save request for that path.

  // `tabsState.activeTabPath` is kept as a mirror of "the focused editor
  // pane's own active tab" — `MenuBar.ts`'s save handler and `StatusBar.svelte`
  // both just read it, unaware panes exist at all. Every pane-focus or
  // per-leaf active-tab change below calls this afterward to keep it in sync.
  function syncActiveTabToFocusedPane(): void {
    if (!$editorPaneTree || !$focusedEditorPaneId) return;
    const leaf = findEditorLeaf($editorPaneTree, $focusedEditorPaneId);
    if (leaf?.activeTabPath) setActiveTab(leaf.activeTabPath);
  }

  function setFocusedEditorPane(paneId: string): void {
    $focusedEditorPaneId = paneId;
    syncActiveTabToFocusedPane();
  }

  function setActiveTabInEditorPane(paneId: string, path: string): void {
    if (!$editorPaneTree) return;
    $editorPaneTree = setActiveTabInEditorLeaf($editorPaneTree, paneId, path);
    $focusedEditorPaneId = paneId;
    syncActiveTabToFocusedPane();
  }

  // Splits `paneId`, duplicating its own currently-active tab into the new
  // pane and focusing that new pane — this one primitive covers both of
  // issue #158's scenarios: a single-file pane's only tab is its active tab
  // (scenario 1, "duplicate the file"), and a multi-tab pane's active tab is
  // whichever one the user had selected (scenario 2, "split just the active
  // tab") — the original pane's own tab strip is never touched either way.
  function splitEditorPaneAt(paneId: string, direction: SplitDirection): void {
    if (!$editorPaneTree) return;
    const activePath = findEditorLeaf($editorPaneTree, paneId)?.activeTabPath;
    if (!activePath) return;
    const newLeaf: EditorLeafPane = { type: "leaf", id: genId("epane"), tabs: [activePath], activeTabPath: activePath };
    $editorPaneTree = splitEditorPane($editorPaneTree, paneId, direction, newLeaf);
    $focusedEditorPaneId = newLeaf.id;
    syncActiveTabToFocusedPane();
  }

  function pathOpenInOtherEditorLeaf(tree: EditorPaneNode, path: string, excludeLeafId: string): boolean {
    return listEditorLeaves(tree).some((leaf) => leaf.id !== excludeLeafId && leaf.tabs.includes(path));
  }

  // The tab's × button inside one leaf's own tab strip. If `path` is also
  // open in another pane, this only closes *this* pane's view of it — the
  // file itself, and the other pane's view, are untouched, and (per the
  // plan) this must never raise the unsaved-changes prompt in that case,
  // since the file isn't actually being closed. Only when this was the last
  // pane showing `path` does it defer to the ordinary file-close flow
  // (`requestCloseTab`, with its dirty check) — the reconciliation `$effect`
  // below removes `path` from `editorPaneTree` once `tabsState` actually
  // drops it, whether that happens immediately (a clean tab) or later,
  // asynchronously, via the unsaved-changes dialog.
  function closeTabInEditorPane(paneId: string, path: string): void {
    if (!$editorPaneTree) return;
    if (pathOpenInOtherEditorLeaf($editorPaneTree, path, paneId)) {
      const leaf = findEditorLeaf($editorPaneTree, paneId);
      const isPanesLastTab = leaf?.tabs.length === 1;
      const currentFocus = $focusedEditorPaneId;
      const nextFocus =
        isPanesLastTab && currentFocus === paneId ? nextActiveEditorPane($editorPaneTree, paneId) : currentFocus;
      $editorPaneTree = closeEditorTabInLeaf($editorPaneTree, paneId, path);
      $focusedEditorPaneId = $editorPaneTree ? (nextFocus ?? currentFocus) : null;
      syncActiveTabToFocusedPane();
    } else {
      requestCloseTab(path);
    }
  }

  function resizeEditorPaneSplit(splitId: string, index: number, delta: number, containerSizePx: number): void {
    if (!$editorPaneTree) return;
    const minRatio = containerSizePx > 0 ? PANE_MIN_PX / containerSizePx : 0;
    $editorPaneTree = resizeEditorSplit($editorPaneTree, splitId, index, delta, minRatio);
  }

  // Ensures whatever `tabsState.activeTabPath` currently points at (set by
  // `openFile()` from the explorer/search/links, or by this file's own
  // pane-focus sync above) is open *and selected* in the editor — creating
  // the first pane on the very first file open (mirroring the terminal's own
  // lazy-init), revealing-and-focusing whichever pane already has it open
  // rather than duplicating it, or adding a genuinely new path into the
  // focused pane. Every branch below leaves the focused leaf's own
  // `activeTabPath` equal to `path` by construction, which is what keeps the
  // "`tabsState.activeTabPath` mirrors the focused pane" invariant above from
  // drifting — without this, a `openFile()` targeting a path already open in
  // an *unfocused* pane would leave `tabsState.activeTabPath` (and thus
  // `StatusBar`/`MenuBar`'s save target) pointing at a file no visibly-focused
  // pane is actually showing.
  $effect(() => {
    const path = $tabsState.activeTabPath;
    if (!path) return;
    if (!$editorPaneTree) {
      const paneId = genId("epane");
      $editorPaneTree = { type: "leaf", id: paneId, tabs: [path], activeTabPath: path };
      $focusedEditorPaneId = paneId;
      return;
    }

    const focusedLeaf = $focusedEditorPaneId ? findEditorLeaf($editorPaneTree, $focusedEditorPaneId) : null;
    if (focusedLeaf?.activeTabPath === path) return;

    const owningLeaf =
      (focusedLeaf?.tabs.includes(path) ? focusedLeaf : null) ??
      listEditorLeaves($editorPaneTree).find((leaf) => leaf.tabs.includes(path));
    if (owningLeaf) {
      if (owningLeaf.activeTabPath !== path) {
        $editorPaneTree = setActiveTabInEditorLeaf($editorPaneTree, owningLeaf.id, path);
      }
      $focusedEditorPaneId = owningLeaf.id;
      return;
    }

    const targetLeafId = focusedLeaf ? focusedLeaf.id : listEditorLeaves($editorPaneTree)[0].id;
    $editorPaneTree = addEditorTabToLeaf($editorPaneTree, targetLeafId, path);
    $focusedEditorPaneId = targetLeafId;
  });

  // The other direction: a path can be closed at the `tabsState` level with
  // no notion of which pane(s) were showing it — the unsaved-changes
  // dialog's "Don't Save"/"Save" actions call `closeTab` directly. Whenever
  // that happens, prune the now-stale path out of every leaf that had it,
  // dropping any leaf left with no tabs, and refocus off a leaf that
  // disappeared out from under the current focus.
  $effect(() => {
    if (!$editorPaneTree) return;
    const openPaths = new Set($tabsState.tabs.map((t) => t.path));
    const isStale = listEditorLeaves($editorPaneTree).some((leaf) => leaf.tabs.some((p) => !openPaths.has(p)));
    if (!isStale) return;

    const currentFocus = $focusedEditorPaneId;
    const focusedLeafFullyStale =
      currentFocus !== null && (findEditorLeaf($editorPaneTree, currentFocus)?.tabs.every((p) => !openPaths.has(p)) ?? false);
    const fallbackFocus = focusedLeafFullyStale ? nextActiveEditorPane($editorPaneTree, currentFocus) : currentFocus;

    $editorPaneTree = pruneMissingTabs($editorPaneTree, openPaths);
    $focusedEditorPaneId = $editorPaneTree ? (fallbackFocus ?? listEditorLeaves($editorPaneTree)[0]?.id ?? null) : null;
    syncActiveTabToFocusedPane();
  });

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
    $terminalPosition === "left" ? ["terminal", "resizer", "editor"] : ["editor", "resizer", "terminal"],
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

  function startDragTerminal(event: PointerEvent): void {
    event.preventDefault();
    function onUp(): void {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      saveTerminalLayout({ position: $terminalPosition, height: terminalHeight, width: terminalWidth });
    }
    let onMove: (e: PointerEvent) => void;
    if ($terminalPosition === "bottom") {
      const startY = event.clientY;
      const startHeight = terminalHeight;
      onMove = (e: PointerEvent): void => {
        const available = mainEl?.clientHeight ?? Infinity;
        terminalHeight = clampToContainer(startHeight - (e.clientY - startY), HEIGHT_MIN, available);
      };
    } else {
      const startX = event.clientX;
      const startWidth = terminalWidth;
      const sign = $terminalPosition === "left" ? 1 : -1;
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
      // Persists the clamp immediately, not just in memory: otherwise a
      // later position change (from the settings dialog) would read the
      // pre-clamp, potentially oversized dimension straight back out of
      // localStorage via setTerminalPosition, undoing the clamp this mount
      // just applied.
      saveTerminalLayout({ position: $terminalPosition, height: terminalHeight, width: terminalWidth });
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
      const dir = resolveExplorerDropTargetDir(logical.x, logical.y);
      if (dir) {
        void importPathsInto(dir, event.paths);
        return;
      }
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

<SettingsDialog />
<KeyboardShortcutsDialog />
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
    <div class="resizer vertical" role="separator" aria-orientation="vertical" onpointerdown={startDragExplorer}>
      <div class="resizer-line"></div>
    </div>
  {/if}

  <div class="main" class:row={$terminalPosition !== "bottom"} bind:this={mainEl}>
    {#each mainSlotOrder as slot (slot)}
      {#if slot === "editor"}
        <div class="editor-area">
          {#if $editorPaneTree}
            <EditorPaneSplit
              tree={$editorPaneTree}
              activePaneId={$focusedEditorPaneId ?? ""}
              onFocus={setFocusedEditorPane}
              onSplit={(paneId, direction) => splitEditorPaneAt(paneId, direction)}
              onSetActiveTab={(paneId, path) => setActiveTabInEditorPane(paneId, path)}
              onCloseTab={(paneId, path) => closeTabInEditorPane(paneId, path)}
              onResizeSplit={(splitId, index, delta, containerSizePx) =>
                resizeEditorPaneSplit(splitId, index, delta, containerSizePx)}
            />
          {/if}
        </div>
      {:else if slot === "resizer"}
        <div
          class="resizer"
          class:horizontal={$terminalPosition === "bottom"}
          class:vertical={$terminalPosition !== "bottom"}
          class:hidden={!$terminalVisible}
          role="separator"
          aria-orientation={$terminalPosition === "bottom" ? "horizontal" : "vertical"}
          onpointerdown={startDragTerminal}
        >
          <div class="resizer-line"></div>
        </div>
      {:else}
        <div
          class="terminal-area"
          class:hidden={!$terminalVisible}
          style={$terminalPosition === "bottom" ? `height: ${terminalHeight}px` : `width: ${terminalWidth}px`}
        >
          <div class="terminal-panes">
            {#if terminalPaneTree}
              <div class="terminal-pane-slot">
                <PaneSplit
                  tree={terminalPaneTree}
                  activePaneId={focusedPaneId ?? ""}
                  workspaceId={$workspace.id}
                  onFocus={setFocusedPane}
                  onSplit={(paneId, direction) => splitPaneAt(paneId, direction)}
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
  }
  .resizer {
    background: transparent;
    flex-shrink: 0;
    position: relative;
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
  .resizer-line {
    position: absolute;
    background: var(--atrium-border);
  }
  .resizer.vertical .resizer-line {
    left: 50%;
    top: 0;
    bottom: 0;
    width: 1px;
    transform: translateX(-50%);
  }
  .resizer.horizontal .resizer-line {
    top: 50%;
    left: 0;
    right: 0;
    height: 1px;
    transform: translateY(-50%);
  }
  .resizer:hover .resizer-line,
  .resizer:active .resizer-line {
    background: var(--atrium-accent);
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
  .terminal-panes {
    flex: 1;
    min-height: 0;
    position: relative;
  }
  .terminal-pane-slot {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
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
  .terminal-area {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
  }
  .terminal-area.hidden {
    display: none;
  }
</style>
