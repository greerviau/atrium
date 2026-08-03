<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { Compartment, EditorState, Transaction, type Extension, type TransactionSpec } from "@codemirror/state";
  import { EditorView, keymap, lineNumbers } from "@codemirror/view";
  import { selectAll as cmSelectAll } from "@codemirror/commands";
  import { indentUnit, syntaxHighlighting } from "@codemirror/language";
  import { readText } from "@tauri-apps/plugin-clipboard-manager";
  import {
    tabsState,
    saveRequest,
    saveTab,
    markDirty,
    clearPendingSelection,
    toggleMarkdownViewMode,
    notifySaveComplete,
    notifySaveFailed,
    requestSave,
    requestSaveReportingErrors,
  } from "../stores/tabs";
  import { focusedEditorPaneId, editorPaneTree } from "../stores/editorPanes";
  import { saveOwnerLeafId } from "./editorPaneTree";
  import { registerView, unregisterView, liveDocFor, createSyncDispatch, syncAnnotation } from "./editorViewRegistry";
  import { theme as themeStore } from "../stores/theme";
  import { buildCmTheme, buildHighlightStyle } from "../theme/cmTheme";
  import { minimapEnabled } from "../stores/minimapEnabled";
  import { wordWrapEnabled } from "../stores/wordWrap";
  import { tabSize } from "../stores/tabSize";
  import { lineNumbersEnabled } from "../stores/lineNumbersEnabled";
  import { zoom } from "../stores/textSize";
  import { autoSaveEnabled, AUTO_SAVE_DELAY_MS, isAutoSaveBlocked, blockAutoSave, unblockAutoSave } from "../stores/autoSave";
  import { showErrorToast, describeError } from "../stores/errorToast";
  import { basename } from "../util/path";
  import { baseExtensions } from "./baseExtensions";
  import { isScrollable, minimapExtension } from "./minimap";
  import { markdownExtensions, markdownSourceExtensions } from "./markdown/livePreviewPlugin";
  import {
    findTableContext,
    insertRow,
    deleteRow,
    moveRow,
    duplicateRow,
    insertColumn,
    deleteColumn,
    moveColumn,
    duplicateColumn,
    type TableEditContext,
  } from "./markdown/tableEdit";
  import { tableContextFromHandleElement } from "./markdown/tableHandles";
  import { codeExtensions, type PaneMode } from "./codeExtensions";
  import { setCursorPosition, clearCursorPosition, type CursorPosition } from "../stores/editorStatus";
  import { attachScrollbarAutoHide } from "../ui/scrollbarAutoHide";
  import { revealInFinder } from "../ipc/reveal";
  import ContextMenu from "../ui/ContextMenu.svelte";
  import { SHORTCUT_LABELS } from "../shell/shortcutLabels";

  // `paneId` identifies which split pane this instance belongs to — combined
  // with `filePath` (via the caller's `${paneId}:${path}` keying, see
  // EditorPanel.svelte) it makes this pane-and-tab occurrence unique even
  // when the same path is open in more than one split.
  let { filePath, paneId }: { filePath: string; paneId: string } = $props();

  // True only for the single EditorView, among possibly several showing
  // `filePath`, that should drive app-global "current cursor" concerns: the
  // currently-focused pane, showing `filePath` as its own active tab.
  // `tabsState.activeTabPath` is kept as a mirror of "the focused pane's own
  // active tab" (see App.svelte), so the two checks together are exactly
  // "this pane is focused, and this is the file it's showing" — without the
  // `paneId` half, two panes both showing the same path as their active tab
  // (e.g. right after a single-file split) would both think they're active.
  const active = $derived($focusedEditorPaneId === paneId && $tabsState.activeTabPath === filePath);

  // True for exactly one EditorPane instance among possibly several showing
  // `filePath` — the one that should actually write to disk when a save is
  // requested for this path. Without this, a `saveTab` request would fire
  // once per pane showing the path — redundant disk writes of the same,
  // now-synced buffer (see `editorViewRegistry.ts`) rather than a
  // divergence risk. See `saveOwnerLeafId`'s own doc comment for which pane
  // wins and why.
  const isSaveOwner = $derived($editorPaneTree !== null && saveOwnerLeafId($editorPaneTree, filePath, $focusedEditorPaneId) === paneId);

  let container: HTMLDivElement;
  // `view` is an imperative handle to the CodeMirror instance: assigned once
  // in onMount and never reassigned again (only destroyed on unmount). The
  // table-edit context-menu buttons below read `view.state` directly, but
  // they only render once `menu` is set, and `menu` is only ever set after
  // `view` already exists (see `onContextMenu`) — so there's no reactive
  // update being missed here for svelte-check to warn about.
  // svelte-ignore non_reactive_update
  let view: EditorView;
  let detachScrollbarAutoHide: (() => void) | undefined;
  const themeCompartment = new Compartment();
  const viewModeCompartment = new Compartment();
  const minimapCompartment = new Compartment();
  const wordWrapCompartment = new Compartment();
  const tabSizeCompartment = new Compartment();
  let lastAppliedViewMode: "rendered" | "source" | undefined;
  let lastAppliedActive: boolean | undefined;
  let lastAppliedMinimapEnabled: boolean | undefined;
  let lastAppliedWordWrapEnabled: boolean | undefined;
  let lastAppliedLineNumbersEnabled: boolean | undefined;
  let minimapIdleHandle: number | undefined;
  let minimapVisibilityTimer: ReturnType<typeof setTimeout> | undefined;
  let lastAppliedMinimapVisible: boolean | undefined;
  let minimapResizeObserver: ResizeObserver | undefined;
  // Imperative auto-save timer handle, same treatment as `minimapIdleHandle`
  // above — not `$state`, since nothing in the template reads it.
  let autoSaveTimer: ReturnType<typeof setTimeout> | undefined;

  interface ContextMenuState {
    x: number;
    y: number;
    hasSelection: boolean;
    pasteDisabled: boolean;
    tableContext: TableEditContext | null;
  }

  let menu = $state<ContextMenuState | null>(null);

  function viewModeExtensions(
    mode: PaneMode,
    viewMode: "rendered" | "source" | undefined,
    showLineNumbers: boolean,
  ): Extension[] {
    if (mode !== "markdown") {
      return [...(showLineNumbers ? [lineNumbers()] : []), ...codeExtensions(filePath)];
    }
    return viewMode === "source" ? markdownSourceExtensions(filePath, showLineNumbers) : markdownExtensions(filePath);
  }

  function themeExtensions() {
    return [buildCmTheme($themeStore), syntaxHighlighting(buildHighlightStyle($themeStore), { fallback: true })];
  }

  // Markdown panes keep their existing unconditional `EditorView.lineWrapping`
  // (see `EditorPane.lineWrapping.test.ts`'s "both rendered and source view"
  // coverage) — this setting only ever applies to a code pane.
  function wordWrapExtension(enabled: boolean): Extension {
    return enabled ? EditorView.lineWrapping : [];
  }

  function wordWrapAllowedFor(mode: PaneMode): boolean {
    return mode === "code";
  }

  // `showMinimap`'s own text/highlight state runs a synchronous full-document
  // `parser.parse()` the moment the facet first becomes active — including on
  // initial view construction, where there's no previous tree to reuse
  // incrementally (issue #155 review: this blocks the main thread for over a
  // second on a ~1MB file). `requestIdleCallback` defers that first build
  // until after the pane's own initial mount and paint, so opening a large
  // file shows the file itself immediately; only the minimap's appearance is
  // delayed. jsdom has no `requestIdleCallback`, hence the `setTimeout`
  // fallback (same fallback the minimap package itself uses for its
  // highlight pass).
  function cancelMinimapIdle(): void {
    if (minimapIdleHandle === undefined) {
      return;
    }
    if (typeof cancelIdleCallback !== "undefined") {
      cancelIdleCallback(minimapIdleHandle);
    } else {
      clearTimeout(minimapIdleHandle);
    }
    minimapIdleHandle = undefined;
  }

  function applyMinimap(enabled: boolean): void {
    cancelMinimapIdle();
    lastAppliedMinimapEnabled = enabled;
    const visible = enabled && isScrollable(view.scrollDOM);
    if (visible === lastAppliedMinimapVisible) {
      return;
    }
    lastAppliedMinimapVisible = visible;
    view.dispatch({ effects: minimapCompartment.reconfigure(minimapExtension(visible)) });
  }

  function scheduleMinimapVisibilityCheck(): void {
    if (minimapVisibilityTimer !== undefined) {
      clearTimeout(minimapVisibilityTimer);
    }
    minimapVisibilityTimer = setTimeout(() => {
      minimapVisibilityTimer = undefined;
      if (view) {
        applyMinimap(effectiveMinimapEnabled);
      }
    }, 0);
  }

  // `@replit/codemirror-minimap` computes its geometry from one uniform line
  // height applied per *document* line, with no notion that a single
  // document line can span more than one visual row. That assumption holds
  // for a code pane (which never wraps) but not for a markdown pane, where
  // `EditorView.lineWrapping` is always active (see below) and, in rendered
  // view, heading/image/table/Mermaid decorations also vary line heights —
  // so the minimap's scroll-position overlay and content no longer line up
  // with the pane's real rendered layout. An actively wrong minimap is worse
  // than no minimap, so markdown panes never show one, in either view mode.
  function minimapAllowedFor(mode: PaneMode): boolean {
    return mode === "code";
  }

  const tab = $derived($tabsState.tabs.find((t) => t.path === filePath));
  const effectiveMinimapEnabled = $derived($minimapEnabled && minimapAllowedFor(tab?.mode ?? "code"));
  const effectiveWordWrapEnabled = $derived($wordWrapEnabled && wordWrapAllowedFor(tab?.mode ?? "code"));

  function currentDoc(): string {
    return view.state.doc.toString();
  }

  function computeCursorPosition(state: EditorState): CursorPosition {
    const { main } = state.selection;
    const headLine = state.doc.lineAt(main.head);
    return {
      line: headLine.number,
      col: main.head - headLine.from + 1,
      selection: main.empty
        ? null
        : {
            chars: main.to - main.from,
            lines: state.doc.lineAt(main.to).number - state.doc.lineAt(main.from).number + 1,
          },
    };
  }

  // Passes `currentDoc` itself (not just its value) so `saveTab` can compare
  // the live buffer against what was written from *inside* its own
  // `tabsState.update` — at the same synchronous moment it decides
  // `isDirty`, not after a further `await` back here. A check made only
  // after `saveTab`'s own promise resolves would be a tick too late: the
  // external-change reconciliation effect's own re-run is already scheduled
  // off `saveTab`'s `tabsState.update`, one microtask hop ahead of this
  // function's continuation, and would silently replace the buffer with the
  // now-stale `savedDoc` — erasing whatever was typed during the write, with
  // no way to undo it (the replacement doesn't enter undo history) — before
  // this function ever got a chance to react.
  async function save(): Promise<void> {
    await saveTab(filePath, currentDoc(), currentDoc);
  }

  function closeMenu(): void {
    menu = null;
  }

  // Checked async, after the menu is already open with a conservative
  // (disabled) default, since reading the OS clipboard is never instant.
  async function refreshPasteAvailability(): Promise<void> {
    let text = "";
    try {
      text = await readText();
    } catch {
      text = "";
    }
    if (menu) {
      menu = { ...menu, pasteDisabled: text.length === 0 };
    }
  }

  // `posAtCoords` resolves a screen coordinate to a document position, or
  // `null` when it can't (per its own public contract) — wrapped here so a
  // right-click never fails to open the menu at all over that; it just
  // shows no table section, the same outcome as a `null` result.
  function safePosAtCoords(v: EditorView, coords: { x: number; y: number }): number | null {
    try {
      return v.posAtCoords(coords);
    } catch {
      return null;
    }
  }

  // A right-click on a row/column handle is resolved from the handle's own
  // stamped identity first — a handle sits outside the table's text flow
  // (in the margin, or above the table entirely), so posAtCoords at its
  // actual screen position doesn't reliably map back to the row/column it
  // represents the way it does for an ordinary in-cell click.
  function onContextMenu(event: MouseEvent): void {
    if (!view) return;
    event.preventDefault();
    const target = event.target as HTMLElement | null;
    const handleContext = target ? tableContextFromHandleElement(view.state, target) : null;
    const pos = handleContext ? null : safePosAtCoords(view, { x: event.clientX, y: event.clientY });
    menu = {
      x: event.clientX,
      y: event.clientY,
      hasSelection: !view.state.selection.main.empty,
      pasteDisabled: true,
      tableContext: handleContext ?? (pos !== null ? findTableContext(view.state, pos) : null),
    };
    void refreshPasteAvailability();
  }

  function doTableEdit(spec: TransactionSpec | null): void {
    closeMenu();
    view.focus();
    if (spec) {
      view.dispatch(spec);
    }
  }

  function doCut(): void {
    closeMenu();
    view.focus();
    document.execCommand("cut");
  }

  function doCopy(): void {
    closeMenu();
    view.focus();
    document.execCommand("copy");
  }

  async function doPaste(): Promise<void> {
    closeMenu();
    let text = "";
    try {
      text = await readText();
    } catch {
      return;
    }
    if (!text) return;
    view.focus();
    view.dispatch(view.state.replaceSelection(text));
  }

  function doSelectAll(): void {
    closeMenu();
    view.focus();
    cmSelectAll(view);
  }

  function doToggleViewMode(): void {
    closeMenu();
    toggleMarkdownViewMode(filePath);
  }

  function doSave(): void {
    closeMenu();
    requestSaveReportingErrors(filePath);
  }

  async function doReveal(): Promise<void> {
    closeMenu();
    await revealInFinder(filePath);
  }

  // Fires once per scheduled auto-save. Reads live tab state at the moment
  // the timer actually goes off (not a snapshot taken when it was armed), so
  // a conflict raised anywhere during the debounce window is still caught —
  // only the fire-time value can see that. Enforces the full failure policy
  // (MF3): skip entirely — no attempt at all — while the tab is deleted,
  // conflicted, or already blocked from a prior failure; on failure, block
  // further attempts and toast exactly once; on success, clear any prior
  // block. `isDeleted` here is bounded by the file watcher's own 150ms
  // debounce, not absolute — a delete landing in the last ~150ms before this
  // fires isn't yet visible to the frontend, so the write would still land.
  async function attemptAutoSave(): Promise<void> {
    const current = get(tabsState).tabs.find((t) => t.path === filePath);
    if (!current || current.isDeleted || current.hasExternalConflict || isAutoSaveBlocked(filePath)) {
      return;
    }
    try {
      await requestSave(filePath);
      unblockAutoSave(filePath);
    } catch (err) {
      blockAutoSave(filePath);
      showErrorToast(`Auto-save paused for ${basename(filePath)}: ${describeError(err)}. Save manually to resume.`);
    }
  }

  // Debounces auto-save behind a plain per-pane timer, reset on every
  // qualifying doc change. Known, accepted interaction: `requestSave` writes
  // to the single-slot `saveRequest` store, so if two panes' timers (for two
  // different paths) fire within the same tick, the second `set()` clobbers
  // the first before its own save effect ever observes it — the earlier
  // path's `requestSave` promise never settles and that pane stays dirty
  // rather than losing data, self-recovering on the next edit or an
  // explicit save. This was flagged as a real but narrow, pre-existing-
  // shaped pressure on a single-slot design that only ever saw user-paced
  // traffic before auto-save; not worth redesigning the save funnel to close
  // pre-emptively.
  function scheduleAutoSave(): void {
    if (autoSaveTimer !== undefined) {
      clearTimeout(autoSaveTimer);
    }
    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = undefined;
      void attemptAutoSave();
    }, AUTO_SAVE_DELAY_MS);
  }

  onMount(() => {
    const initialTab = $tabsState.tabs.find((t) => t.path === filePath);
    const mode = initialTab?.mode ?? "code";
    const initialEffectiveMinimapEnabled = $minimapEnabled && minimapAllowedFor(mode);
    const initialEffectiveWordWrapEnabled = $wordWrapEnabled && wordWrapAllowedFor(mode);
    lastAppliedViewMode = initialTab?.viewMode;
    lastAppliedLineNumbersEnabled = $lineNumbersEnabled;
    lastAppliedWordWrapEnabled = initialEffectiveWordWrapEnabled;
    lastAppliedActive = active;

    const shortcutKeymap = [
      {
        key: "Mod-s",
        run: () => {
          requestSaveReportingErrors(filePath);
          return true;
        },
      },
    ];
    if (mode === "markdown") {
      shortcutKeymap.push({
        key: "Mod-Shift-m",
        run: () => {
          toggleMarkdownViewMode(filePath);
          return true;
        },
      });
    }

    const extensions = [
      baseExtensions(),
      wordWrapCompartment.of(mode === "markdown" ? EditorView.lineWrapping : wordWrapExtension($wordWrapEnabled)),
      tabSizeCompartment.of(indentUnit.of(" ".repeat($tabSize))),
      themeCompartment.of(themeExtensions()),
      viewModeCompartment.of(viewModeExtensions(mode, initialTab?.viewMode, $lineNumbersEnabled)),
      // Starts empty regardless of the setting — see `applyMinimap`'s doc
      // comment. The idle callback scheduled below performs the actual first
      // application.
      minimapCompartment.of([]),
      keymap.of(shortcutKeymap),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          scheduleMinimapVisibilityCheck();
        }
        const isSyncOnly =
          update.docChanged && update.transactions.every((tr) => tr.annotation(syncAnnotation));
        if (update.docChanged && !isSyncOnly) {
          markDirty(filePath);
          if (get(autoSaveEnabled) && isSaveOwner) {
            scheduleAutoSave();
          }
        }
        if ((update.docChanged || update.selectionSet) && active) {
          setCursorPosition(computeCursorPosition(update.state));
        }
      }),
    ];

    const seedDoc = liveDocFor(filePath) ?? initialTab?.savedDoc ?? "";
    view = new EditorView({
      state: EditorState.create({
        doc: seedDoc,
        extensions,
      }),
      parent: container,
      dispatchTransactions: createSyncDispatch(filePath),
    });
    registerView(filePath, view);
    detachScrollbarAutoHide = attachScrollbarAutoHide(view.scrollDOM);
    if (typeof ResizeObserver !== "undefined") {
      minimapResizeObserver = new ResizeObserver(scheduleMinimapVisibilityCheck);
      minimapResizeObserver.observe(view.scrollDOM);
    }

    if (lastAppliedActive) {
      setCursorPosition(computeCursorPosition(view.state));
    }

    // Marking the mount-time value as already "applied" here (even though
    // the compartment itself is still empty) keeps the minimap `$effect`
    // below silent for this initial value — the idle callback is solely
    // responsible for the first real application, so it isn't raced or
    // duplicated by the effect also firing on mount.
    lastAppliedMinimapEnabled = initialEffectiveMinimapEnabled;
    lastAppliedMinimapVisible = undefined;
    const scheduleIdle = typeof requestIdleCallback !== "undefined" ? requestIdleCallback : (cb: () => void) => setTimeout(cb, 1) as unknown as number;
    minimapIdleHandle = scheduleIdle(() => {
      minimapIdleHandle = undefined;
      if (!view) return;
      applyMinimap(initialEffectiveMinimapEnabled);
      // The first idle callback can still precede the browser's first layout.
      // Recheck once the initial DOM measurement is available.
      scheduleMinimapVisibilityCheck();
    });
  });

  onDestroy(() => {
    cancelMinimapIdle();
    if (minimapVisibilityTimer !== undefined) {
      clearTimeout(minimapVisibilityTimer);
    }
    minimapResizeObserver?.disconnect();
    if (autoSaveTimer !== undefined) {
      clearTimeout(autoSaveTimer);
    }
    detachScrollbarAutoHide?.();
    if (view) {
      unregisterView(filePath, view);
      view.destroy();
    }
    if ($tabsState.activeTabPath === null) {
      clearCursorPosition();
    }
  });

  // Reconfigures the theme compartment in place on a theme change, instead
  // of tearing down and rebuilding the view (which would lose undo history,
  // selection, and scroll position).
  $effect(() => {
    const current = $themeStore;
    if (!view) {
      return;
    }
    view.dispatch({
      effects: themeCompartment.reconfigure([
        buildCmTheme(current),
        syntaxHighlighting(buildHighlightStyle(current), { fallback: true }),
      ]),
    });
  });

  // Reconfigures the minimap compartment in place when the effective setting
  // (the global setting gated by `minimapAllowedFor`) actually changes after
  // mount, without losing undo history, selection, or scroll position — same
  // guarantee as the theme-switch effect above. A markdown pane's effective
  // value never changes regardless of the setting, so this never fires for
  // one. Guarded against firing on the initial mount value (see
  // `lastAppliedMinimapEnabled` above): the mount-time idle callback owns
  // that first application.
  $effect(() => {
    const enabled = effectiveMinimapEnabled;
    if (!view || enabled === lastAppliedMinimapEnabled) {
      return;
    }
    applyMinimap(enabled);
  });

  // Reconfigures the word-wrap compartment in place when the effective
  // setting (the global setting gated by `wordWrapAllowedFor`) actually
  // changes after mount, preserving undo history, selection, and scroll
  // position — same guarantee as the minimap-switch effect above. A
  // markdown pane's effective value is always `false` here regardless of
  // the setting (it keeps its own unconditional wrap, applied once at
  // mount and never reconfigured by this effect), so it never fires for
  // one — mirroring `minimapAllowedFor`'s own mode-gating shape.
  $effect(() => {
    const enabled = effectiveWordWrapEnabled;
    if (!view || enabled === lastAppliedWordWrapEnabled) {
      return;
    }
    lastAppliedWordWrapEnabled = enabled;
    view.dispatch({ effects: wordWrapCompartment.reconfigure(wordWrapExtension(enabled)) });
  });

  // Reconfigures the tab-size compartment in place when the setting changes,
  // applying uniformly regardless of mode or view (not gated the way
  // minimap/word-wrap are) — same preserve-state guarantee as the theme
  // effect above.
  $effect(() => {
    const size = $tabSize;
    if (!view) {
      return;
    }
    view.dispatch({ effects: tabSizeCompartment.reconfigure(indentUnit.of(" ".repeat(size))) });
  });

  // Reconfigures the view-mode compartment in place when a markdown tab's
  // `viewMode` toggles between rendered and source, or when the Line
  // Numbers setting changes (both extension sets `viewModeExtensions`
  // builds already fold the gutter into this same compartment), preserving
  // document, cursor, undo history, and scroll position. Guarded against
  // firing on unrelated tab-store updates (e.g. `markDirty` on every
  // keystroke) by comparing against the last-applied values before
  // dispatching.
  //
  // The compartment swap alone leaves CodeMirror's viewport (the character
  // range it considers "visible") carried over from the previous mode: its
  // internal height-change detection only looks at `StateField`-registered
  // decorations, not the `ViewPlugin`-supplied ones `livePreviewPlugin` uses
  // for live-preview styling, so it doesn't see this transition as
  // height-relevant and never recomputes the viewport on its own.
  //
  // Forcing that recompute needs a scroll-target effect dispatched alongside
  // the reconfigure, but `ViewState.update()` only recomputes the viewport
  // when the target falls *outside* the viewport it already has — and
  // `view.scrollSnapshot()`'s anchor is deliberately constructed to already
  // be inside it (that's what makes it useful for preserving scroll position
  // elsewhere), so it doesn't reliably trigger the recompute this fix needs.
  // The selection head reliably does fall outside the current viewport in
  // the case that matters (the cursor defaults to position 0 on open, and
  // reading the rendered preview by scrolling doesn't move it), so it's used
  // here purely to force the recompute — then immediately superseded by a
  // `scrollSnapshot()` captured *before* the toggle, in a second dispatch, so
  // the scroll position CodeMirror eventually applies is the one the user
  // was actually looking at, not the cursor. `ViewState` only tracks one
  // pending scroll target at a time and applies whichever was set last, so
  // this second dispatch reliably overrides the first before either is ever
  // rendered. The explicit `requestMeasure()` after both dispatches
  // (same pattern as the background-tab fix below) guarantees a fresh
  // measure pass re-derives the viewport from actual rendered DOM heights
  // rather than relying on CodeMirror's implicit, best-effort async
  // convergence.
  $effect(() => {
    const current = tab;
    const showLineNumbers = $lineNumbersEnabled;
    if (
      !view ||
      !current ||
      (current.viewMode === lastAppliedViewMode && showLineNumbers === lastAppliedLineNumbersEnabled)
    ) {
      return;
    }
    lastAppliedViewMode = current.viewMode;
    lastAppliedLineNumbersEnabled = showLineNumbers;
    const head = view.state.selection.main.head;
    const scrollSnapshot = view.scrollSnapshot();
    view.dispatch({
      effects: [
        viewModeCompartment.reconfigure(viewModeExtensions(current.mode, current.viewMode, showLineNumbers)),
        EditorView.scrollIntoView(head, { y: "nearest" }),
      ],
    });
    view.dispatch({ effects: scrollSnapshot });
    view.requestMeasure();
  });

  // Forces a fresh CodeMirror measurement and pushes this pane's cursor
  // position into `editorStatus.ts` when this tab's pane actually becomes
  // visible. Every open tab's `EditorPane` is mounted immediately
  // (`App.svelte` keeps inactive tabs' panes in the DOM, hidden via
  // `display: none`), so a background tab's `EditorView` can take its first
  // layout measurement against a zero-size container and lock in a wrong
  // content width that CodeMirror won't shrink back down on its own — only a
  // later, differently-sized measurement (reliably, the first scroll) forces
  // the correction. The cursor-position push here covers switching tabs
  // without touching the keyboard, which the `updateListener` set up in
  // `onMount` never fires for on its own. Guarded like the view-mode effect
  // above so it only fires on an actual activation, not on every unrelated
  // tab-store update.
  $effect(() => {
    const isActive = active;
    if (!view || isActive === lastAppliedActive) {
      return;
    }
    lastAppliedActive = isActive;
    if (isActive) {
      view.requestMeasure();
      setCursorPosition(computeCursorPosition(view.state));
    }
  });

  // External-change reconciliation (section 6.2): when the tab is clean and
  // its `savedDoc` changes underneath us (silent reload after `fs:changed`,
  // or the "Reload" conflict-banner action), replace the CM6 doc to match.
  $effect(() => {
    const current = tab;
    if (!view || !current || current.isDirty) {
      return;
    }
    if (current.savedDoc !== currentDoc()) {
      const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: current.savedDoc },
        annotations: [syncAnnotation.of(true), Transaction.addToHistory.of(false)],
      });
      const newLineCount = view.state.doc.lines;
      const targetLine = Math.min(cursorLine, newLineCount);
      const linePos = view.state.doc.line(targetLine).from;
      view.dispatch({ selection: { anchor: linePos } });
    }
  });

  // Scrolls to a pending selection (from a markdown/terminal/explorer "open
  // to line" request) once the view exists, then clears it. Guarded on
  // `active` so that if `filePath` is open in more than one split pane, only
  // the pane the "open" action actually targeted (the focused one) jumps its
  // cursor/scroll — the other view(s) leave the pending request alone rather
  // than consuming it without acting on it, since `clearPendingSelection` is
  // shared, single-shot state on the underlying `Tab`, not per-pane.
  $effect(() => {
    const current = tab;
    if (!view || !current?.pendingSelection || !active) {
      return;
    }
    const { line, col } = current.pendingSelection;
    const doc = view.state.doc;
    if (line >= 1 && line <= doc.lines) {
      const lineInfo = doc.line(line);
      const pos = col ? Math.min(lineInfo.from + col - 1, lineInfo.to) : lineInfo.from;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "center" }),
      });
      view.focus();
    }
    clearPendingSelection(filePath);
  });

  // Guarded on `isSaveOwner`, not just `filePath` — otherwise every pane
  // showing this path would independently save its own buffer in response
  // to the same request (see `isSaveOwner`'s own comment). Every save —
  // manual or auto-triggered — funnels through this same effect, so an
  // explicit save's success is the one thing that can clear a block a
  // failed auto-save previously set on this path (MF3's failure policy).
  $effect(() => {
    if ($saveRequest === filePath && isSaveOwner) {
      void save()
        .then(() => {
          saveRequest.set(null);
          unblockAutoSave(filePath);
          notifySaveComplete(filePath);
        })
        .catch((err: unknown) => {
          saveRequest.set(null);
          notifySaveFailed(filePath, err);
        });
    }
  });
</script>

<svelte:window onclick={closeMenu} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="editor-pane" bind:this={container} style={`font-size: ${$zoom * 100}%`} oncontextmenu={onContextMenu}></div>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y}>
    <button role="menuitem" disabled={!menu.hasSelection} onclick={doCut}>Cut<kbd class="shortcut-hint">{SHORTCUT_LABELS.cut}</kbd></button>
    <button role="menuitem" disabled={!menu.hasSelection} onclick={doCopy}>Copy<kbd class="shortcut-hint">{SHORTCUT_LABELS.copy}</kbd></button>
    <button role="menuitem" disabled={menu.pasteDisabled} onclick={() => void doPaste()}>Paste<kbd class="shortcut-hint">{SHORTCUT_LABELS.paste}</kbd></button>
    <div class="menu-separator" role="separator"></div>
    <button role="menuitem" onclick={doSelectAll}>Select All<kbd class="shortcut-hint">{SHORTCUT_LABELS.selectAll}</kbd></button>
    {#if tab?.mode === "markdown"}
      <div class="menu-separator" role="separator"></div>
      <button role="menuitem" onclick={doToggleViewMode}>
        {tab.viewMode === "source" ? "Switch to Rendered View" : "Switch to Source View"}
      </button>
    {/if}
    {#if menu.tableContext}
      {@const ctx = menu.tableContext}
      <div class="menu-separator" role="separator"></div>
      <button role="menuitem" disabled={!insertRow(view.state, ctx, "above")} onclick={() => doTableEdit(insertRow(view.state, ctx, "above"))}>Insert Row Above</button>
      <button role="menuitem" disabled={!insertRow(view.state, ctx, "below")} onclick={() => doTableEdit(insertRow(view.state, ctx, "below"))}>Insert Row Below</button>
      <button role="menuitem" disabled={!deleteRow(view.state, ctx)} onclick={() => doTableEdit(deleteRow(view.state, ctx))}>Delete Row</button>
      <button role="menuitem" disabled={!moveRow(view.state, ctx, "up")} onclick={() => doTableEdit(moveRow(view.state, ctx, "up"))}>Move Row Up</button>
      <button role="menuitem" disabled={!moveRow(view.state, ctx, "down")} onclick={() => doTableEdit(moveRow(view.state, ctx, "down"))}>Move Row Down</button>
      <button role="menuitem" disabled={!duplicateRow(view.state, ctx)} onclick={() => doTableEdit(duplicateRow(view.state, ctx))}>Duplicate Row</button>
      <div class="menu-separator" role="separator"></div>
      <button role="menuitem" disabled={!insertColumn(view.state, ctx, "left")} onclick={() => doTableEdit(insertColumn(view.state, ctx, "left"))}>Insert Column Left</button>
      <button role="menuitem" disabled={!insertColumn(view.state, ctx, "right")} onclick={() => doTableEdit(insertColumn(view.state, ctx, "right"))}>Insert Column Right</button>
      <button role="menuitem" disabled={!deleteColumn(view.state, ctx)} onclick={() => doTableEdit(deleteColumn(view.state, ctx))}>Delete Column</button>
      <button role="menuitem" disabled={!moveColumn(view.state, ctx, "left")} onclick={() => doTableEdit(moveColumn(view.state, ctx, "left"))}>Move Column Left</button>
      <button role="menuitem" disabled={!moveColumn(view.state, ctx, "right")} onclick={() => doTableEdit(moveColumn(view.state, ctx, "right"))}>Move Column Right</button>
      <button role="menuitem" disabled={!duplicateColumn(view.state, ctx)} onclick={() => doTableEdit(duplicateColumn(view.state, ctx))}>Duplicate Column</button>
    {/if}
    <div class="menu-separator" role="separator"></div>
    <button role="menuitem" onclick={doSave}>Save<kbd class="shortcut-hint">{SHORTCUT_LABELS.save}</kbd></button>
    <button role="menuitem" onclick={() => void doReveal()}>Reveal in Finder</button>
  </ContextMenu>
{/if}

<style>
  .editor-pane {
    height: 100%;
    overflow: auto;
  }

  .editor-pane :global(.cm-editor) {
    height: 100%;
  }
</style>
