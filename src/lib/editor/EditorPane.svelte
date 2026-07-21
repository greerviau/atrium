<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Compartment, EditorState, type Extension } from "@codemirror/state";
  import { EditorView, keymap, lineNumbers } from "@codemirror/view";
  import { syntaxHighlighting } from "@codemirror/language";
  import {
    tabsState,
    saveRequest,
    saveTab,
    markDirty,
    clearPendingSelection,
    toggleMarkdownViewMode,
  } from "../stores/tabs";
  import { theme as themeStore } from "../stores/theme";
  import { buildCmTheme, buildHighlightStyle } from "../theme/cmTheme";
  import { baseExtensions } from "./baseExtensions";
  import { markdownExtensions, markdownSourceExtensions } from "./markdown/livePreviewPlugin";
  import { codeExtensions } from "./codeExtensions";
  import { setCursorPosition, clearCursorPosition, type CursorPosition } from "../stores/editorStatus";

  let { filePath }: { filePath: string } = $props();

  let container: HTMLDivElement;
  let view: EditorView;
  const themeCompartment = new Compartment();
  const viewModeCompartment = new Compartment();
  let lastAppliedViewMode: "rendered" | "source" | undefined;
  let lastAppliedActive: boolean | undefined;

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

  onMount(() => {
    const initialTab = $tabsState.tabs.find((t) => t.path === filePath);
    const mode = initialTab?.mode ?? "code";
    lastAppliedViewMode = initialTab?.viewMode;
    lastAppliedActive = $tabsState.activeTabPath === filePath;

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
        if ((update.docChanged || update.selectionSet) && $tabsState.activeTabPath === filePath) {
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

    if (lastAppliedActive) {
      setCursorPosition(computeCursorPosition(view.state));
    }
  });

  onDestroy(() => {
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
  $effect(() => {
    const current = tab;
    if (!view || !current || current.viewMode === lastAppliedViewMode) {
      return;
    }
    lastAppliedViewMode = current.viewMode;
    view.dispatch({
      effects: viewModeCompartment.reconfigure(viewModeExtensions(current.mode, current.viewMode)),
    });
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
    const isActive = $tabsState.activeTabPath === filePath;
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
  // to line" request) once the view exists, then clears it.
  $effect(() => {
    const current = tab;
    if (!view || !current?.pendingSelection) {
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

  $effect(() => {
    if ($saveRequest === filePath) {
      void save().then(() => saveRequest.set(null));
    }
  });
</script>

<div class="editor-pane" bind:this={container}></div>

<style>
  .editor-pane {
    height: 100%;
    overflow: auto;
  }

  .editor-pane :global(.cm-editor) {
    height: 100%;
  }
</style>
