<script lang="ts">
  import { onMount, untrack } from "svelte";
  import FileTree from "./lib/explorer/FileTree.svelte";
  import EditorPaneSplit from "./lib/editor/EditorPaneSplit.svelte";
  import PaneSplit from "./lib/terminal/PaneSplit.svelte";
  import WelcomeScreen from "./lib/welcome/WelcomeScreen.svelte";
  import SearchOverlay from "./lib/search/SearchOverlay.svelte";
  import UnsavedChangesDialog from "./lib/shell/UnsavedChangesDialog.svelte";
  import SettingsDialog from "./lib/shell/SettingsDialog.svelte";
  import KeyboardShortcutsDialog from "./lib/shell/KeyboardShortcutsDialog.svelte";
  import ErrorToast from "./lib/shell/ErrorToast.svelte";
  import ExplorerDragPreview from "./lib/explorer/ExplorerDragPreview.svelte";
  import StatusBar from "./lib/shell/StatusBar.svelte";
  import TitleBar from "./lib/shell/TitleBar.svelte";
  import { workspace, openWorkspacePath } from "./lib/stores/workspace";
  import {
    tabsState,
    setActiveTab,
    requestCloseTab,
    reconcileExternalChange,
    markPathDeleted,
    renameOpenTabs,
    tabRenameSignal,
    resetTabs,
  } from "./lib/stores/tabs";
  import { closePrompt } from "./lib/stores/closePrompt";
  import { refreshDirectoryContaining } from "./lib/stores/fileTree";
  import { isPathUnderOrEqual } from "./lib/util/path";
  import { rekeyPath } from "./lib/editor/editorViewRegistry";
  import { get } from "svelte/store";
  import { onFsChanged, onDockOpenPath, onCloseRequested, onDragDropEvent } from "./lib/ipc/events";
  import { insertPathsAtScreenPoint } from "./lib/terminal/terminalDropTargets";
  import { resolveExplorerDropTargetDir } from "./lib/explorer/explorerDropTargets";
  import { importPathsInto } from "./lib/explorer/importExternalPaths";
  import { dragOverTargetDir, draggingPath } from "./lib/explorer/explorerDrag";
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
    setTerminalVisible,
    loadExplorerWidth,
    saveExplorerWidth,
    clampExplorerToContainer,
    RESIZER_THICKNESS,
  } from "./lib/stores/layout";
  import { restoreEditorSession, saveEditorSession, flushEditorSession } from "./lib/stores/editorSession";
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
    renamePathInTree as renamePathInEditorTree,
    type EditorPaneNode,
    type EditorLeafPane,
  } from "./lib/editor/editorPaneTree";
  import { focusedEditorPaneId, editorPaneTree } from "./lib/stores/editorPanes";

  const initialLayout = loadTerminalLayout();

  let explorerWidth = $state(loadExplorerWidth());
  let terminalHeight = $state(initialLayout.height);
  let terminalWidth = $state(initialLayout.width);
  let appEl: HTMLElement | undefined = $state();
  let mainEl: HTMLDivElement | undefined = $state();

  // Stable, in-memory ratio for each of the two outer-layout dimensions that
  // move independently of the nested pane-tree ratios (paneTree.ts). Each is
  // established once (first container availability) and re-baselined on
  // every drag-end; between those events a `resize` recomputes the pixel
  // value fresh from `ratio * currentContainerSize`, never from the previous
  // frame's already-computed pixel value, so repeated resizes never drift.
  let explorerRatio = $state<number | null>(null);
  let terminalWidthRatio = $state<number | null>(null);
  let terminalHeightRatio = $state<number | null>(null);

  /** `.main`'s content width, derived analytically instead of read back from `mainEl.clientWidth` — Svelte 5 batches DOM updates to a microtask, so a same-pass DOM read of `mainEl` after writing `explorerWidth` would still reflect the pre-update sidebar width. */
  function mainContentWidth(appWidthPx: number, explorerWidthPx: number): number {
    return appWidthPx - (get(explorerVisible) ? explorerWidthPx + RESIZER_THICKNESS : 0);
  }

  /** Establishes `explorerRatio` on first call, then re-derives `explorerWidth` from it on every later call. Returns the pixel value it computed, for callers deriving `.main`'s width from it in the same pass. */
  function syncExplorerToContainer(containerWidth: number): number {
    if (!Number.isFinite(containerWidth) || containerWidth <= 0) return explorerWidth;
    if (explorerRatio === null) {
      explorerRatio = explorerWidth / containerWidth;
      return explorerWidth;
    }
    explorerWidth = clampExplorerToContainer(Math.round(explorerRatio * containerWidth), containerWidth);
    return explorerWidth;
  }

  /** Same as `syncExplorerToContainer`, for whichever of `terminalWidthRatio`/`terminalHeightRatio` applies to the current dock position. */
  function syncTerminalToContainer(containerWidth: number, containerHeight: number): void {
    if ($terminalPosition === "bottom") {
      if (!Number.isFinite(containerHeight) || containerHeight <= 0) return;
      if (terminalHeightRatio === null) {
        // Establishing against a persisted value that's never been checked
        // against this container's size before (cold start) — clamp it here
        // too, not just on later resize/drag-driven calls, or an oversized
        // saved height would render unclamped and squeeze the editor to 0.
        terminalHeight = clampToContainer(terminalHeight, HEIGHT_MIN, containerHeight);
        terminalHeightRatio = terminalHeight / containerHeight;
        return;
      }
      terminalHeight = clampToContainer(Math.round(terminalHeightRatio * containerHeight), HEIGHT_MIN, containerHeight);
    } else {
      if (!Number.isFinite(containerWidth) || containerWidth <= 0) return;
      if (terminalWidthRatio === null) {
        terminalWidth = clampToContainer(terminalWidth, WIDTH_MIN, containerWidth);
        terminalWidthRatio = terminalWidth / containerWidth;
        return;
      }
      terminalWidth = clampToContainer(Math.round(terminalWidthRatio * containerWidth), WIDTH_MIN, containerWidth);
    }
  }

  function handleWindowResize(): void {
    if (!appEl || !mainEl) return;
    const appWidth = appEl.clientWidth;
    const newExplorerWidth = syncExplorerToContainer(appWidth);
    syncTerminalToContainer(mainContentWidth(appWidth, newExplorerWidth), mainEl.clientHeight);
  }

  // Re-syncs both ratio-derived pixel values every time `appEl`/`mainEl`
  // (re)bind with a nonzero size — cold start with a restored workspace, and
  // re-opening a workspace after the welcome screen (§3, item 1 of the
  // resize plan). `untrack` keeps this effect's dependencies limited to
  // `appEl`/`mainEl` themselves, not the ratios/pixel values it reads and
  // writes internally, so a drag-end re-baselining a ratio doesn't loop back
  // into this effect.
  $effect(() => {
    const app = appEl;
    const main = mainEl;
    if (!app || !main) return;
    untrack(() => {
      const appWidth = app.clientWidth;
      if (appWidth <= 0) return;
      const newExplorerWidth = syncExplorerToContainer(appWidth);
      syncTerminalToContainer(mainContentWidth(appWidth, newExplorerWidth), main.clientHeight);
    });
  });

  // A single pane tree for the whole terminal dock — splitting no longer
  // creates an independent tab, it adds a sibling panel to this same tree,
  // each leaf owning its own tabs (see paneTree.ts). `focusedPaneId` tracks
  // whichever leaf last had focus, which is what keyboard shortcuts and menu
  // commands with no pane of their own act on.
  let terminalPaneTree = $state<PaneNode | null>(null);
  let focusedPaneId = $state<string | null>(null);

  // Tracks the workspace root across renders so the reset effect below can
  // tell a genuine project switch apart from every other reason `$workspace`
  // might update (e.g. the initial mount, or the id/root pair being set to
  // the same root again).
  let previousWorkspaceRoot: string | null = get(workspace).root;

  // Which root `restoreEditorSession` has actually finished restoring into
  // `editorPaneTree`/`tabsState`, so the persistence-write effect below can
  // tell "the new project's own restored session changed" apart from "the
  // reset effect just cleared the previous project's state on its way out" —
  // without this guard, a naive write-on-every-change effect would overwrite
  // the new root's not-yet-loaded persisted session with the transient empty
  // state `resetTabs()` produces mid-switch.
  let restoredForRoot: string | null = null;

  // Bumped every time the project-switch effect below actually fires,
  // capturing its value locally so a stale `restoreEditorSession(root)` call
  // can tell it's been superseded by a later switch before it applies its
  // result. Without this, switching A -> B before A's own `fsReadFile` calls
  // resolve lets A's restore land *after* B's has already started (or
  // finished): it would apply A's tabs/pane tree on top of B's now-current
  // state, and — since `restoredForRoot` would already equal B by then — the
  // persistence-write effect would immediately persist A's tree under B's
  // storage key, corrupting B's own saved session. Comparing against this
  // token is what lets a superseded restore recognize "I'm no longer the
  // switch in progress" and discard its own result entirely, rather than
  // just discarding the stores-write half and leaving `restoredForRoot`
  // wrongly latched onto a root whose restore never actually applied.
  let switchToken = 0;

  // Which of the two split-pane surfaces — the terminal dock or the
  // editor's own split panes — last had focus, so a global split-direction
  // shortcut (with no specific pane of its own to act on) knows which one to
  // route to. Set alongside every existing terminal-focus assignment below
  // (to "terminal") and every existing editor-focus assignment further down
  // (to "editor"); see `splitFocusedSurface`.
  let lastFocusedSurface = $state<"terminal" | "editor" | null>(null);

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
    lastFocusedSurface = "terminal";
    const root = $workspace.root;
    if (!root || !terminalPaneTree) return;
    terminalPaneTree = addTabToLeaf(terminalPaneTree, paneId, spawnSession(root));
    focusedPaneId = paneId;
  }

  // Used by `Cmd/Ctrl+T` and the native menu, which have no specific panel of
  // their own to act on: opens the first panel if the dock is empty,
  // otherwise adds a tab to whichever panel last had focus.
  function newTerminalTab(): void {
    lastFocusedSurface = "terminal";
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
    lastFocusedSurface = "terminal";
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

  // Used by the four ⌥⌘-arrow split-direction shortcuts, which route to
  // whichever surface — terminal or editor — last had focus rather than
  // acting on a specific pane of their own; see `splitFocusedSurface`.
  function splitFocusedEditorPane(direction: SplitDirection): void {
    if (!$editorPaneTree) return;
    const target =
      $focusedEditorPaneId && findEditorLeaf($editorPaneTree, $focusedEditorPaneId)
        ? $focusedEditorPaneId
        : listEditorLeaves($editorPaneTree)[0]?.id;
    if (target) splitEditorPaneAt(target, direction);
  }

  // Shared by the ⌥⌘-arrow split shortcuts (§ issue #156) and Cmd+W (§ issue
  // #279), both of which act on "whichever surface last had focus" rather
  // than a specific pane of their own. Prefers whichever of the terminal
  // dock or the editor's split panes `lastFocusedSurface` names, as long as
  // that surface is currently eligible — the terminal is only eligible while
  // its dock is visible *and* has a pane tree at all (hiding the dock never
  // tears the tree down, so a hidden dock must still be treated as "can't
  // act on it," not just "empty"); the editor is eligible whenever it has a
  // pane tree. Falls back to whichever eligible surface exists, preferring
  // the terminal (matching today's ⌘\ behavior when nothing has explicitly
  // claimed focus yet), and resolves to `null` if neither is eligible (e.g.
  // before any file has been opened and the terminal dock is hidden).
  function resolveFocusedSurface(): "terminal" | "editor" | null {
    const terminalEligible = terminalPaneTree !== null && $terminalVisible;
    const editorEligible = $editorPaneTree !== null;

    if (lastFocusedSurface === "terminal" && terminalEligible) return "terminal";
    if (lastFocusedSurface === "editor" && editorEligible) return "editor";
    if (terminalEligible) return "terminal";
    if (editorEligible) return "editor";
    return null;
  }

  function splitFocusedSurface(direction: SplitDirection): void {
    const target = resolveFocusedSurface();
    if (target === "terminal") {
      splitFocusedPane(direction);
    } else if (target === "editor") {
      splitFocusedEditorPane(direction);
    }
  }

  function removeTabFromPane(paneId: string, sessionId: string): void {
    if (!terminalPaneTree) return;
    const leaf = findLeaf(terminalPaneTree, paneId);
    const isPanelsLastTab = leaf?.tabs.length === 1;
    const nextFocus = isPanelsLastTab && focusedPaneId === paneId ? nextActivePane(terminalPaneTree, paneId) : focusedPaneId;
    terminalPaneTree = closeTabInLeaf(terminalPaneTree, paneId, sessionId);
    focusedPaneId = terminalPaneTree ? (nextFocus ?? focusedPaneId) : null;
  }

  // The tab's × button — a deliberate close. If this empties the whole dock,
  // hide it rather than let the auto-spawn effect below silently refill it;
  // the user asked to close the last tab, not to get a fresh one in its
  // place. A pane split with tabs remaining elsewhere is unaffected, since
  // removeTabFromPane only leaves terminalPaneTree null when the closed leaf
  // was the tree's sole leaf.
  function closeTabInPane(paneId: string, sessionId: string): void {
    suppressAutoSpawn = false;
    removeTabFromPane(paneId, sessionId);
    if (!terminalPaneTree) {
      setTerminalVisible(false);
    }
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
    lastFocusedSurface = "terminal";
    if (!terminalPaneTree) return;
    terminalPaneTree = setActiveTabInLeaf(terminalPaneTree, paneId, sessionId);
    focusedPaneId = paneId;
  }

  function setSessionTitle(paneId: string, sessionId: string, title: string): void {
    if (!terminalPaneTree) return;
    terminalPaneTree = updateSessionInLeaf(terminalPaneTree, paneId, sessionId, { title });
  }

  function setFocusedPane(paneId: string): void {
    lastFocusedSurface = "terminal";
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
    lastFocusedSurface = "editor";
    $focusedEditorPaneId = paneId;
    syncActiveTabToFocusedPane();
  }

  function setActiveTabInEditorPane(paneId: string, path: string): void {
    lastFocusedSurface = "editor";
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
    lastFocusedSurface = "editor";
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

  // Cmd+W (issue #279): closes the active tab on whichever surface last had
  // focus, reusing the exact close path each tab strip's own × button uses
  // (so dirty-tab protection and the "still open in another split pane"
  // check both apply unchanged). A deliberate no-op when neither surface has
  // an open tab — Cmd+W must never fall through to closing the window.
  function closeFocusedTab(): void {
    const target = resolveFocusedSurface();
    if (target === "editor" && $editorPaneTree) {
      const paneId =
        $focusedEditorPaneId && findEditorLeaf($editorPaneTree, $focusedEditorPaneId)
          ? $focusedEditorPaneId
          : listEditorLeaves($editorPaneTree)[0]?.id;
      const leaf = paneId ? findEditorLeaf($editorPaneTree, paneId) : null;
      if (paneId && leaf?.activeTabPath) {
        closeTabInEditorPane(paneId, leaf.activeTabPath);
      }
    } else if (target === "terminal" && terminalPaneTree) {
      const paneId =
        focusedPaneId && findLeaf(terminalPaneTree, focusedPaneId) ? focusedPaneId : listLeaves(terminalPaneTree)[0]?.id;
      const leaf = paneId ? findLeaf(terminalPaneTree, paneId) : null;
      if (paneId && leaf?.activeTabId) {
        closeTabInPane(paneId, leaf.activeTabId);
      }
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
  //
  // A rename bails out here entirely while `tabRenameSignal` is still set:
  // `renameOpenTabs` re-keys `tabsState.activeTabPath` to the new path in the
  // same synchronous update that sets the signal, and until the pane-tree
  // reconciliation effect below has had a chance to re-key the leaf that
  // actually owns the old path, this effect would see a `path` that exists
  // nowhere in `editorPaneTree` yet and (mis-reading a rename as "a genuinely
  // new path to open") append it as a brand-new tab alongside the
  // about-to-be-renamed one, rather than letting the rename replace it in
  // place.
  $effect(() => {
    if ($tabRenameSignal) return;
    const path = $tabsState.activeTabPath;
    if (!path) return;
    if (!$editorPaneTree) {
      const paneId = genId("epane");
      $editorPaneTree = { type: "leaf", id: paneId, tabs: [path], activeTabPath: path };
      $focusedEditorPaneId = paneId;
      lastFocusedSurface = "editor";
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

  // Reconciles the pane tree against `tabsState` for both ways a path can
  // stop matching what a leaf's own `tabs` array holds. A rename (signaled
  // via `tabRenameSignal`, set by `renameOpenTabs` in the same synchronous
  // call that re-keys `tabsState.tabs`) is handled first and unconditionally
  // returns: if the generic "path no longer open" pruning below ran against
  // a stale `$tabsState` read on the same reactive flush that a rename just
  // fired on, it would see the tab's *old* path missing from `tabsState` (it
  // now only exists at the new path) and delete it from the pane tree
  // outright — indistinguishable, from that check's own point of view, from
  // the tab having been closed. Keeping both reactions in one effect body
  // makes that ordering atomic instead of leaving it to chance across two
  // separately-scheduled effects.
  //
  // Rekeying `editorViewRegistry` before reassigning `$editorPaneTree` is
  // itself deliberate: reassignment changes the key `EditorPanel.svelte`'s
  // keyed `{#each}` block uses, which destroys the old `EditorPane` and
  // mounts a fresh one that seeds its doc from `liveDocFor(newPath)` —
  // rekeying the registry after that remount would be too late, and a dirty
  // tab's unsaved edits would be silently lost in favor of stale, last-saved
  // content.
  $effect(() => {
    const evt = $tabRenameSignal;
    if (evt) {
      if ($editorPaneTree) {
        for (const leaf of listEditorLeaves($editorPaneTree)) {
          for (const path of leaf.tabs) {
            if (isPathUnderOrEqual(path, evt.from)) {
              rekeyPath(path, evt.to + path.slice(evt.from.length));
            }
          }
        }
        $editorPaneTree = renamePathInEditorTree($editorPaneTree, evt.from, evt.to);
        syncActiveTabToFocusedPane();
      }
      tabRenameSignal.set(null);
      return;
    }

    // The other direction: a path can be closed at the `tabsState` level
    // with no notion of which pane(s) were showing it — the
    // unsaved-changes dialog's "Don't Save"/"Save" actions call `closeTab`
    // directly. Whenever that happens, prune the now-stale path out of
    // every leaf that had it, dropping any leaf left with no tabs, and
    // refocus off a leaf that disappeared out from under the current focus.
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
      explorerWidth = clampExplorerToContainer(startWidth + (e.clientX - startX), appEl?.clientWidth ?? Infinity);
    }
    function onUp(): void {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (appEl && appEl.clientWidth > 0) {
        explorerRatio = explorerWidth / appEl.clientWidth;
      }
      saveExplorerWidth(explorerWidth);
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

  // A genuine project switch tears down every tab, editor pane, and
  // terminal session left over from the previous project — none of it
  // belongs to the new root. Clearing `tabsState.tabs` is enough to reset
  // the editor pane tree too, via the prune effect above
  // (`pruneMissingTabs` collapses it to `null` once `openPaths` is empty,
  // the same path already exercised by closing tabs one at a time).
  // `terminalPaneTree`/`focusedPaneId` are local `$state`, not stores, so
  // they can't be reset from `workspace.ts` and are nulled directly here
  // instead; unmounting every `TerminalPane` runs each one's existing
  // `onDestroy` (`ptyKill`), the same per-session cleanup a manual tab
  // close already relies on.
  $effect(() => {
    const root = $workspace.root;
    if (root === previousWorkspaceRoot) return;
    previousWorkspaceRoot = root;
    restoredForRoot = null;
    switchToken += 1;
    const token = switchToken;
    resetTabs();
    terminalPaneTree = null;
    focusedPaneId = null;
    if (root) {
      void restoreEditorSession(root).then((restored) => {
        // A later switch started (and possibly already finished) while this
        // one's `fsReadFile` calls were still in flight — see the
        // `switchToken` comment above. Applying a stale restore here would
        // overwrite whatever the current root's own effect already put in
        // place, and latching `restoredForRoot` to this stale `root` would
        // then let the persistence-write effect below persist this stale
        // result under the *current* root's storage key.
        if (token !== switchToken) return;
        if (restored) {
          tabsState.set({ tabs: restored.tabs, activeTabPath: restored.activeTabPath });
          editorPaneTree.set(restored.paneTree);
          focusedEditorPaneId.set(restored.focusedPaneId);
        }
        restoredForRoot = root;
      });
    } else {
      restoredForRoot = null;
    }
  });

  // Persists the editor session (pane tree + focused pane) for the current
  // root whenever it changes — but only once `restoreEditorSession` above
  // has actually finished restoring this same root, per the guard comment
  // on `restoredForRoot`.
  $effect(() => {
    const root = $workspace.root;
    const tree = $editorPaneTree;
    const focused = $focusedEditorPaneId;
    if (root && restoredForRoot === root) {
      saveEditorSession(root, { paneTree: tree, focusedPaneId: focused });
    }
  });

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
  // open, or because a shell exited on its own — this spawns one, matching
  // the VS Code/JetBrains convention that the terminal panel never shows a
  // blank panel. Closing the dock's last tab via its × button instead hides
  // the dock (see closeTabInPane), so this effect never observes
  // $terminalVisible true with an empty tree for that case. Guarded by
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
      if ($terminalPosition === "bottom") {
        if (mainEl && mainEl.clientHeight > 0) terminalHeightRatio = terminalHeight / mainEl.clientHeight;
      } else {
        if (mainEl && mainEl.clientWidth > 0) terminalWidthRatio = terminalWidth / mainEl.clientWidth;
      }
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

  // Avoids notifying every row's `$derived` read of dragOverTargetDir on
  // every "over" tick (pointer-move rate) when the resolved target hasn't
  // actually changed.
  function setDragOverTargetDir(next: string | null): void {
    if (get(dragOverTargetDir) !== next) dragOverTargetDir.set(next);
  }

  onMount(() => {
    // The first-availability `$effect` above clamps terminalHeight/terminalWidth
    // against the container every time `mainEl` becomes available — on the very
    // first call (establishing the ratio, e.g. cold start) it clamps the
    // just-loaded persisted value directly; on every later call it re-derives
    // from the stable ratio and clamps that. So the one-shot mount-time clamp
    // this used to do here is no longer needed — removing it is safe even
    // though `setTerminalPosition` reads height/width fresh from storage
    // rather than from this in-memory state: nothing renders from that stale
    // stored number directly, and the next drag-end overwrites it with an
    // explicit, correct user choice.
    window.addEventListener("resize", handleWindowResize);
    void initMenuBar(newTerminalTab, () => splitFocusedPane("right"), splitFocusedSurface, closeFocusedTab);
    void onFsChanged((event) => {
      if (event.kind === "remove") {
        markPathDeleted(event.path);
      } else if (event.kind === "rename" && event.fromPath) {
        renameOpenTabs(event.fromPath, event.path);
        // A cross-directory move needs its *source* directory's listing
        // refreshed too, not just the destination refreshed below — the
        // old paired-rename shape emitted one wire event per path, so both
        // directories got refreshed for free; this one event now only
        // covers the destination on its own.
        void refreshDirectoryContaining(event.fromPath);
      } else {
        void reconcileExternalChange(event.path);
      }
      void refreshDirectoryContaining(event.path);
    });
    void onDockOpenPath((path) => void openWorkspacePath(path));
    void onDragDropEvent((event) => {
      if (event.type === "leave") {
        setDragOverTargetDir(null);
        return;
      }
      if (event.type === "enter" || event.type === "over") {
        const logical = event.position.toLogical(window.devicePixelRatio);
        setDragOverTargetDir(resolveExplorerDropTargetDir(logical.x, logical.y));
        return;
      }
      setDragOverTargetDir(null);
      const logical = event.position.toLogical(window.devicePixelRatio);
      const dir = resolveExplorerDropTargetDir(logical.x, logical.y);
      if (dir) {
        void importPathsInto(dir, event.paths);
        return;
      }
      insertPathsAtScreenPoint(event.paths, logical.x, logical.y);
    });
    // Only self-heals a stale OS-drag highlight, gated on draggingPath so it
    // never clears an in-flight internal pointer-drag's target: that gesture
    // owns dragOverTargetDir until its own pointerup/pointercancel, and
    // committing it reads whatever the store holds at that moment (see
    // explorerDrag.ts's `end()`).
    window.addEventListener("blur", () => {
      if (get(draggingPath) === null) setDragOverTargetDir(null);
    });
    void onCloseRequested(() => {
      const dirty = $tabsState.tabs.filter((t) => t.isDirty);
      if (dirty.length === 0) {
        if ($workspace.root) flushEditorSession($workspace.root);
        void appConfirmClose();
        return;
      }
      closePrompt.set({ kind: "window", paths: dirty.map((t) => t.path) });
    });
    void workspaceTakePendingOpen().then((path) => {
      if (path) void openWorkspacePath(path);
    });
    return () => {
      window.removeEventListener("resize", handleWindowResize);
    };
  });
</script>

<SettingsDialog />
<KeyboardShortcutsDialog />
<ErrorToast />
<ExplorerDragPreview />
<div class="window">
  <TitleBar />
  {#if !$workspace.root}
    <WelcomeScreen />
  {:else}
    <SearchOverlay />
    <UnsavedChangesDialog />
    <div class="app-shell">
    <main class="app" bind:this={appEl}>
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
</div>

<style>
  .window {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
  }
  .app-shell {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
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
