<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Compartment, EditorState, type Extension } from "@codemirror/state";
  import { EditorView, keymap, lineNumbers } from "@codemirror/view";
  import { selectAll as cmSelectAll } from "@codemirror/commands";
  import { syntaxHighlighting } from "@codemirror/language";
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
  } from "../stores/tabs";
  import { focusedEditorPaneId, editorPaneTree } from "../stores/editorPanes";
  import { saveOwnerLeafId } from "./editorPaneTree";
  import { theme as themeStore } from "../stores/theme";
  import { buildCmTheme, buildHighlightStyle } from "../theme/cmTheme";
  import { baseExtensions } from "./baseExtensions";
  import { markdownExtensions, markdownSourceExtensions } from "./markdown/livePreviewPlugin";
  import { codeExtensions } from "./codeExtensions";
  import { setCursorPosition, clearCursorPosition, type CursorPosition } from "../stores/editorStatus";
  import { attachScrollbarAutoHide } from "../ui/scrollbarAutoHide";
  import { revealInFinder } from "../ipc/reveal";
  import ContextMenu from "../ui/ContextMenu.svelte";

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
  // once per pane showing the path, racing independent, possibly-diverged
  // buffers (no live content sync between split views yet) against each
  // other for the disk. See `saveOwnerLeafId`'s own doc comment for which
  // pane wins and why.
  const isSaveOwner = $derived($editorPaneTree !== null && saveOwnerLeafId($editorPaneTree, filePath, $focusedEditorPaneId) === paneId);

  let container: HTMLDivElement;
  let view: EditorView;
  let detachScrollbarAutoHide: (() => void) | undefined;
  const themeCompartment = new Compartment();
  const viewModeCompartment = new Compartment();
  let lastAppliedViewMode: "rendered" | "source" | undefined;
  let lastAppliedActive: boolean | undefined;

  interface ContextMenuState {
    x: number;
    y: number;
    hasSelection: boolean;
    pasteDisabled: boolean;
  }

  let menu = $state<ContextMenuState | null>(null);

  function viewModeExtensions(mode: "code" | "markdown", viewMode: "rendered" | "source" | undefined): Extension[] {
    if (mode !== "markdown") {
      return [lineNumbers(), ...codeExtensions(filePath)];
    }
    return viewMode === "source" ? markdownSourceExtensions(filePath) : markdownExtensions(filePath);
  }

  function themeExtensions() {
    return [buildCmTheme($themeStore), syntaxHighlighting(buildHighlightStyle($themeStore), { fallback: true })];
  }

  const tab = $derived($tabsState.tabs.find((t) => t.path === filePath));

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

  async function save(): Promise<void> {
    await saveTab(filePath, currentDoc());
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

  function onContextMenu(event: MouseEvent): void {
    if (!view) return;
    event.preventDefault();
    menu = {
      x: event.clientX,
      y: event.clientY,
      hasSelection: !view.state.selection.main.empty,
      pasteDisabled: true,
    };
    void refreshPasteAvailability();
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
    void save();
  }

  async function doReveal(): Promise<void> {
    closeMenu();
    await revealInFinder(filePath);
  }

  onMount(() => {
    const initialTab = $tabsState.tabs.find((t) => t.path === filePath);
    const mode = initialTab?.mode ?? "code";
    lastAppliedViewMode = initialTab?.viewMode;
    lastAppliedActive = active;

    const shortcutKeymap = [
      {
        key: "Mod-s",
        run: () => {
          void save();
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
      mode === "markdown" ? EditorView.lineWrapping : [],
      themeCompartment.of(themeExtensions()),
      viewModeCompartment.of(viewModeExtensions(mode, initialTab?.viewMode)),
      keymap.of(shortcutKeymap),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          markDirty(filePath);
        }
        if ((update.docChanged || update.selectionSet) && active) {
          setCursorPosition(computeCursorPosition(update.state));
        }
      }),
    ];

    view = new EditorView({
      state: EditorState.create({
        doc: initialTab?.savedDoc ?? "",
        extensions,
      }),
      parent: container,
    });
    detachScrollbarAutoHide = attachScrollbarAutoHide(view.scrollDOM);

    if (lastAppliedActive) {
      setCursorPosition(computeCursorPosition(view.state));
    }
  });

  onDestroy(() => {
    detachScrollbarAutoHide?.();
    view?.destroy();
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

  // Reconfigures the view-mode compartment in place when a markdown tab's
  // `viewMode` toggles between rendered and source, preserving document,
  // cursor, undo history, and scroll position. Guarded against firing on
  // unrelated tab-store updates (e.g. `markDirty` on every keystroke) by
  // comparing against the last-applied value before dispatching.
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
    if (!view || !current || current.viewMode === lastAppliedViewMode) {
      return;
    }
    lastAppliedViewMode = current.viewMode;
    const head = view.state.selection.main.head;
    const scrollSnapshot = view.scrollSnapshot();
    view.dispatch({
      effects: [
        viewModeCompartment.reconfigure(viewModeExtensions(current.mode, current.viewMode)),
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
  // to the same request (see `isSaveOwner`'s own comment).
  $effect(() => {
    if ($saveRequest === filePath && isSaveOwner) {
      void save()
        .then(() => {
          saveRequest.set(null);
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
<div class="editor-pane" bind:this={container} oncontextmenu={onContextMenu}></div>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y}>
    <button role="menuitem" disabled={!menu.hasSelection} onclick={doCut}>Cut</button>
    <button role="menuitem" disabled={!menu.hasSelection} onclick={doCopy}>Copy</button>
    <button role="menuitem" disabled={menu.pasteDisabled} onclick={() => void doPaste()}>Paste</button>
    <div class="menu-separator" role="separator"></div>
    <button role="menuitem" onclick={doSelectAll}>Select All</button>
    {#if tab?.mode === "markdown"}
      <div class="menu-separator" role="separator"></div>
      <button role="menuitem" onclick={doToggleViewMode}>
        {tab.viewMode === "source" ? "Switch to Rendered View" : "Switch to Source View"}
      </button>
    {/if}
    <div class="menu-separator" role="separator"></div>
    <button role="menuitem" onclick={doSave}>Save</button>
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
